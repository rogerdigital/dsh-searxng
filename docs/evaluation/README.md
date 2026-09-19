# Product evaluation

Development evidence for search quality, latency, and maintenance claims. Engineering
checks (`pnpm verify`, certification) prove the implementation works as specified; they do
not establish search quality. Nothing here is a telemetry service or a runtime dependency.

Directory layout:

- `tasks-v1.md` — the versioned task set (the only approved task list; changes require a
  new version file and a note in the report that used it).
- `reports/` — dated run reports, one file per evaluation, named `YYYY-MM-DD-<label>.md`.

## What is compared

Every evaluation compares at least:

1. The **baseline**: the current released default configuration (no preset, default knobs),
   cold-started.
2. Each **candidate**: a configuration change under consideration (engine selection, preset,
   or client knob values).

Official dsh alternatives (Exa, Perplexity) may be added where credentials and budget
exist; explicitly mark missing comparisons. Direct API experiments and adapter-mediated
results are recorded as different evidence classes and never mixed.

## Measurements

Per task (manual inspection, no scraping shortcuts):

- **Useful source**: does any of the first five results contain the information the task
  needs? Yes/no per result, then task answerable if at least one is useful.
- **Empty or unusable**: zero results, or all first-five results unusable (wrong language,
  dead link, paywalled content the task needs, unrelated).
- **Duplicates**: results with the same ultimate content (same article syndicated, same
  host repeated).
- **Unique useful sources**: count of distinct useful sources among the first five.

Result count and the number of reported engine failures are recorded but never treated as
quality scores.

Per configuration:

- **Latency**, measured separately and labeled: cold (first query per task, or with cache
  disabled via `cacheTtlMs: 0`), warm-cache (immediate repeat), and burst (ten concurrent
  distinct queries). Include failures and queue rejections in the measurement; a fast
  rejection is never counted as a fast success.
- **Maintenance effort**: steps and wall time to diagnose and recover from the same
  representative failure on each configuration (stopped container, corrupted settings
  bundle, occupied port), using `doctor`/`repair` only.

## Recording rules

Each report records: plugin revision (`git rev-parse HEAD` and package version), image
digest from `status --json`, full configuration (preset, knob values, engine selection),
network region and type (mask private details; never record credentials or private
queries), query language, timestamps, and repetitions. Runs repeat across at least two
separate time windows; a claim spanning networks requires evidence from at least two
network environments, labeled per environment.

## Pre-registration

Before any candidate run, the report file records:

- The **primary success metric** (e.g., "task answerability on tasks-v1, zh groups").
- **Acceptable regression bounds** (e.g., "EN control answerability may not drop by more
  than one task; p95 burst latency may not exceed baseline by more than 20%").

A candidate that improves the primary metric while violating the bounds fails the gate.
Report per-task differences and exceptions, not only averages.

## Run procedure (managed baseline or candidate)

`scripts/eval-tasks-v1.mjs` automates the window pattern used by the recorded baseline
reports: tune brackets before and after, the 36 `tasks-v1.md` queries sequential with a
2.5 s gap, and a per-task top-five JSONL capture for snippet-level judgment. Run it from
any network with `--base <endpoint> --out <dir>`; the capture is the judgment input, not
a judgment.

```sh
# 1. Record the environment and configuration under test.
npx dsh-searxng status --profile web --json

# 2. Cold run: fresh query per task (or cacheTtlMs: 0 in the profile), one at a time.
#    Time each query end to end; note failures verbatim (error code, not just "failed").
curl -sS -w '\n%{time_total}s\n' \
  'http://127.0.0.1:8080/search?q=<task query>&format=json' | tail -n 1

# 3. Warm-cache run: repeat each query immediately.

# 4. Burst run: ten distinct queries concurrently; record per-query latency and any
#    queue rejections separately.

# 5. Record per-task judgments (useful/empty/duplicate/unique) in the report while
#    looking at the results; do not reconstruct them later from memory.
```

Provider-level runs (through the dsh session, exercising pacing and the budget) substitute
the `curl` step with searches issued in the dsh profile and are labeled as such.
