# 2026-09-12 — M2.3 Chinese engine configuration evaluation (window 1): DEFER

Scope: candidate engine-configuration evaluation on an **isolated development instance**
(plan M2.3), producing the go/defer decision for M3 (overlay apply) and M4 (zh preset).
Decision recorded at the end of this report. No managed deployment, profile, or state was
touched; the isolated instance was removed after the run.

## Environment

| Field | Value |
|---|---|
| Host / network | Same as all 2026-09-11/12 reports; one network environment, no cross-network claim |
| Instance | Isolated container from the catalog v1 image (`ghcr.io/searxng/searxng:2026.8.20-8d3dd0cd4@sha256:e7bb…`), `127.0.0.1:8081`, fresh engine state |
| Plugin revision | `2b79b71` (measurement used the JSON API directly; labeled) |
| Settings | `use_default_settings: true`, JSON format, limiter off, plus `disabled: false` overrides for `baidu`, `sogou`, `quark`, `bing`, `mojeek`, `qwant` (the packaged defaults leave all six disabled — verified via `/config`, 82 of 269 engines enabled by default) |
| Battery | 20 zh tasks (N1–N10, R1–R10 of `tasks-v1.md`), sequential, 2.5 s gap, per-candidate explicit `engines=` allowlists, 60 s pause between candidates |

Engine identifiers were verified against the pinned image via `/config`; the Chinese-native
engines present are `baidu`, `sogou`, `quark` — all disabled by default, so a query-level
`engines=` parameter alone can never select them on the packaged settings. This is why the
apply path (M3) exists at all; this evaluation used an isolated instance instead.

## Phase A — first-touch engine state (fresh instance, one zh query each)

| Engine | First response |
|---|---|
| google cse | 20 results, healthy |
| bing | 10 results, healthy |
| quark | 9 results, healthy |
| baidu | suspended: CAPTCHA — blocked from the very first request |
| sogou | suspended: CAPTCHA — blocked from the very first request |
| mojeek | suspended: access denied |
| qwant | CAPTCHA |
| duckduckgo / brave / startpage | CAPTCHA / rate-limited / CAPTCHA (matching the managed instance's state) |

The Chinese-native engines this network was most hoped for are unreachable here from the
first touch. The live menu was `{google cse, bing, quark}`.

## Candidates and results

| Candidate | Engines | Useful tasks (of 20) | Mean latency | Result notes |
|---|---|---|---|---|
| A0 default-set | google cse, duckduckgo, brave, startpage, wikipedia | 20 | 482 ms | Replicates the baseline reality: every useful result from google cse alone; the other four were suspended (the Phase A probe itself exhausted them, matching how the managed instance behaves under real load) |
| A1 diverse | quark, bing, google cse | 9 | 479 ms | N1–N9 fine (google-led; bing contributed N5/N7 top slots; quark contributed N2). From N10 onward google cse and quark both entered cooldown (~30th google query on the instance) and bing alone returned unrelated junk for every research task |
| A2 non-google | quark, bing | 2 strict (4 lenient) | 256 ms | quark contributed zero top-five results all run (suspended after its first few dispatches); this is bing alone. Top-one answers included a Seattle restaurant guide for 清华官网, a Bhagavad Gita page for 丙肝治愈率, a Sri Lankan education portal for 强基计划; only N5 (12306) and N7 (bilibili) were on target, plus partial R6/R9 |

Fast latency with garbage results is worthless: A2's 256 ms mean is the speed of being
confidently wrong. Beyond irrelevance, bing-alone surfaces for one task included
junk/spam-farm content — a quality failure mode worse than an empty page, because a
result-consuming agent has no signal it was poisoned.

## Findings

1. **No candidate passes the gate.** The effective default (google cse alone) answered
   20/20; the best candidate answered 9/20 once its Google engine cooled down, and the
   non-google candidate answered ~2/20. A preset that only changes result count or removes
   error lines does not pass, and these candidates do not even do that.
2. **Engine diversity is dead on this network, not misconfigured.** Eight of ten probed
   engines were blocked from the first request (CAPTCHA / access denied / rate limit) on a
   fresh instance. The packaged default settings are not the cause; the network's egress
   treatment is.
3. **google cse is a single point of quality with a ~30-query cooldown** on a fresh
   instance — consistent with the 2026-09-11 observations on the managed instance.
4. **bing survives but does not answer Chinese queries usefully here.** Whether a
   locale-configured bing variant fixes this is untested (recorded below as a revisit
   condition); on this evidence a mixed set containing bing is actively harmful — it
   pollutes the top five once better engines drop out.
5. **quark is fragile**: healthy at first touch, suspended (CAPTCHA) for most of the
   battery. It is not a diversity anchor.

## Decision: DEFER M3 and M4

Per the development plan: "If a gate fails, retain M1/M2 and defer the dependent work. Do
not build configuration transactions merely to complete the version sequence." The gate
failed — no candidate demonstrated task quality at or above the effective default, and no
engine set restored meaningful redundancy. Building the overlay apply workflow now would
ship a mutation path with nothing worth mutating to.

Conditions that would justify re-evaluation (any one):

- A different network environment where Chinese-native engines respond (cross-network
  evidence is required for any future `go` regardless).
- An upstream/image change that restores engine accessibility on this network.
- A tested bing locale configuration that demonstrably answers zh tasks usefully.

## Reproduction

```sh
mkdir -p /tmp/dsh-searxng-eval/searxng
# settings.yml: use_default_settings: true; server.secret_key random; limiter false;
# search.formats [html, json]; engines: disabled: false for baidu, sogou, quark, bing,
# mojeek, qwant.
docker run -d --name dsh-searxng-eval-isolated -p 127.0.0.1:8081:8080 \
  -v /tmp/dsh-searxng-eval/searxng:/etc/searxng \
  'ghcr.io/searxng/searxng:2026.8.20-8d3dd0cd4@sha256:e7bb47bebf338c52c55c7bed92293873cfe757b554b261829c0d710fd8307fa3'
# probe: one zh query per engine with &engines=<name>
# battery: 20 zh tasks x 3 candidates, &engines= per candidate, 2.5 s gap
docker rm -f dsh-searxng-eval-isolated && rm -rf /tmp/dsh-searxng-eval
```

(Note: the pinned digest is amd64; on arm64 hosts the isolated instance starts slowly
under emulation — allow a minute for readiness.)
