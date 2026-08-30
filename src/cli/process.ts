import spawn from 'cross-spawn'
import type { ChildProcess } from 'node:child_process'
import { constants as osConstants } from 'node:os'

export interface CommandResult { exitCode: number; stdout: string; stderr: string }
export interface CommandRunner {
  run(command: string, args: readonly string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<CommandResult>
}

export type ProcessFailureReason = 'spawn' | 'output-overflow' | 'abort'
export class ProcessExecutionError extends Error {
  readonly reason: ProcessFailureReason
  readonly cause?: unknown
  constructor(reason: ProcessFailureReason, message: string, cause?: unknown) {
    super(message)
    this.name = 'ProcessExecutionError'
    this.reason = reason
    this.cause = cause
  }
}

export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
export function signalExitCode(signal: NodeJS.Signals): number { return 128 + (osConstants.signals[signal] ?? 0) }

function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

export class NodeProcessRunner implements CommandRunner {
  readonly maxOutputBytes: number
  private readonly spawnProcess: typeof spawn
  readonly terminationGraceMs: number
  readonly terminationTimeoutMs: number
  constructor(options: { maxOutputBytes?: number; spawn?: typeof spawn; terminationGraceMs?: number; terminationTimeoutMs?: number } = {}) {
    if (options.maxOutputBytes !== undefined && (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 0)) throw new RangeError('maxOutputBytes must be a non-negative safe integer')
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.spawnProcess = options.spawn ?? spawn
    this.terminationGraceMs = options.terminationGraceMs ?? 250
    this.terminationTimeoutMs = options.terminationTimeoutMs ?? 1000
  }

  run(command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<CommandResult> {
    if (options.signal?.aborted) return Promise.reject(abortError())
    return new Promise((resolve, reject) => {
      let child: ChildProcess
      try {
        child = this.spawnProcess(command, [...args], { cwd: options.cwd, env: options.env, shell: false })
      } catch (cause) {
        reject(new ProcessExecutionError('spawn', 'Unable to start command'))
        return
      }
      let settled = false
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      const cleanup = (keepError = false) => {
        options.signal?.removeEventListener('abort', onAbort)
        child.stdout?.removeListener('data', onStdout)
        child.stderr?.removeListener('data', onStderr)
        if (!keepError) child.removeListener('error', onError)
        child.removeListener('close', onClose)
      }
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        cleanup(child.pid === undefined)
        if (child.pid !== undefined) child.kill()
        reject(error)
      }
      const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
        const nextSize = stdout.byteLength + stderr.byteLength + chunk.byteLength
        if (nextSize > this.maxOutputBytes) throw new ProcessExecutionError('output-overflow', `Command output exceeded ${this.maxOutputBytes} bytes`)
        return Buffer.concat([current, chunk])
      }
      const onStdout = (chunk: Buffer | string) => { try { stdout = append(stdout, Buffer.from(chunk)) } catch (error) { fail(error as Error) } }
      const onStderr = (chunk: Buffer | string) => { try { stderr = append(stderr, Buffer.from(chunk)) } catch (error) { fail(error as Error) } }
      const onAbort = () => fail(abortError())
      const onError = (_cause: Error) => {
        child.removeListener('error', onError)
        if (!settled) fail(new ProcessExecutionError('spawn', 'Unable to start command'))
      }
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return
        settled = true
        cleanup()
        const exitCode = code ?? (signal ? signalExitCode(signal) : 1)
        resolve({ exitCode, stdout: stdout.toString(), stderr: stderr.toString() })
      }
      child.stdout?.on('data', onStdout)
      child.stderr?.on('data', onStderr)
      child.once('error', onError)
      child.once('close', onClose)
      options.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}
