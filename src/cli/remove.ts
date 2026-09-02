import { lstat, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import type { ManagedIdentity } from './assets.ts'
import type { DockerAdapter } from './docker.ts'
import { CliError } from './errors.ts'
import type { EnvironmentService } from './environment.ts'
import type { ProfileManager } from './profile.ts'
import type { StateStore, StateV2 } from './state.ts'

export interface RemoveInput { profile: string; service: boolean; purgeData: boolean; confirmed: boolean }
export interface RemoveResult { profile: string; profileRemoved: boolean; serviceRemoved: boolean; dataPurged: boolean }
export interface RemoveDependencies {
  environment: EnvironmentService
  state: StateStore
  docker: DockerAdapter
  profiles: ProfileManager
  confirmPurge(volumes: readonly string[]): Promise<boolean>
  removeManagedDirectory(dshHome: string): Promise<void>
}

function blocked(message: string): CliError {
  return new CliError('E_REMOVE_BLOCKED', message, 'Detach the remaining managed profiles, then retry')
}

function removalFailed(message: string): CliError {
  return new CliError('E_INTERNAL', message, 'Run dsh-searxng doctor and retry the removal')
}

function identity(managedDir: string, homeId: string, managed: NonNullable<StateV2['managed']>, composePath?: string): ManagedIdentity {
  return {
    stateDir: managedDir,
    composePath: composePath ?? `${managedDir}/config-${'0'.repeat(64)}/compose.yml`,
    homeId,
    projectName: managed.current.projectName,
    containerName: managed.current.containerName,
  }
}

async function writeWithRestore(state: StateStore, previous: StateV2, next: StateV2): Promise<void> {
  try {
    await state.write(next)
  } catch (primary) {
    try { await state.write(previous) } catch { throw removalFailed('Removal failed and attachment state could not be restored') }
    throw primary
  }
}

export async function removeManagedDirectory(dshHome: string): Promise<void> {
  if (!isAbsolute(dshHome) || normalize(dshHome) !== dshHome) throw removalFailed('DSH home path is unsafe')
  const path = join(dshHome, 'dsh-searxng')
  if (dirname(path) !== dshHome || basename(path) !== 'dsh-searxng') throw removalFailed('Managed directory path is unsafe')
  let info
  try { info = await lstat(path) } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return
    throw removalFailed('Unable to inspect the managed directory')
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw removalFailed('Managed directory is not a safe directory')
  try { await rm(path, { recursive: true }) } catch { throw removalFailed('Unable to remove the managed directory') }
}

export async function remove(
  input: RemoveInput,
  dependencies: RemoveDependencies,
  signal?: AbortSignal,
): Promise<RemoveResult> {
  if (input.purgeData && !input.service) throw new CliError('E_USAGE', '--purge-data requires --service', 'Use --service --purge-data')
  const resolved = await dependencies.environment.resolve(input.profile)
  let purgeDshHome: string | undefined
  const result = await dependencies.state.withLock(async () => {
    signal?.throwIfAborted()
    const previous = await dependencies.state.read()
    const entry = previous.profiles[input.profile]
    const managed = previous.managed
    const otherManaged = Object.entries(previous.profiles)
      .filter(([profile, value]) => profile !== input.profile && value.mode === 'managed')
      .map(([profile]) => profile)
    if (input.service && otherManaged.length > 0) throw blocked(`Managed service is still attached to: ${otherManaged.join(', ')}`)
    if (input.service && (entry?.mode === 'external' || managed === undefined)) throw blocked('The selected profile does not own a managed service')

    const volumes = managed === undefined ? [] : [`${managed.current.projectName}-cache`]
    if (input.purgeData && !input.confirmed && !await dependencies.confirmPurge(volumes)) {
      throw new CliError('E_USAGE', 'Permanent data deletion was not confirmed', 'Retry with --yes after reviewing the listed volume')
    }

    let initialIdentity: ManagedIdentity | undefined
    if (input.service && managed !== undefined) {
      await dependencies.docker.preflight(signal)
      const status = await dependencies.docker.deploymentStatus(identity(resolved.managedDir, previous.homeId, managed), signal)
      if (status.ownership !== 'owned' || status.composePath === undefined) throw blocked('Managed Docker resources are absent or incomplete')
      initialIdentity = identity(resolved.managedDir, previous.homeId, managed, status.composePath)
    }

    await dependencies.environment.preflightDsh(signal)
    const profileRemoved = entry !== undefined
    if (profileRemoved) {
      const profiles = { ...previous.profiles }
      delete profiles[input.profile]
      const next: StateV2 = { schemaVersion: 2, homeId: previous.homeId, ...(managed === undefined ? {} : { managed }), profiles }
      await writeWithRestore(dependencies.state, previous, next)
    }
    try {
      await dependencies.profiles.detach(input.profile, signal)
    } catch (error) {
      if (profileRemoved) {
        try { await dependencies.state.write(previous) } catch { throw removalFailed('Profile detachment failed and state could not be restored') }
      }
      throw error
    }
    await dependencies.profiles.uninstall(input.profile, signal)

    if (input.service && managed !== undefined && initialIdentity !== undefined) {
      const finalStatus = await dependencies.docker.deploymentStatus(identity(resolved.managedDir, previous.homeId, managed), signal)
      if (finalStatus.ownership !== 'owned' || finalStatus.composePath === undefined) throw blocked('Managed Docker ownership changed during removal')
      await dependencies.docker.down(identity(resolved.managedDir, previous.homeId, managed, finalStatus.composePath), input.purgeData, signal)
      if (input.purgeData) purgeDshHome = resolved.dshHome
    }
    return { profile: input.profile, profileRemoved, serviceRemoved: input.service, dataPurged: input.purgeData }
  })
  if (purgeDshHome !== undefined) await dependencies.removeManagedDirectory(purgeDshHome)
  return result
}
