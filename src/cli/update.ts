import { join } from 'node:path'
import type { ManagedIdentity, StagedAssets, StagingAssetRenderer } from './assets.ts'
import { selectDeployment, type DeploymentDefinition } from './deployments.ts'
import type { DockerAdapter } from './docker.ts'
import { CliError } from './errors.ts'
import type { EnvironmentService } from './environment.ts'
import { validateEndToEnd, type DiagnosticCheck, type DiagnosticSnapshot } from './diagnostics.ts'
import { recommendRecovery, stateSha256, type JournalStore, type RecoveryRecommendation } from './journal.ts'
import { bundleComposePath, bundleDirectory, healthyTimestamp, isAbort, stateIdentity } from './managed.ts'
import { readPreservedSecretFromBundle, removeBundleForRebuild } from './repair.ts'
import type { ProfileManager } from './profile.ts'
import type { SearxngProbe } from './searxng.ts'
import type { DeploymentSnapshot, StateStore, StateV2 } from './state.ts'

/** Progress narration points for the CLI's human output. */
export type UpdatePhase =
  | 'diagnosing'
  | 'target-selected'
  | 'pulling'
  | 'staging'
  | 'activating'
  | 'validating'
  | 'rolling-back'
  | 'rolled-back'

export interface UpdateDependencies {
  environment: EnvironmentService
  state: StateStore
  journal: JournalStore
  docker: DockerAdapter
  assets: StagingAssetRenderer
  searxng: SearxngProbe
  profiles: ProfileManager
  catalog: readonly DeploymentDefinition[]
  diagnose(profile: string): Promise<DiagnosticSnapshot>
  /** Reads the existing SearXNG secret from a configuration bundle; update never generates a new one. */
  readPreservedSecret?(bundleDir: string): Promise<string>
  now(): Date
  report?(phase: UpdatePhase): void
}

export interface UpdateResult {
  profile: string
  endpoint: string
  from: number
  to: number
  rolledBack: false
  checks: DiagnosticCheck[]
}

function updateFailed(): CliError {
  return new CliError('E_INTERNAL', 'Update failed unexpectedly', 'Run dsh-searxng doctor and retry')
}

function interruptedOperation(recommendation: RecoveryRecommendation): CliError {
  return new CliError(
    'E_STATE_INVALID',
    `An interrupted operation is recorded in the journal: ${recommendation.summary}`,
    'Run dsh-searxng doctor and follow the interrupted-operation guidance',
  )
}

function externalProfile(): CliError {
  return new CliError(
    'E_STATE_INVALID',
    'The profile is attached to an external SearXNG endpoint',
    'dsh-searxng update only updates owned deployments; external endpoints are read-only',
  )
}

function currentNotHealthy(): CliError {
  return new CliError(
    'E_STATE_INVALID',
    'The current managed deployment is not end-to-end healthy',
    'Run dsh-searxng doctor --json, then dsh-searxng repair, and retry the update from a healthy deployment',
  )
}

function stateChanged(): CliError {
  return new CliError(
    'E_STATE_INVALID',
    'Managed state changed while the update was being prepared',
    'Re-run dsh-searxng update against the current state',
  )
}

function resourceForeign(): CliError {
  return new CliError(
    'E_RESOURCE_FOREIGN',
    'A same-name Docker resource is not owned by this dsh-searxng installation',
    'Rename or remove the foreign resource, then retry',
  )
}

function deploymentDisappeared(): CliError {
  return new CliError(
    'E_STATE_INVALID',
    'Managed Docker resources changed while the update was being prepared',
    'Run dsh-searxng doctor and repair the managed deployment, then retry the update',
  )
}

function alreadyAtVersion(version: number, requested: boolean): CliError {
  return new CliError(
    'E_DEPLOYMENT_UNSUPPORTED',
    requested
      ? `The managed deployment is already at deployment version ${version}`
      : `The managed deployment is already at the latest packaged deployment version ${version}`,
    'No update is required; run dsh-searxng status to verify health',
    { from: version, to: version },
  )
}

function secretUnavailable(): CliError {
  return new CliError(
    'E_STATE_INVALID',
    'The managed SearXNG secret cannot be preserved because the configuration bundle is unreadable',
    'Run dsh-searxng doctor and repair the managed deployment',
  )
}

function inconsistentState(message: string): CliError {
  return new CliError('E_STATE_INVALID', message, 'Run dsh-searxng doctor and repair the managed deployment')
}

function unwindIncomplete(primary: unknown): CliError {
  return new CliError(
    'E_INTERNAL',
    'The update failed and journal cleanup was incomplete',
    'Run dsh-searxng doctor and follow the interrupted-operation guidance',
    { primaryError: primary instanceof CliError ? primary.code : isAbort(primary) ? 'abort' : 'internal' },
  )
}

function journalCleanupIncomplete(): CliError {
  return new CliError(
    'E_INTERNAL',
    'The update completed but operation journal cleanup did not',
    'Run dsh-searxng doctor and follow the interrupted-operation guidance',
  )
}

/** The update failed but the previous deployment was restored and validated. */
function updateRolledBack(targetError: unknown, target: DeploymentDefinition, previous: DeploymentSnapshot): CliError {
  const code = targetError instanceof CliError ? targetError.code : 'E_INTERNAL'
  return new CliError(
    code,
    `The update to deployment version ${target.deploymentVersion} failed and was rolled back; the previous deployment (version ${previous.deploymentVersion}) was restored and validated healthy`,
    'Run dsh-searxng doctor --json to review the redacted failure, then retry the update',
    {
      rolledBack: true,
      targetVersion: target.deploymentVersion,
      targetError: targetError instanceof CliError ? targetError.code : isAbort(targetError) ? 'abort' : 'internal',
    },
  )
}

/** The update failed AND restoring the previous deployment failed: doctor must intervene. */
function rollbackFailed(targetError: unknown, rollbackError: unknown): CliError {
  return new CliError(
    'E_INTERNAL',
    'The update failed and the rollback to the previous deployment did not complete',
    'Run dsh-searxng doctor --json and follow the interrupted-operation guidance immediately',
    {
      targetError: targetError instanceof CliError ? targetError.code : isAbort(targetError) ? 'abort' : 'internal',
      rollbackError: rollbackError instanceof CliError ? rollbackError.code : isAbort(rollbackError) ? 'abort' : 'internal',
    },
  )
}

/**
 * A deployment may only be updated from an end-to-end healthy base: any
 * interruption, external attachment, or unhealthy field blocks the ordinary
 * path and points at doctor/repair instead.
 */
function requireUpdatableCurrent(snapshot: DiagnosticSnapshot): void {
  if (snapshot.interruptedOperation !== undefined) {
    throw interruptedOperation(recommendRecovery(snapshot.interruptedOperation))
  }
  if (snapshot.mode === 'external') throw externalProfile()
  if (
    snapshot.docker !== 'healthy' ||
    snapshot.ownership !== 'owned' ||
    snapshot.container !== 'running' ||
    snapshot.generatedAssets !== 'valid' ||
    snapshot.endpoint !== 'healthy' ||
    snapshot.profileEndpoint !== undefined
  ) {
    throw currentNotHealthy()
  }
}

async function preservedSecret(
  dependencies: UpdateDependencies,
  stateDir: string,
  current: DeploymentSnapshot,
  composePath?: string,
): Promise<string> {
  const bundleDir = bundleDirectory(stateDir, current, composePath)
  if (bundleDir === undefined) throw secretUnavailable()
  return (dependencies.readPreservedSecret ?? readPreservedSecretFromBundle)(bundleDir)
}

/**
 * Stage the target bundle, retrying exactly once when a damaged bundle from a
 * previous attempt to the same version blocks the content-addressed publish.
 * The damaged directory is identified by the renderer's digest-only
 * `details.bundle` and removed with repair's ownership-bounded removal.
 */
async function stageTarget(
  dependencies: UpdateDependencies,
  input: { definition: DeploymentDefinition; stateDir: string; identity: ManagedIdentity; port: number; secret: string },
): Promise<StagedAssets> {
  try {
    return await dependencies.assets.stage(input)
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== 'E_BUNDLE_DAMAGED') throw error
    const bundle = error.details.bundle
    if (typeof bundle !== 'string' || !/^config-[a-f0-9]{64}$/.test(bundle)) throw error
    await removeBundleForRebuild(input.stateDir, join(input.stateDir, bundle))
    return await dependencies.assets.stage(input)
  }
}

function updatedState(
  state: StateV2,
  profile: string,
  current: DeploymentSnapshot,
  target: DeploymentDefinition,
  staged: StagedAssets,
  dependencies: UpdateDependencies,
): StateV2 {
  return {
    ...state,
    managed: {
      current: {
        deploymentVersion: target.deploymentVersion,
        image: target.image,
        endpoint: current.endpoint,
        port: current.port,
        projectName: current.projectName,
        containerName: current.containerName,
        configurationSha256: staged.configurationSha256,
      },
      previous: current,
      lastHealthyAt: healthyTimestamp(dependencies.now, updateFailed),
    },
    profiles: { ...state.profiles, [profile]: { mode: 'managed', endpoint: current.endpoint } },
  }
}

/**
 * Transactional update of the managed deployment: verify the current
 * deployment is end-to-end healthy, select the target from the packaged
 * catalog, journal every phase, pull the target image, stage its bundle
 * (content-addressed; the active bundle is never edited in place), activate
 * it with Compose, and validate it with the same checks setup uses. State
 * keeps `current` old until target validation passes; the old snapshot then
 * moves to `previous`. Any failure after the first Compose mutation rolls
 * back to the previous bundle and image and validates the restore; the
 * journal is cleared only after successful target validation, successful
 * rollback validation, or a handled pre-mutation unwind.
 */
export async function updateManagedService(
  input: { profile: string; deploymentVersion?: number },
  dependencies: UpdateDependencies,
  signal?: AbortSignal,
): Promise<UpdateResult> {
  try {
    return await dependencies.state.withLock(async () => {
      signal?.throwIfAborted()

      dependencies.report?.('diagnosing')
      const snapshot = await dependencies.diagnose(input.profile)
      requireUpdatableCurrent(snapshot)

      const state = await dependencies.state.read()
      if (stateSha256(state) !== snapshot.stateHash) throw stateChanged()
      const managed = state.managed
      if (managed === undefined) throw stateChanged()

      const target = selectDeployment(dependencies.catalog, state.schemaVersion, input.deploymentVersion)
      dependencies.report?.('target-selected')
      if (
        target.deploymentVersion === managed.current.deploymentVersion &&
        target.image === managed.current.image
      ) {
        throw alreadyAtVersion(managed.current.deploymentVersion, input.deploymentVersion !== undefined)
      }

      const environment = await dependencies.environment.resolve(input.profile)
      const identity = stateIdentity(environment.managedDir, state.homeId, managed.current)

      // Ownership gate (security contract), re-verified under the lock
      // immediately before any journal or mutation work. The whole
      // transaction holds the state lock, so nothing can interleave.
      await dependencies.docker.preflight(signal)
      const status = await dependencies.docker.deploymentStatus(identity, signal)
      if (status.ownership === 'foreign') throw resourceForeign()
      if (status.ownership === 'absent' || status.container !== 'running') throw deploymentDisappeared()

      const previousComposePath = bundleComposePath(environment.managedDir, managed.current) ?? status.composePath
      if (previousComposePath === undefined) {
        throw inconsistentState('The managed Compose configuration cannot be located')
      }
      // The runtime identity of the deployment being replaced: the inspected
      // Compose path (trusted by the adapter), else the recorded bundle.
      const currentIdentity = { ...identity, composePath: status.composePath ?? previousComposePath }

      const journal = await dependencies.journal.begin({
        kind: 'update',
        phase: 'prepared',
        beforeStateSha256: stateSha256(state),
        target: { deploymentVersion: target.deploymentVersion, image: target.image },
      })

      let activated = false
      let checks: DiagnosticCheck[] | undefined
      let stagedIdentity: ManagedIdentity | undefined
      const previousIdentity = { ...identity, composePath: previousComposePath }
      try {
        // Pull before mutation: a pull failure leaves the running deployment untouched.
        dependencies.report?.('pulling')
        await dependencies.docker.pull(target.image, signal)

        await dependencies.journal.transition(journal.id, 'mutating')

        dependencies.report?.('staging')
        const secret = await preservedSecret(dependencies, environment.managedDir, managed.current, status.composePath)
        const staged = await stageTarget(dependencies, {
          definition: target,
          stateDir: environment.managedDir,
          identity,
          port: managed.current.port,
          secret,
        })
        stagedIdentity = { ...identity, composePath: join(staged.directory, 'compose.yml') }

        // First Compose mutation onward, every failure rolls back.
        signal?.throwIfAborted()
        dependencies.report?.('activating')
        activated = true
        await dependencies.docker.down(currentIdentity, false, signal)
        await dependencies.docker.up(stagedIdentity, signal)

        await dependencies.journal.transition(journal.id, 'validating')
        dependencies.report?.('validating')
        checks = await validateEndToEnd(input.profile, managed.current.endpoint, dependencies, signal)

        // State keeps `current` old until this point; the commit moves the old
        // snapshot to `previous` in the same atomic write.
        await dependencies.state.write(updatedState(state, input.profile, managed.current, target, staged, dependencies))
      } catch (error) {
        if (!activated) {
          // Nothing mutated: unwind the journal so no recovery is needed.
          try {
            await dependencies.journal.clear(journal.id)
          } catch {
            throw unwindIncomplete(error)
          }
          throw error
        }

        dependencies.report?.('rolling-back')
        if (stagedIdentity === undefined) throw updateFailed()
        try {
          await dependencies.journal.transition(journal.id, 'rolling-back')
          // The rollback runs detached from the caller's cancellation: once
          // begun, restoring the service must not be abortable. The previous
          // bundle is never deleted by an update, so restore means pointing
          // the Compose runtime back at it (down the target project, up the
          // previous bundle and image) and validating the restore.
          await dependencies.docker.down(stagedIdentity, false, undefined)
          await dependencies.docker.up(previousIdentity, undefined)
          await validateEndToEnd(input.profile, managed.current.endpoint, dependencies)
          await dependencies.journal.clear(journal.id)
        } catch (rollbackError) {
          throw rollbackFailed(error, rollbackError)
        }
        dependencies.report?.('rolled-back')
        if (isAbort(error, signal)) throw error
        throw updateRolledBack(error, target, managed.current)
      }

      try {
        await dependencies.journal.clear(journal.id)
      } catch {
        throw journalCleanupIncomplete()
      }
      return {
        profile: input.profile,
        endpoint: managed.current.endpoint,
        from: managed.current.deploymentVersion,
        to: target.deploymentVersion,
        rolledBack: false as const,
        checks: checks ?? [],
      }
    })
  } catch (error) {
    if (error instanceof CliError) throw error
    if (signal?.aborted) signal.throwIfAborted()
    if (isAbort(error, signal)) throw error
    throw updateFailed()
  }
}
