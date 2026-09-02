import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SEARXNG_IMAGE, type StagingAssetRenderer } from '../../src/cli/assets.ts'
import type { DockerAdapter } from '../../src/cli/docker.ts'
import { CliError } from '../../src/cli/errors.ts'
import type { EnvironmentService } from '../../src/cli/environment.ts'
import { stateSha256, type JournalStore, type OperationJournal } from '../../src/cli/journal.ts'
import type { ProfileManager } from '../../src/cli/profile.ts'
import type { SearxngProbe } from '../../src/cli/searxng.ts'
import type { StateStore, StateV2 } from '../../src/cli/state.ts'
import type { DeploymentDefinition } from '../../src/cli/deployments.ts'
import type { DiagnosticSnapshot } from '../../src/cli/diagnostics.ts'
import { updateManagedService, type UpdateDependencies } from '../../src/cli/update.ts'
import { runCli } from '../../src/cli.ts'

const HOME_ID = '0123456789abcdef'
const MANAGED_DIR = '/tmp/dsh/dsh-searxng'
const PROJECT = `dsh-searxng-${HOME_ID}`
const ENDPOINT = 'http://127.0.0.1:8080'
const START = '2026-09-01T00:00:00.000Z'
const PERSISTED_HASH = 'c'.repeat(64)
const STAGED_HASH = 'b'.repeat(64)
const TARGET_IMAGE = `ghcr.io/searxng/searxng:2027.1.1-aaaaaaaa@sha256:${'1'.repeat(64)}`
const PRESERVED_SECRET = 'f'.repeat(64)

const TARGET: DeploymentDefinition = {
  deploymentVersion: 2,
  image: TARGET_IMAGE,
  composeAsset: 'docker/compose.yml',
  settingsAsset: 'docker/settings.yml.template',
  stateSchemas: [2],
}

const CATALOG: readonly DeploymentDefinition[] = [
  {
    deploymentVersion: 1,
    image: SEARXNG_IMAGE,
    composeAsset: 'docker/compose.yml',
    settingsAsset: 'docker/settings.yml.template',
    stateSchemas: [1, 2],
  },
  TARGET,
]

/** The observable transaction contract; every test asserts against this shape. */
const SUCCESS_EVENTS = [
  'lock', 'diagnose-current', 'ownership', 'journal-prepared', 'pull-target',
  'journal-mutating', 'render-target', 'up-target', 'journal-validating',
  'readiness-target', 'search-target', 'provider-target', 'state-commit',
  'journal-clear', 'unlock',
]

function managedState(): StateV2 {
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
        configurationSha256: PERSISTED_HASH,
      },
      lastHealthyAt: '2026-08-29T00:00:00.000Z',
    },
    profiles: { web: { mode: 'managed', endpoint: ENDPOINT } },
  }
}

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

function journalFixture(): OperationJournal {
  return {
    schemaVersion: 1,
    id: 'd'.repeat(32),
    kind: 'repair',
    phase: 'mutating',
    startedAt: START,
    updatedAt: START,
    beforeStateSha256: 'a'.repeat(64),
  }
}

function fakeJournalStore(events: string[]) {
  let active: OperationJournal | undefined
  const store: JournalStore = {
    read: vi.fn(async () => undefined),
    begin: vi.fn(async (input: Parameters<JournalStore['begin']>[0]): Promise<OperationJournal> => {
      events.push('journal-prepared')
      if (active !== undefined) throw new CliError('E_STATE_INVALID', 'occupied', 'doctor')
      active = { schemaVersion: 1, id: 'e'.repeat(32), startedAt: START, updatedAt: START, ...structuredClone(input) }
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
  snapshotOverrides?: Partial<DiagnosticSnapshot>
  deploymentVersion?: number
  managedDir?: string
  dockerOffline?: boolean
  foreignThrow?: boolean
  ownership?: 'owned' | 'absent' | 'foreign'
  pullError?: unknown
  stageFailures?: number
  stageErrorCode?: 'E_BUNDLE_DAMAGED' | 'E_STATE_INVALID'
  stageOmitBundleDetail?: boolean
  readSecretError?: unknown
  upError?: unknown
  upPreviousError?: unknown
  /** 1-based probe call indexes that must fail; call 2 is the target validation when the real diagnose pipeline runs first. */
  failReadinessCalls?: number[]
  readinessError?: unknown
  failSearchCalls?: number[]
  failProviderCalls?: number[]
  stateWriteError?: unknown
}

function updateHarness(options: HarnessOptions = {}) {
  const events: string[] = []
  const writes: StateV2[] = []
  const managedDir = options.managedDir ?? MANAGED_DIR
  const currentCompose = join(managedDir, `config-${PERSISTED_HASH}`, 'compose.yml')
  const stagedCompose = join(managedDir, `config-${STAGED_HASH}`, 'compose.yml')
  let state = structuredClone(options.state ?? managedState())
  const journal = fakeJournalStore(events)

  const environment: EnvironmentService = {
    resolve: vi.fn(async (profile: string) => ({
      dshHome: '/tmp/dsh',
      profileDir: `/tmp/dsh/profiles/${profile}`,
      managedDir,
      homeId: HOME_ID,
    })),
    preflightManaged: vi.fn(async () => {}),
    preflightDsh: vi.fn(async () => {}),
  }

  const docker: DockerAdapter = {
    preflight: vi.fn(async () => {
      if (options.dockerOffline) throw new CliError('E_DOCKER_OFFLINE', 'The Docker daemon is unavailable', 'Start Docker')
      return { serverVersion: '27', composeVersion: '2.30' }
    }),
    inspectOwnership: vi.fn(async () => 'owned' as const),
    pull: vi.fn(async () => {
      events.push('pull-target')
      if (options.pullError !== undefined) throw options.pullError
    }),
    imageExists: vi.fn(async () => false),
    up: vi.fn(async (identity: { composePath: string }) => {
      if (identity.composePath === stagedCompose) {
        events.push('up-target')
        if (options.upError !== undefined) throw options.upError
        return
      }
      events.push('up-previous')
      if (options.upPreviousError !== undefined) throw options.upPreviousError
    }),
    restart: vi.fn(),
    down: vi.fn(async () => {}),
    logs: vi.fn(async () => ''),
    deploymentStatus: vi.fn(async () => {
      events.push('ownership')
      if (options.foreignThrow) throw new CliError('E_RESOURCE_FOREIGN', 'foreign', 'rename it')
      const ownership = options.ownership ?? 'owned' as const
      return { ownership, container: ownership === 'owned' ? 'running' as const : 'absent' as const, composePath: currentCompose }
    }),
  }

  let stageFailures = options.stageFailures ?? 0
  const assets: StagingAssetRenderer = {
    render: vi.fn(async () => { throw new Error('update must not call render') }),
    stage: vi.fn(async (input: { definition: DeploymentDefinition; stateDir: string }) => {
      events.push('render-target')
      expect(input.stateDir).toBe(managedDir)
      expect(input.definition.deploymentVersion).toBe(TARGET.deploymentVersion)
      if (stageFailures > 0) {
        stageFailures -= 1
        throw new CliError(
          options.stageErrorCode ?? 'E_BUNDLE_DAMAGED',
          'Managed configuration bundle does not match its identity',
          'Remove the damaged managed configuration bundle and retry',
          options.stageErrorCode !== undefined && options.stageErrorCode !== 'E_BUNDLE_DAMAGED' || options.stageOmitBundleDetail
            ? {}
            : { bundle: `config-${STAGED_HASH}` },
        )
      }
      return { directory: join(managedDir, `config-${STAGED_HASH}`), configurationSha256: STAGED_HASH, definition: input.definition }
    }),
  }

  let readinessCalls = 0
  let searchCalls = 0
  let providerCalls = 0
  const searxng: SearxngProbe = {
    http: vi.fn(async () => {}),
    readiness: vi.fn(async () => {
      events.push('readiness-target')
      readinessCalls += 1
      if (options.failReadinessCalls?.includes(readinessCalls)) {
        throw options.readinessError ?? new CliError('E_SEARXNG_START_TIMEOUT', 'SearXNG did not become ready', 'Check the managed container logs')
      }
    }),
    realSearch: vi.fn(async () => {
      events.push('search-target')
      searchCalls += 1
      if (options.failSearchCalls?.includes(searchCalls)) {
        throw new CliError('E_SEARCH_FAILED', 'no results', 'Run dsh-searxng doctor')
      }
      return { endpoint: ENDPOINT, resultCount: 1, elapsedMs: 1 }
    }),
    providerSearch: vi.fn(async () => {
      events.push('provider-target')
      providerCalls += 1
      if (options.failProviderCalls?.includes(providerCalls)) {
        throw new CliError('E_SEARCH_FAILED', 'provider unavailable', 'Run dsh-searxng doctor')
      }
      return { endpoint: ENDPOINT, resultCount: 1, elapsedMs: 1 }
    }),
  }

  const profiles: ProfileManager = {
    inspect: vi.fn(),
    preview: vi.fn(async () => ({ installed: true, attached: true, config: { baseURL: ENDPOINT } })),
    validate: vi.fn(async (_profile: string, _endpoint: string, callback: (config: { baseURL: string }) => Promise<void>) => {
      await callback({ baseURL: ENDPOINT })
    }),
    attach: vi.fn(),
    detach: vi.fn(),
    uninstall: vi.fn(),
  }

  const readPreservedSecret = vi.fn(async () => {
    if (options.readSecretError !== undefined) throw options.readSecretError
    return PRESERVED_SECRET
  })

  const stateStore: StateStore = {
    read: vi.fn(async () => structuredClone(state)),
    write: vi.fn(async (next: StateV2) => {
      events.push('state-commit')
      if (options.stateWriteError !== undefined) throw options.stateWriteError
      state = structuredClone(next)
      writes.push(structuredClone(next))
    }),
    withLock: vi.fn(async (operation) => {
      events.push('lock')
      try { return await operation() } finally { events.push('unlock') }
    }),
  }

  const dependencies: UpdateDependencies = {
    environment,
    state: stateStore,
    journal: journal.store,
    docker,
    assets,
    searxng,
    profiles,
    catalog: CATALOG,
    diagnose: vi.fn(async () => {
      events.push('diagnose-current')
      return snapshot({ stateHash: stateSha256(state), ...(options.snapshotOverrides ?? {}) })
    }),
    readPreservedSecret,
    now: () => new Date(START),
  }

  return {
    dependencies, events, writes, journal, docker, assets, profiles, environment, readPreservedSecret,
    state: () => state,
    update: (signal?: AbortSignal) => updateManagedService(
      { profile: 'web', ...(options.deploymentVersion === undefined ? {} : { deploymentVersion: options.deploymentVersion }) },
      dependencies,
      signal,
    ),
    currentCompose,
    stagedCompose,
  }
}

async function errorFrom(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise
  } catch (cause) {
    return cause as CliError
  }
  throw new Error('expected the update to fail')
}

describe('updateManagedService success', () => {
  it('runs the exact transactional event order and commits current/previous atomically', async () => {
    const test = updateHarness()
    const result = await test.update()

    expect(result).toEqual({
      profile: 'web',
      endpoint: ENDPOINT,
      from: 1,
      to: 2,
      rolledBack: false,
      checks: [
        { id: 'http', status: 'pass', message: 'SearXNG HTTP endpoint is reachable' },
        { id: 'json', status: 'pass', message: 'SearXNG JSON API is enabled' },
        { id: 'search', status: 'pass', message: 'SearXNG returned a real search result' },
        { id: 'profile', status: 'pass', message: 'DSH profile has the expected managed attachment' },
        { id: 'provider', status: 'pass', message: 'DSH provider search returned a result' },
      ],
    })
    expect(test.events).toEqual(SUCCESS_EVENTS)
    expect(test.journal.store.begin).toHaveBeenCalledWith({
      kind: 'update',
      phase: 'prepared',
      beforeStateSha256: stateSha256(managedState()),
      target: { deploymentVersion: 2, image: TARGET_IMAGE },
    })
    // The previous bundle (rollback target) is never deleted; the runtime is
    // switched by bringing the current project down and the staged bundle up.
    expect(test.docker.down).toHaveBeenCalledTimes(1)
    expect(test.docker.down).toHaveBeenCalledWith(expect.objectContaining({ composePath: test.currentCompose }), false, undefined)
    expect(test.docker.up).toHaveBeenCalledTimes(1)
    expect(test.docker.up).toHaveBeenCalledWith(expect.objectContaining({ composePath: test.stagedCompose }), undefined)
    expect(test.assets.render).not.toHaveBeenCalled()
    expect(test.readPreservedSecret).toHaveBeenCalledWith(join(MANAGED_DIR, `config-${PERSISTED_HASH}`))
    expect(test.writes).toEqual([{
      ...managedState(),
      managed: {
        current: {
          deploymentVersion: 2,
          image: TARGET_IMAGE,
          endpoint: ENDPOINT,
          port: 8080,
          projectName: PROJECT,
          containerName: PROJECT,
          configurationSha256: STAGED_HASH,
        },
        previous: managedState().managed?.current,
        lastHealthyAt: START,
      },
    }])
    expect(test.journal.active()).toBeUndefined()
  })

  it('selects the explicitly requested deployment version', async () => {
    const test = updateHarness({ deploymentVersion: 2 })
    await test.update()
    expect(test.assets.stage).toHaveBeenCalledWith(expect.objectContaining({
      definition: expect.objectContaining({ deploymentVersion: 2 }),
    }))
  })
})

describe('updateManagedService refuses non-updatable bases', () => {
  it('refuses an unhealthy current deployment before any mutation', async () => {
    const test = updateHarness({ snapshotOverrides: { container: 'stopped', port: 'available' } })
    const error = await errorFrom(test.update())
    expect(error).toMatchObject({
      code: 'E_STATE_INVALID',
      action: expect.stringContaining('doctor'),
    })
    expect(test.events).toEqual(['lock', 'diagnose-current', 'unlock'])
    expect(test.journal.store.begin).not.toHaveBeenCalled()
    expect(test.docker.pull).not.toHaveBeenCalled()
    expect(test.assets.stage).not.toHaveBeenCalled()
    expect(test.writes).toEqual([])
  })

  it('refuses an external endpoint without mutating anything', async () => {
    const test = updateHarness({
      snapshotOverrides: {
        mode: 'external',
        expectedEndpoint: 'https://search.example',
        ownership: 'absent',
        container: 'missing',
        port: 'available',
      },
    })
    const error = await errorFrom(test.update())
    expect(error).toMatchObject({ code: 'E_STATE_INVALID' })
    expect(error.message).toContain('external')
    expect(test.events).toEqual(['lock', 'diagnose-current', 'unlock'])
    expect(test.docker.pull).not.toHaveBeenCalled()
    expect(test.docker.up).not.toHaveBeenCalled()
    expect(test.docker.down).not.toHaveBeenCalled()
    expect(test.assets.stage).not.toHaveBeenCalled()
    expect(test.journal.store.begin).not.toHaveBeenCalled()
    expect(test.writes).toEqual([])
  })

  it('refuses an interrupted operation recorded in the journal', async () => {
    const interrupted = journalFixture()
    const test = updateHarness({ snapshotOverrides: { interruptedOperation: interrupted } })
    const error = await errorFrom(test.update())
    expect(error).toMatchObject({ code: 'E_STATE_INVALID' })
    expect(error.message).toContain('run dsh-searxng repair')
    expect(test.journal.store.begin).not.toHaveBeenCalled()
    expect(test.events).toEqual(['lock', 'diagnose-current', 'unlock'])
  })

  it('refuses when the state changed after the diagnostic snapshot', async () => {
    const test = updateHarness({ snapshotOverrides: { stateHash: '0'.repeat(64) } })
    await expect(test.update()).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
    expect(test.events).toEqual(['lock', 'diagnose-current', 'unlock'])
    expect(test.journal.store.begin).not.toHaveBeenCalled()
  })

  it('refuses a foreign re-inspection before journaling', async () => {
    const test = updateHarness({ ownership: 'foreign' })
    await expect(test.update()).rejects.toMatchObject({ code: 'E_RESOURCE_FOREIGN' })
    expect(test.events).toEqual(['lock', 'diagnose-current', 'ownership', 'unlock'])
    expect(test.journal.store.begin).not.toHaveBeenCalled()
  })

  it('propagates a foreign adapter throw from the ownership gate', async () => {
    const test = updateHarness({ foreignThrow: true })
    await expect(test.update()).rejects.toMatchObject({ code: 'E_RESOURCE_FOREIGN' })
    expect(test.events).toEqual(['lock', 'diagnose-current', 'ownership', 'unlock'])
  })

  it('refuses when the deployment disappeared between diagnosis and the gate', async () => {
    const test = updateHarness({ ownership: 'absent' })
    await expect(test.update()).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
    expect(test.events).toEqual(['lock', 'diagnose-current', 'ownership', 'unlock'])
    expect(test.journal.store.begin).not.toHaveBeenCalled()
  })

  it('refuses an update to the currently deployed version', async () => {
    const test = updateHarness({ deploymentVersion: 1 })
    const error = await errorFrom(test.update())
    expect(error).toMatchObject({ code: 'E_DEPLOYMENT_UNSUPPORTED', details: { from: 1, to: 1 } })
    expect(test.events).toEqual(['lock', 'diagnose-current', 'unlock'])
    expect(test.journal.store.begin).not.toHaveBeenCalled()
  })

  it('refuses an unknown requested deployment version', async () => {
    const test = updateHarness({ deploymentVersion: 9 })
    await expect(test.update()).rejects.toMatchObject({ code: 'E_DEPLOYMENT_UNSUPPORTED' })
    expect(test.events).toEqual(['lock', 'diagnose-current', 'unlock'])
  })
})

describe('updateManagedService pre-mutation failures unwind cleanly', () => {
  it('unwinds the journal without touching files or state when the pull fails', async () => {
    const test = updateHarness({ pullError: new CliError('E_INTERNAL', 'Docker image pull failed', 'Check network access') })
    await expect(test.update()).rejects.toMatchObject({ code: 'E_INTERNAL' })
    expect(test.events).toEqual([
      'lock', 'diagnose-current', 'ownership', 'journal-prepared', 'pull-target', 'journal-clear', 'unlock',
    ])
    expect(test.journal.active()).toBeUndefined()
    expect(test.docker.up).not.toHaveBeenCalled()
    expect(test.docker.down).not.toHaveBeenCalled()
    expect(test.assets.stage).not.toHaveBeenCalled()
    expect(test.writes).toEqual([])
    expect(test.state()).toEqual(managedState())
  })

  it('unwinds the journal when staging persistently fails, leaving the runtime untouched', async () => {
    const test = updateHarness({ stageFailures: 3 })
    await expect(test.update()).rejects.toMatchObject({ code: 'E_BUNDLE_DAMAGED' })
    expect(test.assets.stage).toHaveBeenCalledTimes(2)
    expect(test.events).toEqual([
      'lock', 'diagnose-current', 'ownership', 'journal-prepared', 'pull-target',
      'journal-mutating', 'render-target', 'render-target', 'journal-clear', 'unlock',
    ])
    expect(test.journal.active()).toBeUndefined()
    expect(test.docker.up).not.toHaveBeenCalled()
    expect(test.docker.down).not.toHaveBeenCalled()
    expect(test.writes).toEqual([])
    expect(test.state()).toEqual(managedState())
  })

  it('retries a damaged target bundle exactly once after removing it, then succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-searxng-update-stage-'))
    try {
      const managedDir = join(root, 'dsh-searxng')
      // A damaged leftover bundle from a previous update attempt to the same version.
      await mkdir(join(managedDir, `config-${STAGED_HASH}`), { recursive: true })
      const test = updateHarness({ managedDir, stageFailures: 1 })
      await test.update()
      expect(test.assets.stage).toHaveBeenCalledTimes(2)
      // The damaged bundle costs exactly one extra render attempt.
      expect(test.events).toEqual([
        ...SUCCESS_EVENTS.slice(0, SUCCESS_EVENTS.indexOf('up-target')),
        'render-target',
        ...SUCCESS_EVENTS.slice(SUCCESS_EVENTS.indexOf('up-target')),
      ])
      // The damaged directory was removed and not recreated by the fake renderer;
      // the real renderer would have re-published a valid bundle.
      expect(await readdir(managedDir)).toEqual([])
      expect(test.journal.active()).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not retry staging on a non-damage failure', async () => {
    const test = updateHarness({ stageFailures: 2, stageErrorCode: 'E_STATE_INVALID' })
    await expect(test.update()).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
    expect(test.assets.stage).toHaveBeenCalledTimes(1)
    expect(test.journal.active()).toBeUndefined()
    expect(test.writes).toEqual([])
  })

  it('propagates cancellation raised before mutation without leaving a journal', async () => {
    const cancellation = new DOMException('The operation was aborted', 'AbortError')
    const test = updateHarness({ stageFailures: 1, stageErrorCode: 'E_STATE_INVALID' })
    const controller = new AbortController()
    controller.abort(cancellation)
    await expect(test.update(controller.signal)).rejects.toBe(cancellation)
    expect(test.events).toEqual(['lock', 'unlock'])
    expect(test.journal.store.begin).not.toHaveBeenCalled()
  })
})

describe('updateManagedService post-mutation failures roll back', () => {
  it('restores the previous deployment when Compose activation fails', async () => {
    const test = updateHarness({ upError: new CliError('E_INTERNAL', 'Docker Compose up failed', 'Run dsh-searxng doctor') })
    const error = await errorFrom(test.update())

    expect(error).toMatchObject({
      code: 'E_INTERNAL',
      message: expect.stringContaining('rolled back'),
      details: { rolledBack: true, targetVersion: 2, targetError: 'E_INTERNAL' },
    })
    expect(error.action).toContain('doctor')
    expect(test.events).toEqual([
      'lock', 'diagnose-current', 'ownership', 'journal-prepared', 'pull-target',
      'journal-mutating', 'render-target', 'up-target', 'journal-rolling-back',
      'up-previous', 'readiness-target', 'search-target', 'provider-target',
      'journal-clear', 'unlock',
    ])
    // Rollback: bring the staged project down, bring the previous bundle up.
    expect(test.docker.down).toHaveBeenCalledTimes(2)
    expect(test.docker.down).toHaveBeenNthCalledWith(1, expect.objectContaining({ composePath: test.currentCompose }), false, undefined)
    expect(test.docker.down).toHaveBeenNthCalledWith(2, expect.objectContaining({ composePath: test.stagedCompose }), false, undefined)
    expect(test.docker.up).toHaveBeenCalledTimes(2)
    expect(test.docker.up).toHaveBeenNthCalledWith(2, expect.objectContaining({ composePath: test.currentCompose }), undefined)
    expect(test.writes).toEqual([])
    expect(test.state()).toEqual(managedState())
    expect(test.journal.active()).toBeUndefined()
  })

  it('rolls back when target readiness fails and keeps current until validation passes', async () => {
    const test = updateHarness({ failReadinessCalls: [1] })
    const error = await errorFrom(test.update())

    expect(error).toMatchObject({
      code: 'E_SEARXNG_START_TIMEOUT',
      details: { rolledBack: true, targetError: 'E_SEARXNG_START_TIMEOUT' },
    })
    expect(error.message).toContain('restored')
    expect(test.events).toEqual([
      'lock', 'diagnose-current', 'ownership', 'journal-prepared', 'pull-target',
      'journal-mutating', 'render-target', 'up-target', 'journal-validating',
      'readiness-target', 'journal-rolling-back', 'up-previous',
      'readiness-target', 'search-target', 'provider-target', 'journal-clear', 'unlock',
    ])
    expect(test.writes).toEqual([])
    expect(test.state()).toEqual(managedState())
    expect(test.journal.active()).toBeUndefined()
  })

  it('rolls back when the target real search fails', async () => {
    const test = updateHarness({ failSearchCalls: [1] })
    const error = await errorFrom(test.update())
    expect(error).toMatchObject({
      code: 'E_SEARCH_FAILED',
      details: { rolledBack: true, targetError: 'E_SEARCH_FAILED' },
    })
    expect(test.events).toContain('journal-rolling-back')
    expect(test.events.filter((event) => event === 'search-target')).toHaveLength(2)
    expect(test.state()).toEqual(managedState())
    expect(test.journal.active()).toBeUndefined()
  })

  it('rolls back when the provider search fails', async () => {
    const test = updateHarness({ failProviderCalls: [1] })
    const error = await errorFrom(test.update())
    expect(error).toMatchObject({ details: { rolledBack: true, targetError: 'E_SEARCH_FAILED' } })
    expect(test.events.filter((event) => event === 'provider-target')).toHaveLength(2)
    expect(test.docker.up).toHaveBeenNthCalledWith(2, expect.objectContaining({ composePath: test.currentCompose }), undefined)
    expect(test.state()).toEqual(managedState())
    expect(test.journal.active()).toBeUndefined()
  })

  it('rolls back when the state commit fails even though the target validated', async () => {
    const test = updateHarness({ stateWriteError: new Error('disk full') })
    const error = await errorFrom(test.update())
    expect(error).toMatchObject({
      code: 'E_INTERNAL',
      details: { rolledBack: true, targetError: 'internal' },
    })
    expect(test.events.filter((event) => event === 'state-commit')).toHaveLength(1)
    expect(test.docker.up).toHaveBeenNthCalledWith(2, expect.objectContaining({ composePath: test.currentCompose }), undefined)
    expect(test.writes).toEqual([])
    expect(test.state()).toEqual(managedState())
    expect(test.journal.active()).toBeUndefined()
  })

  it('reports target and rollback errors separately and retains the journal when rollback validation fails', async () => {
    const test = updateHarness({ failReadinessCalls: [1, 2] })
    const error = await errorFrom(test.update())

    expect(error).toMatchObject({
      code: 'E_INTERNAL',
      message: expect.stringContaining('did not complete'),
      details: { targetError: 'E_SEARXNG_START_TIMEOUT', rollbackError: 'E_SEARXNG_START_TIMEOUT' },
    })
    expect(error.action).toContain('doctor --json')
    expect(test.events).toContain('journal-rolling-back')
    expect(test.events).not.toContain('journal-clear')
    expect(test.journal.active()).toMatchObject({ kind: 'update', phase: 'rolling-back', target: { deploymentVersion: 2, image: TARGET_IMAGE } })
    expect(test.writes).toEqual([])
    expect(test.state()).toEqual(managedState())
  })

  it('reports a failed rollback Compose up separately from the target failure', async () => {
    const test = updateHarness({
      upError: new CliError('E_INTERNAL', 'Docker Compose up failed', 'doctor'),
      upPreviousError: new CliError('E_INTERNAL', 'Docker Compose up failed again', 'doctor'),
    })
    const error = await errorFrom(test.update())
    expect(error).toMatchObject({
      details: { targetError: 'E_INTERNAL', rollbackError: 'E_INTERNAL' },
    })
    expect(test.journal.active()).toMatchObject({ phase: 'rolling-back' })
  })

  it('rolls back on mid-mutation cancellation and then rethrows the cancellation', async () => {
    const cancellation = new DOMException('The operation was aborted', 'AbortError')
    const test = updateHarness({ failReadinessCalls: [1], readinessError: cancellation })
    await expect(test.update()).rejects.toBe(cancellation)
    expect(test.events).toEqual([
      'lock', 'diagnose-current', 'ownership', 'journal-prepared', 'pull-target',
      'journal-mutating', 'render-target', 'up-target', 'journal-validating',
      'readiness-target', 'journal-rolling-back', 'up-previous',
      'readiness-target', 'search-target', 'provider-target', 'journal-clear', 'unlock',
    ])
    // The rollback itself runs detached from the aborted signal.
    expect(test.docker.up).toHaveBeenNthCalledWith(2, expect.objectContaining({ composePath: test.currentCompose }), undefined)
    expect(test.journal.active()).toBeUndefined()
    expect(test.state()).toEqual(managedState())
  })
})

function cliUpdateHarness(options: HarnessOptions = {}) {
  const test = updateHarness(options)
  const dependencies = {
    ...test.dependencies,
    confirmPurge: vi.fn(async () => false),
    removeManagedDirectory: vi.fn(async () => {}),
    journal: test.journal.store,
    probeAssets: vi.fn(async () => 'valid' as const),
    catalog: CATALOG,
  }
  return { ...test, dependencies: dependencies as unknown as NonNullable<Parameters<typeof runCli>[1]>['dependencies'] }
}

describe('update CLI', () => {
  it('narrates the phases and reports the transition for human output', async () => {
    const test = cliUpdateHarness()
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = await runCli(['update'], {
      dependencies: test.dependencies,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    })
    expect(exitCode).toBe(0)
    expect(stderr).toEqual([])
    const output = stdout.join('')
    expect(output).toContain('Verifying the current deployment is healthy')
    expect(output).toContain('Target deployment selected')
    expect(output).toContain('Pulling the target image')
    expect(output).toContain('Staging the target configuration')
    expect(output).toContain('Activating the target deployment')
    expect(output).toContain('Validating the target deployment')
    expect(output).toContain('Deployment: 1 -> 2')
    expect(output).toContain(`Endpoint: ${ENDPOINT}`)
    expect(test.events).toContain('up-target')
    expect(test.journal.active()).toBeUndefined()
  })

  it('emits exactly one JSON envelope with from/to and redacted checks', async () => {
    const test = cliUpdateHarness()
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = await runCli(['update', '--json'], {
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
      from: 1,
      to: 2,
      rolledBack: false,
      checks: [
        { id: 'http', status: 'pass', message: 'SearXNG HTTP endpoint is reachable' },
        { id: 'json', status: 'pass', message: 'SearXNG JSON API is enabled' },
        { id: 'search', status: 'pass', message: 'SearXNG returned a real search result' },
        { id: 'profile', status: 'pass', message: 'DSH profile has the expected managed attachment' },
        { id: 'provider', status: 'pass', message: 'DSH provider search returned a result' },
      ],
    })
  })

  it('reports a rolled-back update as a structured error with the rollback outcome', async () => {
    const test = cliUpdateHarness({ failReadinessCalls: [2] })
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = await runCli(['update', '--json'], {
      dependencies: test.dependencies,
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    })
    expect(exitCode).toBe(1)
    expect(stdout).toEqual([])
    expect(JSON.parse(stderr[0]!)).toMatchObject({
      code: 'E_SEARXNG_START_TIMEOUT',
      message: expect.stringContaining('rolled back'),
      rolledBack: true,
      targetVersion: 2,
      targetError: 'E_SEARXNG_START_TIMEOUT',
    })
    expect(test.journal.active()).toBeUndefined()
  })
})
