import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { SEARXNG_IMAGE, type AssetRenderer, type ManagedIdentity } from '../../src/cli/assets.ts'
import type { DockerAdapter } from '../../src/cli/docker.ts'
import { CliError } from '../../src/cli/errors.ts'
import type { EnvironmentService } from '../../src/cli/environment.ts'
import type { ProfileAttachmentConfig, ProfileManager } from '../../src/cli/profile.ts'
import type { SearxngProbe } from '../../src/cli/searxng.ts'
import type { StateStore, StateV1 } from '../../src/cli/state.ts'
import { createSetup, setup, type SetupDependencies } from '../../src/cli/setup.ts'
import { createLoopbackPortChecker, isMainModule, runCli } from '../../src/cli.ts'

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
  ownershipSequence?: ReadonlyArray<'absent' | 'owned' | Error>
  readinessErrors?: readonly unknown[]
  upError?: unknown
  downError?: unknown
  dshError?: unknown
  profileAttached?: boolean
  profileConfig?: Partial<ProfileAttachmentConfig>
  postAttachError?: unknown
  validatePostcheckError?: unknown
  writeBehaviors?: ReadonlyArray<'success' | 'fail-before' | 'fail-after'>
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
  const ownershipSequence = [...(options.ownershipSequence ?? [])]
  const readinessErrors = [...(options.readinessErrors ?? [])]
  const writeBehaviors = [...(options.writeBehaviors ?? [])]
  const probeInputs: Array<Record<string, unknown>> = []

  const stateStore: StateStore = {
    read: vi.fn(async () => { events.push('state-read'); return structuredClone(state) }),
    write: vi.fn(async (next) => {
      events.push('state-write')
      const behavior = writeBehaviors.shift()
      if (behavior === 'fail-before') throw new Error('state write failed with secret=private')
      if (options.writeError !== undefined) throw options.writeError
      state = structuredClone(next)
      writes.push(structuredClone(next))
      if (behavior === 'fail-after') throw new Error('state write finalization failed with query=private')
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
    preflightDsh: vi.fn(async () => {
      events.push('dsh-preflight')
      if (options.dshError !== undefined) throw options.dshError
    }),
  }
  const docker: DockerAdapter = {
    preflight: vi.fn(async () => { events.push('docker-preflight'); return { serverVersion: '27', composeVersion: '2.30' } }),
    inspectOwnership: vi.fn(async (identity) => {
      events.push('ownership')
      identities.push(identity)
      if (options.ownershipError !== undefined) throw options.ownershipError
      const sequenced = ownershipSequence.shift()
      if (sequenced instanceof Error) throw sequenced
      if (sequenced !== undefined) return sequenced
      return options.ownership ?? 'absent'
    }),
    up: vi.fn(async (identity) => {
      events.push('docker-up'); identities.push(identity)
      if (options.upError !== undefined) throw options.upError
    }),
    restart: vi.fn(async (identity) => { events.push('docker-restart'); identities.push(identity) }),
    down: vi.fn(async () => {
      events.push('docker-down')
      if (options.downError !== undefined) throw options.downError
    }),
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
      const error = readinessErrors.shift()
      if (error !== undefined) throw error
      if (readinessFailures > 0) {
        readinessFailures -= 1
        throw new CliError('E_SEARXNG_START_TIMEOUT', 'not ready', 'repair')
      }
    }),
    realSearch: vi.fn(async (input) => {
      events.push('real-search')
      probeInputs.push(input as Record<string, unknown>)
      if (realSearchFailures > 0) {
        realSearchFailures -= 1
        throw new CliError('E_SEARCH_FAILED', 'managed search is unhealthy', 'repair')
      }
      if (options.realSearchError !== undefined) throw options.realSearchError
      return { endpoint: ENDPOINT, resultCount: 1, elapsedMs: 1 }
    }),
    providerSearch: vi.fn(async (input) => {
      events.push('provider-search')
      probeInputs.push(input as Record<string, unknown>)
      if (options.providerSearchError !== undefined) throw options.providerSearchError
      return { endpoint: ENDPOINT, resultCount: 1, elapsedMs: 1 }
    }),
  }
  const profiles: ProfileManager = {
    inspect: vi.fn(async () => ({ installed: false, patchPath: '/tmp/patch' })),
    preview: vi.fn(async (_profile, endpoint) => {
      events.push('profile-preview')
      return {
        installed: options.profileAttached ?? false,
        attached: options.profileAttached ?? false,
        config: { baseURL: endpoint, ...options.profileConfig },
      }
    }),
    validate: vi.fn(async (_profile, endpoint, callback) => {
      events.push('profile-validate')
      await callback({ baseURL: endpoint, ...options.profileConfig })
      if (options.validatePostcheckError !== undefined) throw options.validatePostcheckError
    }),
    attach: vi.fn(async (_profile, endpoint, validate) => {
      events.push('profile-attach')
      const previous = profileEndpoint
      profileEndpoint = endpoint
      try {
        await validate({ baseURL: endpoint, ...options.profileConfig })
        if (options.postAttachError !== undefined) throw options.postAttachError
      } catch (error) { profileEndpoint = previous; throw error }
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
  return {
    deps, events, writes, renders, identities, docker, assets, environment, profiles, probeInputs,
    state: () => state, profileEndpoint: () => profileEndpoint,
  }
}

describe('setup', () => {
  it('orchestrates a new managed deployment in semantic order and writes state last', async () => {
    const test = harness()
    const result = await createSetup({ randomSecret: () => 'b'.repeat(64) })({ profile: 'web', port: 8080 }, test.deps)

    expect(result).toEqual({ profile: 'web', endpoint: ENDPOINT, reused: false })
    expect(test.events).toEqual([
      'lock', 'environment', 'state-read', 'dsh-preflight', 'docker-preflight', 'ownership', 'profile-preview', 'managed-preflight',
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
      'lock', 'environment', 'state-read', 'dsh-preflight', 'docker-preflight', 'ownership', 'profile-preview', 'readiness',
      'real-search', 'profile-attach', 'provider-search', 'state-write', 'unlock',
    ])
    expect(test.state().profiles).toEqual({
      existing: { mode: 'external', endpoint: 'https://existing.example/search' },
      work: { mode: 'managed', endpoint: ENDPOINT },
    })
    expect(test.state().managed?.lastHealthyAt).toBe('2026-08-30T01:02:03.004Z')
  })

  it('recovers a matching owned but unhealthy deployment by restarting without rotating its configuration', async () => {
    const test = harness({ state: managedState(), ownership: 'owned', readinessFailures: 1 })
    const randomSecret = vi.fn(() => 'b'.repeat(64))
    await expect(createSetup({ randomSecret })({ profile: 'web', port: 8080 }, test.deps)).resolves.toMatchObject({ reused: false })
    expect(test.events).toEqual([
      'lock', 'environment', 'state-read', 'dsh-preflight', 'docker-preflight', 'ownership', 'profile-preview', 'readiness', 'docker-restart',
      'readiness', 'real-search', 'profile-attach', 'provider-search',
      'state-write', 'unlock',
    ])
    expect(test.environment.preflightManaged).not.toHaveBeenCalled()
    expect(test.assets.render).not.toHaveBeenCalled()
    expect(test.docker.up).not.toHaveBeenCalled()
    expect(test.docker.down).not.toHaveBeenCalled()
    expect(randomSecret).not.toHaveBeenCalled()
    expect(test.state().managed).toMatchObject({
      deploymentVersion: 1,
      image: SEARXNG_IMAGE,
      endpoint: ENDPOINT,
      port: 8080,
      homeId: HOME_ID,
      projectName: PROJECT,
      containerName: PROJECT,
      lastHealthyAt: '2026-08-30T01:02:03.004Z',
    })
  })

  it('does not restart when readiness passes but real search has an unclassified deterministic failure', async () => {
    const test = harness({ state: managedState(), ownership: 'owned', realSearchFailures: 1 })
    await expect(setup({ profile: 'web', port: 8080 }, test.deps)).rejects.toMatchObject({ code: 'E_SEARCH_FAILED' })
    expect(test.docker.restart).not.toHaveBeenCalled()
    expect(test.profiles.attach).not.toHaveBeenCalled()
  })

  it.each(['E_JSON_DISABLED', 'E_AUTH_FAILED', 'E_RATE_LIMITED', 'E_SEARCH_FAILED'] as const)(
    'does not restart for deterministic readiness failure %s',
    async (code) => {
      const failure = new CliError(code, 'deterministic failure', 'fix configuration')
      const test = harness({ state: managedState(), ownership: 'owned', readinessErrors: [failure] })
      await expect(setup({ profile: 'web', port: 8080 }, test.deps)).rejects.toBe(failure)
      expect(test.docker.restart).not.toHaveBeenCalled()
      expect(test.assets.render).not.toHaveBeenCalled()
    },
  )

  it.each(['E_AUTH_FAILED', 'E_JSON_DISABLED', 'E_RATE_LIMITED', 'E_SEARCH_FAILED'] as const)(
    'preserves deterministic %s after a timeout-triggered restart',
    async (code) => {
      const credential = 'Bearer restart-private-token'
      const failure = new CliError(code, 'deterministic recovery failure', 'fix configuration')
      const test = harness({
        state: managedState(),
        ownership: 'owned',
        readinessFailures: 1,
        realSearchError: failure,
        profileConfig: { authHeader: credential },
      })
      const error = await setup({ profile: 'web', port: 8080 }, test.deps).catch((cause: unknown) => cause)
      expect(error).toBe(failure)
      expect(test.docker.restart).toHaveBeenCalledOnce()
      expect(test.docker.down).not.toHaveBeenCalled()
      expect(JSON.stringify((error as CliError).toJSON())).not.toContain(credential)
    },
  )

  it('is byte-level idempotent when managed state and the effective attachment are already correct', async () => {
    const initial = managedState()
    initial.profiles.web = { mode: 'managed', endpoint: ENDPOINT }
    const test = harness({ state: initial, ownership: 'owned', profileAttached: true })
    await expect(setup({ profile: 'web', port: 8080 }, test.deps)).resolves.toEqual({ profile: 'web', endpoint: ENDPOINT, reused: true })
    expect(test.profiles.attach).not.toHaveBeenCalled()
    expect(test.deps.state.write).not.toHaveBeenCalled()
    expect(test.writes).toEqual([])
    expect(test.state()).toEqual(initial)
    expect(test.events).toEqual([
      'lock', 'environment', 'state-read', 'dsh-preflight', 'docker-preflight', 'ownership',
      'profile-preview', 'readiness', 'real-search', 'profile-validate', 'provider-search', 'unlock',
    ])
  })

  it('rejects a managed idempotent result after a different-byte attachment change during provider validation', async () => {
    const initial = managedState()
    initial.profiles.web = { mode: 'managed', endpoint: ENDPOINT }
    const concurrent = new CliError(
      'E_PROFILE_CONCURRENT_MODIFICATION',
      'profile changed',
      'retry setup',
    )
    const test = harness({ state: initial, ownership: 'owned', profileAttached: true, validatePostcheckError: concurrent })
    await expect(setup({ profile: 'web', port: 8080 }, test.deps)).rejects.toBe(concurrent)
    expect(test.profiles.attach).not.toHaveBeenCalled()
    expect(test.deps.state.write).not.toHaveBeenCalled()
  })

  it('rejects a managed idempotent result after manifest dependency removal during provider validation', async () => {
    const initial = managedState()
    initial.profiles.web = { mode: 'managed', endpoint: ENDPOINT }
    const concurrent = new CliError(
      'E_PROFILE_CONCURRENT_MODIFICATION',
      'manifest changed',
      'retry setup',
    )
    const test = harness({ state: initial, ownership: 'owned', profileAttached: true, validatePostcheckError: concurrent })
    await expect(setup({ profile: 'web', port: 8080 }, test.deps)).rejects.toBe(concurrent)
    expect(test.deps.state.write).not.toHaveBeenCalled()
  })

  it('uses the effective profile auth and search config for raw and provider validation', async () => {
    const initial = managedState()
    initial.profiles.web = { mode: 'managed', endpoint: ENDPOINT }
    const config = { language: 'zh-CN', engines: 'bing', categories: 'general', authHeader: 'Bearer private-token' }
    const test = harness({ state: initial, ownership: 'owned', profileAttached: true, profileConfig: config })
    await setup({ profile: 'web', port: 8080 }, test.deps)
    expect(test.probeInputs).toEqual([
      { baseURL: ENDPOINT, ...config },
      { baseURL: ENDPOINT, ...config },
    ])
    expect(JSON.stringify(test.events)).not.toContain('private-token')
  })

  it('inherits the persisted managed port only when CLI port was not explicit', async () => {
    const endpoint = 'http://127.0.0.1:9090'
    const initial = managedState({ port: 9090, endpoint })
    initial.profiles.web = { mode: 'managed', endpoint }
    const inherited = harness({ state: initial, ownership: 'owned', profileAttached: true })
    await expect(setup({ profile: 'web', port: 8080, portExplicit: false }, inherited.deps))
      .resolves.toEqual({ profile: 'web', endpoint, reused: true })
    expect(inherited.profiles.preview).toHaveBeenCalledWith('web', endpoint, undefined)

    const explicit = harness({ state: initial, ownership: 'owned' })
    await expect(setup({ profile: 'web', port: 8080, portExplicit: true }, explicit.deps)).rejects.toMatchObject({
      code: 'E_STATE_INVALID', action: expect.stringMatching(/repair|migrat/i),
    })
    expect(explicit.docker.preflight).not.toHaveBeenCalled()
  })

  it('stops instead of rotating configuration when owned resources lack matching state', async () => {
    const missing = harness({ ownership: 'owned' })
    await expect(setup({ profile: 'web', port: 8080 }, missing.deps)).rejects.toMatchObject({
      code: 'E_STATE_INVALID', action: expect.stringMatching(/doctor|repair/i),
    })
    expect(missing.events).toEqual(['lock', 'environment', 'state-read', 'dsh-preflight', 'docker-preflight', 'ownership', 'unlock'])

    const mismatched = harness({ state: managedState({ image: 'other-image' }), ownership: 'owned' })
    await expect(setup({ profile: 'web', port: 8080 }, mismatched.deps)).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
    expect(mismatched.assets.render).not.toHaveBeenCalled()
    expect(mismatched.docker.up).not.toHaveBeenCalled()
    expect(mismatched.docker.restart).not.toHaveBeenCalled()
  })

  it('stops for repair when state claims a deployment but its Docker resources are absent', async () => {
    const test = harness({ state: managedState(), ownership: 'absent' })
    await expect(setup({ profile: 'web', port: 8080 }, test.deps)).rejects.toMatchObject({
      code: 'E_STATE_INVALID', action: expect.stringMatching(/doctor|repair/i),
    })
    expect(test.assets.render).not.toHaveBeenCalled()
    expect(test.docker.up).not.toHaveBeenCalled()
  })

  it('does not attach or write healthy state when restart fails or remains unhealthy', async () => {
    const restartFailure = harness({ state: managedState(), ownership: 'owned', readinessFailures: 1 })
    vi.mocked(restartFailure.deps.docker.restart).mockRejectedValueOnce(new CliError('E_INTERNAL', 'Restart failed', 'Run doctor and repair'))
    await expect(setup({ profile: 'web', port: 8080 }, restartFailure.deps)).rejects.toMatchObject({ action: expect.stringMatching(/doctor|repair/i) })
    expect(restartFailure.events).not.toContain('profile-attach')
    expect(restartFailure.events).not.toContain('state-write')
    expect(restartFailure.docker.down).not.toHaveBeenCalled()

    const stillUnhealthy = harness({ state: managedState(), ownership: 'owned', readinessFailures: 2 })
    await expect(setup({ profile: 'web', port: 8080 }, stillUnhealthy.deps)).rejects.toMatchObject({
      code: 'E_STATE_INVALID', action: expect.stringMatching(/doctor|repair/i),
    })
    expect(stillUnhealthy.events).not.toContain('profile-attach')
    expect(stillUnhealthy.events).not.toContain('state-write')
    expect(stillUnhealthy.docker.down).not.toHaveBeenCalled()
  })

  it('validates and normalizes an external endpoint with zero Docker, managed-preflight, or asset calls', async () => {
    const initial = managedState()
    const test = harness({ state: initial })
    await expect(setup({ profile: 'work', port: 9999, url: 'https://search.example/path///' }, test.deps))
      .resolves.toEqual({ profile: 'work', endpoint: 'https://search.example/path', reused: false })
    expect(test.events).toEqual(['lock', 'environment', 'state-read', 'dsh-preflight', 'profile-preview', 'real-search', 'profile-attach', 'provider-search', 'state-write', 'unlock'])
    expect(test.docker.preflight).not.toHaveBeenCalled()
    expect(test.docker.inspectOwnership).not.toHaveBeenCalled()
    expect(test.assets.render).not.toHaveBeenCalled()
    expect(test.environment.preflightManaged).not.toHaveBeenCalled()
    expect(test.state().managed).toEqual(initial.managed)
    expect(test.state().profiles.work).toEqual({ mode: 'external', endpoint: 'https://search.example/path' })
  })

  it('is byte-level idempotent for an already attached matching external profile', async () => {
    const endpoint = 'https://search.example/path'
    const initial: StateV1 = {
      schemaVersion: 1,
      profiles: { work: { mode: 'external', endpoint } },
    }
    const test = harness({ state: initial, profileAttached: true })
    await expect(setup({ profile: 'work', port: 8080, url: endpoint }, test.deps))
      .resolves.toEqual({ profile: 'work', endpoint, reused: true })
    expect(test.profiles.attach).not.toHaveBeenCalled()
    expect(test.deps.state.write).not.toHaveBeenCalled()
    expect(test.state()).toEqual(initial)
    expect(test.events).toEqual([
      'lock', 'environment', 'state-read', 'dsh-preflight', 'profile-preview',
      'real-search', 'profile-validate', 'provider-search', 'unlock',
    ])
  })

  it('rejects an external idempotent result after a same-byte inode replacement during provider validation', async () => {
    const endpoint = 'https://search.example/path'
    const initial: StateV1 = { schemaVersion: 1, profiles: { work: { mode: 'external', endpoint } } }
    const concurrent = new CliError(
      'E_PROFILE_CONCURRENT_MODIFICATION',
      'profile changed',
      'retry setup',
    )
    const test = harness({ state: initial, profileAttached: true, validatePostcheckError: concurrent })
    await expect(setup({ profile: 'work', port: 8080, url: endpoint }, test.deps)).rejects.toBe(concurrent)
    expect(test.profiles.attach).not.toHaveBeenCalled()
    expect(test.deps.state.write).not.toHaveBeenCalled()
  })

  it('rejects an external idempotent result after a same-byte manifest inode replacement during provider validation', async () => {
    const endpoint = 'https://search.example/path'
    const initial: StateV1 = { schemaVersion: 1, profiles: { work: { mode: 'external', endpoint } } }
    const concurrent = new CliError(
      'E_PROFILE_CONCURRENT_MODIFICATION',
      'manifest replaced',
      'retry setup',
    )
    const test = harness({ state: initial, profileAttached: true, validatePostcheckError: concurrent })
    await expect(setup({ profile: 'work', port: 8080, url: endpoint }, test.deps)).rejects.toBe(concurrent)
    expect(test.deps.state.write).not.toHaveBeenCalled()
  })

  it('restores managed state when a state-only repair races with manifest dependency removal', async () => {
    const previous = managedState()
    const concurrent = new CliError(
      'E_PROFILE_CONCURRENT_MODIFICATION',
      'profile changed',
      'retry setup',
    )
    const test = harness({
      state: previous,
      ownership: 'owned',
      profileAttached: true,
      validatePostcheckError: concurrent,
    })
    await expect(setup({ profile: 'web', port: 8080 }, test.deps)).rejects.toBe(concurrent)
    expect(test.profiles.attach).not.toHaveBeenCalled()
    expect(test.writes).toHaveLength(2)
    expect(test.state()).toEqual(previous)
  })

  it('preserves manifest concurrency context when state-only repair rollback also fails', async () => {
    const credential = 'Bearer manifest-race-private-token'
    const previous = managedState()
    const concurrent = new CliError(
      'E_PROFILE_CONCURRENT_MODIFICATION',
      'manifest changed',
      'retry setup',
    )
    const test = harness({
      state: previous,
      ownership: 'owned',
      profileAttached: true,
      validatePostcheckError: concurrent,
      writeBehaviors: ['success', 'fail-before'],
      profileConfig: { authHeader: credential },
    })
    const error = await setup({ profile: 'web', port: 8080 }, test.deps).catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      code: 'E_INTERNAL',
      details: {
        primaryError: 'E_PROFILE_CONCURRENT_MODIFICATION',
        rollbackFailures: ['state'],
      },
    })
    expect(test.docker.down).not.toHaveBeenCalled()
    expect(JSON.stringify((error as CliError).toJSON())).not.toContain(credential)
  })

  it.each(['fail-before', 'fail-after'] as const)(
    'restores previous state after a state-only repair %s write failure',
    async (behavior) => {
      const previous = managedState()
      const test = harness({
        state: previous,
        ownership: 'owned',
        profileAttached: true,
        writeBehaviors: [behavior, 'success'],
      })
      await expect(setup({ profile: 'web', port: 8080 }, test.deps)).rejects.toMatchObject({ code: 'E_INTERNAL' })
      expect(test.profiles.attach).not.toHaveBeenCalled()
      expect(test.state()).toEqual(previous)
      expect(test.writes.at(-1)).toEqual(previous)
    },
  )

  it('aggregates a state-only repair failure when restoring previous state also fails', async () => {
    const previous = managedState()
    const test = harness({
      state: previous,
      ownership: 'owned',
      profileAttached: true,
      writeBehaviors: ['fail-after', 'fail-before'],
    })
    await expect(setup({ profile: 'web', port: 8080 }, test.deps)).rejects.toMatchObject({
      code: 'E_INTERNAL',
      details: { rollbackFailures: ['state'] },
    })
    expect(test.profiles.attach).not.toHaveBeenCalled()
    expect(test.docker.down).not.toHaveBeenCalled()
  })

  it('does not mistake an attached external profile with mismatched state for an idempotent setup', async () => {
    const endpoint = 'https://search.example/path'
    const initial: StateV1 = {
      schemaVersion: 1,
      profiles: { work: { mode: 'external', endpoint: 'https://old.example' } },
    }
    const test = harness({ state: initial, profileAttached: true })
    await expect(setup({ profile: 'work', port: 8080, url: endpoint }, test.deps))
      .resolves.toEqual({ profile: 'work', endpoint, reused: false })
    expect(test.profiles.attach).toHaveBeenCalledOnce()
    expect(test.deps.state.write).toHaveBeenCalledOnce()
    expect(test.state().profiles.work).toEqual({ mode: 'external', endpoint })
  })

  it('requires dsh before every external profile operation', async () => {
    const missing = new CliError('E_DSH_MISSING', 'missing', 'install dsh')
    const test = harness({ dshError: missing })
    await expect(setup({ profile: 'web', port: 8080, url: 'https://search.example' }, test.deps)).rejects.toBe(missing)
    expect(test.profiles.preview).not.toHaveBeenCalled()
    expect(test.deps.searxng.realSearch).not.toHaveBeenCalled()
    expect(test.profiles.attach).not.toHaveBeenCalled()
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
    expect(test.events).toEqual(['lock', 'environment', 'state-read', 'dsh-preflight', 'docker-preflight', 'ownership', 'profile-preview', 'managed-preflight', 'unlock'])
    expect(test.assets.render).not.toHaveBeenCalled()
    expect(test.docker.up).not.toHaveBeenCalled()
  })

  it('refuses foreign resources before rendering or mutation', async () => {
    const test = harness({ ownershipError: new CliError('E_RESOURCE_FOREIGN', 'foreign', 'rename it') })
    await expect(setup({ profile: 'web', port: 8080 }, test.deps)).rejects.toMatchObject({ code: 'E_RESOURCE_FOREIGN' })
    expect(test.events).toEqual(['lock', 'environment', 'state-read', 'dsh-preflight', 'docker-preflight', 'ownership', 'unlock'])
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

  it.each([
    ['partial up', { upError: new CliError('E_INTERNAL', 'partial up', 'retry'), ownershipSequence: ['absent', 'owned'] }],
    ['readiness', { readinessErrors: [new CliError('E_SEARXNG_START_TIMEOUT', 'timeout', 'retry')], ownershipSequence: ['absent', 'owned'] }],
    ['real search', { realSearchError: new CliError('E_SEARCH_FAILED', 'search failed', 'retry'), ownershipSequence: ['absent', 'owned'] }],
    ['provider search', { providerSearchError: new CliError('E_SEARCH_FAILED', 'provider failed', 'retry'), ownershipSequence: ['absent', 'owned'] }],
    ['state write', { writeBehaviors: ['fail-before'], ownershipSequence: ['absent', 'owned'] }],
  ] as const)('rolls back transaction-created Docker resources after %s failure', async (_stage, options) => {
    const test = harness(options as HarnessOptions)
    await expect(setup({ profile: 'web', port: 8080 }, test.deps)).rejects.toBeDefined()
    expect(test.events.slice(-3)).toEqual(['ownership', 'docker-down', 'unlock'])
    expect(test.docker.down).toHaveBeenCalledWith(expect.objectContaining({ composePath: COMPOSE_PATH }), true)
    expect(test.state()).toEqual({ schemaVersion: 1, profiles: {} })
  })

  it('rolls back transaction-created resources on cancellation after Docker mutation', async () => {
    const controller = new AbortController()
    const cancellation = new Error('cancelled after up')
    const test = harness({ ownershipSequence: ['absent', 'owned'] })
    vi.mocked(test.deps.searxng.readiness).mockImplementationOnce(async () => {
      test.events.push('readiness')
      controller.abort(cancellation)
      throw cancellation
    })
    await expect(setup({ profile: 'web', port: 8080 }, test.deps, controller.signal)).rejects.toBe(cancellation)
    expect(test.events.slice(-3)).toEqual(['ownership', 'docker-down', 'unlock'])
  })

  it('restores previous state after attach postcheck fails following a committed state write', async () => {
    const previous: StateV1 = { schemaVersion: 1, profiles: { old: { mode: 'external', endpoint: 'https://old.example' } } }
    const postcheck = new CliError('E_PROFILE_WRITE', 'profile changed after validation', 'repair profile')
    const test = harness({ state: previous, postAttachError: postcheck, ownershipSequence: ['absent', 'owned'] })
    await expect(setup({ profile: 'web', port: 8080 }, test.deps)).rejects.toBe(postcheck)
    expect(test.profileEndpoint()).toBe('before')
    expect(test.writes).toHaveLength(2)
    expect(test.writes.at(-1)).toEqual(previous)
    expect(test.state()).toEqual(previous)
    expect(test.events.slice(-4)).toEqual(['state-write', 'ownership', 'docker-down', 'unlock'])
  })

  it('restores previous state after a managed state write commits bytes and then throws', async () => {
    const credential = 'Bearer fail-after-private-token'
    const previous: StateV1 = { schemaVersion: 1, profiles: { old: { mode: 'external', endpoint: 'https://old.example' } } }
    const test = harness({
      state: previous,
      writeBehaviors: ['fail-after', 'success'],
      ownershipSequence: ['absent', 'owned'],
      profileConfig: { authHeader: credential },
    })
    const error = await setup({ profile: 'web', port: 8080 }, test.deps).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'E_INTERNAL' })
    expect(test.profileEndpoint()).toBe('before')
    expect(test.state()).toEqual(previous)
    expect(test.writes.at(-1)).toEqual(previous)
    expect(test.events.slice(-4)).toEqual(['state-write', 'ownership', 'docker-down', 'unlock'])
    expect(JSON.stringify((error as CliError).toJSON())).not.toContain(credential)
  })

  it('restores previous state after an external state write commits bytes and then throws', async () => {
    const previous: StateV1 = { schemaVersion: 1, profiles: { old: { mode: 'external', endpoint: 'https://old.example' } } }
    const test = harness({ state: previous, writeBehaviors: ['fail-after', 'success'] })
    await expect(setup({ profile: 'web', port: 8080, url: 'https://search.example' }, test.deps))
      .rejects.toMatchObject({ code: 'E_INTERNAL' })
    expect(test.profileEndpoint()).toBe('before')
    expect(test.state()).toEqual(previous)
    expect(test.writes.at(-1)).toEqual(previous)
    expect(test.docker.down).not.toHaveBeenCalled()
  })

  it('aggregates an ambiguous state write failure when restoring previous state also fails', async () => {
    const credential = 'Bearer restore-private-token'
    const test = harness({
      writeBehaviors: ['fail-after', 'fail-before'],
      ownershipSequence: ['absent', 'owned'],
      profileConfig: { authHeader: credential },
    })
    const error = await setup({ profile: 'web', port: 8080 }, test.deps).catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      code: 'E_INTERNAL',
      details: { rollbackFailures: ['state'] },
    })
    expect(test.docker.down).toHaveBeenCalledWith(expect.objectContaining({ composePath: COMPOSE_PATH }), true)
    expect(JSON.stringify((error as CliError).toJSON())).not.toContain(credential)
  })

  it('continues all rollback steps and reports only safe categories when rollback also fails', async () => {
    const credential = 'Bearer private-token'
    const test = harness({
      postAttachError: new Error(`postcheck ${credential}`),
      ownershipSequence: ['absent', 'owned'],
      writeBehaviors: ['success', 'fail-before'],
      downError: new Error(`docker rollback ${credential}`),
      profileConfig: { authHeader: credential },
    })
    const error = await setup({ profile: 'web', port: 8080 }, test.deps).catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      code: 'E_INTERNAL',
      details: { rollbackFailures: expect.arrayContaining(['state', 'docker']) },
    })
    expect(test.events).toContain('docker-down')
    expect(JSON.stringify((error as CliError).toJSON())).not.toContain(credential)
  })

  it('stops cleanup safely when its ownership guard fails and never attempts Docker deletion', async () => {
    const credential = 'Bearer cleanup-private-token'
    const test = harness({
      readinessErrors: [new CliError('E_SEARXNG_START_TIMEOUT', 'timeout', 'retry')],
      ownershipSequence: ['absent', new Error(`ownership inspection ${credential}`)],
      profileConfig: { authHeader: credential },
    })
    const error = await setup({ profile: 'web', port: 8080 }, test.deps).catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      code: 'E_INTERNAL',
      details: { rollbackFailures: ['docker-ownership'] },
    })
    expect(test.docker.down).not.toHaveBeenCalled()
    expect(JSON.stringify((error as CliError).toJSON())).not.toContain(credential)
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
    const writeError = await setup(
      { profile: 'web', port: 8080 },
      { ...test.deps, state: { ...test.deps.state, write: async () => { throw new Error('query=private') } } },
    ).catch((cause: unknown) => cause)
    expect(writeError).toMatchObject({
      code: 'E_INTERNAL',
      message: 'Setup failed and rollback was incomplete',
      details: { rollbackFailures: ['state'] },
    })
    expect(JSON.stringify((writeError as CliError).toJSON())).not.toContain('query=private')
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

  it('preserves an existing managed port when setup omits --port', async () => {
    const endpoint = 'http://127.0.0.1:9090'
    const initial = managedState({ port: 9090, endpoint })
    initial.profiles.web = { mode: 'managed', endpoint }
    const test = harness({ state: initial, ownership: 'owned', profileAttached: true })
    const stdout: string[] = []
    const exitCode = await runCli(['setup', '--json'], {
      dependencies: test.deps,
      stdout: (text) => stdout.push(text),
      stderr: vi.fn(),
    })
    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout[0]!)).toEqual({ endpoint, profile: 'web', reused: true })
    expect(test.profiles.preview).toHaveBeenCalledWith('web', endpoint, undefined)
    expect(test.environment.preflightManaged).not.toHaveBeenCalled()
    expect(test.assets.render).not.toHaveBeenCalled()
  })

  it('prints an actionable one-write human ready result without exposing secrets', async () => {
    const test = harness()
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = await runCli(['setup', '--profile', 'work'], {
      dependencies: test.deps,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    })
    expect(exitCode).toBe(0)
    expect(stdout).toHaveLength(1)
    expect(stdout[0]).toContain('Profile: work')
    expect(stdout[0]).toContain(`Endpoint: ${ENDPOINT}`)
    expect(stdout[0]).toMatch(/Validation:.*passed/i)
    expect(stdout[0]).toContain('Next: dsh --profile work')
    expect(stdout[0]).not.toMatch(/[a-f0-9]{64}/)
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

  it('detects a symlinked executable by real path but never treats an ordinary import as main', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-searxng-main-'))
    const target = join(directory, 'cli.mjs')
    const link = join(directory, 'dsh-searxng')
    const imported = join(directory, 'imported.mjs')
    try {
      await writeFile(target, '#!/usr/bin/env node\n', 'utf8')
      await writeFile(imported, '', 'utf8')
      await symlink(target, link)
      await expect(isMainModule(pathToFileURL(target).href, link)).resolves.toBe(true)
      await expect(isMainModule(pathToFileURL(target).href, imported)).resolves.toBe(false)
      await expect(isMainModule(pathToFileURL(target).href, join(directory, 'missing'))).resolves.toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
