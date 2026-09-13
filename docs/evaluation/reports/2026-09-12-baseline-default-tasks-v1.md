# 2026-09-12 — Default-configuration task-quality baseline (tasks-v1, window 1)

Scope: first answerability window of the **default configuration** (no preset, no engine
overrides) against `docs/evaluation/tasks-v1.md`. This is the baseline future candidates
are compared to. One window of the required two; no comparative claim is made yet.

## Environment

Same host, instance, and network as the 2026-09-11 reports (managed profile `web`, image
`ghcr.io/searxng/searxng:2026.8.20-8d3dd0cd4`, one network environment; no cross-network
claim). Plugin: merged `11cb98f`. Measurement path: JSON API directly (labeled per the
run rules), 36 tasks sequential with a 2.5 s gap, top five captured per task. Judgment
basis: result titles, URLs, and snippets — **no full-page fetches** — judged at run date
2026-09-12; per-task judgments below were recorded from the captured output, not from
memory.

## Engine health bracket (tune before and after)

| Engine | Before | After |
|---|---|---|
| google cse | 0/6 failures, 120 results | 0/6 failures, 120 results |
| brave | 6/6 rate-limited | 6/6 rate-limited |
| duckduckgo | 6/6 CAPTCHA | 6/6 CAPTCHA |
| startpage | 6/6 CAPTCHA | 6/6 CAPTCHA |
| wikipedia | — (not reported) | 6/6 failures (newly reported) |

**The entire baseline was carried by one healthy engine (google cse).** The numbers below
measure the default configuration as experienced on this network — a single-engine
posture — not the engine set's full capability.

## Summary

| Group | Tasks | Answerable | Marginal | Empty/unusable |
|---|---|---|---|---|
| Chinese navigation (N) | 10 | 10 | 0 | 0 |
| Chinese research (R) | 10 | 10 | 1 (R9) | 0 |
| Mixed technical (T) | 8 | 8 | 1 (T8) | 0 |
| Time-sensitive (F) | 4 | 4 | 2 (F2, F3) | 0 |
| English control (C) | 4 | 4 | 0 | 0 |
| **Total** | **36** | **36** | **4** | **0** |

Latency: mean 788 ms, max 2386 ms per task (single sequential query each). Errors: 0.

## Per-task judgments

Useful rank = first result among the top five judged to contain the information the task
needs (from title/URL/snippet). "Marginal" = the need is met but with a caveat recorded
here.

| Task | Useful | Notes |
|---|---|---|
| N1 | #1 | `cs.tsinghua.edu.cn` official first; #2 same host (staff directory). |
| N2 | #1 | `dpaper.las.ac.cn` exact (CAS thesis database); snippet shows an IP-block notice — the source is right, access is CAS-internal. |
| N3 | #1 | `nsfc.gov.cn` official first, four more official subpages. |
| N4 | #1 | `shgjj.com` exact official portal. |
| N5 | #1 | `12306.cn` customer-service page; #2–#3 same host. |
| N6 | #2 | `pbc.gov.cn` homepage #1 (authoritative path); #2 carries live LPR table values in the snippet. |
| N7 | #1 | `live.bilibili.com/h5` — h5 variant of the live home. |
| N8 | #1 | HK Digital Policy Office 跨境通办 + #2 `bayarea.gov.hk`; expected a GD-side portal — both are official for the service. |
| N9 | #1 | `lib.pku.edu.cn` official library home (catalog reachable). |
| N10 | #1 | `zjzs.net` (Zhejiang education exams authority) exact. |
| R1 | #1 | PwC snippet states the 12,000 CNY annual cap; #3 adds the 2.4万 proposal debate — figure present in snippet. |
| R2 | #2 | Official implementation notice with key requirements (plastic ≤5.5% of mass) in snippet; the standard number itself is not verbatim in any snippet — marginal toward useful, counted answerable. |
| R3 | #1 | Official 积分管理办法 (`jzzjf.rsj.sh.gov.cn`) with criteria snippet; #2–#3 commercial explainers. |
| R4 | #3 | Gansu gov relay of the MOF/STA policy + #5 official public guide PDF; snippets reference the 2022 industry-scope announcements. |
| R5 | #1 | WHO fact sheet: DAA therapy cures most infections, 12–24 weeks — qualitative cure statement; exact ≥95 % figure requires the page. |
| R6 | #1 | MEE announcement snippet names the covered industries (steel, cement, aluminum) directly; #2 adds the 2027 eight-industry plan. |
| R7 | #1 | 2025 output >4.5 Mt oil-equivalent in snippet (Sina) + #2 Baidu Baike entry. |
| R8 | #2 | 2026 报考指南 covering process and thresholds; #3 step-by-step explainer. |
| R9 | #2 | **Marginal**: Tianjin municipal regulation full text (cites the national one); the national 条例 text itself is not in the top five. #1 is an official protection report, not the regulation. |
| R10 | #1 | 菌藻共生/小球藻产油 (zh research article) + #2 systematic review of biodiesel production — a recent Chinese-language research summary is present. |
| T1 | #1 | Official k8s debug docs; snippet discusses NotReady events directly. |
| T2 | #3 | Official zh-hans React server-components reference + #2 CSDN mechanics article. |
| T3 | #1 | CSDN article specifically on choosing `num_workers`. |
| T4 | #1 | postgres.cn official translated continuous-archiving/PITR chapter (9.6 era — content correct, version old). |
| T5 | #1 | grpc.io official deadlines guide; #2 adds deadline/retry interaction discussion. |
| T6 | #2 | redis.io `CLUSTER SETSLOT` (the live-resharding command family); #1 a cluster intro. The `redis-cli --cluster reshard` convenience path is not directly in the snippets. |
| T7 | #1 | Official TypeScript narrowing handbook page (only 7 results — thin but on target). |
| T8 | #5 | **Marginal**: an OpenSSL certificate-verification how-to (zhihu) + #2 Aliyun's server-then-client chain diagnosis ordering. Causes and commands partially present; weakest technical task. |
| F1 | #1 | investing.com 今日要闻 + #3 eastmoney live wire. Freshness judged at run date; same-day verification requires page visit. |
| F2 | #1 | nodejs.org releases page — but snippets conflict: the ja-locale table reads v24 LTS through 2026-09-07 while #5 references Node v26.5.1. The LTS line is identifiable; which line is current-in-September-2026 is ambiguous from snippets alone. |
| F3 | #1 | weather.com.cn 7-day forecast snippet covering the coming days (rendered for the 13th). Weekend-specific framing needs the page. |
| F4 | #1 | Zhihu model list updated 2026-09-09 (within a month) + official vendor model pages. |
| C1 | #1 | `docs.docker.com/reference/compose-file/` exact. |
| C2 | #1 | MDN AbortSignal — **ja locale** for an English query; content authoritative. |
| C3 | #1 | Dedicated borrow-checker explainers (#1, #3, #4). |
| C4 | #1 | `datatracker.ietf.org/doc/html/rfc9110` exact. |

## Findings

1. **36/36 answerable in this window, 0 empty**, with four marginal cases whose caveats
   are recorded above. Navigation tasks hit the expected authority at #1 in 10/10
   (N8 met by the HK-side official portal rather than the expected GD-side one).
2. **The baseline is a single-engine result.** Every captured result carries
   `engine: google cse`; the other four reporting engines were failing throughout both
   tune brackets. Any future candidate comparison must either restore engine diversity
   or explicitly compare against this single-engine context.
3. **Locale drift on English queries**: English tasks (C2, F2, T1-adjacent) returned
   Japanese-locale pages of otherwise-authoritative sources (MDN ja, nodejs.org ja).
   Harmless for source quality, relevant evidence for the deferred M5 language-routing
   question — the instance's engine-side locale behavior is not query-driven.
4. **Snippet depth was usually sufficient** (figures present in snippets for R1, R6, R7;
   official domains trivially for N), which keeps the snippet-only judgment basis
   defensible for 32/36 tasks; the four marginal cases are exactly where it strains
   (R9, T8 full text; F2, F3 freshness).
5. **Latency under a spaced battery stayed healthy** (mean 788 ms, max 2386 ms) — no
   degradation onset within 36 sequential queries at 2.5 s spacing, in contrast to the
   burst batteries of 2026-09-11.

## Limits

One window (of the two required before comparative use), one host, one network, one
healthy engine, snippet-level judgment without page fetches, freshness judged at run
date. No candidate comparison and no cross-network claim is made.

## Reproduction

`pnpm build`, then the runner pattern from `2026-09-11-m1-defaults.md` applied to the 36
`tasks-v1.md` queries with a 2.5 s gap, bracketed by `node lib/cli.mjs tune --profile
web` before and after; per-task top five (url/title/snippet/engine) captured to JSON at
run time and judged from that capture.
