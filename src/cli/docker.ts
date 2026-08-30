import { dirname, join } from 'node:path'
import { CliError, redact } from './errors.ts'
import type { ManagedIdentity } from './assets.ts'
import { ProcessExecutionError, type CommandResult, type CommandRunner } from './process.ts'

export type { ManagedIdentity } from './assets.ts'

export interface DockerAdapter {
  preflight(signal?: AbortSignal): Promise<{ serverVersion: string; composeVersion: string }>
  inspectOwnership(identity: ManagedIdentity, signal?: AbortSignal): Promise<'absent' | 'owned'>
  up(identity: ManagedIdentity, signal?: AbortSignal): Promise<void>
  down(identity: ManagedIdentity, volumes: boolean, signal?: AbortSignal): Promise<void>
  logs(identity: ManagedIdentity, tail: number, signal?: AbortSignal): Promise<string>
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

function composeMajor(version: string): number | undefined {
  const matches = [...version.matchAll(/(?:^|[^\d])v?(\d+)\.(\d+)(?:\.\d+)?/gi)]
  const major = matches.at(-1)?.[1]
  if (major === undefined) return undefined
  const parsed = Number(major)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function isInspectRecord(value: unknown): value is { Config: { Labels: Record<string, string> } } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const config = (value as Record<string, unknown>).Config
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return false
  const labels = (config as Record<string, unknown>).Labels
  if (labels === null || typeof labels !== 'object' || Array.isArray(labels)) return false
  return Object.values(labels as Record<string, unknown>).every((label) => typeof label === 'string')
}

function sanitizeLogText(value: string): string {
  return value
    .replace(/("authorization"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/(authorization\s*[:=]\s*)[^\r\n,;]+/gi, '$1[REDACTED]')
    .replace(/((?:secret(?:[_-]?key)?|password|api[_-]?key|access[_-]?token|refresh[_-]?token|query)\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/("(?:secret(?:[_-]?key)?|password|api[_-]?key|access[_-]?token|refresh[_-]?token|query)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
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
    signal?.throwIfAborted()
    let result: CommandResult
    try {
      result = await this.runner.run('docker', ['container', 'inspect', identity.containerName], { signal })
      signal?.throwIfAborted()
    } catch (error) {
      cancellation(error, signal)
      throw operationFailed('inspect')
    }
    if (result.exitCode !== 0) {
      if (/no such (?:object|container)/i.test(`${result.stdout}\n${result.stderr}`)) return 'absent'
      throw operationFailed('inspect')
    }

    let parsed: unknown
    try { parsed = JSON.parse(result.stdout) } catch { throw foreignResource() }
    if (!Array.isArray(parsed) || parsed.length !== 1 || !isInspectRecord(parsed[0])) throw foreignResource()
    const labels = parsed[0].Config.Labels
    if (labels['io.dsh-searxng.managed'] !== 'true' || labels['io.dsh-searxng.home-id'] !== identity.homeId) {
      throw foreignResource()
    }
    return 'owned'
  }

  async up(identity: ManagedIdentity, signal?: AbortSignal): Promise<void> {
    await this.inspectOwnership(identity, signal)
    await this.runCompose(identity, ['up', '--detach'], 'up', signal)
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
