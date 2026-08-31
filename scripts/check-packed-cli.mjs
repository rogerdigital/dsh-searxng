import { execFile } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
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
  if (process.platform !== 'win32') await chmod(executable, 0o755)
  const { stdout } = await run(executable, ['--help'], { cwd: installDirectory })
  for (const commandName of ['setup', 'status', 'doctor', 'remove']) {
    if (!stdout.includes(commandName)) throw new Error(`Packed CLI help is missing ${commandName}`)
  }
  await Promise.all([
    access(join(packageRoot, 'assets', 'docker', 'compose.yml')),
    access(join(packageRoot, 'assets', 'docker', 'settings.yml.template')),
  ])
  process.stdout.write('Packed CLI and Docker assets verified\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
