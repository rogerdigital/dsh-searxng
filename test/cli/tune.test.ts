import { describe, expect, it, vi } from 'vitest'
import {
  TUNE_PROBE_BATTERY,
  formatTuneReport,
  runTuneReport,
  type TuneDependencies,
  type TuneReport,
} from '../../src/cli/tune.ts'
import { runCli } from '../../src/cli.ts'
import type { EnvironmentService } from '../../src/cli/environment.ts'
import type { ProfileManager } from '../../src/cli/profile.ts'
import type { StateStore, StateV2 } from '../../src/cli/state.ts'

const PROFILE = 'web'
const ENDPOINT = 'http://127.0.0.1:8080'

function envelope(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function result(url: string, engine?: string): Record<string, unknown> {
  return { url, ...(engine === undefined ? {} : { engine }) }
}

interface HarnessOptions {
  state?: StateV2
  previewConfig?: Record<string, unknown>
  previewError?: unknown
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
}

function harness(options: HarnessOptions = {}) {
  const fetch = vi.fn(options.fetch ?? (async () => envelope({ results: [result('https://example.com/a', 'bing')] })))
  const dependencies: TuneDependencies = {
    environment: {
      resolve: vi.fn(async () => ({
        dshHome: '/tmp/dsh', profileDir: '/tmp/dsh/profiles/web', managedDir: '/tmp/dsh/dsh-searxng', homeId: '0123456789abcdef',
      })),
    } as unknown as EnvironmentService,
    state: {
      read: vi.fn(async () => structuredClone(options.state ?? {
        schemaVersion: 2,
        homeId: '0123456789abcdef',
        profiles: { [PROFILE]: { mode: 'managed', endpoint: ENDPOINT } },
      })),
    } as unknown as StateStore,
    profiles: {
      preview: vi.fn(async () => {
        if (options.previewError !== undefined) throw options.previewError
        return {
          installed: true,
          attached: true,
          config: { baseURL: ENDPOINT, ...(options.previewConfig ?? {}) },
        }
      }),
    } as unknown as ProfileManager,
    now: () => new Date('2026-09-11T08:00:00.000Z'),
    fetch: fetch as unknown as typeof globalThis.fetch,
  }
  return { dependencies, fetch }
}

function queryOf(url: string): string {
  return new URL(url).searchParams.get('q') ?? ''
}

/** Run the full battery under fake timers; the 1 s probe gaps are the only timers. */
async function runBattery<T>(start: () => Promise<T>): Promise<T> {
  vi.useFakeTimers()
  try {
    const promise = start()
    void promise.catch(() => {})
    await vi.advanceTimersByTimeAsync(10_000)
    return await promise
  } finally {
    vi.useRealTimers()
  }
}

describe('runTuneReport', () => {
  it('runs the fixed battery sequentially and reports per-query observations', async () => {
    const test = harness({
      fetch: async (url) => envelope({
        results: [result('https://example.com/a', 'bing'), result('https://example.com/b', 'duckduckgo')],
      }),
    })
    const report = await runBattery(() => runTuneReport(PROFILE, test.dependencies))

    expect(TUNE_PROBE_BATTERY).toHaveLength(6)
    expect(test.fetch).toHaveBeenCalledTimes(6)
    expect(test.fetch.mock.calls.map(([url]) => queryOf(url as string))).toEqual([...TUNE_PROBE_BATTERY])
    expect(report.probes.map((probe) => probe.query)).toEqual([...TUNE_PROBE_BATTERY])
    expect(report.probes[0]).toMatchObject({ resultCount: 2, elapsedMs: expect.any(Number), unresponsive: [] })
    expect(report.probes[0]!.contributions).toEqual([
      { engine: 'bing', results: 1 },
      { engine: 'duckduckgo', results: 1 },
    ])
    expect(report).toMatchObject({ profile: PROFILE, mode: 'managed', endpoint: ENDPOINT, generatedAt: '2026-09-11T08:00:00.000Z' })
  })

  it('normalizes every unresponsive_engines shape tolerantly', async () => {
    const perProbe = [
      [['google', 'timeout']],
      [{ engine: 'bing', error: 'captcha' }],
      ['duckduckgo'],
      [{ engine: 'startpage' }],
      undefined,
      [42, null, { engine: 'mojeek', error: 'connection' }],
    ]
    const test = harness()
    test.dependencies.fetch = (async () => {
      const shape = perProbe.shift()
      return envelope({
        results: [],
        ...(shape === undefined ? {} : { unresponsive_engines: shape }),
      })
    }) as unknown as typeof globalThis.fetch

    const report = await runBattery(() => runTuneReport(PROFILE, test.dependencies))
    expect(report.probes.map((probe) => probe.unresponsive)).toEqual([
      [{ engine: 'google', reason: 'timeout' }],
      [{ engine: 'bing', reason: 'captcha' }],
      [{ engine: 'duckduckgo' }],
      [{ engine: 'startpage' }],
      [],
      [{ engine: 'mojeek', reason: 'connection' }],
    ])
  })

  it('flags only repeated failures with zero contribution for review', async () => {
    let call = 0
    const dependencies = harness().dependencies
    dependencies.fetch = (async () => {
      call += 1
      // google fails in probes 1-3 (majority of 6) and never contributes;
      // bing fails once but contributes everywhere; brave never fails.
      const unresponsive = call <= 3 ? [['google', 'timeout']] : []
      const results = [result(`https://example.com/${call}-b`, 'bing'), result(`https://example.com/${call}-c`, 'brave')]
      return envelope({ results, unresponsive_engines: unresponsive })
    }) as unknown as typeof globalThis.fetch

    const report = await runBattery(() => runTuneReport(PROFILE, dependencies))
    const byEngine = new Map(report.engines.map((engine) => [engine.engine, engine]))
    expect(byEngine.get('google')).toMatchObject({ reportedFailures: 3, ofProbes: 6, resultContribution: 0, flaggedForReview: true })
    expect(byEngine.get('bing')).toMatchObject({ reportedFailures: 0, resultContribution: 6, flaggedForReview: false })
    expect(byEngine.get('brave')).toMatchObject({ reportedFailures: 0, resultContribution: 6, flaggedForReview: false })
    expect(report.engines.map((engine) => engine.engine).sort()).toEqual(['bing', 'brave', 'google'])
  })

  it('records the evidence limits instead of implying health from silence', async () => {
    const test = harness()
    const report = await runBattery(() => runTuneReport(PROFILE, test.dependencies))
    const joined = report.evidenceLimits.join('\n')
    expect(joined).toMatch(/not health/i)
    expect(joined).toMatch(/never attributed to a single engine/i)
    expect(joined).toMatch(/review/i)
    expect(joined).toMatch(/read-only/i)
  })

  it('stops at the first probe failure with the classified error', async () => {
    const test = harness({ fetch: async () => envelope({ results: [] }, 403) })
    await expect(runTuneReport(PROFILE, test.dependencies)).rejects.toMatchObject({
      code: 'E_JSON_DISABLED',
    })
    expect(test.fetch).toHaveBeenCalledTimes(1)
  })

  it('spaces probes with a bounded gap and honors cancellation', async () => {
    vi.useFakeTimers()
    try {
      const test = harness()
      const controller = new AbortController()
      const attempt = runTuneReport(PROFILE, test.dependencies, controller.signal)
      void attempt.catch(() => {})
      await vi.advanceTimersByTimeAsync(0)
      expect(test.fetch).toHaveBeenCalledTimes(1)
      controller.abort()
      await expect(attempt).rejects.toMatchObject({ name: 'AbortError' })
      expect(test.fetch).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('requires a recorded attachment', async () => {
    const test = harness({
      state: { schemaVersion: 2, homeId: '0123456789abcdef', profiles: {} },
    })
    await expect(runTuneReport(PROFILE, test.dependencies)).rejects.toMatchObject({
      code: 'E_STATE_INVALID',
      message: expect.stringContaining('no recorded SearXNG attachment'),
    })
    expect(test.fetch).not.toHaveBeenCalled()
  })

  it('uses the effective profile config including auth and language', async () => {
    const test = harness({
      previewConfig: { authHeader: 'Bearer tok', language: 'zh-CN' },
    })
    await runBattery(() => runTuneReport(PROFILE, test.dependencies))
    const [firstUrl, firstInit] = test.fetch.mock.calls[0]! as [string, RequestInit]
    expect(queryOf(firstUrl)).toBe(TUNE_PROBE_BATTERY[0])
    expect(new URL(firstUrl).searchParams.get('language')).toBe('zh-CN')
    expect((firstInit.headers as Record<string, string>).authorization).toBe('Bearer tok')
  })

  it('falls back to the recorded endpoint when the profile preview fails', async () => {
    const test = harness({ previewError: new Error('dsh unavailable') })
    await runBattery(() => runTuneReport(PROFILE, test.dependencies))
    const [firstUrl, firstInit] = test.fetch.mock.calls[0]! as [string, RequestInit]
    expect(new URL(firstUrl).origin).toBe(ENDPOINT)
    expect((firstInit.headers as Record<string, string>).authorization).toBeUndefined()
  })
})

describe('formatTuneReport', () => {
  it('renders engine lines, probes, and evidence limits for humans', () => {
    const report: TuneReport = {
      profile: PROFILE,
      mode: 'managed',
      endpoint: ENDPOINT,
      generatedAt: '2026-09-11T08:00:00.000Z',
      probes: [{
        query: 'docker compose reference',
        elapsedMs: 812,
        resultCount: 20,
        unresponsive: [{ engine: 'google', reason: 'timeout' }],
        contributions: [{ engine: 'bing', results: 20 }],
      }],
      engines: [
        { engine: 'google', reportedFailures: 3, ofProbes: 6, resultContribution: 0, flaggedForReview: true },
        { engine: 'bing', reportedFailures: 0, ofProbes: 6, resultContribution: 20, flaggedForReview: false },
      ],
      evidenceLimits: ['Absence from the unresponsive list is not health'],
    }
    const text = formatTuneReport(report)
    expect(text).toContain('(1 probes, managed, http://127.0.0.1:8080)')
    expect(text).toContain('google: 3/6 reported failures, 0 results — flagged for review')
    expect(text).toContain('bing: 0/6 reported failures, 20 results')
    expect(text).toContain("'docker compose reference' — 812ms, 20 results, unresponsive: google (timeout)")
    expect(text).toContain('- Absence from the unresponsive list is not health')
  })
})

describe('tune command wiring', () => {
  it('prints the JSON report with a zero exit code', async () => {
    const test = harness()
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = await runBattery(() => runCli(['tune', '--json'], {
      dependencies: test.dependencies as unknown as NonNullable<Parameters<typeof runCli>[1]>['dependencies'],
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    }))
    expect(exitCode).toBe(0)
    expect(stderr).toEqual([])
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      profile: PROFILE,
      mode: 'managed',
      endpoint: ENDPOINT,
      probes: TUNE_PROBE_BATTERY.map((query) => expect.objectContaining({ query })),
    })
  })

  it('prints the human report by default', async () => {
    const test = harness()
    const stdout: string[] = []
    const exitCode = await runBattery(() => runCli(['tune'], {
      dependencies: test.dependencies as unknown as NonNullable<Parameters<typeof runCli>[1]>['dependencies'],
      stdout: (text) => stdout.push(text),
      stderr: () => {},
    }))
    expect(exitCode).toBe(0)
    expect(stdout[0]).toContain('SearXNG engine health report')
    expect(stdout[0]).toContain('Evidence limits')
  })
})
