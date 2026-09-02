import { execFile } from 'node:child_process'
import { access, chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { homeId } from '../../src/cli/environment.ts'

const enabled = process.env.DSH_SEARXNG_E2E === '1'
const exec = promisify(execFile)
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const executableName = process.platform === 'win32' ? 'dsh-searxng.cmd' : 'dsh-searxng'

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') return reject(new Error('Unable to allocate port'))
      server.close((error) => error === undefined ? resolvePort(address.port) : reject(error))
    })
  })
}

async function dockerOwned(kind: 'container' | 'network' | 'volume', name: string, expectedHomeId: string): Promise<boolean> {
  try {
    const { stdout } = await exec('docker', [kind, 'inspect', name])
    const parsed = JSON.parse(stdout) as Array<{ Config?: { Labels?: Record<string, string> }; Labels?: Record<string, string> }>
    const labels = kind === 'container' ? parsed[0]?.Config?.Labels : parsed[0]?.Labels
    return labels?.['io.dsh-searxng.managed'] === 'true' && labels['io.dsh-searxng.home-id'] === expectedHomeId
  } catch { return false }
}

describe.skipIf(!enabled)('packed managed setup journey', () => {
  it('creates, reuses, diagnoses, restarts, repairs, rolls back an update, and removes only its owned deployment', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'dsh-searxng-e2e-'))
    const dshHome = join(temporary, 'dsh-home')
    const fakeBin = join(temporary, 'bin')
    const installDir = join(temporary, 'install')
    const packDir = join(temporary, 'pack')
    const expectedHomeId = homeId(dshHome)
    const project = `dsh-searxng-${expectedHomeId}`
    const network = `${project}-network`
    const volume = `${project}-cache`
    const port = await freePort()
    await Promise.all([mkdir(fakeBin), mkdir(installDir), mkdir(packDir)])
    const fakeDsh = join(fakeBin, 'dsh')
    await writeFile(fakeDsh, `#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('e2e'); process.exit(0) }
const profile = args[args.indexOf('--profile') + 1] || 'web'
const action = args.includes('add') ? 'add' : args.includes('remove') ? 'remove' : ''
if (!action) process.exit(2)
const dir = join(process.env.DSH_HOME, 'profiles', profile)
await mkdir(dir, { recursive: true })
const path = join(dir, 'package.json')
let manifest = { dependencies: {} }
try { manifest = JSON.parse(await readFile(path, 'utf8')) } catch {}
manifest.dependencies ||= {}
if (action === 'add') manifest.dependencies['dsh-searxng'] = '0.1.1'
else delete manifest.dependencies['dsh-searxng']
await writeFile(path, JSON.stringify(manifest) + '\\n')
`, { mode: 0o755 })
    await chmod(fakeDsh, 0o755)
    const environment = { ...process.env, DSH_HOME: dshHome, PATH: `${fakeBin}:${process.env.PATH ?? ''}` }
    let cli = ''

    try {
      await exec(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['pack', '--pack-destination', packDir], { cwd: root })
      const tarball = join(packDir, (await readdir(packDir)).find((file) => file.endsWith('.tgz'))!)
      await exec(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
        'install', '--prefix', installDir, '--cache', join(temporary, 'npm-cache'),
        '--ignore-scripts', '--no-audit', '--no-fund', tarball,
      ], { cwd: root })
      cli = join(installDir, 'node_modules', '.bin', executableName)

      await exec(cli, ['setup', '--profile', 'web', '--port', String(port)], { env: environment, timeout: 180_000 })
      const firstId = (await exec('docker', ['container', 'inspect', '--format', '{{.Id}}', project])).stdout.trim()
      const managedDir = join(dshHome, 'dsh-searxng')
      const firstBundles = (await readdir(managedDir)).filter((name) => name.startsWith('config-')).sort()
      expect(firstBundles).toHaveLength(1)
      const bundle = firstBundles[0]
      if (bundle === undefined) throw new Error('Managed configuration bundle is missing')
      const firstSettings = await readFile(join(managedDir, bundle, 'searxng', 'settings.yml'), 'utf8')
      const query = await fetch(`http://127.0.0.1:${port}/search?q=e2e&format=json`).then((response) => response.json()) as { results?: unknown[] }
      expect(query.results?.length).toBeGreaterThan(0)

      await exec(cli, ['setup', '--profile', 'web'], { env: environment, timeout: 180_000 })
      const secondId = (await exec('docker', ['container', 'inspect', '--format', '{{.Id}}', project])).stdout.trim()
      const secondBundles = (await readdir(managedDir)).filter((name) => name.startsWith('config-')).sort()
      expect(secondId).toBe(firstId)
      expect(secondBundles).toEqual(firstBundles)
      expect(await readFile(join(managedDir, bundle, 'searxng', 'settings.yml'), 'utf8')).toBe(firstSettings)
      expect(JSON.parse(await readFile(join(managedDir, 'state.json'), 'utf8'))).toMatchObject({ managed: { port } })

      await exec(cli, ['status', '--profile', 'web'], { env: environment, timeout: 60_000 })
      await exec(cli, ['doctor', '--profile', 'web'], { env: environment, timeout: 60_000 })
      await exec('docker', ['container', 'restart', project])
      await exec(cli, ['setup', '--profile', 'web'], { env: environment, timeout: 180_000 })
      await exec(cli, ['doctor', '--profile', 'web'], { env: environment, timeout: 60_000 })

      // Repair leg: injure the generated bundle by deleting its .env while
      // settings.yml (and therefore the secret) stays intact, then require
      // repair to rebuild it through the render-assets path.
      const digest = bundle.replace(/^config-/, '')
      const bundleEnv = join(managedDir, bundle, '.env')
      await rm(bundleEnv)
      const repair = JSON.parse((await exec(cli, ['repair', '--profile', 'web', '--json'], { env: environment, timeout: 180_000 })).stdout) as { actions?: Array<{ type?: string }> }
      expect(repair.actions?.map((action) => action.type)).toContain('render-assets')
      expect(JSON.parse(await readFile(join(managedDir, 'state.json'), 'utf8'))).toMatchObject({ managed: { current: { configurationSha256: digest } } })
      await exec(cli, ['doctor', '--profile', 'web'], { env: environment, timeout: 60_000 })

      // Update-rollback leg: the shipped catalog has one deployment version,
      // so a real update transaction needs a synthetic version 2 injected
      // into this test's installed copy only — same digest-pinned image, but
      // a settings template without the json search format. The update must
      // fail validation and roll back to the previous deployment.
      const packageRoot = join(installDir, 'node_modules', 'dsh-searxng')
      const catalogPath = join(packageRoot, 'assets', 'deployments', 'v1.json')
      const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as {
        deployments: Array<{ deploymentVersion: number; image: string; composeAsset: string; settingsAsset: string; stateSchemas: number[] }>
      }
      expect(catalog.deployments).toHaveLength(1)
      const current = catalog.deployments[0]
      if (current === undefined) throw new Error('Installed deployment catalog is empty')
      const template = await readFile(join(packageRoot, 'assets', current.settingsAsset), 'utf8')
      expect(template.match(/^[ \t]*-[ \t]*json[ \t]*$/gm)?.length ?? 0).toBe(1)
      const faultAsset = 'docker/settings.e2e-fault.yml.template'
      await writeFile(join(packageRoot, 'assets', faultAsset), template.replace(/^[ \t]*-[ \t]*json[ \t]*(?:\r?\n|$)/m, ''))
      await writeFile(catalogPath, `${JSON.stringify({
        ...catalog,
        deployments: [...catalog.deployments, {
          deploymentVersion: 2,
          image: current.image,
          composeAsset: current.composeAsset,
          settingsAsset: faultAsset,
          stateSchemas: [...current.stateSchemas],
        }],
      }, null, 2)}\n`)
      const updateFailure = await exec(cli, ['update', '--profile', 'web', '--deployment-version', '2', '--json'], { env: environment, timeout: 240_000 })
        .then(() => undefined, (error) => error)
      expect(updateFailure).toBeDefined()
      expect(updateFailure?.code).toBe(1)
      const envelope = JSON.parse(updateFailure?.stderr ?? '') as { code?: string; rolledBack?: boolean; targetVersion?: number }
      expect(envelope.code).toBe('E_JSON_DISABLED')
      expect(envelope.rolledBack).toBe(true)
      expect(envelope.targetVersion).toBe(2)
      await exec(cli, ['doctor', '--profile', 'web'], { env: environment, timeout: 60_000 })
      expect(JSON.parse(await readFile(join(managedDir, 'state.json'), 'utf8'))).toMatchObject({
        managed: { current: { deploymentVersion: 1, configurationSha256: digest } },
      })

      await exec(cli, ['remove', '--profile', 'web', '--service', '--purge-data', '--yes'], { env: environment, timeout: 60_000 })
      expect(await dockerOwned('container', project, expectedHomeId)).toBe(false)
      expect(await dockerOwned('network', network, expectedHomeId)).toBe(false)
      expect(await dockerOwned('volume', volume, expectedHomeId)).toBe(false)
      await expect(access(managedDir)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      for (const [kind, name] of [['container', project], ['network', network], ['volume', volume]] as const) {
        if (await dockerOwned(kind, name, expectedHomeId)) {
          const args = kind === 'container' ? ['container', 'rm', '--force', name] : [kind, 'rm', name]
          await exec('docker', args).catch(() => undefined)
        }
      }
      await rm(temporary, { recursive: true, force: true })
    }
  }, 480_000)
})
