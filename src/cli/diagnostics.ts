import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DockerAdapter, DockerDeploymentStatus } from './docker.ts'
import { CliError } from './errors.ts'
import type { EnvironmentService } from './environment.ts'
import { stateSha256, type JournalStore, type OperationJournal } from './journal.ts'
import { bundleDirectory, rethrowCancellation, stateIdentity } from './managed.ts'
import type { ProfileAttachmentConfig, ProfileAttachmentPreview, ProfileManager } from './profile.ts'
import type { SearxngProbe } from './searxng.ts'
import type { DeploymentSnapshot, StateStore } from './state.ts'

export interface DiagnosticCheck {
  id: string
  status: 'pass' | 'fail' | 'skip'
  message: string
  error?: ReturnType<CliError['toJSON']>
}

export interface DiagnosticResult {
  profile: string
  mode?: 'managed' | 'external'
  endpoint?: string
  healthy: boolean
  checks: DiagnosticCheck[]
}

export interface DiagnosticDependencies {
  environment: EnvironmentService
  state: StateStore
  docker: DockerAdapter
  profiles: ProfileManager
  searxng: SearxngProbe
}

/**
 * Read-only world model consumed by the pure repair planner. Produced by
 * `inspectSnapshot`; digests and IDs only, never secrets. Fields that are
 * unobservable for a condition default to the value that keeps the planner
 * conservative (it blocks on the conditions it can see).
 */
export interface DiagnosticSnapshot {
  profile: string
  /** Authoritative endpoint: the managed deployment's, or the profile entry's for external. */
  expectedEndpoint: string
  stateHash: string
  mode: 'managed' | 'external'
  docker: 'healthy' | 'offline'
  ownership: 'owned' | 'absent' | 'foreign'
  container: 'running' | 'stopped' | 'missing'
  generatedAssets: 'valid' | 'missing' | 'invalid'
  port: 'available' | 'owned' | 'foreign'
  endpoint: 'healthy' | 'unreachable' | 'auth-failed' | 'tls-failed'
  profileEndpoint?: { profile: string; expected: string; actual?: string }
  ownedTemporaryResourceIds: string[]
  interruptedOperation?: OperationJournal
}

export interface AssetProbeInput {
  stateDir: string
  homeId: string
  current: DeploymentSnapshot
  composePath?: string
}

export type AssetProbeStatus = DiagnosticSnapshot['generatedAssets']

export interface SnapshotDependencies extends DiagnosticDependencies {
  journal: JournalStore
  /** Overrides the filesystem bundle probe; production reads the managed directory. */
  probeAssets?(input: AssetProbeInput): Promise<AssetProbeStatus>
}

const EXPECTED_ENVIRONMENT: ReadonlyArray<readonly [string, (input: AssetProbeInput) => string]> = [
  ['DSH_SEARXNG_IMAGE', (input) => input.current.image],
  ['DSH_SEARXNG_PORT', (input) => String(input.current.port)],
  ['DSH_SEARXNG_HOME_ID', (input) => input.homeId],
  ['DSH_SEARXNG_PROJECT', (input) => input.current.projectName],
  ['DSH_SEARXNG_CONTAINER', (input) => input.current.containerName],
]

/**
 * Structural bundle probe: the recorded configuration digest (or the live
 * Compose path for digest-less v1 snapshots) must point at a directory whose
 * `.env` carries the deployment identity and whose Compose and settings files
 * exist. The SearXNG secret itself is never read or compared here.
 */
async function fileAssetProbe(input: AssetProbeInput): Promise<AssetProbeStatus> {
  const bundleDir = bundleDirectory(input.stateDir, input.current, input.composePath)
  if (bundleDir === undefined) return 'missing'
  try {
    await stat(bundleDir)
  } catch {
    return 'missing'
  }
  try {
    const lines = new Set((await readFile(join(bundleDir, '.env'), 'utf8')).split('\n').map((line) => line.trim()))
    for (const [key, value] of EXPECTED_ENVIRONMENT) {
      if (!lines.has(`${key}=${value(input)}`)) return 'invalid'
    }
    for (const path of [join(bundleDir, 'compose.yml'), join(bundleDir, 'searxng', 'settings.yml')]) {
      if (!(await stat(path)).isFile()) return 'invalid'
    }
    return 'valid'
  } catch {
    return 'invalid'
  }
}

/**
 * Collect the repair snapshot for a profile. Read-only: probing never mutates
 * state, Docker resources, or the profile. The state hash pins the snapshot to
 * exactly the state bytes the planner reasoned about.
 */
export async function inspectSnapshot(
  profile: string,
  dependencies: SnapshotDependencies,
  signal?: AbortSignal,
): Promise<DiagnosticSnapshot> {
  signal?.throwIfAborted()
  const environment = await dependencies.environment.resolve(profile)
  const state = await dependencies.state.read()
  const entry = state.profiles[profile]
  if (entry === undefined) throw invalidState(`Profile ${profile} has no recorded SearXNG attachment`)
  const interruptedOperation = await dependencies.journal.read()
  const managed = state.managed
  const expectedEndpoint = entry.mode === 'managed' && managed !== undefined ? managed.current.endpoint : entry.endpoint

  let docker: DiagnosticSnapshot['docker'] = 'healthy'
  let ownership: DiagnosticSnapshot['ownership'] = 'absent'
  let container: DiagnosticSnapshot['container'] = 'missing'
  let generatedAssets: DiagnosticSnapshot['generatedAssets'] = entry.mode === 'external' ? 'valid' : 'missing'
  let port: DiagnosticSnapshot['port'] = 'available'
  let composePath: string | undefined
  let probeEndpoint = true

  if (entry.mode === 'managed') {
    if (managed === undefined) throw invalidState('Managed deployment state is missing')
    try {
      await dependencies.docker.preflight(signal)
    } catch (error) {
      rethrowCancellation(error, signal)
      docker = 'offline'
      probeEndpoint = false
    }
    if (docker === 'healthy') {
      try {
        const status = await dependencies.docker.deploymentStatus(
          stateIdentity(environment.managedDir, state.homeId, managed.current),
          signal,
        )
        ownership = status.ownership
        container = status.container === 'absent' ? 'missing' : status.container
        composePath = status.composePath
        if (ownership === 'foreign') {
          // A reported-foreign deployment is not ours: the container value is
          // untrusted and its endpoint must not be probed as if it were.
          container = 'missing'
          probeEndpoint = false
        }
      } catch (error) {
        rethrowCancellation(error, signal)
        ownership = 'foreign'
        probeEndpoint = false
      }
    }
    generatedAssets = await (dependencies.probeAssets ?? fileAssetProbe)({
      stateDir: environment.managedDir,
      homeId: state.homeId,
      current: managed.current,
      ...(composePath === undefined ? {} : { composePath }),
    })
    if (docker === 'healthy') {
      if (container === 'running') {
        port = 'owned'
      } else {
        try {
          await dependencies.environment.preflightManaged(managed.current.port, signal)
          port = 'available'
        } catch (error) {
          rethrowCancellation(error, signal)
          port = error instanceof CliError && error.code === 'E_PORT_CONFLICT' ? 'foreign' : 'available'
        }
      }
    }
  }

  const { preview } = await observeAttachment(dependencies.profiles, profile, expectedEndpoint, signal)

  const endpointHealth: DiagnosticSnapshot['endpoint'] = probeEndpoint
    ? await probeEndpointHealth(dependencies.searxng, preview?.config ?? { baseURL: expectedEndpoint }, signal)
    : 'unreachable'

  const attached = preview !== undefined && preview.installed && preview.attached

  return {
    profile,
    expectedEndpoint,
    stateHash: stateSha256(state),
    mode: entry.mode,
    docker,
    ownership,
    container,
    generatedAssets,
    port,
    endpoint: endpointHealth,
    ...(attached ? {} : {
      profileEndpoint: {
        profile,
        expected: expectedEndpoint,
        ...(preview?.current !== undefined && preview.current.baseURL !== expectedEndpoint
          ? { actual: preview.current.baseURL }
          : {}),
      },
    }),
    ownedTemporaryResourceIds: [],
    ...(interruptedOperation === undefined ? {} : { interruptedOperation }),
  }
}

function normalized(error: unknown): CliError {
  if (error instanceof CliError) return error
  return new CliError('E_INTERNAL', 'A diagnostic check failed unexpectedly', 'Inspect the check and retry')
}

function invalidState(message: string): CliError {
  return new CliError('E_STATE_INVALID', message, 'Run dsh-searxng setup or repair the recorded attachment')
}

function resourceForeign(): CliError {
  return new CliError(
    'E_RESOURCE_FOREIGN',
    'A same-name Docker resource is not owned by this dsh-searxng installation',
    'Rename or remove the foreign resource, then retry',
  )
}

/**
 * Shared attachment observation used by both `diagnose` and `inspectSnapshot`.
 * `diagnose` previews the profile's recorded endpoint so doctor can report
 * attachment drift; `inspectSnapshot` previews the state-truth endpoint
 * (the managed deployment's) because repair plans against state. The preview
 * call, its error handling, and the effective-config derivation are one
 * pipeline so the two observers cannot drift.
 */
interface AttachmentObservation {
  preview?: ProfileAttachmentPreview
  previewError?: unknown
}

async function observeAttachment(
  profiles: ProfileManager,
  profile: string,
  endpoint: string,
  signal?: AbortSignal,
): Promise<AttachmentObservation> {
  let preview: ProfileAttachmentPreview | undefined
  let previewError: unknown
  try {
    preview = await profiles.preview(profile, endpoint, signal)
  } catch (error) {
    rethrowCancellation(error, signal)
    previewError = error
  }
  return {
    ...(preview === undefined ? {} : { preview }),
    ...(previewError === undefined ? {} : { previewError }),
  }
}

/**
 * Shared endpoint probe chain and classification. Doctor reports each stage
 * as its own check; the snapshot consumes the same chain through this
 * classifier so repair and doctor observe identical probe semantics.
 */
async function probeEndpointHealth(
  searxng: SearxngProbe,
  config: ProfileAttachmentConfig,
  signal?: AbortSignal,
): Promise<DiagnosticSnapshot['endpoint']> {
  try {
    await searxng.http(config, signal)
    await searxng.readiness({ ...config, attempts: 1, timeoutMs: 10_000 }, signal)
    await searxng.realSearch(config, signal)
    return 'healthy'
  } catch (error) {
    rethrowCancellation(error, signal)
    if (error instanceof CliError && error.code === 'E_AUTH_FAILED') return 'auth-failed'
    if (error instanceof CliError && error.code === 'E_TLS_FAILED') return 'tls-failed'
    return 'unreachable'
  }
}

/**
 * Shared end-to-end validation used by repair and update after a mutation:
 * the doctor-shaped HTTP/JSON/real-search/profile/provider chain, returning
 * the passing checks or throwing on the first failure. Both transactions
 * validate through this one pipeline so their post-mutation semantics can
 * never drift.
 */
export async function validateEndToEnd(
  profile: string,
  endpoint: string,
  dependencies: Pick<DiagnosticDependencies, 'profiles' | 'searxng'>,
  signal?: AbortSignal,
): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = []
  let preview: ProfileAttachmentPreview | undefined
  try {
    preview = await dependencies.profiles.preview(profile, endpoint, signal)
  } catch (error) {
    rethrowCancellation(error, signal)
    preview = undefined
  }
  const config = preview?.config ?? { baseURL: endpoint }
  // Cold-start gate first: Compose up returns before the service listens, so
  // post-mutation validation may run against a container that still refuses
  // connections. Readiness inherits setup's default retrying budget (no
  // attempts/timeout overrides) and waits for it; the single-shot checks
  // below then run against a warm service, reported in doctor's order.
  await dependencies.searxng.readiness(config, signal)
  await dependencies.searxng.http(config, signal)
  checks.push({ id: 'http', status: 'pass', message: 'SearXNG HTTP endpoint is reachable' })
  checks.push({ id: 'json', status: 'pass', message: 'SearXNG JSON API is enabled' })
  await dependencies.searxng.realSearch(config, signal)
  checks.push({ id: 'search', status: 'pass', message: 'SearXNG returned a real search result' })
  if (preview === undefined || !preview.installed || !preview.attached) {
    throw new CliError('E_SEARCH_FAILED', 'The DSH profile attachment is missing or outdated', 'Re-run dsh-searxng repair')
  }
  checks.push({ id: 'profile', status: 'pass', message: 'DSH profile has the expected managed attachment' })
  await dependencies.profiles.validate(
    profile,
    endpoint,
    async (validated) => { await dependencies.searxng.providerSearch(validated, signal) },
    signal,
  )
  checks.push({ id: 'provider', status: 'pass', message: 'DSH provider search returned a result' })
  return checks
}

export async function diagnose(
  profile: string,
  kind: 'status' | 'doctor',
  dependencies: DiagnosticDependencies,
  signal?: AbortSignal,
): Promise<DiagnosticResult> {
  const checks: DiagnosticCheck[] = []
  let blocked = false
  const record = async (id: string, message: string, operation: () => Promise<void>): Promise<void> => {
    if (blocked) {
      if (kind === 'doctor') checks.push({ id, status: 'skip', message: 'Skipped because a prerequisite failed' })
      return
    }
    try {
      signal?.throwIfAborted()
      await operation()
      checks.push({ id, status: 'pass', message })
    } catch (error) {
      signal?.throwIfAborted()
      const failure = normalized(error)
      checks.push({ id, status: 'fail', message: failure.message, error: failure.toJSON() })
      blocked = true
    }
  }

  let environment: Awaited<ReturnType<EnvironmentService['resolve']>> | undefined
  let state: Awaited<ReturnType<StateStore['read']>> | undefined
  let entry: Awaited<ReturnType<StateStore['read']>>['profiles'][string] | undefined
  await record('environment', 'Environment and attachment state are available', async () => {
    environment = await dependencies.environment.resolve(profile)
    await dependencies.environment.preflightDsh(signal)
    state = await dependencies.state.read()
    entry = state.profiles[profile]
    if (entry === undefined) throw invalidState(`Profile ${profile} has no recorded SearXNG attachment`)
  })
  if (blocked && kind === 'status') return { profile, healthy: false, checks }

  let preview: ProfileAttachmentPreview | undefined
  let previewError: unknown
  if (entry !== undefined) {
    const observation = await observeAttachment(dependencies.profiles, profile, entry.endpoint, signal)
    preview = observation.preview
    previewError = observation.previewError
  }

  let deployment: DockerDeploymentStatus | undefined
  if (entry?.mode === 'managed') {
    await record('docker', 'Docker and Compose are available', async () => { await dependencies.docker.preflight(signal) })
    if (blocked && kind === 'status') return { profile, mode: entry.mode, endpoint: entry.endpoint, healthy: false, checks }
    await record('ownership', 'Managed Docker resources have valid ownership labels', async () => {
      if (environment === undefined || state?.managed === undefined) throw invalidState('Managed deployment state is missing')
      deployment = await dependencies.docker.deploymentStatus(
        stateIdentity(environment.managedDir, state.homeId, state.managed.current),
        signal,
      )
      if (deployment.ownership === 'foreign') throw resourceForeign()
      if (deployment.ownership !== 'owned') throw invalidState('Managed Docker resources are absent')
    })
    if (blocked && kind === 'status') return { profile, mode: entry.mode, endpoint: entry.endpoint, healthy: false, checks }
    await record('container', 'Managed SearXNG container is running', async () => {
      if (deployment?.container !== 'running') throw invalidState('Managed SearXNG container is not running')
    })
  } else {
    for (const [id, message] of [
      ['docker', 'Skipped for an external SearXNG endpoint'],
      ['ownership', 'Skipped for an external SearXNG endpoint'],
      ['container', 'Skipped for an external SearXNG endpoint'],
    ] as const) checks.push({ id, status: 'skip', message })
  }

  const config = preview?.config ?? (entry === undefined ? undefined : { baseURL: entry.endpoint })
  await record('http', 'SearXNG HTTP endpoint is reachable', async () => {
    if (config === undefined) throw normalized(previewError)
    await dependencies.searxng.http(config, signal)
  })
  await record('json', 'SearXNG JSON API is enabled', async () => {
    if (config === undefined) throw normalized(previewError)
    await dependencies.searxng.readiness({ ...config, attempts: 1, timeoutMs: 10_000 }, signal)
  })
  await record('search', 'SearXNG returned a real search result', async () => {
    if (config === undefined) throw normalized(previewError)
    await dependencies.searxng.realSearch(config, signal)
  })
  await record('profile', 'DSH profile has the expected managed attachment', async () => {
    if (previewError !== undefined) throw previewError
    if (preview === undefined || !preview.installed || !preview.attached) throw invalidState('DSH profile attachment is missing or outdated')
  })
  await record('provider', 'DSH provider search returned a result', async () => {
    if (entry === undefined) throw invalidState('Profile attachment state is missing')
    await dependencies.profiles.validate(
      profile,
      entry.endpoint,
      async (validatedConfig) => { await dependencies.searxng.providerSearch(validatedConfig, signal) },
      signal,
    )
  })

  return {
    profile,
    ...(entry === undefined ? {} : { mode: entry.mode, endpoint: entry.endpoint }),
    healthy: !checks.some((check) => check.status === 'fail'),
    checks,
  }
}
