import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliError } from '../../src/cli/errors.ts'
import {
  DefaultSearxngProbe,
  probeSearxng,
} from '../../src/cli/searxng.ts'

const BASE = 'http://127.0.0.1:8080'
const PROBE_QUERY = 'deepseek harness'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('probeSearxng', () => {
  it('returns only safe summary data after a real result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      query: PROBE_QUERY,
      results: [{ url: 'https://example.com/result' }],
    }))

    const result = await probeSearxng({ baseURL: BASE, fetch: fetchMock })

    expect(result).toMatchObject({ endpoint: BASE, resultCount: 1 })
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(result)).not.toContain(PROBE_QUERY)
    const requested = new URL(fetchMock.mock.calls[0]![0] as string)
    expect(requested.searchParams.get('q')).toBe(PROBE_QUERY)
    expect(requested.searchParams.get('format')).toBe('json')
  })

  it.each([
    [401, 'E_AUTH_FAILED'],
    [403, 'E_JSON_DISABLED'],
    [429, 'E_RATE_LIMITED'],
  ] as const)('classifies HTTP %i without leaking body or query', async (status, code) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(`secret ${PROBE_QUERY}`, { status }))

    const error = await probeSearxng({ baseURL: BASE, authHeader: 'Bearer secret', fetch: fetchMock })
      .then(() => undefined, (cause: unknown) => cause)

    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).code).toBe(code)
    const serialized = JSON.stringify((error as CliError).toJSON())
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain(PROBE_QUERY)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    new Response('<html>disabled</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    new Response('{broken', { status: 200, headers: { 'content-type': 'application/json' } }),
  ])('classifies a non-JSON or malformed 200 response as E_JSON_DISABLED', async (response) => {
    const attempt = probeSearxng({ baseURL: BASE, fetch: vi.fn().mockResolvedValue(response) })
    await expect(attempt).rejects.toMatchObject({ code: 'E_JSON_DISABLED' })
  })

  it.each([
    { results: [] },
    { results: [{ url: '' }] },
    { results: [{ url: 'javascript:alert(1)' }] },
    { results: [{ url: 'not a URL' }] },
    {},
  ])('rejects a final response without a valid non-empty HTTP result URL', async (body) => {
    const attempt = probeSearxng({ baseURL: BASE, fetch: vi.fn().mockResolvedValue(jsonResponse(body)) })
    await expect(attempt).rejects.toMatchObject({ code: 'E_SEARCH_FAILED' })
  })

  it.each([
    'http://user:pass@localhost:8080',
    `${BASE}?token=secret`,
    `${BASE}#fragment`,
    'localhost:8080',
  ])('rejects an unsafe base URL before fetching: %s', async (baseURL) => {
    const fetchMock = vi.fn()
    await expect(probeSearxng({ baseURL, fetch: fetchMock })).rejects.toMatchObject({ code: 'E_SEARCH_FAILED' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('turns a synchronous fetch throw into a safe search failure', async () => {
    const fetchMock = vi.fn(() => { throw new Error(`failed ${PROBE_QUERY}`) })
    const error = await probeSearxng({ baseURL: BASE, attempts: 1, fetch: fetchMock })
      .then(() => undefined, (cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'E_SEARCH_FAILED' })
    expect(JSON.stringify((error as CliError).toJSON())).not.toContain(PROBE_QUERY)
  })
})

describe('DefaultSearxngProbe', () => {
  it('allows an empty structurally valid response during readiness', async () => {
    const probe = new DefaultSearxngProbe()
    await expect(probe.readiness({
      baseURL: BASE,
      fetch: vi.fn().mockResolvedValue(jsonResponse({ results: [] })),
    })).resolves.toBeUndefined()
  })

  it.each([502, 503, 504])('retries HTTP %i during readiness', async (status) => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('temporary', { status }))
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
    const attempt = new DefaultSearxngProbe().readiness({ baseURL: BASE, attempts: 2, fetch: fetchMock })
    await vi.runAllTimersAsync()
    await expect(attempt).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries a rejected transport during readiness', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
    const attempt = new DefaultSearxngProbe().readiness({ baseURL: BASE, attempts: 2, fetch: fetchMock })
    await vi.runAllTimersAsync()
    await expect(attempt).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries readiness by default instead of making a single startup request', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
    const attempt = new DefaultSearxngProbe().readiness({ baseURL: BASE, fetch: fetchMock })
    const expectation = expect(attempt).resolves.toBeUndefined()
    await vi.runAllTimersAsync()
    await expectation
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('honors the readiness attempt bound', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'))
    const attempt = new DefaultSearxngProbe().readiness({ baseURL: BASE, attempts: 3, fetch: fetchMock })
    const expectation = expect(attempt).rejects.toMatchObject({ code: 'E_SEARXNG_START_TIMEOUT' })
    await vi.runAllTimersAsync()
    await expectation
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('returns a stable malformed-response error without retrying invalid readiness results', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: 'invalid' }))
    const attempt = new DefaultSearxngProbe().readiness({ baseURL: BASE, attempts: 3, fetch: fetchMock })
    await expect(attempt).rejects.toMatchObject({ code: 'E_SEARCH_FAILED' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    { results: [null] },
    { results: ['invalid'] },
    { results: [{}] },
    { results: [{ url: '' }] },
    { results: [{ url: 'not a URL' }] },
    { results: [{ url: 'ftp://example.com/file' }] },
    { results: [{ url: 'https://example.com/ok' }, null] },
  ])('rejects a non-empty malformed readiness result array: $results', async ({ results }) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results }))
    const error = await new DefaultSearxngProbe().readiness({ baseURL: BASE, attempts: 3, fetch: fetchMock })
      .then(() => undefined, (cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'E_SEARCH_FAILED' })
    expect((error as CliError).message).toMatch(/malformed/i)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('rejects mixed valid and malformed final results', async () => {
    const attempt = probeSearxng({
      baseURL: BASE,
      fetch: vi.fn().mockResolvedValue(jsonResponse({
        results: [{ url: 'https://example.com/ok' }, { url: 'javascript:alert(1)' }],
      })),
    })
    await expect(attempt).rejects.toMatchObject({ code: 'E_SEARCH_FAILED' })
  })

  it('cancels during the readiness retry delay without another request', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'))
    const attempt = new DefaultSearxngProbe().readiness(
      { baseURL: BASE, attempts: 3, fetch: fetchMock },
      controller.signal,
    )
    const expectation = expect(attempt).rejects.toMatchObject({ code: 'E_SEARCH_FAILED' })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await expectation
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('requires non-empty valid results for real and provider searches', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ results: [{ url: 'https://example.com/a' }] }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ url: 'https://example.com/b' }] }))
    const probe = new DefaultSearxngProbe()
    await expect(probe.realSearch({ baseURL: BASE, fetch: fetchMock })).resolves.toMatchObject({ resultCount: 1 })
    await expect(probe.providerSearch({ baseURL: BASE, fetch: fetchMock })).resolves.toMatchObject({ resultCount: 1 })
  })

  it('bounds Retry-After rather than waiting for the server value', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('limited', {
      status: 429,
      headers: { 'retry-after': '999999' },
    }))
    const attempt = new DefaultSearxngProbe().readiness({ baseURL: BASE, attempts: 5, fetch: fetchMock })
    await expect(attempt).rejects.toMatchObject({ code: 'E_RATE_LIMITED' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
