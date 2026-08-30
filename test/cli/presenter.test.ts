import { describe, expect, it } from 'vitest'
import { CliError } from '../../src/cli/errors.ts'
import { presentError, presentSuccess } from '../../src/cli/presenter.ts'

function writers() {
  const stdout: string[] = []
  const stderr: string[] = []
  return { stdout, stderr, out: (text: string) => stdout.push(text), err: (text: string) => stderr.push(text) }
}

describe('CLI presenters', () => {
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
    const io = writers(); const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    presentSuccess({ undefined: undefined, bigint: BigInt(2), nan: NaN, cyclic, date: new Date('secret') }, { format: 'json', stdout: io.out, stderr: io.err })
    expect(() => JSON.parse(io.stdout[0]!)).not.toThrow()
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
})
