import spawn from 'cross-spawn'
import type { ChildProcess } from 'node:child_process'
import { constants as osConstants } from 'node:os'

export interface CommandResult { exitCode: number; stdout: string; stderr: string }
export interface CommandRunner {
  run(command: string, args: readonly string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<CommandResult>
}

export type ProcessFailureReason = 'spawn' | 'output-overflow' | 'abort' | 'process-cleanup'
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
  readonly terminationForceMs: number
  constructor(options: { maxOutputBytes?: number; spawn?: typeof spawn; terminationGraceMs?: number; terminationForceMs?: number } = {}) {
    for (const [name, value] of Object.entries({
      maxOutputBytes: options.maxOutputBytes,
      terminationGraceMs: options.terminationGraceMs,
      terminationForceMs: options.terminationForceMs,
    })) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new RangeError(`${name} must be a non-negative safe integer`)
    }
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.spawnProcess = options.spawn ?? spawn
    this.terminationGraceMs = options.terminationGraceMs ?? 250
    this.terminationForceMs = options.terminationForceMs ?? 1000
  }

  /** Termination signals are sent only to the direct child; no shell or descendant-process cleanup is implied. */
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
      let state: 'running' | 'terminating' | 'settled' = 'running'
      let terminationError: Error | undefined
      let graceTimer: ReturnType<typeof setTimeout> | undefined
      let forceTimer: ReturnType<typeof setTimeout> | undefined
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      const clearTerminationTimers = () => {
        if (graceTimer !== undefined) clearTimeout(graceTimer)
        if (forceTimer !== undefined) clearTimeout(forceTimer)
        graceTimer = undefined
        forceTimer = undefined
      }
      const cleanup = (keepErrorListener = false) => {
        clearTerminationTimers()
        options.signal?.removeEventListener('abort', onAbort)
        child.stdout?.removeListener('data', onStdout)
        child.stderr?.removeListener('data', onStderr)
        if (!keepErrorListener) child.removeListener('error', onError)
        child.removeListener('close', onClose)
      }
      const settleRejected = (error: Error, keepErrorListener = false) => {
        if (state === 'settled') return
        state = 'settled'
        cleanup(keepErrorListener)
        reject(error)
      }
      const signalDirectChild = (signal: NodeJS.Signals) => {
        try {
          child.kill(signal)
        } catch {
          // A close event is still required to confirm termination.
        }
      }
      const requestTermination = (error: Error) => {
        if (state !== 'running') return
        if (child.pid === undefined) {
          settleRejected(error, true)
          return
        }
        state = 'terminating'
        terminationError = error
        options.signal?.removeEventListener('abort', onAbort)
        child.stdout?.removeListener('data', onStdout)
        child.stderr?.removeListener('data', onStderr)
        signalDirectChild('SIGTERM')
        if (state !== 'terminating') return
        graceTimer = setTimeout(() => {
          graceTimer = undefined
          if (state !== 'terminating') return
          signalDirectChild('SIGKILL')
          if (state !== 'terminating') return
          forceTimer = setTimeout(() => {
            forceTimer = undefined
            if (state !== 'terminating') return
            settleRejected(new ProcessExecutionError('process-cleanup', 'Unable to confirm command termination'))
          }, this.terminationForceMs)
        }, this.terminationGraceMs)
      }
      const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
        const nextSize = stdout.byteLength + stderr.byteLength + chunk.byteLength
        if (nextSize > this.maxOutputBytes) throw new ProcessExecutionError('output-overflow', `Command output exceeded ${this.maxOutputBytes} bytes`)
        return Buffer.concat([current, chunk])
      }
      const onStdout = (chunk: Buffer | string) => { try { stdout = append(stdout, Buffer.from(chunk)) } catch (error) { requestTermination(error as Error) } }
      const onStderr = (chunk: Buffer | string) => { try { stderr = append(stderr, Buffer.from(chunk)) } catch (error) { requestTermination(error as Error) } }
      const onAbort = () => requestTermination(abortError())
      const onError = (_cause: Error) => {
        if (state === 'settled') {
          child.removeListener('error', onError)
          return
        }
        if (state === 'terminating') return
        const error = new ProcessExecutionError('spawn', 'Unable to start command')
        if (child.pid === undefined) settleRejected(error)
        else requestTermination(error)
      }
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        if (state === 'settled') return
        const rejected = terminationError
        state = 'settled'
        cleanup()
        if (rejected) {
          reject(rejected)
          return
        }
        const exitCode = code ?? (signal ? signalExitCode(signal) : 1)
        resolve({ exitCode, stdout: stdout.toString(), stderr: stderr.toString() })
      }
      child.stdout?.on('data', onStdout)
      child.stderr?.on('data', onStderr)
      child.on('error', onError)
      child.once('close', onClose)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (options.signal?.aborted) onAbort()
    })
  }
}
