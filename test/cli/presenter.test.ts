import { describe, expect, it } from 'vitest'
import { CliError } from '../../src/cli/errors.ts'
import { presentError, presentSuccess } from '../../src/cli/presenter.ts'

function writers() {
  const stdout: string[] = []
  const stderr: string[] = []
  return { stdout, stderr, out: (text: string) => stdout.push(text), err: (text: string) => stderr.push(text) }
}

describe('CLI presenters', () => {
  const fallback = '{"code":"E_INTERNAL","message":"Unable to serialize output","action":"Inspect the command output"}\n'
  it('writes human success to stdout with one newline', () => {
    const io = writers()
    presentSuccess({ ok: true }, { format: 'human', stdout: io.out, stderr: io.err })
    expect(io.stdout).toEqual(['Success\n'])
    expect(io.stderr).toEqual([])
  })

  it('writes stable redacted JSON success to stdout', () => {
    const io = writers()
    presentSuccess({ query: 'private', nested: { authorization: 'Bearer secret' } }, { format: 'json', stdout: io.out, stderr: io.err })
    expect(io.stdout).toEqual(['{"nested":{"authorization":"[REDACTED]"},"query":"[REDACTED]"}\n'])
  })

  it('writes actionable human errors to stderr', () => {
    const io = writers()
    presentError(new CliError('E_AUTH_FAILED', 'Login failed', 'Check credentials', { secret: 'hidden' }), { format: 'human', stdout: io.out, stderr: io.err })
    expect(io.stdout).toEqual([])
    expect(io.stderr[0]).toContain('E_AUTH_FAILED: Login failed')
    expect(io.stderr[0]).toContain('Next: Check credentials')
    expect(io.stderr[0]).not.toContain('hidden')
  })

  it('writes CliError envelopes as redacted stable JSON', () => {
    const io = writers()
    presentError(new CliError('E_SEARCH_FAILED', 'No results', 'Try again', { query: 'secret' }), { format: 'json', stdout: io.out, stderr: io.err })
    expect(io.stderr).toEqual(['{"action":"Try again","code":"E_SEARCH_FAILED","message":"No results","query":"[REDACTED]"}\n'])
  })

  it('always emits parseable JSON for unexpected cyclic and unusual values', () => {
    const io = writers(); const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic; const sparse = new Array(2)
    presentSuccess({ undefined: undefined, bigint: BigInt(2), nan: NaN, cyclic, date: new Date('secret'), sparse }, { format: 'json', stdout: io.out, stderr: io.err })
    expect(() => JSON.parse(io.stdout[0]!)).not.toThrow()
    expect(JSON.parse(io.stdout[0]!).sparse).toEqual([null, null])
    const error = new Error('secret cause'); error.name = 'secret name'
    presentError(error, { format: 'json', stdout: io.out, stderr: io.err })
    expect(() => JSON.parse(io.stderr[0]!)).not.toThrow()
    expect(io.stderr[0]).not.toContain('secret')
    expect(JSON.parse(io.stderr[0]!)).toEqual({ action: 'Inspect the command output', cause: '[REDACTED]', code: 'E_INTERNAL', message: 'An unexpected error occurred' })
  })
  it('uses a safe valid fallback when redaction encounters a proxy failure', () => {
    const io = writers(); const proxy = new Proxy({}, { ownKeys() { throw new Error('secret') } })
    presentSuccess(proxy, { format: 'json', stdout: io.out, stderr: io.err })
    expect(() => JSON.parse(io.stdout[0]!)).not.toThrow()
    expect(io.stdout[0]).not.toContain('secret')
  })

  it('safely presents getPrototypeOf-throwing proxies without exposing trap text', () => {
    const proxy = new Proxy({}, { getPrototypeOf() { throw new Error('prototype-secret') } })
    const success = writers()
    const failure = writers()

    presentSuccess(proxy, { format: 'json', stdout: success.out, stderr: success.err })
    presentError(proxy, { format: 'json', stdout: failure.out, stderr: failure.err })

    expect(success.stdout).toEqual(['"[REDACTED]"\n'])
    expect(failure.stderr).toEqual([fallback])
    expect(success.stdout[0]).not.toContain('prototype-secret')
    expect(failure.stderr[0]).not.toContain('prototype-secret')
    expect(() => JSON.parse(success.stdout[0]!)).not.toThrow()
    expect(() => JSON.parse(failure.stderr[0]!)).not.toThrow()
  })

  it('safely presents revoked proxies without exposing proxy failures', () => {
    const successProxy = Proxy.revocable({}, {})
    const errorProxy = Proxy.revocable({}, {})
    successProxy.revoke()
    errorProxy.revoke()
    const success = writers()
    const failure = writers()

    presentSuccess(successProxy.proxy, { format: 'json', stdout: success.out, stderr: success.err })
    presentError(errorProxy.proxy, { format: 'json', stdout: failure.out, stderr: failure.err })

    expect(success.stdout).toEqual(['"[REDACTED]"\n'])
    expect(failure.stderr).toEqual([fallback])
    expect(() => JSON.parse(success.stdout[0]!)).not.toThrow()
    expect(() => JSON.parse(failure.stderr[0]!)).not.toThrow()
  })
})
