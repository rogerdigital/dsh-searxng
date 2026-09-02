import { lstat, readFile, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parse } from 'yaml'
import type { AssetRenderer, ManagedIdentity } from './assets.ts'
import { selectDeployment, type DeploymentDefinition } from './deployments.ts'
import type { DockerAdapter, DockerDeploymentStatus } from './docker.ts'
import { CliError } from './errors.ts'
import type { EnvironmentService } from './environment.ts'
import { validateEndToEnd } from './diagnostics.ts'
import { recommendRecovery, stateSha256, type JournalStore, type OperationJournal, type RecoveryRecommendation } from './journal.ts'
import {
  bundleComposePath,
  bundleDirectory,
  canonicalIdentity,
  healthyTimestamp,
  isAbort,
  isConfigBundleName,
  isStagingDirectoryName,
  rethrowCancellation,
  stateIdentity,
} from './managed.ts'
import type { ProfileManager } from './profile.ts'
import type { SearxngProbe } from './searxng.ts'
import type { DeploymentSnapshot, StateStore, StateV2 } from './state.ts'
import type { DiagnosticCheck, DiagnosticSnapshot } from './diagnostics.ts'

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

/**
 * Read-only dependencies shared by ordinary repair and crash recovery. The
 * journal is read fresh from disk; nothing is carried over in memory.
 */
export interface RecoveryDependencies {
  environment: EnvironmentService
  state: StateStore
  journal: JournalStore
  docker: DockerAdapter
  searxng: SearxngProbe
  profiles: ProfileManager
  /** Packaged deployment catalog; when provided, commit decisions are cross-checked against it. */
  catalog?: readonly DeploymentDefinition[]
  now(): Date
}

export interface RepairDependencies extends RecoveryDependencies {
  assets: AssetRenderer
  diagnose(profile: string): Promise<DiagnosticSnapshot>
  /** Reads the existing SearXNG secret from a configuration bundle; repair never generates a new one. */
  readPreservedSecret?(bundleDir: string): Promise<string>
}

/**
 * Recovery decision for an interrupted operation, computed from on-disk state,
 * configuration hashes, image existence, and ownership — never from the
 * journal alone. `blocked` carries the CliError the operator must act on.
 */
export type RecoveryDecision =
  | { type: 'clear-prepared' }
  | { type: 'validate-target'; target: DeploymentSnapshot }
  | { type: 'resume-rollback'; previous: DeploymentSnapshot }
  | { type: 'blocked'; error: CliError }

export interface RecoveryPlan {
  profile: string
  journal: OperationJournal
  /** Hash of the exact state bytes the decision was computed from; the executor refuses any other state. */
  stateHash: string
  endpoint: string
  ageMs: number
  decision: RecoveryDecision
  /** Stale state lock observed during planning; only the executor may remove it. */
  staleLock?: { pid: number }
  summary: string[]
}

export interface RecoveryOutcome {
  decision: 'clear-prepared' | 'validate-target' | 'resume-rollback'
  outcome: 'journal-cleared' | 'target-committed' | 'target-rolled-back' | 'rollback-completed'
  checks: DiagnosticCheck[]
}

export interface RepairResult {
  actions: RepairAction[]
  /** Validating-phase outcomes with the same shape and redaction as doctor checks. */
  checks: DiagnosticCheck[]
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
  return new CliError('E_TLS_FAILED', 'SearXNG TLS validation failed', 'Check the endpoint certificate, then retry')
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

function unsafeBundleRemoval(): CliError {
  return new CliError(
    'E_STATE_INVALID',
    'The damaged managed configuration bundle cannot be rebuilt safely',
    'Run dsh-searxng doctor and repair the managed configuration directory',
  )
}

/**
 * Remove exactly the recorded configuration bundle directory so the
 * content-addressed renderer can rebuild a damaged same-digest bundle. The
 * removal is ownership-bounded like remove.ts: only a direct `config-<sha256>`
 * child of the managed directory, never a symlink or any path outside it.
 */
export async function removeBundleForRebuild(managedDir: string, bundleDir: string): Promise<void> {
  if (dirname(bundleDir) !== managedDir || !isConfigBundleName(basename(bundleDir))) {
    throw unsafeBundleRemoval()
  }
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(bundleDir)
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return
    throw unsafeBundleRemoval()
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw unsafeBundleRemoval()
  try {
    await rm(bundleDir, { recursive: true })
  } catch {
    throw unsafeBundleRemoval()
  }
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

function recoveryFailed(): CliError {
  return new CliError('E_INTERNAL', 'Recovery failed unexpectedly', 'Run dsh-searxng doctor and retry')
}

function recoveryConflicted(): CliError {
  return new CliError(
    'E_STATE_INVALID',
    'The journal or managed state changed while the recovery was being planned',
    'Re-run dsh-searxng repair against the current state',
  )
}

function recoveryStateMismatch(): CliError {
  return new CliError(
    'E_STATE_INVALID',
    'The managed state does not match the state recorded before the interrupted operation',
    'Run dsh-searxng doctor --json and inspect the interrupted operation before re-running dsh-searxng repair',
  )
}

function recoveryIncomplete(error: unknown): CliError {
  return new CliError(
    'E_INTERNAL',
    'The interrupted operation could not be recovered',
    'Run dsh-searxng doctor --json and follow the interrupted-operation guidance',
    { recoveryError: error instanceof CliError ? error.code : isAbort(error) ? 'abort' : 'internal' },
  )
}

/**
 * Conservative matrix for non-update kinds: this plan's verified recovery
 * paths are for updates. A prepared journal whose state is untouched cleared
 * trivially; anything further along blocks with clean-up guidance because
 * setup, remove, and repair have no journal-recorded rollback target.
 */
function nonUpdateInterrupted(journal: OperationJournal): CliError {
  return new CliError(
    'E_STATE_INVALID',
    `An interrupted ${journal.kind} operation is recorded in phase ${journal.phase}; automatic recovery only supports updates`,
    'Run dsh-searxng doctor --json, then remove the deployment with dsh-searxng remove --service and re-create it with dsh-searxng setup',
  )
}

function recoveryProfileUnattached(profile: string, managedProfile: string | undefined): CliError {
  return new CliError(
    'E_STATE_INVALID',
    `Profile ${profile} is not attached to the managed deployment`,
    managedProfile === undefined
      ? 'Re-run dsh-searxng repair with a profile attached to the managed deployment'
      : `Re-run dsh-searxng repair with --profile ${managedProfile}`,
  )
}

function previousBundleMissing(): CliError {
  return new CliError(
    'E_STATE_INVALID',
    'The recorded previous configuration bundle is missing',
    'Run dsh-searxng doctor --json; the deployment must be re-created with dsh-searxng remove --service and dsh-searxng setup',
  )
}

function liveLock(): CliError {
  return new CliError(
    'E_STATE_INVALID',
    'The state lock is held by a running process',
    'Wait for the other dsh-searxng operation to finish, then re-run dsh-searxng repair',
  )
}

function unverifiableLock(): CliError {
  return new CliError(
    'E_STATE_INVALID',
    'The state lock cannot be verified',
    'Inspect the state.lock file in the managed directory and remove it manually once no dsh-searxng operation is running',
  )
}

function staleLockRemovalFailed(): CliError {
  return new CliError(
    'E_INTERNAL',
    'The stale state lock could not be removed',
    'Inspect the state.lock file in the managed directory and remove it manually, then re-run dsh-searxng repair',
  )
}

function unsafeTemporaryRemoval(): CliError {
  return new CliError(
    'E_STATE_INVALID',
    'The orphaned staging directory cannot be removed safely',
    'Run dsh-searxng doctor and remove the reported temporary directories manually',
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
      return `Remove ${count} orphaned staging director${count === 1 ? 'y' : 'ies'} left by an interrupted render`
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

function managedIdentity(managedDir: string, homeId: string, current: Parameters<typeof stateIdentity>[2]): ManagedIdentity {
  return stateIdentity(managedDir, homeId, current)
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

function repairedState(
  state: StateV2,
  plan: RepairPlan,
  dependencies: RepairDependencies,
  renderedConfigurationSha256?: string,
): StateV2 {
  const timestamp = healthyTimestamp(dependencies.now, repairFailed)
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
): Promise<DiagnosticCheck[]> {
  return validateEndToEnd(plan.profile, plan.endpoint, dependencies, signal)
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
      const input = {
        stateDir: identity.stateDir,
        identity,
        image: state.managed.current.image,
        port: state.managed.current.port,
        secret,
        deploymentVersion: state.managed.current.deploymentVersion,
      }
      try {
        return await dependencies.assets.render(input)
      } catch (error) {
        // Rebuild only on the renderer's dedicated damage signal: a damaged
        // same-digest bundle must be removed and re-rendered with the
        // preserved secret. Any other failure (including generic invalid
        // state) propagates so a non-damage error can never delete a healthy
        // bundle and lose the secret.
        if (!(error instanceof CliError) || error.code !== 'E_BUNDLE_DAMAGED') throw error
        await removeBundleForRebuild(managedDir, bundleDir)
        return await dependencies.assets.render(input)
      }
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
      for (const resourceId of action.resourceIds) {
        await removeOrphanedStagingDirectory(managedDir, resourceId)
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
        const status = await dependencies.docker.deploymentStatus(identity, signal)
        // Ownership gate (security contract): the executor may only mutate
        // resources this installation owns. The production adapter throws
        // E_RESOURCE_FOREIGN during inspection; an adapter that instead
        // reports 'foreign' is refused here explicitly so the gate is visible
        // at the call site rather than implicit in the adapter's throw.
        // 'absent' is legitimate: it is exactly what a recreate-runtime plan
        // repairs from the recorded bundle.
        if (status.ownership === 'foreign') throw resourceForeign()
        inspectedComposePath = status.composePath
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
      let checks: DiagnosticCheck[]
      try {
        checks = await validateRepaired(plan, dependencies, signal)
      } catch (error) {
        if (isAbort(error, signal)) throw error
        throw validationFailed(error)
      }

      const next = repairedState(state, plan, dependencies, rendered?.configurationSha256)
      await dependencies.state.write(next)
      await dependencies.journal.clear(journal.id)
      return { actions: plan.actions, checks, healthy: true as const }
    })
  } catch (error) {
    if (error instanceof CliError) throw error
    if (signal?.aborted) signal.throwIfAborted()
    if (isAbort(error, signal)) throw error
    throw repairFailed()
  }
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

/**
 * Remove exactly an orphaned renderer staging directory, with the same
 * ownership-bounded discipline as removeBundleForRebuild: only a direct
 * `.staging-<pid>-<hex>` child of the managed directory, never a symlink and
 * never any path outside it.
 */
async function removeOrphanedStagingDirectory(managedDir: string, name: string): Promise<void> {
  if (!isStagingDirectoryName(name) || dirname(join(managedDir, name)) !== managedDir) throw unsafeTemporaryRemoval()
  const path = join(managedDir, name)
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    throw unsafeTemporaryRemoval()
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw unsafeTemporaryRemoval()
  try {
    await rm(path, { recursive: true })
  } catch {
    throw unsafeTemporaryRemoval()
  }
}

/**
 * process.kill(pid, 0) semantics: ESRCH means the process is gone, EPERM
 * means it exists under another UID. Works the same way on Windows for this
 * purpose. Dependency-free on purpose.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    return errorCode(error) !== 'ESRCH'
  }
  return true
}

type StateLockObservation =
  | { kind: 'absent' }
  | { kind: 'live' }
  | { kind: 'unverifiable' }
  | { kind: 'stale'; pid: number }

async function inspectStateLock(managedDir: string): Promise<StateLockObservation> {
  let source: string
  try {
    source = await readFile(join(managedDir, 'state.lock'), 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'absent' }
    return { kind: 'unverifiable' }
  }
  let pid: unknown
  try {
    pid = (JSON.parse(source) as { pid?: unknown }).pid
  } catch {
    return { kind: 'unverifiable' }
  }
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) return { kind: 'unverifiable' }
  return isProcessAlive(pid) ? { kind: 'live' } : { kind: 'stale', pid }
}

/** Configuration digest carried by a content-addressed bundle path, when the shape matches. */
function digestFromComposePath(composePath: string | undefined): string | undefined {
  if (composePath === undefined) return undefined
  const bundle = basename(dirname(composePath))
  return isConfigBundleName(bundle) ? bundle.slice('config-'.length) : undefined
}

async function isExistingFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

interface DeploymentObservation {
  reachable: boolean
  status?: DockerDeploymentStatus
  foreignError?: CliError
}

/** Best-effort Docker observation: offline daemons degrade, foreign resources block. */
async function observeDeployment(
  dependencies: RecoveryDependencies,
  identity: ManagedIdentity,
  signal?: AbortSignal,
): Promise<DeploymentObservation> {
  try {
    await dependencies.docker.preflight(signal)
  } catch (error) {
    rethrowCancellation(error, signal)
    return { reachable: false }
  }
  try {
    const status = await dependencies.docker.deploymentStatus(identity, signal)
    if (status.ownership === 'foreign') return { reachable: true, status, foreignError: resourceForeign() }
    return { reachable: true, status }
  } catch (error) {
    rethrowCancellation(error, signal)
    if (error instanceof CliError && error.code === 'E_RESOURCE_FOREIGN') return { reachable: true, foreignError: error }
    return { reachable: false }
  }
}

/**
 * Cross-check an update target against the packaged catalog before it may be
 * committed as current state. Catalog misses and damaged catalogs both map to
 * reinstall guidance instead of dead-ending recovery.
 */
function crossCheckCatalog(
  dependencies: RecoveryDependencies,
  stateSchema: number,
  target: { deploymentVersion: number; image: string },
): CliError | undefined {
  if (dependencies.catalog === undefined) return undefined
  try {
    const definition = selectDeployment(dependencies.catalog, stateSchema, target.deploymentVersion)
    if (definition.image === target.image) return undefined
    return new CliError(
      'E_DEPLOYMENT_UNSUPPORTED',
      `The packaged deployment version ${target.deploymentVersion} no longer matches the interrupted update target`,
      'Reinstall dsh-searxng and retry',
      { deploymentVersion: target.deploymentVersion },
    )
  } catch (error) {
    if (error instanceof CliError && (error.code === 'E_DEPLOYMENT_UNSUPPORTED' || error.code === 'E_INTERNAL')) {
      return new CliError(error.code, error.message, 'Reinstall dsh-searxng and retry', { catalogError: error.code })
    }
    throw error
  }
}

/**
 * Compute the recovery decision for an interrupted operation from the world on
 * disk: fresh state bytes, the recorded before-state hash, live Docker
 * ownership, bundle directories, the local image store, and (for commits) the
 * packaged catalog. The journal's phase orders what the interrupted process
 * had and had not done; everything else must be re-derived and must agree.
 */
async function classifyRecovery(
  profile: string,
  journal: OperationJournal,
  dependencies: RecoveryDependencies,
  environment: Awaited<ReturnType<EnvironmentService['resolve']>>,
  state: StateV2,
  signal?: AbortSignal,
): Promise<RecoveryDecision> {
  const stateHash = stateSha256(state)
  const hashMatches = stateHash === journal.beforeStateSha256
  const managed = state.managed

  if (journal.kind !== 'update') {
    if (journal.phase !== 'prepared' || !hashMatches) {
      return { type: 'blocked', error: nonUpdateInterrupted(journal) }
    }
    const identity = managed === undefined
      ? canonicalIdentity(environment.managedDir, state.homeId)
      : stateIdentity(environment.managedDir, state.homeId, managed.current)
    const observation = await observeDeployment(dependencies, identity, signal)
    if (observation.foreignError !== undefined) return { type: 'blocked', error: observation.foreignError }
    return { type: 'clear-prepared' }
  }

  if (journal.target === undefined) {
    return { type: 'blocked', error: inconsistentState('The interrupted update journal has no recorded target') }
  }
  if (managed === undefined) {
    return { type: 'blocked', error: inconsistentState('Managed deployment state is missing') }
  }
  if (state.profiles[profile]?.mode !== 'managed') {
    const managedProfile = Object.entries(state.profiles)
      .find(([, value]) => value.mode === 'managed')?.[0]
    return { type: 'blocked', error: recoveryProfileUnattached(profile, managedProfile) }
  }
  const target = journal.target

  const observation = await observeDeployment(
    dependencies,
    stateIdentity(environment.managedDir, state.homeId, managed.current),
    signal,
  )
  if (observation.foreignError !== undefined) return { type: 'blocked', error: observation.foreignError }

  switch (journal.phase) {
    case 'prepared': {
      // The update transaction pulls its image before the first mutation; a
      // crash at prepared has touched no managed resource. Docker being
      // offline proves nothing either way, so only the state hash gates.
      if (!hashMatches) return { type: 'blocked', error: recoveryStateMismatch() }
      return { type: 'clear-prepared' }
    }
    case 'mutating':
    case 'rolling-back': {
      if (!hashMatches) return { type: 'blocked', error: recoveryStateMismatch() }
      if (!observation.reachable) return { type: 'blocked', error: dockerOffline() }
      const previous = managed.current
      const previousCompose = bundleComposePath(environment.managedDir, previous)
      if (previousCompose === undefined || !(await isExistingFile(previousCompose))) {
        return { type: 'blocked', error: previousBundleMissing() }
      }
      return { type: 'resume-rollback', previous }
    }
    case 'validating': {
      if (hashMatches) {
        const catalogError = crossCheckCatalog(dependencies, state.schemaVersion, target)
        if (catalogError !== undefined) return { type: 'blocked', error: catalogError }
        // State was never committed: the runtime is the target, and its live
        // Compose label is the only trustworthy source for the staged digest.
        const base = managed.current
        const digest = digestFromComposePath(observation.status?.composePath)
        const reconstructed: DeploymentSnapshot = {
          deploymentVersion: target.deploymentVersion,
          image: target.image,
          endpoint: base.endpoint,
          port: base.port,
          projectName: base.projectName,
          containerName: base.containerName,
          ...(digest === undefined ? {} : { configurationSha256: digest }),
        }
        return { type: 'validate-target', target: reconstructed }
      }
      // Post-commit crash window: the state write committed but the journal
      // clear did not. Current state matching the target is the proof; any
      // other mismatch blocks. The catalog is deliberately NOT cross-checked
      // here, unlike the uncommitted branch above: the interrupted update
      // already committed this target before the crash, so recovery only
      // ratifies on-disk reality — blocking could not un-commit it, it would
      // just dead-end the journal clear. A committed target the current
      // package no longer ships remains operable (repair and rollback work
      // from state) and the next update converges to a packaged version.
      const current = managed.current
      if (current.deploymentVersion === target.deploymentVersion && current.image === target.image) {
        return { type: 'validate-target', target: current }
      }
      return { type: 'blocked', error: recoveryStateMismatch() }
    }
  }
}

function summarizeRecovery(journal: OperationJournal, decision: RecoveryDecision, lock: StateLockObservation): string[] {
  const lines: string[] = []
  if (lock.kind === 'stale') lines.push(`Remove the stale state lock left by dead process ${String(lock.pid)}`)
  switch (decision.type) {
    case 'clear-prepared':
      lines.push('No managed resources were mutated; clear the journal')
      break
    case 'validate-target':
      lines.push(`Validate the target deployment (version ${String(decision.target.deploymentVersion)}) and commit it, or roll back to the previous deployment`)
      break
    case 'resume-rollback':
      lines.push(`Roll back to the previous deployment (version ${String(decision.previous.deploymentVersion)}) and validate it`)
      break
    case 'blocked':
      lines.push(decision.error.message)
      break
  }
  return lines
}

/**
 * Plan the recovery of an interrupted operation. Read-only: nothing is
 * mutated, no lock is taken. A live state lock blocks outright; a provably
 * stale one is recorded for the executor to remove after this inspection.
 */
export async function planRecovery(
  profile: string,
  journal: OperationJournal,
  dependencies: RecoveryDependencies,
  signal?: AbortSignal,
): Promise<RecoveryPlan> {
  signal?.throwIfAborted()
  const environment = await dependencies.environment.resolve(profile)
  const state = await dependencies.state.read()
  const stateHash = stateSha256(state)
  const recordedEndpoint = state.profiles[profile]?.endpoint ?? state.managed?.current.endpoint ?? ''
  const ageMs = Math.max(0, dependencies.now().getTime() - Date.parse(journal.startedAt))
  const lock = await inspectStateLock(environment.managedDir)

  const lockDecision = lock.kind === 'live'
    ? liveLock()
    : lock.kind === 'unverifiable'
      ? unverifiableLock()
      : undefined
  if (lockDecision !== undefined) {
    const decision: RecoveryDecision = { type: 'blocked', error: lockDecision }
    return { profile, journal, stateHash, endpoint: recordedEndpoint, ageMs, decision, summary: summarizeRecovery(journal, decision, lock) }
  }

  const decision = await classifyRecovery(profile, journal, dependencies, environment, state, signal)
  const endpoint = decision.type === 'validate-target'
    ? decision.target.endpoint
    : decision.type === 'resume-rollback'
      ? decision.previous.endpoint
      : recordedEndpoint
  return {
    profile,
    journal,
    stateHash,
    endpoint,
    ageMs,
    decision,
    ...(lock.kind === 'stale' ? { staleLock: { pid: lock.pid } } : {}),
    summary: summarizeRecovery(journal, decision, lock),
  }
}

/**
 * Restore the previous deployment on the live runtime: bring the active
 * project down (its Compose path from the running container's label, else the
 * recorded bundles), ensure the previous image is present locally through
 * imageExists before up, and validate the restore end to end. Detached from
 * the caller's cancellation, like the update transaction's own rollback: once
 * begun, restoring the service must not be abortable.
 */
async function restorePreviousDeployment(
  plan: RecoveryPlan,
  dependencies: RecoveryDependencies,
  state: StateV2,
  previous: DeploymentSnapshot,
  target: DeploymentSnapshot | undefined,
): Promise<DiagnosticCheck[]> {
  const managed = state.managed
  if (managed === undefined) throw inconsistentState('Managed deployment state is missing')
  const environment = await dependencies.environment.resolve(plan.profile)
  const identity = stateIdentity(environment.managedDir, state.homeId, managed.current)
  await dependencies.docker.preflight()
  const status = await dependencies.docker.deploymentStatus(identity)
  if (status.ownership === 'foreign') throw resourceForeign()
  const activeCompose = status.composePath ??
    (target === undefined ? undefined : bundleComposePath(environment.managedDir, target)) ??
    bundleComposePath(environment.managedDir, managed.current)
  if (activeCompose === undefined) throw inconsistentState('The managed Compose configuration cannot be located')
  await dependencies.docker.down({ ...identity, composePath: activeCompose }, false, undefined)
  const previousCompose = bundleComposePath(environment.managedDir, previous)
  if (previousCompose === undefined) throw inconsistentState('The previous Compose configuration cannot be located')
  if (!(await dependencies.docker.imageExists(previous.image))) {
    await dependencies.docker.pull(previous.image)
  }
  await dependencies.docker.up({ ...identity, composePath: previousCompose }, undefined)
  return validateEndToEnd(plan.profile, previous.endpoint, dependencies)
}

async function executeValidateTarget(
  plan: RecoveryPlan,
  journal: OperationJournal,
  state: StateV2,
  dependencies: RecoveryDependencies,
  signal?: AbortSignal,
): Promise<RecoveryOutcome> {
  const target = plan.decision.type === 'validate-target' ? plan.decision.target : undefined
  if (target === undefined) throw recoveryConflicted()
  const managed = state.managed
  if (managed === undefined) throw inconsistentState('Managed deployment state is missing')
  const committed = stateSha256(state) !== journal.beforeStateSha256
  const previous = committed ? managed.previous : managed.current
  if (previous === undefined) throw inconsistentState('The previous deployment snapshot is missing')

  let checks: DiagnosticCheck[]
  try {
    checks = await validateEndToEnd(plan.profile, target.endpoint, dependencies, signal)
  } catch (error) {
    if (isAbort(error, signal)) throw error
    try {
      if (journal.phase !== 'rolling-back') await dependencies.journal.transition(journal.id, 'rolling-back')
      const rollbackChecks = await restorePreviousDeployment(plan, dependencies, state, previous, target)
      if (committed) {
        // The interrupted update had already committed this target; the
        // rollback must also move the committed state back.
        await dependencies.state.write({
          ...state,
          managed: { current: previous, lastHealthyAt: healthyTimestamp(dependencies.now, recoveryFailed) },
        })
      }
      await dependencies.journal.clear(journal.id)
      return { decision: 'validate-target', outcome: 'target-rolled-back', checks: rollbackChecks }
    } catch (rollbackError) {
      throw recoveryIncomplete(rollbackError)
    }
  }

  const timestamp = healthyTimestamp(dependencies.now, recoveryFailed)
  const next: StateV2 = committed
    ? { ...state, managed: { ...managed, lastHealthyAt: timestamp } }
    : {
        ...state,
        managed: { current: target, previous: managed.current, lastHealthyAt: timestamp },
        profiles: { ...state.profiles, [plan.profile]: { mode: 'managed', endpoint: target.endpoint } },
      }
  await dependencies.state.write(next)
  await dependencies.journal.clear(journal.id)
  return { decision: 'validate-target', outcome: 'target-committed', checks }
}

async function executeResumeRollback(
  plan: RecoveryPlan,
  journal: OperationJournal,
  state: StateV2,
  dependencies: RecoveryDependencies,
  signal?: AbortSignal,
): Promise<RecoveryOutcome> {
  const previous = plan.decision.type === 'resume-rollback' ? plan.decision.previous : undefined
  if (previous === undefined) throw recoveryConflicted()
  const managed = state.managed
  if (managed === undefined) throw inconsistentState('Managed deployment state is missing')
  try {
    if (journal.phase === 'mutating') await dependencies.journal.transition(journal.id, 'rolling-back')
    const checks = await restorePreviousDeployment(plan, dependencies, state, previous, undefined)
    await dependencies.state.write({
      ...state,
      managed: { ...managed, lastHealthyAt: healthyTimestamp(dependencies.now, recoveryFailed) },
    })
    await dependencies.journal.clear(journal.id)
    return { decision: 'resume-rollback', outcome: 'rollback-completed', checks }
  } catch (error) {
    if (isAbort(error, signal)) throw error
    throw recoveryIncomplete(error)
  }
}

/**
 * Execute a recovery plan under the state lock: re-read the journal and state
 * and refuse anything other than the exact bytes the plan was computed from,
 * remove a recorded stale lock, then clear, commit, or roll back exactly as
 * decided. Any failure leaves the journal (and state) as evidence.
 */
export async function executeRecovery(
  plan: RecoveryPlan,
  dependencies: RecoveryDependencies,
  signal?: AbortSignal,
): Promise<RecoveryOutcome> {
  try {
    const environment = await dependencies.environment.resolve(plan.profile)
    if (plan.staleLock !== undefined) {
      const observation = await inspectStateLock(environment.managedDir)
      if (observation.kind === 'stale' && observation.pid === plan.staleLock.pid) {
        try {
          await rm(join(environment.managedDir, 'state.lock'), { force: true })
        } catch {
          throw staleLockRemovalFailed()
        }
      }
    }
    return await dependencies.state.withLock(async () => {
      signal?.throwIfAborted()
      const journal = await dependencies.journal.read()
      if (journal === undefined || journal.id !== plan.journal.id) throw recoveryConflicted()
      const state = await dependencies.state.read()
      if (stateSha256(state) !== plan.stateHash) throw recoveryConflicted()

      if (plan.decision.type === 'clear-prepared') {
        await dependencies.journal.clear(journal.id)
        return { decision: 'clear-prepared', outcome: 'journal-cleared', checks: [] } as RecoveryOutcome
      }
      if (plan.decision.type === 'validate-target') {
        return await executeValidateTarget(plan, journal, state, dependencies, signal)
      }
      return await executeResumeRollback(plan, journal, state, dependencies, signal)
    })
  } catch (error) {
    if (error instanceof CliError) throw error
    if (signal?.aborted) signal.throwIfAborted()
    if (isAbort(error, signal)) throw error
    throw recoveryFailed()
  }
}
