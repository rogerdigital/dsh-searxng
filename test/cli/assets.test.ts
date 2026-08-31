import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { FileAssetRenderer, SEARXNG_IMAGE, type ManagedIdentity } from '../../src/cli/assets.ts'

const compose = parseYaml(readFileSync(new URL('../../assets/docker/compose.yml', import.meta.url), 'utf8')) as Record<string, any>
const settings = parseYaml(readFileSync(new URL('../../assets/docker/settings.yml.template', import.meta.url), 'utf8')) as Record<string, any>
const labels = {
  'io.dsh-searxng.managed': 'true',
  'io.dsh-searxng.home-id': '${DSH_SEARXNG_HOME_ID}',
  'io.dsh-searxng.schema': '1',
  'io.dsh-searxng.deployment-version': '${DSH_SEARXNG_DEPLOYMENT_VERSION}',
}

describe('Docker assets', () => {
  it('defines one constrained, labeled service and owned resources', () => {
    expect(Object.keys(compose.services)).toEqual(['searxng'])
    const service = compose.services.searxng
    expect(service.ports).toEqual(['127.0.0.1:${DSH_SEARXNG_PORT}:8080'])
    expect(service.cap_drop).toEqual(['ALL'])
    expect(service.cap_add).toEqual(['CHOWN', 'DAC_OVERRIDE', 'SETGID', 'SETUID'])
    expect(service.security_opt).toEqual(['no-new-privileges:true'])
    expect(service.environment).toEqual({ FORCE_OWNERSHIP: 'false' })
    expect(service.volumes[0]).toEqual({
      type: 'bind',
      source: '${DSH_SEARXNG_SETTINGS_DIR}',
      target: '/etc/searxng',
    })
    expect(service.labels).toEqual(labels)
    expect(service.networks).toEqual(['dsh-searxng'])
    expect(compose.volumes['searxng-cache'].name).toBe('${DSH_SEARXNG_CACHE_VOLUME}')
    expect(compose.volumes['searxng-cache'].labels).toEqual(labels)
    expect(compose.networks['dsh-searxng'].name).toBe('${DSH_SEARXNG_NETWORK}')
    expect(compose.networks['dsh-searxng'].labels).toEqual(labels)
  })

  it('contains the required settings and exactly one secret token', () => {
    const template = readFileSync(new URL('../../assets/docker/settings.yml.template', import.meta.url), 'utf8')
    expect((template.match(/__DSH_SEARXNG_SECRET__/g) ?? [])).toHaveLength(1)
    expect(settings.use_default_settings).toBe(true)
    expect(settings.server.limiter).toBe(false)
    expect(settings.search.formats).toEqual(['html', 'json'])
  })

  it('renders parseable private files without placing the secret in the environment', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'dsh-searxng-assets-'))
    const identity: ManagedIdentity = {
      stateDir,
      composePath: join(stateDir, 'compose.yml'),
      homeId: '0123456789abcdef',
      projectName: 'dsh-searxng-0123456789abcdef',
      containerName: 'dsh-searxng-0123456789abcdef',
    }
    const renderer = new FileAssetRenderer({
      assetRoot: new URL('../../assets/docker/', import.meta.url),
    })

    const rendered = await renderer.render({ stateDir, identity, image: SEARXNG_IMAGE, port: 8123, secret: 'a:b#c' })

    expect(rendered.composePath).toBe(join(stateDir, `config-${rendered.configurationSha256}`, 'compose.yml'))
    expect(resolve(rendered.composePath).startsWith(`${resolve(stateDir)}${sep}`)).toBe(true)
    expect(rendered.configurationSha256).toMatch(/^[a-f0-9]{64}$/)
    const bundleDir = dirname(rendered.composePath)
    const generatedSettings = parseYaml(await readFile(join(bundleDir, 'searxng', 'settings.yml'), 'utf8')) as Record<string, any>
    expect(generatedSettings.server.secret_key).toBe('a:b#c')
    expect(generatedSettings.server.limiter).toBe(false)
    expect(generatedSettings.search.formats).toEqual(['html', 'json'])

    const generatedCompose = parseYaml(await readFile(rendered.composePath, 'utf8')) as Record<string, any>
    expect(generatedCompose.services.searxng.ports).toEqual(['127.0.0.1:${DSH_SEARXNG_PORT}:8080'])

    const environment = await readFile(join(bundleDir, '.env'), 'utf8')
    expect(environment).toContain(`DSH_SEARXNG_IMAGE=${SEARXNG_IMAGE}\n`)
    expect(environment).toContain('DSH_SEARXNG_PORT=8123\n')
    expect(environment).toContain('DSH_SEARXNG_HOME_ID=0123456789abcdef\n')
    expect(environment).toContain('DSH_SEARXNG_PROJECT=dsh-searxng-0123456789abcdef\n')
    expect(environment).toContain('DSH_SEARXNG_CONTAINER=dsh-searxng-0123456789abcdef\n')
    expect(environment).toContain('DSH_SEARXNG_NETWORK=dsh-searxng-0123456789abcdef-network\n')
    expect(environment).toContain('DSH_SEARXNG_CACHE_VOLUME=dsh-searxng-0123456789abcdef-cache\n')
    expect(environment).toContain('DSH_SEARXNG_DEPLOYMENT_VERSION=1\n')
    expect(environment).toContain(`DSH_SEARXNG_SETTINGS_DIR=./${basename(bundleDir)}/searxng\n`)
    expect(environment).not.toContain('a:b#c')
    const settingsSource = environment.match(/^DSH_SEARXNG_SETTINGS_DIR=(.+)$/m)?.[1]
    expect(resolve(stateDir, settingsSource!)).toBe(join(bundleDir, 'searxng'))

    if (process.platform !== 'win32') {
      expect((await stat(stateDir)).mode & 0o777).toBe(0o700)
      expect((await stat(bundleDir)).mode & 0o777).toBe(0o700)
      expect((await stat(join(bundleDir, 'searxng'))).mode & 0o777).toBe(0o700)
      for (const file of [join(bundleDir, '.env'), rendered.composePath, join(bundleDir, 'searxng', 'settings.yml')]) {
        expect((await stat(file)).mode & 0o777).toBe(0o600)
      }
    }
  })

  it('renders consistently on repetition and cleans temporary files', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'dsh-searxng-assets-repeat-'))
    const identity: ManagedIdentity = {
      stateDir,
      composePath: join(stateDir, 'compose.yml'),
      homeId: 'fedcba9876543210',
      projectName: 'dsh-searxng-fedcba9876543210',
      containerName: 'dsh-searxng-fedcba9876543210',
    }
    const renderer = new FileAssetRenderer({ assetRoot: new URL('../../assets/docker/', import.meta.url) })
    const input = { stateDir, identity, image: SEARXNG_IMAGE, port: 8080, secret: 'a:b#c' }

    const first = await renderer.render(input)
    const firstBundle = dirname(first.composePath)
    const firstFiles = await Promise.all([
      readFile(join(firstBundle, '.env'), 'utf8'),
      readFile(first.composePath, 'utf8'),
      readFile(join(firstBundle, 'searxng', 'settings.yml'), 'utf8'),
    ])
    const second = await renderer.render(input)
    const secondBundle = dirname(second.composePath)
    const secondFiles = await Promise.all([
      readFile(join(secondBundle, '.env'), 'utf8'),
      readFile(second.composePath, 'utf8'),
      readFile(join(secondBundle, 'searxng', 'settings.yml'), 'utf8'),
    ])

    expect(second).toEqual(first)
    expect(secondFiles).toEqual(firstFiles)
    expect((await readdir(stateDir)).filter((name) => name.startsWith('.staging-'))).toEqual([])
    expect((await readdir(stateDir)).filter((name) => name.startsWith('config-'))).toEqual([basename(firstBundle)])
  })

  it('refuses to reuse a damaged immutable bundle', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'dsh-searxng-assets-damaged-'))
    const identity: ManagedIdentity = {
      stateDir,
      composePath: join(stateDir, 'compose.yml'),
      homeId: '0123456789abcdef',
      projectName: 'dsh-searxng-0123456789abcdef',
      containerName: 'dsh-searxng-0123456789abcdef',
    }
    const renderer = new FileAssetRenderer({ assetRoot: new URL('../../assets/docker/', import.meta.url) })
    const input = { stateDir, identity, image: SEARXNG_IMAGE, port: 8080, secret: 'stable-secret' }
    const first = await renderer.render(input)
    await writeFile(join(dirname(first.composePath), 'searxng', 'settings.yml'), 'damaged\n', { mode: 0o600 })

    await expect(renderer.render(input)).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
    expect((await readdir(stateDir)).filter((name) => name.startsWith('.staging-'))).toEqual([])
  })

  it.skipIf(process.platform === 'win32').each([
    'bundle-directory',
    'settings-directory',
    'environment-file',
    'compose-file',
    'settings-file',
  ] as const)('refuses to follow a symlinked immutable %s', async (targetKind) => {
    const { stateDir, renderer, input, rendered } = await renderedFixture('symlink-secret')
    const bundleDir = dirname(rendered.composePath)
    let original: string
    let target: string
    let type: 'dir' | 'file'
    if (targetKind === 'bundle-directory') {
      original = bundleDir
      target = `${bundleDir}-target`
      type = 'dir'
    } else if (targetKind === 'settings-directory') {
      original = join(bundleDir, 'searxng')
      target = join(bundleDir, 'searxng-target')
      type = 'dir'
    } else if (targetKind === 'environment-file') {
      original = join(bundleDir, '.env')
      target = join(bundleDir, '.env-target')
      type = 'file'
    } else if (targetKind === 'compose-file') {
      original = rendered.composePath
      target = join(bundleDir, 'compose-target.yml')
      type = 'file'
    } else {
      original = join(bundleDir, 'searxng', 'settings.yml')
      target = join(bundleDir, 'searxng', 'settings-target.yml')
      type = 'file'
    }
    await rename(original, target)
    await symlink(target, original, type)

    const error = await renderer.render(input).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'E_STATE_INVALID' })
    const serialized = JSON.stringify((error as { toJSON(): unknown }).toJSON())
    expect(serialized).not.toContain('symlink-secret')
    expect(serialized).not.toContain(stateDir)
  })

  it.each(['bundle-file', 'settings-file', 'compose-directory'] as const)('rejects unexpected immutable bundle type %s', async (targetKind) => {
    const { renderer, input, rendered } = await renderedFixture('type-secret')
    const bundleDir = dirname(rendered.composePath)
    if (targetKind === 'bundle-file') {
      await rm(bundleDir, { recursive: true })
      await writeFile(bundleDir, 'not a directory', { mode: 0o600 })
    } else if (targetKind === 'settings-file') {
      await rm(join(bundleDir, 'searxng'), { recursive: true })
      await writeFile(join(bundleDir, 'searxng'), 'not a directory', { mode: 0o600 })
    } else {
      await rm(rendered.composePath)
      await mkdir(rendered.composePath, { mode: 0o700 })
    }
    await expect(renderer.render(input)).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
  })

  it.each([
    ['.env', 'writeFile'], ['.env', 'sync'], ['.env', 'close'],
    ['compose.yml', 'writeFile'], ['compose.yml', 'sync'], ['compose.yml', 'close'],
    ['searxng/settings.yml', 'writeFile'], ['searxng/settings.yml', 'sync'], ['searxng/settings.yml', 'close'],
  ] as const)('does not publish a mixed generation when %s %s fails', async (target, phase) => {
    const stateDir = await mkdtemp(join(tmpdir(), 'dsh-searxng-assets-failure-'))
    const identity: ManagedIdentity = {
      stateDir,
      composePath: join(stateDir, 'compose.yml'),
      homeId: '0123456789abcdef',
      projectName: 'dsh-searxng-0123456789abcdef',
      containerName: 'dsh-searxng-0123456789abcdef',
    }
    const base = new FileAssetRenderer({ assetRoot: new URL('../../assets/docker/', import.meta.url) })
    const prior = await base.render({ stateDir, identity, image: SEARXNG_IMAGE, port: 8080, secret: 'prior-secret' })
    const priorBytes = await readBundle(prior.composePath)
    const priorBundles = publishedBundles(stateDir)
    const failingOpen: typeof open = async (...args: Parameters<typeof open>) => {
      const handle = await open(...args)
      const file = String(args[0])
      if (!file.includes('.staging-') || !file.endsWith(target.replaceAll('/', sep))) return handle
      return new Proxy(handle, {
        get(current, property) {
          if (property === phase) {
            if (phase === 'close') return async () => { await current.close(); throw new Error('injected close failure') }
            return async () => { throw new Error(`injected ${phase} failure`) }
          }
          const value = Reflect.get(current, property, current) as unknown
          return typeof value === 'function' ? value.bind(current) : value
        },
      })
    }
    const renderer = new FileAssetRenderer({
      assetRoot: new URL('../../assets/docker/', import.meta.url),
      fileSystem: { open: failingOpen },
    })

    await expect(renderer.render({ stateDir, identity, image: SEARXNG_IMAGE, port: 8081, secret: 'next-secret' })).rejects.toThrow()
    expect(await publishedBundles(stateDir)).toEqual(await priorBundles)
    expect(await readBundle(prior.composePath)).toEqual(priorBytes)
    expect((await readdir(stateDir)).filter((name) => name.startsWith('.staging-'))).toEqual([])
  })

  it('does not publish when the staging rename fails', async () => {
    await expectPublishFailure('rename')
  })

  it.skipIf(process.platform === 'win32')('does not report or retain a new bundle when the parent directory fsync fails', async () => {
    await expectPublishFailure('parent-sync')
  })
})

async function readBundle(composePath: string): Promise<string[]> {
  const bundleDir = dirname(composePath)
  return Promise.all([
    readFile(join(bundleDir, '.env'), 'utf8'),
    readFile(composePath, 'utf8'),
    readFile(join(bundleDir, 'searxng', 'settings.yml'), 'utf8'),
  ])
}

async function renderedFixture(secret: string): Promise<{
  stateDir: string
  renderer: FileAssetRenderer
  input: { stateDir: string; identity: ManagedIdentity; image: string; port: number; secret: string }
  rendered: { composePath: string; configurationSha256: string }
}> {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-searxng-assets-verify-'))
  const identity: ManagedIdentity = {
    stateDir,
    composePath: join(stateDir, 'compose.yml'),
    homeId: '0123456789abcdef',
    projectName: 'dsh-searxng-0123456789abcdef',
    containerName: 'dsh-searxng-0123456789abcdef',
  }
  const renderer = new FileAssetRenderer({ assetRoot: new URL('../../assets/docker/', import.meta.url) })
  const input = { stateDir, identity, image: SEARXNG_IMAGE, port: 8080, secret }
  const rendered = await renderer.render(input)
  return { stateDir, renderer, input, rendered }
}

async function publishedBundles(stateDir: string): Promise<string[]> {
  return (await readdir(stateDir)).filter((name) => name.startsWith('config-')).sort()
}

async function expectPublishFailure(failure: 'rename' | 'parent-sync'): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), `dsh-searxng-assets-${failure}-`))
  const identity: ManagedIdentity = {
    stateDir,
    composePath: join(stateDir, 'compose.yml'),
    homeId: '0123456789abcdef',
    projectName: 'dsh-searxng-0123456789abcdef',
    containerName: 'dsh-searxng-0123456789abcdef',
  }
  const base = new FileAssetRenderer({ assetRoot: new URL('../../assets/docker/', import.meta.url) })
  const prior = await base.render({ stateDir, identity, image: SEARXNG_IMAGE, port: 8080, secret: 'prior-secret' })
  const priorBytes = await readBundle(prior.composePath)
  const priorBundles = await publishedBundles(stateDir)

  const failingRename: typeof rename = async (...args: Parameters<typeof rename>) => {
    if (failure === 'rename' && String(args[0]).includes('.staging-') && basename(String(args[1])).startsWith('config-')) {
      throw new Error('injected rename failure')
    }
    return rename(...args)
  }
  const failingOpen: typeof open = async (...args: Parameters<typeof open>) => {
    const handle = await open(...args)
    if (failure !== 'parent-sync' || resolve(String(args[0])) !== resolve(stateDir)) return handle
    return new Proxy(handle, {
      get(current, property) {
        if (property === 'sync') return async () => { throw new Error('injected parent sync failure') }
        const value = Reflect.get(current, property, current) as unknown
        return typeof value === 'function' ? value.bind(current) : value
      },
    })
  }
  const renderer = new FileAssetRenderer({
    assetRoot: new URL('../../assets/docker/', import.meta.url),
    fileSystem: { open: failingOpen, rename: failingRename },
  })
  await expect(renderer.render({ stateDir, identity, image: SEARXNG_IMAGE, port: 8081, secret: 'next-secret' })).rejects.toThrow()
  expect(await publishedBundles(stateDir)).toEqual(priorBundles)
  expect(await readBundle(prior.composePath)).toEqual(priorBytes)
  expect((await readdir(stateDir)).filter((name) => name.startsWith('.staging-'))).toEqual([])
}
