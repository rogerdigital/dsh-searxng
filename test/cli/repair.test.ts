import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FileAssetRenderer, SEARXNG_IMAGE, type AssetRenderer } from '../../src/cli/assets.ts'
import type { DockerAdapter } from '../../src/cli/docker.ts'
import { CliError } from '../../src/cli/errors.ts'
import type { EnvironmentService } from '../../src/cli/environment.ts'
import { recommendRecovery, stateSha256, type JournalStore, type OperationJournal, type OperationPhase } from '../../src/cli/journal.ts'
import type { ProfileManager } from '../../src/cli/profile.ts'
import type { SearxngProbe } from '../../src/cli/searxng.ts'
import type { StateStore, StateV2 } from '../../src/cli/state.ts'
import type { DiagnosticSnapshot } from '../../src/cli/diagnostics.ts'
import { executeRepair, planRepair, readPreservedSecretFromBundle, type RepairDependencies } from '../../src/cli/repair.ts'
import { runCli } from '../../src/cli.ts'

const HOME_ID = '0123456789abcdef'
const MANAGED_DIR = '/tmp/dsh/dsh-searxng'
const PROJECT = `dsh-searxng-${HOME_ID}`
const ENDPOINT = 'http://127.0.0.1:8080'
const EXTERNAL_ENDPOINT = 'https://search.example'
const COMPOSE_PATH = join(MANAGED_DIR, `config-${'a'.repeat(64)}`, 'compose.yml')
const RENDERED_HASH = 'b'.repeat(64)
const PERSISTED_HASH = 'c'.repeat(64)
const START = '2026-09-01T00:00:00.000Z'
const PRESERVED_SECRET = 'f'.repeat(64)

function snapshot(overrides: Partial<DiagnosticSnapshot> = {}): DiagnosticSnapshot {
  return {
    profile: 'web',
    expectedEndpoint: ENDPOINT,
    stateHash: 'a'.repeat(64),
    mode: 'managed',
    docker: 'healthy',
    ownership: 'owned',
    container: 'running',
    generatedAssets: 'valid',
    port: 'owned',
    endpoint: 'healthy',
    ownedTemporaryResourceIds: [],
    ...overrides,
  }
}

function externalSnapshot(overrides: Partial<DiagnosticSnapshot> = {}): DiagnosticSnapshot {
  return snapshot({
    mode: 'external',
    expectedEndpoint: EXTERNAL_ENDPOINT,
    ownership: 'absent',
    container: 'missing',
    port: 'available',
    ...overrides,
  })
}

function journalFixture(phase: OperationPhase = 'mutating'): OperationJournal {
  return {
    schemaVersion: 1,
    id: 'd'.repeat(32),
    kind: 'update',
    phase,
    startedAt: START,
    updatedAt: START,
    beforeStateSha256: 'a'.repeat(64),
  }
}

function planError(input: DiagnosticSnapshot): CliError {
  try {
    planRepair(input)
  } catch (error) {
    return error as CliError
  }
  throw new Error('expected planRepair to throw')
}

describe('planRepair', () => {
  it('plans no actions for a healthy system and echoes the snapshot identity', () => {
    const plan = planRepair(snapshot())
    expect(plan).toMatchObject({
      profile: 'web',
      endpoint: ENDPOINT,
      mode: 'managed',
      stateHash: 'a'.repeat(64),
      actions: [],
    })
    expect(plan.recovery).toBeUndefined()
    expect(plan.summary.length).toBeGreaterThan(0)
  })

  it('restarts a stopped owned container', () => {
    const plan = planRepair(snapshot({ container: 'stopped', port: 'available' }))
    expect(plan.actions).toEqual([{ type: 'restart-container' }])
  })

  it('restarts a hung running container with an unreachable endpoint', () => {
    expect(planRepair(snapshot({ endpoint: 'unreachable' })).actions).toEqual([{ type: 'restart-container' }])
  })

  it.each(['missing', 'invalid'] as const)('re-renders %s generated assets with the same secret, then recreates', (generatedAssets) => {
    const plan = planRepair(snapshot({ generatedAssets }))
    expect(plan.actions).toEqual([
      { type: 'render-assets', preserveSecret: true },
      { type: 'recreate-runtime', preserveData: true },
    ])
  })

  it('recreates a missing runtime while preserving owned data', () => {
    expect(planRepair(snapshot({ container: 'missing', port: 'available' })).actions).toEqual([
      { type: 'recreate-runtime', preserveData: true },
    ])
  })

  it('reattaches only the profile for a stale managed endpoint', () => {
    const plan = planRepair(snapshot({ profileEndpoint: { profile: 'web', expected: ENDPOINT } }))
    expect(plan.actions).toEqual([{ type: 'reattach-profile', profile: 'web', endpoint: ENDPOINT }])
  })

  it('reattaches a healthy external profile whose attachment drifted', () => {
    const plan = planRepair(externalSnapshot({ profileEndpoint: { profile: 'web', expected: EXTERNAL_ENDPOINT } }))
    expect(plan.actions).toEqual([{ type: 'reattach-profile', profile: 'web', endpoint: EXTERNAL_ENDPOINT }])
  })

  it('plans no actions for a healthy external system', () => {
    expect(planRepair(externalSnapshot()).actions).toEqual([])
  })

  it('plans removal of owned temporary resources alongside ordinary repair', () => {
    const plan = planRepair(snapshot({ ownedTemporaryResourceIds: ['tmp-a', 'tmp-b'] }))
    expect(plan.actions).toEqual([
      { type: 'remove-owned-temporary', resourceIds: ['tmp-a', 'tmp-b'] },
    ])
  })

  it.each([
    ['foreign container', snapshot({ ownership: 'foreign', container: 'missing' }), 'E_RESOURCE_FOREIGN'],
    ['occupied foreign port', snapshot({ container: 'missing', port: 'foreign' }), 'E_PORT_CONFLICT'],
    ['Docker offline', snapshot({ docker: 'offline', endpoint: 'unreachable' }), 'E_DOCKER_OFFLINE'],
    ['external endpoint failure', externalSnapshot({ endpoint: 'unreachable' }), 'E_SEARCH_FAILED'],
    ['TLS failure', snapshot({ endpoint: 'tls-failed' }), 'E_TLS_FAILED'],
    ['external TLS failure', externalSnapshot({ endpoint: 'tls-failed' }), 'E_TLS_FAILED'],
    ['authentication failure', snapshot({ endpoint: 'auth-failed' }), 'E_AUTH_FAILED'],
    ['external authentication failure', externalSnapshot({ endpoint: 'auth-failed' }), 'E_AUTH_FAILED'],
  ] as const)('blocks repair for %s with one CliError and no actions', (_name, input, code) => {
    const error = planError(input)
    expect(error).toBeInstanceOf(CliError)
    expect(error.code).toBe(code)
    expect(error.action.length).toBeGreaterThan(0)
  })

  it.each(['prepared', 'mutating', 'validating', 'rolling-back'] as const)(
    'surfaces the recovery recommendation for an interrupted update in %s instead of ordinary actions',
    (phase) => {
      const interrupted = journalFixture(phase)
      const damaged = snapshot({ interruptedOperation: interrupted, container: 'stopped', port: 'available' })
      const plan = planRepair(damaged)
      expect(plan.actions).toEqual([])
      expect(plan.recovery).toEqual(recommendRecovery(interrupted))
      expect(plan.summary).toEqual([recommendRecovery(interrupted).summary])
    },
  )
})

function managedState(configurationSha256: string = PERSISTED_HASH): StateV2 {
  return {
    schemaVersion: 2,
    homeId: HOME_ID,
    managed: {
      current: {
        deploymentVersion: 1,
        image: SEARXNG_IMAGE,
        endpoint: ENDPOINT,
        port: 8080,
        projectName: PROJECT,
        containerName: PROJECT,
        configurationSha256,
      },
      lastHealthyAt: '2026-08-29T00:00:00.000Z',
    },
    profiles: { web: { mode: 'managed', endpoint: ENDPOINT } },
  }
}

function externalState(): StateV2 {
  return {
    schemaVersion: 2,
    homeId: HOME_ID,
    profiles: { web: { mode: 'external', endpoint: EXTERNAL_ENDPOINT } },
  }
}

function fakeJournalStore(events: string[], initial?: OperationJournal) {
  let active = initial === undefined ? undefined : structuredClone(initial)
  const store: JournalStore = {
    read: vi.fn(async () => { events.push('journal-read'); return active === undefined ? undefined : structuredClone(active) }),
    begin: vi.fn(async (input: Parameters<JournalStore['begin']>[0]): Promise<OperationJournal> => {
      events.push('journal-begin')
      if (active !== undefined) throw new CliError('E_STATE_INVALID', 'occupied', 'doctor')
      active = {
        schemaVersion: 1,
        id: 'e'.repeat(32),
        startedAt: START,
        updatedAt: START,
        ...structuredClone(input),
      }
      return structuredClone(active)
    }),
    transition: vi.fn(async (id, phase) => {
      events.push(`journal-${phase}`)
      if (active === undefined || active.id !== id) throw new CliError('E_STATE_INVALID', 'mismatch', 'doctor')
      active = { ...active, phase, updatedAt: START }
      return structuredClone(active)
    }),
    clear: vi.fn(async (id) => {
      events.push('journal-clear')
      if (active === undefined || active.id !== id) throw new CliError('E_STATE_INVALID', 'mismatch', 'doctor')
      active = undefined
    }),
  }
  return { store, active: () => active }
}

interface HarnessOptions {
  state?: StateV2
  journal?: OperationJournal
  container?: 'running' | 'stopped' | 'absent'
  foreign?: boolean
  ownership?: 'owned' | 'absent' | 'foreign'
  dockerOffline?: boolean
  realSearchError?: unknown
  readSecretError?: unknown
  supportRemoveOwnedResource?: boolean
  managedDir?: string
  assetsRenderer?: AssetRenderer
  renderFailures?: number
  renderErrorCode?: 'E_BUNDLE_DAMAGED' | 'E_STATE_INVALID'
  useProductionSecretReader?: boolean
  abortDuringPreview?: { controller: AbortController; reason: unknown }
}

function executorHarness(options: HarnessOptions = {}) {
  const events: string[] = []
  const writes: StateV2[] = []
  const managedDir = options.managedDir ?? MANAGED_DIR
  let state = structuredClone(options.state ?? managedState())
  const journal = fakeJournalStore(events, options.journal)
  const environment: EnvironmentService = {
    resolve: vi.fn(async (profile: string) => {
      events.push('environment')
      return { dshHome: '/tmp/dsh', profileDir: `/tmp/dsh/profiles/${profile}`, managedDir, homeId: HOME_ID }
    }),
    preflightManaged: vi.fn(async () => {}),
    preflightDsh: vi.fn(async () => {}),
  }
  const docker: DockerAdapter = {
    preflight: vi.fn(async () => {
      events.push('docker-preflight')
      if (options.dockerOffline) throw new CliError('E_DOCKER_OFFLINE', 'offline', 'start Docker')
      return { serverVersion: '27', composeVersion: '2.30' }
    }),
    inspectOwnership: vi.fn(async () => 'owned' as const),
    up: vi.fn(async () => { events.push('docker-up') }),
    restart: vi.fn(async () => { events.push('docker-restart') }),
    down: vi.fn(async (_identity, volumes) => { events.push(`docker-down:${volumes}`) }),
    logs: vi.fn(async () => ''),
    deploymentStatus: vi.fn(async () => {
      events.push('ownership')
      if (options.foreign) throw new CliError('E_RESOURCE_FOREIGN', 'foreign', 'rename it')
      return {
        ownership: options.ownership ?? 'owned' as const,
        container: options.container ?? 'running' as const,
        composePath: COMPOSE_PATH,
      }
    }),
  }
  if (options.supportRemoveOwnedResource) {
    docker.removeOwnedResource = vi.fn(async (resourceId: string) => { events.push(`remove-resource:${resourceId}`) })
  }
  let renderFailures = options.renderFailures ?? 0
  const renderErrorCode = options.renderErrorCode ?? 'E_BUNDLE_DAMAGED'
  const assets: AssetRenderer = options.assetsRenderer ?? {
    render: vi.fn(async (input: { identity: { stateDir: string }; port: number }) => {
      events.push('render')
      expect(input.identity.stateDir).toBe(managedDir)
      if (renderFailures > 0) {
        renderFailures -= 1
        throw new CliError(renderErrorCode, 'Managed configuration bundle does not match its identity', 'repair the bundle')
      }
      return { composePath: COMPOSE_PATH, configurationSha256: RENDERED_HASH }
    }),
  }
  const searxng: SearxngProbe = {
    http: vi.fn(async () => { events.push('http') }),
    readiness: vi.fn(async () => { events.push('json') }),
    realSearch: vi.fn(async () => {
      events.push('search')
      if (options.realSearchError !== undefined) throw options.realSearchError
      return { endpoint: ENDPOINT, resultCount: 1, elapsedMs: 1 }
    }),
    providerSearch: vi.fn(async () => { events.push('provider-search'); return { endpoint: ENDPOINT, resultCount: 1, elapsedMs: 1 } }),
  }
  const profiles: ProfileManager = {
    inspect: vi.fn(),
    preview: vi.fn(async () => {
      events.push('profile-preview')
      if (options.abortDuringPreview !== undefined) {
        options.abortDuringPreview.controller.abort(options.abortDuringPreview.reason)
        throw options.abortDuringPreview.reason
      }
      return { installed: true, attached: true, config: { baseURL: ENDPOINT } }
    }),
    validate: vi.fn(async (_profile, _endpoint, callback) => {
      events.push('profile-validate')
      await callback({ baseURL: ENDPOINT })
    }),
    attach: vi.fn(async (_profile, endpoint, validate) => {
      events.push('profile-attach')
      await validate({ baseURL: endpoint })
    }),
    detach: vi.fn(),
    uninstall: vi.fn(),
  }
  const readPreservedSecret = vi.fn(async () => {
    events.push('read-secret')
    if (options.readSecretError !== undefined) throw options.readSecretError
    return PRESERVED_SECRET
  })
  const stateStore: StateStore = {
    read: vi.fn(async () => { events.push('state-read'); return structuredClone(state) }),
    write: vi.fn(async (next) => {
      events.push('state-write')
      state = structuredClone(next)
      writes.push(structuredClone(next))
    }),
    withLock: vi.fn(async (operation) => {
      events.push('lock')
      try { return await operation() } finally { events.push('unlock') }
    }),
  }
  const dependencies: RepairDependencies = {
    environment,
    state: stateStore,
    journal: journal.store,
    docker,
    assets,
    searxng,
    profiles,
    diagnose: vi.fn(async () => { throw new Error('executeRepair must not call diagnose') }),
    ...(options.useProductionSecretReader === true ? {} : { readPreservedSecret }),
    now: () => new Date(START),
  }
  return {
    dependencies, events, writes, journal, docker, assets, profiles, environment,
    readPreservedSecret,
    state: () => state,
    planFor: (overrides: Partial<DiagnosticSnapshot> = {}) => planRepair(
      snapshot({ stateHash: stateSha256(state), ...overrides }),
    ),
  }
}

describe('executeRepair', () => {
  it('executes a restart plan under the lock with journal discipline and validates before committing', async () => {
    const test = executorHarness()
    const plan = test.planFor({ container: 'stopped', port: 'available' })
    const result = await executeRepair(plan, test.dependencies)

    expect(result).toEqual({
      actions: [{ type: 'restart-container' }],
      checks: [
        { id: 'http', status: 'pass', message: 'SearXNG HTTP endpoint is reachable' },
        { id: 'json', status: 'pass', message: 'SearXNG JSON API is enabled' },
        { id: 'search', status: 'pass', message: 'SearXNG returned a real search result' },
        { id: 'profile', status: 'pass', message: 'DSH profile has the expected managed attachment' },
        { id: 'provider', status: 'pass', message: 'DSH provider search returned a result' },
      ],
      healthy: true,
    })
    expect(test.events).toEqual([
      'lock', 'state-read', 'journal-read', 'environment', 'docker-preflight', 'ownership',
      'journal-begin', 'journal-mutating', 'docker-restart', 'journal-validating',
      'profile-preview', 'http', 'json', 'search', 'profile-validate', 'provider-search',
      'state-write', 'journal-clear', 'unlock',
    ])
    expect(test.journal.store.begin).toHaveBeenCalledWith({
      kind: 'repair',
      phase: 'prepared',
      beforeStateSha256: plan.stateHash,
    })
    expect(test.docker.restart).toHaveBeenCalledWith(expect.objectContaining({ containerName: PROJECT }), undefined)
    expect(test.writes).toEqual([{
      ...managedState(),
      managed: { ...managedState().managed!, lastHealthyAt: START },
    }])
    expect(test.journal.active()).toBeUndefined()
  })

  it('re-renders assets with the preserved secret and recreates the runtime without purging data', async () => {
    const test = executorHarness()
    const plan = test.planFor({ generatedAssets: 'invalid', container: 'missing', port: 'available' })
    await executeRepair(plan, test.dependencies)

    expect(test.readPreservedSecret).toHaveBeenCalledWith(join(MANAGED_DIR, `config-${PERSISTED_HASH}`))
    expect(test.assets.render).toHaveBeenCalledWith(expect.objectContaining({
      stateDir: MANAGED_DIR,
      image: SEARXNG_IMAGE,
      port: 8080,
      secret: PRESERVED_SECRET,
    }))
    expect(test.assets.render).toHaveBeenCalledWith(expect.objectContaining({
      identity: expect.objectContaining({ projectName: PROJECT, containerName: PROJECT, homeId: HOME_ID }),
    }))
    expect(test.docker.down).toHaveBeenCalledWith(expect.objectContaining({ composePath: COMPOSE_PATH }), false, undefined)
    expect(test.docker.up).toHaveBeenCalledWith(expect.objectContaining({ composePath: COMPOSE_PATH }), undefined)
    expect(test.state().managed?.current.configurationSha256).toBe(RENDERED_HASH)
    expect(test.state().managed?.lastHealthyAt).toBe(START)
    expect(test.events.filter((event) => event === 'render' || event.startsWith('docker-'))).toEqual([
      'docker-preflight', 'render', 'docker-down:false', 'docker-up',
    ])
  })

  it('retries a damaged bundle render exactly once by removing the recorded bundle directory', async () => {
    const test = executorHarness({ renderFailures: 1 })
    const plan = test.planFor({ generatedAssets: 'invalid', container: 'missing', port: 'available' })
    const result = await executeRepair(plan, test.dependencies)
    expect(result.healthy).toBe(true)
    expect(test.assets.render).toHaveBeenCalledTimes(2)
    expect(test.events.filter((event) => event === 'render')).toEqual(['render', 'render'])
  })

  it('propagates a persistent bundle-render failure after the single rebuild retry', async () => {
    const test = executorHarness({ renderFailures: 3 })
    const plan = test.planFor({ generatedAssets: 'invalid', container: 'missing', port: 'available' })
    await expect(executeRepair(plan, test.dependencies)).rejects.toMatchObject({ code: 'E_BUNDLE_DAMAGED' })
    expect(test.assets.render).toHaveBeenCalledTimes(2)
    expect(test.journal.active()).toMatchObject({ kind: 'repair', phase: 'mutating' })
    expect(test.writes).toEqual([])
  })

  it('refuses to invent a secret when the bundle cannot preserve it and leaves the journal at mutating', async () => {
    const test = executorHarness({
      readSecretError: new CliError(
        'E_STATE_INVALID',
        'The managed SearXNG secret cannot be preserved because the configuration bundle is unreadable',
        'Run dsh-searxng setup to re-create the managed deployment',
      ),
    })
    const plan = test.planFor({ generatedAssets: 'missing', container: 'missing', port: 'available' })
    await expect(executeRepair(plan, test.dependencies)).rejects.toMatchObject({
      code: 'E_STATE_INVALID',
      action: expect.stringContaining('setup'),
    })
    expect(test.assets.render).not.toHaveBeenCalled()
    expect(test.docker.up).not.toHaveBeenCalled()
    expect(test.journal.active()).toMatchObject({ kind: 'repair', phase: 'mutating' })
    expect(test.writes).toEqual([])
  })

  it('reattaches an external profile without touching Docker and records the healthy attachment', async () => {
    const test = executorHarness({ state: externalState() })
    const plan = planRepair(externalSnapshot({
      stateHash: stateSha256(externalState()),
      profileEndpoint: { profile: 'web', expected: EXTERNAL_ENDPOINT },
    }))
    const result = await executeRepair(plan, test.dependencies)

    expect(result.actions).toEqual([{ type: 'reattach-profile', profile: 'web', endpoint: EXTERNAL_ENDPOINT }])
    expect(test.profiles.attach).toHaveBeenCalledWith('web', EXTERNAL_ENDPOINT, expect.any(Function), undefined)
    expect(test.docker.preflight).not.toHaveBeenCalled()
    expect(test.docker.deploymentStatus).not.toHaveBeenCalled()
    expect(test.writes).toEqual([externalState()])
    expect(test.events).toEqual([
      'lock', 'state-read', 'journal-read', 'environment',
      'journal-begin', 'journal-mutating', 'profile-attach', 'provider-search', 'journal-validating',
      'profile-preview', 'http', 'json', 'search', 'profile-validate', 'provider-search',
      'state-write', 'journal-clear', 'unlock',
    ])
  })

  it('aborts without mutation when the state changed after planning', async () => {
    const test = executorHarness()
    const plan = { ...test.planFor({ container: 'stopped', port: 'available' }), stateHash: '0'.repeat(64) }
    await expect(executeRepair(plan, test.dependencies)).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
    expect(test.events).toEqual(['lock', 'state-read', 'unlock'])
    expect(test.journal.store.begin).not.toHaveBeenCalled()
    expect(test.writes).toEqual([])
  })

  it('aborts when an interrupted operation is recorded and surfaces its recovery direction', async () => {
    const interrupted = journalFixture('mutating')
    const test = executorHarness({ journal: interrupted })
    const plan = test.planFor({ container: 'stopped', port: 'available' })
    let error: CliError | undefined
    try {
      await executeRepair(plan, test.dependencies)
    } catch (cause) {
      error = cause as CliError
    }
    expect(error).toMatchObject({ code: 'E_STATE_INVALID' })
    expect(error?.message).toContain(recommendRecovery(interrupted).summary)
    expect(test.events).toEqual(['lock', 'state-read', 'journal-read', 'unlock'])
    expect(test.journal.active()).toEqual(interrupted)
    expect(test.writes).toEqual([])
  })

  it('refuses to execute a recovery plan that carries no ordinary actions', async () => {
    const test = executorHarness()
    const plan = planRepair(snapshot({ interruptedOperation: journalFixture('mutating') }))
    await expect(executeRepair(plan, test.dependencies)).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
    expect(test.events).toEqual(['lock', 'unlock'])
  })

  it('leaves the journal at validating and reports E_SEARCH_FAILED when validation fails', async () => {
    const test = executorHarness({ realSearchError: new CliError('E_SEARCH_FAILED', 'no results', 'doctor') })
    const plan = test.planFor({ container: 'stopped', port: 'available' })
    const error = await executeRepair(plan, test.dependencies).catch((cause: unknown) => cause as CliError)
    expect(error).toMatchObject({
      code: 'E_SEARCH_FAILED',
      details: { validationError: 'E_SEARCH_FAILED' },
    })
    expect(test.journal.active()).toMatchObject({ kind: 'repair', phase: 'validating' })
    expect(test.journal.store.clear).not.toHaveBeenCalled()
    expect(test.writes).toEqual([])
  })

  it('reports validation failures caused by downstream check errors as E_SEARCH_FAILED', async () => {
    const test = executorHarness({ realSearchError: new CliError('E_JSON_DISABLED', 'json off', 'enable json') })
    const plan = test.planFor({ container: 'stopped', port: 'available' })
    await expect(executeRepair(plan, test.dependencies)).rejects.toMatchObject({
      code: 'E_SEARCH_FAILED',
      details: { validationError: 'E_JSON_DISABLED' },
    })
    expect(test.journal.active()).toMatchObject({ phase: 'validating' })
  })

  it('propagates foreign ownership found during the locked re-inspection before beginning the journal', async () => {
    const test = executorHarness({ foreign: true })
    const plan = test.planFor({ container: 'stopped', port: 'available' })
    await expect(executeRepair(plan, test.dependencies)).rejects.toMatchObject({ code: 'E_RESOURCE_FOREIGN' })
    expect(test.events).toEqual(['lock', 'state-read', 'journal-read', 'environment', 'docker-preflight', 'ownership', 'unlock'])
    expect(test.journal.store.begin).not.toHaveBeenCalled()
  })

  it('refuses an explicitly foreign inspection status before journaling, without relying on the adapter throw', async () => {
    const test = executorHarness({ ownership: 'foreign', container: 'stopped' })
    const plan = test.planFor({ container: 'stopped', port: 'available' })
    await expect(executeRepair(plan, test.dependencies)).rejects.toMatchObject({ code: 'E_RESOURCE_FOREIGN' })
    expect(test.events).toEqual(['lock', 'state-read', 'journal-read', 'environment', 'docker-preflight', 'ownership', 'unlock'])
    expect(test.journal.store.begin).not.toHaveBeenCalled()
    expect(test.docker.restart).not.toHaveBeenCalled()
  })

  it('still repairs a legitimately absent deployment while enforcing the ownership gate', async () => {
    const test = executorHarness({ ownership: 'absent', container: 'absent' })
    const plan = test.planFor({ container: 'missing', port: 'available' })
    const result = await executeRepair(plan, test.dependencies)
    expect(result.actions).toEqual([{ type: 'recreate-runtime', preserveData: true }])
    expect(test.docker.up).toHaveBeenCalledWith(expect.objectContaining({ composePath: COMPOSE_PATH }), undefined)
  })

  it('retries render only on the dedicated bundle-damage signal, never on generic invalid state', async () => {
    const test = executorHarness({ renderFailures: 3, renderErrorCode: 'E_STATE_INVALID' })
    const plan = test.planFor({ generatedAssets: 'invalid', container: 'missing', port: 'available' })
    await expect(executeRepair(plan, test.dependencies)).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
    expect(test.assets.render).toHaveBeenCalledTimes(1)
    expect(test.journal.active()).toMatchObject({ kind: 'repair', phase: 'mutating' })
    expect(test.writes).toEqual([])
  })

  it('propagates cancellation raised while previewing the profile during validation', async () => {
    const cancellation = new DOMException('The operation was aborted', 'AbortError')
    const controller = new AbortController()
    const test = executorHarness({ abortDuringPreview: { controller, reason: cancellation } })
    const plan = test.planFor({ container: 'stopped', port: 'available' })
    await expect(executeRepair(plan, test.dependencies, controller.signal)).rejects.toBe(cancellation)
    expect(test.events).toContain('docker-restart')
    expect(test.journal.active()).toMatchObject({ kind: 'repair', phase: 'validating' })
    expect(test.writes).toEqual([])
  })

  it('removes owned temporary resources through the adapter capability', async () => {
    const test = executorHarness({ supportRemoveOwnedResource: true })
    const plan = test.planFor({ ownedTemporaryResourceIds: ['tmp-a'] })
    await executeRepair(plan, test.dependencies)
    expect(test.docker.removeOwnedResource).toHaveBeenCalledWith('tmp-a', undefined)
    expect(test.events).toContain('remove-resource:tmp-a')
  })

  it('reports an operational error when the adapter cannot remove temporary resources', async () => {
    const test = executorHarness()
    const plan = test.planFor({ ownedTemporaryResourceIds: ['tmp-a'] })
    await expect(executeRepair(plan, test.dependencies)).rejects.toMatchObject({ code: 'E_INTERNAL' })
    expect(test.journal.active()).toMatchObject({ kind: 'repair', phase: 'mutating' })
  })

  it('propagates cancellation before acquiring any dependency work', async () => {
    const test = executorHarness()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(executeRepair(test.planFor({ container: 'stopped', port: 'available' }), test.dependencies, controller.signal))
      .rejects.toBeInstanceOf(Error)
    expect(test.events).toEqual(['lock', 'unlock'])
  })

  it('never calls diagnose from the executor itself', async () => {
    const test = executorHarness()
    await executeRepair(test.planFor({ container: 'stopped', port: 'available' }), test.dependencies)
    expect(test.dependencies.diagnose).not.toHaveBeenCalled()
  })
})

function cliHarness(options: { container?: 'running' | 'stopped' } = {}) {
  const test = executorHarness({ container: options.container })
  const dependencies = {
    ...test.dependencies,
    diagnose: undefined,
    confirmPurge: vi.fn(async () => false),
    removeManagedDirectory: vi.fn(async () => {}),
    journal: test.journal.store,
    probeAssets: vi.fn(async () => 'valid' as const),
    environment: {
      ...test.environment,
      preflightManaged: vi.fn(async () => {}),
    },
  }
  return { ...test, dependencies: dependencies as unknown as NonNullable<Parameters<typeof runCli>[1]>['dependencies'] }
}

describe('executeRepair bundle rebuild (real filesystem)', () => {
  async function renderedBundle(root: string) {
    const renderer = new FileAssetRenderer({ assetRoot: new URL('../../assets/docker/', import.meta.url) })
    const stateDir = join(root, 'dsh-searxng')
    const rendered = await renderer.render({
      stateDir,
      identity: {
        stateDir,
        composePath: join(stateDir, `config-${'0'.repeat(64)}`, 'compose.yml'),
        homeId: HOME_ID,
        projectName: PROJECT,
        containerName: PROJECT,
      },
      image: SEARXNG_IMAGE,
      port: 8080,
      secret: PRESERVED_SECRET,
    })
    return {
      renderer,
      bundleDir: dirname(rendered.composePath),
      digest: rendered.configurationSha256,
      render: vi.spyOn(renderer, 'render'),
    }
  }

  it('rebuilds a damaged same-digest bundle with the preserved secret and identical digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-searxng-rebuild-'))
    try {
      const bundle = await renderedBundle(root)
      // Damage the bundle while keeping the secret source intact.
      await rm(join(bundle.bundleDir, '.env'))

      const test = executorHarness({
        managedDir: join(root, 'dsh-searxng'),
        assetsRenderer: bundle.renderer,
        useProductionSecretReader: true,
        state: managedState(bundle.digest),
      })
      const plan = test.planFor({ generatedAssets: 'invalid', container: 'missing', port: 'available' })
      const result = await executeRepair(plan, test.dependencies)

      expect(result.healthy).toBe(true)
      expect(bundle.render).toHaveBeenCalledTimes(2)
      await expect(readFile(join(bundle.bundleDir, '.env'), 'utf8')).resolves.toContain(`DSH_SEARXNG_IMAGE=${SEARXNG_IMAGE}`)
      await expect(readFile(join(bundle.bundleDir, 'compose.yml'), 'utf8')).resolves.not.toBe('')
      await expect(readFile(join(bundle.bundleDir, 'searxng', 'settings.yml'), 'utf8'))
        .resolves.toContain(`secret_key: ${PRESERVED_SECRET}`)
      expect(test.state().managed?.current.configurationSha256).toBe(bundle.digest)
      expect(test.state().managed?.lastHealthyAt).toBe(START)
      expect(test.docker.down).toHaveBeenCalledWith(expect.objectContaining({ composePath: join(bundle.bundleDir, 'compose.yml') }), false, undefined)
      expect(test.docker.up).toHaveBeenCalledWith(expect.objectContaining({ composePath: join(bundle.bundleDir, 'compose.yml') }), undefined)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed and never rotates the secret when no owned artifact preserves it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-searxng-rebuild-'))
    try {
      const bundle = await renderedBundle(root)
      await rm(join(bundle.bundleDir, 'searxng', 'settings.yml'))

      const test = executorHarness({
        managedDir: join(root, 'dsh-searxng'),
        assetsRenderer: bundle.renderer,
        useProductionSecretReader: true,
        state: managedState(bundle.digest),
      })
      const plan = test.planFor({ generatedAssets: 'invalid', container: 'missing', port: 'available' })
      await expect(executeRepair(plan, test.dependencies)).rejects.toMatchObject({
        code: 'E_STATE_INVALID',
        action: expect.stringContaining('setup'),
      })
      expect(bundle.render).not.toHaveBeenCalled()
      expect(test.journal.active()).toMatchObject({ kind: 'repair', phase: 'mutating' })
      expect(test.writes).toEqual([])
      await expect(readFile(join(bundle.bundleDir, 'searxng', 'settings.yml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('readPreservedSecretFromBundle', () => {
  it('reads the secret from an existing bundle without altering it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-searxng-secret-'))
    try {
      await mkdir(join(root, 'searxng'), { recursive: true })
      await writeFile(join(root, 'searxng', 'settings.yml'), `server:\n  secret_key: ${PRESERVED_SECRET}\nlimiter: false\n`, 'utf8')
      await expect(readPreservedSecretFromBundle(root)).resolves.toBe(PRESERVED_SECRET)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['missing bundle', undefined],
    ['missing secret key', 'server:\n  limiter: false\n'],
    ['empty secret key', 'server:\n  secret_key: ""\n'],
    ['malformed settings', 'server: [unclosed\n'],
  ] as const)('fails closed for a %s instead of rotating the secret', async (_name, source) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-searxng-secret-'))
    try {
      if (source !== undefined) {
        await mkdir(join(root, 'searxng'), { recursive: true })
        await writeFile(join(root, 'searxng', 'settings.yml'), source, 'utf8')
      }
      await expect(readPreservedSecretFromBundle(root)).rejects.toMatchObject({
        code: 'E_STATE_INVALID',
        action: expect.stringContaining('setup'),
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('repair CLI', () => {
  it('prints the exact plan before mutation and the final health for human output', async () => {
    const test = cliHarness({ container: 'stopped' })
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = await runCli(['repair'], {
      dependencies: test.dependencies,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    })
    expect(exitCode).toBe(0)
    expect(stderr).toEqual([])
    expect(stdout).toHaveLength(2)
    expect(stdout[0]).toContain('Repair plan for profile web')
    expect(stdout[0]).toContain('Restart the managed SearXNG container')
    expect(stdout[1]).toContain('SearXNG healthy')
    expect(stdout[1]).toContain(`Endpoint: ${ENDPOINT}`)
    expect(test.events).toContain('docker-restart')
  })

  it('emits exactly one JSON envelope containing the action identifiers and redacted checks', async () => {
    const test = cliHarness({ container: 'stopped' })
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = await runCli(['repair', '--json'], {
      dependencies: test.dependencies,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    })
    expect(exitCode).toBe(0)
    expect(stderr).toEqual([])
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0]!)).toEqual({
      profile: 'web',
      endpoint: ENDPOINT,
      healthy: true,
      actions: [{ type: 'restart-container' }],
      checks: [
        { id: 'http', status: 'pass', message: 'SearXNG HTTP endpoint is reachable' },
        { id: 'json', status: 'pass', message: 'SearXNG JSON API is enabled' },
        { id: 'search', status: 'pass', message: 'SearXNG returned a real search result' },
        { id: 'profile', status: 'pass', message: 'DSH profile has the expected managed attachment' },
        { id: 'provider', status: 'pass', message: 'DSH provider search returned a result' },
      ],
    })
  })

  it('reports a blocking plan as a structured error without mutating anything', async () => {
    const test = executorHarness({ dockerOffline: true })
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = await runCli(['repair', '--json'], {
      dependencies: {
        ...test.dependencies,
        confirmPurge: vi.fn(async () => false),
        removeManagedDirectory: vi.fn(async () => {}),
        journal: test.journal.store,
        probeAssets: vi.fn(async () => 'valid' as const),
      },
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    })
    expect(exitCode).toBe(1)
    expect(stdout).toEqual([])
    expect(JSON.parse(stderr[0]!)).toMatchObject({ code: 'E_DOCKER_OFFLINE' })
    expect(test.journal.store.begin).not.toHaveBeenCalled()
  })
})
