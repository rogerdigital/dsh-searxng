# Development Plan — Deepening the Owned-Stack Advantage

Status: proposed. This plan turns the differentiation strategy ("we own the whole search
stack, so we can do what API-wrapper plugins structurally cannot") into scheduled work.

## Strategy

Search itself is a commodity. The moat is **ownership of the full stack** — instance,
configuration, image pin, and HTTP client — and the four capabilities that ownership unlocks
and paid-API plugins cannot follow:

1. **Reliability** — smooth agent-shaped load (bursty, repetitive) into upstream-friendly
   traffic, so self-hosted search survives agent workloads.
2. **Tuning** — measure live engine health *from this network* and adapt the instance.
3. **Curation** — versioned engine presets, with the Chinese web as a first-class target.
4. **Verifiable privacy** — prove the posture (`doctor`), not assert it.

Every milestone below ladders into one of these four. Work that does not, does not belong in
this plan.

## Current state (what we build on)

| Asset | Where | Notes |
|---|---|---|
| Web seam adapter | `src/provider.ts` | Thin; maps client errors to `WebError`. |
| HTTP client | `src/searxng-client.ts` | Dependency-free; 2-attempt retry on 502/503/504 + network/timeout; no 429 handling, no pacing, no cache. |
| Plugin config | `src/index.ts` | `baseURL`, `language`, `engines`, `categories`, `authHeader` — all static, profile-level. |
| Deployment catalog | `assets/deployments/v1.json`, `src/cli/deployments.ts` | Schema 1; one entry; `selectDeployment` supports multi-entry catalogs, but `setup` still hardcodes version 1 (`src/cli/setup.ts:137`). |
| Settings template | `assets/docker/settings.yml.template` | Minimal: `use_default_settings: true`, JSON format, limiter off. |
| Lifecycle commands | `src/cli/{setup,status,doctor,repair,update,remove}.ts` | Journaling, transactional update with rollback, ownership labels. |
| State | `src/cli/state.ts` | Schema-versioned (1, 2 in catalog) with migration hooks. |
| Validation | `src/cli/searxng.ts` | Real-search readiness/probe pipeline reused by setup/update/repair. |
| Tests | `test/cli/*.test.ts`, `test/e2e/managed-setup.test.ts`, opt-in docker integration | Per-module unit tests; `pnpm verify` gate. |

## Non-goals

- **No provider-generated answers** (`WebSearchResult.content`): that is Exa/Perplexity turf;
  self-hosted has no counterpart, and stitched-together snippets read as inferior.
- **No paid-API fallback ("hybrid mode")**: dilutes the free/key-less identity and drags users
  back into accounts and billing.
- **No remote manifests or update channels**: the published npm package remains the only
  channel; the CLI never fetches executable content.
- **No Podman**, no seam-shape changes, no new peer dependencies.

## Milestones

### M1 (v0.4.0) — Catalog-driven setup + reliability under agent load

Theme: pure client-side value plus one tracked debt. No deployment-surface change; fastest
path to user-visible differentiation.

#### 1.1 Wire `setup` to the deployment catalog (tracked follow-up)

- `setup` selects via `selectDeployment(catalog, stateSchema)` instead of the compiled-in
  `?? 1` default (`src/cli/setup.ts:118,137`), matching what `update`/`repair` already do.
- Gate: catalog entries beyond version 1 stay blocked until this ships (per README).
- Files: `src/cli/setup.ts`, `test/cli/setup.test.ts`, `test/cli/deployments.test.ts`.

#### 1.2 Bounded TTL query cache (in-process)

- Key: normalized query + active provider params (`language`/`engines`/`categories` resolved
  per request after M3 routing) + `baseURL`. Value: mapped `WebSearchResult`.
- Memory-only (provider lives inside the dsh process; nothing hits disk — privacy posture
  unchanged). Capacity bound (default 64 entries, LRU) and TTL (default 10 min).
- Cache hits bypass pacing and network entirely; `AbortSignal` semantics trivially preserved.
- Config: `cacheTtlMs` (0 disables) on the plugin `Config` (`src/index.ts`), default 600_000.
- Files: `src/searxng-client.ts` or a new `src/query-cache.ts`, `test/searxng-client.test.ts`.

#### 1.3 Adaptive pacing (token bucket)

- Token bucket in front of each network attempt: capacity 2, refill 1 token / 1500 ms by
  default. Interactive single queries are unaffected (burst absorbs them); agent bursts are
  smoothed instead of translating into upstream 429s.
- The queue wait is abortable: a queued request whose `AbortSignal` fires rejects immediately
  with `WEB_ABORTED`, never leaks a timer.
- Config: `minIntervalMs` (0 disables pacing), default 1500.
- Files: `src/searxng-client.ts`, `test/searxng-client.test.ts` (fake timers).

#### 1.4 Resilient-retry upgrade

- HTTP 429: honor `Retry-After` when present, else exponential backoff (1 attempt extra,
  capped); then surface the existing `E_RATE_LIMITED`-style message.
- Empty or engine-starved response (`results: []` with restrictions configured): one retry
  **without** `engines`/`categories` params — instance defaults are always safe — before
  returning the empty result honestly.
- Keep total attempts bounded (hard cap 3) so agent-visible latency stays predictable.
- Files: `src/searxng-client.ts`, `src/provider.ts` (error mapping if new kinds), tests.

#### 1.5 In-process counters (groundwork)

- Counters on the provider instance: cache hits, pacing delays, retries, fallback retries,
  last error kind. Not surfaced anywhere yet (CLI and provider run in different processes);
  they exist so M4 `stats` and future diagnostics have a shape to grow into.

Validation: `pnpm verify` green; new unit tests with fake `fetch` and fake timers covering
cache eviction/expiry, bucket timing, abort-while-queued, 429 backoff, empty→fallback.

### M2 (v0.5.0) — `tune` + verifiable privacy posture

Theme: the flagship owned-stack feature plus making the privacy claim checkable. Introduces
the settings-overlay renderer that M3 reuses.

#### 2.1 Settings-overlay renderer

- Managed `settings.yml` becomes a layered render: packaged template → overlay(s) → secret
  injection. Overlays are recorded in state and re-applied by `repair`'s rebuild-from-assets
  path (repair keeps its "rebuild template, preserve secret" contract; overlays ride state).
- Overlay content is engine enable/disable/weight only — a closed, renderable vocabulary.
- State schema bump to 3 with migration (mechanism exists; catalog `stateSchemas` gains 3).
- Files: `src/cli/assets.ts`, `src/cli/state.ts`, `assets/deployments/` (schema or entry
  update), `test/cli/assets.test.ts`, `test/cli/state.test.ts`.

#### 2.2 `dsh-searxng tune --profile <name>`

- Runs a fixed probe battery (packaged list, ~6 queries: EN + zh, navigational +
  informational) through the existing JSON client, extended to tolerate-and-collect
  `unresponsive_engines` (absent field degrades gracefully) and per-result `engine`
  attribution; wall-clock latency per query.
- Report (table + `--json`): per engine — responsive share, result share, latency bucket.
- Recommendation: disable engines unresponsive in ≥50% of probes; watch-only below that.
- Apply path uses the M2.1 overlay: confirmation on interactive terminals (`--yes` for
  automation, mirroring `remove`), journaled mutation (same journal as repair/update),
  container restart, then real-search revalidation via the existing `src/cli/searxng.ts`
  pipeline. Failure → overlay rolled back, previous settings restored, journal cleared.
- `tune --reset` clears the overlay. External mode: report-only, never writes.
- `doctor` surfaces the persisted last-tune summary (age, engines disabled).
- Files: new `src/cli/tune.ts`, `src/cli/args.ts` (command), `src/cli/diagnostics.ts`,
  `test/cli/tune.test.ts`, `test/cli/recovery.test.ts` (interplay), docker integration test.

#### 2.3 Privacy posture checks in `doctor`

- New `privacy` section, managed mode: loopback bind (host IP from `docker inspect`),
  query logging disabled (rendered settings assertion), limiter off, secret file permissions,
  JSON format enabled. External mode: endpoint protocol + auth presence.
- Surfaced in human output and `doctor --json`, redaction rules unchanged.
- Files: `src/cli/diagnostics.ts`, `test/cli/diagnostics.test.ts`.

Validation: unit tests for overlay render/rollback/state migration; opt-in docker
integration runs tune end-to-end (`DSH_SEARXNG_DOCKER_INTEGRATION=1`); e2e gains a tune leg.

### M3 (v0.6.0) — Engine presets + CJK-aware routing

Theme: curation, with the Chinese web as the sharp edge. Rides the M2 overlay mechanism.

#### 3.1 Preset overlays as packaged assets

- `assets/presets/catalog.json` (own schema 1, validated like the deployment catalog) mapping
  preset names to overlay fragments under `assets/presets/`: `developer` (github,
  stackoverflow, docs-weighted), `news` (time-biased engines), `science` (arxiv, pubmed,
  crossref), `zh` (baidu, zhihu, bing-cn weighting; CJK-friendly).
- `setup --preset <name>` records the preset in state; render order: template → preset →
  tune overlay (tune wins — live measurement outranks curation). `repair` and `update`
  preserve overlays; an overlay that cannot render against a newer deployment fails closed
  with `E_BUNDLE_DAMAGED`, and `repair` rebuilds without it (stated in output).
- Presets are data shipped per npm release — same update channel, no remote fetch.
- Files: `assets/presets/*`, `src/cli/assets.ts`, `src/cli/setup.ts`, `test/cli/assets.test.ts`.

#### 3.2 CJK-aware per-request language routing

- In the client: when no explicit `language` is configured and the query contains a CJK
  character ratio ≥ 30%, set `language=zh-CN` for that request only. Explicit config and
  SearXNG bang syntax (`!en`, `!zh`) always win — bangs are passed through untouched.
- Config: `autoLanguage` (default true), documented in the provider table.
- Files: `src/searxng-client.ts`, `src/provider.ts`, `src/index.ts`, tests (Chinese, Japanese,
  Korean, mixed, pure-ASCII, bang-present cases).

#### 3.3 Per-query control documentation

- README section: `!bang` engine switching, `site:` filtering, and the M1 empty-result
  fallback behavior — zero seam changes, purely owned-stack affordances.
- Files: `README.md`, `docs/`.

Validation: preset render tests; e2e `setup --preset zh` in opt-in CI; heuristic unit tests.

### M4 (v0.7.0+, unscheduled) — External failover + adjacent capabilities

Not committed work; sequenced after the core lands and proves adoption.

1. **External multi-instance failover** — `baseURLs: string[]` config (first entry primary),
   health-decay scoring in the provider, failover on network/timeout/5xx/429, sticky
   recovery to primary. `setup` external validation probes all entries.
2. **`stats` command** — enable SearXNG `/metrics` in the managed settings; summarize query
   volume, latency distribution, unresponsive engines; reads M1.5-shaped counters where
   available (shared-file channel to be designed).
3. **Fetch-provider design study** (morty sidecar) — the strategic expansion from "search
   plugin" to "self-hosted web layer" (`ctx.web.registerFetchProvider` already exists in the
   seam). Doubles the managed-service surface; a written decision (scope, lifecycle cost,
   certification impact) precedes any implementation.

## Sequencing and dependencies

```
M1 (no deployment-surface change)     M2                        M3            M4
├─ 1.1 catalog wiring ──────────────► (multiple catalog entries become possible)
├─ 1.2 cache                          ├─ 2.1 overlay renderer ─► 3.1 presets
├─ 1.3 pacing                         ├─ 2.2 tune ─────────────► 3.1 (tune overlay)
├─ 1.4 retry upgrade                  └─ 2.3 privacy checks
└─ 1.5 counters
```

- 1.1 is the gate for any catalog entry beyond version 1 (including M2's state-schema-3
  entry and M3 preset assets).
- 2.1 is the shared prerequisite for tune (2.2) and presets (3.1).
- Nothing in M2/M3 blocks on M1's client work; parallel branches are fine, one milestone per
  release train.

## Release discipline (every milestone)

1. `pnpm verify` (typecheck, unit tests, build, pack, packed-CLI check) green on all three
   platforms in CI.
2. Opt-in docker CI legs (`DSH_SEARXNG_E2E=1`, `DSH_SEARXNG_DOCKER_INTEGRATION=1`) exercise
   the new managed surface (tune for M2, preset setup for M3).
3. Pack the tarball and run `pnpm certify:platform` on macOS; record evidence under
   `docs/certification/` and update the README runtime-support claims (Windows certification
   remains an open slot until its report exists).
4. README updates ship in the same PR as the feature — the docs are part of the definition
   of done.

## Risks

| Risk | Mitigation |
|---|---|
| dsh is in developer preview; breaking seam/peer changes | Keep peer windows narrow (current pattern), CI matrix, and treat seam drift as a patch release, not a milestone blocker. |
| SearXNG JSON drift (`unresponsive_engines`, per-result `engine`) | Digest-pinned images make drift opt-in via `update`; tune parses tolerantly and degrades to watch-only. |
| Pacing adds latency to interactive queries | Defaults gentle (burst 2 / 1500 ms); single queries never wait; knobs exposed. |
| Overlay vs. newer SearXNG settings keys | Closed overlay vocabulary (engine enable/disable/weight only); render-time validation fails closed with `E_BUNDLE_DAMAGED`. |
| State schema growth | Bump per milestone at most; migration path exercised in unit tests and by `doctor`. |

## Open questions (decide at milestone kickoff, not now)

- Config knob naming and final defaults (`cacheTtlMs`, `minIntervalMs`, `autoLanguage`).
- `tune` apply UX: confirm-then-apply (chosen) vs. report-only `tune` + `tune --apply`.
- Whether the `zh` preset's engine set needs per-network validation before default enable
  (tune is the safety net; decide whether preset + tune are co-required for `zh`).
- Whether presets ship inside a deployment catalog v2 instead of a sibling catalog (lean:
  sibling catalog — deployment pinning and curation change on different cadences).
