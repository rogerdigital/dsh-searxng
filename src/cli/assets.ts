import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
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

interface AssetFileSystem {
  chmod: typeof chmod
  mkdir: typeof mkdir
  open: typeof open
  readFile: typeof readFile
  rename: typeof rename
  rm: typeof rm
}

const realFileSystem: AssetFileSystem = { chmod, mkdir, open, readFile, rename, rm }

export interface FileAssetRendererOptions {
  assetRoot?: URL
  fileSystem?: Partial<AssetFileSystem>
}

function invalidAssets(message: string): CliError {
  return new CliError('E_INTERNAL', message, 'Reinstall dsh-searxng and retry')
}

function invalidInput(message: string): CliError {
  return new CliError('E_USAGE', message, 'Use a valid managed deployment configuration')
}

function isEnvironmentValue(value: string): boolean {
  return value.length > 0 && !/[\r\n\0]/.test(value)
}

function validateInput(input: Parameters<AssetRenderer['render']>[0]): void {
  if (resolve(input.stateDir) !== resolve(input.identity.stateDir)) throw invalidInput('State directory does not match managed identity')
  if (resolve(dirname(input.identity.composePath)) !== resolve(input.stateDir)) throw invalidInput('Compose file must be inside the state directory')
  if (!/^[a-f0-9]{16}$/.test(input.identity.homeId)) throw invalidInput('Managed home identity is invalid')
  if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535) throw invalidInput('Port must be between 1 and 65535')
  if (!isEnvironmentValue(input.image)) throw invalidInput('Image reference is invalid')
  if (!isEnvironmentValue(input.identity.projectName)) throw invalidInput('Compose project name is invalid')
  if (!isEnvironmentValue(input.identity.containerName)) throw invalidInput('Container name is invalid')
  if (input.secret.length === 0 || input.secret.includes('\0')) throw invalidInput('SearXNG secret is invalid')
}

function renderSettings(template: string, secret: string): string {
  let parsed: unknown
  try {
    parsed = parse(template)
  } catch {
    throw invalidAssets('Packaged SearXNG settings are invalid')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidAssets('Packaged SearXNG settings are invalid')
  const settings = parsed as Record<string, unknown>
  const server = settings.server
  if (server === null || typeof server !== 'object' || Array.isArray(server)) throw invalidAssets('Packaged SearXNG settings are invalid')

  const rendered = {
    ...settings,
    server: { ...(server as Record<string, unknown>), secret_key: secret },
  }
  return stringify(rendered)
}

function renderEnvironment(input: Parameters<AssetRenderer['render']>[0]): string {
  return [
    `DSH_SEARXNG_IMAGE=${input.image}`,
    `DSH_SEARXNG_PORT=${input.port}`,
    `DSH_SEARXNG_HOME_ID=${input.identity.homeId}`,
    `DSH_SEARXNG_PROJECT=${input.identity.projectName}`,
    `DSH_SEARXNG_CONTAINER=${input.identity.containerName}`,
    'DSH_SEARXNG_DEPLOYMENT_VERSION=1',
    '',
  ].join('\n')
}

function configurationHash(environment: string, compose: string, settings: string): string {
  return createHash('sha256')
    .update('environment\0').update(environment)
    .update('compose\0').update(compose)
    .update('settings\0').update(settings)
    .digest('hex')
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
    const environment = renderEnvironment(input)
    const settingsDirectory = join(input.stateDir, 'searxng')
    await this.ensurePrivateDirectory(input.stateDir)
    await this.ensurePrivateDirectory(settingsDirectory)

    await this.atomicWrite(join(input.stateDir, '.env'), environment)
    await this.atomicWrite(input.identity.composePath, compose)
    await this.atomicWrite(join(settingsDirectory, 'settings.yml'), settings)

    return {
      composePath: input.identity.composePath,
      configurationSha256: configurationHash(environment, compose, settings),
    }
  }

  private async ensurePrivateDirectory(path: string): Promise<void> {
    await this.fs.mkdir(path, { recursive: true, mode: 0o700 })
    await this.fs.chmod(path, 0o700)
  }

  private async atomicWrite(path: string, contents: string): Promise<void> {
    const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
    let handle: FileHandle | undefined
    try {
      handle = await this.fs.open(temporaryPath, 'wx', 0o600)
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await this.fs.chmod(temporaryPath, 0o600)
      await this.fs.rename(temporaryPath, path)
      await this.fs.chmod(path, 0o600)
    } catch (error) {
      if (handle !== undefined) {
        try { await handle.close() } catch {}
      }
      try { await this.fs.rm(temporaryPath, { force: true }) } catch {}
      throw error
    }
  }
}
