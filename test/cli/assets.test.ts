import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    expect(service.cap_add).toEqual(['CHOWN', 'SETGID', 'SETUID'])
    expect(service.labels).toEqual(labels)
    expect(service.networks).toEqual(['dsh-searxng'])
    expect(compose.volumes['searxng-cache'].labels).toEqual(labels)
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

    expect(rendered.composePath).toBe(identity.composePath)
    expect(rendered.configurationSha256).toMatch(/^[a-f0-9]{64}$/)
    const generatedSettings = parseYaml(await readFile(join(stateDir, 'searxng', 'settings.yml'), 'utf8')) as Record<string, any>
    expect(generatedSettings.server.secret_key).toBe('a:b#c')
    expect(generatedSettings.server.limiter).toBe(false)
    expect(generatedSettings.search.formats).toEqual(['html', 'json'])

    const generatedCompose = parseYaml(await readFile(identity.composePath, 'utf8')) as Record<string, any>
    expect(generatedCompose.services.searxng.ports).toEqual(['127.0.0.1:${DSH_SEARXNG_PORT}:8080'])

    const environment = await readFile(join(stateDir, '.env'), 'utf8')
    expect(environment).toContain(`DSH_SEARXNG_IMAGE=${SEARXNG_IMAGE}\n`)
    expect(environment).toContain('DSH_SEARXNG_PORT=8123\n')
    expect(environment).toContain('DSH_SEARXNG_HOME_ID=0123456789abcdef\n')
    expect(environment).toContain('DSH_SEARXNG_PROJECT=dsh-searxng-0123456789abcdef\n')
    expect(environment).toContain('DSH_SEARXNG_CONTAINER=dsh-searxng-0123456789abcdef\n')
    expect(environment).toContain('DSH_SEARXNG_DEPLOYMENT_VERSION=1\n')
    expect(environment).not.toContain('a:b#c')

    expect((await stat(stateDir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(stateDir, 'searxng'))).mode & 0o777).toBe(0o700)
    for (const file of [join(stateDir, '.env'), identity.composePath, join(stateDir, 'searxng', 'settings.yml')]) {
      expect((await stat(file)).mode & 0o777).toBe(0o600)
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
    const firstFiles = await Promise.all([
      readFile(join(stateDir, '.env'), 'utf8'),
      readFile(identity.composePath, 'utf8'),
      readFile(join(stateDir, 'searxng', 'settings.yml'), 'utf8'),
    ])
    const second = await renderer.render(input)
    const secondFiles = await Promise.all([
      readFile(join(stateDir, '.env'), 'utf8'),
      readFile(identity.composePath, 'utf8'),
      readFile(join(stateDir, 'searxng', 'settings.yml'), 'utf8'),
    ])

    expect(second).toEqual(first)
    expect(secondFiles).toEqual(firstFiles)
    expect((await readdir(stateDir)).filter((name) => name.includes('.tmp-'))).toEqual([])
    expect((await readdir(join(stateDir, 'searxng'))).filter((name) => name.includes('.tmp-'))).toEqual([])
  })
})
