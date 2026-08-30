import * as fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  isMap,
  isNode,
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
  inspect(profile: string, signal?: AbortSignal): Promise<{ installed: boolean; patchPath: string }>
  attach(profile: string, endpoint: string, validate: () => Promise<void>, signal?: AbortSignal): Promise<void>
  detach(profile: string, signal?: AbortSignal): Promise<void>
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

class ProfileConflictError extends Error {
  constructor() {
    super('profile-conflict')
    this.name = 'ProfileConflictError'
  }
}

class CommittedWriteError extends Error {
  readonly committed: PatchSnapshot
  constructor(committed: PatchSnapshot) {
    super('committed-write-finalization-failed')
    this.name = 'CommittedWriteError'
    this.committed = committed
  }
}

interface FileIdentity {
  readonly device: number | bigint
  readonly inode: number | bigint
  readonly size: number | bigint
  readonly modifiedMs: number | bigint
  readonly changedMs: number | bigint
}

interface PatchSnapshot {
  readonly exists: boolean
  readonly bytes?: Buffer
  readonly identity?: FileIdentity
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

function cancellationFrom(error: unknown, signal?: AbortSignal): unknown | undefined {
  if (signal?.aborted) return signal.reason ?? error
  if (error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError') return error
  return undefined
}

function primaryErrorClass(error: unknown, stage: FailureStage, signal?: AbortSignal): string {
  if (cancellationFrom(error, signal) !== undefined) return 'abort'
  if (error instanceof CliError) return error.code
  if (error instanceof ProfileConflictError) return 'profile-conflict'
  if (error instanceof OperationFailure) return 'process'
  if (stage === 'install') return 'process'
  if (stage === 'write' || stage === 'detach') return 'filesystem'
  return 'unknown'
}

function fileIdentity(stat: Awaited<ReturnType<typeof fs.lstat>>): FileIdentity {
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedMs: stat.mtimeMs,
    changedMs: stat.ctimeMs,
  }
}

function sameIdentity(left?: FileIdentity, right?: FileIdentity): boolean {
  return left !== undefined && right !== undefined &&
    left.device === right.device && left.inode === right.inode && left.size === right.size &&
    left.modifiedMs === right.modifiedMs && left.changedMs === right.changedMs
}

function sameFileAcrossRename(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.size === right.size &&
    left.modifiedMs === right.modifiedMs
}

function sameSnapshot(left: PatchSnapshot, right: PatchSnapshot): boolean {
  if (left.exists !== right.exists) return false
  if (!left.exists) return true
  return left.bytes !== undefined && right.bytes !== undefined &&
    left.bytes.equals(right.bytes) && sameIdentity(left.identity, right.identity)
}

function sameBytes(snapshot: PatchSnapshot, bytes: Buffer): boolean {
  return snapshot.exists && snapshot.bytes !== undefined && snapshot.bytes.equals(bytes)
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

function containsAnchor(value: unknown): boolean {
  if (!isNode(value)) return false
  if ('anchor' in value && typeof value.anchor === 'string' && value.anchor.length > 0) return true
  if (isMap(value)) {
    return value.items.some((pair) => containsAnchor(pair.key) || containsAnchor(pair.value))
  }
  if (isSeq(value)) return value.items.some((item) => containsAnchor(item))
  return false
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

function serializePatch(document: Document<Node, true>): Buffer {
  try {
    const source = document.toString()
    const reparsed = parseDocument(source)
    if (reparsed.errors.length > 0 || !isSeq(reparsed.contents)) throw new Error('invalid serialization')
    reparsed.toJS({ maxAliasCount: 100 })
    return Buffer.from(source)
  } catch {
    throw profileWriteError('The DSH profile patch cannot be serialized safely')
  }
}

function renderAttachment(parsed: ParsedPatch, endpoint: string): Buffer {
  const { document, sequence } = parsed
  let lastEffectiveConfig: YAMLMap<unknown, unknown> | undefined
  const retained: Node[] = []

  for (const item of sequence.items) {
    if (isManagedPatch(item) && containsAnchor(item)) {
      throw profileWriteError('The managed DSH profile patch contains an unsafe YAML anchor')
    }
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
  return serializePatch(document)
}

function renderDetachment(parsed: ParsedPatch): Buffer | undefined {
  for (const item of parsed.sequence.items) {
    if (isManagedPatch(item) && containsAnchor(item)) {
      throw profileWriteError('The managed DSH profile patch contains an unsafe YAML anchor')
    }
  }
  const retained = parsed.sequence.items.filter((item) => !isManagedPatch(item))
  if (retained.length === parsed.sequence.items.length) return undefined
  parsed.sequence.items = retained
  return serializePatch(parsed.document)
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

  async inspect(profile: string, signal?: AbortSignal): Promise<{ installed: boolean; patchPath: string }> {
    signal?.throwIfAborted()
    const name = resolvedProfileName(profile)
    const dir = this.resolveProfileDirectory(name)
    const patchPath = join(dir, 'cordis.patch.yml')
    const installed = await this.readInstalled(join(dir, 'package.json'))
    signal?.throwIfAborted()
    return { installed, patchPath }
  }

  async attach(
    profile: string,
    endpoint: string,
    validate: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    const name = resolvedProfileName(profile)
    const normalizedEndpoint = normalizeEndpoint(endpoint)
    const dir = this.resolveProfileDirectory(name)
    const packagePath = join(dir, 'package.json')
    const patchPath = join(dir, 'cordis.patch.yml')
    const installedBefore = await this.readInstalled(packagePath)
    let original: PatchSnapshot
    try {
      original = await this.readPatchSnapshot(patchPath)
    } catch (error) {
      if (error instanceof ProfileConflictError) {
        throw profileWriteError(
          'The DSH profile changed while it was being read',
          { primaryFailure: 'write', primaryError: 'profile-conflict', rollbackFailures: [] },
        )
      }
      throw error
    }
    if (original.bytes !== undefined) {
      renderAttachment(parsePatch(original.bytes), normalizedEndpoint)
    }
    let pluginAdded = false
    let writeAttempted = false
    let rollbackExpected: PatchSnapshot | undefined
    let output: Buffer | undefined
    let failureStage: FailureStage = 'install'

    try {
      if (!installedBefore) {
        failureStage = 'install'
        await this.runPlugin(name, 'add', signal)
        pluginAdded = true
      }

      signal?.throwIfAborted()
      failureStage = 'write'
      const renderBase = await this.readPatchSnapshot(patchPath)
      rollbackExpected = renderBase
      output = renderAttachment(parsePatch(renderBase.bytes ?? Buffer.from('[]\n')), normalizedEndpoint)
      // Portable best-effort CAS: within the trusted profile directory, compare
      // bytes plus file identity immediately before the atomic rename.
      const beforeCommit = await this.readPatchSnapshot(patchPath)
      if (!sameSnapshot(renderBase, beforeCommit)) throw new ProfileConflictError()

      writeAttempted = true
      try {
        rollbackExpected = await this.writeAtomic(patchPath, output, renderBase)
      } catch (error) {
        if (error instanceof CommittedWriteError) rollbackExpected = error.committed
        throw error
      }

      failureStage = 'validation'
      await validate()
      signal?.throwIfAborted()
    } catch (primaryError) {
      const rollbackFailures: string[] = []
      let patchRollbackBlocked = false

      if (!installedBefore && !pluginAdded && failureStage === 'install') {
        try {
          pluginAdded = await this.readInstalled(packagePath)
        } catch {
          rollbackFailures.push('plugin-inspect')
        }
        if (pluginAdded) {
          try {
            rollbackExpected = await this.readPatchSnapshot(patchPath)
          } catch (error) {
            rollbackFailures.push(error instanceof ProfileConflictError ? 'patch-conflict' : 'patch')
            patchRollbackBlocked = true
          }
        }
      }

      let rollbackCurrent: PatchSnapshot | undefined
      if ((pluginAdded || writeAttempted) && !patchRollbackBlocked) {
        try {
          const current = await this.readPatchSnapshot(patchPath)
          if (rollbackExpected === undefined || !sameSnapshot(current, rollbackExpected)) {
            throw new ProfileConflictError()
          }
          rollbackCurrent = current
        } catch (error) {
          rollbackFailures.push(error instanceof ProfileConflictError ? 'patch-conflict' : 'patch')
        }
      }

      if (pluginAdded) {
        let pluginRemoved = false
        try {
          await this.runPlugin(name, 'remove')
          pluginRemoved = true
        } catch {
          rollbackFailures.push('plugin')
          rollbackCurrent = undefined
        }
        if (pluginRemoved && rollbackCurrent !== undefined) {
          try {
            rollbackCurrent = await this.readPatchSnapshot(patchPath)
          } catch (error) {
            rollbackFailures.push(error instanceof ProfileConflictError ? 'patch-conflict' : 'patch')
            rollbackCurrent = undefined
          }
        }
      }

      if (rollbackCurrent !== undefined) {
        try {
          await this.restoreSnapshot(patchPath, original, rollbackCurrent)
        } catch (error) {
          rollbackFailures.push(error instanceof ProfileConflictError ? 'patch-conflict' : 'patch')
        }
      }

      if (rollbackFailures.length === 0) {
        const cancellation = cancellationFrom(primaryError, signal)
        if (cancellation !== undefined) throw cancellation
        if (primaryError instanceof CliError) throw primaryError
      }
      throw profileWriteError(
        'Unable to attach SearXNG to the DSH profile',
        {
          primaryFailure: failureStage,
          primaryError: primaryErrorClass(primaryError, failureStage, signal),
          rollbackFailures,
        },
      )
    }
  }

  async detach(profile: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const name = resolvedProfileName(profile)
    const dir = this.resolveProfileDirectory(name)
    const patchPath = join(dir, 'cordis.patch.yml')
    let snapshot: PatchSnapshot
    try {
      snapshot = await this.readPatchSnapshot(patchPath)
    } catch (error) {
      if (error instanceof ProfileConflictError) {
        throw profileWriteError(
          'The DSH profile changed while it was being read',
          { primaryFailure: 'detach', primaryError: 'profile-conflict', rollbackFailures: [] },
        )
      }
      throw error
    }
    if (!snapshot.exists || snapshot.bytes === undefined) return
    const output = renderDetachment(parsePatch(snapshot.bytes))
    if (output === undefined) return
    let writeAttempted = false
    let rollbackExpected = snapshot
    try {
      const beforeCommit = await this.readPatchSnapshot(patchPath)
      if (!sameSnapshot(snapshot, beforeCommit)) throw new ProfileConflictError()
      writeAttempted = true
      try {
        rollbackExpected = await this.writeAtomic(patchPath, output, snapshot)
      } catch (error) {
        if (error instanceof CommittedWriteError) rollbackExpected = error.committed
        throw error
      }
      signal?.throwIfAborted()
    } catch (primaryError) {
      const rollbackFailures: string[] = []
      if (writeAttempted) {
        try {
          const current = await this.readPatchSnapshot(patchPath)
          if (!sameSnapshot(current, rollbackExpected)) {
            throw new ProfileConflictError()
          }
          await this.restoreSnapshot(patchPath, snapshot, current)
        } catch (error) {
          rollbackFailures.push(error instanceof ProfileConflictError ? 'patch-conflict' : 'patch')
        }
      }
      if (rollbackFailures.length === 0) {
        const cancellation = cancellationFrom(primaryError, signal)
        if (cancellation !== undefined) throw cancellation
        if (primaryError instanceof CliError) throw primaryError
      }
      throw profileWriteError(
        'Unable to detach SearXNG from the DSH profile',
        {
          primaryFailure: 'detach',
          primaryError: primaryErrorClass(primaryError, 'detach', signal),
          rollbackFailures,
        },
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
    let before: Awaited<ReturnType<typeof fs.lstat>>
    try {
      before = await this.fileSystem.lstat(patchPath)
    } catch (error) {
      if (ioCode(error) === 'ENOENT') return { exists: false }
      if (error instanceof CliError) throw error
      throw profileWriteError('Unable to read the DSH profile patch')
    }
    if (before.isSymbolicLink()) throw profileWriteError('The DSH profile patch is unsafe')
    try {
      const bytes = Buffer.from(await this.fileSystem.readFile(patchPath))
      const after = await this.fileSystem.lstat(patchPath)
      if (after.isSymbolicLink() || !sameIdentity(fileIdentity(before), fileIdentity(after))) {
        throw new ProfileConflictError()
      }
      return { exists: true, bytes, identity: fileIdentity(after) }
    } catch (error) {
      if (error instanceof ProfileConflictError || error instanceof CliError) throw error
      if (ioCode(error) === 'ENOENT') throw new ProfileConflictError()
      throw profileWriteError('Unable to read the DSH profile patch')
    }
  }

  private async runPlugin(
    profile: string,
    operation: 'add' | 'remove',
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    const result = await this.commandRunner.run(this.dshCommand, [
      'plugin', '--profile', profile, operation, PLUGIN_NAME,
    ], { signal })
    signal?.throwIfAborted()
    if (result.exitCode !== 0) throw new OperationFailure(operation === 'add' ? 'install' : 'write')
  }

  private async restoreSnapshot(
    patchPath: string,
    snapshot: PatchSnapshot,
    expectedCurrent: PatchSnapshot,
  ): Promise<void> {
    if (snapshot.exists && snapshot.bytes !== undefined) {
      await this.writeAtomic(patchPath, snapshot.bytes, expectedCurrent)
      return
    }
    const beforeUnlink = await this.readPatchSnapshot(patchPath)
    if (!sameSnapshot(beforeUnlink, expectedCurrent)) throw new ProfileConflictError()
    try { await this.fileSystem.unlink(patchPath) } catch (error) {
      if (ioCode(error) !== 'ENOENT') throw error
    }
    await this.syncDirectory(dirname(patchPath))
  }

  private async writeAtomic(
    path: string,
    bytes: Buffer,
    expectedCurrent?: PatchSnapshot,
  ): Promise<PatchSnapshot> {
    const directory = dirname(path)
    await this.fileSystem.mkdir(directory, { recursive: true, mode: 0o700 })
    const temporaryPath = `${path}.tmp-${this.randomId()}`
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      handle = await this.fileSystem.open(temporaryPath, 'wx', 0o600)
      await handle.writeFile(bytes)
      await handle.chmod(0o600)
      await handle.sync()
      const staged: PatchSnapshot = {
        exists: true,
        bytes: Buffer.from(bytes),
        identity: fileIdentity(await handle.stat()),
      }
      if (expectedCurrent !== undefined) {
        const beforeRename = await this.readPatchSnapshot(path)
        if (!sameSnapshot(beforeRename, expectedCurrent)) throw new ProfileConflictError()
      }
      await this.fileSystem.rename(temporaryPath, path)
      const renamedIdentity = fileIdentity(await handle.stat())
      // macOS advances ctime during rename. Prove continuity with the stable
      // fields, then use this same open handle's post-rename identity for the
      // exact target comparison below, including the updated ctime.
      if (staged.identity === undefined || !sameFileAcrossRename(staged.identity, renamedIdentity)) {
        throw new ProfileConflictError()
      }
      let closeFailed = false
      try {
        await handle.close()
        handle = undefined
      } catch {
        closeFailed = true
      }
      const committed = await this.readPatchSnapshot(path)
      if (!sameBytes(committed, bytes) || !sameIdentity(committed.identity, renamedIdentity)) {
        throw new ProfileConflictError()
      }
      if (closeFailed) throw new CommittedWriteError(committed)
      try {
        await this.syncDirectory(directory)
      } catch {
        throw new CommittedWriteError(committed)
      }
      return committed
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
