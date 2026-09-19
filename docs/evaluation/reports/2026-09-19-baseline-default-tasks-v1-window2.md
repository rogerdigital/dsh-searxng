# 2026-09-19 — Default-configuration task-quality baseline (tasks-v1, window 2)

Scope: second answerability window of the **default configuration** (no preset, no engine
overrides) against `docs/evaluation/tasks-v1.md`. With window 1 (2026-09-12) this
completes the required two time windows for the baseline — on **one network
environment**; no cross-network claim is made. Same measurement path as window 1: JSON
API directly (labeled per the run rules), 36 tasks sequential with a 2.5 s gap, top five
captured per task, judged from titles/URLs/snippets with **no full-page fetches** at run
date 2026-09-19.

## Environment

Same host, network, image (`ghcr.io/searxng/searxng:2026.8.20-8d3dd0cd4`), and managed
profile `web` as the 2026-09-11/12 reports. Plugin: merged `f2fb2d9`, package 0.4.0.
Note: the managed container had been removed since window 1 (state file and the
content-addressed bundle survived; no profile attachment was recorded). Before the run
it was recreated from the surviving bundle and cache volume — same image digest, same
settings hash (`4814475a…`) — and `setup --profile web` re-attached the profile with all
`status --json` checks passing. Engine cooldown state carried over through the retained
volume.

## Engine health bracket (tune before and after)

| Engine | Before | After |
|---|---|---|
| google cse | 0/6 failures, 120 results | 0/6 failures, 120 results |
| brave | 6/6 suspended: too many requests | 6/6 suspended: too many requests |
| duckduckgo | 6/6 CAPTCHA | 6/6 CAPTCHA |
| startpage | 6/6 suspended: CAPTCHA | 6/6 suspended: CAPTCHA |
| wikipedia | — (not reported) | 6/6 suspended: too many requests |

Identical bracket to window 1, including wikipedia appearing only in the after bracket:
the battery's own query volume suspends it mid-run in both windows. The baseline remains
a **single-engine result** — all 180 captured top-five slots carry `engine: google cse`.

## Summary

| Group | Tasks | Answerable | Marginal | Empty/unusable |
|---|---|---|---|---|
| Chinese navigation (N) | 10 | 10 | 0 | 0 |
| Chinese research (R) | 10 | 10 | 3 (R3, R7, R9) | 0 |
| Mixed technical (T) | 8 | 8 | 0 | 1 thin (T7) |
| Time-sensitive (F) | 4 | 4 | 1 (F2) | 0 |
| English control (C) | 4 | 4 | 0 | 0 |
| **Total** | **36** | **36** | **4** | **0** |

Latency: mean 608 ms, max 2037 ms per task (single sequential query each; window 1:
mean 788 ms, max 2386 ms). Errors: 0. Useful rank #1 in 33/36 tasks (window 1: 29/36).

## Per-task judgments

Useful rank = first result among the top five judged to contain the information the task
needs (from title/URL/snippet). "Marginal" = the need is met but with a caveat recorded
here.

| Task | Useful | Notes |
|---|---|---|
| N1 | #1 | `www.cs.tsinghua.edu.cn` official first; #2 same host (staff directory). |
| N2 | #1 | `dpaper.las.ac.cn` exact (CAS thesis database); snippet describes access tiers rather than window 1's IP-block notice — source right, access CAS-tiered. |
| N3 | #1 | `www.nsfc.gov.cn` official homepage + three more official subpages; slowest query of the run (2037 ms). |
| N4 | #1 | `www.shgjj.com` exact official portal (empty snippet, title/URL suffice); #2–#3 一网通办 official. |
| N5 | #1 | `www.12306.cn` customer-service page; #2–#3 same host; #4 ja-locale App Store page, #5 Wikipedia — official first regardless. |
| N6 | #1 | `pbc.gov.cn` LPR page (title identifies it; empty snippet); live LPR values additionally in #2 (BOC table, latest row 2026-04-20 3.00%/3.50%) and #3 (chinamoney 2026-03-20). Window 1 needed #2 for values. |
| N7 | #1 | `live.bilibili.com` live home. |
| N8 | #1 | `bayarea.gov.hk` GBA portal + #2 digitalpolicy.gov.hk 跨境通办; like window 1, the HK-side official portal meets the need, not a GD-side one. |
| N9 | #1 | `www.lib.pku.edu.cn` catalog page (未名学术搜索 covering 馆藏书刊目录); #2 same host. |
| N10 | #1 | `www.zjzs.net` exams authority; #3 same host shows the 成绩查询 channels. |
| R1 | #2 | #2 PwC snippet carries the 12,000 CNY annual cap; #1 reports the 2026-07 人社部 "十五五" plan proposing to raise the cap — figure needs #2 (window 1 had it at #1). |
| R2 | #1 | Suzhou gov implementation notice with key requirement (lead-acid mass limit 55→63 kg); the standard number **GB 17761-2024 is verbatim in #2's snippet** — window 1's marginal gap is closed this window. |
| R3 | #1 | **Marginal**: zhihu 2026 guide carries the 120-point standard and criteria outline; the official 积分管理办法 page (`jzzjf.rsj.sh.gov.cn`, window 1's #1) is absent from the top five. |
| R4 | #1 | Official 税务总局 policy-library notice: 60%/30% refund proportions and the real-estate carve-out in snippet; #4 same domain (征管事项). |
| R5 | #1 | WHO fact sheet snippet states **"DAAs 可使 95% 以上的丙肝感染者得到治愈"** — the ≥95 % figure window 1 had to defer to the page for. |
| R6 | #1 | MEE announcement snippet names steel/cement/aluminum directly; #3 adds the 3378-unit expansion figure. |
| R7 | #2 | **Marginal**: #2 Baike 深海一号 entry with phase-II test rates (daily gas >1M m³); #4 (CNOOC engineering) carries the design capacity but the number is truncated mid-digit in the snippet ("设计产能天然气32…"). Window 1 had a clean capacity figure at #1. |
| R8 | #1 | Eight-step application/selection flow enumerated in #1's snippet; #2 zhihu adds the schedule; #5 is the 2026 guide. |
| R9 | #3 | **Marginal**: provincial regulation text (#3 河北) and the official protection report (#4) present; the national 《长城保护条例》 full text is again not in the top five (window 1's marginal repeats). #1 is a ja-locale Baike entry. |
| R10 | #1 | zh systematic review of the biodiesel production chain + #3 microalgae-oil research progress — recent Chinese-language research summary present, as in window 1. |
| T1 | #1 | Official k8s troubleshooting docs discussing NotReady events directly; #2 GKE docs, #4 a 2026 SOP post. |
| T2 | #1 | Official zh-hans React server-components reference (window 1: #3). |
| T3 | #1 | CSDN article specifically on choosing `num_workers`; #2 adds generic pipeline guidance. |
| T4 | #1 | postgres.cn official PITR/continuous-archiving chapter. |
| T5 | #1 | grpc.io official deadlines guide; the deadline-vs-retry **interaction** is thinner this window (#2–#5 drift off-topic) — window 1 had a dedicated #2. |
| T6 | #2 | redis.io `CLUSTER SETSLOT` (live-resharding command family); the `redis-cli --cluster reshard` convenience path remains absent from snippets, as in window 1. |
| T7 | #5 | **Thin**: #5 covers discriminated unions explicitly (discriminant properties); #1–#2 cover generic typeof-guard narrowing without the discriminant case; the official handbook page window 1 had is absent. |
| T8 | #1 | Cause list present (#4 "unable to get local issuer certificate": missing intermediate/root, CAFile/CAPath) and verification commands (#3 `s_client`) — window 1's weakest task is met within the top five this window. |
| F1 | #1 | investing.com live headlines + #3 eastmoney wire ("8 時間前" timestamp in snippet supports freshness); #4's dated TOP10 is 13 days stale but not needed. |
| F2 | #1 | **Marginal**: nodejs.org releases table (ja locale) identifies v24 Krypton as the LTS line, but the support-end column reads 2026-09-07 for v24 while #4 (herodevs, 2026-06) says v22 EOL 2027-04 — snippets again conflict on the current-in-September-2026 line, same ambiguity class as window 1. |
| F3 | #1 | weather.com.cn 7-day forecast snippet carries the coming weekend's values (19日 27/20℃, 20日 28/19℃) directly; caveat: the page rendered "18日（今天）", a fetch-time UTC offset artifact — the weekend values are unaffected. Window 1 judged this marginal; with values in the snippet it is not. |
| F4 | #1 | DataLearner model timeline (2026-07 entries: MiniMax H3, Claude Opus 5, Gemini 3.6 Flash) + #3 zhihu list updated 2026-09-17 — releases within the past month. |
| C1 | #1 | `docs.docker.com/reference/compose-file/` exact; #4 the compose-spec repo. |
| C2 | #1 | MDN AbortSignal — **ja locale** for an English query (three of five MDN hits ja); content authoritative. |
| C3 | #1 | Dedicated borrow-checker explainers (#1, #2, #3). |
| C4 | #1 | `datatracker.ietf.org/doc/html/rfc9110` exact; #2–#3 ja translations follow. |

## Findings

1. **36/36 answerable in both windows, 0 empty in both.** The two-window baseline
   requirement is now met (same network). Marginal cases shifted at the boundary —
   R9 and F2 repeated; T8 and F3 improved to clean; R3 and R7 dipped to marginal —
   while overall answerability and the #1-rank rate stayed stable or improved
   (29/36 → 33/36). Per-task volatility concentrates exactly where snippet depth is
   the binding constraint (R9 regulation text, F2 conflicting tables, R7 truncated
   figure, R3 official page dropping out of the top five).
2. **The single-engine posture is fully reproducible.** All 180 top-five slots from
   google cse; the same four engines failing in both tune brackets with the same
   reasons (brave/wikipedia rate-limit suspensions, ddg/startpage CAPTCHA); and
   wikipedia suspending **mid-battery** (present only in the after bracket) in both
   windows — the battery's own 36-query volume is enough to suspend it. Any candidate
   comparison still runs against this single-engine context.
3. **Snippet depth varies week to week at fixed rank**: GB 17761-2024 (R2) and the
   ≥95 % DAA cure rate (R5) were page-visit-dependent in window 1 and snippet-present
   in window 2; the reverse happened for R7's capacity figure. The title/URL/snippet
   judgment basis stays defensible overall, and its strain remains localized to the
   marginal set.
4. **Locale drift on English queries repeats**: MDN ja (C2), nodejs.org ja (F2),
   Baike ja (R9), Japanese translations ranking for C4 — second window of evidence for
   the deferred M5 language-routing question; the instance's engine-side locale
   behavior is not query-driven.
5. **Latency stayed healthy** (mean 608 ms, max 2037 ms; window 1: 788/2386 ms) with
   no degradation onset across 36 spaced queries — consistent with the 2026-09-11
   spaced-battery finding.
6. **Recovery observation (tooling, not search quality)**: with the managed container
   removed but state and bundle intact, `setup` fails at its restart-recovery step
   (restart of a nonexistent container), `repair` refuses for lack of a profile
   attachment, and `remove --service` cannot resolve a compose path — a three-way
   recovery gap worked around here by recreating the container from the surviving
   bundle before running `setup`. Recorded for a CLI follow-up; this report's run was
   unaffected (all `status` checks passed before measurement).

## Limits

Two windows, one host, one network, one healthy engine, snippet-level judgment without
page fetches, freshness judged at run date, instance recreated from surviving state
before the run. No candidate comparison and no cross-network claim is made; a
cross-network statement still requires a labeled run from a second network environment.

## Reproduction

`node scripts/eval-tasks-v1.mjs --base http://127.0.0.1:8080` (added in this change)
runs the tune brackets and the 36-task battery with the same gap and capture shape;
per-task top five (url/title/snippet/engine) are captured to JSONL at run time and
judged from that capture, per the run rules in `docs/evaluation/README.md`.
