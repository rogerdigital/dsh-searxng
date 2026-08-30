import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execPath } from 'node:process'
import { PassThrough } from 'node:stream'
import spawn from 'cross-spawn'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWindowsProcessTreeTerminationStrategy, NodeProcessRunner, ProcessExecutionError, signalExitCode } from '../../src/cli/process.ts'

interface FakeChild extends EventEmitter {
  pid?: number
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
}

function createFakeChild(pid: number | undefined): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.pid = pid
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn(() => true)
  child.unref = vi.fn()
  return child
}

function asSpawn(child: FakeChild): typeof spawn {
  return vi.fn(() => child as unknown as ChildProcess) as unknown as typeof spawn
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function waitForPid(path: string): Promise<number> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(await readFile(path, 'utf8'), 10)
      if (Number.isSafeInteger(pid) && pid > 0) return pid
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for descendant PID')
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function runWindowsCommandTreeCase(mode: 'abort' | 'overflow'): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-searxng-process-'))
  const commandPath = join(directory, 'long-lived.cmd')
  const pidPath = join(directory, 'descendant.pid')
  const script = "const fs=require('node:fs');fs.writeFileSync(process.env.PID_FILE,String(process.pid));if(process.env.MODE==='overflow')setTimeout(()=>process.stdout.write('x'.repeat(1024)),1000);setInterval(()=>{},1000)"
  await writeFile(commandPath, `@echo off\r\n"%NODE_EXE%" -e "${script}"\r\n`, 'utf8')
  const controller = new AbortController()
  let descendantPid: number | undefined
  let deadAtRejection = false
  const pending = new NodeProcessRunner({ maxOutputBytes: 32, terminationGraceMs: 100, terminationForceMs: 2000 }).run(commandPath, [], {
    env: { ...process.env, MODE: mode, NODE_EXE: execPath, PID_FILE: pidPath },
    signal: controller.signal,
  })
  const observed = pending.then(
    () => new Error('expected termination rejection'),
    (error) => {
      deadAtRejection = descendantPid !== undefined && !isProcessAlive(descendantPid)
      return error
    },
  )
  try {
    descendantPid = await waitForPid(pidPath)
    if (mode === 'abort') controller.abort()
    const error = await observed
    expect(error).toMatchObject(mode === 'abort' ? { name: 'AbortError' } : { reason: 'output-overflow' })
    expect(deadAtRejection).toBe(true)
  } finally {
    if (descendantPid !== undefined && isProcessAlive(descendantPid)) process.kill(descendantPid, 'SIGKILL')
    await rm(directory, { recursive: true, force: true })
  }
}

describe('NodeProcessRunner', () => {
  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid output limit %s', (maxOutputBytes) => {
    expect(() => new NodeProcessRunner({ maxOutputBytes })).toThrow()
  })
  it.each(['terminationGraceMs', 'terminationForceMs'] as const)('rejects invalid %s values', (option) => {
    for (const value of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new NodeProcessRunner({ [option]: value })).toThrow()
    }
  })
  it('uses realistic default termination deadlines', () => {
    const runner = new NodeProcessRunner()
    expect(runner.terminationGraceMs).toBe(1000)
    expect(runner.terminationForceMs).toBe(5000)
  })
  it('captures stdout from an argument-array command', async () => {
    await expect(new NodeProcessRunner().run(execPath, ['-e', "process.stdout.write('hello')"])).resolves.toEqual({ exitCode: 0, stdout: 'hello', stderr: '' })
  })

  it('passes shell metacharacters literally without invoking a shell', async () => {
    const args = ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '$()', ';', 'a value']
    await expect(new NodeProcessRunner().run(execPath, args)).resolves.toMatchObject({ exitCode: 0, stdout: JSON.stringify(['$()', ';', 'a value']) })
  })

  it('captures stderr and nonzero exit codes', async () => {
    await expect(new NodeProcessRunner().run(execPath, ['-e', "process.stderr.write('bad'); process.exit(3)"])).resolves.toEqual({ exitCode: 3, stdout: '', stderr: 'bad' })
  })
  it('enforces an aggregate stdout and stderr limit', async () => {
    await expect(new NodeProcessRunner({ maxOutputBytes: 10 }).run(execPath, ['-e', "process.stdout.write('123456'); process.stderr.write('123456')"])).rejects.toMatchObject({ reason: 'output-overflow' })
  })
  it('waits for close after abort escalates a SIGTERM-ignoring child to SIGKILL', async () => {
    if (process.platform === 'win32') return
    let child: ChildProcess | undefined
    let childClosed = false
    let closeSignal: NodeJS.Signals | null = null
    let markReady: (() => void) | undefined
    const ready = new Promise<void>((resolve) => { markReady = resolve })
    const observedSpawn = ((...args: Parameters<typeof spawn>) => {
      child = spawn(...args)
      child.stdout?.once('data', () => markReady?.())
      child.once('close', (_code, signal) => {
        childClosed = true
        closeSignal = signal
      })
      return child
    }) as typeof spawn
    const controller = new AbortController()
    const pending = new NodeProcessRunner({ spawn: observedSpawn, terminationGraceMs: 20, terminationForceMs: 100 }).run(execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"], { signal: controller.signal })
    try {
      await ready
      const pid = child?.pid
      expect(pid).toBeTypeOf('number')
      controller.abort()
      const error = await pending.then(
        () => new Error('expected abort rejection'),
        (value) => {
          expect(childClosed).toBe(true)
          return value
        },
      )
      expect(error).toMatchObject({ name: 'AbortError' })
      expect(closeSignal).toBe('SIGKILL')
      expect(() => process.kill(pid!, 0)).toThrow()
    } finally {
      child?.kill('SIGKILL')
    }
  })

  it('waits for close after output overflow escalates a SIGTERM-ignoring child to SIGKILL', async () => {
    if (process.platform === 'win32') return
    let child: ChildProcess | undefined
    let childClosed = false
    let closeSignal: NodeJS.Signals | null = null
    const observedSpawn = ((...args: Parameters<typeof spawn>) => {
      child = spawn(...args)
      child.once('close', (_code, signal) => {
        childClosed = true
        closeSignal = signal
      })
      return child
    }) as typeof spawn
    const pending = new NodeProcessRunner({ maxOutputBytes: 32, spawn: observedSpawn, terminationGraceMs: 20, terminationForceMs: 100 }).run(execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('x'.repeat(1000)); setInterval(() => {}, 1000)"])
    try {
      const pid = child?.pid
      expect(pid).toBeTypeOf('number')
      const error = await pending.then(
        () => new Error('expected output overflow rejection'),
        (value) => {
          expect(childClosed).toBe(true)
          return value
        },
      )
      expect(error).toMatchObject({ name: 'ProcessExecutionError', reason: 'output-overflow' })
      expect(closeSignal).toBe('SIGKILL')
      expect(() => process.kill(pid!, 0)).toThrow()
    } finally {
      child?.kill('SIGKILL')
    }
  })

  it('owns late child errors until close after cleanup timeout rejection', async () => {
    vi.useFakeTimers()
    const child = createFakeChild(12345)
    const baselineErrorListeners = child.listenerCount('error')
    const baselineCloseListeners = child.listenerCount('close')
    const terminationStrategy = { terminate: vi.fn() }
    const controller = new AbortController()
    const pending = new NodeProcessRunner({ spawn: asSpawn(child), terminationStrategy, terminationGraceMs: 10, terminationForceMs: 20 }).run('command', ['--token', 'secret'], { signal: controller.signal })
    let rejectionCount = 0
    const observed = pending.then(
      () => new Error('expected cleanup rejection'),
      (error) => {
        rejectionCount += 1
        return error
      },
    )

    controller.abort()
    expect(terminationStrategy.terminate).toHaveBeenNthCalledWith(1, child, false)
    await vi.advanceTimersByTimeAsync(10)
    expect(terminationStrategy.terminate).toHaveBeenNthCalledWith(2, child, true)
    expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(20)

    const error = await observed
    expect(error).toMatchObject({ name: 'ProcessExecutionError', reason: 'process-cleanup' })
    expect(error.message).toBe('Unable to confirm command termination')
    expect(JSON.stringify(error)).not.toContain('secret')
    expect(rejectionCount).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(child.stdout.destroyed).toBe(true)
    expect(child.stderr.destroyed).toBe(true)
    expect(child.unref).toHaveBeenCalledOnce()
    expect(child.listenerCount('close')).toBe(baselineCloseListeners + 1)
    expect(child.listenerCount('error')).toBe(baselineErrorListeners + 1)
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    expect(() => child.emit('error', new Error('late child error'))).not.toThrow()
    child.emit('close', null, 'SIGKILL')
    expect(child.listenerCount('close')).toBe(baselineCloseListeners)
    expect(child.listenerCount('error')).toBe(baselineErrorListeners)
    expect(rejectionCount).toBe(1)
  })

  it('uses an injected termination strategy for graceful and forced requests', async () => {
    vi.useFakeTimers()
    const child = createFakeChild(12345)
    const terminationStrategy = { terminate: vi.fn() }
    const controller = new AbortController()
    const observed = new NodeProcessRunner({ spawn: asSpawn(child), terminationStrategy, terminationGraceMs: 10, terminationForceMs: 20 })
      .run('command', [], { signal: controller.signal })
      .catch((error) => error)

    controller.abort()
    expect(terminationStrategy.terminate).toHaveBeenNthCalledWith(1, child, false)
    await vi.advanceTimersByTimeAsync(10)
    expect(terminationStrategy.terminate).toHaveBeenNthCalledWith(2, child, true)
    child.emit('close', null, 'SIGKILL')
    await expect(observed).resolves.toMatchObject({ name: 'AbortError' })
  })

  it('constructs shell-free taskkill commands for Windows process trees', () => {
    const taskkill = createFakeChild(54321)
    const spawnTaskkill = asSpawn(taskkill)
    const strategy = createWindowsProcessTreeTerminationStrategy(spawnTaskkill)
    const child = createFakeChild(12345)

    strategy.terminate(child as unknown as ChildProcess, false)
    strategy.terminate(child as unknown as ChildProcess, true)

    expect(spawnTaskkill).toHaveBeenNthCalledWith(1, 'taskkill.exe', ['/PID', '12345', '/T'], { shell: false, stdio: 'ignore', windowsHide: true })
    expect(spawnTaskkill).toHaveBeenNthCalledWith(2, 'taskkill.exe', ['/PID', '12345', '/T', '/F'], { shell: false, stdio: 'ignore', windowsHide: true })
    expect(taskkill.unref).toHaveBeenCalledTimes(2)
  })

  it('buffers output chunks without concatenating until successful close', async () => {
    const child = createFakeChild(12345)
    const concat = vi.spyOn(Buffer, 'concat')
    const pending = new NodeProcessRunner({ spawn: asSpawn(child) }).run('command', [])
    child.stdout.write('hel')
    child.stdout.write('lo')
    child.stderr.write('warn')
    expect(concat).not.toHaveBeenCalled()
    child.emit('close', 0, null)

    await expect(pending).resolves.toEqual({ exitCode: 0, stdout: 'hello', stderr: 'warn' })
    expect(concat).toHaveBeenCalledTimes(2)
  })

  it.skipIf(process.platform !== 'win32')('terminates a real .cmd descendant before abort rejection', async () => {
    await runWindowsCommandTreeCase('abort')
  }, 15000)

  it.skipIf(process.platform !== 'win32')('terminates a real .cmd descendant before overflow rejection', async () => {
    await runWindowsCommandTreeCase('overflow')
  }, 15000)

  it('rejects an already-aborted signal without spawning', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(new NodeProcessRunner().run(execPath, ['-e', 'setTimeout(() => {}, 1000)'], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('terminates and rejects a running process on abort', async () => {
    const controller = new AbortController()
    const pending = new NodeProcessRunner().run(execPath, ['-e', 'setTimeout(() => {}, 10000)'], { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects missing commands with deterministic safe information', async () => {
    const error = await new NodeProcessRunner().run('__definitely_missing_command__', ['--token', 'secret']).catch((value) => value)
    expect(error).toBeInstanceOf(ProcessExecutionError)
    expect(error).toMatchObject({ name: 'ProcessExecutionError', reason: 'spawn' })
    expect(String(error.message)).not.toContain('secret')
    expect(JSON.stringify(error)).not.toContain('spawnargs')
  })

  it('handles missing command and immediate abort without killing the caller', async () => {
    const child = createFakeChild(undefined)
    const controller = new AbortController()
    const pending = new NodeProcessRunner({ spawn: asSpawn(child) }).run('__definitely_missing_command__', ['secret'], { signal: controller.signal })
    controller.abort()
    const error = await pending.catch((value) => value)
    child.emit('error', new Error('ENOENT: secret'))
    expect(error).toMatchObject({ name: 'AbortError' })
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('cleans all listeners and timers after a normal close', async () => {
    vi.useFakeTimers()
    const child = createFakeChild(12345)
    const controller = new AbortController()
    const pending = new NodeProcessRunner({ spawn: asSpawn(child), terminationGraceMs: 10, terminationForceMs: 20 }).run('command', [], { signal: controller.signal })
    child.stdout.write('hello')
    child.emit('close', 0, null)

    await expect(pending).resolves.toEqual({ exitCode: 0, stdout: 'hello', stderr: '' })
    expect(vi.getTimerCount()).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('maps a signal exit using the platform signal number', async () => {
    if (process.platform === 'win32') return
    const result = await new NodeProcessRunner().run(execPath, ['-e', "process.kill(process.pid, 'SIGHUP')"])
    expect(result.exitCode).toBe(129)
    expect(signalExitCode('SIGTERM')).toBe(128 + 15)
  })
})
