import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

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
})
