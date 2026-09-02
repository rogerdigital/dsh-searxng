import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { CliError } from './errors.ts'
import { assertValidProfile } from './environment.ts'

export interface StateV1 {
  schemaVersion: 1
  managed?: {
    deploymentVersion: 1
    image: string
    endpoint: string
    port: number
    homeId: string
    projectName: string
    containerName: string
    lastHealthyAt: string
  }
  profiles: Record<string, { mode: 'managed' | 'external'; endpoint: string }>
}

export interface DeploymentSnapshot {
  deploymentVersion: number
  image: string
  endpoint: string
  port: number
  projectName: string
  containerName: string
  /**
   * Absent only for snapshots migrated from schema v1, which never recorded a
   * configuration digest; every newly rendered deployment records one.
   */
  configurationSha256?: string
}

export interface StateV2 {
  schemaVersion: 2
  homeId: string
  managed?: {
    current: DeploymentSnapshot
    previous?: DeploymentSnapshot
    lastHealthyAt: string
  }
  profiles: Record<string, { mode: 'managed' | 'external'; endpoint: string }>
}

export interface StateStore {
  read(): Promise<StateV2>
  write(state: StateV2): Promise<void>
  withLock<T>(operation: () => Promise<T>): Promise<T>
}

/** Filesystem operations required by the shared atomic file-replace primitive. */
export interface AtomicWriteFs {
  mkdir: typeof mkdir
  open: typeof open
  rename: typeof rename
  rm: typeof rm
  chmod: typeof chmod
  link: typeof link
}

interface FsFacade extends AtomicWriteFs {
  readFile: typeof readFile
  stat: typeof stat
}

interface LockOwnership {
  token: string
  dev?: number
  ino?: number
}

const realFs: FsFacade = { mkdir, open, readFile, rename, rm, chmod, stat, link }

function stateInvalid(message: string): CliError {
  return new CliError('E_STATE_INVALID', message, 'Repair or remove the state file')
}

function stateReadFailed(): CliError {
  return new CliError(
    'E_INTERNAL',
    'Unable to read state storage',
    'Check state storage permissions and file type, then retry',
  )
}

function locked(): CliError {
  return new CliError('E_STATE_INVALID', 'State is locked', 'Wait and retry')
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

export function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index])
}

function isEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const parsed = Date.parse(value)
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value
}

function validateProfiles(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw stateInvalid('Invalid profiles')
  }
  for (const [profile, entry] of Object.entries(value as Record<string, unknown>)) {
    try {
      assertValidProfile(profile)
    } catch {
      throw stateInvalid('Invalid profile')
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || !exactKeys(entry, ['mode', 'endpoint'])) {
      throw stateInvalid('Invalid profile state')
    }
    const profileState = entry as Record<string, unknown>
    if (
      (profileState.mode !== 'managed' && profileState.mode !== 'external') ||
      !isEndpoint(profileState.endpoint)
    ) {
      throw stateInvalid('Invalid profile state')
    }
  }
}

function validateStateV1(value: unknown): asserts value is StateV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw stateInvalid('State must be an object')
  const root = value as Record<string, unknown>
  const rootKeys = root.managed === undefined
    ? ['schemaVersion', 'profiles']
    : ['schemaVersion', 'managed', 'profiles']
  if (root.schemaVersion !== 1 || !exactKeys(root, rootKeys)) throw stateInvalid('Unsupported state schema')
  validateProfiles(root.profiles)

  if (root.managed === undefined) return
  if (
    root.managed === null ||
    typeof root.managed !== 'object' ||
    Array.isArray(root.managed) ||
    !exactKeys(root.managed, [
      'deploymentVersion',
      'image',
      'endpoint',
      'port',
      'homeId',
      'projectName',
      'containerName',
      'lastHealthyAt',
    ])
  ) {
    throw stateInvalid('Invalid managed state')
  }
  const managed = root.managed as Record<string, unknown>
  if (
    managed.deploymentVersion !== 1 ||
    !isNonEmptyString(managed.image) ||
    !isEndpoint(managed.endpoint) ||
    !Number.isSafeInteger(managed.port) ||
    (managed.port as number) < 1 ||
    (managed.port as number) > 65535 ||
    typeof managed.homeId !== 'string' ||
    !/^[a-f0-9]{16}$/.test(managed.homeId) ||
    !isNonEmptyString(managed.projectName) ||
    !isNonEmptyString(managed.containerName) ||
    !isCanonicalTimestamp(managed.lastHealthyAt)
  ) {
    throw stateInvalid('Invalid managed state')
  }
}

function validateSnapshot(value: unknown, where: string): asserts value is DeploymentSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw stateInvalid(`Invalid managed ${where}`)
  const snapshot = value as Record<string, unknown>
  const keys = ['deploymentVersion', 'image', 'endpoint', 'port', 'projectName', 'containerName']
  if (snapshot.configurationSha256 !== undefined) keys.push('configurationSha256')
  if (!exactKeys(snapshot, keys)) throw stateInvalid(`Invalid managed ${where}`)
  if (
    !Number.isSafeInteger(snapshot.deploymentVersion) ||
    (snapshot.deploymentVersion as number) < 1 ||
    !isNonEmptyString(snapshot.image) ||
    !isEndpoint(snapshot.endpoint) ||
    !Number.isSafeInteger(snapshot.port) ||
    (snapshot.port as number) < 1 ||
    (snapshot.port as number) > 65535 ||
    !isNonEmptyString(snapshot.projectName) ||
    !isNonEmptyString(snapshot.containerName) ||
    (snapshot.configurationSha256 !== undefined &&
      (typeof snapshot.configurationSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.configurationSha256)))
  ) {
    throw stateInvalid(`Invalid managed ${where}`)
  }
}

function validateStateV2(value: unknown): asserts value is StateV2 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw stateInvalid('State must be an object')
  const root = value as Record<string, unknown>
  const rootKeys = root.managed === undefined
    ? ['schemaVersion', 'homeId', 'profiles']
    : ['schemaVersion', 'homeId', 'managed', 'profiles']
  if (root.schemaVersion !== 2 || !exactKeys(root, rootKeys)) throw stateInvalid('Unsupported state schema')
  if (typeof root.homeId !== 'string' || !/^[a-f0-9]{16}$/.test(root.homeId)) {
    throw stateInvalid('Invalid state home identity')
  }
  validateProfiles(root.profiles)

  if (root.managed === undefined) return
  if (root.managed === null || typeof root.managed !== 'object' || Array.isArray(root.managed)) {
    throw stateInvalid('Invalid managed state')
  }
  const managed = root.managed as Record<string, unknown>
  const managedKeys = managed.previous === undefined
    ? ['current', 'lastHealthyAt']
    : ['current', 'previous', 'lastHealthyAt']
  if (!exactKeys(managed, managedKeys)) throw stateInvalid('Invalid managed state')
  validateSnapshot(managed.current, 'current')
  if (managed.previous !== undefined) validateSnapshot(managed.previous, 'previous')
  if (!isCanonicalTimestamp(managed.lastHealthyAt)) throw stateInvalid('Invalid managed state')
}

/**
 * Migrate a validated v1 state in memory. v1 recorded no configuration digest,
 * so the migrated current snapshot legitimately carries none; v1 homeId moves
 * from the managed section to the state root, falling back to the store home.
 */
function migrateStateV1(state: StateV1, fallbackHomeId: string): StateV2 {
  return {
    schemaVersion: 2,
    homeId: state.managed?.homeId ?? fallbackHomeId,
    ...(state.managed === undefined ? {} : {
      managed: {
        current: {
          deploymentVersion: state.managed.deploymentVersion,
          image: state.managed.image,
          endpoint: state.managed.endpoint,
          port: state.managed.port,
          projectName: state.managed.projectName,
          containerName: state.managed.containerName,
        },
        lastHealthyAt: state.managed.lastHealthyAt,
      },
    }),
    profiles: state.profiles,
  }
}

function combinedError(primary: unknown, secondary: readonly unknown[], message: string): unknown {
  if (secondary.length === 0) return primary
  return new AggregateError([primary, ...secondary], message)
}

async function syncDirectory(fs: AtomicWriteFs, root: string): Promise<void> {
  if (process.platform === 'win32') return
  const directory = await fs.open(root, constants.O_RDONLY)
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

async function rollbackReplace(
  fs: AtomicWriteFs,
  root: string,
  path: string,
  originalExists: boolean,
  backupPath: string,
  failedPath: string,
  errors: unknown[],
): Promise<void> {
  if (originalExists) {
    try {
      await fs.rename(path, failedPath)
    } catch (error) {
      errors.push(error)
      return
    }
    try {
      await fs.link(backupPath, path)
    } catch (error) {
      errors.push(error)
      return
    }
    try {
      await syncDirectory(fs, root)
    } catch (error) {
      errors.push(error)
      return
    }
    try {
      await fs.rm(failedPath, { force: true })
    } catch (error) {
      errors.push(error)
    }
    try {
      await fs.rm(backupPath, { force: true })
    } catch (error) {
      errors.push(error)
    }
    return
  }

  try {
    await fs.rename(path, failedPath)
  } catch (renameError) {
    try {
      await fs.rm(path)
    } catch (removeError) {
      errors.push(renameError, removeError)
      return
    }
  }
  try {
    await syncDirectory(fs, root)
  } catch (error) {
    errors.push(error)
    return
  }
  try {
    await fs.rm(failedPath, { force: true })
  } catch (error) {
    errors.push(error)
  }
}

/**
 * Atomically replace `path` with `contents` using the same discipline as the
 * state store: hard-link backup, exclusive 0600 temporary, fsync, rename
 * commit, directory fsync, and rollback with retained evidence on failure.
 */
export async function writeAtomicFile(fs: AtomicWriteFs, root: string, path: string, contents: string): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 })

  const suffix = `${process.pid}-${randomBytes(8).toString('hex')}`
  const temporaryPath = `${path}.tmp-${suffix}`
  const backupPath = `${path}.backup-${suffix}`
  const failedPath = `${path}.failed-${suffix}`
  let originalExists = true
  try {
    await fs.link(path, backupPath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') originalExists = false
    else throw error
  }

  let handle: FileHandle | undefined
  let committed = false
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.chmod(temporaryPath, 0o600)
    await fs.rename(temporaryPath, path)
    committed = true
    await syncDirectory(fs, root)
    if (originalExists) await fs.rm(backupPath)
  } catch (primary) {
    const recoveryErrors: unknown[] = []
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch (error) {
        recoveryErrors.push(error)
      }
    }
    try {
      await fs.rm(temporaryPath, { force: true })
    } catch (error) {
      recoveryErrors.push(error)
    }

    if (committed) {
      await rollbackReplace(fs, root, path, originalExists, backupPath, failedPath, recoveryErrors)
    } else if (originalExists) {
      try {
        await fs.rm(backupPath, { force: true })
      } catch (error) {
        recoveryErrors.push(error)
      }
    }
    throw combinedError(primary, recoveryErrors, 'Atomic file write failed and cleanup or rollback was incomplete')
  }
}

export class FileStateStore implements StateStore {
  private readonly root: string
  private readonly homeId: string
  private readonly fs: FsFacade
  private readonly statePath: string
  private readonly lockPath: string

  constructor(managedDirectory: string, homeId: string, fsFacade: Partial<FsFacade> = {}) {
    if (typeof homeId !== 'string' || !/^[a-f0-9]{16}$/.test(homeId)) {
      throw new CliError('E_INTERNAL', 'State home identity is invalid', 'Check the CLI installation and retry')
    }
    this.root = managedDirectory
    this.homeId = homeId
    this.fs = { ...realFs, ...fsFacade }
    this.statePath = join(managedDirectory, 'state.json')
    this.lockPath = join(managedDirectory, 'state.lock')
  }

  async read(): Promise<StateV2> {
    let source: string
    try {
      source = await this.fs.readFile(this.statePath, 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { schemaVersion: 2, homeId: this.homeId, profiles: {} }
      throw stateReadFailed()
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch {
      throw stateInvalid('State JSON is malformed')
    }
    // read() has a write side effect: it persists the one-shot v1→v2
    // migration. It cannot take the state lock itself — diagnose reads
    // unlocked while setup/remove call read() under withLock, and lock
    // recursion would deadlock — so this migration write may race a
    // concurrent committed write. Last writer wins and re-running setup
    // converges; the update transaction (lifecycle Task 4) must instead
    // read state only after acquiring the lock.
    if (isSchemaV1(parsed)) {
      validateStateV1(parsed)
      const migrated = migrateStateV1(parsed, this.homeId)
      validateStateV2(migrated)
      await this.write(migrated)
      return migrated
    }
    validateStateV2(parsed)
    return parsed
  }

  async write(state: StateV2): Promise<void> {
    validateStateV2(state)
    await writeAtomicFile(this.fs, this.root, this.statePath, `${JSON.stringify(state)}\n`)
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    await this.fs.chmod(this.root, 0o700)
    const ownership = await this.acquireLock()

    let result: T | undefined
    let operationError: unknown
    let operationFailed = false
    try {
      result = await operation()
    } catch (error) {
      operationFailed = true
      operationError = error
    }

    let releaseError: unknown
    try {
      await this.releaseLock(ownership)
    } catch (error) {
      releaseError = error
    }

    if (operationFailed && releaseError !== undefined) {
      throw new AggregateError([operationError, releaseError], 'State operation and lock release both failed')
    }
    if (operationFailed) throw operationError
    if (releaseError !== undefined) throw releaseError
    return result as T
  }

  private async acquireLock(): Promise<LockOwnership> {
    const token = randomBytes(16).toString('hex')
    const metadata = `${JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString(), identity: token })}\n`
    let handle: FileHandle | undefined
    let created = false
    let ownership: LockOwnership = { token }
    try {
      handle = await this.fs.open(this.lockPath, 'wx', 0o600)
      created = true
      const identity = await handle.stat()
      ownership = { token, dev: identity.dev, ino: identity.ino }
      await handle.writeFile(metadata, 'utf8')
      await handle.sync()
      await handle.chmod(0o600)
      await handle.close()
      handle = undefined
      return ownership
    } catch (primary) {
      if (!created && errorCode(primary) === 'EEXIST') throw locked()
      const cleanupErrors: unknown[] = []
      if (handle !== undefined) {
        try {
          await handle.close()
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      if (created) {
        try {
          await this.quarantineLock(ownership, true, true)
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      throw combinedError(primary, cleanupErrors, 'State lock acquisition failed and cleanup was incomplete')
    }
  }

  private async releaseLock(ownership: LockOwnership): Promise<void> {
    await this.quarantineLock(ownership, false, false)
  }

  /**
   * Node has no portable conditional unlink-by-inode. The 0700 managed directory
   * and unpredictable quarantine name are the local trust boundary: this covers
   * cooperating CLI processes, accidental canonical replacement, and ordinary
   * filesystem errors, but not same-UID/root attackers racing private paths or
   * hostile filesystems that violate atomic rename/link semantics.
   */
  private async quarantineLock(
    expected: LockOwnership,
    foreignIsError: boolean,
    allowIncompleteToken: boolean,
  ): Promise<void> {
    const quarantinePath = join(this.root, `state.lock.release-${randomBytes(16).toString('hex')}`)
    await this.fs.rename(this.lockPath, quarantinePath)

    let snapshot: LockOwnership
    try {
      snapshot = await this.inspectQuarantine(quarantinePath)
    } catch (verificationError) {
      const recoveryErrors: unknown[] = []
      try {
        await this.fs.link(quarantinePath, this.lockPath)
      } catch (error) {
        recoveryErrors.push(error)
      }
      throw combinedError(
        verificationError,
        recoveryErrors,
        'Lock quarantine verification failed and recovery was incomplete',
      )
    }

    const tokenMatches = snapshot.token === expected.token
    const inodeMatches = expected.dev === snapshot.dev && expected.ino === snapshot.ino
    const owned = inodeMatches && (allowIncompleteToken || tokenMatches)
    if (owned) {
      await this.fs.rm(quarantinePath)
      return
    }

    await this.fs.link(quarantinePath, this.lockPath)
    await this.fs.rm(quarantinePath)
    if (foreignIsError) throw new Error('Lock ownership changed during acquisition cleanup')
  }

  private async inspectQuarantine(path: string): Promise<LockOwnership> {
    let handle: FileHandle | undefined
    try {
      handle = await this.fs.open(path, 'r')
      const identity = await handle.stat()
      const source = await handle.readFile('utf8')
      await handle.close()
      handle = undefined
      let token = ''
      try {
        const parsed = JSON.parse(source) as { identity?: unknown }
        if (typeof parsed.identity === 'string') token = parsed.identity
      } catch {
        // Malformed content is a foreign lock, not a verification I/O failure.
      }
      return { token, dev: identity.dev, ino: identity.ino }
    } catch (primary) {
      const cleanupErrors: unknown[] = []
      if (handle !== undefined) {
        try {
          await handle.close()
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      throw combinedError(primary, cleanupErrors, 'Lock quarantine inspection failed')
    }
  }
}

function isSchemaV1(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1
}
