import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import { CliError, redact } from './errors.ts'
import type { ManagedIdentity } from './assets.ts'
import { ProcessExecutionError, type CommandResult, type CommandRunner } from './process.ts'

export type { ManagedIdentity } from './assets.ts'

export interface DockerAdapter {
  preflight(signal?: AbortSignal): Promise<{ serverVersion: string; composeVersion: string }>
  inspectOwnership(identity: ManagedIdentity, signal?: AbortSignal): Promise<'absent' | 'owned'>
  up(identity: ManagedIdentity, signal?: AbortSignal): Promise<void>
  restart(identity: ManagedIdentity, signal?: AbortSignal): Promise<void>
  down(identity: ManagedIdentity, volumes: boolean, signal?: AbortSignal): Promise<void>
  logs(identity: ManagedIdentity, tail: number, signal?: AbortSignal): Promise<string>
  deploymentStatus(identity: ManagedIdentity, signal?: AbortSignal): Promise<DockerDeploymentStatus>
  /**
   * Pull the exact digest-pinned image before any deployment mutation, so a
   * pull failure never leaves a half-updated runtime behind.
   */
  pull(image: string, signal?: AbortSignal): Promise<void>
  /**
   * Report whether the exact image reference is present in the local store.
   * Reserved for crash-recovery decisions (lifecycle Task 5); the update
   * transaction always pulls unconditionally.
   */
  imageExists(image: string, signal?: AbortSignal): Promise<boolean>
  /**
   * Optional capability to delete a named temporary Docker resource after
   * re-verifying this installation's ownership labels. Reserved: the repair
   * executor currently removes orphaned filesystem staging directories only
   * and does not call this method.
   */
  removeOwnedResource?(resourceId: string, signal?: AbortSignal): Promise<void>
}

export interface DockerDeploymentStatus {
  /**
   * 'foreign' is part of the contract so callers must refuse it explicitly.
   * The production adapter additionally throws E_RESOURCE_FOREIGN during
   * inspection rather than returning a partial status; adapters that return
   * 'foreign' are equally valid and callers must enforce the gate themselves.
   */
  ownership: 'absent' | 'owned' | 'foreign'
  container: 'absent' | 'running' | 'stopped'
  composePath?: string
}

export interface CliDockerAdapterOptions {
  maxLogBytes?: number
  redact?: (value: unknown) => unknown
}

const MAX_LOG_TAIL = 1000
const DEFAULT_MAX_LOG_BYTES = 64 * 1024

function cancellation(error: unknown, signal?: AbortSignal): never | void {
  signal?.throwIfAborted()
  if (error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError') throw error
}

function foreignResource(): CliError {
  return new CliError(
    'E_RESOURCE_FOREIGN',
    'A same-name Docker resource is not owned by this dsh-searxng installation',
    'Rename or remove the foreign resource, then retry',
  )
}

function operationFailed(operation: string): CliError {
  return new CliError('E_INTERNAL', `Docker Compose ${operation} failed`, 'Run dsh-searxng doctor and inspect Docker status')
}

function restartFailed(): CliError {
  return new CliError('E_INTERNAL', 'Docker container restart failed', 'Run dsh-searxng doctor and repair the managed deployment')
}

function imageReferenceInvalid(): CliError {
  return new CliError('E_USAGE', 'Image reference is invalid', 'Use a digest-pinned image reference')
}

function pullFailed(): CliError {
  return new CliError('E_INTERNAL', 'Docker image pull failed', 'Check network access to the image registry, then retry')
}

function imageInspectFailed(): CliError {
  return new CliError('E_INTERNAL', 'Docker image inspection failed', 'Run dsh-searxng doctor and inspect Docker status')
}

function validateImageReference(image: string): void {
  if (typeof image !== 'string' || image.length === 0 || /[\s\u0000-\u001f\u007f]/.test(image)) throw imageReferenceInvalid()
}

function incompleteManagedResources(): CliError {
  return new CliError(
    'E_STATE_INVALID',
    'Managed Docker resources are incomplete',
    'Run dsh-searxng doctor and repair the managed deployment',
  )
}

function composeMajor(version: string): number | undefined {
  const matches = [...version.matchAll(/(?:^|[^\d])v?(\d+)\.(\d+)(?:\.\d+)?/gi)]
  const major = matches.at(-1)?.[1]
  if (major === undefined) return undefined
  const parsed = Number(major)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

const RESOURCE_LABELS = {
  managed: 'io.dsh-searxng.managed',
  homeId: 'io.dsh-searxng.home-id',
  schema: 'io.dsh-searxng.schema',
  deploymentVersion: 'io.dsh-searxng.deployment-version',
} as const

type ResourceKind = 'container' | 'network' | 'volume'

function invalidIdentity(): CliError {
  return new CliError('E_USAGE', 'Managed Docker identity is invalid', 'Run setup again to regenerate managed deployment identity')
}

function validateIdentity(identity: ManagedIdentity): void {
  if (!/^[a-f0-9]{16}$/.test(identity.homeId)) throw invalidIdentity()
  const canonicalName = `dsh-searxng-${identity.homeId}`
  if (identity.projectName !== canonicalName || identity.containerName !== canonicalName) throw invalidIdentity()
  if (/[\u0000-\u001f\u007f]/.test(identity.stateDir) || /[\u0000-\u001f\u007f]/.test(identity.composePath)) throw invalidIdentity()
  if (!isAbsolute(identity.stateDir) || normalize(identity.stateDir) !== identity.stateDir) throw invalidIdentity()
  const bundleDir = dirname(identity.composePath)
  if (
    basename(identity.composePath) !== 'compose.yml' ||
    dirname(bundleDir) !== identity.stateDir ||
    !/^config-[a-f0-9]{64}$/.test(basename(bundleDir)) ||
    join(bundleDir, 'compose.yml') !== identity.composePath
  ) throw invalidIdentity()
}

function resourceName(identity: ManagedIdentity, kind: ResourceKind): string {
  if (kind === 'container') return identity.containerName
  return `${identity.projectName}-${kind === 'network' ? 'network' : 'cache'}`
}

function resourceLabels(value: unknown, kind: ResourceKind): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const labels = kind === 'container'
    ? (record.Config !== null && typeof record.Config === 'object' && !Array.isArray(record.Config)
        ? (record.Config as Record<string, unknown>).Labels
        : undefined)
    : record.Labels
  if (labels === null || typeof labels !== 'object' || Array.isArray(labels)) return undefined
  if (!Object.values(labels as Record<string, unknown>).every((label) => typeof label === 'string')) return undefined
  return labels as Record<string, string>
}

function hasExpectedLabels(labels: Record<string, string>, homeId: string): boolean {
  // Ownership is the home identity, not the deployment version: any resource
  // carrying this homeId was created by this installation, whatever packaged
  // deployment version rendered it. Requiring a fixed version here would
  // misclassify (and refuse to roll back) our own updated deployments.
  const deploymentVersion = labels[RESOURCE_LABELS.deploymentVersion]
  return labels[RESOURCE_LABELS.managed] === 'true' &&
    labels[RESOURCE_LABELS.homeId] === homeId &&
    labels[RESOURCE_LABELS.schema] === '1' &&
    typeof deploymentVersion === 'string' && /^\d+$/.test(deploymentVersion) && Number(deploymentVersion) >= 1
}

function absentMessage(kind: ResourceKind, output: string): boolean {
  if (kind === 'container') return /no such (?:object|container)/i.test(output)
  if (kind === 'network') return /(?:no such network|network .+ not found)/i.test(output)
  return new RegExp(`no such ${kind}`, 'i').test(output)
}

function sanitizeLogText(value: string): string {
  return value
    .replace(/("authorization"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/(authorization\s*[:=]\s*)[^\r\n,;]+/gi, '$1[REDACTED]')
    .replace(/("(?:search(?:[_-]?query)|query)"\s*:\s*")(?:\\.|[^"\\])*(")/gi, '$1[REDACTED]$2')
    .replace(/(^|[?&])((?:q|query|search(?:[_-]?query))=)[^&\s"']*/gim, '$1$2[REDACTED]')
    .replace(/^(?![^\r\n]*&[a-z][\w-]*=)((?:search(?:[_-]?query)|query)\s*[:=]\s*)[^\r\n]*/gim, '$1[REDACTED]')
    .replace(/([^a-z\d_?&-])((?:search(?:[_-]?query)|query)\s*[:=]\s*)[^\r\n]*/gim, '$1$2[REDACTED]')
    .replace(/((?:secret(?:[_-]?key)?|password|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/("(?:secret(?:[_-]?key)?|password|api[_-]?key|access[_-]?token|refresh[_-]?token)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
}

function capUtf8(value: string, limit: number): string {
  const bytes = Buffer.from(value)
  if (bytes.byteLength <= limit) return value
  let capped = bytes.subarray(0, limit).toString('utf8')
  while (Buffer.byteLength(capped) > limit) capped = capped.slice(0, -1)
  return capped
}

export class CliDockerAdapter implements DockerAdapter {
  private readonly runner: CommandRunner
  private readonly maxLogBytes: number
  private readonly redactValue: (value: unknown) => unknown

  constructor(runner: CommandRunner, options: CliDockerAdapterOptions = {}) {
    if (!Number.isSafeInteger(options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES) || (options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES) < 0) {
      throw new RangeError('maxLogBytes must be a non-negative safe integer')
    }
    this.runner = runner
    this.maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES
    this.redactValue = options.redact ?? redact
  }

  async preflight(signal?: AbortSignal): Promise<{ serverVersion: string; composeVersion: string }> {
    signal?.throwIfAborted()
    let docker: CommandResult
    try {
      docker = await this.runner.run('docker', ['version', '--format', '{{.Server.Version}}'], { signal })
      signal?.throwIfAborted()
    } catch (error) {
      cancellation(error, signal)
      if (error instanceof ProcessExecutionError && error.reason === 'spawn') {
        throw new CliError('E_DOCKER_MISSING', 'The Docker executable is unavailable', 'Install Docker and ensure it is on PATH')
      }
      throw new CliError('E_DOCKER_OFFLINE', 'The Docker daemon is unavailable', 'Start Docker Desktop or the Docker daemon, then retry')
    }
    const serverVersion = docker.stdout.trim()
    if (docker.exitCode !== 0 || serverVersion.length === 0) {
      throw new CliError('E_DOCKER_OFFLINE', 'The Docker daemon is unavailable', 'Start Docker Desktop or the Docker daemon, then retry')
    }

    let compose: CommandResult
    try {
      compose = await this.runner.run('docker', ['compose', 'version', '--short'], { signal })
      signal?.throwIfAborted()
    } catch (error) {
      cancellation(error, signal)
      throw new CliError('E_COMPOSE_UNSUPPORTED', 'Docker Compose v2 is unavailable', 'Install or enable Docker Compose v2')
    }
    const composeVersion = compose.stdout.trim()
    if (compose.exitCode !== 0 || composeMajor(composeVersion) === undefined || composeMajor(composeVersion)! < 2) {
      throw new CliError('E_COMPOSE_UNSUPPORTED', 'Docker Compose v2 is required', 'Install or enable Docker Compose v2')
    }
    return { serverVersion, composeVersion }
  }

  async inspectOwnership(identity: ManagedIdentity, signal?: AbortSignal): Promise<'absent' | 'owned'> {
    validateIdentity(identity)
    signal?.throwIfAborted()
    let anyOwned = false
    for (const kind of ['container', 'network', 'volume'] as const) {
      const ownership = await this.inspectResource(identity, kind, signal)
      if (ownership === 'owned') anyOwned = true
    }
    return anyOwned ? 'owned' : 'absent'
  }

  async deploymentStatus(identity: ManagedIdentity, signal?: AbortSignal): Promise<DockerDeploymentStatus> {
    validateIdentity(identity)
    signal?.throwIfAborted()
    const container = await this.inspectContainer(identity, signal)
    const network = await this.inspectResource(identity, 'network', signal)
    const volume = await this.inspectResource(identity, 'volume', signal)
    const ownership = container === undefined && network === 'absent' && volume === 'absent' ? 'absent' : 'owned'
    if (container === undefined) return { ownership, container: 'absent' }
    const config = container.Config
    const labels = config !== null && typeof config === 'object' && !Array.isArray(config)
      ? (config as Record<string, unknown>).Labels
      : undefined
    if (labels === null || typeof labels !== 'object' || Array.isArray(labels)) throw foreignResource()
    const composePath = (labels as Record<string, unknown>)['com.docker.compose.project.config_files']
    const project = (labels as Record<string, unknown>)['com.docker.compose.project']
    if (typeof composePath !== 'string' || composePath.includes(',') || project !== identity.projectName) throw foreignResource()
    try { validateIdentity({ ...identity, composePath }) } catch { throw foreignResource() }
    const state = container.State
    if (state === null || typeof state !== 'object' || Array.isArray(state) || typeof (state as Record<string, unknown>).Running !== 'boolean') {
      throw foreignResource()
    }
    return {
      ownership,
      container: (state as Record<string, unknown>).Running ? 'running' : 'stopped',
      composePath,
    }
  }

  async up(identity: ManagedIdentity, signal?: AbortSignal): Promise<void> {
    await this.inspectOwnership(identity, signal)
    await this.runCompose(identity, ['up', '--detach'], 'up', signal)
  }

  async restart(identity: ManagedIdentity, signal?: AbortSignal): Promise<void> {
    validateIdentity(identity)
    signal?.throwIfAborted()
    const ownership: Array<'absent' | 'owned'> = []
    for (const kind of ['container', 'network', 'volume'] as const) {
      ownership.push(await this.inspectResource(identity, kind, signal))
    }
    if (ownership.some((resource) => resource === 'absent')) throw incompleteManagedResources()

    let result: CommandResult
    try {
      result = await this.runner.run('docker', ['container', 'restart', identity.containerName], { signal })
      signal?.throwIfAborted()
    } catch (error) {
      cancellation(error, signal)
      throw restartFailed()
    }
    if (result.exitCode !== 0) throw restartFailed()
  }

  async down(identity: ManagedIdentity, volumes: boolean, signal?: AbortSignal): Promise<void> {
    const ownership = await this.inspectOwnership(identity, signal)
    if (ownership === 'absent') return
    await this.runCompose(identity, volumes ? ['down', '--volumes'] : ['down'], 'down', signal)
  }

  async logs(identity: ManagedIdentity, tail: number, signal?: AbortSignal): Promise<string> {
    if (!Number.isSafeInteger(tail) || tail < 1 || tail > MAX_LOG_TAIL) {
      throw new CliError('E_USAGE', `Log tail must be between 1 and ${MAX_LOG_TAIL}`, 'Choose a bounded positive log tail')
    }
    const ownership = await this.inspectOwnership(identity, signal)
    if (ownership === 'absent') return ''
    const result = await this.runCompose(identity, ['logs', '--no-color', '--tail', String(tail), 'searxng'], 'logs', signal)
    const sanitized = sanitizeLogText(`${result.stdout}${result.stderr}`)
    const redacted = this.redactValue({ output: sanitized })
    const output = redacted !== null && typeof redacted === 'object' && !Array.isArray(redacted)
      ? (redacted as Record<string, unknown>).output
      : undefined
    return capUtf8(typeof output === 'string' ? output : '[REDACTED]', this.maxLogBytes)
  }

  async pull(image: string, signal?: AbortSignal): Promise<void> {
    validateImageReference(image)
    signal?.throwIfAborted()
    let result: CommandResult
    try {
      result = await this.runner.run('docker', ['image', 'pull', image], { signal })
      signal?.throwIfAborted()
    } catch (error) {
      cancellation(error, signal)
      throw pullFailed()
    }
    if (result.exitCode !== 0) throw pullFailed()
  }

  async imageExists(image: string, signal?: AbortSignal): Promise<boolean> {
    validateImageReference(image)
    signal?.throwIfAborted()
    let result: CommandResult
    try {
      result = await this.runner.run('docker', ['image', 'inspect', image], { signal })
      signal?.throwIfAborted()
    } catch (error) {
      cancellation(error, signal)
      throw imageInspectFailed()
    }
    if (result.exitCode === 0) return true
    if (/no such image/i.test(`${result.stdout}\n${result.stderr}`)) return false
    throw imageInspectFailed()
  }

  private composeArgs(identity: ManagedIdentity, operation: readonly string[]): string[] {
    return [
      'compose',
      '--project-directory', identity.stateDir,
      '--env-file', join(dirname(identity.composePath), '.env'),
      '-f', identity.composePath,
      '--project-name', identity.projectName,
      ...operation,
    ]
  }

  private async inspectResource(
    identity: ManagedIdentity,
    kind: ResourceKind,
    signal?: AbortSignal,
  ): Promise<'absent' | 'owned'> {
    let result: CommandResult
    try {
      result = await this.runner.run('docker', [kind, 'inspect', resourceName(identity, kind)], { signal })
      signal?.throwIfAborted()
    } catch (error) {
      cancellation(error, signal)
      throw operationFailed('inspect')
    }
    if (result.exitCode !== 0) {
      if (absentMessage(kind, `${result.stdout}\n${result.stderr}`)) return 'absent'
      throw operationFailed('inspect')
    }

    let parsed: unknown
    try { parsed = JSON.parse(result.stdout) } catch { throw foreignResource() }
    if (!Array.isArray(parsed) || parsed.length !== 1) throw foreignResource()
    const labels = resourceLabels(parsed[0], kind)
    if (labels === undefined || !hasExpectedLabels(labels, identity.homeId)) throw foreignResource()
    return 'owned'
  }

  private async inspectContainer(identity: ManagedIdentity, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
    let result: CommandResult
    try {
      result = await this.runner.run('docker', ['container', 'inspect', identity.containerName], { signal })
      signal?.throwIfAborted()
    } catch (error) {
      cancellation(error, signal)
      throw operationFailed('inspect')
    }
    if (result.exitCode !== 0) {
      if (absentMessage('container', `${result.stdout}\n${result.stderr}`)) return undefined
      throw operationFailed('inspect')
    }
    let parsed: unknown
    try { parsed = JSON.parse(result.stdout) } catch { throw foreignResource() }
    if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0] === null || typeof parsed[0] !== 'object' || Array.isArray(parsed[0])) {
      throw foreignResource()
    }
    const record = parsed[0] as Record<string, unknown>
    const labels = resourceLabels(record, 'container')
    if (labels === undefined || !hasExpectedLabels(labels, identity.homeId)) throw foreignResource()
    return record
  }

  private async runCompose(
    identity: ManagedIdentity,
    args: readonly string[],
    operation: string,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    signal?.throwIfAborted()
    let result: CommandResult
    try {
      result = await this.runner.run('docker', this.composeArgs(identity, args), { signal })
      signal?.throwIfAborted()
    } catch (error) {
      cancellation(error, signal)
      throw operationFailed(operation)
    }
    if (result.exitCode !== 0) throw operationFailed(operation)
    return result
  }
}
