import type { SearxngResult, SearxngSearchResponse } from './types.ts'

const USER_AGENT = 'dsh-searxng/0.2.1'
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_RETRY_DELAY_MS = 100
const RETRYABLE_STATUSES = new Set([502, 503, 504])

export type SearxngClientFailureKind =
  | 'invalid-url'
  | 'caller-abort'
  | 'timeout'
  | 'network'
  | 'contract'
  | 'http'

export class SearxngClientError extends Error {
  constructor(
    readonly kind: SearxngClientFailureKind,
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'SearxngClientError'
  }
}

export interface SearxngClientOptions {
  baseURL: string
  language?: string
  engines?: string
  categories?: string
  authHeader?: string
  timeoutMs?: number
  maxAttempts?: 1 | 2
  retryDelayMs?: number
  fetch?: typeof globalThis.fetch
}

export interface SearxngClientSource {
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
}

export interface SearxngClientResult {
  sources: SearxngClientSource[]
  truncated: false
}

export interface JsonRequestOptions {
  url: string
  headers: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  maxAttempts?: 1 | 2
  retryDelayMs?: number
  fetch?: typeof globalThis.fetch
}

export interface JsonRequestResult {
  response: Response
  payload?: unknown
}

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
  throw new SearxngClientError('network', 'SearXNG request failed')
}

export function isValidSearxngBaseUrl(baseURL: string): boolean {
  if (!URL.canParse(baseURL)) return false
  const url = new URL(baseURL)
  return (url.protocol === 'http:' || url.protocol === 'https:')
    && url.username.length === 0
    && url.password.length === 0
    && url.search.length === 0
    && url.hash.length === 0
}

export function mapSearxngClientResult(result: unknown): SearxngClientSource | undefined {
  if (!isUsableSearxngResult(result)) return undefined
  return {
    url: result.url,
    ...nonEmpty(result.title) !== undefined ? { title: nonEmpty(result.title) } : {},
    ...nonEmpty(result.content) !== undefined ? { snippet: nonEmpty(result.content) } : {},
    ...nonEmpty(result.publishedDate) !== undefined ? { publishedAt: nonEmpty(result.publishedDate) } : {},
  }
}

export function mapSearxngClientResponse(response: SearxngSearchResponse): SearxngClientResult {
  const rawResults = (response as { results?: unknown }).results
  const sources = (Array.isArray(rawResults) ? rawResults : [])
    .map(mapSearxngClientResult)
    .filter((source): source is SearxngClientSource => source !== undefined)
  return { sources, truncated: false }
}

export async function searchSearxng(
  options: SearxngClientOptions,
  request: { query: string },
  signal?: AbortSignal,
): Promise<SearxngClientResult> {
  if (!isValidSearxngBaseUrl(options.baseURL)) {
    throw new SearxngClientError('invalid-url', 'SearXNG base URL is invalid')
  }
  const params = new URLSearchParams({ q: request.query, format: 'json' })
  for (const key of ['language', 'engines', 'categories'] as const) {
    const value = options[key]
    if (value !== undefined && value.length > 0) params.set(key, value)
  }

  const result = await requestJsonWithRetry({
    url: buildSearchUrl(options.baseURL, params),
    headers: {
      accept: 'application/json',
      'user-agent': USER_AGENT,
      ...(options.authHeader !== undefined && options.authHeader.length > 0
        ? { authorization: options.authHeader }
        : {}),
    },
    ...(signal === undefined ? {} : { signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })

  if (!result.response.ok) {
    throw new SearxngClientError('http', `SearXNG search failed with HTTP ${result.response.status}`, result.response.status)
  }
  if (!isSearxngSearchResponse(result.payload)) {
    throw new SearxngClientError('contract', 'SearXNG returned an unprocessable response body')
  }
  return mapSearxngClientResponse(result.payload)
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
  if (options.signal?.aborted) throw new SearxngClientError('caller-abort', 'SearXNG request aborted')

  const controller = new AbortController()
  let timedOut = false
  let rejectBoundary: ((reason: SearxngClientError) => void) | undefined
  const boundary = new Promise<never>((_resolve, reject) => { rejectBoundary = reject })
  const onCallerAbort = () => {
    controller.abort(options.signal?.reason)
    rejectBoundary?.(new SearxngClientError('caller-abort', 'SearXNG request aborted'))
  }
  options.signal?.addEventListener('abort', onCallerAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException('Request timed out', 'TimeoutError'))
    rejectBoundary?.(new SearxngClientError('timeout', 'SearXNG request timed out'))
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
      cancelResponseBody(response)
      throw new SearxngClientError('contract', 'SearXNG returned a non-JSON response')
    }
    try {
      return { response, payload: await response.json() as unknown }
    } catch {
      throw new SearxngClientError('contract', 'SearXNG returned malformed JSON')
    }
  })

  try {
    return await Promise.race([request, boundary])
  } catch (error) {
    if (options.signal?.aborted) throw new SearxngClientError('caller-abort', 'SearXNG request aborted')
    if (timedOut) throw new SearxngClientError('timeout', 'SearXNG request timed out')
    if (error instanceof SearxngClientError) throw error
    if (isAbortError(error)) throw new SearxngClientError('caller-abort', 'SearXNG request aborted')
    // The original fetch failure is preserved as the cause chain so callers can
    // classify TLS-level failures; message content stays redacted.
    throw new SearxngClientError('network', 'SearXNG request failed', undefined, { cause: error })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onCallerAbort)
    rejectBoundary = undefined
  }
}

function normalizeRequestFailure(error: unknown, signal?: AbortSignal): SearxngClientError {
  if (signal?.aborted) return new SearxngClientError('caller-abort', 'SearXNG request aborted')
  if (error instanceof SearxngClientError) return error
  return new SearxngClientError('network', 'SearXNG request failed', undefined, { cause: error })
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new SearxngClientError('caller-abort', 'SearXNG request aborted'))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new SearxngClientError('caller-abort', 'SearXNG request aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function buildSearchUrl(baseURL: string, params: URLSearchParams): string {
  const url = new URL(baseURL)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/search`
  url.search = params.toString()
  url.hash = ''
  return url.toString()
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function isSearxngSearchResponse(value: unknown): value is SearxngSearchResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Array.isArray((value as Record<string, unknown>).results)
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

function isAbortError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError'
}
