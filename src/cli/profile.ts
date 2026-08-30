import * as fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  isAlias,
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
  preview(profile: string, endpoint: string, signal?: AbortSignal): Promise<ProfileAttachmentPreview>
  validate(
    profile: string,
    endpoint: string,
    callback: (config: ProfileAttachmentConfig) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>
  attach(
    profile: string,
    endpoint: string,
    validate: (config: ProfileAttachmentConfig) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>
  detach(profile: string, signal?: AbortSignal): Promise<void>
  uninstall(profile: string, signal?: AbortSignal): Promise<void>
}

export interface ProfileAttachmentConfig {
  baseURL: string
  language?: string
  engines?: string
  categories?: string
  authHeader?: string
}

export interface ProfileAttachmentPreview {
  installed: boolean
  attached: boolean
  config: ProfileAttachmentConfig
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
  action = 'Check the DSH profile and retry',
): CliError {
  return new CliError(
    'E_PROFILE_WRITE',
    message,
    action,
    details,
  )
}

function concurrentProfileModification(): CliError {
  return new CliError(
    'E_PROFILE_CONCURRENT_MODIFICATION',
    'The DSH profile changed during validation',
    'Review the profile change and retry setup',
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

function containsAnchorOrAlias(value: unknown): boolean {
  if (!isNode(value)) return false
  if (isAlias(value)) return true
  if ('anchor' in value && typeof value.anchor === 'string' && value.anchor.length > 0) return true
  if (isMap(value)) {
    return value.items.some((pair) => containsAnchorOrAlias(pair.key) || containsAnchorOrAlias(pair.value))
  }
  if (isSeq(value)) return value.items.some((item) => containsAnchorOrAlias(item))
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
  if (containsAnchorOrAlias(config)) {
    throw profileWriteError('The target DSH profile config contains an unsafe YAML anchor or alias')
  }
  return config.clone() as YAMLMap<unknown, unknown>
}

function providerConfig(config: YAMLMap<unknown, unknown>, endpoint?: string): ProfileAttachmentConfig {
  let value: unknown
  try { value = config.toJSON() } catch { throw profileWriteError('The target DSH profile config is invalid') }
  if (!isPlainRecord(value)) throw profileWriteError('The target DSH profile config is invalid')
  const configuredBaseURL = endpoint ?? value.baseURL
  if (typeof configuredBaseURL !== 'string') throw profileWriteError('The target DSH profile config has no valid SearXNG endpoint')
  const result: ProfileAttachmentConfig = { baseURL: normalizeEndpoint(configuredBaseURL) }
  for (const key of ['language', 'engines', 'categories', 'authHeader'] as const) {
    const field = value[key]
    if (field === undefined) continue
    if (typeof field !== 'string') throw profileWriteError(`The target DSH profile ${key} config is invalid`)
    result[key] = field
  }
  return result
}

function cloneProviderConfig(config: ProfileAttachmentConfig): ProfileAttachmentConfig {
  return { ...config }
}

function lastTarget(parsed: ParsedPatch): YAMLMap<unknown, unknown> | undefined {
  let target: YAMLMap<unknown, unknown> | undefined
  for (const item of parsed.sequence.items) if (isTargetPatch(item)) target = item
  return target
}

function configFromAttachment(bytes: Buffer): ProfileAttachmentConfig {
  const parsed = parsePatch(bytes)
  const target = lastTarget(parsed)
  if (target === undefined) throw profileWriteError('The managed DSH profile attachment is missing')
  return providerConfig(configOf(parsed.document, target))
}

function isCurrentManagedAttachment(parsed: ParsedPatch, endpoint: string): boolean {
  const managed = parsed.sequence.items.filter(isManagedPatch)
  const target = lastTarget(parsed)
  if (managed.length !== 1 || target === undefined || !isManagedPatch(target)) return false
  return providerConfig(configOf(parsed.document, target)).baseURL === endpoint
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
    if (isManagedPatch(item) && containsAnchorOrAlias(item)) {
      throw profileWriteError('The managed DSH profile patch contains an unsafe YAML anchor or alias')
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
    if (isManagedPatch(item) && containsAnchorOrAlias(item)) {
      throw profileWriteError('The managed DSH profile patch contains an unsafe YAML anchor or alias')
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

  async preview(profile: string, endpoint: string, signal?: AbortSignal): Promise<ProfileAttachmentPreview> {
    signal?.throwIfAborted()
    const name = resolvedProfileName(profile)
    const normalizedEndpoint = normalizeEndpoint(endpoint)
    const dir = this.resolveProfileDirectory(name)
    const installed = await this.readInstalled(join(dir, 'package.json'))
    const snapshot = await this.readPatchSnapshot(join(dir, 'cordis.patch.yml'))
    const source = snapshot.bytes ?? Buffer.from('[]\n')
    const current = parsePatch(source)
    const attached = installed && isCurrentManagedAttachment(current, normalizedEndpoint)
    const output = renderAttachment(parsePatch(source), normalizedEndpoint)
    signal?.throwIfAborted()
    return { installed, attached, config: cloneProviderConfig(configFromAttachment(output)) }
  }

  async validate(
    profile: string,
    endpoint: string,
    callback: (config: ProfileAttachmentConfig) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    const name = resolvedProfileName(profile)
    const normalizedEndpoint = normalizeEndpoint(endpoint)
    const dir = this.resolveProfileDirectory(name)
    const manifestPath = join(dir, 'package.json')
    let manifestSnapshot: PatchSnapshot
    let snapshot: PatchSnapshot
    try {
      manifestSnapshot = await this.readManifestSnapshot(manifestPath)
      snapshot = await this.readPatchSnapshot(join(dir, 'cordis.patch.yml'))
    } catch (error) {
      if (error instanceof ProfileConflictError) throw concurrentProfileModification()
      throw error
    }
    if (
      manifestSnapshot.bytes === undefined ||
      !this.installedFromManifestSnapshot(manifestSnapshot) ||
      snapshot.bytes === undefined
    ) throw concurrentProfileModification()
    const parsed = parsePatch(snapshot.bytes)
    if (!isCurrentManagedAttachment(parsed, normalizedEndpoint)) throw concurrentProfileModification()
    const target = lastTarget(parsed)
    if (target === undefined) throw concurrentProfileModification()
    const config = cloneProviderConfig(providerConfig(configOf(parsed.document, target)))

    let callbackFailed = false
    let callbackError: unknown
    try {
      await callback(config)
    } catch (error) {
      callbackFailed = true
      callbackError = error
    }

    let unchanged = false
    try {
      const manifestAfter = await this.readManifestSnapshot(manifestPath)
      const after = await this.readPatchSnapshot(join(dir, 'cordis.patch.yml'))
      unchanged = sameSnapshot(manifestSnapshot, manifestAfter) &&
        sameSnapshot(snapshot, after) &&
        manifestAfter.bytes !== undefined &&
        this.installedFromManifestSnapshot(manifestAfter)
    } catch {
      unchanged = false
    }
    if (!unchanged) throw concurrentProfileModification()
    if (callbackFailed) throw callbackError
    signal?.throwIfAborted()
  }

  async attach(
    profile: string,
    endpoint: string,
    validate: (config: ProfileAttachmentConfig) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    const name = resolvedProfileName(profile)
    const normalizedEndpoint = normalizeEndpoint(endpoint)
    const dir = this.resolveProfileDirectory(name)
    const packagePath = join(dir, 'package.json')
    const patchPath = join(dir, 'cordis.patch.yml')
    let manifestBefore: PatchSnapshot
    try {
      manifestBefore = await this.readManifestSnapshot(packagePath)
    } catch (error) {
      if (error instanceof ProfileConflictError) throw concurrentProfileModification()
      throw error
    }
    const installedBefore = this.installedFromManifestSnapshot(manifestBefore)
    let manifestBaseline = manifestBefore
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
    let pluginResidualPossible = false
    let deferredAddError: unknown
    let writeAttempted = false
    let rollbackExpected: PatchSnapshot | undefined
    let output: Buffer | undefined
    let failureStage: FailureStage = 'install'
    let rollbackTarget = original
    let restoreRollbackTargetAllowed = true

    try {
      if (!installedBefore) {
        failureStage = 'install'
        const beforeAdd = await this.readManifestSnapshot(packagePath)
        if (!sameSnapshot(manifestBefore, beforeAdd) || this.installedFromManifestSnapshot(beforeAdd)) {
          throw concurrentProfileModification()
        }
        let addError: unknown
        try {
          await this.addPlugin(name, signal)
        } catch (error) {
          addError = error
        }
        let afterAdd: PatchSnapshot
        try {
          afterAdd = await this.readManifestSnapshot(packagePath)
        } catch {
          pluginResidualPossible = true
          throw concurrentProfileModification()
        }
        if (!this.installedFromManifestSnapshot(afterAdd)) {
          if (!sameSnapshot(beforeAdd, afterAdd)) {
            throw concurrentProfileModification()
          }
          if (addError !== undefined) throw addError
          throw new OperationFailure('install')
        }
        pluginAdded = true
        pluginResidualPossible = true
        manifestBaseline = afterAdd
        deferredAddError = addError
      }

      signal?.throwIfAborted()
      const renderBase = await this.readPatchSnapshot(patchPath)
      if (!await this.manifestMatches(packagePath, manifestBaseline)) {
        throw concurrentProfileModification()
      }
      rollbackExpected = renderBase
      if (pluginAdded) {
        if (original.exists && !sameSnapshot(original, renderBase)) {
          restoreRollbackTargetAllowed = false
          throw new ProfileConflictError()
        }
        if (!original.exists) rollbackTarget = renderBase
      }
      if (deferredAddError !== undefined) throw deferredAddError
      failureStage = 'write'
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
      if (!await this.manifestMatches(packagePath, manifestBaseline)) {
        throw concurrentProfileModification()
      }
      let validationError: unknown
      try {
        await validate(cloneProviderConfig(configFromAttachment(output)))
      } catch (error) {
        validationError = error
      }
      const afterValidation = await this.readPatchSnapshot(patchPath)
      if (rollbackExpected === undefined || !sameSnapshot(afterValidation, rollbackExpected)) {
        if (validationError !== undefined) throw validationError
        throw new ProfileConflictError()
      }
      if (!await this.manifestMatches(packagePath, manifestBaseline)) {
        throw concurrentProfileModification()
      }
      if (validationError !== undefined) throw validationError
      signal?.throwIfAborted()
    } catch (primaryError) {
      const rollbackFailures: string[] = []
      let patchRollbackBlocked = false
      let effectivePrimaryError = primaryError
      if (pluginResidualPossible) rollbackFailures.push('plugin-residual')

      if (!installedBefore && !pluginAdded && failureStage === 'install') {
        try {
          rollbackExpected = await this.readPatchSnapshot(patchPath)
          if (!sameSnapshot(original, rollbackExpected)) {
            restoreRollbackTargetAllowed = false
            effectivePrimaryError = new ProfileConflictError()
          }
        } catch (error) {
          rollbackFailures.push(error instanceof ProfileConflictError ? 'patch-conflict' : 'patch')
          patchRollbackBlocked = true
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

      if (rollbackCurrent !== undefined && restoreRollbackTargetAllowed) {
        try {
          await this.restoreSnapshot(patchPath, rollbackTarget, rollbackCurrent)
        } catch (error) {
          rollbackFailures.push(error instanceof ProfileConflictError ? 'patch-conflict' : 'patch')
        }
      }

      if (rollbackFailures.length === 0) {
        const cancellation = cancellationFrom(effectivePrimaryError, signal)
        if (cancellation !== undefined) throw cancellation
        if (effectivePrimaryError instanceof CliError) throw effectivePrimaryError
      }
      throw profileWriteError(
        'Unable to attach SearXNG to the DSH profile',
        {
          primaryFailure: failureStage,
          primaryError: primaryErrorClass(effectivePrimaryError, failureStage, signal),
          rollbackFailures,
        },
        rollbackFailures.includes('plugin-residual')
          ? 'Run dsh-searxng setup again; it will reuse or reconcile the retained plugin package state'
          : 'Check the DSH profile and retry',
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

  async uninstall(profile: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const name = resolvedProfileName(profile)
    const packagePath = join(this.resolveProfileDirectory(name), 'package.json')
    if (!await this.readInstalled(packagePath)) return
    let result
    try {
      result = await this.commandRunner.run(
        this.dshCommand,
        ['plugin', '--profile', name, 'remove', PLUGIN_NAME],
        { signal },
      )
      signal?.throwIfAborted()
    } catch (error) {
      const cancellation = cancellationFrom(error, signal)
      if (cancellation !== undefined) throw cancellation
      throw profileWriteError('Unable to remove dsh-searxng from the DSH profile')
    }
    if (result.exitCode !== 0 || await this.readInstalled(packagePath)) {
      throw profileWriteError('Unable to remove dsh-searxng from the DSH profile')
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

  private installedFromManifestSnapshot(snapshot: PatchSnapshot): boolean {
    if (snapshot.bytes === undefined) return false
    let value: unknown
    try { value = JSON.parse(snapshot.bytes.toString()) } catch { throw profileWriteError('The DSH profile manifest is invalid') }
    return installedFromManifest(value)
  }

  private async readManifestSnapshot(packagePath: string): Promise<PatchSnapshot> {
    let before: Awaited<ReturnType<typeof fs.lstat>>
    try {
      before = await this.fileSystem.lstat(packagePath)
    } catch (error) {
      if (ioCode(error) === 'ENOENT') return { exists: false }
      if (error instanceof CliError) throw error
      throw profileWriteError('Unable to read the DSH profile manifest')
    }
    if (before.isSymbolicLink() || !before.isFile()) throw profileWriteError('The DSH profile manifest is unsafe')
    try {
      const bytes = Buffer.from(await this.fileSystem.readFile(packagePath))
      const after = await this.fileSystem.lstat(packagePath)
      if (after.isSymbolicLink() || !after.isFile() || !sameIdentity(fileIdentity(before), fileIdentity(after))) {
        throw new ProfileConflictError()
      }
      return { exists: true, bytes, identity: fileIdentity(after) }
    } catch (error) {
      if (error instanceof ProfileConflictError || error instanceof CliError) throw error
      if (ioCode(error) === 'ENOENT') throw new ProfileConflictError()
      throw profileWriteError('Unable to read the DSH profile manifest')
    }
  }

  private async manifestMatches(packagePath: string, expected: PatchSnapshot): Promise<boolean> {
    try {
      const current = await this.readManifestSnapshot(packagePath)
      return sameSnapshot(current, expected) && this.installedFromManifestSnapshot(current)
    } catch {
      return false
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
    if (before.isSymbolicLink() || !before.isFile()) throw profileWriteError('The DSH profile patch is unsafe')
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

  private async addPlugin(
    profile: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    const result = await this.commandRunner.run(this.dshCommand, [
      'plugin', '--profile', profile, 'add', PLUGIN_NAME,
    ], { signal })
    signal?.throwIfAborted()
    if (result.exitCode !== 0) throw new OperationFailure('install')
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
