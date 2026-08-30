import { CliError } from './errors.ts'
import { requestJsonWithRetry } from '../provider.ts'

const PROBE_QUERY = 'deepseek harness'
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_ATTEMPTS = 1
const DEFAULT_READINESS_ATTEMPTS = 30
const READINESS_RETRY_DELAY_MS = 100
const RETRYABLE_STATUS = new Set([502, 503, 504])

export interface ProbeOptions {
  baseURL: string
  authHeader?: string
  timeoutMs?: number
  attempts?: number
  fetch?: typeof globalThis.fetch
}

export interface ProbeResult {
  endpoint: string
  resultCount: number
  elapsedMs: number
}

export interface SearxngProbe {
  readiness(options: ProbeOptions, signal?: AbortSignal): Promise<void>
  realSearch(options: ProbeOptions, signal?: AbortSignal): Promise<ProbeResult>
  providerSearch(options: ProbeOptions, signal?: AbortSignal): Promise<ProbeResult>
}

interface ProbeAttemptResult {
  endpoint: string
  resultCount: number
  elapsedMs: number
}

class TransientProbeError extends Error {}

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
  async readiness(options: ProbeOptions, signal?: AbortSignal): Promise<void> {
    try {
      await runProbe({ ...options, attempts: options.attempts ?? DEFAULT_READINESS_ATTEMPTS }, true, signal)
    } catch (error) {
      if (error instanceof CliError && isImmediateFailure(error.code)) throw error
      if (error instanceof MalformedProbeResponseError) throw error
      if (signal?.aborted) throw searchFailed('SearXNG readiness check was cancelled')
      throw new CliError(
        'E_SEARXNG_START_TIMEOUT',
        'SearXNG did not become ready within the bounded startup checks',
        'Run dsh-searxng doctor and inspect the managed SearXNG logs',
      )
    }
  }

  realSearch(options: ProbeOptions, signal?: AbortSignal): Promise<ProbeResult> {
    return probeSearxng(options, signal)
  }

  providerSearch(options: ProbeOptions, signal?: AbortSignal): Promise<ProbeResult> {
    return probeSearxng(options, signal)
  }
}

async function runProbe(
  options: ProbeOptions,
  allowEmptyResults: boolean,
  signal?: AbortSignal,
): Promise<ProbeAttemptResult> {
  const endpoint = validateEndpoint(options.baseURL)
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw searchFailed('Probe attempts must be a positive safe integer')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw searchFailed('Probe timeout must be a positive safe integer')

  const startedAt = Date.now()
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw searchFailed('SearXNG probe was cancelled')
    try {
      const request = await requestJsonWithRetry({
        url: buildProbeUrl(endpoint),
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
      if (!results.every(hasValidHttpUrl)) throw new MalformedProbeResponseError()
      if (!allowEmptyResults && results.length === 0) {
        throw searchFailed('SearXNG returned no usable search result')
      }
      return { endpoint, resultCount: results.length, elapsedMs: Math.max(0, Date.now() - startedAt) }
    } catch (error) {
      lastError = toCliError(error, signal)
      if (lastError instanceof CliError && isImmediateFailure(lastError.code)) throw lastError
      if (!isTransientFailure(error)) throw lastError
      if (attempt === attempts) throw lastError
      await delay(READINESS_RETRY_DELAY_MS, signal)
    }
  }
  throw toCliError(lastError, signal)
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

function buildProbeUrl(endpoint: string): string {
  const url = new URL(endpoint)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/search`
  url.search = new URLSearchParams({ q: PROBE_QUERY, format: 'json' }).toString()
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

function toCliError(error: unknown, signal?: AbortSignal): CliError {
  if (error instanceof CliError) return error
  if (signal?.aborted) return searchFailed('SearXNG probe was cancelled')
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const message = String(error.message)
    if (/non-JSON|malformed JSON/i.test(message)) {
      return new CliError('E_JSON_DISABLED', 'SearXNG did not return usable JSON', 'Enable json in search.formats and retry')
    }
  }
  return searchFailed('SearXNG request failed')
}

function isTransientFailure(error: unknown): boolean {
  if (error instanceof TransientProbeError) return true
  if (error === null || typeof error !== 'object' || !('kind' in error)) return false
  return error.kind === 'network' || error.kind === 'timeout'
}

function isImmediateFailure(code: CliError['code']): boolean {
  return code === 'E_AUTH_FAILED' || code === 'E_JSON_DISABLED' || code === 'E_RATE_LIMITED'
}

function searchFailed(message: string): CliError {
  return new CliError('E_SEARCH_FAILED', message, 'Check the SearXNG endpoint and run dsh-searxng doctor')
}

function delay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(searchFailed('SearXNG probe was cancelled'))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(searchFailed('SearXNG probe was cancelled'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
