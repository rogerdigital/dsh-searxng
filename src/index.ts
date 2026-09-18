/**
 * `dsh-searxng`: registers a SearXNG-backed `WebSearchProvider`
 * with `ctx.web`. A function plugin (NOT a default-export service): a
 * search provider does not own the `ctx.web` key — it registers INTO the
 * seam's provider registry, exactly as `@deepseek-ai/dsh-web-search-exa`
 * does. The key is owned by `@deepseek-ai/dsh-web`.
 *
 * @module dsh-searxng
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { SearxngSearchProvider } from './provider.ts'

export {
  SEARXNG_PROVIDER_ID,
  SearxngSearchProvider,
} from './provider.ts'
export type { SearxngSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-searxng'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** SearXNG instance base URL without a query or fragment. Falls back to `$SEARXNG_BASE_URL`. Empty → unavailable. */
  baseURL?: string
  /** Failover pool of SearXNG base URLs; the first entry is primary and a non-empty list wins over `baseURL`. */
  baseURLs?: string[]
  /** Locale passed as SearXNG's `language` parameter, e.g. `zh-CN`. */
  language?: string
  /** Comma-separated engine allowlist passed as SearXNG's `engines` parameter. */
  engines?: string
  /** Comma-separated category filter passed as SearXNG's `categories` parameter. */
  categories?: string
  /** Authorization header value for instances fronted by an API-key gate. */
  authHeader?: string
  /** Cached query result lifetime in milliseconds; 0 disables caching. Default 600000. */
  cacheTtlMs?: number
  /** Minimum spacing between network requests in milliseconds; 0 disables pacing. Default 1500. */
  minIntervalMs?: number
  /** Maximum requests waiting for a pacing slot before rejecting. Default 8. */
  queueCapacity?: number
  /** Total wall-clock budget for one search call in milliseconds. Default 15000. */
  totalBudgetMs?: number
}

export const Config: z<Config> = z.object({
  baseURL: z.string(),
  baseURLs: z.array(z.string()),
  language: z.string(),
  engines: z.string(),
  categories: z.string(),
  authHeader: z.string(),
  cacheTtlMs: z.number(),
  minIntervalMs: z.number(),
  queueCapacity: z.number(),
  totalBudgetMs: z.number(),
})

/** Register the SearXNG search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new SearxngSearchProvider({
    // No public instance is assumed: most disable the JSON format and
    // rate-limit heavily, so an unset base URL honestly reads "unavailable".
    baseURL: config.baseURL ?? launchEnvironmentOf(ctx).get('SEARXNG_BASE_URL')?.value ?? '',
    ...(Array.isArray(config.baseURLs) && config.baseURLs.length > 0 ? { baseURLs: config.baseURLs } : {}),
    ...config.language !== undefined && config.language.length > 0 ? { language: config.language } : {},
    ...config.engines !== undefined && config.engines.length > 0 ? { engines: config.engines } : {},
    ...config.categories !== undefined && config.categories.length > 0 ? { categories: config.categories } : {},
    ...config.authHeader !== undefined && config.authHeader.length > 0 ? { authHeader: config.authHeader } : {},
    ...config.cacheTtlMs !== undefined ? { cacheTtlMs: config.cacheTtlMs } : {},
    ...config.minIntervalMs !== undefined ? { minIntervalMs: config.minIntervalMs } : {},
    ...config.queueCapacity !== undefined ? { queueCapacity: config.queueCapacity } : {},
    ...config.totalBudgetMs !== undefined ? { totalBudgetMs: config.totalBudgetMs } : {},
  }))
}
