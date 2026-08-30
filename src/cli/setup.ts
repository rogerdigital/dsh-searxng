import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { SEARXNG_IMAGE, type AssetRenderer, type ManagedIdentity } from './assets.ts'
import type { DockerAdapter } from './docker.ts'
import { CliError } from './errors.ts'
import type { EnvironmentService, ResolvedEnvironment } from './environment.ts'
import type { ProfileManager } from './profile.ts'
import type { SearxngProbe } from './searxng.ts'
import type { StateStore, StateV1 } from './state.ts'

export interface SetupDependencies {
  environment: EnvironmentService
  state: StateStore
  docker: DockerAdapter
  assets: AssetRenderer
  searxng: SearxngProbe
  profiles: ProfileManager
  now(): Date
}

export interface SetupInput { profile: string; port: number; url?: string }
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

function canonicalIdentity(environment: ResolvedEnvironment): ManagedIdentity {
  const name = `dsh-searxng-${environment.homeId}`
  return {
    stateDir: environment.managedDir,
    composePath: join(environment.managedDir, `config-${'0'.repeat(64)}`, 'compose.yml'),
    homeId: environment.homeId,
    projectName: name,
    containerName: name,
  }
}

function isMatchingManagedState(
  managed: StateV1['managed'],
  identity: ManagedIdentity,
  endpoint: string,
  port: number,
): managed is NonNullable<StateV1['managed']> {
  return managed !== undefined &&
    managed.deploymentVersion === 1 &&
    managed.image === SEARXNG_IMAGE &&
    managed.endpoint === endpoint &&
    managed.port === port &&
    managed.homeId === identity.homeId &&
    managed.projectName === identity.projectName &&
    managed.containerName === identity.containerName
}

function healthyTimestamp(dependencies: SetupDependencies): string {
  const timestamp = dependencies.now().toISOString()
  if (new Date(timestamp).toISOString() !== timestamp) throw setupFailed()
  return timestamp
}

function managedState(
  previous: StateV1,
  input: SetupInput,
  endpoint: string,
  identity: ManagedIdentity,
  dependencies: SetupDependencies,
): StateV1 {
  return {
    schemaVersion: 1,
    managed: {
      deploymentVersion: 1,
      image: SEARXNG_IMAGE,
      endpoint,
      port: input.port,
      homeId: identity.homeId,
      projectName: identity.projectName,
      containerName: identity.containerName,
      lastHealthyAt: healthyTimestamp(dependencies),
    },
    profiles: { ...previous.profiles, [input.profile]: { mode: 'managed', endpoint } },
  }
}

function externalState(previous: StateV1, input: SetupInput, endpoint: string): StateV1 {
  return {
    schemaVersion: 1,
    ...(previous.managed === undefined ? {} : { managed: previous.managed }),
    profiles: { ...previous.profiles, [input.profile]: { mode: 'external', endpoint } },
  }
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true ||
    (error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError')
}

async function externalSetup(
  input: SetupInput,
  endpoint: string,
  previous: StateV1,
  dependencies: SetupDependencies,
  signal?: AbortSignal,
): Promise<SetupResult> {
  await dependencies.searxng.realSearch({ baseURL: endpoint }, signal)
  await dependencies.profiles.attach(
    input.profile,
    endpoint,
    async () => { await dependencies.searxng.providerSearch({ baseURL: endpoint }, signal) },
    signal,
  )
  await dependencies.state.write(externalState(previous, input, endpoint))
  return { profile: input.profile, endpoint, reused: false }
}

async function managedSetup(
  input: SetupInput,
  previous: StateV1,
  environment: ResolvedEnvironment,
  dependencies: SetupDependencies,
  randomSecret: () => string,
  signal?: AbortSignal,
): Promise<SetupResult> {
  const endpoint = `http://127.0.0.1:${input.port}`
  const placeholderIdentity = canonicalIdentity(environment)

  await dependencies.docker.preflight(signal)
  const ownership = await dependencies.docker.inspectOwnership(placeholderIdentity, signal)
  const hasState = previous.managed !== undefined
  const matching = hasState && ownership === 'owned' &&
    isMatchingManagedState(previous.managed, placeholderIdentity, endpoint, input.port)

  if ((hasState && !matching) || (!hasState && ownership === 'owned')) {
    throw inconsistentManagedDeployment()
  }

  if (matching) {
    let healthy = false
    try {
      await dependencies.searxng.readiness({ baseURL: endpoint }, signal)
      await dependencies.searxng.realSearch({ baseURL: endpoint }, signal)
      healthy = true
    } catch (error) {
      if (isAbort(error, signal)) throw error
    }
    if (healthy) {
      await dependencies.profiles.attach(
        input.profile,
        endpoint,
        async () => { await dependencies.searxng.providerSearch({ baseURL: endpoint }, signal) },
        signal,
      )
      await dependencies.state.write(managedState(previous, input, endpoint, placeholderIdentity, dependencies))
      return { profile: input.profile, endpoint, reused: true }
    }

    await dependencies.docker.restart(placeholderIdentity, signal)
    try {
      await dependencies.searxng.readiness({ baseURL: endpoint }, signal)
      await dependencies.searxng.realSearch({ baseURL: endpoint }, signal)
    } catch (error) {
      if (isAbort(error, signal)) throw error
      throw managedRecoveryFailed()
    }
    await dependencies.profiles.attach(
      input.profile,
      endpoint,
      async () => { await dependencies.searxng.providerSearch({ baseURL: endpoint }, signal) },
      signal,
    )
    await dependencies.state.write(managedState(previous, input, endpoint, placeholderIdentity, dependencies))
    return { profile: input.profile, endpoint, reused: false }
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
  await dependencies.docker.up(identity, signal)
  await dependencies.searxng.readiness({ baseURL: endpoint }, signal)
  await dependencies.searxng.realSearch({ baseURL: endpoint }, signal)
  await dependencies.profiles.attach(
    input.profile,
    endpoint,
    async () => { await dependencies.searxng.providerSearch({ baseURL: endpoint }, signal) },
    signal,
  )
  await dependencies.state.write(managedState(previous, input, endpoint, identity, dependencies))
  return { profile: input.profile, endpoint, reused: false }
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
          return externalSetup(input, safeEndpoint(input.url), previous, dependencies, signal)
        }
        return managedSetup(input, previous, environment, dependencies, randomSecret, signal)
      })
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted()
      if (error instanceof CliError || isAbort(error, signal)) throw error
      throw setupFailed()
    }
  }
}

export const setup: (
  input: SetupInput,
  dependencies: SetupDependencies,
  signal?: AbortSignal,
) => Promise<SetupResult> = createSetup()
