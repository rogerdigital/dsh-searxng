import type { ManagedIdentity } from './assets.ts'
import type { DockerAdapter, DockerDeploymentStatus } from './docker.ts'
import { CliError } from './errors.ts'
import type { EnvironmentService } from './environment.ts'
import type { ProfileAttachmentPreview, ProfileManager } from './profile.ts'
import type { SearxngProbe } from './searxng.ts'
import type { StateStore } from './state.ts'

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

function normalized(error: unknown): CliError {
  if (error instanceof CliError) return error
  return new CliError('E_INTERNAL', 'A diagnostic check failed unexpectedly', 'Inspect the check and retry')
}

function invalidState(message: string): CliError {
  return new CliError('E_STATE_INVALID', message, 'Run dsh-searxng setup or repair the recorded attachment')
}

function identity(managedDir: string, managed: NonNullable<Awaited<ReturnType<StateStore['read']>>['managed']>): ManagedIdentity {
  return {
    stateDir: managedDir,
    composePath: `${managedDir}/config-${'0'.repeat(64)}/compose.yml`,
    homeId: managed.homeId,
    projectName: managed.projectName,
    containerName: managed.containerName,
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
      deployment = await dependencies.docker.deploymentStatus(identity(environment.managedDir, state.managed), signal)
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
