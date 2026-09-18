import { afterEach, describe, expect, it, vi } from 'vitest'
import { SearxngSearchSession } from '../src/search-session.ts'

const BASE = 'http://127.0.0.1:8080'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const RESULT = { results: [{ url: 'https://example.com/r', title: 'R', content: 'S' }] }

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('SearxngSearchSession cache', () => {
  it('serves a repeated query from cache without a second fetch', async () => {
    const fetch = vi.fn(async () => jsonResponse(RESULT))
    const session = new SearxngSearchSession({ baseURL: BASE, fetch, cacheTtlMs: 60_000, minIntervalMs: 0 })
    await session.search('same query', undefined)
    await session.search('same query', undefined)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not serve a different query, params, or base URL from the cache', async () => {
    const fetch = vi.fn(async () => jsonResponse(RESULT))
    const session = new SearxngSearchSession({ baseURL: BASE, fetch, cacheTtlMs: 60_000, minIntervalMs: 0 })
    await session.search('a', undefined)
    await session.search('b', undefined)
    const other = new SearxngSearchSession({ baseURL: BASE, fetch, engines: 'bing', cacheTtlMs: 60_000, minIntervalMs: 0 })
    await other.search('a', undefined)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('expires entries after the TTL', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async () => jsonResponse(RESULT))
    const session = new SearxngSearchSession({ baseURL: BASE, fetch, cacheTtlMs: 1_000, minIntervalMs: 0 })
    await session.search('q', undefined)
    vi.advanceTimersByTime(1_001)
    await session.search('q', undefined)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('evicts the least recently used entry beyond capacity', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async () => jsonResponse(RESULT))
    const session = new SearxngSearchSession({ baseURL: BASE, fetch, cacheTtlMs: 60_000, cacheCapacity: 2, minIntervalMs: 0 })
    await session.search('q1', undefined)
    await session.search('q2', undefined)
    await session.search('q1', undefined)
    await session.search('q3', undefined)
    await session.search('q2', undefined)
    // q1's hit refreshed its recency, so q2 is the eviction victim and the
    // final search refetches it: a pure FIFO cache would serve q2 and stop at 3.
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('rejects an already-aborted caller without fetch, even on a cache hit', async () => {
    const fetch = vi.fn(async () => jsonResponse(RESULT))
    const session = new SearxngSearchSession({ baseURL: BASE, fetch, cacheTtlMs: 60_000, minIntervalMs: 0 })
    await session.search('q', undefined)
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    await expect(session.search('q', controller.signal)).rejects.toMatchObject({ kind: 'caller-abort' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('disables caching when cacheTtlMs is 0', async () => {
    const fetch = vi.fn(async () => jsonResponse(RESULT))
    const session = new SearxngSearchSession({ baseURL: BASE, fetch, cacheTtlMs: 0, minIntervalMs: 0 })
    await session.search('q', undefined)
    await session.search('q', undefined)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not cache an empty result page', async () => {
    const fetch = vi.fn(async () => jsonResponse({ results: [] }))
    const session = new SearxngSearchSession({ baseURL: BASE, fetch, cacheTtlMs: 60_000, minIntervalMs: 0 })
    await session.search('q', undefined)
    await session.search('q', undefined)
    // An empty page is a success but carries no reusable information; caching
    // it would mask upstream recovery for the whole TTL.
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not cache failures', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('denied', { status: 403 }))
      .mockResolvedValueOnce(jsonResponse(RESULT))
    const session = new SearxngSearchSession({ baseURL: BASE, fetch, cacheTtlMs: 60_000, minIntervalMs: 0 })
    await expect(session.search('q', undefined)).rejects.toMatchObject({ kind: 'http', status: 403 })
    await expect(session.search('q', undefined)).resolves.toBeTruthy()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('rejects an invalid base URL before any cache or fetch work', async () => {
    const fetch = vi.fn(async () => jsonResponse(RESULT))
    const session = new SearxngSearchSession({ baseURL: 'http://user:pass@x', fetch, cacheTtlMs: 60_000, minIntervalMs: 0 })
    await expect(session.search('q', undefined)).rejects.toMatchObject({ kind: 'invalid-url' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('SearxngSearchSession pacing', () => {
  function pendingFetch(): { fetch: ReturnType<typeof vi.fn>; release: () => void } {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetch = vi.fn(async () => {
      await gate
      return jsonResponse(RESULT)
    })
    return { fetch, release }
  }

  it('admits a burst up to bucket capacity immediately', async () => {
    vi.useFakeTimers()
    const { fetch } = pendingFetch()
    const session = new SearxngSearchSession({ baseURL: BASE, fetch, minIntervalMs: 1_500 })
    void session.search('one', undefined)
    void session.search('two', undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('paces a third concurrent request until a token refills', async () => {
    vi.useFakeTimers()
    const { fetch } = pendingFetch()
    const session = new SearxngSearchSession({ baseURL: BASE, fetch, minIntervalMs: 1_500 })
    void session.search('one', undefined)
    void session.search('two', undefined)
    void session.search('three', undefined)
    await vi.advanceTimersByTimeAsync(1_499)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('rejects immediately when the waiting queue is full', async () => {
    vi.useFakeTimers()
    const { fetch } = pendingFetch()
    const session = new SearxngSearchSession({ baseURL: BASE, fetch, minIntervalMs: 1_500, queueCapacity: 1 })
    void session.search('one', undefined)
    void session.search('two', undefined)
    void session.search('three', undefined)
    await expect(session.search('four', undefined)).rejects.toMatchObject({ kind: 'busy' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('rejects a queued caller on abort and frees its queue slot', async () => {
    vi.useFakeTimers()
    const { fetch } = pendingFetch()
    const session = new SearxngSearchSession({ baseURL: BASE, fetch, minIntervalMs: 1_500, queueCapacity: 1 })
    void session.search('one', undefined)
    void session.search('two', undefined)
    const controller = new AbortController()
    const queued = session.search('three', controller.signal)
    void queued.catch(() => {})
    controller.abort(new Error('stop'))
    await expect(queued).rejects.toMatchObject({ kind: 'caller-abort' })
    // The freed slot admits a new waiter instead of rejecting it as busy.
    const next = session.search('four', undefined)
    void next.catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    await expect(Promise.race([next.then(() => 'settled'), Promise.resolve('waiting')])).resolves.toBe('waiting')
  })

  it('runs concurrent searches unpaced when minIntervalMs is 0', async () => {
    vi.useFakeTimers()
    const { fetch } = pendingFetch()
    const session = new SearxngSearchSession({ baseURL: BASE, fetch, minIntervalMs: 0 })
    for (const query of ['a', 'b', 'c', 'd', 'e']) void session.search(query, undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(5)
  })
})

describe('SearxngSearchSession budget', () => {
  it('clamps the per-attempt timeout to the remaining budget', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(() => new Promise<Response>(() => {}))
    const session = new SearxngSearchSession({
      baseURL: BASE, fetch, minIntervalMs: 0, totalBudgetMs: 500,
    })
    const attempt = session.search('q', undefined)
    void attempt.catch(() => {})
    await vi.advanceTimersByTimeAsync(499)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(attempt).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('does not retry when Retry-After exceeds the remaining budget', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async () => new Response('slow down', {
      status: 429,
      headers: { 'retry-after': '30' },
    }))
    const session = new SearxngSearchSession({
      baseURL: BASE, fetch, minIntervalMs: 0, totalBudgetMs: 1_000,
    })
    await expect(session.search('q', undefined)).rejects.toMatchObject({ kind: 'http', status: 429 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('honors Retry-After within budget and retries once', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(jsonResponse(RESULT))
    const session = new SearxngSearchSession({
      baseURL: BASE, fetch, minIntervalMs: 0, totalBudgetMs: 10_000,
    })
    const attempt = session.search('q', undefined)
    void attempt.catch(() => {})
    await vi.advanceTimersByTimeAsync(999)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(attempt).resolves.toMatchObject({ truncated: false })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('exhausts the budget during the pacing wait without any network attempt', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetch = vi.fn(async () => {
      await gate
      return jsonResponse(RESULT)
    })
    const session = new SearxngSearchSession({
      baseURL: BASE, fetch, minIntervalMs: 5_000, totalBudgetMs: 1_000, cacheTtlMs: 0,
    })
    void session.search('one', undefined).catch(() => {})
    void session.search('two', undefined).catch(() => {})
    const third = session.search('three', undefined)
    void third.catch(() => {})
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(third).rejects.toMatchObject({ kind: 'budget' })
    expect(fetch).toHaveBeenCalledTimes(2)
    release()
  })

  it('caps total attempts at three under repeated 5xx within budget', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async () => new Response('bad gateway', { status: 503 }))
    const session = new SearxngSearchSession({
      baseURL: BASE, fetch, minIntervalMs: 0, retryDelayMs: 100, totalBudgetMs: 60_000, cacheTtlMs: 0,
    })
    const attempt = session.search('q', undefined)
    void attempt.catch(() => {})
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(attempt).rejects.toMatchObject({ kind: 'http', status: 503 })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('retries a network failure within budget and succeeds', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(RESULT))
    const session = new SearxngSearchSession({
      baseURL: BASE, fetch, minIntervalMs: 0, retryDelayMs: 100, cacheTtlMs: 0,
    })
    const attempt = session.search('q', undefined)
    void attempt.catch(() => {})
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(attempt).resolves.toMatchObject({ truncated: false })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

const BASE_B = 'http://127.0.0.1:8081'

function poolSession(fetch: unknown, options: Record<string, unknown> = {}) {
  return new SearxngSearchSession({
    baseURL: BASE,
    baseURLs: [BASE, BASE_B],
    fetch: fetch as typeof globalThis.fetch,
    minIntervalMs: 0,
    retryDelayMs: 1,
    ...options,
  })
}

describe('SearxngSearchSession failover', () => {
  it('fails over to the secondary endpoint on a network failure', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith(BASE)) throw new TypeError('fetch failed')
      return jsonResponse(RESULT)
    })
    const result = await poolSession(fetch).search('q', undefined)
    expect(result.sources.length).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1]?.[0]).toContain(BASE_B)
  })

  it('fails over after a retryable HTTP status', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.startsWith(BASE) ? jsonResponse({}, 502) : jsonResponse(RESULT))
    const result = await poolSession(fetch).search('q', undefined)
    expect(result.sources.length).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1]?.[0]).toContain(BASE_B)
  })

  it('fails over after a rate limit once Retry-After fits the budget', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.startsWith(BASE)
        ? new Response(JSON.stringify({}), {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '0' },
          })
        : jsonResponse(RESULT))
    const result = await poolSession(fetch).search('q', undefined)
    expect(result.sources.length).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1]?.[0]).toContain(BASE_B)
  })

  it('does not fail over on a non-retryable HTTP status', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.startsWith(BASE) ? jsonResponse({}, 403) : jsonResponse(RESULT))
    await expect(poolSession(fetch).search('q', undefined)).rejects.toMatchObject({ kind: 'http', status: 403 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not fail over on an unprocessable response body', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.startsWith(BASE)
        ? new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } })
        : jsonResponse(RESULT))
    await expect(poolSession(fetch).search('q', undefined)).rejects.toMatchObject({ kind: 'contract' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('throws the last failure after exhausting attempts across the pool', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith(BASE)) throw new TypeError('fetch failed')
      return jsonResponse({}, 502)
    })
    await expect(poolSession(fetch).search('q', undefined)).rejects.toMatchObject({ kind: 'network' })
    expect(fetch).toHaveBeenCalledTimes(3)
    // Both endpoints carry fresh penalties; the pool-order tie goes to the primary.
    expect(fetch.mock.calls[2]?.[0]).toContain(BASE)
  })

  it('steers the next search away from a failing primary until it recovers', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith(BASE)) throw new TypeError('fetch failed')
      return jsonResponse(RESULT)
    })
    const session = poolSession(fetch)
    await session.search('one', undefined)
    await session.search('two', undefined)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch.mock.calls[2]?.[0]).toContain(BASE_B)
  })

  it('returns to the primary after its health penalty decays', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith(BASE)) throw new TypeError('fetch failed')
      return jsonResponse(RESULT)
    })
    const session = poolSession(fetch)
    const first = session.search('one', undefined)
    await vi.advanceTimersByTimeAsync(10)
    await first
    vi.advanceTimersByTime(65_000)
    const second = session.search('two', undefined)
    await vi.advanceTimersByTimeAsync(10)
    await second
    expect(fetch.mock.calls[2]?.[0]).toContain(BASE)
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('serves a repeat query from the pool cache when the serving endpoint died', async () => {
    let primaryUp = true
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith(BASE) && !primaryUp) throw new TypeError('fetch failed')
      return jsonResponse(RESULT)
    })
    const session = poolSession(fetch, { cacheTtlMs: 60_000 })
    await session.search('same', undefined)
    primaryUp = false
    const again = await session.search('same', undefined)
    expect(again.sources.length).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('waits on the selected endpoint bucket, not the primary one, when steering', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async (url: string) => {
      if (url.startsWith(BASE)) throw new TypeError('fetch failed')
      return jsonResponse(RESULT)
    })
    const session = new SearxngSearchSession({
      baseURL: BASE,
      baseURLs: [BASE, BASE_B],
      fetch: fetch as typeof globalThis.fetch,
      minIntervalMs: 1_500,
      retryDelayMs: 1,
    })
    const one = session.search('one', undefined)
    await vi.advanceTimersByTimeAsync(10)
    await one
    // The primary stays penalized, so both follow-ups select the secondary and
    // pace on its bucket: the second waits for its refill, never for the
    // primary's.
    await session.search('two', undefined)
    const three = session.search('three', undefined)
    await vi.advanceTimersByTimeAsync(2_000)
    await three
    const urls = fetch.mock.calls.map((call) => String(call[0]))
    expect(urls[0]).toContain(BASE)
    expect(urls.slice(1).every((url) => url.startsWith(BASE_B))).toBe(true)
  })
})
