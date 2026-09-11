/**
 * Read-only engine-health report (`dsh-searxng tune`). Runs a fixed probe
 * battery sequentially through the SearXNG JSON API and reports what the
 * evidence can support — nothing more:
 *
 * - Presence in `unresponsive_engines` is a reported failure/suspension
 *   observation; it does not prove the engine was actually dispatched.
 * - Absence is **not** health: the JSON API exposes no dispatch list, so
 *   engines that stayed silent earn no credit.
 * - Wall-clock time covers the whole fan-out and is never attributed to a
 *   single engine.
 *
 * The report writes no state, profile, or instance configuration; the apply
 * path is deliberately a later, separate milestone.
 *
 * @module dsh-searxng/cli/tune
 */

import { CliError } from './errors.ts'
import type { EnvironmentService } from './environment.ts'
import type { ProfileAttachmentConfig, ProfileManager } from './profile.ts'
import {
  buildProbeSearchUrl,
  classifyProbeStatus,
  probeDelay,
} from './searxng.ts'
import { requestJsonWithRetry } from '../searxng-client.ts'
import type { StateStore } from './state.ts'

/**
 * Fixed diagnostic battery: EN and zh, navigational and informational,
 * mixed-language technical. Diagnostic queries, not quality-benchmark tasks
 * (those live in docs/evaluation/).
 */
export const TUNE_PROBE_BATTERY: readonly string[] = [
  'docker compose reference',
  'rust borrow checker explanation',
  '清华大学 官网',
  '个人养老金 年缴费上限',
  'kubernetes node not ready 排查',
  'abortsignal abortcontroller fetch api mdn',
]

/** Gap between sequential probes: never fire the battery as a burst. */
const PROBE_GAP_MS = 1_000
const PROBE_TIMEOUT_MS = 10_000

export interface TuneUnresponsiveEntry {
  engine: string
  reason?: string
}

export interface TuneContribution {
  engine: string
  results: number
}

export interface TuneProbeReport {
  query: string
  elapsedMs: number
  resultCount: number
  unresponsive: TuneUnresponsiveEntry[]
  contributions: TuneContribution[]
}

export interface TuneEngineReport {
  engine: string
  reportedFailures: number
  ofProbes: number
  resultContribution: number
  flaggedForReview: boolean
}

export interface TuneReport {
  profile: string
  mode: 'managed' | 'external'
  endpoint: string
  generatedAt: string
  probes: TuneProbeReport[]
  engines: TuneEngineReport[]
  evidenceLimits: readonly string[]
}

export interface TuneDependencies {
  environment: EnvironmentService
  state: StateStore
  profiles: ProfileManager
  now(): Date
  fetch?: typeof globalThis.fetch
}

const EVIDENCE_LIMITS: readonly string[] = [
  'Absence from the unresponsive list is not health: the JSON API exposes no dispatch list, so engines that stayed silent earned no credit',
  'Wall-clock time covers the whole fan-out and is never attributed to a single engine',
  'A short battery cannot establish an engine\'s long-term value; flagged engines are for review, not disablement',
  'This report is read-only: no state, profile, or instance configuration was changed',
]

function invalidState(message: string): CliError {
  return new CliError('E_STATE_INVALID', message, 'Run dsh-searxng setup to record the attachment')
}

function searchFailed(message: string): CliError {
  return new CliError('E_SEARCH_FAILED', message, 'Check the SearXNG endpoint and run dsh-searxng doctor')
}

/** Tolerant normalization of one `unresponsive_engines` entry: tuple, object, or bare string. */
function normalizeUnresponsiveEntry(value: unknown): TuneUnresponsiveEntry | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? { engine: trimmed } : undefined
  }
  if (Array.isArray(value)) {
    const [engine, reason] = value as unknown[]
    if (typeof engine !== 'string' || engine.trim().length === 0) return undefined
    return typeof reason === 'string' && reason.trim().length > 0
      ? { engine: engine.trim(), reason: reason.trim() }
      : { engine: engine.trim() }
  }
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const engine = typeof record.engine === 'string' ? record.engine.trim()
    : typeof record.name === 'string' ? record.name.trim()
    : undefined
  if (engine === undefined || engine.length === 0) return undefined
  const reason = typeof record.error === 'string' && record.error.trim().length > 0
    ? record.error.trim()
    : typeof record.reason === 'string' && record.reason.trim().length > 0
      ? record.reason.trim()
      : undefined
  return reason === undefined ? { engine } : { engine, reason }
}

function normalizeUnresponsiveList(value: unknown): TuneUnresponsiveEntry[] {
  if (!Array.isArray(value)) return []
  const entries: TuneUnresponsiveEntry[] = []
  for (const item of value) {
    const entry = normalizeUnresponsiveEntry(item)
    if (entry !== undefined) entries.push(entry)
  }
  return entries
}

function isValidHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || !URL.canParse(value)) return false
  const url = new URL(value)
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.username.length === 0 && url.password.length === 0
}

interface ProbeOutcome {
  elapsedMs: number
  resultCount: number
  unresponsive: TuneUnresponsiveEntry[]
  contributions: TuneContribution[]
}

async function probeOnce(
  config: ProfileAttachmentConfig,
  query: string,
  fetch: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<ProbeOutcome> {
  const startedAt = Date.now()
  let response: Response
  let payload: unknown
  try {
    const result = await requestJsonWithRetry({
      url: buildProbeSearchUrl(config.baseURL, config, query),
      headers: {
        accept: 'application/json',
        ...(config.authHeader !== undefined && config.authHeader.length > 0
          ? { authorization: config.authHeader }
          : {}),
      },
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: PROBE_TIMEOUT_MS,
      maxAttempts: 1,
      fetch,
    })
    response = result.response
    payload = result.payload
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof CliError) throw error
    throw searchFailed('SearXNG request failed while probing')
  }
  classifyProbeStatus(response.status)
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray((payload as Record<string, unknown>).results)) {
    throw searchFailed('SearXNG returned a malformed search response')
  }
  const envelope = payload as { results: unknown[]; unresponsive_engines?: unknown }
  const contributions = new Map<string, number>()
  let resultCount = 0
  for (const entry of envelope.results) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    if (!isValidHttpUrl(record.url)) continue
    resultCount += 1
    if (typeof record.engine === 'string' && record.engine.trim().length > 0) {
      const engine = record.engine.trim()
      contributions.set(engine, (contributions.get(engine) ?? 0) + 1)
    }
  }
  return {
    elapsedMs: Math.max(0, Date.now() - startedAt),
    resultCount,
    unresponsive: normalizeUnresponsiveList(envelope.unresponsive_engines),
    contributions: [...contributions.entries()].map(([engine, results]) => ({ engine, results })),
  }
}

function aggregate(probes: TuneProbeReport[]): TuneEngineReport[] {
  const reportedFailures = new Map<string, number>()
  const contribution = new Map<string, number>()
  for (const probe of probes) {
    for (const entry of probe.unresponsive) {
      reportedFailures.set(entry.engine, (reportedFailures.get(entry.engine) ?? 0) + 1)
    }
    for (const entry of probe.contributions) {
      contribution.set(entry.engine, (contribution.get(entry.engine) ?? 0) + entry.results)
    }
  }
  const engines = new Set([...reportedFailures.keys(), ...contribution.keys()])
  const threshold = Math.ceil(probes.length / 2)
  return [...engines].sort().map((engine) => {
    const failures = reportedFailures.get(engine) ?? 0
    const results = contribution.get(engine) ?? 0
    return {
      engine,
      reportedFailures: failures,
      ofProbes: probes.length,
      resultContribution: results,
      // Review flag only: repeated reported failures with no observed
      // contribution. Never a disablement instruction.
      flaggedForReview: failures >= threshold && results === 0,
    }
  })
}

/** Human-readable rendering of a report; the JSON form is the report object itself. */
export function formatTuneReport(report: TuneReport): string {
  const engineLines = report.engines.length === 0
    ? ['  no engine reported failures or contributed results']
    : report.engines.map((engine) => engine.flaggedForReview
      ? `  ${engine.engine}: ${engine.reportedFailures}/${engine.ofProbes} reported failures, ${engine.resultContribution} results — flagged for review`
      : `  ${engine.engine}: ${engine.reportedFailures}/${engine.ofProbes} reported failures, ${engine.resultContribution} results`)
  const probeLines = report.probes.map((probe) => {
    const unresponsive = probe.unresponsive.length === 0
      ? ''
      : `, unresponsive: ${probe.unresponsive
          .map((entry) => entry.reason === undefined ? entry.engine : `${entry.engine} (${entry.reason})`)
          .join(', ')}`
    return `  '${probe.query}' — ${probe.elapsedMs}ms, ${probe.resultCount} results${unresponsive}`
  })
  return [
    `SearXNG engine health report (${report.probes.length} probes, ${report.mode}, ${report.endpoint})`,
    '',
    'Engines:',
    ...engineLines,
    '',
    'Probes:',
    ...probeLines,
    '',
    'Evidence limits:',
    ...report.evidenceLimits.map((limit) => `- ${limit}`),
    '',
  ].join('\n')
}

/** Run the read-only engine-health battery for a profile's recorded attachment. */
export async function runTuneReport(
  profile: string,
  dependencies: TuneDependencies,
  signal?: AbortSignal,
): Promise<TuneReport> {
  signal?.throwIfAborted()
  await dependencies.environment.resolve(profile)
  const state = await dependencies.state.read()
  const entry = state.profiles[profile]
  if (entry === undefined) {
    throw invalidState(`Profile ${profile} has no recorded SearXNG attachment`)
  }

  let config: ProfileAttachmentConfig = { baseURL: entry.endpoint }
  try {
    const preview = await dependencies.profiles.preview(profile, entry.endpoint, signal)
    if (preview !== undefined) config = preview.config
  } catch (error) {
    if (signal?.aborted) throw error
    // The recorded endpoint still identifies the instance; the effective
    // profile options (auth, language) are simply unavailable in this run.
  }

  const fetch = dependencies.fetch ?? globalThis.fetch
  const probes: TuneProbeReport[] = []
  for (const [index, query] of TUNE_PROBE_BATTERY.entries()) {
    if (index > 0) await probeDelay(PROBE_GAP_MS, signal)
    signal?.throwIfAborted()
    const outcome = await probeOnce(config, query, fetch, signal)
    probes.push({ query, ...outcome })
  }

  return {
    profile,
    mode: entry.mode,
    endpoint: entry.endpoint,
    generatedAt: dependencies.now().toISOString(),
    probes,
    engines: aggregate(probes),
    evidenceLimits: EVIDENCE_LIMITS,
  }
}
