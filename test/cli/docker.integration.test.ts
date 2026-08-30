import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FileAssetRenderer, SEARXNG_IMAGE, type ManagedIdentity } from '../../src/cli/assets.ts'
import { CliDockerAdapter } from '../../src/cli/docker.ts'
import { NodeProcessRunner } from '../../src/cli/process.ts'

const enabled = process.platform === 'linux' && process.env.DSH_SEARXNG_DOCKER_INTEGRATION === '1'
const temporaryDirectories: string[] = []

describe.skipIf(!enabled)('managed SearXNG Docker integration', () => {
  afterAll(async () => {
    await Promise.all(temporaryDirectories.map(async (directory) => {
      try { await rm(directory, { recursive: true, force: true }) } catch {}
    }))
  })

  it('renders, starts, serves JSON, and removes only its owned resources', { timeout: 180_000 }, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'dsh-searxng-docker-integration-'))
    temporaryDirectories.push(stateDir)
    const homeId = randomBytes(8).toString('hex')
    const name = `dsh-searxng-${homeId}`
    const port = await availablePort()
    const initialIdentity: ManagedIdentity = {
      stateDir,
      composePath: join(stateDir, 'compose.yml'),
      homeId,
      projectName: name,
      containerName: name,
    }
    const renderer = new FileAssetRenderer({ assetRoot: new URL('../../assets/docker/', import.meta.url) })
    const rendered = await renderer.render({
      stateDir,
      identity: initialIdentity,
      image: SEARXNG_IMAGE,
      port,
      secret: randomBytes(32).toString('hex'),
    })
    const identity = { ...initialIdentity, composePath: rendered.composePath }
    const docker = new CliDockerAdapter(new NodeProcessRunner())

    await docker.preflight()
    try {
      await docker.up(identity)
      await waitForJson(`http://127.0.0.1:${port}/search?q=dsh-searxng-probe&format=json`)
    } finally {
      await docker.down(identity, true)
    }
    await expect(docker.inspectOwnership(identity)).resolves.toBe('absent')
  })
})

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to allocate a port')))
        return
      }
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function waitForJson(url: string): Promise<void> {
  const deadline = Date.now() + 120_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
      if (response.ok) {
        const body = await response.json() as { results?: unknown }
        if (Array.isArray(body.results)) return
      }
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error('SearXNG did not return JSON before the deadline', { cause: lastError })
}
