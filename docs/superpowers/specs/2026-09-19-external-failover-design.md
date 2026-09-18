# External Multi-Instance Failover Design

**Status:** Approved design (M5.1 scope decision recorded 2026-09-19)

**Date:** 2026-09-19

## Problem

The provider talks to exactly one SearXNG endpoint. When that instance is
stopped, upgraded, rate-limited by upstream engines, or network-partitioned,
every search fails until it recovers — the failure mode the 2026-09-11/12
evaluations recorded repeatedly (single-engine posture, engine cooldown,
CAPTCHA suspensions). An operator running two or more instances (for example a
local managed instance plus a remote one, or two hosts on different networks)
has no way to express that redundancy today: `Config.baseURL` is a single
string, and `setup --url` records a single external endpoint.

`docs/development-plan.md` M5.1 names this feature: "`baseURLs: string[]`
config (first entry primary), health-decay scoring in the provider, failover
on network/timeout/5xx/429, sticky recovery to primary. `setup` external
validation probes all entries."

## Decision

Ship the provider-level half of M5.1 now; defer the CLI/state half.

**In scope (this design):**

- `Config.baseURLs?: string[]` and the matching provider option. The first
  entry is primary. A non-empty `baseURLs` defines the endpoint pool and wins
  over `baseURL`; absent/empty `baseURLs` keeps today's single-`baseURL`
  behavior byte-for-byte (all existing tests must stay green unmodified).
- An endpoint pool inside `SearxngSearchSession`: one `Pacer` per endpoint,
  one health penalty per endpoint, and failover between network attempts.
- Failover classes (closed list): network failures, timeouts, and HTTP
  502/503/504/429. `contract` failures and other 4xx stay terminal — a
  malformed response or a JSON-disabled instance is a configuration problem
  that failover would silently mask, the same reasoning that keeps empty
  results honest.
- One shared total budget, one shared LRU cache keyed by the **pool identity**
  (the ordered URL list), not by the endpoint that happened to serve. A warm
  entry from a now-dead instance still answers a repeated query; instances in
  one pool are assumed to serve equivalent content.
- Hard cap of 3 network attempts per `search()` call across the whole pool
  (unchanged), and a config cap of 8 pool entries.

**Deferred (recorded follow-ups, not silent drops):**

- `setup --url` accepting multiple entries, the external endpoint list in
  `state.json`, profile-patch rendering of `baseURLs`, and repair fidelity for
  that list. This requires a state schema bump; the plan allows at most one
  schema bump per milestone and M3 already claims the next one if it ships.
  Until then `baseURLs` is a profile-config knob the operator sets directly,
  and `setup --url` keeps recording exactly one external endpoint.
- `doctor`/`tune` reporting per external endpoint (rides the CLI slice).
- A `SEARXNG_BASE_URLS` environment fallback (no consumer asked for it).

## Health model

Per endpoint, the session keeps a `penalty` and the time of its last failure:

- Construction: `penalty = 0` for every endpoint.
- Failover-class failure: `penalty += 1` (recorded at the failure time).
- Any success on that endpoint: `penalty = 0`.
- Effective penalty at selection time: `penalty * 2^(-(now - lastFailureAt) /
  30_000)` — a 30 s half-life, an internal constant until a consumer needs a
  knob (open question below).
- Selection orders endpoints by quantized effective penalty
  (`< 0.25` counts as fully healthy), ties broken by config order.

Consequences, by construction:

- **Failover**: a fresh failure gives the endpoint an effective penalty of 1
  while untouched endpoints sit at 0, so the next attempt (and the first
  attempt of later calls) goes elsewhere.
- **Sticky recovery to primary**: penalties decay with time, and equal
  quantized penalties resolve to config order, so the primary regains the
  first slot roughly two half-lives (~60 s) after its last failure — or
  immediately after any primary success.
- **Single-entry pools**: one endpoint makes selection a constant; the
  attempt/retry/backoff loop degenerates exactly to today's behavior.

## Attempt loop

Per `search()` call: acquire the pacing token of the currently selected
endpoint, run one network attempt, then classify. Failover classes advance to
the next-best endpoint (re-selected after each failure, so a third attempt can
return to a retried primary); 429 still honors `Retry-After` inside the shared
budget before the next attempt. The shared `deadlineAt` bounds queue waits,
backoff, and every attempt across all endpoints; `AbortSignal` keeps winning
over all of it. When every attempt fails, the last failure is thrown, exactly
as today.

Pacing stays per endpoint: traffic aimed at instance B must not wait on
instance A's depleted bucket. A caller already waiting in one endpoint's queue
stays queued (abortable, budget-bounded); failover happens between attempts,
not inside a pacing wait.

## Config surface

```ts
// plugin Config and SearxngSearchProviderOptions
baseURLs?: string[]  // 1..8 entries; first is primary; wins over baseURL
```

Validation mirrors the single-URL rule (`isValidSearxngBaseUrl` per entry;
exact duplicates collapse, keeping first occurrence). `available()` requires
every entry to be valid — one malformed entry makes the provider honestly
unavailable rather than silently skipping an instance the operator named.
Failures keep today's shapes and messages (no endpoint host is embedded in
error text; diagnosis belongs to `doctor`/`tune`, and the deferred CLI slice
will report per-endpoint state).

## Tests

Extend `test/search-session.test.ts` and `test/provider.test.ts` in the
existing fake-fetch/fake-timer style:

1. Network error on the primary fails over and succeeds on the secondary.
2. 502 and 429 (with in-budget `Retry-After`) fail over; 403 and `contract`
   failures stay terminal with a single endpoint attempted.
3. A primary failure steers the next call's first attempt to the secondary;
   after ~2 half-lives (fake timers) the primary is first again.
4. The cache is shared across the pool: a repeat query served earlier by a
   now-failing primary does not hit the network.
5. Per-endpoint pacing: a failover attempt is not delayed by the primary's
   depleted bucket.
6. All endpoints failing throws the last failure; budget exhaustion across
   failover stays bounded.
7. Provider: `baseURLs` precedence over `baseURL`, one invalid entry ⇒
   `available() === false` and `invalid-url` on search.

Single-`baseURL` behavior is pinned by the existing suite, which must pass
unmodified.
