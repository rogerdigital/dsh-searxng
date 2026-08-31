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
  it('creates, reuses, diagnoses, restarts, queries, and removes only its owned deployment', async () => {
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
  }, 300_000)
})
