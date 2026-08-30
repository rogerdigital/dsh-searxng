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
const USER_AGENT = 'dsh-searxng/0.1.1'
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_RETRY_DELAY_MS = 100
const RETRYABLE_STATUSES = new Set([502, 503, 504])

type RequestFailureKind = 'caller-abort' | 'timeout' | 'network' | 'contract'

class RequestFailure extends Error {
  constructor(
    readonly kind: RequestFailureKind,
    message: string,
  ) {
    super(message)
    this.name = 'RequestFailure'
  }
}

/** @internal Shared by the CLI probe without exposing it from the package entry point. */
export interface JsonRequestOptions {
  url: string
  headers: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  maxAttempts?: 1 | 2
  retryDelayMs?: number
  fetch?: typeof globalThis.fetch
}

/** @internal Result from the bounded JSON request policy. */
export interface JsonRequestResult {
  response: Response
  payload?: unknown
}

/**
 * Perform a bounded JSON request. Transient transport and gateway failures get
 * at most one retry; caller cancellation and response-contract failures never do.
 *
 * @internal Used by the CLI probe and provider implementation only.
 */
export async function requestJsonWithRetry(options: JsonRequestOptions): Promise<JsonRequestResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const maxAttempts = options.maxAttempts ?? 2
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs must be a positive safe integer')
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) throw new RangeError('retryDelayMs must be a non-negative safe integer')
  const fetchRequest = options.fetch ?? globalThis.fetch

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await requestJsonAttempt({ ...options, timeoutMs, fetch: fetchRequest })
      if (!result.response.ok) {
        cancelResponseBody(result.response)
        if (RETRYABLE_STATUSES.has(result.response.status) && attempt < maxAttempts) {
          await abortableDelay(retryDelayMs, options.signal)
          continue
        }
      }
      return result
    } catch (error) {
      const failure = normalizeRequestFailure(error, options.signal)
      const retryable = failure.kind === 'network' || failure.kind === 'timeout'
      if (!retryable || attempt === maxAttempts) throw failure
      await abortableDelay(retryDelayMs, options.signal)
    }
  }
  throw new RequestFailure('network', 'SearXNG request failed')
}

function cancelResponseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {})
  } catch {
    // The HTTP status remains the primary failure; cancellation is best effort.
  }
}

async function requestJsonAttempt(
  options: JsonRequestOptions & { timeoutMs: number; fetch: typeof globalThis.fetch },
): Promise<JsonRequestResult> {
  if (options.signal?.aborted) throw new RequestFailure('caller-abort', 'SearXNG request aborted')

  const controller = new AbortController()
  let timedOut = false
  let rejectBoundary: ((reason: RequestFailure) => void) | undefined
  const boundary = new Promise<never>((_resolve, reject) => { rejectBoundary = reject })
  const onCallerAbort = () => {
    controller.abort(options.signal?.reason)
    rejectBoundary?.(new RequestFailure('caller-abort', 'SearXNG request aborted'))
  }
  options.signal?.addEventListener('abort', onCallerAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException('Request timed out', 'TimeoutError'))
    rejectBoundary?.(new RequestFailure('timeout', 'SearXNG request timed out'))
  }, options.timeoutMs)

  const request = Promise.resolve().then(async () => {
    const response = await options.fetch(options.url, {
      method: 'GET',
      headers: options.headers,
      signal: controller.signal,
    })
    if (!response.ok) return { response }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!/(?:^|[;/\s])(?:application\/json|[^;/\s]+\+json)(?:[;/\s]|$)/.test(contentType)) {
      throw new RequestFailure('contract', 'SearXNG returned a non-JSON response')
    }
    try {
      return { response, payload: await response.json() as unknown }
    } catch {
      throw new RequestFailure('contract', 'SearXNG returned malformed JSON')
    }
  })

  try {
    return await Promise.race([request, boundary])
  } catch (error) {
    if (options.signal?.aborted) throw new RequestFailure('caller-abort', 'SearXNG request aborted')
    if (timedOut) throw new RequestFailure('timeout', 'SearXNG request timed out')
    if (error instanceof RequestFailure) throw error
    if (isAbortError(error)) throw new RequestFailure('caller-abort', 'SearXNG request aborted')
    throw new RequestFailure('network', 'SearXNG request failed')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onCallerAbort)
    rejectBoundary = undefined
  }
}

function normalizeRequestFailure(error: unknown, signal?: AbortSignal): RequestFailure {
  if (signal?.aborted) return new RequestFailure('caller-abort', 'SearXNG request aborted')
  if (error instanceof RequestFailure) return error
  return new RequestFailure('network', 'SearXNG request failed')
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new RequestFailure('caller-abort', 'SearXNG request aborted'))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new RequestFailure('caller-abort', 'SearXNG request aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

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
 * @returns the normalized source, or `undefined` when the entry is malformed
 *   or has no safe HTTP(S) URL.
 */
export function mapSearxngResult(result: unknown): WebSearchSource | undefined {
  if (!isUsableSearxngResult(result)) return undefined
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
 * @returns the normalized result; malformed entries and entries without a
 *   safe HTTP(S) URL are dropped
 *   ({@link mapSearxngResult}).
 */
export function mapSearxngResponse(response: SearxngSearchResponse): WebSearchResult {
  const rawResults = (response as { results?: unknown }).results
  const sources = (Array.isArray(rawResults) ? rawResults : [])
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
    if (!isValidBaseUrl(this.options.baseURL)) {
      throw new WebError('SearXNG base URL must be an absolute HTTP URL without credentials, query, or fragment', 'WEB_PROVIDER_ERROR')
    }
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

    let result: JsonRequestResult
    try {
      result = await requestJsonWithRetry({
        url: buildSearchUrl(this.options.baseURL, params),
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
      const failure = normalizeRequestFailure(error, signal)
      if (failure.kind === 'caller-abort') {
        throw new WebError('SearXNG search aborted', 'WEB_ABORTED')
      }
      if (failure.kind === 'timeout') {
        throw new WebError('SearXNG request timed out; check the instance and network, then retry', 'WEB_PROVIDER_ERROR')
      }
      if (failure.kind === 'contract') {
        throw new WebError('SearXNG returned an unprocessable response body', 'WEB_PROVIDER_ERROR')
      }
      throw new WebError('SearXNG request failed', 'WEB_PROVIDER_ERROR')
    }

    if (!result.response.ok) {
      throw new WebError(httpFailureMessage(result.response.status), 'WEB_PROVIDER_ERROR')
    }

    if (!isSearxngSearchResponse(result.payload)) {
      throw new WebError('SearXNG returned an unprocessable response body', 'WEB_PROVIDER_ERROR')
    }
    return mapSearxngResponse(result.payload)
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
    && url.username.length === 0
    && url.password.length === 0
    && url.search.length === 0
    && url.hash.length === 0
}

function isSearxngSearchResponse(value: unknown): value is SearxngSearchResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const results = (value as Record<string, unknown>).results
  return Array.isArray(results)
}

function isUsableSearxngResult(value: unknown): value is SearxngResult & { url: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  if (!isValidResultUrl(result.url)) return false
  if (!isOptionalNullableString(result.title)) return false
  if (!isOptionalNullableString(result.content)) return false
  if (!isOptionalNullableString(result.engine)) return false
  if (!isOptionalNullableString(result.publishedDate)) return false
  return result.score === undefined || result.score === null || (typeof result.score === 'number' && Number.isFinite(result.score))
}

function isValidResultUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || !URL.canParse(value)) return false
  const url = new URL(value)
  return (url.protocol === 'http:' || url.protocol === 'https:')
    && url.username.length === 0
    && url.password.length === 0
}

function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string'
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError'
}
