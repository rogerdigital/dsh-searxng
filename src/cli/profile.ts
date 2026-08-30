import * as fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  isMap,
  isSeq,
  parseDocument,
  type Document,
  type Node,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml'
import { CliError } from './errors.ts'
import { assertValidProfile, profileDir, resolveDshHome } from './environment.ts'
import type { CommandRunner } from './process.ts'

const DEFAULT_PROFILE = 'web'
const PLUGIN_NAME = 'dsh-searxng'
const TARGET_ID = 'web-search-searxng'
const MANAGED_MARKER = 'dsh-searxng managed attachment'

export interface ProfileManager {
  inspect(profile: string): Promise<{ installed: boolean; patchPath: string }>
  attach(profile: string, endpoint: string, validate: () => Promise<void>): Promise<void>
  detach(profile: string): Promise<void>
}

export interface ProfileFileSystem {
  readFile: typeof fs.readFile
  lstat: typeof fs.lstat
  mkdir: typeof fs.mkdir
  open: typeof fs.open
  rename: typeof fs.rename
  unlink: typeof fs.unlink
}

export interface NodeProfileManagerOptions {
  commandRunner: CommandRunner
  dshHome?: string
  resolveDshHome?: () => string
  resolveProfileDirectory?: (profile: string) => string
  fileSystem?: ProfileFileSystem
  randomId?: () => string
  platform?: NodeJS.Platform
  dshCommand?: string
}

const nodeFileSystem: ProfileFileSystem = {
  readFile: fs.readFile,
  lstat: fs.lstat,
  mkdir: fs.mkdir,
  open: fs.open,
  rename: fs.rename,
  unlink: fs.unlink,
}

type FailureStage = 'install' | 'write' | 'validation' | 'detach'

class OperationFailure extends Error {
  readonly stage: FailureStage
  constructor(stage: FailureStage) {
    super(stage)
    this.stage = stage
  }
}

interface PatchSnapshot {
  readonly exists: boolean
  readonly bytes?: Buffer
}

interface ParsedPatch {
  readonly document: Document<Node, true>
  readonly sequence: YAMLSeq<Node>
}

function ioCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function profileWriteError(
  message = 'Unable to update the DSH profile',
  details: Record<string, unknown> = {},
): CliError {
  return new CliError(
    'E_PROFILE_WRITE',
    message,
    'Check the DSH profile and retry',
    details,
  )
}

function resolvedProfileName(profile: string): string {
  const name = profile || DEFAULT_PROFILE
  return assertValidProfile(name)
}

function normalizeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) throw new Error('unsafe')
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    return url.toString().replace(/\/$/, '')
  } catch {
    throw profileWriteError('The SearXNG endpoint is invalid')
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function installedFromManifest(value: unknown): boolean {
  if (!isPlainRecord(value)) throw profileWriteError('The DSH profile manifest is invalid')

  let dependencyInstalled = false
  if (value.dependencies !== undefined) {
    if (!isPlainRecord(value.dependencies)) throw profileWriteError('The DSH profile manifest is invalid')
    for (const version of Object.values(value.dependencies)) {
      if (typeof version !== 'string') throw profileWriteError('The DSH profile manifest is invalid')
    }
    dependencyInstalled = Object.hasOwn(value.dependencies, PLUGIN_NAME)
  }

  let bundleInstalled = false
  if (value.dsh !== undefined) {
    if (!isPlainRecord(value.dsh)) throw profileWriteError('The DSH profile manifest is invalid')
    if (value.dsh.profile !== undefined) {
      if (!isPlainRecord(value.dsh.profile)) throw profileWriteError('The DSH profile manifest is invalid')
      if (value.dsh.profile.bundles !== undefined) {
        if (!Array.isArray(value.dsh.profile.bundles) || value.dsh.profile.bundles.some((item) => typeof item !== 'string')) {
          throw profileWriteError('The DSH profile manifest is invalid')
        }
        bundleInstalled = value.dsh.profile.bundles.includes(PLUGIN_NAME)
      }
    }
  }
  return dependencyInstalled || bundleInstalled
}

function hasManagedMarker(node: YAMLMap<unknown, unknown>): boolean {
  return (node.commentBefore ?? '')
    .split('\n')
    .some((line) => line.trim() === MANAGED_MARKER)
}

function isTargetPatch(node: Node): node is YAMLMap<unknown, unknown> {
  return isMap(node) && node.get('id') === TARGET_ID
}

function isManagedPatch(node: Node): node is YAMLMap<unknown, unknown> {
  return isTargetPatch(node) && hasManagedMarker(node)
}

function parsePatch(bytes: Buffer): ParsedPatch {
  let document: Document<Node, true>
  try {
    document = parseDocument(bytes.toString('utf8')) as Document<Node, true>
  } catch {
    throw profileWriteError('The DSH profile patch is invalid')
  }
  if (document.errors.length > 0 || !isSeq(document.contents)) {
    throw profileWriteError('The DSH profile patch must be a YAML sequence')
  }
  return { document, sequence: document.contents as YAMLSeq<Node> }
}

function configOf(
  document: Document<Node, true>,
  patch: YAMLMap<unknown, unknown>,
): YAMLMap<unknown, unknown> {
  const config = patch.get('config', true)
  if (config === undefined) return document.createNode({}) as YAMLMap<unknown, unknown>
  if (!isMap(config)) throw profileWriteError('The target DSH profile config is invalid')
  return config.clone() as YAMLMap<unknown, unknown>
}

function renderAttachment(parsed: ParsedPatch, endpoint: string): Buffer {
  const { document, sequence } = parsed
  let lastEffectiveConfig: YAMLMap<unknown, unknown> | undefined
  const retained: Node[] = []

  for (const item of sequence.items) {
    if (isTargetPatch(item)) lastEffectiveConfig = configOf(document, item)
    if (isManagedPatch(item)) {
      continue
    }
    retained.push(item)
  }

  const config = lastEffectiveConfig ?? document.createNode({}) as YAMLMap<unknown, unknown>
  config.set('baseURL', endpoint)
  const managed = document.createNode({ id: TARGET_ID }) as YAMLMap<unknown, unknown>
  if (!isMap(managed)) throw profileWriteError()
  managed.set('config', config)
  managed.commentBefore = ` ${MANAGED_MARKER}`
  sequence.items = [...retained, managed]
  return Buffer.from(document.toString())
}

function renderDetachment(parsed: ParsedPatch): Buffer | undefined {
  const retained = parsed.sequence.items.filter((item) => !isManagedPatch(item))
  if (retained.length === parsed.sequence.items.length) return undefined
  parsed.sequence.items = retained
  return Buffer.from(parsed.document.toString())
}

export class NodeProfileManager implements ProfileManager {
  private readonly commandRunner: CommandRunner
  private readonly resolveProfileDirectory: (profile: string) => string
  private readonly fileSystem: ProfileFileSystem
  private readonly randomId: () => string
  private readonly platform: NodeJS.Platform
  private readonly dshCommand: string

  constructor(options: NodeProfileManagerOptions) {
    this.commandRunner = options.commandRunner
    const homeResolver = options.resolveDshHome ?? (() => options.dshHome ?? resolveDshHome())
    this.resolveProfileDirectory = options.resolveProfileDirectory
      ?? ((profile) => profileDir(homeResolver(), profile))
    this.fileSystem = options.fileSystem ?? nodeFileSystem
    this.randomId = options.randomId ?? (() => `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    this.platform = options.platform ?? process.platform
    this.dshCommand = options.dshCommand ?? 'dsh'
  }

  async inspect(profile: string): Promise<{ installed: boolean; patchPath: string }> {
    const name = resolvedProfileName(profile)
    const dir = this.resolveProfileDirectory(name)
    const patchPath = join(dir, 'cordis.patch.yml')
    const installed = await this.readInstalled(join(dir, 'package.json'))
    return { installed, patchPath }
  }

  async attach(profile: string, endpoint: string, validate: () => Promise<void>): Promise<void> {
    const name = resolvedProfileName(profile)
    const normalizedEndpoint = normalizeEndpoint(endpoint)
    const dir = this.resolveProfileDirectory(name)
    const packagePath = join(dir, 'package.json')
    const patchPath = join(dir, 'cordis.patch.yml')
    const installed = await this.readInstalled(packagePath)
    const snapshot = await this.readPatchSnapshot(patchPath)
    const parsed = parsePatch(snapshot.bytes ?? Buffer.from('[]\n'))
    const output = renderAttachment(parsed, normalizedEndpoint)
    let pluginAdded = false
    let patchMayHaveChanged = false
    let failureStage: FailureStage = 'install'

    try {
      if (!installed) {
        failureStage = 'install'
        await this.runPlugin(name, 'add')
        pluginAdded = true
      }
      failureStage = 'write'
      patchMayHaveChanged = true
      await this.writeAtomic(patchPath, output)
      failureStage = 'validation'
      await validate()
    } catch {
      const rollbackFailures: string[] = []
      if (patchMayHaveChanged) {
        try { await this.restoreSnapshot(patchPath, snapshot) } catch { rollbackFailures.push('patch') }
      }
      if (pluginAdded) {
        try { await this.runPlugin(name, 'remove') } catch { rollbackFailures.push('plugin') }
      }
      throw profileWriteError(
        'Unable to attach SearXNG to the DSH profile',
        { primaryFailure: failureStage, rollbackFailures },
      )
    }
  }

  async detach(profile: string): Promise<void> {
    const name = resolvedProfileName(profile)
    const dir = this.resolveProfileDirectory(name)
    const patchPath = join(dir, 'cordis.patch.yml')
    const snapshot = await this.readPatchSnapshot(patchPath)
    if (!snapshot.exists || snapshot.bytes === undefined) return
    const output = renderDetachment(parsePatch(snapshot.bytes))
    if (output === undefined) return
    try {
      await this.writeAtomic(patchPath, output)
    } catch {
      try {
        await this.restoreSnapshot(patchPath, snapshot)
      } catch {
        throw profileWriteError(
          'Unable to detach SearXNG from the DSH profile',
          { primaryFailure: 'detach', rollbackFailures: ['patch'] },
        )
      }
      throw profileWriteError(
        'Unable to detach SearXNG from the DSH profile',
        { primaryFailure: 'detach', rollbackFailures: [] },
      )
    }
  }

  private async readInstalled(packagePath: string): Promise<boolean> {
    try {
      const info = await this.fileSystem.lstat(packagePath)
      if (info.isSymbolicLink()) throw profileWriteError('The DSH profile manifest is unsafe')
      const source = await this.fileSystem.readFile(packagePath)
      let value: unknown
      try { value = JSON.parse(source.toString()) } catch { throw profileWriteError('The DSH profile manifest is invalid') }
      return installedFromManifest(value)
    } catch (error) {
      if (ioCode(error) === 'ENOENT') return false
      if (error instanceof CliError) throw error
      throw profileWriteError('Unable to read the DSH profile manifest')
    }
  }

  private async readPatchSnapshot(patchPath: string): Promise<PatchSnapshot> {
    try {
      const info = await this.fileSystem.lstat(patchPath)
      if (info.isSymbolicLink()) throw profileWriteError('The DSH profile patch is unsafe')
      return { exists: true, bytes: Buffer.from(await this.fileSystem.readFile(patchPath)) }
    } catch (error) {
      if (ioCode(error) === 'ENOENT') return { exists: false }
      if (error instanceof CliError) throw error
      throw profileWriteError('Unable to read the DSH profile patch')
    }
  }

  private async runPlugin(profile: string, operation: 'add' | 'remove'): Promise<void> {
    let result
    try {
      result = await this.commandRunner.run(this.dshCommand, [
        'plugin', '--profile', profile, operation, PLUGIN_NAME,
      ])
    } catch {
      throw new OperationFailure(operation === 'add' ? 'install' : 'write')
    }
    if (result.exitCode !== 0) throw new OperationFailure(operation === 'add' ? 'install' : 'write')
  }

  private async restoreSnapshot(patchPath: string, snapshot: PatchSnapshot): Promise<void> {
    if (snapshot.exists && snapshot.bytes !== undefined) {
      await this.writeAtomic(patchPath, snapshot.bytes)
      return
    }
    try { await this.fileSystem.unlink(patchPath) } catch (error) {
      if (ioCode(error) !== 'ENOENT') throw error
    }
    await this.syncDirectory(dirname(patchPath))
  }

  private async writeAtomic(path: string, bytes: Buffer): Promise<void> {
    const directory = dirname(path)
    await this.fileSystem.mkdir(directory, { recursive: true, mode: 0o700 })
    const temporaryPath = `${path}.tmp-${this.randomId()}`
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      handle = await this.fileSystem.open(temporaryPath, 'wx', 0o600)
      await handle.writeFile(bytes)
      await handle.chmod(0o600)
      await handle.sync()
      await handle.close()
      handle = undefined
      await this.fileSystem.rename(temporaryPath, path)
      await this.syncDirectory(directory)
    } catch (error) {
      if (handle !== undefined) {
        try { await handle.close() } catch {}
      }
      try { await this.fileSystem.unlink(temporaryPath) } catch {}
      throw error
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    if (this.platform === 'win32') return
    const handle = await this.fileSystem.open(directory, 'r')
    try { await handle.sync() } finally { await handle.close() }
  }
}
