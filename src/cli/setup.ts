import { randomBytes } from 'node:crypto'
import { SEARXNG_IMAGE, type AssetRenderer, type ManagedIdentity } from './assets.ts'
import type { DockerAdapter } from './docker.ts'
import { CliError } from './errors.ts'
import type { EnvironmentService, ResolvedEnvironment } from './environment.ts'
import { canonicalIdentity, healthyTimestamp, isAbort } from './managed.ts'
import type { ProfileManager } from './profile.ts'
import type { SearxngProbe } from './searxng.ts'
import type { DeploymentSnapshot, StateStore, StateV2 } from './state.ts'

export interface SetupDependencies {
  environment: EnvironmentService
  state: StateStore
  docker: DockerAdapter
  assets: AssetRenderer
  searxng: SearxngProbe
  profiles: ProfileManager
  now(): Date
}

export interface SetupInput { profile: string; port: number; portExplicit?: boolean; url?: string }
export interface SetupResult { profile: string; endpoint: string; reused: boolean }

interface SetupFactoryOptions { randomSecret?: () => string }

function setupFailed(): CliError {
  return new CliError('E_INTERNAL', 'Setup failed unexpectedly', 'Run dsh-searxng doctor and retry')
}

function inconsistentManagedDeployment(): CliError {
  return new CliError(
    'E_STATE_INVALID',
    'Managed deployment state does not match Docker resources',
    'Run dsh-searxng doctor and repair the managed deployment',
  )
}

function managedRecoveryFailed(): CliError {
  return new CliError(
    'E_STATE_INVALID',
    'Managed SearXNG is still unhealthy after restart',
    'Run dsh-searxng doctor and repair the managed deployment',
  )
}

function portMigrationRequired(): CliError {
  return new CliError(
    'E_STATE_INVALID',
    'The requested port differs from the existing managed deployment',
    'Run dsh-searxng doctor and use an explicit repair or migration workflow',
  )
}

function rollbackIncomplete(primary: unknown, rollbackFailures: readonly string[]): CliError {
  const inherited = primary instanceof CliError && Array.isArray(primary.details.rollbackFailures)
    ? primary.details.rollbackFailures.filter((value): value is string => typeof value === 'string')
    : []
  return new CliError(
    'E_INTERNAL',
    'Setup failed and rollback was incomplete',
    'Run dsh-searxng doctor and repair the managed deployment before retrying',
    {
      primaryError: primary instanceof CliError ? primary.code : isAbort(primary) ? 'abort' : 'internal',
      rollbackFailures: [...inherited, ...rollbackFailures],
    },
  )
}

function safeEndpoint(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new CliError('E_USAGE', 'The SearXNG endpoint is invalid', 'Use an absolute HTTP or HTTPS URL') }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new CliError(
      'E_USAGE',
      'The SearXNG endpoint must be a safe HTTP or HTTPS URL',
      'Remove credentials, query parameters, and fragments from the endpoint',
    )
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}

function healthyTimestampFor(dependencies: SetupDependencies): string {
  return healthyTimestamp(dependencies.now, setupFailed)
}

function isMatchingManagedState(
  managed: StateV2['managed'],
  homeId: string,
  identity: ManagedIdentity,
  endpoint: string,
  port: number,
): boolean {
  return managed !== undefined &&
    homeId === identity.homeId &&
    managed.current.deploymentVersion === 1 &&
    managed.current.image === SEARXNG_IMAGE &&
    managed.current.endpoint === endpoint &&
    managed.current.port === port &&
    managed.current.projectName === identity.projectName &&
    managed.current.containerName === identity.containerName
}

function managedState(
  previous: StateV2,
  input: SetupInput,
  endpoint: string,
  identity: ManagedIdentity,
  dependencies: SetupDependencies,
  configurationSha256?: string,
): StateV2 {
  const prior = previous.managed?.current
  const digest = configurationSha256 ?? prior?.configurationSha256
  const current: DeploymentSnapshot = {
    deploymentVersion: prior?.deploymentVersion ?? 1,
    image: SEARXNG_IMAGE,
    endpoint,
    port: input.port,
    projectName: identity.projectName,
    containerName: identity.containerName,
    ...(digest === undefined ? {} : { configurationSha256: digest }),
  }
  return {
    schemaVersion: 2,
    homeId: identity.homeId,
    managed: {
      current,
      lastHealthyAt: healthyTimestampFor(dependencies),
    },
    profiles: { ...previous.profiles, [input.profile]: { mode: 'managed', endpoint } },
  }
}

function externalState(previous: StateV2, input: SetupInput, endpoint: string): StateV2 {
  return {
    schemaVersion: 2,
    homeId: previous.homeId,
    ...(previous.managed === undefined ? {} : { managed: previous.managed }),
    profiles: { ...previous.profiles, [input.profile]: { mode: 'external', endpoint } },
  }
}

function profileStateMatches(previous: StateV2, input: SetupInput, endpoint: string, mode: 'managed' | 'external'): boolean {
  const current = previous.profiles[input.profile]
  return current?.mode === mode && current.endpoint === endpoint
}

async function withStateRestore(
  previous: StateV2,
  dependencies: SetupDependencies,
  operation: (write: (next: StateV2) => Promise<void>) => Promise<void>,
): Promise<void> {
  let stateWriteAttempted = false
  try {
    await operation(async (next) => {
      stateWriteAttempted = true
      await dependencies.state.write(next)
    })
  } catch (primary) {
    if (!stateWriteAttempted) throw primary
    try {
      await dependencies.state.write(previous)
    } catch {
      throw rollbackIncomplete(primary, ['state'])
    }
    throw primary
  }
}

async function attachAndCommit(
  input: SetupInput,
  endpoint: string,
  previous: StateV2,
  next: StateV2,
  dependencies: SetupDependencies,
  signal?: AbortSignal,
): Promise<void> {
  await withStateRestore(previous, dependencies, async (write) => {
    await dependencies.profiles.attach(
      input.profile,
      endpoint,
      async (config) => {
        await dependencies.searxng.providerSearch(config, signal)
        await write(next)
      },
      signal,
    )
  })
}

async function validateAndCommit(
  input: SetupInput,
  endpoint: string,
  previous: StateV2,
  next: StateV2,
  dependencies: SetupDependencies,
  signal?: AbortSignal,
): Promise<void> {
  await withStateRestore(previous, dependencies, async (write) => {
    await dependencies.profiles.validate(
      input.profile,
      endpoint,
      async (config) => {
        await dependencies.searxng.providerSearch(config, signal)
        await write(next)
      },
      signal,
    )
  })
}

async function cleanupCreatedDeployment(
  identity: ManagedIdentity,
  dependencies: SetupDependencies,
): Promise<string[]> {
  const failures: string[] = []
  let ownership: 'absent' | 'owned' | undefined
  try {
    ownership = await dependencies.docker.inspectOwnership(identity)
  } catch {
    failures.push('docker-ownership')
  }
  if (ownership === 'owned') {
    try { await dependencies.docker.down(identity, true) } catch { failures.push('docker') }
  }
  return failures
}

function isIncompleteRollback(error: unknown): error is CliError {
  return error instanceof CliError &&
    Array.isArray(error.details.rollbackFailures) &&
    error.details.rollbackFailures.length > 0
}

async function externalSetup(
  input: SetupInput,
  endpoint: string,
  previous: StateV2,
  dependencies: SetupDependencies,
  signal?: AbortSignal,
): Promise<SetupResult> {
  const preview = await dependencies.profiles.preview(input.profile, endpoint, signal)
  await dependencies.searxng.realSearch(preview.config, signal)
  if (preview.attached && profileStateMatches(previous, input, endpoint, 'external')) {
    await dependencies.profiles.validate(
      input.profile,
      endpoint,
      async (config) => { await dependencies.searxng.providerSearch(config, signal) },
      signal,
    )
    return { profile: input.profile, endpoint, reused: true }
  }
  const next = externalState(previous, input, endpoint)
  await attachAndCommit(input, endpoint, previous, next, dependencies, signal)
  return { profile: input.profile, endpoint, reused: false }
}

async function managedSetup(
  input: SetupInput,
  previous: StateV2,
  environment: ResolvedEnvironment,
  dependencies: SetupDependencies,
  randomSecret: () => string,
  signal?: AbortSignal,
): Promise<SetupResult> {
  const endpoint = `http://127.0.0.1:${input.port}`
  const placeholderIdentity = canonicalIdentity(environment.managedDir, environment.homeId)

  await dependencies.docker.preflight(signal)
  const ownership = await dependencies.docker.inspectOwnership(placeholderIdentity, signal)
  const hasState = previous.managed !== undefined
  const matching = hasState && ownership === 'owned' &&
    isMatchingManagedState(previous.managed, previous.homeId, placeholderIdentity, endpoint, input.port)

  if ((hasState && !matching) || (!hasState && ownership === 'owned')) {
    throw inconsistentManagedDeployment()
  }

  const preview = await dependencies.profiles.preview(input.profile, endpoint, signal)

  if (matching) {
    try {
      await dependencies.searxng.readiness(preview.config, signal)
    } catch (error) {
      if (isAbort(error, signal)) throw error
      if (!(error instanceof CliError) || error.code !== 'E_SEARXNG_START_TIMEOUT') throw error
      await dependencies.docker.restart(placeholderIdentity, signal)
      try {
        await dependencies.searxng.readiness(preview.config, signal)
      } catch (recoveryError) {
        if (isAbort(recoveryError, signal)) throw recoveryError
        if (recoveryError instanceof CliError && recoveryError.code !== 'E_SEARXNG_START_TIMEOUT') throw recoveryError
        throw managedRecoveryFailed()
      }
      try {
        await dependencies.searxng.realSearch(preview.config, signal)
      } catch (recoveryError) {
        if (isAbort(recoveryError, signal) || recoveryError instanceof CliError) throw recoveryError
        throw managedRecoveryFailed()
      }
      const next = managedState(previous, input, endpoint, placeholderIdentity, dependencies)
      await attachAndCommit(input, endpoint, previous, next, dependencies, signal)
      return { profile: input.profile, endpoint, reused: false }
    }

    await dependencies.searxng.realSearch(preview.config, signal)
    if (preview.attached && profileStateMatches(previous, input, endpoint, 'managed')) {
      await dependencies.profiles.validate(
        input.profile,
        endpoint,
        async (config) => { await dependencies.searxng.providerSearch(config, signal) },
        signal,
      )
      return { profile: input.profile, endpoint, reused: true }
    }
    const next = managedState(previous, input, endpoint, placeholderIdentity, dependencies)
    if (preview.attached) {
      await validateAndCommit(input, endpoint, previous, next, dependencies, signal)
    } else {
      await attachAndCommit(input, endpoint, previous, next, dependencies, signal)
    }
    return { profile: input.profile, endpoint, reused: true }
  }

  await dependencies.environment.preflightManaged(input.port, signal)
  const rendered = await dependencies.assets.render({
    stateDir: environment.managedDir,
    identity: placeholderIdentity,
    image: SEARXNG_IMAGE,
    port: input.port,
    secret: randomSecret(),
  })
  const identity = { ...placeholderIdentity, composePath: rendered.composePath }
  try {
    // From this point onward, any resources discovered under this identity may
    // only have been created by this first-setup transaction.
    await dependencies.docker.up(identity, signal)
    await dependencies.searxng.readiness(preview.config, signal)
    await dependencies.searxng.realSearch(preview.config, signal)
    const next = managedState(previous, input, endpoint, identity, dependencies, rendered.configurationSha256)
    await attachAndCommit(input, endpoint, previous, next, dependencies, signal)
    return { profile: input.profile, endpoint, reused: false }
  } catch (primary) {
    const cleanupFailures = await cleanupCreatedDeployment(identity, dependencies)
    if (cleanupFailures.length > 0) throw rollbackIncomplete(primary, cleanupFailures)
    throw primary
  }
}

export function createSetup(options: SetupFactoryOptions = {}) {
  const randomSecret = options.randomSecret ?? (() => randomBytes(32).toString('hex'))
  return async function setupUseCase(
    input: SetupInput,
    dependencies: SetupDependencies,
    signal?: AbortSignal,
  ): Promise<SetupResult> {
    try {
      return await dependencies.state.withLock(async () => {
        signal?.throwIfAborted()
        const environment = await dependencies.environment.resolve(input.profile)
        const previous = await dependencies.state.read()
        if (input.url !== undefined) {
          const endpoint = safeEndpoint(input.url)
          await dependencies.environment.preflightDsh(signal)
          return externalSetup(input, endpoint, previous, dependencies, signal)
        }
        const portExplicit = input.portExplicit ?? true
        let port = input.port
        if (previous.managed !== undefined) {
          if (!portExplicit) port = previous.managed.current.port
          else if (port !== previous.managed.current.port) throw portMigrationRequired()
        }
        await dependencies.environment.preflightDsh(signal)
        return managedSetup({ ...input, port }, previous, environment, dependencies, randomSecret, signal)
      })
    } catch (error) {
      if (isIncompleteRollback(error)) throw error
      if (signal?.aborted) signal.throwIfAborted()
      if (isAbort(error, signal)) throw error
      if (error instanceof CliError) throw error
      throw setupFailed()
    }
  }
}

export const setup: (
  input: SetupInput,
  dependencies: SetupDependencies,
  signal?: AbortSignal,
) => Promise<SetupResult> = createSetup()
