import { dirname, join } from 'node:path'
import type { ManagedIdentity } from './assets.ts'
import { CliError } from './errors.ts'
import { isCanonicalTimestamp, type DeploymentSnapshot } from './state.ts'

/**
 * Shared managed-deployment primitives used by setup, diagnostics, repair,
 * and remove. Previously each module carried its own copy of identity
 * construction, bundle-path derivation, cancellation classification, and
 * healthy-timestamp normalization; these are load-bearing safety details and
 * must not drift between call sites.
 */

/** Canonical identity whose resource names are derived from the home id (setup's first-install shape). */
export function canonicalIdentity(stateDir: string, homeId: string): ManagedIdentity {
  const name = `dsh-searxng-${homeId}`
  return {
    stateDir,
    composePath: placeholderComposePath(stateDir),
    homeId,
    projectName: name,
    containerName: name,
  }
}

/** Identity carrying the resource names recorded in state, with an optional inspected Compose path. */
export function stateIdentity(
  stateDir: string,
  homeId: string,
  current: Pick<DeploymentSnapshot, 'projectName' | 'containerName'>,
  composePath?: string,
): ManagedIdentity {
  return {
    stateDir,
    composePath: composePath ?? placeholderComposePath(stateDir),
    homeId,
    projectName: current.projectName,
    containerName: current.containerName,
  }
}

function placeholderComposePath(stateDir: string): string {
  return join(stateDir, `config-${'0'.repeat(64)}`, 'compose.yml')
}

export function isConfigBundleName(name: string): boolean {
  return /^config-[a-f0-9]{64}$/.test(name)
}

/** Recorded bundle directory: the digest-addressed bundle, else the inspected Compose path's bundle. */
export function bundleDirectory(
  stateDir: string,
  current: Pick<DeploymentSnapshot, 'configurationSha256'>,
  composePath?: string,
): string | undefined {
  if (current.configurationSha256 !== undefined) {
    return join(stateDir, `config-${current.configurationSha256}`)
  }
  return composePath === undefined ? undefined : dirname(composePath)
}

/** Compose path of the recorded bundle when the state carries a configuration digest. */
export function bundleComposePath(
  stateDir: string,
  current: Pick<DeploymentSnapshot, 'configurationSha256'>,
): string | undefined {
  return current.configurationSha256 === undefined
    ? undefined
    : join(stateDir, `config-${current.configurationSha256}`, 'compose.yml')
}

/** True when the error is an AbortError or the signal is already aborted. */
export function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true ||
    (error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError')
}

/** Rethrow caller cancellation before a caller maps or swallows the error. */
export function rethrowCancellation(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) signal.throwIfAborted()
  if (isAbort(error)) throw error
}

/** Canonical healthy timestamp from the operation clock; `onInvalid` supplies the operation's failure. */
export function healthyTimestamp(now: () => Date, onInvalid: () => CliError): string {
  const timestamp = now().toISOString()
  if (!isCanonicalTimestamp(timestamp)) throw onInvalid()
  return timestamp
}
