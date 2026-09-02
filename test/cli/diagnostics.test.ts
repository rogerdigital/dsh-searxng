import { describe, expect, it, vi } from 'vitest'
import { CliError } from '../../src/cli/errors.ts'
import { diagnose, type DiagnosticDependencies } from '../../src/cli/diagnostics.ts'
import type { StateV2 } from '../../src/cli/state.ts'

const HOME_ID = '0123456789abcdef'
const PROJECT = `dsh-searxng-${HOME_ID}`
const ENDPOINT = 'http://127.0.0.1:8080'

function state(mode: 'managed' | 'external'): StateV2 {
  return {
    schemaVersion: 2,
    homeId: HOME_ID,
    ...(mode === 'managed' ? {
      managed: {
        current: {
          deploymentVersion: 1,
          image: 'image', endpoint: ENDPOINT, port: 8080,
          projectName: PROJECT, containerName: PROJECT,
        },
        lastHealthyAt: '2026-08-30T00:00:00.000Z',
      },
    } : {}),
    profiles: { web: { mode, endpoint: ENDPOINT } },
  }
}

function harness(mode: 'managed' | 'external' = 'managed', failure?: string) {
  const calls: string[] = []
  const fail = (id: string) => {
    if (failure === id) throw new CliError('E_SEARCH_FAILED', `failed ${id}`, 'repair', { authHeader: 'secret' })
  }
  const dependencies: DiagnosticDependencies = {
    environment: {
      resolve: vi.fn(async () => { calls.push('environment'); fail('environment'); return { dshHome: '/dsh', profileDir: '/dsh/profiles/web', managedDir: '/dsh/dsh-searxng', homeId: HOME_ID } }),
      preflightDsh: vi.fn(async () => { calls.push('dsh'); fail('environment') }),
      preflightManaged: vi.fn(),
    },
    state: {
      read: vi.fn(async () => state(mode)), write: vi.fn(),
      withLock: vi.fn(async (operation) => operation()),
    },
    docker: {
      preflight: vi.fn(async () => { calls.push('docker'); fail('docker'); return { serverVersion: '27', composeVersion: '2.30' } }),
      inspectOwnership: vi.fn(async () => 'owned' as const), up: vi.fn(), restart: vi.fn(), down: vi.fn(), logs: vi.fn(async () => ''),
      deploymentStatus: vi.fn(async () => {
        calls.push('ownership'); fail('ownership')
        return { ownership: 'owned' as const, container: failure === 'container' ? 'stopped' as const : 'running' as const, composePath: `/dsh/dsh-searxng/config-${'a'.repeat(64)}/compose.yml` }
      }),
    },
    profiles: {
      inspect: vi.fn(), attach: vi.fn(), detach: vi.fn(), uninstall: vi.fn(),
      validate: vi.fn(async (_profile, _endpoint, callback) => { await callback({ baseURL: ENDPOINT }) }),
      preview: vi.fn(async () => { calls.push('profile'); fail('profile'); return { installed: true, attached: true, config: { baseURL: ENDPOINT } } }),
    },
    searxng: {
      http: vi.fn(async () => { calls.push('http'); fail('http') }),
      readiness: vi.fn(async () => { calls.push('json'); fail('json') }),
      realSearch: vi.fn(async () => { calls.push('search'); fail('search'); return { endpoint: ENDPOINT, resultCount: 1, elapsedMs: 1 } }),
      providerSearch: vi.fn(async () => { calls.push('provider'); fail('provider'); return { endpoint: ENDPOINT, resultCount: 1, elapsedMs: 1 } }),
    },
  }
  return { dependencies, calls }
}

describe('diagnose', () => {
  it('runs managed doctor checks in stable order', async () => {
    const test = harness()
    const result = await diagnose('web', 'doctor', test.dependencies)
    expect(result.healthy).toBe(true)
    expect(result.checks.map((check) => check.id)).toEqual([
      'environment', 'docker', 'ownership', 'container', 'http', 'json', 'search', 'profile', 'provider',
    ])
    expect(result.checks.every((check) => check.status === 'pass')).toBe(true)
    expect(test.calls).toEqual(['environment', 'dsh', 'profile', 'docker', 'ownership', 'http', 'json', 'search', 'provider'])
  })

  it('skips every Docker check for external profiles', async () => {
    const test = harness('external')
    const result = await diagnose('web', 'doctor', test.dependencies)
    expect(result.checks.slice(1, 4).map((check) => check.status)).toEqual(['skip', 'skip', 'skip'])
    expect(test.dependencies.docker.preflight).not.toHaveBeenCalled()
    expect(test.dependencies.docker.deploymentStatus).not.toHaveBeenCalled()
    expect(result.healthy).toBe(true)
  })

  it('records the first failure and skips unsafe downstream doctor checks with redacted errors', async () => {
    const test = harness('managed', 'json')
    const result = await diagnose('web', 'doctor', test.dependencies)
    const json = result.checks.find((check) => check.id === 'json')
    expect(json).toMatchObject({ status: 'fail', error: { code: 'E_SEARCH_FAILED', authHeader: '[REDACTED]' } })
    expect(result.checks.slice(6).map((check) => check.status)).toEqual(['skip', 'skip', 'skip'])
    expect(result.healthy).toBe(false)
  })

  it('stops status immediately after the first failed check', async () => {
    const test = harness('managed', 'docker')
    const result = await diagnose('web', 'status', test.dependencies)
    expect(result.checks.map((check) => [check.id, check.status])).toEqual([
      ['environment', 'pass'], ['docker', 'fail'],
    ])
    expect(test.dependencies.docker.deploymentStatus).not.toHaveBeenCalled()
  })
})
