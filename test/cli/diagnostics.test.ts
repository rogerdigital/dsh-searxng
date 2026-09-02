import { describe, expect, it, vi } from 'vitest'
import { CliError } from '../../src/cli/errors.ts'
import { diagnose, inspectSnapshot, type DiagnosticDependencies, type SnapshotDependencies } from '../../src/cli/diagnostics.ts'
import { stateSha256, type OperationJournal } from '../../src/cli/journal.ts'
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

const COMPOSE_PATH = `/dsh/dsh-searxng/config-${'a'.repeat(64)}/compose.yml`
const START = '2026-08-30T12:00:00.000Z'

function journalFixture(phase: OperationJournal['phase'] = 'mutating'): OperationJournal {
  return {
    schemaVersion: 1,
    id: 'd'.repeat(32),
    kind: 'update',
    phase,
    startedAt: START,
    updatedAt: START,
    beforeStateSha256: 'a'.repeat(64),
  }
}

function snapshotHarness(options: {
  mode?: 'managed' | 'external'
  state?: StateV2
  container?: 'running' | 'stopped' | 'absent'
  dockerOffline?: boolean
  foreign?: boolean
  assets?: 'valid' | 'missing' | 'invalid'
  portOccupied?: boolean
  authFailed?: boolean
  tlsFailed?: boolean
  searchFailed?: boolean
  attached?: boolean
  currentEndpoint?: string
  journal?: OperationJournal
  profileMissing?: boolean
} = {}) {
  const mode = options.mode ?? 'managed'
  const calls: string[] = []
  const dependencies: SnapshotDependencies = {
    environment: {
      resolve: vi.fn(async () => ({ dshHome: '/dsh', profileDir: '/dsh/profiles/web', managedDir: '/dsh/dsh-searxng', homeId: HOME_ID })),
      preflightDsh: vi.fn(async () => {}),
      preflightManaged: vi.fn(async () => {
        calls.push('port-probe')
        if (options.portOccupied) throw new CliError('E_PORT_CONFLICT', 'Port 8080 is already in use', 'choose another')
      }),
    },
    state: {
      read: vi.fn(async () => options.profileMissing
        ? { ...state(mode), profiles: {} }
        : state(mode)),
      write: vi.fn(),
      withLock: vi.fn(async (operation) => operation()),
    },
    journal: {
      read: vi.fn(async () => options.journal === undefined ? undefined : structuredClone(options.journal)),
      begin: vi.fn(), transition: vi.fn(), clear: vi.fn(),
    },
    probeAssets: vi.fn(async () => options.assets ?? 'valid'),
    docker: {
      preflight: vi.fn(async () => {
        calls.push('docker')
        if (options.dockerOffline) throw new CliError('E_DOCKER_OFFLINE', 'offline', 'start Docker')
        return { serverVersion: '27', composeVersion: '2.30' }
      }),
      inspectOwnership: vi.fn(async () => 'owned' as const), up: vi.fn(), restart: vi.fn(), down: vi.fn(), logs: vi.fn(async () => ''),
      deploymentStatus: vi.fn(async () => {
        calls.push('ownership')
        if (options.foreign) throw new CliError('E_RESOURCE_FOREIGN', 'foreign', 'rename it')
        return { ownership: 'owned' as const, container: options.container ?? 'running' as const, composePath: COMPOSE_PATH }
      }),
    },
    profiles: {
      inspect: vi.fn(), attach: vi.fn(), detach: vi.fn(), uninstall: vi.fn(), validate: vi.fn(),
      preview: vi.fn(async () => {
        calls.push('profile')
        return {
          installed: options.attached ?? true,
          attached: options.attached ?? true,
          config: { baseURL: ENDPOINT },
          ...(options.currentEndpoint === undefined ? {} : { current: { baseURL: options.currentEndpoint } }),
        }
      }),
    },
    searxng: {
      http: vi.fn(async () => { calls.push('http') }),
      readiness: vi.fn(async () => { calls.push('json') }),
      realSearch: vi.fn(async () => {
        calls.push('search')
        if (options.authFailed) throw new CliError('E_AUTH_FAILED', 'auth', 'check header')
        if (options.tlsFailed) throw new CliError('E_TLS_FAILED', 'tls', 'check certificate')
        if (options.searchFailed) throw new CliError('E_SEARCH_FAILED', 'down', 'doctor')
        return { endpoint: ENDPOINT, resultCount: 1, elapsedMs: 1 }
      }),
      providerSearch: vi.fn(async () => ({ endpoint: ENDPOINT, resultCount: 1, elapsedMs: 1 })),
    },
  }
  return { dependencies, calls }
}

describe('inspectSnapshot', () => {
  it('produces a healthy managed snapshot with the hashed state', async () => {
    const test = snapshotHarness()
    const current = state('managed').managed!.current
    const snapshot = await inspectSnapshot('web', test.dependencies)
    expect(snapshot).toEqual({
      profile: 'web',
      expectedEndpoint: ENDPOINT,
      stateHash: stateSha256(state('managed')),
      mode: 'managed',
      docker: 'healthy',
      ownership: 'owned',
      container: 'running',
      generatedAssets: 'valid',
      port: 'owned',
      endpoint: 'healthy',
      ownedTemporaryResourceIds: [],
    })
    expect('profileEndpoint' in snapshot).toBe(false)
    expect('interruptedOperation' in snapshot).toBe(false)
    expect(test.dependencies.probeAssets).toHaveBeenCalledWith({
      stateDir: '/dsh/dsh-searxng',
      homeId: HOME_ID,
      current,
      composePath: COMPOSE_PATH,
    })
    expect(test.calls).not.toContain('port-probe')
  })

  it('classifies a stopped container with an occupied port as a foreign port conflict', async () => {
    const test = snapshotHarness({ container: 'stopped', portOccupied: true })
    const snapshot = await inspectSnapshot('web', test.dependencies)
    expect(snapshot).toMatchObject({ container: 'stopped', port: 'foreign', endpoint: 'healthy' })
    expect(test.calls).toContain('port-probe')
  })

  it('skips endpoint probing and reports unreachable when Docker is offline', async () => {
    const test = snapshotHarness({ dockerOffline: true })
    const snapshot = await inspectSnapshot('web', test.dependencies)
    expect(snapshot).toMatchObject({ docker: 'offline', endpoint: 'unreachable', ownership: 'absent' })
    expect(test.calls).not.toContain('http')
    expect(test.dependencies.environment.preflightManaged).not.toHaveBeenCalled()
  })

  it('classifies foreign ownership without probing the endpoint', async () => {
    const test = snapshotHarness({ foreign: true })
    const snapshot = await inspectSnapshot('web', test.dependencies)
    expect(snapshot).toMatchObject({ ownership: 'foreign', endpoint: 'unreachable' })
    expect(test.calls).not.toContain('http')
  })

  it('classifies authentication failure from the endpoint probe chain', async () => {
    const test = snapshotHarness({ authFailed: true })
    const snapshot = await inspectSnapshot('web', test.dependencies)
    expect(snapshot).toMatchObject({ endpoint: 'auth-failed' })
  })

  it('classifies a TLS failure distinctly as tls-failed', async () => {
    const test = snapshotHarness({ tlsFailed: true })
    const snapshot = await inspectSnapshot('web', test.dependencies)
    expect(snapshot).toMatchObject({ endpoint: 'tls-failed' })
  })

  it('classifies a generic endpoint failure as unreachable', async () => {
    const test = snapshotHarness({ searchFailed: true })
    const snapshot = await inspectSnapshot('web', test.dependencies)
    expect(snapshot).toMatchObject({ endpoint: 'unreachable' })
  })

  it('maps an absent container to missing while keeping owned assets', async () => {
    const test = snapshotHarness({ container: 'absent' })
    const snapshot = await inspectSnapshot('web', test.dependencies)
    expect(snapshot).toMatchObject({ container: 'missing', generatedAssets: 'valid', port: 'available' })
  })

  it('reports a stale attachment as a profile endpoint mismatch with its live endpoint', async () => {
    const test = snapshotHarness({ attached: false, currentEndpoint: 'http://drifted.invalid' })
    const snapshot = await inspectSnapshot('web', test.dependencies)
    expect(snapshot.profileEndpoint).toEqual({ profile: 'web', expected: ENDPOINT, actual: 'http://drifted.invalid' })
  })

  it('omits the live endpoint when no attachment config is readable', async () => {
    const test = snapshotHarness({ attached: false })
    const snapshot = await inspectSnapshot('web', test.dependencies)
    expect(snapshot.profileEndpoint).toEqual({ profile: 'web', expected: ENDPOINT })
  })

  it('carries an interrupted operation from the journal', async () => {
    const interrupted = journalFixture('validating')
    const test = snapshotHarness({ journal: interrupted })
    const snapshot = await inspectSnapshot('web', test.dependencies)
    expect(snapshot.interruptedOperation).toEqual(interrupted)
  })

  it('skips Docker inspection for external profiles but still probes the endpoint', async () => {
    const test = snapshotHarness({ mode: 'external' })
    const snapshot = await inspectSnapshot('web', test.dependencies)
    expect(snapshot).toEqual({
      profile: 'web',
      expectedEndpoint: ENDPOINT,
      stateHash: stateSha256(state('external')),
      mode: 'external',
      docker: 'healthy',
      ownership: 'absent',
      container: 'missing',
      generatedAssets: 'valid',
      port: 'available',
      endpoint: 'healthy',
      ownedTemporaryResourceIds: [],
    })
    expect(test.dependencies.docker.preflight).not.toHaveBeenCalled()
    expect(test.dependencies.environment.preflightManaged).not.toHaveBeenCalled()
    expect(test.calls).toEqual(['profile', 'http', 'json', 'search'])
  })

  it('rejects a profile without a recorded attachment', async () => {
    const test = snapshotHarness({ profileMissing: true })
    await expect(inspectSnapshot('web', test.dependencies)).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
  })
})
