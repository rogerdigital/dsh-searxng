import { execFile } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const command = (name) => process.platform === 'win32' ? `${name}.cmd` : name

async function run(file, args, options = {}) {
  try {
    return await exec(file, args, {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === 'win32',
      ...options,
    })
  } catch (error) {
    const output = `${error?.stdout ?? ''}${error?.stderr ?? ''}`
    throw new Error(`Packed CLI check failed: ${file} ${args.join(' ')}\n${output}`)
  }
}

const temporary = await mkdtemp(join(tmpdir(), 'dsh-searxng-pack-'))
try {
  const packDirectory = join(temporary, 'pack')
  const installDirectory = join(temporary, 'install')
  await mkdir(packDirectory)
  await mkdir(installDirectory)
  await run(command('pnpm'), ['pack', '--pack-destination', packDirectory])
  const tarballs = (await readdir(packDirectory)).filter((file) => file.endsWith('.tgz'))
  if (tarballs.length !== 1) throw new Error(`Expected one tarball, found ${tarballs.length}`)
  const tarball = join(packDirectory, tarballs[0])
  await run(command('npm'), [
    'install', '--prefix', installDirectory, '--cache', join(temporary, 'npm-cache'),
    '--ignore-scripts', '--no-audit', '--no-fund', tarball,
  ])

  const packageRoot = join(installDirectory, 'node_modules', 'dsh-searxng')
  const executable = join(installDirectory, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh-searxng.cmd' : 'dsh-searxng')
  const cliSource = await readFile(join(packageRoot, 'lib', 'cli.mjs'), 'utf8')
  const forbidden = [
    ['dynamic evaluation', /\bnew Function\s*\(|\beval\s*\(/],
    ['Schemastery', /schemastery/i],
    ['DSH web provider runtime', /@deepseek-ai[+/]dsh-web/i],
    ['DSH launch environment runtime', /@deepseek-ai[+/]dsh-launch-environment/i],
    ['Cordis runtime', /@deepseek-ai[+/]cordis/i],
  ]
  for (const [label, pattern] of forbidden) {
    if (pattern.test(cliSource)) throw new Error(`Packed CLI unexpectedly contains ${label}`)
  }
  if (process.platform !== 'win32') await chmod(executable, 0o755)
  const { stdout } = await run(executable, ['--help'], { cwd: installDirectory })
  for (const commandName of ['setup', 'status', 'doctor', 'repair', 'update', 'remove']) {
    if (!stdout.includes(commandName)) throw new Error(`Packed CLI help is missing ${commandName}`)
  }
  await Promise.all([
    access(join(packageRoot, 'assets', 'docker', 'compose.yml')),
    access(join(packageRoot, 'assets', 'docker', 'settings.yml.template')),
  ])
  // The packed CLI resolves its deployment catalog from the installed layout;
  // locate the single versioned catalog file and verify it and every asset
  // it references. The filename is derived, not hardcoded, so a schema bump
  // that renames the catalog is still exercised.
  const deploymentsDir = join(packageRoot, 'assets', 'deployments')
  const catalogFiles = (await readdir(deploymentsDir)).filter((file) => /^v\d+\.json$/.test(file))
  if (catalogFiles.length !== 1) {
    throw new Error(`Expected exactly one deployment catalog, found ${catalogFiles.length}: ${catalogFiles.join(', ')}`)
  }
  const catalogFile = catalogFiles[0]
  const fileVersion = Number(catalogFile.replace(/^v/, '').replace(/\.json$/, ''))
  const catalog = JSON.parse(await readFile(join(deploymentsDir, catalogFile), 'utf8'))
  if (catalog.schemaVersion !== fileVersion) {
    throw new Error(`Packed catalog schema ${catalog.schemaVersion} does not match its file name v${fileVersion}`)
  }
  if (!Array.isArray(catalog.deployments) || catalog.deployments.length < 1) {
    throw new Error('Packed deployment catalog is invalid')
  }
  let previousVersion = 0
  for (const deployment of catalog.deployments) {
    if (!(deployment.deploymentVersion > previousVersion)) {
      throw new Error('Packed deployment versions must be unique and increasing')
    }
    previousVersion = deployment.deploymentVersion
    if (!/@sha256:[a-f0-9]{64}$/.test(deployment.image ?? '')) {
      throw new Error(`Packed deployment ${deployment.deploymentVersion} is not pinned to a sha256 image digest`)
    }
    await access(join(packageRoot, 'assets', deployment.composeAsset))
    await access(join(packageRoot, 'assets', deployment.settingsAsset))
  }
  process.stdout.write('Packed CLI, deployment catalog, and Docker assets verified\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
