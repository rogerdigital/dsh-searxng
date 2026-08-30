import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  SEARXNG_PROVIDER_ID,
  SearxngSearchProvider,
  mapSearxngResponse,
  mapSearxngResult,
} from '../src/provider.ts'
import type { SearxngResult } from '../src/types.ts'

const BASE = 'http://127.0.0.1:8080'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('mapSearxngResult', () => {
  it('maps a full entry to url/title/snippet/publishedAt', () => {
    const entry: SearxngResult = {
      url: 'https://example.com/a',
      title: 'A result',
      content: 'A snippet',
      engine: 'google',
      score: 1.5,
      publishedDate: '2026-01-02T03:04:05Z',
    }
    expect(mapSearxngResult(entry)).toEqual({
      url: 'https://example.com/a',
      title: 'A result',
      snippet: 'A snippet',
      publishedAt: '2026-01-02T03:04:05Z',
    })
  })

  it('keeps an entry with only url and title (seam allows URL-only sources)', () => {
    const entry: SearxngResult = { url: 'https://example.com/b', title: 'B', content: '' }
    expect(mapSearxngResult(entry)).toEqual({ url: 'https://example.com/b', title: 'B' })
  })

  it('keeps an entry with only a url', () => {
    expect(mapSearxngResult({ url: 'https://example.com/c', title: null, content: null })).toEqual({
      url: 'https://example.com/c',
    })
  })

  it('drops an entry without a url', () => {
    expect(mapSearxngResult({ title: 'orphan', content: 'no url' })).toBeUndefined()
    expect(mapSearxngResult({ url: '', title: 'empty url' })).toBeUndefined()
    expect(mapSearxngResult({ url: null })).toBeUndefined()
  })

  it('drops blank-only fields instead of inventing them', () => {
    expect(mapSearxngResult({ url: 'https://example.com/d', title: '  ', content: ' \t ' })).toEqual({
      url: 'https://example.com/d',
    })
  })
})

describe('mapSearxngResponse', () => {
  it('maps results and reports truncated: false (the seam owns truncation)', () => {
    const result = mapSearxngResponse({
      query: 'q',
      results: [
        { url: 'https://example.com/1', title: '1', content: 's1' },
        { title: 'no url' },
      ],
      number_of_results: 42,
    })
    expect(result).toEqual({
      sources: [{ url: 'https://example.com/1', title: '1', snippet: 's1' }],
      truncated: false,
    })
  })

  it('tolerates a missing results array', () => {
    expect(mapSearxngResponse({ query: 'q' })).toEqual({ sources: [], truncated: false })
  })
})

describe('SearxngSearchProvider', () => {
  it('registers under the stable searxng id', () => {
    expect(new SearxngSearchProvider({ baseURL: BASE }).id).toBe(SEARXNG_PROVIDER_ID)
  })

  describe('available', () => {
    it('is true for an absolute base URL', () => {
      expect(new SearxngSearchProvider({ baseURL: BASE }).available()).toBe(true)
    })

    it('is false without a base URL or with a relative one', () => {
      expect(new SearxngSearchProvider({ baseURL: '' }).available()).toBe(false)
      expect(new SearxngSearchProvider({ baseURL: 'localhost:8080' }).available()).toBe(false)
    })

    it.each([`${BASE}?x=1`, `${BASE}#section`])(
      'is false when the base URL contains a query or fragment: %s',
      (baseURL) => {
        expect(new SearxngSearchProvider({ baseURL }).available()).toBe(false)
      },
    )

    it('is false when the base URL contains credentials', () => {
      expect(new SearxngSearchProvider({ baseURL: 'http://user:pass@localhost:8080' }).available()).toBe(false)
    })
  })

  describe('search', () => {
    it('rejects an unsafe base URL without making a request', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      await expect(new SearxngSearchProvider({ baseURL: 'http://user:pass@localhost:8080' }).search({ query: 'q' }))
        .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it.each([
      [`${BASE}/`, `${BASE}/search`],
      [`${BASE}/searxng`, `${BASE}/searxng/search`],
      [`${BASE}/searxng/`, `${BASE}/searxng/search`],
    ])('normalizes the base URL %s', async (baseURL, expectedPath) => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)

      await new SearxngSearchProvider({ baseURL }).search({ query: 'q' })

      const requested = new URL(fetchMock.mock.calls[0]![0] as string)
      expect(requested.origin + requested.pathname).toBe(expectedPath)
    })

    it('requests the JSON format with query and optional filters', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({ results: [{ url: 'https://example.com/1', content: 's' }] }),
      )
      vi.stubGlobal('fetch', fetchMock)

      const provider = new SearxngSearchProvider({
        baseURL: BASE,
        language: 'zh-CN',
        engines: 'bing,duckduckgo',
        categories: 'general',
      })
      const result = await provider.search({ query: '你好 world' })

      expect(result.sources).toEqual([{ url: 'https://example.com/1', snippet: 's' }])
      expect(fetchMock).toHaveBeenCalledOnce()
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
      const parsed = new URL(url)
      expect(parsed.origin + parsed.pathname).toBe(`${BASE}/search`)
      expect(parsed.searchParams.get('q')).toBe('你好 world')
      expect(parsed.searchParams.get('format')).toBe('json')
      expect(parsed.searchParams.get('language')).toBe('zh-CN')
      expect(parsed.searchParams.get('engines')).toBe('bing,duckduckgo')
      expect(parsed.searchParams.get('categories')).toBe('general')
      expect(init.method).toBe('GET')
      expect((init.headers as Record<string, string>)['accept']).toBe('application/json')
    })

    it('omits filter parameters when unconfigured', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)

      await new SearxngSearchProvider({ baseURL: BASE }).search({ query: 'q', maxResults: 3 })

      const parsed = new URL(fetchMock.mock.calls[0]![0] as string)
      expect(parsed.searchParams.has('language')).toBe(false)
      expect(parsed.searchParams.has('engines')).toBe(false)
      expect(parsed.searchParams.has('categories')).toBe(false)
    })

    it('sends the configured authorization header verbatim', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)

      await new SearxngSearchProvider({ baseURL: BASE, authHeader: 'Bearer tok' }).search({ query: 'q' })

      const init = fetchMock.mock.calls[0]![1] as RequestInit
      expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok')
    })

    it('links the caller abort signal to the request', async () => {
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      }))
      vi.stubGlobal('fetch', fetchMock)
      const controller = new AbortController()

      const attempt = new SearxngSearchProvider({ baseURL: BASE }).search({ query: 'q' }, controller.signal)
      controller.abort()

      await expect(attempt).rejects.toMatchObject({ code: 'WEB_ABORTED' })
      expect((fetchMock.mock.calls[0]![1] as RequestInit).signal).not.toBe(controller.signal)
      expect((fetchMock.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true)
    })

    it.each([
      [403, /JSON format|search\.formats/],
      [429, /rate limit/i],
      [502, /HTTP 502/],
    ])('maps HTTP %i to a WEB_PROVIDER_ERROR with guidance', async (status, pattern) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status })))

      const attempt = new SearxngSearchProvider({ baseURL: BASE }).search({ query: 'q' })
      await expect(attempt).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(WebError)
        expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR')
        expect((error as WebError).message).toMatch(pattern)
        return true
      })
    })

    it('maps a network failure to WEB_PROVIDER_ERROR with the cause chained', async () => {
      const cause = new TypeError('fetch failed')
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause))

      const attempt = new SearxngSearchProvider({ baseURL: BASE }).search({ query: 'q' })
      await expect(attempt).rejects.toSatisfy((error: unknown) => {
        expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR')
        expect((error as WebError).cause).toBe(cause)
        return true
      })
    })

    it('retries one transient transport failure and then succeeds', async () => {
      vi.useFakeTimers()
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(new TypeError('offline'))
        .mockResolvedValueOnce(jsonResponse({ results: [{ url: 'https://example.com/ok' }] }))
      vi.stubGlobal('fetch', fetchMock)

      const attempt = new SearxngSearchProvider({ baseURL: BASE }).search({ query: 'q' })
      await vi.runAllTimersAsync()

      await expect(attempt).resolves.toMatchObject({ sources: [{ url: 'https://example.com/ok' }] })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      vi.useRealTimers()
    })

    it('cancels during the retry delay and cleans up the delay timer', async () => {
      vi.useFakeTimers()
      const controller = new AbortController()
      const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'))
      vi.stubGlobal('fetch', fetchMock)
      const attempt = new SearxngSearchProvider({ baseURL: BASE }).search({ query: 'q' }, controller.signal)
      const expectation = expect(attempt).rejects.toMatchObject({ code: 'WEB_ABORTED' })
      await vi.advanceTimersByTimeAsync(0)
      controller.abort()
      await expectation
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
      vi.useRealTimers()
    })

    it.each([502, 503, 504])('retries HTTP %i once and then succeeds', async (status) => {
      vi.useFakeTimers()
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response('temporary', { status }))
        .mockResolvedValueOnce(jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)

      const attempt = new SearxngSearchProvider({ baseURL: BASE }).search({ query: 'q' })
      await vi.runAllTimersAsync()

      await expect(attempt).resolves.toMatchObject({ sources: [] })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      vi.useRealTimers()
    })

    it('stops after two transient attempts', async () => {
      vi.useFakeTimers()
      const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'))
      vi.stubGlobal('fetch', fetchMock)
      const attempt = new SearxngSearchProvider({ baseURL: BASE }).search({ query: 'q' })
      const expectation = expect(attempt).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      await vi.runAllTimersAsync()
      await expectation
      expect(fetchMock).toHaveBeenCalledTimes(2)
      vi.useRealTimers()
    })

    it.each([401, 403, 429])('does not retry HTTP %i', async (status) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('denied', { status }))
      vi.stubGlobal('fetch', fetchMock)
      await expect(new SearxngSearchProvider({ baseURL: BASE }).search({ query: 'q' }))
        .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('applies a finite default timeout even when fetch ignores abort', async () => {
      vi.useFakeTimers()
      const fetchMock = vi.fn(() => new Promise<Response>(() => {}))
      vi.stubGlobal('fetch', fetchMock)
      const attempt = new SearxngSearchProvider({ baseURL: BASE }).search({ query: 'q' })
      const expectation = expect(attempt).rejects.toSatisfy((error: unknown) => {
        expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR')
        expect((error as WebError).message).toMatch(/timed out/i)
        return true
      })
      await vi.advanceTimersByTimeAsync(60_000)
      await expectation
      expect(fetchMock).toHaveBeenCalledTimes(2)
      vi.useRealTimers()
    })

    it('cleans up the per-attempt timeout after a successful response', async () => {
      vi.useFakeTimers()
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ results: [] })))
      await expect(new SearxngSearchProvider({ baseURL: BASE }).search({ query: 'q' })).resolves.toBeDefined()
      expect(vi.getTimerCount()).toBe(0)
      vi.useRealTimers()
    })

    it('handles a synchronous fetch throw without an unhandled rejection', async () => {
      vi.useFakeTimers()
      const fetchMock = vi.fn(() => { throw new TypeError('sync offline') })
      vi.stubGlobal('fetch', fetchMock)
      const attempt = new SearxngSearchProvider({ baseURL: BASE }).search({ query: 'q' })
      const expectation = expect(attempt).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      await vi.runAllTimersAsync()
      await expectation
      expect(fetchMock).toHaveBeenCalledTimes(2)
      vi.useRealTimers()
    })

    it('does not retry malformed JSON or a non-JSON success', async () => {
      for (const response of [
        new Response('{broken', { status: 200, headers: { 'content-type': 'application/json' } }),
        new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      ]) {
        const fetchMock = vi.fn().mockResolvedValue(response)
        vi.stubGlobal('fetch', fetchMock)
        await expect(new SearxngSearchProvider({ baseURL: BASE }).search({ query: 'q' }))
          .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
        expect(fetchMock).toHaveBeenCalledOnce()
      }
    })

    it.each([null, [], { results: 'invalid' }])('rejects a malformed JSON contract without retrying', async (payload) => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload))
      vi.stubGlobal('fetch', fetchMock)
      await expect(new SearxngSearchProvider({ baseURL: BASE }).search({ query: 'q' }))
        .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      expect(fetchMock).toHaveBeenCalledOnce()
    })

    it.each([
      { results: [null] },
      { results: ['primitive'] },
      { results: [{}] },
      { results: [{ url: null }] },
      { results: [{ url: '' }] },
      { results: [{ url: 'not a URL' }] },
      { results: [{ url: 'javascript:alert(1)' }] },
      { results: [{ url: 'https://example.com', title: 42 }] },
      { results: [{ url: 'https://example.com', content: {} }] },
      { results: [{ url: 'https://example.com', publishedDate: false }] },
      { results: [{ url: 'https://example.com', score: 'high' }] },
      { results: [{ url: 'https://example.com' }, null] },
    ])('rejects malformed result entries without leaking request data: $results', async ({ results }) => {
      const query = 'private provider query'
      const bodySecret = 'body-secret'
      const credential = 'Bearer credential-secret'
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results, debug: bodySecret }))
      vi.stubGlobal('fetch', fetchMock)

      const error = await new SearxngSearchProvider({ baseURL: BASE, authHeader: credential })
        .search({ query })
        .then(() => undefined, (cause: unknown) => cause)

      expect(error).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      expect(error).toBeInstanceOf(WebError)
      const visible = `${(error as Error).message}\n${JSON.stringify(error)}`
      expect(visible).not.toContain(query)
      expect(visible).not.toContain(bodySecret)
      expect(visible).not.toContain(credential)
      expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('ignores Retry-After on a non-retryable rate limit', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('limited', {
        status: 429,
        headers: { 'retry-after': '999999' },
      }))
      vi.stubGlobal('fetch', fetchMock)
      const attempt = new SearxngSearchProvider({ baseURL: BASE }).search({ query: 'q' })
      await expect(attempt).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
      expect(fetchMock).toHaveBeenCalledOnce()
      vi.useRealTimers()
    })

    it('maps an abort during fetch to WEB_ABORTED', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')))

      const attempt = new SearxngSearchProvider({ baseURL: BASE }).search({ query: 'q' })
      await expect(attempt).rejects.toSatisfy((error: unknown) => {
        expect((error as WebError).code).toBe('WEB_ABORTED')
        return true
      })
    })

    it('maps a non-JSON 200 body to WEB_PROVIDER_ERROR', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        new Response('<html>not json</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ))

      const attempt = new SearxngSearchProvider({ baseURL: BASE }).search({ query: 'q' })
      await expect(attempt).rejects.toSatisfy((error: unknown) => {
        expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR')
        expect((error as WebError).message).toMatch(/unprocessable response body/)
        return true
      })
    })
  })
})
