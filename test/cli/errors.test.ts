import { describe, expect, it } from 'vitest'
import { CliError, redact } from '../../src/cli/errors.ts'

describe('redact', () => {
  it('deeply redacts sensitive keys without mutating input', () => {
    const input = { authorization: 'Bearer abc', nested: [{ secret_key: 's', safe: 1 }], query: 'private' }
    expect(redact(input)).toEqual({ authorization: '[REDACTED]', nested: [{ secret_key: '[REDACTED]', safe: 1 }], query: '[REDACTED]' })
    expect(input).toEqual({ authorization: 'Bearer abc', nested: [{ secret_key: 's', safe: 1 }], query: 'private' })
  })
  it('normalizes bounded separators and avoids unrelated words', () => {
    expect(redact({ DSH_SEARXNG_SECRET: 'x', SECRET_KEY: 'y', AUTH_HEADER: 'z', API_KEY: 'a', access_token: 'b', cookie: 'c', SEARCH_QUERY: 'd', clientSecret: 'e', databasePassword: 'f', bearerToken: 'g', sessionCookie: 'h', monkey: 'safe', secretary: 'safe' })).toEqual({ DSH_SEARXNG_SECRET: '[REDACTED]', SECRET_KEY: '[REDACTED]', AUTH_HEADER: '[REDACTED]', API_KEY: '[REDACTED]', access_token: '[REDACTED]', cookie: '[REDACTED]', SEARCH_QUERY: '[REDACTED]', clientSecret: '[REDACTED]', databasePassword: '[REDACTED]', bearerToken: '[REDACTED]', sessionCookie: '[REDACTED]', monkey: 'safe', secretary: 'safe' })
  })

  it('does not serialize secrets hidden in Error objects or non-plain values', () => {
    class SecretHolder { value = 'hidden'; toJSON() { return { token: 'hidden' } } }
    const customError = new Error('safe'); customError.name = 'secret-error'
    const value = { cause: customError, date: new Date('2020-01-01'), regexp: /secret/, holder: new SecretHolder(), token: 'secret' }
    const result = redact(value)
    expect(result).toEqual({ cause: '[REDACTED]', date: '[REDACTED]', regexp: '[REDACTED]', holder: '[REDACTED]', token: '[REDACTED]' })
    expect(JSON.stringify(result)).not.toContain('hidden')
  })
  it('does not invoke throwing getters or proxy reflection', () => {
    const value = Object.create(null) as Record<string, unknown>
    Object.defineProperty(value, 'secret', { enumerable: true, get() { throw new Error('getter-secret') } })
    expect(redact(value)).toEqual({ secret: '[REDACTED]' })
    const proxy = new Proxy({}, { ownKeys() { throw new Error('proxy-secret') } })
    expect(redact(proxy)).toBe('[REDACTED]')
  })

  it('returns a fixed placeholder for getPrototypeOf-throwing and revoked proxies', () => {
    const prototypeProxy = new Proxy({}, { getPrototypeOf() { throw new Error('prototype-secret') } })
    const revocable = Proxy.revocable({}, {})
    const revocableArray = Proxy.revocable([], {})
    revocable.revoke()
    revocableArray.revoke()

    expect(() => redact(prototypeProxy)).not.toThrow()
    expect(redact(prototypeProxy)).toBe('[REDACTED]')
    expect(() => redact(revocable.proxy)).not.toThrow()
    expect(redact(revocable.proxy)).toBe('[REDACTED]')
    expect(() => redact(revocableArray.proxy)).not.toThrow()
    expect(redact(revocableArray.proxy)).toBe('[REDACTED]')
  })

  it('redacts array accessors without invoking indexed getters and preserves holes', () => {
    let getterInvocations = 0
    const value = new Array(3)
    Object.defineProperty(value, '0', { enumerable: true, get() { getterInvocations += 1; return 'array-secret' } })
    value[2] = 'safe'

    const result = redact(value)
    expect(getterInvocations).toBe(0)
    expect(result).toEqual(['[REDACTED]', , 'safe'])
    expect(Array.isArray(result)).toBe(true)
    if (Array.isArray(result)) expect(1 in result).toBe(false)
    expect(JSON.stringify(result)).toBe('["[REDACTED]",null,"safe"]')
  })

  it('skips non-enumerable properties instead of serializing hidden values', () => {
    const value = { visible: 'safe' }
    Object.defineProperty(value, 'hidden', { enumerable: false, value: 'hidden-secret' })

    const output = JSON.stringify(redact(value))
    expect(output).toBe('{"visible":"safe"}')
    expect(output).not.toContain('hidden-secret')
  })
})

describe('CliError', () => {
  it('returns a stable redacted envelope', () => {
    const error = new CliError('E_SEARCH_FAILED', 'Search failed', 'Check the SearXNG service', { query: 'private', nested: { password: 'p', ok: true } })
    expect(error.code).toBe('E_SEARCH_FAILED')
    expect(error.message).toBe('Search failed')
    expect(error.action).toBe('Check the SearXNG service')
    expect(error.toJSON()).toEqual({ code: 'E_SEARCH_FAILED', message: 'Search failed', action: 'Check the SearXNG service', nested: { password: '[REDACTED]', ok: true }, query: '[REDACTED]' })
    expect(new CliError('E_INTERNAL', 'x', 'y').toJSON()).toEqual({ code: 'E_INTERNAL', message: 'x', action: 'y' })
    expect(new CliError('E_INTERNAL', 'x', 'y', { code: 'bad', message: 'bad', action: 'bad' }).toJSON()).toMatchObject({ code: 'E_INTERNAL', message: 'x', action: 'y' })
  })
})
