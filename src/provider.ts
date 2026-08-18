/**
 * `SearxngSearchProvider`: a `WebSearchProvider` backed by a SearXNG
 * instance's JSON API (`GET /search?format=json`). It maps `content` to
 * `snippet` and `publishedDate` to `publishedAt`, keeps entries that carry
 * only a URL and title (the seam allows URL-only sources; dropping them would
 * discard real results), and omits `content` because SearXNG returns no
 * generated answer.
 *
 * @module dsh-searxng/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { SearxngResult, SearxngSearchResponse } from './types.ts'

/** Stable id this provider registers under. */
export const SEARXNG_PROVIDER_ID = 'searxng'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'dsh-searxng/0.1.0'

/**
 * Resolved provider options (the plugin's `apply` supplies env-var and
 * constant defaults).
 */
export interface SearxngSearchProviderOptions {
  /**
   * Base URL of the SearXNG instance, e.g. `http://127.0.0.1:8080`. The
   * instance must have `json` in its `search.formats`; query and fragment
   * components are not accepted. Empty/absent makes the provider unavailable —
   * no public instance is assumed, because most disable the JSON format and
   * rate-limit heavily.
   */
  baseURL: string
  /** Locale passed as SearXNG's `language` parameter, e.g. `zh-CN`. */
  language?: string
  /** Comma-separated engine allowlist passed as SearXNG's `engines` parameter. */
  engines?: string
  /** Comma-separated category filter passed as SearXNG's `categories` parameter. */
  categories?: string
  /**
   * Value for the authorization header, for instances fronted by an
   * API-key gate. Sent verbatim.
   */
  authHeader?: string
}

/**
 * Map one SearXNG result to a normalized source, or `undefined` when it
 * carries no usable URL (an entry without a URL cannot be cited; every other
 * field is optional per the seam contract).
 *
 * @param result - one entry of SearXNG's `results[]`.
 * @returns the normalized source, or `undefined` when the entry has no URL.
 */
export function mapSearxngResult(result: SearxngResult): WebSearchSource | undefined {
  if (typeof result.url !== 'string' || result.url.length === 0) return undefined
  return {
    url: result.url,
    ...nonEmpty(result.title) !== undefined ? { title: nonEmpty(result.title) } : {},
    ...nonEmpty(result.content) !== undefined ? { snippet: nonEmpty(result.content) } : {},
    ...nonEmpty(result.publishedDate) !== undefined ? { publishedAt: nonEmpty(result.publishedDate) } : {},
  }
}

/** `value` when it is a non-blank string, else `undefined`. */
function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/**
 * Map a SearXNG response envelope to a normalized search result.
 *
 * @param response - the parsed `GET /search` response body.
 * @returns the normalized result; entries without a URL are dropped
 *   ({@link mapSearxngResult}).
 */
export function mapSearxngResponse(response: SearxngSearchResponse): WebSearchResult {
  const sources = (response.results ?? [])
    .map(mapSearxngResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  // SearXNG returns no generated answer, so `content` is omitted. The web
  // service owns the final `maxResults` truncation, so report `truncated: false`.
  return { sources, truncated: false }
}

/** The SearXNG-backed search provider; network failures surface as `WEB_PROVIDER_ERROR`. */
export class SearxngSearchProvider implements WebSearchProvider {
  readonly id = SEARXNG_PROVIDER_ID

  constructor(private readonly options: SearxngSearchProviderOptions) {}

  available(): boolean {
    return isValidBaseUrl(this.options.baseURL)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const params = new URLSearchParams({ q: request.query, format: 'json' })
    if (this.options.language !== undefined && this.options.language.length > 0) {
      params.set('language', this.options.language)
    }
    if (this.options.engines !== undefined && this.options.engines.length > 0) {
      params.set('engines', this.options.engines)
    }
    if (this.options.categories !== undefined && this.options.categories.length > 0) {
      params.set('categories', this.options.categories)
    }
    // SearXNG takes no result-count parameter; the seam enforces the
    // request's `maxResults` bound by truncating `sources` on return.

    let response: Response
    try {
      response = await fetch(buildSearchUrl(this.options.baseURL, params), {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'user-agent': USER_AGENT,
          ...this.options.authHeader !== undefined && this.options.authHeader.length > 0
            ? { authorization: this.options.authHeader }
            : {},
        },
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`SearXNG request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      throw new WebError(httpFailureMessage(response.status), 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as SearxngSearchResponse
      return mapSearxngResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`SearXNG returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/** Build the JSON search endpoint while preserving an optional deployment subpath. */
function buildSearchUrl(baseURL: string, params: URLSearchParams): string {
  const url = new URL(baseURL)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/search`
  url.search = params.toString()
  url.hash = ''
  return url.toString()
}

/**
 * Human-readable failure text that names the two fixes a user can actually
 * make: HTTP 403 is almost always a SearXNG instance without `json` in
 * `search.formats`; 429 is the instance's rate limiter.
 */
function httpFailureMessage(status: number): string {
  if (status === 403) {
    return 'SearXNG refused the request (HTTP 403). Most likely the instance does not enable the JSON format — add "json" to search.formats in its settings, or see the plugin README for a ready-to-use docker-compose instance'
  }
  if (status === 429) {
    return 'SearXNG instance rate limit hit (HTTP 429). Space out requests, or raise the limiter limits on the instance'
  }
  return `SearXNG instance error (HTTP ${status})`
}

/**
 * True when `baseURL` parses as an absolute http(s) URL with no query or
 * fragment (a cheap local config check). Bare `URL.canParse` would accept e.g.
 * `localhost:8080` — valid URL syntax with an unusable `localhost:` scheme
 * that only fails later at fetch.
 */
function isValidBaseUrl(baseURL: string): boolean {
  if (!URL.canParse(baseURL)) return false
  const url = new URL(baseURL)
  return (url.protocol === 'http:' || url.protocol === 'https:')
    && url.search.length === 0
    && url.hash.length === 0
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
