import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { homeId } from '../../src/cli/environment.ts'
import {
  CERTIFY_CHECKS,
  CertificationError,
  certifyHomeId,
  parseCertifyArgs,
  preflightCertification,
  redactText,
  runCertification,
  type CertifyFileSystem,
  type CertifyProcessResult,
  type CertifySpawner,
  type PreflightResult,
} from '../../scripts/certify-platform.mjs'

type Respond = (
  file: string,
  args: readonly string[],
  world: FakeWorld,
) => Partial<CertifyProcessResult> | undefined

/** In-memory world: a fake fs plus a scriptable, recording spawner. */
class FakeWorld {
  readonly files = new Map<string, string>()
  readonly calls: Array<{ file: string; args: readonly string[]; env?: Record<string, string | undefined> }> = []

  constructor(private readonly respond: Respond) {}

  readonly spawner: CertifySpawner = async (file, args, options) => {
    this.calls.push({ file, args, env: options?.env })
    const result = this.respond(file, args, this) ?? {}
    return {
      code: result.code ?? 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      spawnFailed: result.spawnFailed ?? false,
    }
  }

  readonly fileSystem: CertifyFileSystem = {
    readFile: async (path) => {
      const contents = this.files.get(path)
      if (contents === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return contents
    },
    writeFile: async (path, data) => { this.files.set(path, data) },
    removeFile: async (path) => { this.files.delete(path) },
    pathExists: async (path) => this.files.has(path),
    removeTree: async () => {},
  }
}

const tempRoot = '/tmp/cert-root'
const dshHome = join(tempRoot, 'dsh-home')
const installRoot = join(tempRoot, 'install')
const packageRoot = join(installRoot, 'node_modules', 'dsh-searxng')
const managedDir = join(dshHome, 'dsh-searxng')
const digest = 'a'.repeat(64)
const image = `ghcr.io/searxng/searxng:test@sha256:${'b'.repeat(64)}`
const endpoint = 'http://127.0.0.1:8080'
const identity = certifyHomeId(dshHome)
const containerName = `dsh-searxng-${identity}-searxng-1`
const bundleEnv = join(managedDir, `config-${digest}`, '.env')
const statePath = join(managedDir, 'state.json')
const catalogPath = join(packageRoot, 'assets', 'deployments', 'v1.json')
const templatePath = join(packageRoot, 'assets', 'docker', 'settings.yml.template')
const tarballPath = '/pkg/dsh-searxng-0.2.1.tgz'
const sha256 = 'c'.repeat(64)

const stateJson = () => JSON.stringify({
  schemaVersion: 2,
  homeId: identity,
  managed: {
    current: { deploymentVersion: 1, image, endpoint, port: 8080, projectName: `dsh-searxng-${identity}`, containerName, configurationSha256: digest },
    lastHealthyAt: '2026-09-02T00:00:00.000Z',
  },
  profiles: { web: { mode: 'managed', endpoint } },
})

const seedInstalledPackage = (world: FakeWorld): void => {
  world.files.set(join(packageRoot, 'package.json'), JSON.stringify({ name: 'dsh-searxng', version: '0.9.9' }))
  world.files.set(catalogPath, JSON.stringify({
    schemaVersion: 1,
    deployments: [{
      deploymentVersion: 1,
      image,
      composeAsset: 'docker/compose.yml',
      settingsAsset: 'docker/settings.yml.template',
      stateSchemas: [1, 2],
    }],
  }))
  world.files.set(templatePath, 'use_default_settings: true\n\nserver:\n  secret_key: "__DSH_SEARXNG_SECRET__"\n  limiter: false\n\nsearch:\n  formats:\n    - html\n    - json\n')
}

const healthyDoctor = () => ({
  code: 0,
  stdout: `${JSON.stringify({ profile: 'web', mode: 'managed', endpoint, healthy: true, checks: [] })}\n`,
})

/** The scripted happy-path journey: every lifecycle command succeeds. */
const createHappyJourney = () => {
  const observations: { envPresentAtRemove: boolean } = { envPresentAtRemove: false }
  const respond: Respond = (file, args, world) => {
  if (file === 'dsh') return { code: 0, stdout: 'dsh 1.2.3\n' }
  if (file === 'docker') {
    if (args[0] === 'version') return { code: 0, stdout: '27.3.1\n' }
    if (args[0] === 'compose') return { code: 0, stdout: '2.29.7\n' }
    if (args[0] === 'restart') return { code: 0 }
    if (args[0] === 'container' && args[1] === 'inspect' && args.includes('--format')) return { code: 0, stdout: 'cid-1\n' }
    return { code: 0 }
  }
  if (file === 'node' && args[0] === '/npm-cli.js') return { code: 0 }
  if (file === 'node' && args[0]?.endsWith('cli.mjs')) {
    const command = args[1]
    if (command === 'setup') {
      const repeated = world.calls.filter((call) => call.file === 'node' && call.args[1] === 'setup').length > 1
      if (!repeated) {
        world.files.set(statePath, stateJson())
        world.files.set(bundleEnv, 'DSH_SEARXNG_IMAGE=...\n')
        return { code: 0, stdout: `${JSON.stringify({ profile: 'web', endpoint, reused: false })}\n` }
      }
      return { code: 0, stdout: `${JSON.stringify({ profile: 'web', endpoint, reused: true })}\n` }
    }
    if (command === 'status') return { code: 0, stdout: `${JSON.stringify({ profile: 'web', mode: 'managed', endpoint, healthy: true, checks: [] })}\n` }
    if (command === 'doctor') return healthyDoctor()
    if (command === 'repair') {
      world.files.set(bundleEnv, 'DSH_SEARXNG_IMAGE=...\n')
      return {
        code: 0,
        stdout: `${JSON.stringify({
          profile: 'web',
          endpoint,
          healthy: true,
          actions: [{ type: 'render-assets', preserveSecret: true }, { type: 'recreate-runtime', preserveData: true }],
          checks: [],
        })}\n`,
      }
    }
    if (command === 'update') {
      return {
        code: 1,
        stderr: `${JSON.stringify({
          code: 'E_JSON_DISABLED',
          message: 'SearXNG JSON search is unavailable',
          action: 'Enable json in search.formats and retry',
          rolledBack: true,
          targetVersion: 2,
          targetError: 'E_JSON_DISABLED',
        })}\n`,
      }
    }
    if (command === 'remove') {
      if (args.includes('--json')) {
        observations.envPresentAtRemove = world.files.has(bundleEnv)
        world.files.delete(statePath)
        world.files.delete(bundleEnv)
        return { code: 0, stdout: `${JSON.stringify({ profile: 'web', profileRemoved: true, serviceRemoved: true, dataPurged: true })}\n` }
      }
      // The cleanup re-run after a successful removal is refused; cleanup tolerates it.
      return { code: 1, stderr: `${JSON.stringify({ code: 'E_REMOVE_BLOCKED', message: 'The selected profile does not own a managed service', action: '' })}\n` }
    }
  }
  return undefined
  }
  return { respond, observations }
}

const preflightResult = (): PreflightResult => ({
  platform: 'test-platform',
  node: 'v22.11.0',
  docker: '27.3.1',
  compose: '2.29.7',
  packageVersion: '0.2.1',
  tarball: tarballPath,
  tarballSha256: sha256,
})

const runJourney = async (world: FakeWorld) => runCertification({
  preflight: preflightResult(),
  spawner: world.spawner,
  fileSystem: world.fileSystem,
  makeTempDir: async () => tempRoot,
  resolveNpm: () => ({ file: 'node', args: ['/npm-cli.js'] }),
  node: 'node',
  baseEnv: { PATH: '/usr/bin' },
  sleep: async () => {},
  now: () => 1_000_000,
})

describe('parseCertifyArgs', () => {
  it('requires an explicit tarball path', () => {
    expect(() => parseCertifyArgs([])).toThrow(CertificationError)
    expect(() => parseCertifyArgs(['--tarball'])).toThrow(CertificationError)
    expect(() => parseCertifyArgs(['--tarball', '--json'])).toThrow(CertificationError)
    expect(() => parseCertifyArgs(['--tarball='])).toThrow(CertificationError)
    expect(() => parseCertifyArgs(['--tarball', '/a.tgz', '--tarball', '/b.tgz'])).toThrow(CertificationError)
    expect(() => parseCertifyArgs(['/a.tgz'])).toThrow(CertificationError)
    expect(() => parseCertifyArgs(['--tarball', '/a.tgz', '--verbose'])).toThrow(CertificationError)
  })

  it('accepts the flag and equals forms', () => {
    expect(parseCertifyArgs(['--tarball', '/a.tgz'])).toEqual({ tarball: '/a.tgz' })
    expect(parseCertifyArgs(['--tarball=/a.tgz'])).toEqual({ tarball: '/a.tgz' })
  })
})

describe('certifyHomeId', () => {
  it('derives the same home id as the CLI ownership identity', () => {
    for (const path of ['/tmp/dsh-home', '/tmp/../tmp/dsh-home', 'relative/dsh-home']) {
      expect(certifyHomeId(path)).toBe(homeId(path))
    }
  })
})

describe('redactText', () => {
  it('masks secret-looking assignments and keeps ordinary output', () => {
    expect(redactText('server:\n  secret_key: abc123\n  limiter: false\n'))
      .toBe('server:\n  secret_key: [REDACTED]\n  limiter: false\n')
    expect(redactText('everything healthy')).toBe('everything healthy')
  })
})

describe('preflightCertification', () => {
  const baseInput = (world: FakeWorld) => ({
    tarball: tarballPath,
    spawner: world.spawner,
    pathExists: async () => true,
    sha256File: async () => sha256,
    nodeVersion: 'v22.11.0',
    platform: 'test-platform',
  })

  it('records the observed dsh, Docker, Compose, Node, and tarball identity', async () => {
    const world = new FakeWorld(happyJourneyOfflineShell)
    const result = await preflightCertification(baseInput(world))
    expect(result).toEqual({
      platform: 'test-platform',
      node: 'v22.11.0',
      docker: '27.3.1',
      compose: '2.29.7',
      packageVersion: '0.2.1',
      tarball: tarballPath,
      tarballSha256: sha256,
    })
  })

  it('refuses to start unless dsh, Docker, Compose v2, Node, and the tarball are present', async () => {
    const refuse = async (respond: Respond, overrides: Partial<Parameters<typeof preflightCertification>[0]> = {}) => {
      const world = new FakeWorld(respond)
      try {
        await preflightCertification({ ...baseInput(world), ...overrides })
        throw new Error('expected preflight to refuse')
      } catch (error) {
        expect(error).toBeInstanceOf(CertificationError)
        return (error as CertificationError).code
      }
    }
    const missingDsh: Respond = (file) => (file === 'dsh' ? { code: 127, stderr: 'not found', spawnFailed: true } : happyJourneyOfflineShell(file, []))
    const brokenDsh: Respond = (file) => (file === 'dsh' ? { code: 1, stderr: 'crash' } : undefined)
    const missingDocker: Respond = (file) => (file === 'docker' ? { code: 127, stderr: 'not found', spawnFailed: true } : undefined)
    const offlineDocker: Respond = (file, args) => (file === 'docker' && args[0] === 'version' ? { code: 1, stderr: 'cannot connect' } : happyJourneyOfflineShell(file, args))
    const composeV1: Respond = (file, args) => (file === 'docker' && args[0] === 'compose' ? { code: 0, stdout: '1.29.2\n' } : happyJourneyOfflineShell(file, args))
    const missingCompose: Respond = (file, args) => (file === 'docker' && args[0] === 'compose' ? { code: 127, stderr: 'not found', spawnFailed: true } : happyJourneyOfflineShell(file, args))

    expect(await refuse(missingDsh)).toBe('E_DSH_MISSING')
    expect(await refuse(brokenDsh)).toBe('E_DSH_MISSING')
    expect(await refuse(missingDocker)).toBe('E_DOCKER_MISSING')
    expect(await refuse(offlineDocker)).toBe('E_DOCKER_OFFLINE')
    expect(await refuse(composeV1)).toBe('E_COMPOSE_UNSUPPORTED')
    expect(await refuse(missingCompose)).toBe('E_COMPOSE_UNSUPPORTED')
    expect(await refuse(happyJourneyOfflineShell, { nodeVersion: 'v18.20.0' })).toBe('E_NODE_UNSUPPORTED')
    expect(await refuse(happyJourneyOfflineShell, { pathExists: async () => false })).toBe('E_TARBALL_MISSING')
  })
})

/** dsh/docker happy shell without delegating to the full journey responder. */
function happyJourneyOfflineShell(file: string, args: readonly string[]): Partial<CertifyProcessResult> | undefined {
  if (file === 'dsh') return { code: 0, stdout: 'dsh 1.2.3\n' }
  if (file === 'docker' && args[0] === 'version') return { code: 0, stdout: '27.3.1\n' }
  if (file === 'docker' && args[0] === 'compose') return { code: 0, stdout: '2.29.7\n' }
  return undefined
}

describe('runCertification', () => {
  it('walks the full lifecycle on an isolated DSH_HOME with profile web and reports every check passing', async () => {
    const journey = createHappyJourney()
    const world = new FakeWorld(journey.respond)
    seedInstalledPackage(world)
    const { report, exitCode } = await runJourney(world)

    expect(exitCode).toBe(0)
    expect(report.schemaVersion).toBe(1)
    expect(report.packageVersion).toBe('0.9.9')
    expect(report.platform).toBe('test-platform')
    expect(report.node).toBe('v22.11.0')
    expect(report.docker).toBe('27.3.1')
    expect(report.compose).toBe('2.29.7')
    expect(report.tarballSha256).toBe(sha256)
    expect(report.profile).toBe('web')
    expect(report.diagnostics).toBeUndefined()
    for (const name of CERTIFY_CHECKS) expect(report.checks[name]).toBe('pass')
    expect(report.checks.cleanup).toBe('pass')

    // The isolated home lives under the temporary root, never the user home.
    expect(dshHome.startsWith(tempRoot)).toBe(true)

    // Every CLI command ran against the isolated DSH_HOME with profile web.
    const cliCalls = world.calls.filter((call) => call.file === 'node' && call.args[0]?.endsWith('cli.mjs'))
    expect(cliCalls.length).toBeGreaterThan(0)
    for (const call of cliCalls) {
      expect(call.env?.DSH_HOME).toBe(dshHome)
      expect(call.args).toContain('--profile')
      expect(call.args[call.args.indexOf('--profile') + 1]).toBe('web')
    }

    // The tarball was installed without lifecycle scripts into the temp project.
    const install = world.calls.find((call) => call.file === 'node' && call.args[0] === '/npm-cli.js')
    expect(install?.args.slice(1)).toEqual([
      'install', '--prefix', installRoot, '--cache', join(tempRoot, 'npm-cache'),
      '--ignore-scripts', '--no-audit', '--no-fund', tarballPath,
    ])

    // The owned container was captured and restarted by id.
    expect(world.calls.some((call) => call.file === 'docker' && call.args[0] === 'restart' && call.args[1] === 'cid-1')).toBe(true)

    // The repair failure was injected and rebuilt: the .env still existed
    // when the final remove ran, proving repair restored it.
    expect(journey.observations.envPresentAtRemove).toBe(true)

    // The synthetic catalog entry and fault template live only in the temp install.
    const injectedCatalog = JSON.parse(world.files.get(catalogPath) ?? '{}')
    expect(injectedCatalog.deployments.map((entry: { deploymentVersion: number }) => entry.deploymentVersion)).toEqual([1, 2])
    const faultTemplate = world.files.get(join(packageRoot, 'assets', 'docker', 'settings.cert-fault.yml.template'))
    expect(faultTemplate).toBeDefined()
    expect(faultTemplate).not.toContain('- json')
    expect(world.calls.some((call) => call.file === 'node' && call.args[1] === 'update' && call.args.includes('--deployment-version') && call.args[call.args.indexOf('--deployment-version') + 1] === '2')).toBe(true)
    expect(report.notes.join('\n')).toContain('synthetic deployment version 2')

    // The final removal went through the CLI with purge confirmation.
    expect(world.calls.some((call) => call.file === 'node' && call.args[1] === 'remove' && call.args.includes('--purge-data') && call.args.includes('--yes'))).toBe(true)
    expect(world.files.has(statePath)).toBe(false)

    // Nothing needed a forced docker removal in the happy path.
    expect(world.calls.some((call) => call.file === 'docker' && call.args.includes('rm'))).toBe(false)
  })

  it('reports the failing check, skips the rest, still cleans up, and removes only resources carrying this home id', async () => {
    let sweepInjected = false
    const failingJourney: Respond = (file, args) => {
      if (file === 'node' && args[0]?.endsWith('cli.mjs') && args[1] === 'setup') {
        return { code: 1, stderr: `${JSON.stringify({ code: 'E_DOCKER_OFFLINE', message: 'The Docker daemon is unavailable', action: 'Start Docker' })}\n` }
      }
      if (file === 'docker' && args[0] === 'container' && args[1] === 'ls') {
        if (!sweepInjected && args.includes(`label=io.dsh-searxng.home-id=${identity}`)) {
          sweepInjected = true
          return { code: 0, stdout: 'owned9\nforeign123\n' }
        }
        return { code: 0, stdout: '' }
      }
      if (file === 'docker' && args[0] === 'container' && args[1] === 'inspect') {
        const id = args[2]
        const labels = {
          'io.dsh-searxng.managed': 'true',
          'io.dsh-searxng.home-id': id === 'foreign123' ? 'ffffffffffffffff' : identity,
        }
        return { code: 0, stdout: JSON.stringify([{ Config: { Labels: labels } }]) }
      }
      if ((file === 'docker' && (args[0] === 'network' || args[0] === 'volume') && args[1] === 'ls')) return { code: 0, stdout: '' }
      return createHappyJourney().respond(file, args, new FakeWorld(() => undefined))
    }

    const world = new FakeWorld(failingJourney)
    seedInstalledPackage(world)
    const { report, exitCode } = await runJourney(world)

    expect(exitCode).toBe(1)
    expect(report.checks.setup).toBe('fail')
    for (const name of CERTIFY_CHECKS.filter((name) => name !== 'setup')) expect(report.checks[name]).toBe('skip')
    expect(report.checks.cleanup).toBe('pass')
    expect(report.diagnostics?.message).toContain('setup did not complete')
    expect(report.diagnostics?.stderr).toContain('E_DOCKER_OFFLINE')

    // Cleanup still ran the ownership-checked removal through the CLI...
    expect(world.calls.some((call) => call.file === 'node' && call.args[1] === 'remove' && call.args.includes('--service') && call.args.includes('--yes'))).toBe(true)
    // ...removed the owned leftover by force...
    expect(world.calls.some((call) => call.file === 'docker' && call.args[0] === 'container' && call.args[1] === 'rm' && call.args.includes('owned9'))).toBe(true)
    // ...and never removed the resource that does not carry this home id.
    const removals = world.calls.filter((call) => call.file === 'docker' && call.args.includes('rm'))
    expect(removals.length).toBeGreaterThan(0)
    expect(removals.every((call) => !call.args.includes('foreign123'))).toBe(true)
  })
})
