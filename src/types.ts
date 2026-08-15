/**
 * Wire types for the SearXNG JSON search API (`GET /search?format=json`).
 * Types only — no runtime code. Fields are optional because a SearXNG
 * response is a best-effort aggregation across upstream engines: entries
 * lacking `content` (the snippet) or `publishedDate` are common, and the
 * whole `results` array is absent on some failures.
 *
 * @module dsh-searxng/types
 */

/** One entry of SearXNG's `results[]`. */
export interface SearxngResult {
  url?: string | null
  title?: string | null
  /** Snippet text extracted by the upstream engine. Maps to `snippet`. */
  content?: string | null
  /** Engine(s) that produced this entry. */
  engine?: string | null
  /** Relevance score assigned by SearXNG's ranking. */
  score?: number | null
  /** Publication timestamp as an engine-supplied string, not normalized. */
  publishedDate?: string | null
}

/** SearXNG's search response envelope. */
export interface SearxngSearchResponse {
  query?: string
  results?: SearxngResult[]
  /** Direct answers (e.g. from answer engines), rendered as strings. */
  answers?: string[]
  /** Search suggestions for the query. */
  suggestions?: string[]
  /** Engines that were contacted but failed; shape varies by SearXNG version. */
  unresponsive_engines?: unknown[]
  /** Upstream-reported total result count; frequently 0 or absent. */
  number_of_results?: number | null
}
