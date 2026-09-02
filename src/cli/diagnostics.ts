import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ManagedIdentity } from './assets.ts'
import type { DockerAdapter, DockerDeploymentStatus } from './docker.ts'
import { CliError } from './errors.ts'
import type { EnvironmentService } from './environment.ts'
import { stateSha256, type JournalStore, type OperationJournal } from './journal.ts'
import type { ProfileAttachmentPreview, ProfileManager } from './profile.ts'
import type { SearxngProbe } from './searxng.ts'
import type { DeploymentSnapshot, StateStore, StateV2 } from './state.ts'

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

function isAbortError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError'
}

function rethrowCancellation(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) signal.throwIfAborted()
  if (isAbortError(error)) throw error
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
  const bundleDir = input.current.configurationSha256 !== undefined
    ? join(input.stateDir, `config-${input.current.configurationSha256}`)
    : input.composePath === undefined ? undefined : dirname(input.composePath)
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
          identity(environment.managedDir, state.homeId, managed),
          signal,
        )
        ownership = status.ownership
        container = status.container === 'absent' ? 'missing' : status.container
        composePath = status.composePath
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

  let preview: ProfileAttachmentPreview | undefined
  try {
    preview = await dependencies.profiles.preview(profile, expectedEndpoint, signal)
  } catch {
    preview = undefined
  }

  let endpointHealth: DiagnosticSnapshot['endpoint'] = 'healthy'
  if (probeEndpoint) {
    const config = preview?.config ?? { baseURL: expectedEndpoint }
    try {
      await dependencies.searxng.http(config, signal)
      await dependencies.searxng.readiness({ ...config, attempts: 1, timeoutMs: 10_000 }, signal)
      await dependencies.searxng.realSearch(config, signal)
    } catch (error) {
      rethrowCancellation(error, signal)
      endpointHealth = error instanceof CliError && error.code === 'E_AUTH_FAILED' ? 'auth-failed' : 'unreachable'
    }
  } else {
    endpointHealth = 'unreachable'
  }

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
    ...(attached ? {} : { profileEndpoint: { profile, expected: expectedEndpoint } }),
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

function identity(
  managedDir: string,
  homeId: string,
  managed: NonNullable<Awaited<ReturnType<StateStore['read']>>['managed']>,
): ManagedIdentity {
  return {
    stateDir: managedDir,
    composePath: `${managedDir}/config-${'0'.repeat(64)}/compose.yml`,
    homeId,
    projectName: managed.current.projectName,
    containerName: managed.current.containerName,
  }
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
    try { preview = await dependencies.profiles.preview(profile, entry.endpoint, signal) } catch (error) { previewError = error }
  }

  let deployment: DockerDeploymentStatus | undefined
  if (entry?.mode === 'managed') {
    await record('docker', 'Docker and Compose are available', async () => { await dependencies.docker.preflight(signal) })
    if (blocked && kind === 'status') return { profile, mode: entry.mode, endpoint: entry.endpoint, healthy: false, checks }
    await record('ownership', 'Managed Docker resources have valid ownership labels', async () => {
      if (environment === undefined || state?.managed === undefined) throw invalidState('Managed deployment state is missing')
      deployment = await dependencies.docker.deploymentStatus(identity(environment.managedDir, state.homeId, state.managed), signal)
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
