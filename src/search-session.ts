/**
 * Provider-owned search session: one instance lives inside one
 * `SearxngSearchProvider`, so cache entries and pacing state never leak across
 * profiles or authentication contexts. The free functions in
 * `searxng-client.ts` stay uncontrolled on purpose — CLI lifecycle probes must
 * measure fresh, unpaced responses.
 *
 * One total budget spans the whole `search()` call: the pacing wait, every
 * backoff delay, and every network attempt. Attempt counts are a secondary
 * guard; the budget is the primary latency bound.
 *
 * @module dsh-searxng/search-session
 */

import {
  SearxngClientError,
  abortableDelay,
  buildSearchUrl,
  buildSearxngSearchParams,
  isSearxngSearchResponse,
  isValidSearxngBaseUrl,
  mapSearxngClientResponse,
  requestJsonWithRetry,
  searxngRequestHeaders,
} from './searxng-client.ts'
import type { SearxngClientOptions, SearxngClientResult } from './searxng-client.ts'

/** Knobs are per provider instance; defaults follow docs/development-plan.md M1. */
export interface SearxngSearchSessionOptions extends SearxngClientOptions {
  /** Cached entry lifetime in milliseconds; 0 disables caching. Default 600_000. */
  cacheTtlMs?: number
  /** Maximum cached entries (LRU). Default 64. */
  cacheCapacity?: number
  /** Minimum spacing between network attempts; 0 disables pacing. Default 1500. */
  minIntervalMs?: number
  /** Maximum requests waiting for a pacing slot before rejecting. Default 8. */
  queueCapacity?: number
  /** Total wall-clock budget for one search call. Default 15_000. */
  totalBudgetMs?: number
}

const DEFAULT_CACHE_TTL_MS = 600_000
const DEFAULT_CACHE_CAPACITY = 64
const DEFAULT_MIN_INTERVAL_MS = 1_500
const DEFAULT_QUEUE_CAPACITY = 8
const DEFAULT_TOTAL_BUDGET_MS = 15_000
const DEFAULT_BACKOFF_AFTER_RATE_LIMIT_MS = 1_000
const MAX_ATTEMPTS = 3
const RETRYABLE_STATUSES = new Set([502, 503, 504])

interface CacheEntry {
  readonly expiresAt: number
  readonly value: SearxngClientResult
}

interface PacerWaiter {
  readonly deadlineAt: number
  readonly signal?: AbortSignal
  resolve(): void
  reject(error: SearxngClientError): void
  onAbort(): void
}

/**
 * Token bucket with a bounded FIFO of waiting acquirers. Tokens refill
 * continuously; a full queue rejects immediately (`busy`) instead of holding
 * the caller, and every wait is abortable. Pacing is provider-instance-local:
 * it cannot coordinate other processes sharing the same instance or IP.
 */
class Pacer {
  private tokens: number
  private lastRefillAt: number
  private readonly waiters: PacerWaiter[] = []
  private wakeTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly capacity: number,
    private readonly intervalMs: number,
    private readonly queueCapacity: number,
  ) {
    this.tokens = capacity
    this.lastRefillAt = Date.now()
  }

  acquire(deadlineAt: number, signal?: AbortSignal): Promise<void> {
    if (this.waiters.length >= this.queueCapacity) {
      return Promise.reject(new SearxngClientError(
        'busy',
        'SearXNG provider pacing queue is full; retry after in-flight searches settle',
      ))
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: PacerWaiter = {
        deadlineAt,
        ...(signal === undefined ? {} : { signal }),
        resolve,
        reject,
        onAbort: () => {
          this.removeWaiter(waiter)
          reject(new SearxngClientError('caller-abort', 'SearXNG search aborted'))
        },
      }
      signal?.addEventListener('abort', waiter.onAbort, { once: true })
      this.waiters.push(waiter)
      this.drain()
    })
  }

  private removeWaiter(waiter: PacerWaiter): void {
    const index = this.waiters.indexOf(waiter)
    if (index >= 0) this.waiters.splice(index, 1)
    if (this.waiters.length === 0) this.clearWake()
  }

  private drain(): void {
    const now = Date.now()
    // Budget spent waiting never starts a network attempt.
    for (const waiter of [...this.waiters]) {
      if (waiter.deadlineAt <= now) {
        this.removeWaiter(waiter)
        waiter.signal?.removeEventListener('abort', waiter.onAbort)
        waiter.reject(new SearxngClientError('budget', 'SearXNG search budget expired while waiting for a pacing slot'))
      }
    }
    this.refill(now)
    while (this.waiters.length > 0 && this.tokens >= 1) {
      const waiter = this.waiters.shift()
      if (waiter === undefined) break
      this.tokens -= 1
      waiter.signal?.removeEventListener('abort', waiter.onAbort)
      waiter.resolve()
    }
    this.scheduleWake()
  }

  private refill(now: number): void {
    const gained = (now - this.lastRefillAt) / this.intervalMs
    if (gained > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + gained)
      this.lastRefillAt = now
    }
  }

  private scheduleWake(): void {
    if (this.waiters.length === 0) {
      this.clearWake()
      return
    }
    const now = Date.now()
    const timeToNextToken = this.tokens >= 1 ? 0 : (1 - this.tokens) * this.intervalMs
    let nextEventAt = now + timeToNextToken
    for (const waiter of this.waiters) nextEventAt = Math.min(nextEventAt, waiter.deadlineAt)
    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer)
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined
      this.drain()
    }, Math.max(1, nextEventAt - now))
  }

  private clearWake(): void {
    if (this.wakeTimer !== undefined) {
      clearTimeout(this.wakeTimer)
      this.wakeTimer = undefined
    }
  }
}

export class SearxngSearchSession {
  private readonly options: SearxngSearchSessionOptions
  private readonly cacheTtlMs: number
  private readonly cacheCapacity: number
  private readonly totalBudgetMs: number
  private readonly perAttemptTimeoutMs: number
  private readonly retryDelayMs: number
  private readonly pacing: Pacer | undefined
  private readonly cache = new Map<string, CacheEntry>()

  constructor(options: SearxngSearchSessionOptions) {
    const {
      cacheTtlMs = DEFAULT_CACHE_TTL_MS,
      cacheCapacity = DEFAULT_CACHE_CAPACITY,
      minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
      queueCapacity = DEFAULT_QUEUE_CAPACITY,
      totalBudgetMs = DEFAULT_TOTAL_BUDGET_MS,
    } = options
    if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 0) {
      throw new RangeError('cacheTtlMs must be a non-negative safe integer')
    }
    if (!Number.isSafeInteger(cacheCapacity) || cacheCapacity < 1) {
      throw new RangeError('cacheCapacity must be a positive safe integer')
    }
    if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0) {
      throw new RangeError('minIntervalMs must be a non-negative safe integer')
    }
    if (!Number.isSafeInteger(queueCapacity) || queueCapacity < 1) {
      throw new RangeError('queueCapacity must be a positive safe integer')
    }
    if (!Number.isSafeInteger(totalBudgetMs) || totalBudgetMs < 1) {
      throw new RangeError('totalBudgetMs must be a positive safe integer')
    }
    this.options = options
    this.cacheTtlMs = cacheTtlMs
    this.cacheCapacity = cacheCapacity
    this.totalBudgetMs = totalBudgetMs
    this.perAttemptTimeoutMs = options.timeoutMs ?? 10_000
    this.retryDelayMs = options.retryDelayMs ?? 100
    this.pacing = minIntervalMs === 0 ? undefined : new Pacer(2, minIntervalMs, queueCapacity)
  }

  /** Run one search through instance-local cache, pacing, and the total budget. */
  async search(query: string, signal?: AbortSignal): Promise<SearxngClientResult> {
    if (signal?.aborted) throw new SearxngClientError('caller-abort', 'SearXNG search aborted')
    if (!isValidSearxngBaseUrl(this.options.baseURL)) {
      throw new SearxngClientError('invalid-url', 'SearXNG base URL is invalid')
    }
    const key = this.cacheKey(query)
    const cached = this.readCached(key)
    if (cached !== undefined) return structuredClone(cached)

    const deadlineAt = Date.now() + this.totalBudgetMs
    await this.pacing?.acquire(deadlineAt, signal)

    let lastFailure: SearxngClientError | undefined
    let rateLimitBackoffUsed = false
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) throw lastFailure ?? budgetExpired()
      let outcome: Awaited<ReturnType<typeof requestJsonWithRetry>>
      try {
        outcome = await requestJsonWithRetry({
          url: buildSearchUrl(this.options.baseURL, buildSearxngSearchParams(this.options, query)),
          headers: searxngRequestHeaders(this.options),
          ...(signal === undefined ? {} : { signal }),
          timeoutMs: Math.max(1, Math.min(this.perAttemptTimeoutMs, Math.ceil(remaining))),
          maxAttempts: 1,
          ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
        })
      } catch (error) {
        if (!(error instanceof SearxngClientError)) throw error
        if (error.kind !== 'timeout' && error.kind !== 'network') throw error
        lastFailure = error
        if (attempt === MAX_ATTEMPTS) throw error
        const delay = Math.min(this.retryDelayMs, deadlineAt - Date.now() - 1)
        if (delay <= 0) throw error
        await abortableDelay(delay, signal)
        continue
      }

      if (outcome.response.ok) {
        if (!isSearxngSearchResponse(outcome.payload)) {
          throw new SearxngClientError('contract', 'SearXNG returned an unprocessable response body')
        }
        const mapped = mapSearxngClientResponse(outcome.payload)
        this.writeCached(key, mapped)
        return mapped
      }

      const status = outcome.response.status
      lastFailure = new SearxngClientError('http', `SearXNG search failed with HTTP ${status}`, status)
      const retryableStatus = RETRYABLE_STATUSES.has(status)
      const rateLimited = status === 429 && !rateLimitBackoffUsed
      if (!retryableStatus && !rateLimited) throw lastFailure
      let delay = this.retryDelayMs
      if (status === 429) {
        rateLimitBackoffUsed = true
        delay = parseRetryAfterMs(outcome.response.headers.get('retry-after'))
          ?? Math.max(delay, DEFAULT_BACKOFF_AFTER_RATE_LIMIT_MS)
      }
      // Never retry earlier than Retry-After; a delay that no longer fits in
      // the budget returns the failure instead of starting another attempt.
      if (delay >= deadlineAt - Date.now()) throw lastFailure
      await abortableDelay(delay, signal)
    }
    throw lastFailure ?? budgetExpired()
  }

  private cacheKey(query: string): string {
    // Exact query text (syntax and case preserved) plus every resolved
    // request-shaping option and the endpoint identity.
    return JSON.stringify([
      this.options.baseURL,
      this.options.language ?? '',
      this.options.engines ?? '',
      this.options.categories ?? '',
      query,
    ])
  }

  private readCached(key: string): SearxngClientResult | undefined {
    if (this.cacheTtlMs === 0) return undefined
    const entry = this.cache.get(key)
    if (entry === undefined) return undefined
    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(key)
      return undefined
    }
    // Re-insert so eviction order tracks recency of use, not just insertion.
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.value
  }

  private writeCached(key: string, value: SearxngClientResult): void {
    if (this.cacheTtlMs === 0) return
    this.cache.delete(key)
    this.cache.set(key, { expiresAt: Date.now() + this.cacheTtlMs, value })
    while (this.cache.size > this.cacheCapacity) {
      const oldest = this.cache.keys().next()
      if (oldest.done === true) break
      this.cache.delete(oldest.value)
    }
  }
}

function budgetExpired(): SearxngClientError {
  return new SearxngClientError('budget', 'SearXNG search budget expired before a network attempt')
}

/** Parse a `Retry-After` header carrying delay seconds; other forms fall back to the default. */
function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined
  return Number.parseInt(value.trim(), 10) * 1_000
}
