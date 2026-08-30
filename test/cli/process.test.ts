import { execPath } from 'node:process'
import { describe, expect, it } from 'vitest'
import { NodeProcessRunner, ProcessExecutionError, signalExitCode } from '../../src/cli/process.ts'

describe('NodeProcessRunner', () => {
  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid output limit %s', (maxOutputBytes) => {
    expect(() => new NodeProcessRunner({ maxOutputBytes })).toThrow()
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
  it('escalates termination when a child ignores SIGTERM', async () => {
    if (process.platform === 'win32') return
    const controller = new AbortController()
    const pending = new NodeProcessRunner({ terminationGraceMs: 20, terminationTimeoutMs: 100 }).run(execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects when output exceeds the configured bounded buffer', async () => {
    await expect(new NodeProcessRunner({ maxOutputBytes: 32 }).run(execPath, ['-e', "process.stdout.write('x'.repeat(1000))"])).rejects.toMatchObject({ name: 'ProcessExecutionError', reason: 'output-overflow' })
  })

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
    const controller = new AbortController()
    const pending = new NodeProcessRunner().run('__definitely_missing_command__', ['secret'], { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: expect.stringMatching(/AbortError|ProcessExecutionError/) })
  })

  it('maps a signal exit using the platform signal number', async () => {
    if (process.platform === 'win32') return
    const result = await new NodeProcessRunner().run(execPath, ['-e', "process.kill(process.pid, 'SIGHUP')"])
    expect(result.exitCode).toBe(129)
    expect(signalExitCode('SIGTERM')).toBe(128 + 15)
  })
})
