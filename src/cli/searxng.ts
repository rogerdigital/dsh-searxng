import { CliError } from './errors.ts'
import {
  requestJsonWithRetry,
  searchSearxng,
  type SearxngClientOptions,
  type SearxngClientResult,
} from '../searxng-client.ts'

const PROBE_QUERY = 'deepseek harness'
const DEFAULT_PROBE_TIMEOUT_MS = 10_000
const DEFAULT_READINESS_TIMEOUT_MS = 60_000
const READINESS_ATTEMPT_TIMEOUT_MS = 5_000
const DEFAULT_ATTEMPTS = 1
const READINESS_RETRY_DELAY_MS = 250
const RETRYABLE_STATUS = new Set([502, 503, 504])

export interface ProbeOptions {
  baseURL: string
  authHeader?: string
  language?: string
  engines?: string
  categories?: string
  /** Total readiness deadline; per-attempt timeout for real/provider searches. */
  timeoutMs?: number
  /** Optional attempt cap. Readiness otherwise polls until its deadline. */
  attempts?: number
  fetch?: typeof globalThis.fetch
}

export interface ProbeResult {
  endpoint: string
  resultCount: number
  elapsedMs: number
}

export interface SearxngProbe {
  http(options: ProbeOptions, signal?: AbortSignal): Promise<void>
  readiness(options: ProbeOptions, signal?: AbortSignal): Promise<void>
  realSearch(options: ProbeOptions, signal?: AbortSignal): Promise<ProbeResult>
  providerSearch(options: SearxngClientOptions, signal?: AbortSignal): Promise<ProbeResult>
}

type ClientSearch = (
  options: SearxngClientOptions,
  request: { query: string },
  signal?: AbortSignal,
) => Promise<SearxngClientResult>

export interface DefaultSearxngProbeOptions {
  search?: ClientSearch
}

interface ProbeAttemptResult {
  endpoint: string
  resultCount: number
  elapsedMs: number
}

class TransientProbeError extends Error {}

/** Node fetch reports TLS failures as cause chains carrying OpenSSL-style codes. */
const TLS_FAILURE_CODE = /^(?:ERR_TLS|ERR_SSL|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|CERT_SIGNATURE_FAILURE|EPROTO)/

function isTlsFailure(error: unknown): boolean {
  let current: unknown = error
  while (current !== null && typeof current === 'object') {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && TLS_FAILURE_CODE.test(code)) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

function tlsFailed(): CliError {
  return new CliError('E_TLS_FAILED', 'SearXNG TLS validation failed', 'Check the endpoint certificate, then retry')
}

class MalformedProbeResponseError extends CliError {
  constructor() {
    super(
      'E_SEARCH_FAILED',
      'SearXNG returned a malformed search response',
      'Check the SearXNG JSON API configuration and run dsh-searxng doctor',
    )
  }
}

export async function probeSearxng(options: ProbeOptions, signal?: AbortSignal): Promise<ProbeResult> {
  return runProbe(options, false, signal)
}

export class DefaultSearxngProbe implements SearxngProbe {
  private readonly search: ClientSearch

  constructor(options: DefaultSearxngProbeOptions = {}) {
    this.search = options.search ?? searchSearxng
  }

  async http(options: ProbeOptions, signal?: AbortSignal): Promise<void> {
    const endpoint = validateEndpoint(options.baseURL)
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw searchFailed('Probe timeout must be a positive safe integer')
    const timeout = AbortSignal.timeout(timeoutMs)
    const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    try {
      const response = await (options.fetch ?? globalThis.fetch)(endpoint, {
        headers: options.authHeader === undefined ? {} : { authorization: options.authHeader },
        signal: requestSignal,
      })
      classifyStatus(response.status)
      if (!response.ok) throw searchFailed('SearXNG HTTP endpoint returned an error')
    } catch (error) {
      rethrowCancellation(error, signal)
      if (error instanceof CliError) throw error
      if (isTlsFailure(error)) throw tlsFailed()
      throw searchFailed('SearXNG HTTP endpoint is unavailable')
    }
  }

  async readiness(options: ProbeOptions, signal?: AbortSignal): Promise<void> {
    await runReadiness(options, signal)
  }

  realSearch(options: ProbeOptions, signal?: AbortSignal): Promise<ProbeResult> {
    return probeSearxng(options, signal)
  }

  async providerSearch(options: SearxngClientOptions, signal?: AbortSignal): Promise<ProbeResult> {
    signal?.throwIfAborted()
    const startedAt = Date.now()
    try {
      const result = await this.search({ ...options }, { query: PROBE_QUERY }, signal)
      signal?.throwIfAborted()
      if (result.sources.length === 0) throw searchFailed('The configured provider returned no usable search result')
      return { endpoint: options.baseURL, resultCount: result.sources.length, elapsedMs: Math.max(0, Date.now() - startedAt) }
    } catch (error) {
      rethrowCancellation(error, signal)
      if (error instanceof CliError) throw error
      throw searchFailed('The configured SearXNG provider search failed')
    }
  }
}

async function runProbe(
  options: ProbeOptions,
  allowEmptyResults: boolean,
  signal?: AbortSignal,
): Promise<ProbeAttemptResult> {
  const endpoint = validateEndpoint(options.baseURL)
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw searchFailed('Probe attempts must be a positive safe integer')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw searchFailed('Probe timeout must be a positive safe integer')

  const startedAt = Date.now()
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    signal?.throwIfAborted()
    try {
      return await probeAttempt(options, endpoint, timeoutMs, allowEmptyResults, startedAt, signal)
    } catch (error) {
      rethrowCancellation(error, signal)
      lastError = toCliError(error)
      if (!isTransientFailure(error)) throw lastError
      if (attempt === attempts) throw lastError
      await delay(READINESS_RETRY_DELAY_MS, signal)
    }
  }
  throw toCliError(lastError)
}

async function runReadiness(options: ProbeOptions, signal?: AbortSignal): Promise<void> {
  const endpoint = validateEndpoint(options.baseURL)
  const timeoutMs = options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw searchFailed('Readiness timeout must be a positive safe integer')
  if (options.attempts !== undefined && (!Number.isSafeInteger(options.attempts) || options.attempts < 1)) {
    throw searchFailed('Probe attempts must be a positive safe integer')
  }

  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  let attempt = 0
  while (true) {
    signal?.throwIfAborted()
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) throw startupTimeout()
    if (options.attempts !== undefined && attempt >= options.attempts) throw startupTimeout()
    attempt += 1

    try {
      await probeAttempt(
        options,
        endpoint,
        Math.min(READINESS_ATTEMPT_TIMEOUT_MS, remainingMs),
        true,
        startedAt,
        signal,
      )
      return
    } catch (error) {
      rethrowCancellation(error, signal)
      const cliError = toCliError(error)
      if (!isTransientFailure(error)) throw cliError
      if (options.attempts !== undefined && attempt >= options.attempts) throw startupTimeout()
      const delayMs = Math.min(READINESS_RETRY_DELAY_MS, deadline - Date.now())
      if (delayMs <= 0) throw startupTimeout()
      await delay(delayMs, signal)
    }
  }
}

async function probeAttempt(
  options: ProbeOptions,
  endpoint: string,
  timeoutMs: number,
  allowEmptyResults: boolean,
  startedAt: number,
  signal?: AbortSignal,
): Promise<ProbeAttemptResult> {
  const request = await requestJsonWithRetry({
    url: buildProbeUrl(endpoint, options),
    headers: {
      accept: 'application/json',
      ...(options.authHeader !== undefined && options.authHeader.length > 0
        ? { authorization: options.authHeader }
        : {}),
    },
    signal,
    timeoutMs,
    maxAttempts: 1,
    fetch: options.fetch,
  })
  classifyStatus(request.response.status)
  const results = parseResults(request.payload)
  const resultCount = results.filter(hasValidHttpUrl).length
  if (results.length > 0 && resultCount === 0) throw new MalformedProbeResponseError()
  if (!allowEmptyResults && resultCount === 0) throw searchFailed('SearXNG returned no usable search result')
  return { endpoint, resultCount, elapsedMs: Math.max(0, Date.now() - startedAt) }
}

function startupTimeout(): CliError {
  return new CliError(
    'E_SEARXNG_START_TIMEOUT',
    'SearXNG did not become ready before the startup deadline',
    'Run dsh-searxng doctor and inspect the managed SearXNG logs',
  )
}

function validateEndpoint(baseURL: string): string {
  if (!URL.canParse(baseURL)) throw searchFailed('SearXNG endpoint must be an absolute HTTP URL')
  const url = new URL(baseURL)
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 || url.password.length > 0 ||
    url.search.length > 0 || url.hash.length > 0
  ) throw searchFailed('SearXNG endpoint must be an HTTP URL without credentials, query, or fragment')
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}

function buildProbeUrl(endpoint: string, options: ProbeOptions): string {
  const url = new URL(endpoint)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/search`
  const params = new URLSearchParams({ q: PROBE_QUERY, format: 'json' })
  for (const key of ['language', 'engines', 'categories'] as const) {
    const value = options[key]
    if (value !== undefined && value.length > 0) params.set(key, value)
  }
  url.search = params.toString()
  return url.toString()
}

function classifyStatus(status: number): void {
  if (status === 401) {
    throw new CliError('E_AUTH_FAILED', 'SearXNG authentication failed', 'Check the configured authorization header and retry')
  }
  if (status === 403) {
    throw new CliError('E_JSON_DISABLED', 'SearXNG JSON search is unavailable', 'Enable json in search.formats and retry')
  }
  if (status === 429) {
    throw new CliError('E_RATE_LIMITED', 'SearXNG rate limited the probe', 'Wait for the limiter window or adjust the instance limiter')
  }
  if (status < 200 || status >= 300) {
    if (RETRYABLE_STATUS.has(status)) throw new TransientProbeError('SearXNG is temporarily unavailable')
    throw searchFailed(`SearXNG search failed with HTTP ${status}`)
  }
}

function parseResults(payload: unknown): unknown[] {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new MalformedProbeResponseError()
  }
  const results = (payload as Record<string, unknown>).results
  if (!Array.isArray(results)) throw new MalformedProbeResponseError()
  return results
}

function hasValidHttpUrl(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const rawUrl = (value as Record<string, unknown>).url
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0 || !URL.canParse(rawUrl)) return false
  const url = new URL(rawUrl)
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.username.length === 0 && url.password.length === 0
}

function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error
  if (isTlsFailure(error)) return tlsFailed()
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const message = String(error.message)
    if (/non-JSON|malformed JSON/i.test(message)) {
      return new CliError('E_JSON_DISABLED', 'SearXNG did not return usable JSON', 'Enable json in search.formats and retry')
    }
  }
  return searchFailed('SearXNG request failed')
}

function rethrowCancellation(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) signal.throwIfAborted()
  if (error !== null && typeof error === 'object') {
    if ('name' in error && error.name === 'AbortError') throw error
    if ('kind' in error && error.kind === 'caller-abort') {
      throw new DOMException('The operation was aborted', 'AbortError')
    }
    if ('code' in error && error.code === 'WEB_ABORTED') {
      throw new DOMException('The operation was aborted', 'AbortError')
    }
  }
}

function isTransientFailure(error: unknown): boolean {
  if (error instanceof TransientProbeError) return true
  if (error === null || typeof error !== 'object' || !('kind' in error)) return false
  return error.kind === 'network' || error.kind === 'timeout'
}

function searchFailed(message: string): CliError {
  return new CliError('E_SEARCH_FAILED', message, 'Check the SearXNG endpoint and run dsh-searxng doctor')
}

function delay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
