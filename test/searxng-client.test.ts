import { describe, expect, it, vi } from 'vitest'
import {
  SearxngClientError,
  isValidSearxngBaseUrl,
  searchSearxng,
} from '../src/searxng-client.ts'

describe('searchSearxng', () => {
  it('normalizes a real JSON search without DSH types', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      results: [{ url: 'https://example.com/result', title: 'Result', content: 'Snippet' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await expect(searchSearxng({ baseURL: 'http://127.0.0.1:8080', fetch }, {
      query: 'deepseek harness',
    })).resolves.toEqual({
      sources: [{ url: 'https://example.com/result', title: 'Result', snippet: 'Snippet' }],
      truncated: false,
    })
  })

  it('returns a typed HTTP failure without leaking the response body', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('private body', { status: 403 }))
    const error = await searchSearxng({ baseURL: 'http://127.0.0.1:8080', fetch }, { query: 'q' })
      .then(() => undefined, (cause: unknown) => cause)

    expect(error).toBeInstanceOf(SearxngClientError)
    expect(error).toMatchObject({ kind: 'http', status: 403 })
    expect(JSON.stringify(error)).not.toContain('private body')
  })

  it('validates absolute credential-free HTTP endpoints', () => {
    expect(isValidSearxngBaseUrl('https://search.example.com/base')).toBe(true)
    expect(isValidSearxngBaseUrl('http://user:pass@localhost:8080')).toBe(false)
    expect(isValidSearxngBaseUrl('localhost:8080')).toBe(false)
  })
})
