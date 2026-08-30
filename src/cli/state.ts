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

interface FsFacade {
  mkdir: typeof mkdir
  open: typeof open
  readFile: typeof readFile
  rename: typeof rename
  rm: typeof rm
  chmod: typeof chmod
  stat: typeof stat
  link: typeof link
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

function locked(): CliError {
  return new CliError('E_STATE_INVALID', 'State is locked', 'Wait and retry')
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function exactKeys(value: object, expected: readonly string[]): boolean {
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const parsed = Date.parse(value)
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value
}

function validateState(value: unknown): asserts value is StateV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw stateInvalid('State must be an object')
  const root = value as Record<string, unknown>
  const rootKeys = root.managed === undefined
    ? ['schemaVersion', 'profiles']
    : ['schemaVersion', 'managed', 'profiles']
  if (root.schemaVersion !== 1 || !exactKeys(root, rootKeys)) throw stateInvalid('Unsupported state schema')
  if (root.profiles === null || typeof root.profiles !== 'object' || Array.isArray(root.profiles)) {
    throw stateInvalid('Invalid profiles')
  }

  for (const [profile, entry] of Object.entries(root.profiles as Record<string, unknown>)) {
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

function combinedError(primary: unknown, secondary: readonly unknown[], message: string): unknown {
  if (secondary.length === 0) return primary
  return new AggregateError([primary, ...secondary], message)
}

export class StateStore {
  private readonly root: string
  private readonly fs: FsFacade
  private readonly statePath: string
  private readonly lockPath: string

  constructor(managedDirectory: string, fsFacade: Partial<FsFacade> = {}) {
    this.root = managedDirectory
    this.fs = { ...realFs, ...fsFacade }
    this.statePath = join(managedDirectory, 'state.json')
    this.lockPath = join(managedDirectory, 'state.lock')
  }

  async read(): Promise<StateV1> {
    let source: string
    try {
      source = await this.fs.readFile(this.statePath, 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { schemaVersion: 1, profiles: {} }
      throw stateInvalid('Unable to read state')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch {
      throw stateInvalid('State JSON is malformed')
    }
    validateState(parsed)
    return parsed
  }

  async write(state: StateV1): Promise<void> {
    validateState(state)
    await this.fs.mkdir(this.root, { recursive: true, mode: 0o700 })

    const suffix = `${process.pid}-${randomBytes(8).toString('hex')}`
    const temporaryPath = `${this.statePath}.tmp-${suffix}`
    const backupPath = `${this.statePath}.backup-${suffix}`
    const failedPath = `${this.statePath}.failed-${suffix}`
    let originalExists = true
    try {
      await this.fs.link(this.statePath, backupPath)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') originalExists = false
      else throw error
    }

    let handle: FileHandle | undefined
    let committed = false
    try {
      handle = await this.fs.open(temporaryPath, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await this.fs.chmod(temporaryPath, 0o600)
      await this.fs.rename(temporaryPath, this.statePath)
      committed = true
      await this.syncDirectory()
      if (originalExists) await this.fs.rm(backupPath)
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
        await this.fs.rm(temporaryPath, { force: true })
      } catch (error) {
        recoveryErrors.push(error)
      }

      if (committed) {
        await this.rollbackWrite(originalExists, backupPath, failedPath, recoveryErrors)
      } else if (originalExists) {
        try {
          await this.fs.rm(backupPath, { force: true })
        } catch (error) {
          recoveryErrors.push(error)
        }
      }
      throw combinedError(primary, recoveryErrors, 'State write failed and cleanup or rollback was incomplete')
    }
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

  private async rollbackWrite(
    originalExists: boolean,
    backupPath: string,
    failedPath: string,
    errors: unknown[],
  ): Promise<void> {
    if (originalExists) {
      try {
        await this.fs.rename(this.statePath, failedPath)
      } catch (error) {
        errors.push(error)
        return
      }
      try {
        await this.fs.link(backupPath, this.statePath)
      } catch (error) {
        errors.push(error)
        return
      }
      try {
        await this.syncDirectory()
      } catch (error) {
        errors.push(error)
        return
      }
      try {
        await this.fs.rm(failedPath, { force: true })
      } catch (error) {
        errors.push(error)
      }
      try {
        await this.fs.rm(backupPath, { force: true })
      } catch (error) {
        errors.push(error)
      }
      return
    }

    try {
      await this.fs.rename(this.statePath, failedPath)
    } catch (renameError) {
      try {
        await this.fs.rm(this.statePath)
      } catch (removeError) {
        errors.push(renameError, removeError)
        return
      }
    }
    try {
      await this.syncDirectory()
    } catch (error) {
      errors.push(error)
      return
    }
    try {
      await this.fs.rm(failedPath, { force: true })
    } catch (error) {
      errors.push(error)
    }
  }

  private async syncDirectory(): Promise<void> {
    if (process.platform === 'win32') return
    const directory = await this.fs.open(this.root, constants.O_RDONLY)
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
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
      await handle.writeFile(metadata, 'utf8')
      await handle.sync()
      const identity = await handle.stat()
      ownership = { token, dev: identity.dev, ino: identity.ino }
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
          await this.quarantineLock(ownership, true, ownership.dev === undefined)
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
    allowTokenOnly: boolean,
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
    const owned = tokenMatches && (allowTokenOnly || inodeMatches)
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
