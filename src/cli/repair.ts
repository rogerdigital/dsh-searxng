import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'
import type { AssetRenderer, ManagedIdentity } from './assets.ts'
import type { DockerAdapter } from './docker.ts'
import { CliError } from './errors.ts'
import type { EnvironmentService } from './environment.ts'
import { recommendRecovery, stateSha256, type JournalStore, type OperationJournal, type RecoveryRecommendation } from './journal.ts'
import type { ProfileAttachmentPreview, ProfileManager } from './profile.ts'
import type { SearxngProbe } from './searxng.ts'
import type { DeploymentSnapshot, StateStore, StateV2 } from './state.ts'
import type { DiagnosticSnapshot } from './diagnostics.ts'

export type RepairAction =
  | { type: 'restart-container' }
  | { type: 'render-assets'; preserveSecret: true }
  | { type: 'recreate-runtime'; preserveData: true }
  | { type: 'reattach-profile'; profile: string; endpoint: string }
  | { type: 'remove-owned-temporary'; resourceIds: string[] }

export interface RepairPlan {
  profile: string
  endpoint: string
  mode: 'managed' | 'external'
  /** Hash of the exact state bytes this plan was computed from; the executor refuses any other state. */
  stateHash: string
  actions: RepairAction[]
  summary: string[]
  /** Set when an interrupted operation is recorded: no ordinary actions, only the recovery direction (Task 4). */
  recovery?: RecoveryRecommendation
}

export interface RepairDependencies {
  environment: EnvironmentService
  state: StateStore
  journal: JournalStore
  docker: DockerAdapter
  assets: AssetRenderer
  searxng: SearxngProbe
  profiles: ProfileManager
  diagnose(profile: string): Promise<DiagnosticSnapshot>
  /** Reads the existing SearXNG secret from a configuration bundle; repair never generates a new one. */
  readPreservedSecret?(bundleDir: string): Promise<string>
  now(): Date
}

export interface RepairResult {
  actions: RepairAction[]
  healthy: true
}

function dockerOffline(): CliError {
  return new CliError('E_DOCKER_OFFLINE', 'The Docker daemon is unavailable', 'Start Docker Desktop or the Docker daemon, then retry')
}

function resourceForeign(): CliError {
  return new CliError(
    'E_RESOURCE_FOREIGN',
    'A same-name Docker resource is not owned by this dsh-searxng installation',
    'Rename or remove the foreign resource, then retry',
  )
}

function portConflict(): CliError {
  return new CliError(
    'E_PORT_CONFLICT',
    'The managed port is occupied by a foreign process',
    'Stop the process using the port or remove and re-create the deployment on a free port',
  )
}

function authFailed(): CliError {
  return new CliError('E_AUTH_FAILED', 'SearXNG authentication failed', 'Check the configured authorization header and retry')
}

function tlsFailed(): CliError {
  return new CliError('E_SEARCH_FAILED', 'SearXNG TLS validation failed', 'Check the endpoint certificate, then retry')
}

function externalEndpointFailed(): CliError {
  return new CliError(
    'E_SEARCH_FAILED',
    'The external SearXNG endpoint is unhealthy',
    'dsh-searxng repair never modifies external endpoints; fix the endpoint or run dsh-searxng setup --url',
  )
}

function interruptedOperation(recommendation: RecoveryRecommendation): CliError {
  return new CliError(
    'E_STATE_INVALID',
    `An interrupted operation is recorded in the journal: ${recommendation.summary}`,
    'Run dsh-searxng doctor and follow the interrupted-operation guidance',
  )
}

function stateChanged(): CliError {
  return new CliError(
    'E_STATE_INVALID',
    'Managed state changed while the repair was being planned',
    'Re-run dsh-searxng repair against the current state',
  )
}

function inconsistentState(message: string): CliError {
  return new CliError('E_STATE_INVALID', message, 'Run dsh-searxng doctor and repair the managed deployment')
}

function secretUnavailable(): CliError {
  return new CliError(
    'E_STATE_INVALID',
    'The managed SearXNG secret cannot be preserved because the configuration bundle is unreadable',
    'Run dsh-searxng setup to re-create the managed deployment',
  )
}

function validationFailed(error: unknown): CliError {
  return new CliError(
    'E_SEARCH_FAILED',
    'SearXNG validation failed after repair',
    'Run dsh-searxng doctor; the interrupted repair is recorded in the journal',
    { validationError: error instanceof CliError ? error.code : 'internal' },
  )
}

function repairFailed(): CliError {
  return new CliError('E_INTERNAL', 'Repair failed unexpectedly', 'Run dsh-searxng doctor and retry')
}

function removalUnavailable(): CliError {
  return new CliError(
    'E_INTERNAL',
    'This Docker adapter cannot remove owned temporary resources',
    'Run dsh-searxng doctor and remove the reported temporary resources manually',
  )
}

function describeAction(action: RepairAction): string {
  switch (action.type) {
    case 'restart-container': return 'Restart the managed SearXNG container'
    case 'render-assets': return 'Re-render the managed configuration with the existing secret'
    case 'recreate-runtime': return 'Recreate the managed runtime preserving cached data'
    case 'reattach-profile': return `Reattach profile ${action.profile} to ${action.endpoint}`
    case 'remove-owned-temporary': {
      const count = action.resourceIds.length
      return `Remove ${count} owned temporary Docker resource${count === 1 ? '' : 's'}`
    }
  }
}

function summarize(actions: RepairAction[]): string[] {
  return actions.length === 0 ? ['No repair actions required; validate current health'] : actions.map(describeAction)
}

/**
 * Pure planner: maps a diagnostic snapshot onto the closed repair-action
 * union. Blocking conditions (foreign resources, foreign port, Docker
 * offline, authentication or TLS failure, unhealthy external endpoint) throw
 * exactly one CliError and plan no mutations. An interrupted operation plans
 * no ordinary actions and surfaces the journal's recovery recommendation
 * instead; the rollback itself belongs to the update transaction (Task 4).
 */
export function planRepair(snapshot: DiagnosticSnapshot): RepairPlan {
  const base = {
    profile: snapshot.profile,
    endpoint: snapshot.expectedEndpoint,
    mode: snapshot.mode,
    stateHash: snapshot.stateHash,
  }
  if (snapshot.interruptedOperation !== undefined) {
    const recovery = recommendRecovery(snapshot.interruptedOperation)
    return { ...base, actions: [], summary: [recovery.summary], recovery }
  }
  if (snapshot.endpoint === 'auth-failed') throw authFailed()
  if (snapshot.endpoint === 'tls-failed') throw tlsFailed()
  if (snapshot.mode === 'external') {
    if (snapshot.endpoint !== 'healthy') throw externalEndpointFailed()
    const actions: RepairAction[] = snapshot.profileEndpoint === undefined
      ? []
      : [{ type: 'reattach-profile', profile: snapshot.profile, endpoint: snapshot.expectedEndpoint }]
    return { ...base, actions, summary: summarize(actions) }
  }

  if (snapshot.docker === 'offline') throw dockerOffline()
  if (snapshot.ownership === 'foreign') throw resourceForeign()
  if (snapshot.port === 'foreign') throw portConflict()

  const actions: RepairAction[] = []
  if (snapshot.generatedAssets !== 'valid') {
    actions.push({ type: 'render-assets', preserveSecret: true })
    actions.push({ type: 'recreate-runtime', preserveData: true })
  } else if (snapshot.container === 'missing') {
    actions.push({ type: 'recreate-runtime', preserveData: true })
  } else if (snapshot.container === 'stopped' || snapshot.endpoint === 'unreachable') {
    actions.push({ type: 'restart-container' })
  }
  if (snapshot.profileEndpoint !== undefined) {
    actions.push({ type: 'reattach-profile', profile: snapshot.profile, endpoint: snapshot.expectedEndpoint })
  }
  if (snapshot.ownedTemporaryResourceIds.length > 0) {
    actions.push({ type: 'remove-owned-temporary', resourceIds: [...snapshot.ownedTemporaryResourceIds] })
  }
  return { ...base, actions, summary: summarize(actions) }
}

function managedIdentity(managedDir: string, homeId: string, current: DeploymentSnapshot): ManagedIdentity {
  return {
    stateDir: managedDir,
    composePath: join(managedDir, `config-${'0'.repeat(64)}`, 'compose.yml'),
    homeId,
    projectName: current.projectName,
    containerName: current.containerName,
  }
}

function bundleDirectory(managedDir: string, current: DeploymentSnapshot, composePath?: string): string | undefined {
  if (current.configurationSha256 !== undefined) return join(managedDir, `config-${current.configurationSha256}`)
  return composePath === undefined ? undefined : dirname(composePath)
}

function bundleComposePath(managedDir: string, current: DeploymentSnapshot): string | undefined {
  return current.configurationSha256 === undefined
    ? undefined
    : join(managedDir, `config-${current.configurationSha256}`, 'compose.yml')
}

/**
 * Default secret preserver: reads `server.secret_key` from the existing
 * bundle; never invents one. An unreadable or tampered bundle fails closed
 * with E_STATE_INVALID instead of rotating the secret.
 */
export async function readPreservedSecretFromBundle(bundleDir: string): Promise<string> {
  let source: string
  try {
    source = await readFile(join(bundleDir, 'searxng', 'settings.yml'), 'utf8')
  } catch {
    throw secretUnavailable()
  }
  try {
    const settings = parse(source) as { server?: { secret_key?: unknown } } | null
    const secret = settings?.server?.secret_key
    if (typeof secret !== 'string' || secret.length === 0 || secret.includes('\0')) throw secretUnavailable()
    return secret
  } catch (error) {
    if (error instanceof CliError) throw error
    throw secretUnavailable()
  }
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true ||
    (error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError')
}

function healthyTimestamp(dependencies: RepairDependencies): string {
  const timestamp = dependencies.now().toISOString()
  if (Number.isNaN(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) throw repairFailed()
  return timestamp
}

function repairedState(
  state: StateV2,
  plan: RepairPlan,
  dependencies: RepairDependencies,
  renderedConfigurationSha256?: string,
): StateV2 {
  const timestamp = healthyTimestamp(dependencies)
  return {
    ...state,
    ...(plan.mode === 'managed' && state.managed !== undefined ? {
      managed: {
        ...state.managed,
        current: renderedConfigurationSha256 === undefined || state.managed.current.configurationSha256 === renderedConfigurationSha256
          ? state.managed.current
          : { ...state.managed.current, configurationSha256: renderedConfigurationSha256 },
        lastHealthyAt: timestamp,
      },
    } : {}),
    profiles: { ...state.profiles, [plan.profile]: { mode: plan.mode, endpoint: plan.endpoint } },
  }
}

async function validateRepaired(
  plan: RepairPlan,
  dependencies: RepairDependencies,
  signal?: AbortSignal,
): Promise<void> {
  let preview: ProfileAttachmentPreview | undefined
  try {
    preview = await dependencies.profiles.preview(plan.profile, plan.endpoint, signal)
  } catch {
    preview = undefined
  }
  const config = preview?.config ?? { baseURL: plan.endpoint }
  await dependencies.searxng.http(config, signal)
  await dependencies.searxng.readiness({ ...config, attempts: 1, timeoutMs: 10_000 }, signal)
  await dependencies.searxng.realSearch(config, signal)
  if (preview === undefined || !preview.installed || !preview.attached) {
    throw new CliError('E_SEARCH_FAILED', 'The DSH profile attachment is missing or outdated after repair', 'Re-run dsh-searxng repair')
  }
  await dependencies.profiles.validate(
    plan.profile,
    plan.endpoint,
    async (validated) => { await dependencies.searxng.providerSearch(validated, signal) },
    signal,
  )
}

interface ActionContext {
  dependencies: RepairDependencies
  state: StateV2
  managedDir: string
  identity: ManagedIdentity | undefined
  /** Compose path of a bundle rendered earlier in this plan, else the one inspected under the lock. */
  composePath: string | undefined
}

interface RenderedBundle {
  composePath: string
  configurationSha256: string
}

async function executeAction(
  action: RepairAction,
  context: ActionContext,
  signal?: AbortSignal,
): Promise<RenderedBundle | undefined> {
  const { dependencies, state, managedDir, identity, composePath } = context
  switch (action.type) {
    case 'restart-container': {
      if (identity === undefined) throw inconsistentState('Managed deployment state is missing')
      await dependencies.docker.restart(identity, signal)
      return undefined
    }
    case 'render-assets': {
      if (identity === undefined || state.managed === undefined) {
        throw inconsistentState('Managed deployment state is missing')
      }
      const bundleDir = bundleDirectory(managedDir, state.managed.current, composePath)
      if (bundleDir === undefined) throw secretUnavailable()
      const secret = await (dependencies.readPreservedSecret ?? readPreservedSecretFromBundle)(bundleDir)
      const rendered = await dependencies.assets.render({
        stateDir: identity.stateDir,
        identity,
        image: state.managed.current.image,
        port: state.managed.current.port,
        secret,
      })
      return rendered
    }
    case 'recreate-runtime': {
      if (identity === undefined || state.managed === undefined) {
        throw inconsistentState('Managed deployment state is missing')
      }
      const runtimeComposePath = composePath ?? bundleComposePath(managedDir, state.managed.current)
      if (runtimeComposePath === undefined) {
        throw inconsistentState('The managed Compose configuration cannot be located')
      }
      const runtime = { ...identity, composePath: runtimeComposePath }
      await dependencies.docker.down(runtime, false, signal)
      await dependencies.docker.up(runtime, signal)
      return undefined
    }
    case 'reattach-profile': {
      await dependencies.profiles.attach(
        action.profile,
        action.endpoint,
        async (config) => { await dependencies.searxng.providerSearch(config, signal) },
        signal,
      )
      return undefined
    }
    case 'remove-owned-temporary': {
      const remove = dependencies.docker.removeOwnedResource
      if (remove === undefined) throw removalUnavailable()
      for (const resourceId of action.resourceIds) {
        await remove.call(dependencies.docker, resourceId, signal)
      }
      return undefined
    }
  }
}

/**
 * Execute a pre-computed plan under the state lock: re-inspect ownership,
 * compare the plan's state hash, journal the operation, run only the closed
 * action union, validate HTTP/JSON/real-search/profile/provider checks, then
 * persist `lastHealthyAt` and clear the journal. Any failure leaves the
 * journal for recovery and never reports success. The caller (CLI) prints the
 * exact planned actions before invoking this function.
 */
export async function executeRepair(
  plan: RepairPlan,
  dependencies: RepairDependencies,
  signal?: AbortSignal,
): Promise<RepairResult> {
  try {
    return await dependencies.state.withLock(async () => {
      signal?.throwIfAborted()
      if (plan.recovery !== undefined) throw interruptedOperation(plan.recovery)

      const state = await dependencies.state.read()
      if (stateSha256(state) !== plan.stateHash) throw stateChanged()
      const interrupted: OperationJournal | undefined = await dependencies.journal.read()
      if (interrupted !== undefined) throw interruptedOperation(recommendRecovery(interrupted))

      const environment = await dependencies.environment.resolve(plan.profile)
      let identity: ManagedIdentity | undefined
      let inspectedComposePath: string | undefined
      if (plan.mode === 'managed') {
        const managed = state.managed
        if (managed === undefined) throw inconsistentState('Managed deployment state is missing')
        identity = managedIdentity(environment.managedDir, state.homeId, managed.current)
        await dependencies.docker.preflight(signal)
        inspectedComposePath = (await dependencies.docker.deploymentStatus(identity, signal)).composePath
      }

      const journal = await dependencies.journal.begin({
        kind: 'repair',
        phase: 'prepared',
        beforeStateSha256: plan.stateHash,
      })
      await dependencies.journal.transition(journal.id, 'mutating')

      let rendered: RenderedBundle | undefined
      for (const action of plan.actions) {
        signal?.throwIfAborted()
        const outcome = await executeAction(
          action,
          {
            dependencies,
            state,
            managedDir: environment.managedDir,
            identity,
            composePath: rendered === undefined ? inspectedComposePath : rendered.composePath,
          },
          signal,
        )
        if (outcome !== undefined) rendered = outcome
      }

      await dependencies.journal.transition(journal.id, 'validating')
      try {
        await validateRepaired(plan, dependencies, signal)
      } catch (error) {
        if (isAbort(error, signal)) throw error
        throw validationFailed(error)
      }

      const next = repairedState(state, plan, dependencies, rendered?.configurationSha256)
      await dependencies.state.write(next)
      await dependencies.journal.clear(journal.id)
      return { actions: plan.actions, healthy: true as const }
    })
  } catch (error) {
    if (error instanceof CliError) throw error
    if (signal?.aborted) signal.throwIfAborted()
    if (isAbort(error, signal)) throw error
    throw repairFailed()
  }
}
