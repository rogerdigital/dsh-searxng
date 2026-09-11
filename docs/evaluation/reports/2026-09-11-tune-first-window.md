# 2026-09-11 — Tune first window: engine-attributed degradation of the default configuration

Scope: first engine-attributed observation of the default engine set's degradation on this
network, captured by the newly delivered `dsh-searxng tune` report. Diagnostic evidence
only — no task-set run, no answerability judgments, and no configuration comparison. This
window attributes the M1 report's "empty HTTP-200 results" observation to specific engines
and causes.

## Environment

Same host, instance, and network as `2026-09-11-m1-defaults.md` (managed profile `web`,
image `ghcr.io/searxng/searxng:2026.8.20-8d3dd0cd4`, one network environment, no
cross-network claim). Plugin: the M2 branch working tree (PR #33; the tune logic is what
merged as `124fbee`). Timing: several hours after the M1 evaluation's two batteries; the
instance saw no deliberate load in between beyond `doctor`'s validation searches. Exact
wall-clock time not recorded; same day.

## Observation (verbatim `tune --profile web` summary)

| Engine | Reported failures | Contribution | Flagged |
|---|---|---|---|
| brave | 6/6 — too many requests / suspended | 0 results | yes |
| duckduckgo | 6/6 — CAPTCHA | 0 results | yes |
| startpage | 6/6 — timeout / suspended | 0 results | yes |
| google cse | 4/6 — timeout / suspended | 40 results | no |

Per-probe (wall time, results, unresponsive engines with reasons):

| Query | ms | Results | Unresponsive |
|---|---|---|---|
| docker compose reference | 3078 | 0 | brave (too many requests), duckduckgo (CAPTCHA), google cse (timeout), startpage (timeout) |
| rust borrow checker explanation | 3033 | 0 | brave (suspended: too many requests), duckduckgo (CAPTCHA), google cse (timeout), startpage (suspended: timeout) |
| 清华大学 官网 | 778 | 0 | brave, duckduckgo, google cse, startpage (same causes) |
| 个人养老金 年缴费上限 | 3022 | 0 | brave, duckduckgo, google cse, startpage (same causes) |
| kubernetes node not ready 排查 | 1176 | 20 | brave, duckduckgo, startpage |
| abortsignal abortcontroller fetch api mdn | 1184 | 20 | brave, duckduckgo, startpage |

## Findings

1. **The default engine set was already degraded before this battery started.** The very
   first probe saw all four reporting engines failing. The instance had carried no
   deliberate load for hours after the M1 batteries, so on this network the upstream
   cooldown outlasts hours of idleness (or a single early query re-triggered it) — either
   way, the "wait a few minutes" recovery assumption is not safe for evaluation planning.
2. **Causes are engine-specific and consistent**: brave rate-limits (HTTP-level too many
   requests), duckduckgo serves CAPTCHAs, google cse and startpage time out. Cause
   variety suggests per-engine anti-abuse mechanisms, not one shared outage.
3. **Partial recovery is visible and correctly not flagged**: google cse failed in 4/6
   probes yet contributed 40 results — the review rule (repeated failures **and** zero
   contribution) kept it off the flagged list, exactly the conservative behavior M2
   specified.
4. **Empty answers are slower than useful ones here**: the four zero-result probes took
   778–3078 ms while both result-bearing probes took ~1.2 s — consistent with
   timeout-driven empties (the instance waits for engines that never answer) rather than
   fast negative answers.
5. **Consequences for planned evaluations**: (a) batteries must space across longer
   intervals than hours, or acceptance that early probes measure a degraded state;
   (b) every M2.3 candidate-configuration run should bracket itself with a `tune` report
   so engine health at run time is recorded alongside the task results; (c) the task
   quality baseline of the default configuration on this network will be measured against
   a largely degraded engine set unless engines recover — that context must travel with
   the numbers.

## Limits

One window, one host, one network, one diagnostic battery (six fixed queries). The tune
report's own evidence limits apply: absence from the failure list is not health, wall
time is aggregate, and a short battery cannot establish long-term engine value.
