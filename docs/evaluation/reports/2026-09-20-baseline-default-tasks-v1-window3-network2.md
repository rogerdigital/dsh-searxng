# 2026-09-20 — Default-configuration baseline (tasks-v1, window 3, second network)

Scope: first answerability window of the default configuration from a **second network
environment** — a GitHub-hosted `ubuntu-latest` runner (datacenter network, region not
selected; no residential/home-network claim applies to this window). Produced by the
`eval-window` workflow on PR #43: an isolated instance staged from the packaged catalog
pin (`ghcr.io/searxng/searxng:2026.8.20-8d3dd0cd4`, packaged settings shape:
`use_default_settings: true`, json enabled, limiter off, **fresh engine state**, no dsh
profile), then `scripts/eval-tasks-v1.mjs --no-tune` — 36 tasks sequential, 2.5 s gap,
top five captured per task, per-query `unresponsive` lists standing in for the tune
brackets. Judgment basis unchanged: titles/URLs/snippets, no full-page fetches, judged
at run date 2026-09-20 (17:00 UTC). Compared against windows 1 (2026-09-12) and 2
(2026-09-19), both from the home network.

## Engine posture (per-query unresponsive capture, of 36)

| Engine | Window 1 (home) | Window 2 (home) | Window 3 (runner) |
|---|---|---|---|
| google cse | healthy, sole contributor | healthy, sole contributor | healthy, sole contributor (180/180 top-five slots) |
| brave | 6/6 suspended (rate limit) | 6/6 suspended | 36/36 suspended |
| duckduckgo | 6/6 CAPTCHA | 6/6 CAPTCHA | 36/36 suspended |
| startpage | 6/6 CAPTCHA | 6/6 CAPTCHA | 36/36 suspended |
| wikipedia | after-bracket only | after-bracket only | suspended N5–N6, **recovered N7–N20**, suspended from the 26th query on (22/36 total) |

**The single-engine posture reproduces across network environments.** Every top-five
slot in all three windows comes from google cse; the same four engines fail on a fresh
instance from a first-world datacenter IP exactly as they did from the home network —
including wikipedia's mid-battery suspension, which this window resolves into a full
suspend → recover → suspend cycle tied to the battery's own query volume. The posture
is a property of the engine set and shared-IP reputation, not of this host or network.

## Summary

| Group | Tasks | Answerable | Marginal | Empty |
|---|---|---|---|---|
| Chinese navigation (N) | 10 | 10 | 0 | 0 |
| Chinese research (R) | 10 | 10 | 1 (R9) | 0 |
| Mixed technical (T) | 8 | 8 | 0 | 0 |
| Time-sensitive (F) | 4 | 4 | 0 | 0 |
| English control (C) | 4 | 4 | 0 | 0 |
| **Total** | **36** | **36** | **1** | **0** |

Latency: mean 643 ms, max 3006 ms (N5; windows 1/2: 788/2386 and 608/2037 ms). Errors:
0. Useful rank #1 in 31/36 — lower than window 2's 33/36 but the same substance; see
per-task notes for where the runner's ranking differed.

## Per-task judgments (deltas and confirmations vs the home windows)

| Task | Useful | Notes |
|---|---|---|
| N1–N10 | #1 ×10 | All ten navigation authorities at #1, same domains as both home windows (N8 met by `digitalpolicy.gov.hk` 跨境通办 this time — the service page itself, one step more specific than window 2's portal home; N2's snippet shows the CAS thesis database refusing a **Google-crawler IP** (`66.249.79.133`) — the source is right, the block is the engine's fetch-side vantage, a cleaner statement of window 1's IP-block note). |
| R1 | #1 | **New information**: a 2026-08 zhihu piece reports the individual-pension cap **rising from 12,000** (snippet truncated at "180…", i.e. an 18,000 figure cut mid-digit); #3 the 人社部 "十五五" plan; #5 PwC still describing the 12,000 cap (2026-06). The home windows saw only the 12,000 figure — index freshness differs by environment. |
| R2 | #1 | Standard number GB 17761-2024 verbatim at #1 plus **#5 `openstd.samr.gov.cn`, the official standards full-text page** — stronger than both home windows. |
| R3 | #1 | The **official** 积分管理办法 (`jzzjf.rsj.sh.gov.cn`) is #1 with criteria snippet — the page that dropped out of window 2's top five (window 2's marginal) is present here. |
| R4 | #1 | Official tax-library notice at #1; #5 HKTDC names the 制造业等四个行业 scope and the refund formula. |
| R5 | #1 | "治愈率超过95%" verbatim at #1 (UN news). |
| R6 | #1 | MEE quota notice naming steel/cement/aluminum; #5 adds the four-industry coverage figure. |
| R7 | #1 | 2025 output >4.5 Mt oil-equivalent at #1 and **the annual gas capacity figure (50 亿 m³) intact at #4** — window 2's truncated-figure marginal does not recur. |
| R8 | #1 | Eight-step flow at #1, as in window 2. |
| R9 | #3 | **Marginal, third window running**: provincial 条例 text (#1 河北), an official MOJ Q&A **about the national 条例** (#3), and an implementation critique (#5); the national 条例 full text is never in the top five on any environment. The one genuinely snippet-hard task in the set. |
| R10 | #1 | Chinese-language research summaries present (#1 菌藻共生, #2 systematic review). |
| T1 | #1 | Official k8s troubleshooting docs. |
| T2 | #1 | RSC-mechanics articles (#1–#3 juejin) — the official react.dev page that led home windows is absent, but the task's need (a mechanics explanation) is met. |
| T3 | #1 | The same CSDN `num_workers` article as home. |
| T4 | #1 | `archive_command` steps with `%p`/`%f` directives at #1 (rockdata) — more current than home windows' 9.6-era postgres.cn chapter. |
| T5 | #1 | grpc.io deadlines at #1; #2 adds deadline-propagation discussion. |
| T6 | #2 | `CLUSTER GETKEYSINSLOT` (slot-migration key listing) at #2 via redis.com.cn; the convenience `--cluster reshard` path stays absent from snippets on all environments. |
| T7 | #1 | Discriminated-unions explainer at #1 **and** the official TypeScript narrowing page at #3 — home window 2 had neither at useful rank. |
| T8 | #1 | Cause list + `s_client`-style verification steps (#1–#3) — the weakest home task is comfortably met here. |
| F1 | #1 | investing.com live headlines + eastmoney wire. |
| F2 | #1 | **Clean**: the English nodejs.org releases page — "v24.21.0 Latest LTS, v26.9.0 Latest Release" — plus the annual-cycle announcement. The conflicting-table ambiguity both home windows hit does not occur; it was an environment/index artifact, not a task defect. |
| F3 | #2 | AccuWeather carries the coming days' values (9/20–9/22) at #2; weather.com.cn's snippet lacks the day rows this time. |
| F4 | #1 | zhihu list updated 2026-09-17 + vendor pages (GLM-5.3, Kimi K3, GPT-5.5) — releases within the month. |
| C1–C4 | #1 ×4 | Same authorities as home (docs.docker.com, **English** MDN, borrow-checker explainers, datatracker). |

## Findings

1. **Cross-network claim now supported for the baseline's engine posture**: across two
   labeled environments (home network windows 1–2; GitHub datacenter window 3) the
   default configuration is a single-engine result — 540/540 top-five slots from
   google cse — with the same four engines failing and the same mid-battery wikipedia
   suspension. Any candidate comparison must still state this single-engine context.
2. **Answerability is environment-stable**: 36/36 on all three windows; the only
   repeated marginal is R9 (national regulation text). Two home-window marginals
   (R3, R7) were artifacts of which page ranked where, both cleanly met here —
   marginal-set membership tracks snippet depth and ranking variance, not a quality
   difference between environments.
3. **Locale drift is the engine serving by IP region, not query-driven**: the home
   network received ja-locale pages for English queries in both windows; the datacenter
   receives English pages (MDN, nodejs.org) for the same queries. For the deferred M5
   language-routing question this is direct evidence that engine-side locale cannot be
   relied on in either direction, and the query-driven `language` parameter / `:lang`
   syntax remains the honest lever.
4. **Index freshness differs by environment**: window 3 surfaced an August-2026
   pension-cap raise that neither home window's snippets showed, while PwC's June
   table still carried the old cap — time-sensitive figures need a freshness check
   per environment, not just per date.
5. **Latency and error profile unchanged** (mean 643 ms vs 608/788 ms; 0 errors, 0
   empty) from a fresh container on a datacenter host — no cold-start penalty visible
   at 2.5 s spacing.

## Limits

One window per environment for the runner so far (home has two); region not selected —
the claim is "a second network environment", not a specific geography; snippet-level
judgment without page fetches; freshness judged at run date; the runner instance was
fresh (no engine cooldown carry-over), unlike the home windows' retained volume. The
zh-candidate question (M2.3) is **not** answered by this window — the battery runs the
default configuration; enabling and comparing baidu/sogou/quark on a second network is
the remaining evaluation step for the M3 gate, and the workflow pattern just proven
makes it a small extension.

## Reproduction

`gh workflow run eval-window.yml` (after PR #43 merges; the PR run itself produced this
window), or `scripts/eval-tasks-v1.mjs --base <endpoint> --out <dir> --no-tune` against
any isolated instance. Capture artifact `eval-window/battery.jsonl` from run 35524416550.
