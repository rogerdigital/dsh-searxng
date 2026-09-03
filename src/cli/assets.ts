import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parse, stringify } from 'yaml'
import { CliError } from './errors.ts'
import { isDigestPinnedImage, isSafeAssetPath, type DeploymentDefinition } from './deployments.ts'

export const SEARXNG_IMAGE =
  'ghcr.io/searxng/searxng:2026.8.20-8d3dd0cd4@sha256:e7bb47bebf338c52c55c7bed92293873cfe757b554b261829c0d710fd8307fa3'

const DEFAULT_ASSET_ROOT = new URL('../assets/docker/', import.meta.url)

export interface ManagedIdentity {
  stateDir: string
  composePath: string
  homeId: string
  projectName: string
  containerName: string
}

export interface AssetRenderer {
  render(input: {
    stateDir: string
    identity: ManagedIdentity
    image: string
    port: number
    secret: string
    /** Deployment version stamped into the environment; the create path defaults to 1. */
    deploymentVersion?: number
  }): Promise<{ composePath: string; configurationSha256: string }>
}

/** A rendered, published, content-addressed target bundle ready for activation. */
export interface StagedAssets {
  directory: string
  configurationSha256: string
  definition: DeploymentDefinition
}

export interface StageInput {
  stateDir: string
  identity: ManagedIdentity
  port: number
  secret: string
  definition: DeploymentDefinition
}

/**
 * Renderer that can additionally stage a catalog deployment: publishing a new
 * bundle for the target version without touching the active one. Activation
 * (pointing the Compose runtime at the staged bundle) is transaction
 * orchestration over Docker, not a filesystem concern.
 */
export interface StagingAssetRenderer extends AssetRenderer {
  stage(input: StageInput): Promise<StagedAssets>
}

export interface AssetFileSystem {
  chmod: typeof chmod
  lstat: typeof lstat
  mkdir: typeof mkdir
  open: typeof open
  readFile: typeof readFile
  rename: typeof rename
  rm: typeof rm
}

const realFileSystem: AssetFileSystem = { chmod, lstat, mkdir, open, readFile, rename, rm }

export interface FileAssetRendererOptions {
  assetRoot?: URL
  /** Root that deployment-catalog asset paths (docker/...) resolve against. */
  catalogAssetRoot?: URL
  fileSystem?: Partial<AssetFileSystem>
}

interface BundleContents {
  environment: string
  compose: string
  settings: string
}

function invalidAssets(message: string): CliError {
  return new CliError('E_INTERNAL', message, 'Reinstall dsh-searxng and retry')
}

function invalidInput(message: string): CliError {
  return new CliError('E_USAGE', message, 'Use a valid managed deployment configuration')
}

function invalidBundle(message: string, bundleName?: string): CliError {
  // Dedicated damage signal: the existing content-addressed bundle directory
  // is present but mismatched, incomplete, or unsafe. Consumers (repair,
  // update) key deterministic rebuild decisions on exactly this code, so it
  // must not be reused for unrelated invalid-state failures. `bundleName` is
  // the digest-only directory name (never a path) so consumers can locate
  // the damaged bundle for a bounded rebuild.
  return new CliError(
    'E_BUNDLE_DAMAGED',
    message,
    'Remove the damaged managed configuration bundle and retry',
    bundleName === undefined ? {} : { bundle: bundleName },
  )
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function isEnvironmentValue(value: string): boolean {
  return value.length > 0 && !/[\r\n\0]/.test(value)
}

function isContained(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child))
  return path.length > 0 && !path.startsWith('..') && !isAbsolute(path)
}

function validateInput(input: Parameters<AssetRenderer['render']>[0]): void {
  if (resolve(input.stateDir) !== resolve(input.identity.stateDir)) throw invalidInput('State directory does not match managed identity')
  if (!isContained(input.stateDir, input.identity.composePath)) throw invalidInput('Compose file must be inside the state directory')
  if (!/^[a-f0-9]{16}$/.test(input.identity.homeId)) throw invalidInput('Managed home identity is invalid')
  if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535) throw invalidInput('Port must be between 1 and 65535')
  if (!isEnvironmentValue(input.image)) throw invalidInput('Image reference is invalid')
  if (!isEnvironmentValue(input.identity.projectName)) throw invalidInput('Compose project name is invalid')
  if (!isEnvironmentValue(input.identity.containerName)) throw invalidInput('Container name is invalid')
  if (input.secret.length === 0 || input.secret.includes('\0')) throw invalidInput('SearXNG secret is invalid')
}

function renderSettings(template: string, secret: string): string {
  let parsed: unknown
  try { parsed = parse(template) } catch { throw invalidAssets('Packaged SearXNG settings are invalid') }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidAssets('Packaged SearXNG settings are invalid')
  const settings = parsed as Record<string, unknown>
  const server = settings.server
  if (server === null || typeof server !== 'object' || Array.isArray(server)) throw invalidAssets('Packaged SearXNG settings are invalid')
  return stringify({ ...settings, server: { ...(server as Record<string, unknown>), secret_key: secret } })
}

function baseEnvironment(input: {
  image: string
  port: number
  identity: ManagedIdentity
  deploymentVersion: number
}): string {
  return [
    `DSH_SEARXNG_IMAGE=${input.image}`,
    `DSH_SEARXNG_PORT=${input.port}`,
    `DSH_SEARXNG_HOME_ID=${input.identity.homeId}`,
    `DSH_SEARXNG_PROJECT=${input.identity.projectName}`,
    `DSH_SEARXNG_CONTAINER=${input.identity.containerName}`,
    `DSH_SEARXNG_NETWORK=${input.identity.projectName}-network`,
    `DSH_SEARXNG_CACHE_VOLUME=${input.identity.projectName}-cache`,
    `DSH_SEARXNG_DEPLOYMENT_VERSION=${input.deploymentVersion}`,
  ].join('\n')
}

function configurationHash(environment: string, compose: string, settings: string): string {
  return createHash('sha256')
    .update('environment\0').update(environment)
    .update('compose\0').update(compose)
    .update('settings\0').update(settings)
    .digest('hex')
}

function finalEnvironment(base: string, bundleName: string): string {
  return `${base}\nDSH_SEARXNG_SETTINGS_DIR=./${bundleName}/searxng\n`
}

export class FileAssetRenderer implements AssetRenderer {
  private readonly assetRoot: URL
  private readonly catalogAssetRoot: URL
  private readonly fs: AssetFileSystem

  constructor(options: FileAssetRendererOptions = {}) {
    this.assetRoot = options.assetRoot ?? DEFAULT_ASSET_ROOT
    // Catalog asset paths are relative to the packaged assets root (assets/),
    // the same root the deployment catalog validates against — the renderer's
    // own root is the docker subdirectory that render()'s fixed names use.
    this.catalogAssetRoot = options.catalogAssetRoot ?? new URL('..', DEFAULT_ASSET_ROOT)
    this.fs = { ...realFileSystem, ...options.fileSystem }
  }

  async render(input: Parameters<AssetRenderer['render']>[0]): Promise<{ composePath: string; configurationSha256: string }> {
    validateInput(input)
    const [compose, template] = await this.readAssets('compose.yml', 'settings.yml.template')
    return this.publishBundle({
      stateDir: input.stateDir,
      identity: input.identity,
      image: input.image,
      port: input.port,
      secret: input.secret,
      deploymentVersion: input.deploymentVersion ?? 1,
      compose,
      template,
    })
  }

  async stage(input: StageInput): Promise<StagedAssets> {
    const definition = input.definition
    if (
      !Number.isSafeInteger(definition.deploymentVersion) || definition.deploymentVersion < 1 ||
      typeof definition.image !== 'string' || !isEnvironmentValue(definition.image) ||
      !isDigestPinnedImage(definition.image) ||
      !isSafeAssetPath(definition.composeAsset) || !isSafeAssetPath(definition.settingsAsset)
    ) {
      throw invalidInput('Deployment definition is invalid')
    }
    validateInput({
      stateDir: input.stateDir,
      identity: input.identity,
      image: definition.image,
      port: input.port,
      secret: input.secret,
    })
    const [compose, template] = await this.readAssets(definition.composeAsset, definition.settingsAsset, this.catalogAssetRoot)
    const published = await this.publishBundle({
      stateDir: input.stateDir,
      identity: input.identity,
      image: definition.image,
      port: input.port,
      secret: input.secret,
      deploymentVersion: definition.deploymentVersion,
      compose,
      template,
    })
    return {
      directory: dirname(published.composePath),
      configurationSha256: published.configurationSha256,
      definition,
    }
  }

  private async readAssets(composePath: string, settingsPath: string, root: URL = this.assetRoot): Promise<[string, string]> {
    try {
      return await Promise.all([
        this.fs.readFile(new URL(composePath, root), 'utf8'),
        this.fs.readFile(new URL(settingsPath, root), 'utf8'),
      ])
    } catch {
      throw invalidAssets('Packaged Docker assets are unavailable')
    }
  }

  /**
   * Shared content-addressed publish pipeline: render, stage in a private
   * sibling temporary directory, fsync, atomically rename into place, and
   * verify any pre-existing same-digest bundle. The active bundle is never
   * edited in place; each generation gets its own immutable directory.
   */
  private async publishBundle(input: {
    stateDir: string
    identity: ManagedIdentity
    image: string
    port: number
    secret: string
    deploymentVersion: number
    compose: string
    template: string
  }): Promise<{ composePath: string; configurationSha256: string }> {
    const settings = renderSettings(input.template, input.secret)
    const environmentBase = baseEnvironment(input)
    const configurationSha256 = configurationHash(environmentBase, input.compose, settings)
    const bundleName = `config-${configurationSha256}`
    const bundleDir = join(input.stateDir, bundleName)
    const composePath = join(bundleDir, 'compose.yml')
    const contents: BundleContents = {
      environment: finalEnvironment(environmentBase, bundleName),
      compose: input.compose,
      settings,
    }

    await this.ensurePrivateDirectory(input.stateDir)
    if (await this.verifyExistingBundle(bundleDir, contents)) return { composePath, configurationSha256 }

    const stagingDir = join(input.stateDir, `.staging-${process.pid}-${randomBytes(8).toString('hex')}`)
    let published = false
    try {
      await this.fs.mkdir(stagingDir, { mode: 0o700 })
      await this.fs.chmod(stagingDir, 0o700)
      const settingsDir = join(stagingDir, 'searxng')
      await this.fs.mkdir(settingsDir, { mode: 0o700 })
      await this.fs.chmod(settingsDir, 0o700)

      await this.writePrivateFile(join(stagingDir, '.env'), contents.environment)
      await this.writePrivateFile(join(stagingDir, 'compose.yml'), contents.compose)
      await this.writePrivateFile(join(settingsDir, 'settings.yml'), contents.settings)
      await this.syncDirectory(settingsDir)
      await this.syncDirectory(stagingDir)

      try {
        await this.fs.rename(stagingDir, bundleDir)
      } catch (error) {
        if (errorCode(error) === 'EEXIST' || errorCode(error) === 'ENOTEMPTY') {
          await this.fs.rm(stagingDir, { recursive: true, force: true })
          if (await this.verifyExistingBundle(bundleDir, contents)) return { composePath, configurationSha256 }
        }
        throw error
      }
      published = true
      try {
        await this.syncDirectory(input.stateDir)
      } catch (error) {
        await this.withdrawUnconfirmedBundle(bundleDir, stagingDir)
        published = false
        throw error
      }
      return { composePath, configurationSha256 }
    } catch (error) {
      if (!published) {
        try { await this.fs.rm(stagingDir, { recursive: true, force: true }) } catch {}
      }
      throw error
    }
  }

  private async ensurePrivateDirectory(path: string): Promise<void> {
    await this.fs.mkdir(path, { recursive: true, mode: 0o700 })
    await this.fs.chmod(path, 0o700)
  }

  private async writePrivateFile(path: string, contents: string): Promise<void> {
    let handle: FileHandle | undefined
    try {
      handle = await this.fs.open(path, 'wx', 0o600)
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await this.fs.chmod(path, 0o600)
    } catch (error) {
      if (handle !== undefined) {
        try { await handle.close() } catch {}
      }
      throw error
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    if (process.platform === 'win32') return
    const handle = await this.fs.open(path, 'r')
    try { await handle.sync() } finally { await handle.close() }
  }

  private async verifyExistingBundle(bundleDir: string, contents: BundleContents): Promise<boolean> {
    const bundleName = basename(bundleDir)
    let bundleStats
    try { bundleStats = await this.fs.lstat(bundleDir) } catch (error) {
      if (errorCode(error) === 'ENOENT') return false
      throw error
    }
    if (bundleStats.isSymbolicLink() || !bundleStats.isDirectory()) throw invalidBundle('Managed configuration bundle is not a directory', bundleName)

    const expected = [
      [join(bundleDir, '.env'), contents.environment],
      [join(bundleDir, 'compose.yml'), contents.compose],
      [join(bundleDir, 'searxng', 'settings.yml'), contents.settings],
    ] as const
    try {
      const settingsStats = await this.fs.lstat(join(bundleDir, 'searxng'))
      if (settingsStats.isSymbolicLink() || !settingsStats.isDirectory()) throw invalidBundle('Managed configuration settings path is invalid', bundleName)
      if (process.platform !== 'win32' && ((bundleStats.mode & 0o777) !== 0o700 || (settingsStats.mode & 0o777) !== 0o700)) {
        throw invalidBundle('Managed configuration directory permissions are invalid', bundleName)
      }
      for (const [path, content] of expected) {
        const actual = await this.readVerifiedFile(path, bundleName)
        if (actual !== content) {
          throw invalidBundle('Managed configuration bundle does not match its identity', bundleName)
        }
      }
    } catch (error) {
      if (error instanceof CliError) throw error
      throw invalidBundle('Managed configuration bundle is incomplete', bundleName)
    }
    return true
  }

  private async readVerifiedFile(path: string, bundleName: string): Promise<string> {
    const pathStats = await this.fs.lstat(path)
    if (
      pathStats.isSymbolicLink() ||
      !pathStats.isFile() ||
      pathStats.nlink !== 1 ||
      (process.platform !== 'win32' && (pathStats.mode & 0o777) !== 0o600)
    ) throw invalidBundle('Managed configuration file type or permissions are invalid', bundleName)

    const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0
    const handle = await this.fs.open(path, constants.O_RDONLY | noFollow)
    try {
      const openedStats = await handle.stat()
      if (
        !openedStats.isFile() ||
        openedStats.nlink !== 1 ||
        openedStats.dev !== pathStats.dev ||
        openedStats.ino !== pathStats.ino
      ) throw invalidBundle('Managed configuration file changed during validation', bundleName)
      return await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  }

  private async withdrawUnconfirmedBundle(bundleDir: string, stagingDir: string): Promise<void> {
    try {
      await this.fs.rename(bundleDir, stagingDir)
      await this.fs.rm(stagingDir, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError([cleanupError], 'Configuration publish was not durable and recovery was incomplete')
    }
  }
}
