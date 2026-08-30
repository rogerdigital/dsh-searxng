import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { SEARXNG_IMAGE, type AssetRenderer, type ManagedIdentity } from '../../src/cli/assets.ts'
import type { DockerAdapter } from '../../src/cli/docker.ts'
import { CliError } from '../../src/cli/errors.ts'
import type { EnvironmentService } from '../../src/cli/environment.ts'
import type { ProfileManager } from '../../src/cli/profile.ts'
import type { SearxngProbe } from '../../src/cli/searxng.ts'
import type { StateStore, StateV1 } from '../../src/cli/state.ts'
import { createSetup, setup, type SetupDependencies } from '../../src/cli/setup.ts'
import { createLoopbackPortChecker, runCli } from '../../src/cli.ts'

const HOME_ID = '0123456789abcdef'
const MANAGED_DIR = '/tmp/dsh/dsh-searxng'
const PROJECT = `dsh-searxng-${HOME_ID}`
const ENDPOINT = 'http://127.0.0.1:8080'
const COMPOSE_PATH = join(MANAGED_DIR, `config-${'a'.repeat(64)}`, 'compose.yml')

interface HarnessOptions {
  state?: StateV1
  ownership?: 'absent' | 'owned'
  readinessFailures?: number
  realSearchFailures?: number
  realSearchError?: unknown
  providerSearchError?: unknown
  preflightError?: unknown
  ownershipError?: unknown
  writeError?: unknown
}

function managedState(overrides: Partial<NonNullable<StateV1['managed']>> = {}): StateV1 {
  return {
    schemaVersion: 1,
    managed: {
      deploymentVersion: 1,
      image: SEARXNG_IMAGE,
      endpoint: ENDPOINT,
      port: 8080,
      homeId: HOME_ID,
      projectName: PROJECT,
      containerName: PROJECT,
      lastHealthyAt: '2026-08-29T00:00:00.000Z',
      ...overrides,
    },
    profiles: { existing: { mode: 'external', endpoint: 'https://existing.example/search' } },
  }
}

function harness(options: HarnessOptions = {}) {
  const events: string[] = []
  const writes: StateV1[] = []
  const renders: Parameters<AssetRenderer['render']>[0][] = []
  const identities: ManagedIdentity[] = []
  let state: StateV1 = structuredClone(options.state ?? { schemaVersion: 1, profiles: {} })
  let readinessFailures = options.readinessFailures ?? 0
  let realSearchFailures = options.realSearchFailures ?? 0
  let profileEndpoint = 'before'

  const stateStore: StateStore = {
    read: vi.fn(async () => { events.push('state-read'); return structuredClone(state) }),
    write: vi.fn(async (next) => {
      events.push('state-write')
      if (options.writeError !== undefined) throw options.writeError
      state = structuredClone(next)
      writes.push(structuredClone(next))
    }),
    withLock: vi.fn(async (operation) => {
      events.push('lock')
      try { return await operation() } finally { events.push('unlock') }
    }),
  }
  const environment: EnvironmentService = {
    resolve: vi.fn(async (profile) => {
      events.push('environment')
      return { dshHome: '/tmp/dsh', profileDir: `/tmp/dsh/profiles/${profile}`, managedDir: MANAGED_DIR, homeId: HOME_ID }
    }),
    preflightManaged: vi.fn(async () => {
      events.push('managed-preflight')
      if (options.preflightError !== undefined) throw options.preflightError
    }),
  }
  const docker: DockerAdapter = {
    preflight: vi.fn(async () => { events.push('docker-preflight'); return { serverVersion: '27', composeVersion: '2.30' } }),
    inspectOwnership: vi.fn(async (identity) => {
      events.push('ownership')
      identities.push(identity)
      if (options.ownershipError !== undefined) throw options.ownershipError
      return options.ownership ?? 'absent'
    }),
    up: vi.fn(async (identity) => { events.push('docker-up'); identities.push(identity) }),
    down: vi.fn(async () => { events.push('docker-down') }),
    logs: vi.fn(async () => ''),
  }
  const assets: AssetRenderer = {
    render: vi.fn(async (input) => {
      events.push('render')
      renders.push(input)
      return { composePath: COMPOSE_PATH, configurationSha256: 'a'.repeat(64) }
    }),
  }
  const searxng: SearxngProbe = {
    readiness: vi.fn(async () => {
      events.push('readiness')
      if (readinessFailures > 0) {
        readinessFailures -= 1
        throw new CliError('E_SEARXNG_START_TIMEOUT', 'not ready', 'repair')
      }
    }),
    realSearch: vi.fn(async () => {
      events.push('real-search')
      if (realSearchFailures > 0) {
        realSearchFailures -= 1
        throw new CliError('E_SEARCH_FAILED', 'managed search is unhealthy', 'repair')
      }
      if (options.realSearchError !== undefined) throw options.realSearchError
      return { endpoint: ENDPOINT, resultCount: 1, elapsedMs: 1 }
    }),
    providerSearch: vi.fn(async () => {
      events.push('provider-search')
      if (options.providerSearchError !== undefined) throw options.providerSearchError
      return { endpoint: ENDPOINT, resultCount: 1, elapsedMs: 1 }
    }),
  }
  const profiles: ProfileManager = {
    inspect: vi.fn(async () => ({ installed: false, patchPath: '/tmp/patch' })),
    attach: vi.fn(async (_profile, endpoint, validate) => {
      events.push('profile-attach')
      const previous = profileEndpoint
      profileEndpoint = endpoint
      try { await validate() } catch (error) { profileEndpoint = previous; throw error }
    }),
    detach: vi.fn(async () => {}),
  }
  const deps: SetupDependencies = {
    environment,
    state: stateStore,
    docker,
    assets,
    searxng,
    profiles,
    now: () => new Date('2026-08-30T01:02:03.004Z'),
  }
  return { deps, events, writes, renders, identities, docker, assets, environment, profiles, state: () => state, profileEndpoint: () => profileEndpoint }
}

describe('setup', () => {
  it('orchestrates a new managed deployment in semantic order and writes state last', async () => {
    const test = harness()
    const result = await createSetup({ randomSecret: () => 'b'.repeat(64) })({ profile: 'web', port: 8080 }, test.deps)

    expect(result).toEqual({ profile: 'web', endpoint: ENDPOINT, reused: false })
    expect(test.events).toEqual([
      'lock', 'environment', 'state-read', 'docker-preflight', 'ownership', 'managed-preflight',
      'render', 'docker-up', 'readiness', 'real-search', 'profile-attach',
      'provider-search', 'state-write', 'unlock',
    ])
    expect(test.renders[0]).toMatchObject({ stateDir: MANAGED_DIR, image: SEARXNG_IMAGE, port: 8080, secret: 'b'.repeat(64) })
    expect(test.renders[0]?.identity).toEqual({
      stateDir: MANAGED_DIR,
      composePath: join(MANAGED_DIR, `config-${'0'.repeat(64)}`, 'compose.yml'),
      homeId: HOME_ID,
      projectName: PROJECT,
      containerName: PROJECT,
    })
    expect(test.identities.at(-1)?.composePath).toBe(COMPOSE_PATH)
    expect(test.writes).toEqual([{
      schemaVersion: 1,
      managed: {
        deploymentVersion: 1,
        image: SEARXNG_IMAGE,
        endpoint: ENDPOINT,
        port: 8080,
        homeId: HOME_ID,
        projectName: PROJECT,
        containerName: PROJECT,
        lastHealthyAt: '2026-08-30T01:02:03.004Z',
      },
      profiles: { web: { mode: 'managed', endpoint: ENDPOINT } },
    }])
  })

  it('generates a 32-byte lowercase hexadecimal secret without returning it', async () => {
    const test = harness()
    await setup({ profile: 'web', port: 8080 }, test.deps)
    expect(test.renders[0]?.secret).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(test.writes)).not.toContain(test.renders[0]!.secret)
  })

  it('strictly reuses a matching healthy owned deployment without port preflight, render, or up', async () => {
    const test = harness({ state: managedState(), ownership: 'owned' })
    await expect(setup({ profile: 'work', port: 8080 }, test.deps)).resolves.toEqual({ profile: 'work', endpoint: ENDPOINT, reused: true })
    expect(test.events).toEqual([
      'lock', 'environment', 'state-read', 'docker-preflight', 'ownership', 'readiness',
      'real-search', 'profile-attach', 'provider-search', 'state-write', 'unlock',
    ])
    expect(test.state().profiles).toEqual({
      existing: { mode: 'external', endpoint: 'https://existing.example/search' },
      work: { mode: 'managed', endpoint: ENDPOINT },
    })
    expect(test.state().managed?.lastHealthyAt).toBe('2026-08-30T01:02:03.004Z')
  })

  it('repairs matching owned but unhealthy deployment without mistaking its port for a conflict', async () => {
    const test = harness({ state: managedState(), ownership: 'owned', readinessFailures: 1 })
    await expect(setup({ profile: 'web', port: 8080 }, test.deps)).resolves.toMatchObject({ reused: false })
    expect(test.events).toEqual([
      'lock', 'environment', 'state-read', 'docker-preflight', 'ownership', 'readiness', 'render',
      'docker-up', 'readiness', 'real-search', 'profile-attach', 'provider-search',
      'state-write', 'unlock',
    ])
    expect(test.environment.preflightManaged).not.toHaveBeenCalled()
  })

  it('repairs an owned matching deployment when readiness passes but its real search is unhealthy', async () => {
    const test = harness({ state: managedState(), ownership: 'owned', realSearchFailures: 1 })
    await expect(setup({ profile: 'web', port: 8080 }, test.deps)).resolves.toMatchObject({ reused: false })
    expect(test.events).toEqual([
      'lock', 'environment', 'state-read', 'docker-preflight', 'ownership', 'readiness', 'real-search',
      'render', 'docker-up', 'readiness', 'real-search', 'profile-attach', 'provider-search',
      'state-write', 'unlock',
    ])
    expect(test.environment.preflightManaged).not.toHaveBeenCalled()
  })

  it('validates and normalizes an external endpoint with zero Docker, managed-preflight, or asset calls', async () => {
    const initial = managedState()
    const test = harness({ state: initial })
    await expect(setup({ profile: 'work', port: 9999, url: 'https://search.example/path///' }, test.deps))
      .resolves.toEqual({ profile: 'work', endpoint: 'https://search.example/path', reused: false })
    expect(test.events).toEqual(['lock', 'environment', 'state-read', 'real-search', 'profile-attach', 'provider-search', 'state-write', 'unlock'])
    expect(test.docker.preflight).not.toHaveBeenCalled()
    expect(test.docker.inspectOwnership).not.toHaveBeenCalled()
    expect(test.assets.render).not.toHaveBeenCalled()
    expect(test.environment.preflightManaged).not.toHaveBeenCalled()
    expect(test.state().managed).toEqual(initial.managed)
    expect(test.state().profiles.work).toEqual({ mode: 'external', endpoint: 'https://search.example/path' })
  })

  it.each([
    'ftp://search.example',
    'https://user:pass@search.example',
    'https://search.example?q=secret',
    'https://search.example/#secret',
  ])('rejects unsafe external endpoint %s before probing or profile mutation', async (url) => {
    const test = harness()
    await expect(setup({ profile: 'web', port: 8080, url }, test.deps)).rejects.toMatchObject({ code: 'E_USAGE' })
    expect(test.events).toEqual(['lock', 'environment', 'state-read', 'unlock'])
  })

  it('refuses an occupied new port before render or Docker mutation', async () => {
    const test = harness({ preflightError: new CliError('E_PORT_CONFLICT', 'occupied', 'choose another') })
    await expect(setup({ profile: 'web', port: 8080 }, test.deps)).rejects.toMatchObject({ code: 'E_PORT_CONFLICT' })
    expect(test.events).toEqual(['lock', 'environment', 'state-read', 'docker-preflight', 'ownership', 'managed-preflight', 'unlock'])
    expect(test.assets.render).not.toHaveBeenCalled()
    expect(test.docker.up).not.toHaveBeenCalled()
  })

  it('refuses foreign resources before rendering or mutation', async () => {
    const test = harness({ ownershipError: new CliError('E_RESOURCE_FOREIGN', 'foreign', 'rename it') })
    await expect(setup({ profile: 'web', port: 8080 }, test.deps)).rejects.toMatchObject({ code: 'E_RESOURCE_FOREIGN' })
    expect(test.events).toEqual(['lock', 'environment', 'state-read', 'docker-preflight', 'ownership', 'unlock'])
    expect(test.assets.render).not.toHaveBeenCalled()
    expect(test.docker.up).not.toHaveBeenCalled()
  })

  it('does not mutate a profile or state when real search fails', async () => {
    const test = harness({ realSearchError: new CliError('E_SEARCH_FAILED', 'failed', 'retry') })
    await expect(setup({ profile: 'web', port: 8080 }, test.deps)).rejects.toMatchObject({ code: 'E_SEARCH_FAILED' })
    expect(test.events).not.toContain('profile-attach')
    expect(test.events).not.toContain('state-write')
  })

  it('observably rolls the profile back and does not write state when provider validation fails', async () => {
    const test = harness({ providerSearchError: new CliError('E_SEARCH_FAILED', 'provider failed', 'retry') })
    await expect(setup({ profile: 'web', port: 8080 }, test.deps)).rejects.toMatchObject({ code: 'E_SEARCH_FAILED' })
    expect(test.profileEndpoint()).toBe('before')
    expect(test.events).not.toContain('state-write')
    expect(test.events.at(-1)).toBe('unlock')
  })

  it('propagates cancellation while always unlocking and never writing healthy state', async () => {
    const test = harness()
    const cancellation = new Error('cancelled')
    const controller = new AbortController()
    controller.abort(cancellation)
    await expect(setup({ profile: 'web', port: 8080 }, test.deps, controller.signal)).rejects.toBe(cancellation)
    expect(test.events).toEqual(['lock', 'unlock'])
    expect(test.writes).toEqual([])
  })

  it('wraps unexpected state failures without leaking their secret content and still unlocks', async () => {
    const test = harness()
    vi.mocked(test.deps.state.read).mockRejectedValueOnce(new Error('secret=q-private'))
    await expect(setup({ profile: 'web', port: 8080 }, test.deps)).rejects.toMatchObject({ code: 'E_INTERNAL', message: 'Setup failed unexpectedly' })
    expect(test.events.at(-1)).toBe('unlock')
    await expect(setup({ profile: 'web', port: 8080 }, { ...test.deps, state: { ...test.deps.state, write: async () => { throw new Error('query=private') } } }))
      .rejects.toMatchObject({ code: 'E_INTERNAL', message: 'Setup failed unexpectedly' })
  })
})

describe('production CLI entry', () => {
  it('returns zero and emits exactly one JSON success for setup', async () => {
    const test = harness()
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = await runCli(['setup', '--json'], {
      dependencies: test.deps,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    })
    expect(exitCode).toBe(0)
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0]!)).toEqual({ endpoint: ENDPOINT, profile: 'web', reused: false })
    expect(stderr).toEqual([])
  })

  it('maps parser failures to one safe E_USAGE output and exit code two', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const secretUrl = 'https://user:super-secret@example.com'
    const exitCode = await runCli(['setup', '--url', secretUrl, '--json'], {
      dependencies: harness().deps,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    })
    expect(exitCode).toBe(2)
    expect(stdout).toEqual([])
    expect(stderr).toHaveLength(1)
    expect(JSON.parse(stderr[0]!)).toMatchObject({ code: 'E_USAGE' })
    expect(stderr[0]).not.toContain('super-secret')
    expect(stderr[0]).not.toContain(secretUrl)
  })

  it.each(['status', 'doctor', 'remove'])('fails unwired %s explicitly instead of silently succeeding', async (command) => {
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = await runCli([command, '--json'], {
      dependencies: harness().deps,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    })
    expect(exitCode).toBe(2)
    expect(stdout).toEqual([])
    expect(JSON.parse(stderr[0]!)).toMatchObject({ code: 'E_USAGE', message: expect.stringMatching(/not available yet/i) })
  })

  it('maps operational errors to exit one and exactly one error output', async () => {
    const test = harness()
    vi.mocked(test.deps.docker.preflight).mockRejectedValueOnce(new CliError('E_DOCKER_OFFLINE', 'Docker offline', 'Start Docker'))
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = await runCli(['setup'], {
      dependencies: test.deps,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    })
    expect(exitCode).toBe(1)
    expect(stdout).toEqual([])
    expect(stderr).toHaveLength(1)
    expect(stderr[0]).toContain('E_DOCKER_OFFLINE')
  })

  it('passes cancellation into setup so the state lock is still released', async () => {
    const test = harness()
    const controller = new AbortController()
    controller.abort(new Error('cancelled by signal'))
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = await runCli(['setup', '--json'], {
      dependencies: test.deps,
      signal: controller.signal,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    })
    expect(exitCode).toBe(1)
    expect(stdout).toEqual([])
    expect(stderr).toHaveLength(1)
    expect(test.events).toEqual(['lock', 'unlock'])
  })

  it('checks availability by binding only loopback and closes before resolving', async () => {
    const listenOptions: Array<Record<string, unknown>> = []
    const outcomes = ['occupied', 'available'] as const
    const servers: EventEmitter[] = []
    const check = createLoopbackPortChecker(() => {
      const outcome = outcomes[servers.length]
      const server = new EventEmitter() as EventEmitter & {
        listening: boolean
        listen(options: Record<string, unknown>): void
        close(callback: (error?: Error) => void): void
        unref(): void
      }
      server.listening = false
      server.listen = (options) => {
        listenOptions.push(options)
        queueMicrotask(() => {
          if (outcome === 'occupied') server.emit('error', Object.assign(new Error('occupied'), { code: 'EADDRINUSE' }))
          else { server.listening = true; server.emit('listening') }
        })
      }
      server.close = (callback) => { server.listening = false; queueMicrotask(() => callback()) }
      server.unref = () => {}
      servers.push(server)
      return server as never
    })
    await expect(check(43210)).resolves.toBe(false)
    await expect(check(43210)).resolves.toBe(true)
    expect(listenOptions).toEqual([
      { port: 43210, host: '127.0.0.1', exclusive: true },
      { port: 43210, host: '127.0.0.1', exclusive: true },
    ])
    expect(servers.every((server) => server.listenerCount('error') === 0 && server.listenerCount('listening') === 0)).toBe(true)
  })

  it('propagates an already-aborted port check without opening a listener', async () => {
    const cancellation = new Error('cancelled port check')
    const controller = new AbortController()
    controller.abort(cancellation)
    await expect(createLoopbackPortChecker()(8080, controller.signal)).rejects.toBe(cancellation)
  })

  it('declares the executable package path and source shebang', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as Record<string, unknown>
    const source = await readFile(new URL('../../src/cli.ts', import.meta.url), 'utf8')
    expect(packageJson.bin).toEqual({ 'dsh-searxng': './lib/cli.mjs' })
    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true)
  })
})
