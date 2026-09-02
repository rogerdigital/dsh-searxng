/**
 * Versioned deployment catalog: the indirection between the CLI and the
 * packaged Docker assets it renders. `assets/deployments/v1.json` (catalog
 * schema 1) lists every deployment this CLI can install, each pinned to a
 * digest-verified SearXNG image and pointing at the packaged compose and
 * settings assets it renders.
 *
 * The latest published npm package is the only update channel: the CLI never
 * fetches a remote manifest and never downloads executable content. Loading
 * and selecting a deployment only reads files already inside the installed
 * package, so catalog failures never require — or trigger — Docker.
 */
import { readFileSync, statSync } from 'node:fs'
import { CliError } from './errors.ts'
import { exactKeys } from './state.ts'

/** Catalog schema understood by this CLI; newer schemas must fail loudly. */
const CATALOG_SCHEMA_VERSION = 1

/** Location of the catalog inside the asset root. */
const CATALOG_ASSET = 'deployments/v1.json'

/**
 * Resolve the asset root from the packed CLI first (lib/*.mjs sits directly
 * beside assets/) and from the source tree second (src/cli/ is two levels
 * deeper), so the default works in the published tarball and in development.
 */
const PACKED_ASSET_ROOT = new URL('../assets/', import.meta.url)
const ASSET_ROOT_CANDIDATES = [PACKED_ASSET_ROOT, new URL('../../assets/', import.meta.url)]

export interface DeploymentDefinition {
  readonly deploymentVersion: number
  readonly image: string
  readonly composeAsset: string
  readonly settingsAsset: string
  readonly stateSchemas: readonly number[]
}

const DIGEST_PINNED_IMAGE = /^[^\s@]+@sha256:[a-f0-9]{64}$/
const DEPLOYMENT_KEYS = ['composeAsset', 'deploymentVersion', 'image', 'settingsAsset', 'stateSchemas']

function deploymentUnsupported(message: string, action: string, details: Record<string, unknown> = {}): CliError {
  // Errors are E_DEPLOYMENT_UNSUPPORTED rather than E_STATE_INVALID: the state
  // is fine — the packaged catalog cannot satisfy the request. Only this code
  // means "catalog entry absent, malformed, or incompatible with the state".
  return new CliError('E_DEPLOYMENT_UNSUPPORTED', message, action, details)
}

function catalogDamaged(message: string): CliError {
  return new CliError('E_INTERNAL', message, 'Reinstall dsh-searxng and retry')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/** Relative POSIX-style path that cannot escape the asset root. */
function isSafeAssetPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.includes('\\') || value.includes(':') || value.startsWith('/') || value.includes('\0')) return false
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function defaultAssetRoot(): URL {
  for (const candidate of ASSET_ROOT_CANDIDATES) {
    try {
      if (statSync(new URL(CATALOG_ASSET, candidate)).isFile()) return candidate
    } catch {
      // This layout has no catalog; try the next candidate.
    }
  }
  return PACKED_ASSET_ROOT
}

function validateDeployment(value: unknown, index: number, assetRoot: URL): DeploymentDefinition {
  const where = `Deployment entry ${index}`
  if (!isRecord(value) || !exactKeys(value, DEPLOYMENT_KEYS)) {
    throw deploymentUnsupported(`${where} is malformed`, 'Reinstall dsh-searxng and retry')
  }
  const { deploymentVersion, image, composeAsset, settingsAsset, stateSchemas } = value
  if (!isPositiveInteger(deploymentVersion)) {
    throw deploymentUnsupported(`${where} has an invalid deployment version`, 'Reinstall dsh-searxng and retry')
  }
  if (typeof image !== 'string' || !DIGEST_PINNED_IMAGE.test(image)) {
    throw deploymentUnsupported(
      `Deployment version ${deploymentVersion} is not pinned to a sha256 image digest`,
      'Reinstall dsh-searxng and retry',
      { deploymentVersion, image },
    )
  }
  if (!isSafeAssetPath(composeAsset) || !isSafeAssetPath(settingsAsset)) {
    throw deploymentUnsupported(
      `Deployment version ${deploymentVersion} has an unsafe asset path`,
      'Reinstall dsh-searxng and retry',
      { deploymentVersion, composeAsset, settingsAsset },
    )
  }
  if (
    !Array.isArray(stateSchemas) ||
    stateSchemas.length === 0 ||
    !stateSchemas.every(isPositiveInteger) ||
    new Set(stateSchemas).size !== stateSchemas.length
  ) {
    throw deploymentUnsupported(
      `Deployment version ${deploymentVersion} has invalid state schemas`,
      'Reinstall dsh-searxng and retry',
      { deploymentVersion },
    )
  }
  for (const assetPath of [composeAsset, settingsAsset]) {
    let present = false
    try {
      present = statSync(new URL(assetPath, assetRoot)).isFile()
    } catch {
      present = false
    }
    if (!present) {
      throw deploymentUnsupported(
        `Deployment version ${deploymentVersion} references a missing packaged asset: ${assetPath}`,
        'Reinstall dsh-searxng and retry',
        { deploymentVersion, assetPath },
      )
    }
  }
  return Object.freeze({
    deploymentVersion,
    image,
    composeAsset,
    settingsAsset,
    stateSchemas: Object.freeze([...stateSchemas]),
  })
}

function validateCatalog(parsed: unknown, assetRoot: URL): readonly DeploymentDefinition[] {
  if (!isRecord(parsed) || !exactKeys(parsed, ['schemaVersion', 'deployments'])) {
    throw deploymentUnsupported('Deployment catalog is malformed', 'Reinstall dsh-searxng and retry')
  }
  if (parsed.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw deploymentUnsupported(
      `Deployment catalog schema ${String(parsed.schemaVersion)} is not supported`,
      'Upgrade dsh-searxng and retry',
      { schemaVersion: parsed.schemaVersion },
    )
  }
  if (!Array.isArray(parsed.deployments) || parsed.deployments.length === 0) {
    throw deploymentUnsupported('Deployment catalog lists no deployments', 'Reinstall dsh-searxng and retry')
  }
  const deployments: DeploymentDefinition[] = []
  let previousVersion = 0
  for (const [index, entry] of parsed.deployments.entries()) {
    const deployment = validateDeployment(entry, index, assetRoot)
    if (deployment.deploymentVersion <= previousVersion) {
      throw deploymentUnsupported(
        'Deployment catalog versions must be unique and increasing',
        'Reinstall dsh-searxng and retry',
        { deploymentVersion: deployment.deploymentVersion },
      )
    }
    previousVersion = deployment.deploymentVersion
    deployments.push(deployment)
  }
  return Object.freeze(deployments)
}

/**
 * Load and validate the packaged deployment catalog, returning frozen
 * definitions. The catalog and every asset it references must already exist
 * under `assetRoot` (the packaged `assets/` root by default); nothing is read
 * from the network and Docker is never contacted.
 */
export function loadDeploymentCatalog(assetRoot?: URL): readonly DeploymentDefinition[] {
  const root = assetRoot ?? defaultAssetRoot()
  let source: string
  try {
    source = readFileSync(new URL(CATALOG_ASSET, root), 'utf8')
  } catch {
    throw catalogDamaged('Packaged deployment catalog is unavailable')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw catalogDamaged('Packaged deployment catalog is malformed')
  }
  return validateCatalog(parsed, root)
}

/**
 * Pick a deployment from an already-validated catalog. With
 * `requestedVersion` an exact match is required and it must support
 * `stateSchema`; without it the newest deployment whose `stateSchemas`
 * include `stateSchema` is selected.
 */
export function selectDeployment(
  catalog: readonly DeploymentDefinition[],
  stateSchema: number,
  requestedVersion?: number,
): DeploymentDefinition {
  const availableVersions = catalog.map((deployment) => deployment.deploymentVersion)
  if (requestedVersion !== undefined) {
    const requested = catalog.find((deployment) => deployment.deploymentVersion === requestedVersion)
    if (requested === undefined) {
      throw deploymentUnsupported(
        `Deployment version ${String(requestedVersion)} is not available (available: ${availableVersions.join(', ')})`,
        'Choose an available deployment version',
        { requestedVersion, availableVersions },
      )
    }
    if (!requested.stateSchemas.includes(stateSchema)) {
      throw deploymentUnsupported(
        `Deployment version ${requested.deploymentVersion} does not support state schema ${String(stateSchema)}`,
        'Choose a deployment version that supports the current state',
        { requestedVersion, stateSchema, availableVersions },
      )
    }
    return requested
  }
  for (let index = catalog.length - 1; index >= 0; index -= 1) {
    const deployment = catalog[index]
    if (deployment !== undefined && deployment.stateSchemas.includes(stateSchema)) return deployment
  }
  throw deploymentUnsupported(
    `No packaged deployment supports state schema ${String(stateSchema)}`,
    'Upgrade dsh-searxng and retry',
    { stateSchema, availableVersions },
  )
}
