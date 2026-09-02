import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SEARXNG_IMAGE, type AssetRenderer } from '../../src/cli/assets.ts'
import type { DockerAdapter } from '../../src/cli/docker.ts'
import { CliError } from '../../src/cli/errors.ts'
import type { EnvironmentService } from '../../src/cli/environment.ts'
import { FileJournalStore, stateSha256, type OperationJournal, type OperationKind, type OperationPhase } from '../../src/cli/journal.ts'
import type { ProfileManager } from '../../src/cli/profile.ts'
import type { SearxngProbe } from '../../src/cli/searxng.ts'
import { FileStateStore, type DeploymentSnapshot, type StateV2 } from '../../src/cli/state.ts'
import type { DeploymentDefinition } from '../../src/cli/deployments.ts'
import { diagnose, inspectSnapshot, type SnapshotDependencies } from '../../src/cli/diagnostics.ts'
import { executeRepair, executeRecovery, planRecovery, type RecoveryDependencies, type RepairDependencies } from '../../src/cli/repair.ts'
import { remove, removeManagedDirectory, type RemoveDependencies } from '../../src/cli/remove.ts'
import { setup } from '../../src/cli/setup.ts'
import { runCli } from '../../src/cli.ts'

const HOME_ID = '0123456789abcdef'
const PROJECT = `dsh-searxng-${HOME_ID}`
const ENDPOINT = 'http://127.0.0.1:8080'
const CURRENT_HASH = 'c'.repeat(64)
const STAGED_HASH = 'b'.repeat(64)
const JOURNAL_ID = 'd'.repeat(32)
const START = '2026-09-01T00:00:00.000Z'
const RECOVERY_TIME = '2026-09-01T00:05:00.000Z'
const TARGET_IMAGE = `ghcr.io/searxng/searxng:2027.1.1-aaaaaaaa@sha256:${'1'.repeat(64)}`
const UNRELATED_HASH = '0'.repeat(64)

const CATALOG: readonly DeploymentDefinition[] = [
  {
    deploymentVersion: 1,
    image: SEARXNG_IMAGE,
    composeAsset: 'docker/compose.yml',
    settingsAsset: 'docker/settings.yml.template',
    stateSchemas: [1, 2],
  },
  {
    deploymentVersion: 2,
    image: TARGET_IMAGE,
    composeAsset: 'docker/compose.yml',
    settingsAsset: 'docker/settings.yml.template',
    stateSchemas: [2],
  },
]

const CURRENT_SNAPSHOT: DeploymentSnapshot = {
  deploymentVersion: 1,
  image: SEARXNG_IMAGE,
  endpoint: ENDPOINT,
  port: 8080,
  projectName: PROJECT,
  containerName: PROJECT,
  configurationSha256: CURRENT_HASH,
}

const TARGET_SNAPSHOT: DeploymentSnapshot = {
  ...CURRENT_SNAPSHOT,
  deploymentVersion: 2,
  image: TARGET_IMAGE,
  configurationSha256: STAGED_HASH,
}

function managedState(current: DeploymentSnapshot = CURRENT_SNAPSHOT, previous?: DeploymentSnapshot): StateV2 {
  return {
    schemaVersion: 2,
    homeId: HOME_ID,
    managed: {
      current,
      ...(previous === undefined ? {} : { previous }),
      lastHealthyAt: '2026-08-29T00:00:00.000Z',
    },
    profiles: { web: { mode: 'managed', endpoint: ENDPOINT } },
  }
}

function journalFixture(
  phase: OperationPhase,
  options: { kind?: OperationKind; beforeStateSha256?: string; target?: false | { deploymentVersion: number; image: string } } = {},
): OperationJournal {
  const kind = options.kind ?? 'update'
  const target = options.target === undefined
    ? (kind === 'update' ? { deploymentVersion: 2, image: TARGET_IMAGE } : undefined)
    : (options.target === false ? undefined : options.target)
  return {
    schemaVersion: 1,
    id: JOURNAL_ID,
    kind,
    phase,
    startedAt: START,
    updatedAt: START,
    beforeStateSha256: options.beforeStateSha256 ?? UNRELATED_HASH,
    ...(target === undefined ? {} : { target }),
  }
}

/**
 * The world exactly as a fresh process would find it after a crash: state and
 * journal bytes plus bundle directories materialized directly on the real
 * filesystem, with no in-memory store objects carrying anything over.
 */
interface CrashWorld {
  phase: OperationPhase
  kind?: OperationKind
  state: StateV2
  /** Hash recorded before the interrupted operation; defaults to the on-disk state's hash. */
  beforeStateSha256?: string
  journalTarget?: false | { deploymentVersion: number; image: string }
  running?: 'previous' | 'target' | 'stopped-target' | 'stopped-previous' | 'none'
  foreign?: boolean
  dockerOffline?: boolean
  images?: string[]
  bundles?: 'current' | 'staged' | 'both' | 'none'
  lock?: string
  stagingDirs?: string[]
  catalog?: readonly DeploymentDefinition[] | null
  failSearchCalls?: number[]
}

interface Materialized {
  root: string
  journal: OperationJournal
  previousCompose: string
  stagedCompose: string
}

async function materialize(world: CrashWorld): Promise<Materialized> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-searxng-recovery-'))
  const bundles = world.bundles ?? 'both'
  const previousCompose = join(root, `config-${CURRENT_HASH}`, 'compose.yml')
  const stagedCompose = join(root, `config-${STAGED_HASH}`, 'compose.yml')
  if (bundles === 'current' || bundles === 'both') {
    await mkdir(dirname(previousCompose), { recursive: true })
    await writeFile(previousCompose, 'services: searxng\n', 'utf8')
  }
  if (bundles === 'staged' || bundles === 'both') {
    await mkdir(dirname(stagedCompose), { recursive: true })
    await writeFile(stagedCompose, 'services: searxng\n', 'utf8')
  }
  for (const staging of world.stagingDirs ?? []) {
    await mkdir(join(root, staging), { recursive: true })
  }
  await writeFile(join(root, 'state.json'), `${JSON.stringify(world.state)}\n`, 'utf8')
  const journal = journalFixture(world.phase, {
    kind: world.kind,
    beforeStateSha256: world.beforeStateSha256 ?? stateSha256(world.state),
    ...(world.journalTarget === undefined ? {} : { target: world.journalTarget }),
  })
  await writeFile(join(root, 'journal.json'), `${JSON.stringify(journal)}\n`, 'utf8')
  if (world.lock !== undefined) {
    await writeFile(join(root, 'state.lock'), world.lock, 'utf8')
  }
  return { root, journal, previousCompose, stagedCompose }
}

/** A brand-new dependency graph over the materialized world, as a fresh CLI process would build it. */
function freshGraph(world: CrashWorld, materialized: Materialized) {
  const events: string[] = []
  const images = world.images ?? [SEARXNG_IMAGE, TARGET_IMAGE]
  let searchCalls = 0
  const environment: EnvironmentService = {
    resolve: vi.fn(async () => ({
      dshHome: dirname(materialized.root),
      profileDir: join(dirname(materialized.root), 'profiles', 'web'),
      managedDir: materialized.root,
      homeId: HOME_ID,
    })),
    preflightManaged: vi.fn(async () => {}),
    preflightDsh: vi.fn(async () => {}),
  }
  const composeFor = (which: 'previous' | 'target') =>
    which === 'previous' ? materialized.previousCompose : materialized.stagedCompose
  const running = world.running ?? 'previous'
  const docker: DockerAdapter = {
    preflight: vi.fn(async () => {
      if (world.dockerOffline) throw new CliError('E_DOCKER_OFFLINE', 'The Docker daemon is unavailable', 'Start Docker')
      return { serverVersion: '27', composeVersion: '2.30' }
    }),
    inspectOwnership: vi.fn(async () => 'owned' as const),
    up: vi.fn(async (identity: { composePath: string }) => {
      events.push(`up:${basename(dirname(identity.composePath))}`)
    }),
    restart: vi.fn(),
    down: vi.fn(async (identity: { composePath: string }, volumes: boolean) => {
      events.push(`down:${basename(dirname(identity.composePath))}:${volumes}`)
    }),
    logs: vi.fn(async () => ''),
    pull: vi.fn(async (image: string) => { events.push(`pull:${image}`) }),
    imageExists: vi.fn(async (image: string) => images.includes(image)),
    deploymentStatus: vi.fn(async () => {
      if (world.foreign) throw new CliError('E_RESOURCE_FOREIGN', 'foreign', 'rename it')
      if (running === 'none') return { ownership: 'absent' as const, container: 'absent' as const }
      if (running === 'previous') {
        return { ownership: 'owned' as const, container: 'running' as const, composePath: composeFor('previous') }
      }
      if (running === 'stopped-previous') {
        return { ownership: 'owned' as const, container: 'stopped' as const, composePath: composeFor('previous') }
      }
      if (running === 'stopped-target') {
        return { ownership: 'owned' as const, container: 'stopped' as const, composePath: composeFor('target') }
      }
      return { ownership: 'owned' as const, container: 'running' as const, composePath: composeFor('target') }
    }),
  }
  const searxng: SearxngProbe = {
    http: vi.fn(async () => { events.push('http') }),
    readiness: vi.fn(async () => { events.push('readiness') }),
    realSearch: vi.fn(async () => {
      events.push('search')
      searchCalls += 1
      if (world.failSearchCalls?.includes(searchCalls)) {
        throw new CliError('E_SEARCH_FAILED', 'no results', 'Run dsh-searxng doctor')
      }
      return { endpoint: ENDPOINT, resultCount: 1, elapsedMs: 1 }
    }),
    providerSearch: vi.fn(async () => {
      events.push('provider')
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
  const dependencies: RecoveryDependencies = {
    environment,
    state: new FileStateStore(materialized.root, HOME_ID),
    journal: new FileJournalStore(materialized.root),
    docker,
    searxng,
    profiles,
    ...(world.catalog === null ? {} : { catalog: world.catalog ?? CATALOG }),
    now: () => new Date(RECOVERY_TIME),
  }
  return {
    dependencies, events, docker, searxng, profiles, environment,
    statePath: join(materialized.root, 'state.json'),
    journalPath: join(materialized.root, 'journal.json'),
    lockPath: join(materialized.root, 'state.lock'),
  }
}

async function stateBytes(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

const asBytes = (state: StateV2): string => `${JSON.stringify(state)}\n`

async function withWorld<T>(world: CrashWorld, run: (materialized: Materialized, graph: ReturnType<typeof freshGraph>) => Promise<T>): Promise<T> {
  const materialized = await materialize(world)
  try {
    return await run(materialized, freshGraph(world, materialized))
  } finally {
    await rm(materialized.root, { recursive: true, force: true })
  }
}

describe('planRecovery classifies interrupted updates from on-disk state', () => {
  it('classifies an untouched prepared update as clear-prepared', async () => {
    await withWorld({ phase: 'prepared', state: managedState() }, async (materialized, graph) => {
      const plan = await planRecovery('web', materialized.journal, graph.dependencies)
      expect(plan.decision).toEqual({ type: 'clear-prepared' })
      expect(plan.stateHash).toBe(stateSha256(managedState()))
      expect(plan.endpoint).toBe(ENDPOINT)
      expect(plan.ageMs).toBe(Date.parse(RECOVERY_TIME) - Date.parse(START))
    })
  })

  it('classifies a mutating update as resume-rollback to the snapshot recorded in state', async () => {
    await withWorld({ phase: 'mutating', state: managedState(), running: 'target' }, async (materialized, graph) => {
      const plan = await planRecovery('web', materialized.journal, graph.dependencies)
      expect(plan.decision).toEqual({ type: 'resume-rollback', previous: CURRENT_SNAPSHOT })
    })
  })

  it('classifies an uncommitted validating update as validate-target reconstructed from the live runtime', async () => {
    await withWorld({ phase: 'validating', state: managedState(), running: 'target' }, async (materialized, graph) => {
      const plan = await planRecovery('web', materialized.journal, graph.dependencies)
      expect(plan.decision).toEqual({ type: 'validate-target', target: TARGET_SNAPSHOT })
    })
  })

  it('classifies the post-commit crash window (committed state matching the target) as validate-target', async () => {
    await withWorld(
      { phase: 'validating', state: managedState(TARGET_SNAPSHOT, CURRENT_SNAPSHOT), running: 'target', beforeStateSha256: UNRELATED_HASH },
      async (materialized, graph) => {
        const plan = await planRecovery('web', materialized.journal, graph.dependencies)
        expect(plan.decision).toEqual({ type: 'validate-target', target: TARGET_SNAPSHOT })
      },
    )
  })

  it('blocks a state hash mismatch outside the post-commit window', async () => {
    // mutating with committed state: not the validating post-commit window.
    await withWorld(
      { phase: 'mutating', state: managedState(TARGET_SNAPSHOT, CURRENT_SNAPSHOT), running: 'target', beforeStateSha256: UNRELATED_HASH },
      async (materialized, graph) => {
        const plan = await planRecovery('web', materialized.journal, graph.dependencies)
        expect(plan.decision).toMatchObject({ type: 'blocked' })
        expect((plan.decision as { error: CliError }).error.action).toContain('doctor')
      },
    )
    // validating with a mismatched state that does not match the target either.
    const tampered = managedState()
    tampered.managed!.lastHealthyAt = '2026-08-31T00:00:00.000Z'
    await withWorld({ phase: 'validating', state: tampered, running: 'target', beforeStateSha256: UNRELATED_HASH }, async (materialized, graph) => {
      const plan = await planRecovery('web', materialized.journal, graph.dependencies)
      expect(plan.decision).toMatchObject({ type: 'blocked' })
    })
  })

  it('blocks resume-rollback when the recorded previous bundle directory is missing', async () => {
    await withWorld({ phase: 'mutating', state: managedState(), running: 'target', bundles: 'staged' }, async (materialized, graph) => {
      const plan = await planRecovery('web', materialized.journal, graph.dependencies)
      expect(plan.decision).toMatchObject({ type: 'blocked' })
    })
  })

  it('blocks rollback recovery when Docker is offline', async () => {
    await withWorld({ phase: 'mutating', state: managedState(), running: 'target', dockerOffline: true }, async (materialized, graph) => {
      const plan = await planRecovery('web', materialized.journal, graph.dependencies)
      expect(plan.decision).toMatchObject({ type: 'blocked', error: { code: 'E_DOCKER_OFFLINE' } })
    })
  })

  it('blocks a foreign deployment before any recovery action', async () => {
    await withWorld({ phase: 'mutating', state: managedState(), running: 'target', foreign: true }, async (materialized, graph) => {
      const plan = await planRecovery('web', materialized.journal, graph.dependencies)
      expect(plan.decision).toMatchObject({ type: 'blocked', error: { code: 'E_RESOURCE_FOREIGN' } })
    })
  })

  it('blocks validating recovery while Docker is offline instead of burning validation retries', async () => {
    await withWorld(
      { phase: 'validating', state: managedState(), running: 'target', dockerOffline: true },
      async (materialized, graph) => {
        const plan = await planRecovery('web', materialized.journal, graph.dependencies)
        expect(plan.decision).toMatchObject({ type: 'blocked', error: { code: 'E_DOCKER_OFFLINE' } })
        expect(graph.searxng.readiness).not.toHaveBeenCalled()
        await expect(stat(graph.journalPath)).resolves.toBeDefined()
      },
    )
    // The post-commit crash window gets the same gate: no probe, no rollback attempt.
    await withWorld(
      {
        phase: 'validating',
        state: managedState(TARGET_SNAPSHOT, CURRENT_SNAPSHOT),
        running: 'target',
        beforeStateSha256: UNRELATED_HASH,
        dockerOffline: true,
      },
      async (materialized, graph) => {
        const plan = await planRecovery('web', materialized.journal, graph.dependencies)
        expect(plan.decision).toMatchObject({ type: 'blocked', error: { code: 'E_DOCKER_OFFLINE' } })
      },
    )
  })

  it('blocks when the target deployment is absent from the packaged catalog', async () => {
    await withWorld(
      { phase: 'validating', state: managedState(), running: 'target', catalog: [CATALOG[0]!] },
      async (materialized, graph) => {
        const plan = await planRecovery('web', materialized.journal, graph.dependencies)
        expect(plan.decision).toMatchObject({ type: 'blocked', error: { code: 'E_DEPLOYMENT_UNSUPPORTED', action: 'Reinstall dsh-searxng and retry' } })
      },
    )
  })

  it('blocks when the catalog image for the target version no longer matches the journal target', async () => {
    const drifted = CATALOG.map((entry) =>
      entry.deploymentVersion === 2 ? { ...entry, image: `ghcr.io/searxng/searxng:drifted@sha256:${'2'.repeat(64)}` } : entry)
    await withWorld({ phase: 'validating', state: managedState(), running: 'target', catalog: drifted }, async (materialized, graph) => {
      const plan = await planRecovery('web', materialized.journal, graph.dependencies)
      expect(plan.decision).toMatchObject({ type: 'blocked', error: { code: 'E_DEPLOYMENT_UNSUPPORTED', action: 'Reinstall dsh-searxng and retry' } })
    })
  })

  it('blocks when the requested profile is not attached to the managed deployment', async () => {
    const detached: StateV2 = {
      schemaVersion: 2,
      homeId: HOME_ID,
      managed: managedState().managed,
      profiles: { other: { mode: 'external', endpoint: 'https://search.example' } },
    }
    await withWorld({ phase: 'mutating', state: detached, running: 'target' }, async (materialized, graph) => {
      const plan = await planRecovery('web', materialized.journal, graph.dependencies)
      expect(plan.decision).toMatchObject({
        type: 'blocked',
        error: { code: 'E_STATE_INVALID', action: expect.stringContaining('profile attached to the managed deployment') },
      })
    })
  })
})

describe('planRecovery matrix for non-update operation kinds', () => {
  it('clears a prepared setup journal when the state is untouched', async () => {
    await withWorld({ phase: 'prepared', kind: 'setup', state: managedState() }, async (materialized, graph) => {
      const plan = await planRecovery('web', materialized.journal, graph.dependencies)
      expect(plan.decision).toEqual({ type: 'clear-prepared' })
    })
  })

  it.each(['mutating', 'validating', 'rolling-back'] as const)
    ('blocks an interrupted remove operation in %s with clean-up guidance', async (phase) => {
      await withWorld({ phase, kind: 'remove', state: managedState(), running: 'previous' }, async (materialized, graph) => {
        const plan = await planRecovery('web', materialized.journal, graph.dependencies)
        expect(plan.decision).toMatchObject({
          type: 'blocked',
          error: { code: 'E_STATE_INVALID', action: expect.stringContaining('doctor --json') },
        })
      })
    })

  it.each(['mutating', 'validating', 'rolling-back'] as const)
    ('blocks an interrupted repair operation in %s with clean-up guidance', async (phase) => {
      await withWorld({ phase, kind: 'repair', state: managedState(), running: 'previous' }, async (materialized, graph) => {
        const plan = await planRecovery('web', materialized.journal, graph.dependencies)
        expect(plan.decision).toMatchObject({
          type: 'blocked',
          error: { code: 'E_STATE_INVALID', action: expect.stringContaining('doctor --json') },
        })
      })
    })

  it('blocks a prepared non-update journal when the state hash changed', async () => {
    await withWorld({ phase: 'prepared', kind: 'setup', state: managedState(), beforeStateSha256: UNRELATED_HASH }, async (materialized, graph) => {
      const plan = await planRecovery('web', materialized.journal, graph.dependencies)
      expect(plan.decision).toMatchObject({ type: 'blocked' })
    })
  })
})

describe('executeRecovery through a fresh dependency graph', () => {
  it('clears an untouched prepared journal and leaves the state bytes unchanged', async () => {
    await withWorld({ phase: 'prepared', state: managedState() }, async (materialized, graph) => {
      const plan = await planRecovery('web', materialized.journal, graph.dependencies)
      const outcome = await executeRecovery(plan, graph.dependencies)
      expect(outcome).toEqual({
        decision: 'clear-prepared',
        outcome: 'journal-cleared',
        checks: [],
      })
      await expect(stat(graph.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stateBytes(graph.statePath)).resolves.toBe(asBytes(managedState()))
      expect(graph.docker.down).not.toHaveBeenCalled()
    })
  })

  it('still clears a prepared journal when Docker is offline: the phase precedes every runtime mutation', async () => {
    await withWorld({ phase: 'prepared', state: managedState(), dockerOffline: true }, async (materialized, graph) => {
      const plan = await planRecovery('web', materialized.journal, graph.dependencies)
      expect(plan.decision).toEqual({ type: 'clear-prepared' })
      const outcome = await executeRecovery(plan, graph.dependencies)
      expect(outcome).toMatchObject({ decision: 'clear-prepared', outcome: 'journal-cleared' })
      await expect(stat(graph.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stateBytes(graph.statePath)).resolves.toBe(asBytes(managedState()))
      expect(graph.docker.deploymentStatus).not.toHaveBeenCalled()
    })
  })

  it('resumes rollback from mutating: downs the active target, ups and validates the previous, clears the journal', async () => {
    await withWorld({ phase: 'mutating', state: managedState(), running: 'target' }, async (materialized, graph) => {
      const plan = await planRecovery('web', materialized.journal, graph.dependencies)
      const outcome = await executeRecovery(plan, graph.dependencies)

      expect(outcome.decision).toBe('resume-rollback')
      expect(outcome.outcome).toBe('rollback-completed')
      expect(outcome.checks.map((check) => check.id)).toEqual(['http', 'json', 'search', 'profile', 'provider'])
      // The active bundle comes from the running container's compose label;
      // the previous bundle is restored from the state-recorded digest.
      expect(graph.docker.down).toHaveBeenCalledTimes(1)
      expect(graph.docker.down).toHaveBeenCalledWith(
        expect.objectContaining({ composePath: materialized.stagedCompose }),
        false,
        undefined,
      )
      expect(graph.docker.up).toHaveBeenCalledTimes(1)
      expect(graph.docker.up).toHaveBeenCalledWith(
        expect.objectContaining({ composePath: materialized.previousCompose }),
        undefined,
      )
      // The previous image is verified present (never re-pulled when it exists).
      expect(graph.docker.imageExists).toHaveBeenCalledWith(SEARXNG_IMAGE)
      expect(graph.docker.pull).not.toHaveBeenCalled()
      const recovered: StateV2 = JSON.parse(await stateBytes(graph.statePath))
      expect(recovered.managed?.current).toEqual(CURRENT_SNAPSHOT)
      expect(recovered.managed?.lastHealthyAt).toBe(RECOVERY_TIME)
      await expect(stat(graph.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('pulls the previous image through imageExists before restoring when it is missing locally', async () => {
    await withWorld(
      { phase: 'rolling-back', state: managedState(), running: 'target', images: [TARGET_IMAGE] },
      async (materialized, graph) => {
        const plan = await planRecovery('web', materialized.journal, graph.dependencies)
        const outcome = await executeRecovery(plan, graph.dependencies)
        expect(outcome.outcome).toBe('rollback-completed')
        expect(graph.docker.pull).toHaveBeenCalledWith(SEARXNG_IMAGE)
        expect(graph.docker.up).toHaveBeenCalledWith(
          expect.objectContaining({ composePath: materialized.previousCompose }),
          undefined,
        )
        await expect(stat(graph.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
      },
    )
  })

  it('resumes an interrupted rolling-back phase and validates the previous snapshot', async () => {
    await withWorld({ phase: 'rolling-back', state: managedState(), running: 'target' }, async (materialized, graph) => {
      const plan = await planRecovery('web', materialized.journal, graph.dependencies)
      const outcome = await executeRecovery(plan, graph.dependencies)
      expect(outcome).toMatchObject({ decision: 'resume-rollback', outcome: 'rollback-completed' })
      expect(graph.events).toContain(`down:config-${STAGED_HASH}:false`)
      expect(graph.events).toContain(`up:config-${CURRENT_HASH}`)
      await expect(stat(graph.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('commits the target from validating when every end-to-end check passes', async () => {
    await withWorld({ phase: 'validating', state: managedState(), running: 'target' }, async (materialized, graph) => {
      const plan = await planRecovery('web', materialized.journal, graph.dependencies)
      const outcome = await executeRecovery(plan, graph.dependencies)

      expect(outcome.decision).toBe('validate-target')
      expect(outcome.outcome).toBe('target-committed')
      expect(graph.docker.down).not.toHaveBeenCalled()
      const recovered: StateV2 = JSON.parse(await stateBytes(graph.statePath))
      expect(recovered.managed).toEqual({
        current: TARGET_SNAPSHOT,
        previous: CURRENT_SNAPSHOT,
        lastHealthyAt: RECOVERY_TIME,
      })
      await expect(stat(graph.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('rolls the target back from validating when validation fails', async () => {
    await withWorld(
      { phase: 'validating', state: managedState(), running: 'target', failSearchCalls: [1] },
      async (materialized, graph) => {
        const plan = await planRecovery('web', materialized.journal, graph.dependencies)
        const outcome = await executeRecovery(plan, graph.dependencies)

        expect(outcome).toMatchObject({ decision: 'validate-target', outcome: 'target-rolled-back' })
        expect(graph.docker.down).toHaveBeenCalledWith(
          expect.objectContaining({ composePath: materialized.stagedCompose }),
          false,
          undefined,
        )
        expect(graph.docker.up).toHaveBeenCalledWith(
          expect.objectContaining({ composePath: materialized.previousCompose }),
          undefined,
        )
        // The state was never committed by the interrupted update and stays exactly as materialized.
        await expect(stateBytes(graph.statePath)).resolves.toBe(asBytes(managedState()))
        await expect(stat(graph.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
      },
    )
  })

  it('clears the journal and refreshes lastHealthyAt in the post-commit crash window', async () => {
    await withWorld(
      { phase: 'validating', state: managedState(TARGET_SNAPSHOT, CURRENT_SNAPSHOT), running: 'target', beforeStateSha256: UNRELATED_HASH },
      async (materialized, graph) => {
        const plan = await planRecovery('web', materialized.journal, graph.dependencies)
        const outcome = await executeRecovery(plan, graph.dependencies)

        expect(outcome).toMatchObject({ decision: 'validate-target', outcome: 'target-committed' })
        expect(graph.docker.down).not.toHaveBeenCalled()
        const recovered: StateV2 = JSON.parse(await stateBytes(graph.statePath))
        expect(recovered.managed).toEqual({
          current: TARGET_SNAPSHOT,
          previous: CURRENT_SNAPSHOT,
          lastHealthyAt: RECOVERY_TIME,
        })
        await expect(stat(graph.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
      },
    )
  })

  it('rolls a committed target back in the post-commit window when validation fails', async () => {
    await withWorld(
      {
        phase: 'validating',
        state: managedState(TARGET_SNAPSHOT, CURRENT_SNAPSHOT),
        running: 'target',
        beforeStateSha256: UNRELATED_HASH,
        failSearchCalls: [1],
      },
      async (materialized, graph) => {
        const plan = await planRecovery('web', materialized.journal, graph.dependencies)
        const outcome = await executeRecovery(plan, graph.dependencies)

        expect(outcome).toMatchObject({ decision: 'validate-target', outcome: 'target-rolled-back' })
        const recovered: StateV2 = JSON.parse(await stateBytes(graph.statePath))
        expect(recovered.managed).toEqual({
          current: CURRENT_SNAPSHOT,
          lastHealthyAt: RECOVERY_TIME,
        })
        await expect(stat(graph.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
      },
    )
  })

  it('retains the journal and state as evidence when the resumed rollback cannot validate', async () => {
    await withWorld(
      { phase: 'mutating', state: managedState(), running: 'target', failSearchCalls: [1, 2] },
      async (materialized, graph) => {
        const plan = await planRecovery('web', materialized.journal, graph.dependencies)
        const error = await executeRecovery(plan, graph.dependencies).catch((cause: unknown) => cause as CliError)
        expect(error).toMatchObject({ code: 'E_INTERNAL', action: expect.stringContaining('doctor --json') })

        const retained = JSON.parse(await stateBytes(graph.journalPath)) as OperationJournal
        expect(retained).toMatchObject({ id: JOURNAL_ID, kind: 'update', phase: 'rolling-back' })
        await expect(stateBytes(graph.statePath)).resolves.toBe(asBytes(managedState()))
      },
    )
  })

  it('refuses to execute when the journal was replaced after planning', async () => {
    await withWorld({ phase: 'prepared', state: managedState() }, async (materialized, graph) => {
      const plan = await planRecovery('web', materialized.journal, graph.dependencies)
      await writeFile(
        graph.journalPath,
        `${JSON.stringify({ ...materialized.journal, id: 'e'.repeat(32) })}\n`,
        'utf8',
      )
      await expect(executeRecovery(plan, graph.dependencies)).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
      await expect(stat(graph.journalPath)).resolves.toBeDefined()
    })
  })

  it('refuses to execute when the state changed after planning', async () => {
    await withWorld({ phase: 'prepared', state: managedState() }, async (materialized, graph) => {
      const plan = await planRecovery('web', materialized.journal, graph.dependencies)
      const changed = structuredClone(managedState())
      changed.managed!.lastHealthyAt = '2026-08-31T00:00:00.000Z'
      await writeFile(graph.statePath, asBytes(changed), 'utf8')
      await expect(executeRecovery(plan, graph.dependencies)).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
      await expect(stat(graph.journalPath)).resolves.toBeDefined()
    })
  })
})

describe('state lock handling during recovery', () => {
  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    return child.pid!
  }

  it('removes a stale lock after journal inspection and completes the recovery', async () => {
    const pid = await deadPid()
    await withWorld(
      { phase: 'prepared', state: managedState(), lock: `${JSON.stringify({ pid, timestamp: START, identity: 'a'.repeat(32) })}\n` },
      async (materialized, graph) => {
        const plan = await planRecovery('web', materialized.journal, graph.dependencies)
        expect(plan.staleLock).toEqual({ pid, identity: 'a'.repeat(32) })
        const outcome = await executeRecovery(plan, graph.dependencies)
        expect(outcome.outcome).toBe('journal-cleared')
        await expect(stat(graph.lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(graph.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
      },
    )
  })

  it('never deletes a lock that was replaced after planning: it is restored and recovery blocks safely', async () => {
    const pid = await deadPid()
    await withWorld(
      { phase: 'prepared', state: managedState(), lock: `${JSON.stringify({ pid, timestamp: START, identity: 'a'.repeat(32) })}\n` },
      async (materialized, graph) => {
        const plan = await planRecovery('web', materialized.journal, graph.dependencies)
        expect(plan.staleLock).toBeDefined()
        // Between the staleness check and the removal, the dead owner's lock
        // file is replaced by a newly acquired live one.
        await writeFile(
          graph.lockPath,
          `${JSON.stringify({ pid: process.pid, timestamp: START, identity: 'b'.repeat(32) })}\n`,
          'utf8',
        )
        await expect(executeRecovery(plan, graph.dependencies)).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
        // The live replacement is intact, byte for byte, and no quarantine leftovers remain.
        await expect(readFile(graph.lockPath, 'utf8')).resolves.toBe(
          `${JSON.stringify({ pid: process.pid, timestamp: START, identity: 'b'.repeat(32) })}\n`,
        )
        expect((await readdir(materialized.root)).filter((name) => name.startsWith('state.lock.recovery-'))).toEqual([])
        // Evidence retained: nothing was recovered.
        await expect(stat(graph.journalPath)).resolves.toBeDefined()
        await expect(stateBytes(graph.statePath)).resolves.toBe(asBytes(managedState()))
      },
    )
  })

  it('never removes a live lock and blocks with wait guidance', async () => {
    await withWorld(
      {
        phase: 'mutating',
        state: managedState(),
        running: 'target',
        lock: `${JSON.stringify({ pid: process.pid, timestamp: START, identity: 'a'.repeat(32) })}\n`,
      },
      async (materialized, graph) => {
        const plan = await planRecovery('web', materialized.journal, graph.dependencies)
        expect(plan.decision).toMatchObject({ type: 'blocked' })
        const error = (plan.decision as { type: 'blocked'; error: CliError }).error
        expect(error.code).toBe('E_STATE_INVALID')
        expect(error.action).toContain('Wait')
        // Nothing was executed: evidence intact.
        await expect(stat(graph.lockPath)).resolves.toBeDefined()
        await expect(stat(graph.journalPath)).resolves.toBeDefined()
        expect(graph.docker.down).not.toHaveBeenCalled()
      },
    )
  })

  it('refuses to remove a lock whose owner cannot be verified', async () => {
    await withWorld({ phase: 'prepared', state: managedState(), lock: 'not json\n' }, async (materialized, graph) => {
      const plan = await planRecovery('web', materialized.journal, graph.dependencies)
      expect(plan.decision).toMatchObject({ type: 'blocked' })
      await expect(stat(graph.lockPath)).resolves.toBeDefined()
    })
  })

  it('the state store itself still refuses a stale lock: only recovery removes it', async () => {
    const pid = await deadPid()
    await withWorld(
      { phase: 'prepared', state: managedState(), lock: `${JSON.stringify({ pid, timestamp: START, identity: 'a'.repeat(32) })}\n` },
      async (_materialized, graph) => {
        await expect(graph.dependencies.state.withLock(async () => 'ok')).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
        await expect(stat(graph.lockPath)).resolves.toBeDefined()
      },
    )
  })
})

describe('recovery through a fresh CLI dependency graph', () => {
  function cliDependencies(world: CrashWorld, materialized: Materialized, options: { packagedCatalog?: boolean } = {}) {
    const graph = freshGraph(world, materialized)
    const dependencies = {
      environment: graph.environment,
      state: graph.dependencies.state,
      docker: graph.docker,
      assets: { render: vi.fn(async () => { throw new Error('recovery must not render') }) } satisfies AssetRenderer,
      searxng: graph.searxng,
      profiles: graph.profiles,
      now: graph.dependencies.now,
      confirmPurge: vi.fn(async () => false),
      removeManagedDirectory: vi.fn(async () => {}),
      journal: graph.dependencies.journal,
      probeAssets: vi.fn(async () => 'valid' as const),
      ...(options.packagedCatalog === true ? {} : { catalog: CATALOG }),
    }
    return { graph, dependencies: dependencies as unknown as NonNullable<Parameters<typeof runCli>[1]>['dependencies'] }
  }

  it('cross-checks the packaged production catalog when no catalog is injected into the wiring', async () => {
    // No `catalog` in the CLI dependencies: the repair wiring must fall back
    // to loadDeploymentCatalog(), whose only packaged entry is version 1 —
    // the journal's version-2 target is unknown and must block with
    // reinstall guidance instead of being committed blind.
    const world: CrashWorld = { phase: 'validating', state: managedState(), running: 'target' }
    await withWorld(world, async (materialized, graph) => {
      const cli = cliDependencies(world, materialized, { packagedCatalog: true })
      const stdout: string[] = []
      const stderr: string[] = []
      const exitCode = await runCli(['repair', '--json'], {
        dependencies: cli.dependencies,
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      })
      expect(exitCode).toBe(1)
      expect(stdout).toEqual([])
      expect(JSON.parse(stderr[0]!)).toMatchObject({
        code: 'E_DEPLOYMENT_UNSUPPORTED',
        action: 'Reinstall dsh-searxng and retry',
      })
      expect(graph.docker.up).not.toHaveBeenCalled()
      await expect(stat(graph.journalPath)).resolves.toBeDefined()
      await expect(stateBytes(graph.statePath)).resolves.toBe(asBytes(managedState()))
    })
  })

  it.each([
    ['prepared', 'clear-prepared', 'journal-cleared'],
    ['mutating', 'resume-rollback', 'rollback-completed'],
    ['validating', 'validate-target', 'target-committed'],
    ['rolling-back', 'resume-rollback', 'rollback-completed'],
  ] as const)('recovers an update interrupted in %s without any in-memory carry-over', async (phase, decision, outcome) => {
    await withWorld(
      { phase, state: managedState(), running: phase === 'prepared' ? 'previous' : 'target' },
      async (materialized, graph) => {
        const cli = cliDependencies({ phase, state: managedState(), running: phase === 'prepared' ? 'previous' : 'target' }, materialized)
        const stdout: string[] = []
        const stderr: string[] = []
        const exitCode = await runCli(['repair', '--json'], {
          dependencies: cli.dependencies,
          stdout: (text) => stdout.push(text),
          stderr: (text) => stderr.push(text),
        })
        expect(exitCode).toBe(0)
        expect(stderr).toEqual([])
        expect(stdout).toHaveLength(1)
        const envelope = JSON.parse(stdout[0]!) as Record<string, unknown>
        expect(envelope.recovery).toMatchObject({ decision, outcome })
        expect(envelope.healthy).toBe(true)
        await expect(stat(graph.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
      },
    )
  })

  it('explains the interruption and the recovery for human output', async () => {
    await withWorld({ phase: 'mutating', state: managedState(), running: 'target' }, async (materialized, graph) => {
      const cli = cliDependencies({ phase: 'mutating', state: managedState(), running: 'target' }, materialized)
      const stdout: string[] = []
      const stderr: string[] = []
      const exitCode = await runCli(['repair'], {
        dependencies: cli.dependencies,
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      })
      expect(exitCode).toBe(0)
      const output = stdout.join('')
      expect(output).toContain('Interrupted operation: update (mutating)')
      expect(output).toContain('SearXNG healthy')
      await expect(stat(graph.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('reports a blocked recovery as a structured error without mutating evidence', async () => {
    await withWorld(
      { phase: 'mutating', state: managedState(TARGET_SNAPSHOT, CURRENT_SNAPSHOT), running: 'target', beforeStateSha256: UNRELATED_HASH },
      async (materialized, graph) => {
        const cli = cliDependencies(
          { phase: 'mutating', state: managedState(TARGET_SNAPSHOT, CURRENT_SNAPSHOT), running: 'target', beforeStateSha256: UNRELATED_HASH },
          materialized,
        )
        const stdout: string[] = []
        const stderr: string[] = []
        const exitCode = await runCli(['repair', '--json'], {
          dependencies: cli.dependencies,
          stdout: (text) => stdout.push(text),
          stderr: (text) => stderr.push(text),
        })
        expect(exitCode).toBe(1)
        expect(stdout).toEqual([])
        expect(JSON.parse(stderr[0]!)).toMatchObject({ code: 'E_STATE_INVALID' })
        await expect(stat(graph.journalPath)).resolves.toBeDefined()
      },
    )
  })
})

describe('doctor reports the interrupted operation', () => {
  async function doctorDeps(world: CrashWorld, materialized: Materialized): Promise<SnapshotDependencies> {
    const graph = freshGraph(world, materialized)
    return {
      environment: graph.environment,
      state: graph.dependencies.state,
      docker: graph.docker,
      profiles: graph.profiles,
      searxng: graph.searxng,
      journal: graph.dependencies.journal,
      now: graph.dependencies.now,
    }
  }

  it('reports journal id, kind, phase, and age without secrets', async () => {
    await withWorld({ phase: 'mutating', state: managedState(), running: 'target' }, async (materialized) => {
      const result = await diagnose('web', 'doctor', await doctorDeps({ phase: 'mutating', state: managedState(), running: 'target' }, materialized))
      expect(result.interruptedOperation).toEqual({
        id: JOURNAL_ID,
        kind: 'update',
        phase: 'mutating',
        startedAt: START,
        ageMs: Date.parse(RECOVERY_TIME) - Date.parse(START),
      })
      const journalCheck = result.checks.find((check) => check.id === 'journal')
      expect(journalCheck?.status).toBe('fail')
      expect(journalCheck?.message).toContain('update')
      expect(journalCheck?.message).toContain('mutating')
      expect(JSON.stringify(result)).not.toMatch(/[a-f0-9]{64}/)
      expect(result.healthy).toBe(false)
    })
  })

  it('keeps the rest of the chain running and reports health for status output', async () => {
    await withWorld({ phase: 'mutating', state: managedState(), running: 'target' }, async (materialized) => {
      const world: CrashWorld = { phase: 'mutating', state: managedState(), running: 'target' }
      const result = await diagnose('web', 'status', await doctorDeps(world, materialized))
      expect(result.interruptedOperation).toBeUndefined()
      expect(result.checks.some((check) => check.id === 'journal')).toBe(false)
      expect(result.healthy).toBe(true)
    })
  })

  it('passes the journal check when no operation is interrupted', async () => {
    await withWorld({ phase: 'mutating', state: managedState(), running: 'target' }, async (materialized) => {
      await rm(join(materialized.root, 'journal.json'), { force: true })
      const result = await diagnose('web', 'doctor', await doctorDeps({ phase: 'mutating', state: managedState(), running: 'target' }, materialized))
      expect(result.interruptedOperation).toBeUndefined()
      expect(result.checks.find((check) => check.id === 'journal')).toMatchObject({ status: 'pass' })
      expect(result.healthy).toBe(true)
    })
  })

  it('fails the journal check and skips downstream checks for a malformed journal', async () => {
    await withWorld({ phase: 'mutating', state: managedState(), running: 'target' }, async (materialized) => {
      await writeFile(join(materialized.root, 'journal.json'), 'not json\n', 'utf8')
      const result = await diagnose('web', 'doctor', await doctorDeps({ phase: 'mutating', state: managedState(), running: 'target' }, materialized))
      expect(result.healthy).toBe(false)
      const journalCheck = result.checks.find((check) => check.id === 'journal')
      expect(journalCheck?.status).toBe('fail')
      expect(result.checks.find((check) => check.id === 'environment')?.status).toBe('skip')
    })
  })

  it('prints the interruption for human doctor output', async () => {
    const world: CrashWorld = { phase: 'validating', state: managedState(), running: 'target' }
    await withWorld(world, async (materialized) => {
      const graph = freshGraph(world, materialized)
      const dependencies = {
        environment: graph.environment,
        state: graph.dependencies.state,
        docker: graph.docker,
        assets: { render: vi.fn(async () => { throw new Error('unused') }) },
        searxng: graph.searxng,
        profiles: graph.profiles,
        now: graph.dependencies.now,
        confirmPurge: vi.fn(async () => false),
        removeManagedDirectory: vi.fn(async () => {}),
        journal: graph.dependencies.journal,
        probeAssets: vi.fn(async () => 'valid' as const),
      }
      const stdout: string[] = []
      const stderr: string[] = []
      const exitCode = await runCli(['doctor'], {
        dependencies: dependencies as unknown as NonNullable<Parameters<typeof runCli>[1]>['dependencies'],
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      })
      expect(exitCode).toBe(1)
      const output = `${stdout.join('')}${stderr.join('')}`
      expect(output).toContain('interrupted update operation')
      expect(output).toContain('repair')
      expect(output).not.toMatch(/[a-f0-9]{64}/)
    })
  })
})

describe('setup respects an interrupted journal', () => {
  it('refuses to run and directs to repair without mutating anything', async () => {
    await withWorld({ phase: 'mutating', state: managedState(), running: 'target' }, async (materialized, graph) => {
      const error = await setup(
        { profile: 'web', port: 8080, portExplicit: true },
        {
          environment: graph.environment,
          state: graph.dependencies.state,
          journal: graph.dependencies.journal,
          docker: graph.docker,
          assets: { render: vi.fn(async () => { throw new Error('setup must not render') }) },
          searxng: graph.searxng,
          profiles: graph.profiles,
          now: graph.dependencies.now,
        },
      ).then(
        () => { throw new Error('expected setup to refuse') },
        (cause: unknown) => cause as CliError,
      )
      expect(error).toMatchObject({ code: 'E_STATE_INVALID' })
      expect(error.action).toContain('repair')
      expect(graph.docker.up).not.toHaveBeenCalled()
      await expect(stateBytes(graph.statePath)).resolves.toBe(asBytes(managedState()))
      await expect(stat(graph.journalPath)).resolves.toBeDefined()
    })
  })
})

describe('non-update journal escape path', () => {
  function removeDeps(graph: ReturnType<typeof freshGraph>): RemoveDependencies {
    return {
      environment: graph.environment,
      state: graph.dependencies.state,
      journal: graph.dependencies.journal,
      docker: graph.docker,
      profiles: graph.profiles,
      confirmPurge: vi.fn(async () => false),
      removeManagedDirectory: vi.fn(async () => {}),
    }
  }

  it('remove --service clears the journal after successful service removal', async () => {
    await withWorld(
      { phase: 'validating', kind: 'repair', state: managedState(), running: 'previous' },
      async (materialized, graph) => {
        const result = await remove(
          { profile: 'web', service: true, purgeData: false, confirmed: false },
          removeDeps(graph),
        )
        expect(result).toMatchObject({ profileRemoved: true, serviceRemoved: true })
        expect(graph.docker.down).toHaveBeenCalledTimes(1)
        // The journal's evidence purpose ended with the deployment.
        await expect(stat(graph.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
      },
    )
  })

  it('remove without --service never clears the journal: the deployment is still recorded', async () => {
    await withWorld(
      { phase: 'validating', kind: 'repair', state: managedState(), running: 'previous' },
      async (materialized, graph) => {
        await remove({ profile: 'web', service: false, purgeData: false, confirmed: false }, removeDeps(graph))
        await expect(stat(graph.journalPath)).resolves.toBeDefined()
      },
    )
  })

  it('remove --service clears an interrupted journal even when no managed state remains', async () => {
    const bare: StateV2 = { schemaVersion: 2, homeId: HOME_ID, profiles: {} }
    await withWorld({ phase: 'mutating', kind: 'setup', state: bare }, async (materialized, graph) => {
      const result = await remove(
        { profile: 'web', service: true, purgeData: false, confirmed: false },
        removeDeps(graph),
      )
      expect(result).toMatchObject({ serviceRemoved: true })
      await expect(stat(graph.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('blocked guidance no longer loops: remove --service --purge-data lets setup succeed', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-searxng-escape-'))
    try {
      const dshHome = join(base, 'dsh')
      const managedDir = join(dshHome, 'dsh-searxng')
      await mkdir(managedDir, { recursive: true })
      await writeFile(join(managedDir, 'state.json'), `${JSON.stringify(managedState())}\n`, 'utf8')
      const journal = journalFixture('validating', { kind: 'repair', beforeStateSha256: stateSha256(managedState()) })
      await writeFile(join(managedDir, 'journal.json'), `${JSON.stringify(journal)}\n`, 'utf8')

      const environment: EnvironmentService = {
        resolve: vi.fn(async () => ({ dshHome, profileDir: join(dshHome, 'profiles', 'web'), managedDir, homeId: HOME_ID })),
        preflightManaged: vi.fn(async () => {}),
        preflightDsh: vi.fn(async () => {}),
      }
      const composePath = join(managedDir, `config-${CURRENT_HASH}`, 'compose.yml')
      const removeDocker: DockerAdapter = {
        preflight: vi.fn(async () => ({ serverVersion: '27', composeVersion: '2.30' })),
        inspectOwnership: vi.fn(async () => 'owned' as const),
        up: vi.fn(async () => {}),
        restart: vi.fn(),
        down: vi.fn(async () => {}),
        logs: vi.fn(async () => ''),
        pull: vi.fn(),
        imageExists: vi.fn(async () => true),
        deploymentStatus: vi.fn(async () => ({ ownership: 'owned' as const, container: 'running' as const, composePath })),
      }
      // After the purge the deployment is gone: setup must see absent ownership.
      const setupDocker: DockerAdapter = {
        ...removeDocker,
        inspectOwnership: vi.fn(async () => 'absent' as const),
        deploymentStatus: vi.fn(async () => ({ ownership: 'absent' as const, container: 'absent' as const })),
      }
      const searxng: SearxngProbe = {
        http: vi.fn(async () => {}),
        readiness: vi.fn(async () => {}),
        realSearch: vi.fn(async () => ({ endpoint: ENDPOINT, resultCount: 1, elapsedMs: 1 })),
        providerSearch: vi.fn(async () => ({ endpoint: ENDPOINT, resultCount: 1, elapsedMs: 1 })),
      }
      const profiles: ProfileManager = {
        inspect: vi.fn(),
        preview: vi.fn(async () => ({ installed: false, attached: false, config: { baseURL: ENDPOINT } })),
        validate: vi.fn(async (_profile: string, _endpoint: string, callback: (config: { baseURL: string }) => Promise<void>) => {
          await callback({ baseURL: ENDPOINT })
        }),
        attach: vi.fn(async (_profile: string, endpoint: string, validate: (config: { baseURL: string }) => Promise<void>) => {
          await validate({ baseURL: endpoint })
        }),
        detach: vi.fn(async () => {}),
        uninstall: vi.fn(async () => {}),
      }

      // Step 1: recovery blocks with escape guidance that names remove --service.
      const recoveryGraph: RecoveryDependencies = {
        environment,
        state: new FileStateStore(managedDir, HOME_ID),
        journal: new FileJournalStore(managedDir),
        docker: removeDocker,
        searxng,
        profiles,
        now: () => new Date(RECOVERY_TIME),
      }
      const plan = await planRecovery('web', journal, recoveryGraph)
      expect(plan.decision).toMatchObject({ type: 'blocked' })
      expect((plan.decision as { error: CliError }).error.action).toContain('remove --service --purge-data')

      // Step 2: remove --service --purge-data removes the deployment and journal.
      const result = await remove(
        { profile: 'web', service: true, purgeData: true, confirmed: true },
        {
          environment,
          state: new FileStateStore(managedDir, HOME_ID),
          journal: new FileJournalStore(managedDir),
          docker: removeDocker,
          profiles,
          confirmPurge: vi.fn(async () => true),
          removeManagedDirectory,
        },
      )
      expect(result).toMatchObject({ serviceRemoved: true, dataPurged: true })
      await expect(stat(managedDir)).rejects.toMatchObject({ code: 'ENOENT' })

      // Step 3: setup succeeds over the same world — no journal, no dead-loop.
      const setupResult = await setup(
        { profile: 'web', port: 8080, portExplicit: true },
        {
          environment,
          state: new FileStateStore(managedDir, HOME_ID),
          journal: new FileJournalStore(managedDir),
          docker: setupDocker,
          assets: {
            render: vi.fn(async () => ({ composePath, configurationSha256: CURRENT_HASH })),
          },
          searxng,
          profiles,
          now: () => new Date(RECOVERY_TIME),
        },
      )
      expect(setupResult).toEqual({ profile: 'web', endpoint: ENDPOINT, reused: false })
      const recreated: StateV2 = JSON.parse(await readFile(join(managedDir, 'state.json'), 'utf8'))
      expect(recreated.managed?.current).toMatchObject({ port: 8080, endpoint: ENDPOINT })
      await expect(stat(join(managedDir, 'journal.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

describe('orphaned staging directories', () => {
  function repairDeps(graph: ReturnType<typeof freshGraph>): RepairDependencies {
    return {
      environment: graph.environment,
      state: graph.dependencies.state,
      journal: graph.dependencies.journal,
      docker: graph.docker,
      assets: { render: vi.fn(async () => { throw new Error('unused') }) },
      searxng: graph.searxng,
      profiles: graph.profiles,
      diagnose: vi.fn(async () => { throw new Error('unused') }),
      now: graph.dependencies.now,
    }
  }

  it('inspectSnapshot lists direct .staging-* children of the managed directory', async () => {
    await withWorld(
      {
        phase: 'prepared',
        state: managedState(),
        stagingDirs: ['.staging-4242-0123456789abcdef', '.staging-777-fedcba9876543210'],
      },
      async (materialized, graph) => {
        // A foreign-shaped staging-like entry must not be swept.
        await mkdir(join(materialized.root, '.staging-not-ours'), { recursive: true })
        const dependencies: SnapshotDependencies = {
          environment: graph.environment,
          state: graph.dependencies.state,
          docker: graph.docker,
          profiles: graph.profiles,
          searxng: graph.searxng,
          journal: graph.dependencies.journal,
          probeAssets: vi.fn(async () => 'valid' as const),
        }
        const snapshot = await inspectSnapshot('web', dependencies)
        expect(snapshot.ownedTemporaryResourceIds).toEqual([
          '.staging-4242-0123456789abcdef',
          '.staging-777-fedcba9876543210',
        ])
      },
    )
  })

  it('remove-owned-temporary removes exactly the swept staging directories', async () => {
    const staging = '.staging-4242-0123456789abcdef'
    await withWorld({ phase: 'prepared', state: managedState(), stagingDirs: [staging] }, async (materialized, graph) => {
      // Ordinary repair runs only without a journal; recovery cleared this one already.
      await rm(join(materialized.root, 'journal.json'), { force: true })
      await executeRepair(
        {
          profile: 'web',
          endpoint: ENDPOINT,
          mode: 'managed',
          stateHash: stateSha256(managedState()),
          actions: [{ type: 'remove-owned-temporary', resourceIds: [staging] }],
          summary: [],
        },
        repairDeps(graph),
      )
      expect(await readdir(materialized.root)).not.toContain(staging)
    })
  })

  it('refuses to remove a staging entry that is a symlink', async () => {
    const staging = '.staging-4242-0123456789abcdef'
    await withWorld({ phase: 'prepared', state: managedState() }, async (materialized, graph) => {
      await rm(join(materialized.root, 'journal.json'), { force: true })
      const outside = await mkdtemp(join(tmpdir(), 'dsh-searxng-outside-'))
      try {
        await symlink(outside, join(materialized.root, staging))
        await expect(executeRepair(
          {
            profile: 'web',
            endpoint: ENDPOINT,
            mode: 'managed',
            stateHash: stateSha256(managedState()),
            actions: [{ type: 'remove-owned-temporary', resourceIds: [staging] }],
            summary: [],
          },
          repairDeps(graph),
        )).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
        await expect(stat(join(materialized.root, staging))).resolves.toBeDefined()
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })
  })
})
