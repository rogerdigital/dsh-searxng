import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SEARXNG_IMAGE } from '../../src/cli/assets.ts'
import { CliError } from '../../src/cli/errors.ts'
import {
  type DeploymentDefinition,
  loadDeploymentCatalog,
  selectDeployment,
} from '../../src/cli/deployments.ts'

const REPO_ASSET_ROOT = new URL('../../assets/', import.meta.url)
const CURRENT_STATE_SCHEMA = 2
const DIGEST = 'e7bb47bebf338c52c55c7bed92293873cfe757b554b261829c0d710fd8307fa3'

/** Fixture overrides are loosely typed so negative cases can carry invalid values. */
type DeploymentFixtureOverrides = { [K in keyof DeploymentDefinition]?: unknown }

function deploymentFixture(overrides: DeploymentFixtureOverrides = {}): DeploymentDefinition {
  return {
    deploymentVersion: 1,
    image: `ghcr.io/searxng/searxng:2026.8.20-8d3dd0cd4@sha256:${DIGEST}`,
    composeAsset: 'docker/compose.yml',
    settingsAsset: 'docker/settings.yml.template',
    stateSchemas: [1, 2],
    ...overrides as Partial<DeploymentDefinition>,
  }
}

function catalogFixture(deployments: readonly unknown[]): { schemaVersion: number; deployments: unknown[] } {
  return { schemaVersion: 1, deployments: [...deployments] }
}

/** Creates an asset root holding a catalog plus placeholder packaged assets. */
async function catalogRoot(catalog: unknown, options: { compose?: string; settings?: string } = {}): Promise<URL> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-searxng-catalog-'))
  await mkdir(join(root, 'deployments'), { recursive: true })
  await mkdir(join(root, 'docker'), { recursive: true })
  await writeFile(join(root, 'deployments', 'v1.json'), `${JSON.stringify(catalog)}\n`, 'utf8')
  await writeFile(join(root, 'docker', 'compose.yml'), options.compose ?? 'services: {}\n', 'utf8')
  await writeFile(join(root, 'docker', 'settings.yml.template'), options.settings ?? 'use_default_settings: true\n', 'utf8')
  return pathToFileURL(`${root}/`)
}

function catalogError(catalog: unknown, options?: { compose?: string; settings?: string }): Promise<CliError> {
  return catalogRoot(catalog, options).then((root) => {
    try {
      loadDeploymentCatalog(root)
    } catch (error) {
      return error as CliError
    }
    throw new Error('expected loadDeploymentCatalog to throw')
  })
}

const invalidCatalogs: ReadonlyArray<readonly [string, unknown]> = [
  ['future schema', { ...catalogFixture([deploymentFixture()]), schemaVersion: 2 }],
  ['missing schema field', { deployments: [deploymentFixture()] }],
  ['extra root field', { ...catalogFixture([deploymentFixture()]), note: 'extra' }],
  ['non-array deployments', { ...catalogFixture([deploymentFixture()]), deployments: {} }],
  ['empty deployments', catalogFixture([])],
  ['non-object deployment', catalogFixture(['deployment'])],
  ['extra deployment field', catalogFixture([{ ...deploymentFixture(), note: 'extra' }])],
  ['non-integer deployment version', catalogFixture([deploymentFixture({ deploymentVersion: 1.5 })])],
  ['non-positive deployment version', catalogFixture([deploymentFixture({ deploymentVersion: 0 })])],
  ['image without digest pin', catalogFixture([deploymentFixture({ image: 'ghcr.io/searxng/searxng:2026.8.20' })])],
  ['image with short digest', catalogFixture([deploymentFixture({ image: `ghcr.io/searxng/searxng@sha256:${'a'.repeat(63)}` })])],
  ['image with non-hex digest', catalogFixture([deploymentFixture({ image: `ghcr.io/searxng/searxng@sha256:${'g'.repeat(64)}` })])],
  ['duplicate deployment versions', catalogFixture([deploymentFixture(), deploymentFixture()])],
  ['non-increasing deployment versions', catalogFixture([
    deploymentFixture({ deploymentVersion: 2 }),
    deploymentFixture({ deploymentVersion: 1 }),
  ])],
  ['absolute compose path', catalogFixture([deploymentFixture({ composeAsset: '/etc/passwd' })])],
  ['parent traversal path', catalogFixture([deploymentFixture({ composeAsset: '../docker/compose.yml' })])],
  ['backslash path', catalogFixture([deploymentFixture({ settingsAsset: 'docker\\settings.yml.template' })])],
  ['windows drive path', catalogFixture([deploymentFixture({ composeAsset: 'C:/docker/compose.yml' })])],
  ['empty state schemas', catalogFixture([deploymentFixture({ stateSchemas: [] })])],
  ['duplicate state schemas', catalogFixture([deploymentFixture({ stateSchemas: [1, 1] })])],
  ['non-integer state schema', catalogFixture([deploymentFixture({ stateSchemas: [1, '2'] })])],
  ['missing compose asset', catalogFixture([deploymentFixture({ composeAsset: 'docker/absent.yml' })])],
  ['missing settings asset', catalogFixture([deploymentFixture({ settingsAsset: 'docker/absent.yml.template' })])],
]

describe('packaged deployment catalog', () => {
  it('loads deployment version 1 pinned to the renderer image and current state schema', () => {
    const catalog = loadDeploymentCatalog(REPO_ASSET_ROOT)
    expect(catalog).toHaveLength(1)
    const deployment = catalog[0]!
    expect(deployment.deploymentVersion).toBe(1)
    expect(deployment.image).toBe(SEARXNG_IMAGE)
    expect(deployment.composeAsset).toBe('docker/compose.yml')
    expect(deployment.settingsAsset).toBe('docker/settings.yml.template')
    expect(deployment.stateSchemas).toEqual([1, CURRENT_STATE_SCHEMA])
    expect(fileURLToPath(new URL(deployment.composeAsset, REPO_ASSET_ROOT))).toContain('assets/docker/compose.yml')
  })

  it('resolves the packaged asset root by default from source and installed layouts', () => {
    expect(loadDeploymentCatalog()).toEqual(loadDeploymentCatalog(REPO_ASSET_ROOT))
  })

  it('returns a deeply frozen catalog', () => {
    const catalog = loadDeploymentCatalog(REPO_ASSET_ROOT)
    expect(Object.isFrozen(catalog)).toBe(true)
    for (const deployment of catalog) {
      expect(Object.isFrozen(deployment)).toBe(true)
      expect(Object.isFrozen(deployment.stateSchemas)).toBe(true)
    }
  })

  it('selects the newest packaged deployment for the current state schema', () => {
    const deployment = selectDeployment(loadDeploymentCatalog(REPO_ASSET_ROOT), CURRENT_STATE_SCHEMA)
    expect(deployment.image).toBe(SEARXNG_IMAGE)
  })
})

describe('catalog validation', () => {
  it.each(invalidCatalogs)('rejects %s without touching Docker', async (_label, catalog) => {
    await expect(catalogError(catalog)).resolves.toMatchObject({ code: 'E_DEPLOYMENT_UNSUPPORTED' })
  })

  it('rejects a missing catalog as damaged packaging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-searxng-catalog-absent-'))
    expect(() => loadDeploymentCatalog(pathToFileURL(`${root}/`))).toThrowError(
      expect.objectContaining({ code: 'E_INTERNAL' }),
    )
  })

  it('rejects malformed catalog JSON as damaged packaging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-searxng-catalog-malformed-'))
    await mkdir(join(root, 'deployments'), { recursive: true })
    await writeFile(join(root, 'deployments', 'v1.json'), '{not json', 'utf8')
    expect(() => loadDeploymentCatalog(pathToFileURL(`${root}/`))).toThrowError(
      expect.objectContaining({ code: 'E_INTERNAL' }),
    )
  })

  it('accepts a minimal valid catalog referencing existing assets', async () => {
    const root = await catalogRoot(catalogFixture([deploymentFixture()]))
    const catalog = loadDeploymentCatalog(root)
    expect(catalog).toHaveLength(1)
    expect(catalog[0]).toMatchObject({ deploymentVersion: 1, stateSchemas: [1, 2] })
  })
})

describe('selectDeployment', () => {
  const catalog: readonly DeploymentDefinition[] = [
    deploymentFixture({ deploymentVersion: 1, stateSchemas: [1, 2] }),
    deploymentFixture({ deploymentVersion: 2, stateSchemas: [2] }),
    deploymentFixture({ deploymentVersion: 3, stateSchemas: [3] }),
  ]

  function selectionError(stateSchema: number, requestedVersion?: number): CliError {
    try {
      selectDeployment(catalog, stateSchema, requestedVersion)
    } catch (error) {
      return error as CliError
    }
    throw new Error('expected selectDeployment to throw')
  }

  it('requires an exact requested version', () => {
    expect(selectDeployment(catalog, 2, 2)).toMatchObject({ deploymentVersion: 2 })
    expect(selectDeployment(catalog, 2, 1)).toMatchObject({ deploymentVersion: 1 })
  })

  it('selects the newest deployment supporting the state schema', () => {
    expect(selectDeployment(catalog, 2)).toMatchObject({ deploymentVersion: 2 })
    expect(selectDeployment(catalog, 1)).toMatchObject({ deploymentVersion: 1 })
    expect(selectDeployment(catalog, 3)).toMatchObject({ deploymentVersion: 3 })
  })

  it('rejects an unknown requested version and lists the available ones', () => {
    const error = selectionError(2, 7)
    expect(error).toBeInstanceOf(CliError)
    expect(error.code).toBe('E_DEPLOYMENT_UNSUPPORTED')
    expect(error.message).toContain('7')
    expect(error.message).toContain('1, 2, 3')
    expect(error.details).toMatchObject({ requestedVersion: 7, availableVersions: [1, 2, 3] })
    expect(error.action.length).toBeGreaterThan(0)
  })

  it('rejects a requested deployment that does not support the state schema', () => {
    const error = selectionError(2, 3)
    expect(error).toMatchObject({ code: 'E_DEPLOYMENT_UNSUPPORTED' })
    expect(error.message).toContain('3')
    expect(error.message).toContain('2')
  })

  it('rejects a state schema no deployment supports', () => {
    const error = selectionError(4)
    expect(error).toMatchObject({ code: 'E_DEPLOYMENT_UNSUPPORTED' })
    expect(error.message).toContain('4')
  })
})
