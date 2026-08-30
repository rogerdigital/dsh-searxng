import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parse, stringify } from 'yaml'
import { CliError } from './errors.ts'

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
  }): Promise<{ composePath: string; configurationSha256: string }>
}

export interface AssetFileSystem {
  chmod: typeof chmod
  mkdir: typeof mkdir
  open: typeof open
  readFile: typeof readFile
  rename: typeof rename
  rm: typeof rm
  stat: typeof stat
}

const realFileSystem: AssetFileSystem = { chmod, mkdir, open, readFile, rename, rm, stat }

export interface FileAssetRendererOptions {
  assetRoot?: URL
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

function invalidBundle(message: string): CliError {
  return new CliError('E_STATE_INVALID', message, 'Remove the damaged managed configuration bundle and retry')
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

function baseEnvironment(input: Parameters<AssetRenderer['render']>[0]): string {
  return [
    `DSH_SEARXNG_IMAGE=${input.image}`,
    `DSH_SEARXNG_PORT=${input.port}`,
    `DSH_SEARXNG_HOME_ID=${input.identity.homeId}`,
    `DSH_SEARXNG_PROJECT=${input.identity.projectName}`,
    `DSH_SEARXNG_CONTAINER=${input.identity.containerName}`,
    'DSH_SEARXNG_DEPLOYMENT_VERSION=1',
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
  private readonly fs: AssetFileSystem

  constructor(options: FileAssetRendererOptions = {}) {
    this.assetRoot = options.assetRoot ?? DEFAULT_ASSET_ROOT
    this.fs = { ...realFileSystem, ...options.fileSystem }
  }

  async render(input: Parameters<AssetRenderer['render']>[0]): Promise<{ composePath: string; configurationSha256: string }> {
    validateInput(input)
    let compose: string
    let template: string
    try {
      ;[compose, template] = await Promise.all([
        this.fs.readFile(new URL('compose.yml', this.assetRoot), 'utf8'),
        this.fs.readFile(new URL('settings.yml.template', this.assetRoot), 'utf8'),
      ])
    } catch {
      throw invalidAssets('Packaged Docker assets are unavailable')
    }

    const settings = renderSettings(template, input.secret)
    const environmentBase = baseEnvironment(input)
    const configurationSha256 = configurationHash(environmentBase, compose, settings)
    const bundleName = `config-${configurationSha256}`
    const bundleDir = join(input.stateDir, bundleName)
    const composePath = join(bundleDir, 'compose.yml')
    const contents: BundleContents = {
      environment: finalEnvironment(environmentBase, bundleName),
      compose,
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
    let bundleStats
    try { bundleStats = await this.fs.stat(bundleDir) } catch (error) {
      if (errorCode(error) === 'ENOENT') return false
      throw error
    }
    if (!bundleStats.isDirectory()) throw invalidBundle('Managed configuration bundle is not a directory')

    const expected = [
      [join(bundleDir, '.env'), contents.environment],
      [join(bundleDir, 'compose.yml'), contents.compose],
      [join(bundleDir, 'searxng', 'settings.yml'), contents.settings],
    ] as const
    try {
      const settingsStats = await this.fs.stat(join(bundleDir, 'searxng'))
      if (!settingsStats.isDirectory()) throw invalidBundle('Managed configuration settings path is invalid')
      if (process.platform !== 'win32' && ((bundleStats.mode & 0o777) !== 0o700 || (settingsStats.mode & 0o777) !== 0o700)) {
        throw invalidBundle('Managed configuration directory permissions are invalid')
      }
      for (const [path, content] of expected) {
        const [actual, fileStats] = await Promise.all([this.fs.readFile(path, 'utf8'), this.fs.stat(path)])
        if (!fileStats.isFile() || actual !== content || (process.platform !== 'win32' && (fileStats.mode & 0o777) !== 0o600)) {
          throw invalidBundle('Managed configuration bundle does not match its identity')
        }
      }
    } catch (error) {
      if (error instanceof CliError) throw error
      throw invalidBundle('Managed configuration bundle is incomplete')
    }
    return true
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
