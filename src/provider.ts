/**
 * DSH web-seam adapter for the dependency-free SearXNG client.
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
import {
  SearxngClientError,
  isValidSearxngBaseUrl,
  mapSearxngClientResponse,
  mapSearxngClientResult,
  searchSearxng,
} from './searxng-client.ts'
import type { SearxngSearchResponse } from './types.ts'

/** Stable id this provider registers under. */
export const SEARXNG_PROVIDER_ID = 'searxng'

/**
 * Resolved provider options (the plugin's `apply` supplies env-var and
 * constant defaults).
 */
export interface SearxngSearchProviderOptions {
  /** Absolute HTTP(S) SearXNG base URL without credentials, query, or fragment. */
  baseURL: string
  /** Locale passed as SearXNG's `language` parameter, e.g. `zh-CN`. */
  language?: string
  /** Comma-separated engine allowlist passed as SearXNG's `engines` parameter. */
  engines?: string
  /** Comma-separated category filter passed as SearXNG's `categories` parameter. */
  categories?: string
  /** Authorization header value for instances fronted by an API-key gate. */
  authHeader?: string
}

/** Map one SearXNG result to the DSH web source shape. */
export function mapSearxngResult(result: unknown): WebSearchSource | undefined {
  return mapSearxngClientResult(result)
}

/** Map a SearXNG response envelope to the DSH web result shape. */
export function mapSearxngResponse(response: SearxngSearchResponse): WebSearchResult {
  return mapSearxngClientResponse(response)
}

/** The SearXNG-backed search provider; failures surface through stable DSH errors. */
export class SearxngSearchProvider implements WebSearchProvider {
  readonly id = SEARXNG_PROVIDER_ID

  constructor(private readonly options: SearxngSearchProviderOptions) {}

  available(): boolean {
    return isValidSearxngBaseUrl(this.options.baseURL)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    try {
      return await searchSearxng(this.options, request, signal)
    } catch (error: unknown) {
      if (!(error instanceof SearxngClientError)) {
        throw new WebError('SearXNG request failed', 'WEB_PROVIDER_ERROR')
      }
      if (error.kind === 'caller-abort') {
        throw new WebError('SearXNG search aborted', 'WEB_ABORTED')
      }
      if (error.kind === 'invalid-url') {
        throw new WebError(
          'SearXNG base URL must be an absolute HTTP URL without credentials, query, or fragment',
          'WEB_PROVIDER_ERROR',
        )
      }
      if (error.kind === 'timeout') {
        throw new WebError(
          'SearXNG request timed out; check the instance and network, then retry',
          'WEB_PROVIDER_ERROR',
        )
      }
      if (error.kind === 'contract') {
        throw new WebError('SearXNG returned an unprocessable response body', 'WEB_PROVIDER_ERROR')
      }
      if (error.kind === 'http') {
        throw new WebError(httpFailureMessage(error.status), 'WEB_PROVIDER_ERROR')
      }
      throw new WebError('SearXNG request failed', 'WEB_PROVIDER_ERROR')
    }
  }
}

function httpFailureMessage(status: number | undefined): string {
  if (status === 403) {
    return 'SearXNG refused the request (HTTP 403). Most likely the instance does not enable the JSON format — add "json" to search.formats in its settings, or see the plugin README for a ready-to-use docker-compose instance'
  }
  if (status === 429) {
    return 'SearXNG instance rate limit hit (HTTP 429). Space out requests, or raise the limiter limits on the instance'
  }
  return `SearXNG instance error (HTTP ${status ?? 'unknown'})`
}
