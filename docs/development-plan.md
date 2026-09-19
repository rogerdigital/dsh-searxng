# Development Plan — Deepening the Owned-Stack Advantage

Status: proposed, revision 3. M1/M2 are the near-term scope; M3/M4 are conditional on
measured benefit. Version labels are planning targets, not release commitments.

## Strategy

Help dsh users run self-hosted search with less setup and maintenance effort, while retaining
control over deployment and engine configuration and adapting to their own network.

The plugin controls the instance, configuration, image pin, and HTTP client. It does not own
upstream indexes, rankings, availability, or anti-abuse policies. Deployment control enables
useful configuration and recovery workflows; it does not guarantee better search quality.

1. **Reliability** — bounded latency, cancellation, and load handling are baseline quality.
   Cache and retry features are useful but readily reproducible by other adapters.
2. **Network-specific tuning** — turn observable failures into understandable evidence and
   test whether configuration changes improve real tasks or reduce maintenance effort.
3. **Validated curation** — package configurations with repeatable quality evidence, starting
   with Chinese-language tasks. An engine list alone is not a durable advantage.
4. **Checkable local posture** — explain the configuration the operator controls and the
   limits of verification through `doctor`.

The target users accept a self-hosted runtime and value control and avoiding a separate
search-service account. There is no search-provider per-query bill for the key-less managed
configuration, but machine, network, and maintenance costs remain. Lowering that maintenance
burden is a product outcome, not merely an implementation concern.

### Competitive context

Reference snapshot: 2026-09-10. Recheck before publishing competitive claims; these sources
establish available interfaces, not comparative quality or performance.

| Alternative | Relevant evidence | Implication |
|---|---|---|
| Official dsh Exa adapter | [Provider source](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/web/web-search-exa/src/provider.ts) maps search results and highlights. The [underlying API](https://exa.ai/docs/reference/search) offers richer filters and content retrieval. | Distinguish an adapter's current exposure from the service's capabilities. Cache, retry, and filters are not exclusive advantages. |
| Official dsh Perplexity adapter | [Provider source](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/web/web-search-perplexity/src/provider.ts) uses Sonar for an answer plus sources. The separate [Search API](https://docs.perplexity.ai/api-reference/search-post) supports structured retrieval and filters. | Compare equivalent retrieval tasks; answer generation is outside this plugin's scope. |
| Official dsh DeepSeek search adapter | [Plugin documentation](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/web/web-search-deepseek/README.md) describes credential reuse and the additional model turn per search. | Avoid claiming that avoiding another service account is unique; compare actual usage costs and task latency. |
| Other SearXNG adapters | For example, [searxng-mcp](https://github.com/zatevakhin/searxng-mcp) exposes search, browsing, engine discovery, and health checks. | Self-hosted search integration alone is not distinctive. Build on this plugin's setup, validation, ownership-safe repair, and rollback workflows. |

The working differentiation hypothesis is **less maintenance plus demonstrably useful local
configuration**. It must be tested against default SearXNG as well as hosted alternatives.

## Product evidence and investment gates

Engineering checks prove that an implementation works as specified. They do not establish
search quality or justify the next milestone. Keep a small, versioned evaluation under
`docs/evaluation/`: query cases, scoring rules, reproducible run instructions, and dated
reports. This is development evidence, not a new telemetry service or runtime dependency.

- Start with 30–50 public, non-sensitive tasks covering Chinese navigation and research,
  mixed Chinese/English technical queries, time-sensitive queries, and an English control set.
  The six-query `tune` battery is a quick diagnostic, not the quality benchmark.
- Compare the current release/default configuration with each candidate on the same tasks.
  Include official dsh alternatives where credentials and budget are available; explicitly
  mark missing comparisons and distinguish adapter results from direct API experiments.
- Record useful sources among the first five results, task answerability, empty/unusable
  results, duplicates, and unique useful sources. Inspect relevance; result count and fewer
  reported engine failures are not quality scores.
- Measure cold, warm-cache, and burst latency separately, including failures and queue
  rejections. Record setup effort and steps/time needed to diagnose and recover from the
  same representative failures. Never count a fast rejection as a successful fast search.
- Record plugin revision, image digest, configuration, network region/type, query language,
  timestamps, repetitions, and any provider charges. Repeat across at least two separate
  time windows; a claim spanning networks requires evidence from at least two network
  environments. Mask private network details and never commit credentials or private queries.
- Before candidate runs, record the primary success metric and acceptable quality/latency
  regression bounds. Report per-task differences and exceptions, not just one average.
  These small evaluations support scoped decisions, not universal superiority claims.

Near-term execution checklist:

- [x] Establish the baseline and task set alongside M1 (windows 1 and 2 recorded:
  docs/evaluation/reports/2026-09-12-baseline-default-tasks-v1.md and
  2026-09-19-baseline-default-tasks-v1-window2.md — 36/36 answerable in both windows,
  one network environment, no cross-network claim; `scripts/eval-tasks-v1.mjs` runs
  the battery for further windows, including from a second network).
- [x] Validate M1 defaults against cold and burst workloads before making them defaults (docs/evaluation/reports/2026-09-11-m1-defaults.md).
- [x] Deliver the M2 read-only report and test whether it helps resolve representative failures (delivered 2026-09-11; a live run surfaced per-engine rate limiting and CAPTCHA causes on a degraded instance).
- [x] Evaluate candidate Chinese configurations in isolated development instances during M2 (2026-09-12: no candidate passed; M3/M4 deferred — docs/evaluation/reports/2026-09-12-zh-candidates-defer.md).
- [ ] Gate M3 on repeatable task-quality or maintenance benefit without violating the recorded
  regression bounds; identify which configuration changes actually require an apply workflow.
- [ ] Gate M4 on an effective `zh` candidate, documented network limits, and M3 recovery checks.

If a gate fails, retain M1/M2 and defer the dependent work. Do not build configuration
transactions merely to complete the version sequence. No comparative results are claimed yet.

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

- **No provider-generated answers** (`WebSearchResult.content`): keep this provider focused
  on useful sources; answer synthesis does not support the maintenance/configuration goal.
- **No paid-API fallback ("hybrid mode")**: keep service accounts and billing out of the
  managed search path.
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

Theme: baseline client reliability plus one tracked debt. No deployment-surface change.
Build the evaluation baseline alongside this work; defaults below are candidates to validate.

#### 1.1 Wire `setup` to the deployment catalog (tracked follow-up)

- `setup` selects via `selectDeployment(catalog, stateSchema)` instead of the compiled-in
  `?? 1` default (`src/cli/setup.ts:118,137`), matching what `update`/`repair` already do.
- Gate: catalog entries beyond version 1 stay blocked until this ships (per README).
- Files: `src/cli/setup.ts`, `test/cli/setup.test.ts`, `test/cli/deployments.test.ts`.

#### 1.2 Bounded TTL query cache (in-process)

- Scope the cache to a provider instance so profiles and authentication contexts do not share
  results. Key: exact query + resolved `language`/`engines`/`categories` + `baseURL`; preserve
  query syntax and case. Value: mapped `WebSearchResult`.
- Memory-only: no query persistence to disk. Proposed capacity 64 entries (LRU), TTL 10 min;
  document in-process retention and freshness trade-offs, especially for time-sensitive tasks.
- Cache hits bypass pacing/network but must still reject an already-aborted caller. Lifecycle
  and `tune` probes bypass the provider cache and measure fresh responses.
- Config: `cacheTtlMs` (0 disables) on the plugin `Config` (`src/index.ts`), default 600_000.
- Files: `src/searxng-client.ts` or a new `src/query-cache.ts`, `test/searxng-client.test.ts`.

#### 1.3 Adaptive pacing with a bounded queue

- Token bucket in front of each network attempt: capacity 2, refill 1 token / 1500 ms
  by proposed default. An idle bucket admits a single query immediately; a depleted bucket
  adds latency. Test whether this reduces burst failures without excessive cold-query cost.
  Provider-local pacing does not coordinate other processes sharing the same instance/IP.
- The pacing queue is bounded (default 8 waiting requests). A full queue rejects immediately
  with the provider-error code rather than holding the caller indefinitely; the rejection is
  honest backpressure the agent can retry on.
- Both the queue wait and the token wait honor `AbortSignal` immediately.
- Config: `minIntervalMs` (0 disables pacing), default 1500.
- Files: `src/searxng-client.ts`, `test/searxng-client.test.ts` (fake timers).

#### 1.4 Retry under one total deadline

- A single budget (default 15 s) spans the whole `search()` call: pacing wait, backoff
  delays, and every network attempt. Each attempt's timeout is clamped to the remaining
  budget. Do not retry earlier than `Retry-After`: if it exceeds the remaining budget, return
  the failure without another attempt. Exhaustion returns the last failure, or a timeout if
  no network attempt started.
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
budget, budget exhaustion. Compare cold/warm/burst results against the baseline before
settling the proposed defaults.

#### 1.5 Document existing per-query controls

- Document `:zh-CN` / `:en` for language, `!engine` / `!category` for engine/category selection,
  and `site:` filtering with its engine-dependent support. Explain honest empty results and
  cache freshness/disable behavior. Verify examples against the pinned deployment.
- Files: `README.md`, `docs/`. This does not depend on preset infrastructure.

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
  - Presence in `unresponsive_engines` is a reported failure/suspension observation. Preserve
    the reason where available; do not infer an actual dispatch from presence alone.
- Report (table + `--json`): per engine — probes reporting failure/suspension (of N), result contribution share;
  per query — wall time and its unresponsive list.
- Repeated reported failures with no observed useful contribution flag an engine for review,
  not permanent disablement. Explain the sample size and possible lost coverage; missing
  evidence stays unknown. A short battery cannot establish an engine's long-term value.
- Both modes perform searches but write no local state or configuration. Return the report
  to stdout (`--json` supported); no persisted last-tune summary is added to `doctor` in M2.
  Use bounded sequential probes to avoid making a degraded instance worse.
- Files: new `src/cli/tune.ts`, `src/cli/args.ts`, `src/cli/diagnostics.ts`,
  `test/cli/tune.test.ts`, `test/cli/diagnostics.test.ts`.

#### 2.2 Privacy posture checks in `doctor`, scoped to what is checkable

- **Verified local configuration** section: loopback bind (host IP from `docker inspect`),
  secret file permissions, and any logging controls actually verifiable in the effective
  configuration. Missing evidence is unknown, not a pass. Report limiter and JSON settings
  as operational checks, not proof of privacy.
- **Explicitly out of scope** section, stated in the output itself: upstream engine logging
  and network observers cannot be verified from this host. Local switches are never
  presented as an end-to-end privacy guarantee.
- Surfaced in human output and `doctor --json`, redaction rules unchanged. External mode:
  endpoint protocol and auth presence only, same scoping language.
- Files: `src/cli/diagnostics.ts`, `test/cli/diagnostics.test.ts`.

Validation: unit tests with a fake SearXNG server (tolerant parsing, missing fields, zh and
EN batteries); `doctor --json` shape tests; opt-in docker CI runs the report end-to-end.

#### 2.3 Evaluate Chinese configurations before building the apply path

- Test candidate engine combinations using isolated development instances and the product
  evaluation set. Do not edit a user's managed bundle or add a production mutation command.
- Verify engine identifiers and availability against the pinned image. Compare candidates
  with defaults across tasks and networks; do not precommit to a baidu/zhihu/bing-cn list.
- Report useful-source coverage, task quality, latency, and maintenance trade-offs. Keep
  successful candidate settings and reproduction instructions with the dated evaluation.
- The output is a go/defer decision for M3/M4. A recommendation that merely removes error
  messages, or a preset that only increases result count, does not pass.

### M3 (conditional; v0.6.0 candidate) — Overlay transactions: applying `tune` safely

Theme: the mutation half of tuning. Ships only the overlay machinery `tune` needs; presets
(M4) ride the same rails. Start only after the product-evidence gate passes; write a focused
implementation plan for the validated configuration changes before modifying lifecycle code.

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
  interruption before commit leaves the previous state authoritative; recovery after commit
  must recognize the committed target. Retain the previous bundle for rollback by repointing,
  recreating, and revalidating the runtime.
- **Journal schema 2**: `target`/`previous` gain `configurationSha256` (and bundle name)
  alongside `deploymentVersion`/`image`, so same-version overlay changes are first-class
  recovery subjects. Recovery recomputes from disk which bundle the runtime actually serves
  and restores overlay metadata as well as runtime configuration. Record recoverable old/new
  overlay data or durable references, not digests alone. Recovery converges: clear the journal
  (nothing mutated), validate-and-commit the target, or resume the rollback. Interruption before or after the state commit, and a failed or
  interrupted rollback, are all covered; only a recovered-and-validated operation clears
  the journal.
- `tune` remains report-only by default; `tune --apply` explicitly previews the selected
  changes and evidence limits, then confirms on interactive terminals (`--yes` for automation).
  `tune --reset` clears the tune overlay through the same transaction. Do not convert a quick
  diagnostic flag into an automatic permanent engine disablement.
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
  sweep only after a successful transaction and journal clearance, under the state lock.
  Protect all state snapshots, live runtime mounts, and journal previous/target references
  before applying retention. Unknown ownership or active references prevent deletion.
- Files: `src/cli/assets.ts` (sweep), tests including the live-bundle guard.

Validation: unit tests for layered render, state migration, journal schema 2 round-trip and
recovery decisions at every interruption point; opt-in docker CI runs apply → validate →
forced-interrupt → repair end-to-end; GC retention tests.

### M4 (conditional; v0.7.0 candidate) — Engine presets, `zh` first

Theme: productize the Chinese configuration validated during M2, after M3 recovery passes.
Ship one preset with its evaluated image/network scope before considering a broader catalog.

#### 4.1 Preset infrastructure + exactly one preset: `zh`

- `assets/presets/catalog.json` (own schema 1, validated like the deployment catalog) mapping
  preset names to overlay fragments under `assets/presets/`. Ship only the `zh` candidate
  supported by M2 evidence. Publish its intended tasks, compatible image, tested networks,
  known limitations, and explicit recovery/reset guidance. Future presets need separate
  demand and quality evidence; they are not automatic data additions.
- `setup --preset zh` records the preset in state; render order: template → preset → tune
  overlay (live measurement outranks curation). `repair` and `update` preserve overlays;
  an overlay that cannot render against a newer deployment takes the `E_OVERLAY_INCOMPATIBLE`
  path from M3 — explicit resolution, never silent drop.
- Presets are data shipped per npm release — same update channel, no remote fetch.
- Files: `assets/presets/*`, `src/cli/assets.ts`, `src/cli/setup.ts`, `test/cli/assets.test.ts`.

Validation: preset render tests; e2e `setup --preset zh` in opt-in CI; repeat the product
comparison on the release candidate and confirm the published scope still holds.

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

```text
M1: baseline + catalog + client reliability + existing control documentation
  → M2: read-only tune + local posture + isolated Chinese configuration evaluation
      → evidence gate passes → M3: overlay apply, journal/recovery, bounded retention
          → preset evidence + recovery gates pass → M4: validated zh preset
      → evidence gate fails → retain M1/M2; defer M3/M4
M5: unscheduled; each item needs a separate demand and scope decision
```

- Catalog wiring gates entries beyond version 1; it does not block isolated configuration
  evaluation using the currently pinned image.
- M2 is independently shippable. Diagnostic and quality evidence are distinct: a report
  informs investigation; task comparisons justify configuration changes.
- M3 supplies the production mutation path M4 needs. M4 research does not depend on M3.
- No milestone advances solely because the preceding version has shipped.

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
5. Record the applicable product evaluation and gate decision under `docs/evaluation/`.
   A release claim about quality, latency, or maintenance must name the tested scope;
   technical certification does not substitute for this evidence.

## Risks

| Risk | Mitigation |
|---|---|
| dsh is in developer preview; breaking seam/peer changes | Keep peer windows narrow (current pattern), CI matrix, and treat seam drift as a patch release, not a milestone blocker. |
| SearXNG JSON drift (`unresponsive_engines`, per-result `engine`) | Digest-pinned images make drift opt-in via `update`; tune parses tolerantly and degrades to watch-only. |
| Pacing adds latency or holds callers | Validate proposed defaults (burst 2 / 1500 ms, queue cap 8); the M1 total budget (15 s default) bounds the worst-case call; queue-full rejects fast. |
| Overlay vs. newer SearXNG settings keys | Closed overlay vocabulary (engine enable/disable/weight only); render-time validation raises `E_OVERLAY_INCOMPATIBLE` and keeps the current configuration active. |
| Content-addressed bundles accumulate on disk | M3.4 retention runs under the lock after journal clearance; state, runtime, and recovery references always override the generation count. |
| Interrupted apply leaves ambiguous state | Journal schema 2 records previous/target config digests; recovery recomputes the served bundle from disk and converges before clearing. |
| Fewer engine errors hide lost search coverage | Compare useful sources and task answerability before applying changes; keep quick diagnostics separate from quality judgments. |
| Chinese preset works only in one environment | Evaluate early across times/networks, publish limits, and defer productization when gains do not repeat. |
| State schema growth | Bump per milestone at most; migration path exercised in unit tests and by `doctor`. |

## Open questions (decide at milestone kickoff, not now)

- Config knob naming and final defaults: `cacheTtlMs`, `minIntervalMs`, queue cap, total
  budget default (15 s proposed).
- At M1 kickoff, record evaluation scoring and regression bounds before candidate runs.
- At M2 kickoff, define report review-flag thresholds and missing/suspended-engine handling;
  no threshold alone authorizes permanent disabling.
- GC retention count (two previous generations proposed).
- Auto language routing viability (M5 evaluation; default-off if it ships at all).
- Whether presets ship inside a deployment catalog v2 instead of a sibling catalog (lean:
  sibling catalog — deployment pinning and curation change on different cadences).

## Revision notes

Revision 2 established the technical boundaries below; current sections include the
subsequent product-evidence refinements from revision 3:

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
  `unresponsive_engines` is not health; M2.1 now reports failure/suspension
  observations without treating them as proof of dispatch or permission to disable.
- CJK-ratio language routing conflates kanji-heavy Japanese with Chinese, and `!zh` is not
  language syntax (official syntax: `:lang` selects language, `!` selects engine/category);
  auto-routing is deferred to an M5 evaluation, docs corrected (now M1.5).
- `doctor` privacy output must scope claims to verified local configuration and name the
  unverifiable links explicitly (now M2.2).
- Scope narrowing accepted: M1 drops unconsumed counters; M2 is read-only and M3 carries the
  transaction work; M4 ships one preset first.

Revision 3 aligns investment with product evidence:

- Replaces full-stack exclusivity claims with lower-maintenance, locally configurable search;
  distinguishes hosted services from their current adapters and adds self-hosted alternatives.
- Adds a versioned evaluation baseline, separate cold/warm/burst measurements, and explicit
  go/defer gates. M3/M4 version labels are conditional.
- Moves Chinese configuration research into M2 and existing query-control documentation into
  M1; preset productization still requires M3's safe mutation path.
- Keeps M2 stateless, removes the persisted-summary contradiction, and treats short probes as
  diagnostic evidence rather than permission to permanently disable an engine.
- Preserves configuration recovery requirements and makes retention subordinate to live,
  state, and journal references. No new runtime feature is implemented by this revision.
