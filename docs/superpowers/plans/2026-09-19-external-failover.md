# External Multi-Instance Failover Implementation Plan

> **For agentic workers:** implement this plan task-by-task; steps use checkbox (`- [ ]`)
> syntax for tracking. Design: `docs/superpowers/specs/2026-09-19-external-failover-design.md`.

**Goal:** Provider-level failover across a configured list of external SearXNG endpoints
(M5.1 core): `baseURLs` config, per-endpoint pacing and health penalties, failover on
network/timeout/502/503/504/429, sticky recovery to the primary, shared budget and
pool-keyed cache. Single-`baseURL` behavior stays byte-for-byte; the CLI/state half of
M5.1 is explicitly deferred (see the design's "Deferred" section).

**Tech Stack:** TypeScript, Vitest with fake fetch/fake timers, tsdown build.

---

### Task 1: Endpoint pool resolution and validation

**Files:**
- Modify: `src/search-session.ts`
- Test: `test/search-session.test.ts`

- [x] Add `resolveEndpointPool(options)` — non-empty `baseURLs` (1..8 entries after
  exact-duplicate collapse, first occurrence kept) wins over `baseURL`; otherwise the
  single-entry pool `[baseURL ?? '']`. RangeError on non-string entries or > 8
  surviving entries.
- [x] Session constructor builds the pool, one `Pacer` per endpoint, and a health
  record (`penalty`, `lastFailureAt`) per endpoint; `cacheKey` uses the pool identity
  (JSON array) instead of the single URL.
- [x] Existing single-`baseURL` tests pass unmodified.

### Task 2: Failover attempt loop

**Files:**
- Modify: `src/search-session.ts`
- Test: `test/search-session.test.ts`

- [x] Re structure `search()`: per attempt, select the endpoint with the lowest
  quantized effective penalty (`penalty * 2^(-(now - lastFailureAt) / 30_000)`,
  `< 0.25` counts as 0), ties by pool order; acquire that endpoint's pacer; run one
  attempt against it.
- [x] Failover classes (network, timeout, HTTP 502/503/504/429) add a penalty and
  continue to the next attempt; any success clears that endpoint's penalty; 429 keeps
  honoring `Retry-After` inside the shared budget; contract and other 4xx stay
  terminal; `MAX_ATTEMPTS = 3` spans the whole pool; last failure thrown as today.
- [x] Tests: failover on network error / 502 / 429-then-success; no failover on 403
  or contract; all-fail throws the last failure; penalty steers the next call's first
  attempt; primary is first again after ~2 half-lives (fake timers); cache is shared
  across the pool; a failover attempt is not delayed by the primary's depleted bucket.

### Task 3: Provider and plugin config surface

**Files:**
- Modify: `src/provider.ts`, `src/index.ts`
- Test: `test/provider.test.ts`

- [x] `SearxngSearchProviderOptions.baseURLs?: string[]`; `available()` requires every
  pool entry valid; `apply` passes a non-empty `baseURLs` through.
- [x] Tests: `baseURLs` precedence over `baseURL`; one invalid entry ⇒ unavailable and
  `invalid-url` `WEB_PROVIDER_ERROR` on search.

### Task 4: README and verification

**Files:**
- Modify: `README.md`

- [x] Document `baseURLs` (primary-first semantics, failover classes, ~30 s half-life
  health decay with sticky recovery, shared budget/cache-by-pool) and the deferred CLI
  note: `setup --url` still records one external endpoint until the state-schema
  follow-up ships.
- [x] `pnpm verify` green (typecheck, tests, build, pack, packed-CLI check).
