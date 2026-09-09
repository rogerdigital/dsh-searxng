# Development Plan — Deepening the Owned-Stack Advantage

Status: proposed; revised after a technical review that verified config-mount, journal,
and error-code semantics against the codebase (see "Revision notes" at the end).

## Strategy

Search itself is a commodity. The moat is **ownership of the full stack** — instance,
configuration, image pin, and HTTP client — and the four capabilities that ownership unlocks
and paid-API plugins cannot follow:

1. **Reliability** — smooth agent-shaped load (bursty, repetitive) into upstream-friendly
   traffic, so self-hosted search survives agent workloads.
2. **Tuning** — measure live engine health *from this network* and adapt the instance.
3. **Curation** — versioned engine presets, with the Chinese web as a first-class target.
4. **Verifiable privacy** — prove the local posture (`doctor`), never overclaim the chain.

Every milestone below ladders into one of these four. Work that does not, does not belong in
this plan.

## Current state (what we build on)

| Asset | Where | Notes |
|---|---|---|
| Web seam adapter | `src/provider.ts` | Thin; maps client errors to `WebError`. |
| HTTP client | `src/searxng-client.ts` | Dependency-free; 2-attempt retry on 502/503/504 + network/timeout; no 429 handling, no pacing, no cache. |
| Plugin config | `src/index.ts` | `baseURL`, `language`, `engines`, `categories`, `authHeader` — all static, profile-level. |
| Deployment catalog | `assets/deployments/v1.json`, `src/cli/deployments.ts` | Schema 1; one entry; `selectDeployment` supports multi-entry catalogs, but `setup` still hardcodes version 1 (`src/cli/setup.ts:137`). |
| Bundle publishing | `src/cli/assets.ts` | Content-addressed, immutable bundle directories (`configurationHash` names the directory; `.env` points `DSH_SEARXNG_SETTINGS_DIR` at it). `stage()` is the transactional publish path used by `update`. |
| Journal | `src/cli/journal.ts` | Kinds `setup/repair/update/remove`; `target` carries only `deploymentVersion/image`; recovery recommendations are phase-based. Schema 1, strict keys. |
| Lifecycle commands | `src/cli/{setup,status,doctor,repair,update,remove}.ts` | Journaling, transactional update with rollback, ownership labels; `repair` actions include `restart-container` and `recreate-runtime`. |
| State | `src/cli/state.ts` | Schema-versioned (1, 2 in catalog) with migration hooks. |
| Validation | `src/cli/searxng.ts` | Real-search readiness/probe pipeline reused by setup/update/repair. |
| Tests | `test/cli/*.test.ts`, `test/e2e/managed-setup.test.ts`, opt-in docker integration | Per-module unit tests; `pnpm verify` gate. |

## Non-goals

- **No provider-generated answers** (`WebSearchResult.content`): that is Exa/Perplexity turf;
  self-hosted has no counterpart, and stitched-together snippets read as inferior.
- **No paid-API fallback ("hybrid mode")**: dilutes the free/key-less identity and drags users
  back into accounts and billing.
- **No silent widening of user search restrictions**: `engines`/`categories` are an allowlist
  expressing user intent. Empty results are returned honestly; they are never retried against
  a different engine set by default.
- **No unbounded work in one search call**: pacing waits, backoff, and network attempts all
  share one total deadline; a search call never blocks indefinitely.
- **No remote manifests or update channels**: the published npm package remains the only
  channel; the CLI never fetches executable content.
- **No Podman**, no seam-shape changes, no new peer dependencies.

## Milestones

### M1 (v0.4.0) — Catalog-driven setup + bounded client reliability

Theme: pure client-side value plus one tracked debt. No deployment-surface change; fastest
path to user-visible differentiation.

#### 1.1 Wire `setup` to the deployment catalog (tracked follow-up)

- `setup` selects via `selectDeployment(catalog, stateSchema)` instead of the compiled-in
  `?? 1` default (`src/cli/setup.ts:118,137`), matching what `update`/`repair` already do.
- Gate: catalog entries beyond version 1 stay blocked until this ships (per README).
- Files: `src/cli/setup.ts`, `test/cli/setup.test.ts`, `test/cli/deployments.test.ts`.

#### 1.2 Bounded TTL query cache (in-process)

- Key: normalized query + resolved provider params (`language`/`engines`/`categories`) +
  `baseURL`. Value: mapped `WebSearchResult`.
- Memory-only (provider lives inside the dsh process; nothing hits disk — privacy posture
  unchanged). Capacity bound (default 64 entries, LRU) and TTL (default 10 min).
- Cache hits bypass pacing and network entirely; `AbortSignal` semantics trivially preserved.
- Config: `cacheTtlMs` (0 disables) on the plugin `Config` (`src/index.ts`), default 600_000.
- Files: `src/searxng-client.ts` or a new `src/query-cache.ts`, `test/searxng-client.test.ts`.

#### 1.3 Adaptive pacing with a bounded queue

- Token bucket in front of each network attempt: capacity 2, refill 1 token / 1500 ms by
  default. Interactive single queries are unaffected (burst absorbs them); agent bursts are
  smoothed instead of translating into upstream 429s.
- The pacing queue is bounded (default 8 waiting requests). A full queue rejects immediately
  with the provider-error code rather than holding the caller indefinitely; the rejection is
  honest backpressure the agent can retry on.
- Both the queue wait and the token wait honor `AbortSignal` immediately.
- Config: `minIntervalMs` (0 disables pacing), default 1500.
- Files: `src/searxng-client.ts`, `test/searxng-client.test.ts` (fake timers).

#### 1.4 Retry under one total deadline

- A single budget (default 15 s) spans the whole `search()` call: pacing wait, backoff
  delays, and every network attempt. Each attempt's timeout is clamped to the remaining
  budget; `Retry-After` is honored but clamped to the remaining budget; exhaustion returns
  the last failure rather than starting another attempt.
- HTTP 429: at most one extra backoff attempt, only if the remaining budget allows it.
  502/503/504 keep the existing fast-retry path, budget-bound. Hard cap of 3 attempts stays
  as a secondary guard.
- `AbortSignal` is honored in every stage (queue, backoff delay, fetch); abort always wins
  over budget arithmetic.
- **Empty results are not retried differently**: with `engines`/`categories` configured, an
  empty page is a valid outcome and is returned as-is (see non-goals).
- Files: `src/searxng-client.ts`, `src/provider.ts` (error mapping), tests.

Validation: `pnpm verify` green; unit tests with fake `fetch` and fake timers covering cache
eviction/expiry, bucket timing, queue-full rejection, abort in each stage, 429 backoff within
budget, budget exhaustion.

Deferred from the original draft: in-process counters. Nothing consumes them (the `stats`
idea is unscheduled and reads SearXNG's own `/metrics`); they return when a consumer exists.

### M2 (v0.5.0) — Read-only `tune` report + scoped privacy posture

Theme: the measurement and trust half of tuning, with **zero mutation surface**. The apply
path is deliberately a separate milestone (M3) because configuration changes are
transactional work, not a restart.

#### 2.1 `dsh-searxng tune --profile <name>` (report only)

- Runs a fixed probe battery (packaged list, ~6 queries: EN + zh, navigational +
  informational) through the existing JSON client, extended to tolerate-and-collect
  `unresponsive_engines` and per-result `engine` attribution; wall-clock time per query.
- Evidence rules, forced by the API surface (the JSON response exposes no dispatch list and
  no per-engine timing):
  - Wall time is an aggregate across the fan-out; it is **never attributed to a single
    engine** and never drives recommendations.
  - Absence from `unresponsive_engines` is **not health**: participation is unknowable, so
    responsive-share is not computed and silence earns no credit.
  - The only direct failure evidence is **presence** in `unresponsive_engines` — an engine
    that appears there was dispatched to and failed.
- Report (table + `--json`): per engine — probes failed (of N), result contribution share;
  per query — wall time and its unresponsive list.
- Recommendations are conservative by construction: an engine is recommended for disable
  only if it failed in a **majority of probes** *and* contributed ~zero results across the
  battery. Everything else is watch-only. `tune` in this milestone writes nothing — managed
  and external modes are equally read-only, so the report is safe on any instance.
- `doctor` surfaces the persisted last-tune summary (age, failed engines) as diagnostics.
- Files: new `src/cli/tune.ts`, `src/cli/args.ts`, `src/cli/diagnostics.ts`,
  `test/cli/tune.test.ts`, `test/cli/diagnostics.test.ts`.

#### 2.2 Privacy posture checks in `doctor`, scoped to what is checkable

- **Verified local configuration** section: loopback bind (host IP from `docker inspect`),
  query logging disabled in the rendered settings, limiter off, secret file permissions,
  JSON format enabled.
- **Explicitly out of scope** section, stated in the output itself: upstream engine logging
  and network observers cannot be verified from this host. Local switches are never
  presented as an end-to-end privacy guarantee.
- Surfaced in human output and `doctor --json`, redaction rules unchanged. External mode:
  endpoint protocol and auth presence only, same scoping language.
- Files: `src/cli/diagnostics.ts`, `test/cli/diagnostics.test.ts`.

Validation: unit tests with a fake SearXNG server (tolerant parsing, missing fields, zh and
EN batteries); `doctor --json` shape tests; opt-in docker CI runs the report end-to-end.

### M3 (v0.6.0) — Overlay transactions: applying `tune` safely

Theme: the mutation half of tuning. Ships only the overlay machinery `tune` needs; presets
(M4) ride the same rails.

#### 3.1 Settings-overlay renderer

- Managed `settings.yml` becomes a layered render: packaged template → overlay(s) → secret
  injection. Overlays are recorded in state and re-applied by `repair`'s rebuild-from-assets
  path.
- Overlay content is engine enable/disable/weight only — a closed, renderable vocabulary.
- State schema bump to 3 with migration (mechanism exists; catalog `stateSchemas` gains 3).
- Files: `src/cli/assets.ts`, `src/cli/state.ts`, `assets/deployments/`, `test/cli/assets.test.ts`,
  `test/cli/state.test.ts`.

#### 3.2 Transactional apply — stage, switch mounts by recreation, verify, commit

- **A plain restart can never apply new settings**: bundles are content-addressed immutable
  directories and the container's bind mount points at the rendered bundle path
  (`src/cli/assets.ts` — `configurationHash` names the directory; `.env` points
  `DSH_SEARXNG_SETTINGS_DIR` at it). Changed settings mean a changed hash, a new directory,
  and therefore a runtime that must be **recreated against the new bundle**, exactly as
  `update` does via `stage()` and repair's `recreate-runtime` action.
- Apply sequence: render + publish the new bundle through the existing `stage()` pipeline →
  recreate the runtime (down/up against the new bundle) → validate the served configuration
  (digest match + real-search validation via `src/cli/searxng.ts`) → commit state. An
  interruption at any point leaves the previous bundle authoritative; rollback is a repoint
  to the still-present previous bundle plus recreation and revalidation.
- **Journal schema 2**: `target`/`previous` gain `configurationSha256` (and bundle name)
  alongside `deploymentVersion`/`image`, so same-version overlay changes are first-class
  recovery subjects. Recovery recomputes from disk which bundle the runtime actually serves
  and converges: clear the journal (nothing mutated), validate-and-commit the target, or
  resume the rollback. Interruption before or after the state commit, and a failed or
  interrupted rollback, are all covered; only a recovered-and-validated operation clears
  the journal.
- Confirmation on interactive terminals for the apply step (`--yes` for automation, matching
  `remove`); `tune --reset` clears the overlay through the same transaction.
- Files: `src/cli/journal.ts` (schema 2 + validator), `src/cli/tune.ts` (apply),
  `src/cli/assets.ts`, `src/cli/repair.ts` (recovery decision), `test/cli/recovery.test.ts`,
  docker integration test including forced interruption points.

#### 3.3 Overlay incompatibility is not bundle damage

- New code `E_OVERLAY_INCOMPATIBLE`, deliberately distinct from `E_BUNDLE_DAMAGED` (which
  triggers delete-and-rebuild of the bundle from packaged assets — the wrong medicine for a
  healthy bundle carrying an unrenderable overlay, and destructive to a working secret-holding
  configuration).
- On incompatibility the current configuration stays active and the error names the explicit
  resolution: `tune --reset`, or migrate the preset. **Overlays are never auto-dropped** —
  dropping one would silently re-enable engines the user or tune disabled.
- Files: `src/cli/errors.ts`, renderer validation, tests.

#### 3.4 Bundle garbage collection

- Content-addressed generations accumulate — every apply/update creates one. Define
  retention: keep the current bundle plus the previous two generations per deployment;
  sweep on successful apply/update/repair; never delete the bundle the state points at
  (ownership-style guard before deletion).
- Files: `src/cli/assets.ts` (sweep), tests including the live-bundle guard.

Validation: unit tests for layered render, state migration, journal schema 2 round-trip and
recovery decisions at every interruption point; opt-in docker CI runs apply → validate →
forced-interrupt → repair end-to-end; GC retention tests.

### M4 (v0.7.0) — Engine presets, `zh` first

Theme: curation on proven rails. One preset ships and is validated before the catalog grows.

#### 4.1 Preset infrastructure + exactly one preset: `zh`

- `assets/presets/catalog.json` (own schema 1, validated like the deployment catalog) mapping
  preset names to overlay fragments under `assets/presets/`. This milestone ships `zh` only
  (baidu, zhihu, bing-cn weighting; CJK-friendly); `developer`, `news`, `science` follow as
  data additions once `zh` is validated across real networks — `tune` is the safety net that
  keeps a wrong curation correctable.
- `setup --preset zh` records the preset in state; render order: template → preset → tune
  overlay (live measurement outranks curation). `repair` and `update` preserve overlays;
  an overlay that cannot render against a newer deployment takes the `E_OVERLAY_INCOMPATIBLE`
  path from M3 — explicit resolution, never silent drop.
- Presets are data shipped per npm release — same update channel, no remote fetch.
- Files: `assets/presets/*`, `src/cli/assets.ts`, `src/cli/setup.ts`, `test/cli/assets.test.ts`.

#### 4.2 Per-query control documentation

- README section with the corrected official syntax: `:zh-CN` / `:en` **select a language**
  (`:` prefix), `!engine` / `!category` **select engines or categories** (`!` prefix), and
  `site:` domain filtering. Also documents M1's honest empty-result semantics.
- Files: `README.md`, `docs/`.

Validation: preset render tests; e2e `setup --preset zh` in opt-in CI.

### M5 (unscheduled) — Follow-ups after the core proves out

1. **External multi-instance failover** — `baseURLs: string[]` config (first entry primary),
   health-decay scoring in the provider, failover on network/timeout/5xx/429, sticky
   recovery to primary. `setup` external validation probes all entries.
2. **`stats` command** — enable SearXNG `/metrics` in the managed settings; summarize query
   volume, latency distribution, unresponsive engines.
3. **Fetch-provider design study** (morty sidecar) — the strategic expansion from "search
   plugin" to "self-hosted web layer" (`ctx.web.registerFetchProvider` already exists in the
   seam). Doubles the managed-service surface; a written decision precedes implementation.
4. **Auto language routing — evaluation only**. The CJK-ratio approach from the original
   draft is rejected: it cannot distinguish kanji-heavy Japanese from Chinese. A defensible
   variant, if pursued, is script classification — kana detected → `ja`, hangul → `ko`,
   han-only → ambiguous (no routing) — layered under explicit configuration, default off.
   Ships only if the evaluation shows a real win over explicit `language` config plus `:lang`
   query syntax.

## Sequencing and dependencies

```
M1 (client-side only)      M2 (read-only)          M3 (transactions)       M4 (curation)
├─ 1.1 catalog wiring ───► gates every new catalog entry (incl. M3's schema-3 entry)
├─ 1.2 cache               ├─ 2.1 tune report ───► 3.2 apply builds on the report shape
├─ 1.3 pacing + queue      └─ 2.2 privacy checks
└─ 1.4 total budget                                 3.1 overlay renderer ─► 4.1 presets
                                                    3.2 apply + journal 2
                                                    3.3 E_OVERLAY_INCOMPATIBLE
                                                    3.4 bundle GC
```

- 1.1 is the gate for any catalog entry beyond version 1.
- M2 is independently shippable and lands before any mutation surface exists — the report
  cannot corrupt anything, and its evidence rules shape M3's recommendation gate.
- 3.1 is the shared prerequisite for apply (3.2) and presets (4.1).
- M5 items are unsequenced by design.

## Release discipline (every milestone)

1. `pnpm verify` (typecheck, unit tests, build, pack, packed-CLI check) green on all three
   platforms in CI.
2. Opt-in docker CI legs (`DSH_SEARXNG_E2E=1`, `DSH_SEARXNG_DOCKER_INTEGRATION=1`) exercise
   the new managed surface (tune report for M2; apply/interrupt/repair and `--preset zh`
   for M3/M4).
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
| Pacing adds latency or holds callers | Defaults gentle (burst 2 / 1500 ms, queue cap 8); the M1 total budget (15 s default) bounds the worst-case call; queue-full rejects fast. |
| Overlay vs. newer SearXNG settings keys | Closed overlay vocabulary (engine enable/disable/weight only); render-time validation raises `E_OVERLAY_INCOMPATIBLE` and keeps the current configuration active. |
| Content-addressed bundles accumulate on disk | M3.4 GC: current + previous two generations, swept on successful operations, live bundle never deleted. |
| Interrupted apply leaves ambiguous state | Journal schema 2 records previous/target config digests; recovery recomputes the served bundle from disk and converges before clearing. |
| State schema growth | Bump per milestone at most; migration path exercised in unit tests and by `doctor`. |

## Open questions (decide at milestone kickoff, not now)

- Config knob naming and final defaults: `cacheTtlMs`, `minIntervalMs`, queue cap, total
  budget default (15 s proposed).
- Tune recommendation threshold: "majority of probes failed AND ~zero result contribution" —
  exact numbers at M2 kickoff.
- GC retention count (two previous generations proposed).
- Auto language routing viability (M5 evaluation; default-off if it ships at all).
- Whether presets ship inside a deployment catalog v2 instead of a sibling catalog (lean:
  sibling catalog — deployment pinning and curation change on different cadences).

## Revision notes

Revision 2 (this document) incorporates a technical review that verified the following
against the codebase, all confirmed:

- `tune` cannot apply settings via container restart — bind mounts point at
  content-addressed immutable bundles (`src/cli/assets.ts`); apply must stage a new bundle
  and recreate the runtime (now M3.2).
- The journal (schema 1, kinds `setup/repair/update/remove`, deployment-only targets)
  cannot express same-version overlay changes; recovery semantics for tune require journal
  schema 2 with configuration digests (now M3.2).
- `E_BUNDLE_DAMAGED` triggers delete-and-rebuild and is the wrong signal for overlay
  incompatibility; auto-dropping overlays would re-enable disabled engines (now M3.3).
- Empty results must not silently widen the `engines`/`categories` allowlist (removed from
  M1.4; added to non-goals).
- Attempt caps alone do not bound latency; one total deadline must span queue, backoff, and
  network stages (now M1.3/1.4).
- `tune`'s measurements cannot attribute latency per engine, and absence from
  `unresponsive_engines` is not health; recommendations rest only on in-presence failures
  (now M2.1 evidence rules).
- CJK-ratio language routing conflates kanji-heavy Japanese with Chinese, and `!zh` is not
  language syntax (official syntax: `:lang` selects language, `!` selects engine/category);
  auto-routing is deferred to an M5 evaluation, docs corrected (now M4.2).
- `doctor` privacy output must scope claims to verified local configuration and name the
  unverifiable links explicitly (now M2.2).
- Scope narrowing accepted: M1 drops unconsumed counters; M2 is read-only and M3 carries the
  transaction work; M4 ships one preset first.
