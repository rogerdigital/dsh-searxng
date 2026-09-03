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

describe('SearXNG HTTP diagnostics', () => {
  it('checks the configured endpoint with authentication', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    await new DefaultSearxngProbe().http({ baseURL: BASE, authHeader: 'Bearer private', fetch: fetchMock })
    expect(fetchMock).toHaveBeenCalledWith(BASE, expect.objectContaining({
      headers: { authorization: 'Bearer private' },
      signal: expect.any(AbortSignal),
    }))
  })

  it.each([[401, 'E_AUTH_FAILED'], [403, 'E_JSON_DISABLED'], [429, 'E_RATE_LIMITED']] as const)(
    'classifies HTTP diagnostic status %i as %s', async (status, code) => {
      const probe = new DefaultSearxngProbe()
      await expect(probe.http({ baseURL: BASE, fetch: vi.fn().mockResolvedValue(new Response('', { status })) }))
        .rejects.toMatchObject({ code })
    },
  )

  it('preserves caller cancellation', async () => {
    const controller = new AbortController()
    const cancellation = new DOMException('cancelled', 'AbortError')
    const fetchMock = vi.fn().mockImplementation(async () => { controller.abort(cancellation); throw cancellation })
    await expect(new DefaultSearxngProbe().http({ baseURL: BASE, fetch: fetchMock }, controller.signal)).rejects.toBe(cancellation)
  })

  it.each([
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'ERR_SSL_PROTOCOL_ERROR',
  ] as const)('classifies a TLS fetch cause (%s) as E_TLS_FAILED', async (causeCode) => {
    const failure = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('tls failure'), { code: causeCode }),
    })
    const probe = new DefaultSearxngProbe()
    await expect(probe.http({ baseURL: 'https://127.0.0.1:8443', fetch: vi.fn().mockRejectedValue(failure) }))
      .rejects.toMatchObject({ code: 'E_TLS_FAILED' })
    await expect(probe.realSearch({ baseURL: 'https://127.0.0.1:8443', fetch: vi.fn().mockRejectedValue(failure) }))
      .rejects.toMatchObject({ code: 'E_TLS_FAILED' })
  })

  it('keeps a plain connection failure as E_SEARCH_FAILED', async () => {
    const failure = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
    })
    const probe = new DefaultSearxngProbe()
    await expect(probe.http({ baseURL: 'https://127.0.0.1:8443', fetch: vi.fn().mockRejectedValue(failure) }))
      .rejects.toMatchObject({ code: 'E_SEARCH_FAILED' })
  })

  it('terminates a cyclic or overly deep cause chain without classifying it as TLS', async () => {
    const cyclic = Object.assign(new Error('fetch failed'))
    ;(cyclic as { cause?: unknown }).cause = cyclic
    const probe = new DefaultSearxngProbe()
    await expect(probe.http({ baseURL: 'https://127.0.0.1:8443', fetch: vi.fn().mockRejectedValue(cyclic) }))
      .rejects.toMatchObject({ code: 'E_SEARCH_FAILED' })

    let deep: Error = Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' })
    for (let index = 0; index < 50; index += 1) {
      deep = Object.assign(new Error('chained'), { cause: deep, code: 'ECONNREFUSED' })
    }
    await expect(probe.http({ baseURL: 'https://127.0.0.1:8443', fetch: vi.fn().mockRejectedValue(deep) }))
      .rejects.toMatchObject({ code: 'E_SEARCH_FAILED' })
  })
})

describe('probeSearxng', () => {
  it('preserves a fetch AbortError instead of reporting a search failure', async () => {
    const cancellation = new DOMException('cancelled request', 'AbortError')
    const fetchMock = vi.fn().mockRejectedValue(cancellation)

    await expect(probeSearxng({ baseURL: BASE, fetch: fetchMock })).rejects.toMatchObject({ name: 'AbortError' })
  })

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

  it('applies effective language, engine, category, and auth settings to raw probes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [{ url: 'https://example.com/result' }] }))
    await probeSearxng({
      baseURL: BASE,
      language: 'zh-CN',
      engines: 'bing,google',
      categories: 'general',
      authHeader: 'Bearer private-token',
      fetch: fetchMock,
    })
    const [request, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const requested = new URL(request)
    expect(requested.searchParams.get('language')).toBe('zh-CN')
    expect(requested.searchParams.get('engines')).toBe('bing,google')
    expect(requested.searchParams.get('categories')).toBe('general')
    expect(init.headers).toMatchObject({ authorization: 'Bearer private-token' })
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
    // A fresh Response per call: empty results retry with a varied query, and
    // a Response body can be read only once.
    const attempt = probeSearxng({ baseURL: BASE, fetch: vi.fn().mockImplementation(() => jsonResponse(body)) })
    await expect(attempt).rejects.toMatchObject({ code: 'E_SEARCH_FAILED' })
  })

  it('retries an empty real-search result with a varied query before failing', async () => {
    const urls: string[] = []
    const fetchMock = vi.fn().mockImplementation((input: unknown) => {
      urls.push(String(input))
      return Promise.resolve(jsonResponse({ results: [{ url: 'https://example.com/result' }] }))
    })
    await expect(probeSearxng({ baseURL: BASE, fetch: fetchMock })).resolves.toMatchObject({ resultCount: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(urls[0]).toContain('deepseek+harness')
  })

  it('recovers when upstream engines cool down for the repeated probe query', async () => {
    let calls = 0
    const queries: string[] = []
    const fetchMock = vi.fn().mockImplementation((input: unknown) => {
      calls += 1
      const url = new URL(String(input))
      queries.push(url.searchParams.get('q') ?? '')
      // First query cooled down upstream: zero results; the varied retry works.
      const empty = calls === 1
      return Promise.resolve(jsonResponse(empty ? { results: [] } : { results: [{ url: 'https://example.com/recovered' }] }))
    })
    await expect(probeSearxng({ baseURL: BASE, fetch: fetchMock })).resolves.toMatchObject({ resultCount: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(queries[0]).toBe('deepseek harness')
    expect(queries[1]).toMatch(/^deepseek harness [0-9a-f]{8}$/)
  })

  it('gives up on persistently empty real-search results after three varied attempts', async () => {
    const queries: string[] = []
    const fetchMock = vi.fn().mockImplementation((input: unknown) => {
      queries.push(new URL(String(input)).searchParams.get('q') ?? '')
      return Promise.resolve(jsonResponse({ results: [] }))
    })
    await expect(probeSearxng({ baseURL: BASE, fetch: fetchMock })).rejects.toMatchObject({ code: 'E_SEARCH_FAILED' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(new Set(queries).size).toBe(3)
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
  ])('rejects a non-empty malformed readiness result array: $results', async ({ results }) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results }))
    const error = await new DefaultSearxngProbe().readiness({ baseURL: BASE, attempts: 3, fetch: fetchMock })
      .then(() => undefined, (cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'E_SEARCH_FAILED' })
    expect((error as CliError).message).toMatch(/malformed/i)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('accepts mixed final results and counts only usable HTTP URLs', async () => {
    const attempt = probeSearxng({
      baseURL: BASE,
      fetch: vi.fn().mockResolvedValue(jsonResponse({
        results: [
          { url: 'https://example.com/ok' },
          { url: 'javascript:alert(1)' },
          null,
          { url: 'http://example.com/second' },
        ],
      })),
    })
    await expect(attempt).resolves.toMatchObject({ resultCount: 2 })
  })

  it('accepts mixed readiness results when at least one URL is usable', async () => {
    const attempt = new DefaultSearxngProbe().readiness({
      baseURL: BASE,
      fetch: vi.fn().mockResolvedValue(jsonResponse({
        results: [null, { url: 'https://example.com/ok' }, { url: '' }],
      })),
    })
    await expect(attempt).resolves.toBeUndefined()
  })

  it('preserves cancellation during the readiness retry delay without another request', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'))
    const attempt = new DefaultSearxngProbe().readiness(
      { baseURL: BASE, attempts: 3, fetch: fetchMock },
      controller.signal,
    )
    const expectation = expect(attempt).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await expectation
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('requires non-empty valid results for real searches', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ results: [{ url: 'https://example.com/a' }] }))
    const probe = new DefaultSearxngProbe()
    await expect(probe.realSearch({ baseURL: BASE, fetch: fetchMock })).resolves.toMatchObject({ resultCount: 1 })
  })

  it('preserves cancellation from realSearch requests', async () => {
    const controller = new AbortController()
    const cancellation = new Error('cancelled real search')
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    const attempt = new DefaultSearxngProbe().realSearch({ baseURL: BASE, fetch: fetchMock }, controller.signal)

    controller.abort(cancellation)

    await expect(attempt).rejects.toBe(cancellation)
  })

  it('validates through the shared client with the exact effective profile config', async () => {
    const search = vi.fn(async () => ({ sources: [{ url: 'https://example.com/provider' }], truncated: false as const }))
    const signal = new AbortController().signal
    const probe = new DefaultSearxngProbe({ search })
    const config = {
      baseURL: BASE,
      language: 'zh-CN',
      engines: 'bing,google',
      categories: 'general',
      authHeader: 'Bearer private-token',
    }

    await expect(probe.providerSearch(config, signal)).resolves.toMatchObject({ endpoint: BASE, resultCount: 1 })
    expect(search).toHaveBeenCalledWith(config, { query: PROBE_QUERY }, signal)
  })

  it('preserves provider request cancellation instead of reporting a search failure', async () => {
    const cancellation = new DOMException('cancelled provider request', 'AbortError')
    const probe = new DefaultSearxngProbe({
      search: async () => { throw cancellation },
    })

    await expect(probe.providerSearch({ baseURL: BASE })).rejects.toBe(cancellation)
  })

  it('returns a safe failure when the real provider path has no result or throws', async () => {
    const credential = 'Bearer private-token'
    const empty = new DefaultSearxngProbe({
      search: async () => ({ sources: [], truncated: false }),
    })
    await expect(empty.providerSearch({ baseURL: BASE, authHeader: credential })).rejects.toMatchObject({ code: 'E_SEARCH_FAILED' })

    const failed = new DefaultSearxngProbe({
      search: async () => { throw new Error(`failed ${credential}`) },
    })
    const error = await failed.providerSearch({ baseURL: BASE, authHeader: credential }).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'E_SEARCH_FAILED' })
    expect(JSON.stringify((error as CliError).toJSON())).not.toContain(credential)
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

  it.each([
    ['fast rejection', vi.fn().mockRejectedValue(new TypeError('offline'))],
    ['hung fetch', vi.fn(() => new Promise<Response>(() => {}))],
  ])('uses timeoutMs as the total readiness deadline for %s', async (_label, fetchMock) => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const attempt = new DefaultSearxngProbe().readiness({
      baseURL: BASE,
      timeoutMs: 1_000,
      fetch: fetchMock,
    })
    const expectation = expect(attempt).rejects.toMatchObject({ code: 'E_SEARXNG_START_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(999)
    expect(vi.getMockedSystemTime()?.getTime()).toBe(999)
    await vi.advanceTimersByTimeAsync(1)
    await expectation
    expect(vi.getMockedSystemTime()?.getTime()).toBe(1_000)
  })

  it.each([400, 404, 500])('fails readiness immediately for non-retryable HTTP %i', async (status) => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const fetchMock = vi.fn().mockResolvedValue(new Response('failed', { status }))
    const attempt = new DefaultSearxngProbe().readiness({ baseURL: BASE, timeoutMs: 60_000, fetch: fetchMock })
    await expect(attempt).rejects.toMatchObject({ code: 'E_SEARCH_FAILED' })
    expect(Date.now()).toBe(0)
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
