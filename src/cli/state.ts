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

function sameFile(first: Awaited<ReturnType<typeof stat>>, second: Awaited<ReturnType<typeof stat>>): boolean {
  return first.dev === second.dev && first.ino === second.ino
}

export class StateStore {
  private readonly root: string
  private readonly fs: FsFacade
  private readonly statePath: string
  private readonly lockPath: string
  private readonly transitionPath: string

  constructor(managedDirectory: string, fsFacade: Partial<FsFacade> = {}) {
    this.root = managedDirectory
    this.fs = { ...realFs, ...fsFacade }
    this.statePath = join(managedDirectory, 'state.json')
    this.lockPath = join(managedDirectory, 'state.lock')
    this.transitionPath = join(managedDirectory, 'state.lock.transition')
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
    const identity = randomBytes(16).toString('hex')
    const ownerPath = join(this.root, `state.lock.owner-${identity}`)
    const metadata = `${JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString(), identity })}\n`

    await this.createOwnedFile(ownerPath, metadata)
    let acquired = false
    try {
      await this.acquireTransition(identity)
      let acquisitionError: unknown
      try {
        await this.fs.link(ownerPath, this.lockPath)
        acquired = true
      } catch (error) {
        acquisitionError = errorCode(error) === 'EEXIST' ? locked() : error
      }
      let transitionError: unknown
      try {
        await this.releaseTransition()
      } catch (error) {
        transitionError = error
      }
      if (acquisitionError !== undefined && transitionError !== undefined) {
        throw new AggregateError(
          [acquisitionError, transitionError],
          'State lock acquisition and transition cleanup both failed',
        )
      }
      if (acquisitionError !== undefined) throw acquisitionError
      if (transitionError !== undefined) throw transitionError
    } catch (error) {
      const primary = errorCode(error) === 'EEXIST' ? locked() : error
      const cleanupErrors: unknown[] = []
      if (acquired) {
        try {
          await this.releaseLock(identity, ownerPath)
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError)
        }
      } else {
        try {
          await this.fs.rm(ownerPath, { force: true })
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError)
        }
      }
      throw combinedError(primary, cleanupErrors, 'State lock acquisition failed and cleanup was incomplete')
    }

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
      await this.releaseLock(identity, ownerPath)
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

  private async createOwnedFile(path: string, contents: string): Promise<void> {
    let handle: FileHandle | undefined
    let created = false
    try {
      handle = await this.fs.open(path, 'wx', 0o600)
      created = true
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await this.fs.chmod(path, 0o600)
    } catch (primary) {
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
          await this.fs.rm(path, { force: true })
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      throw combinedError(primary, cleanupErrors, 'Exclusive file creation failed and cleanup was incomplete')
    }
  }

  private async acquireTransition(identity: string, retry = false): Promise<void> {
    const attempts = retry ? 50 : 1
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.createOwnedFile(this.transitionPath, `${identity}\n`)
        return
      } catch (error) {
        if (!retry || errorCode(error) !== 'EEXIST' || attempt === attempts - 1) throw error
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
    }
  }

  private async releaseTransition(): Promise<void> {
    await this.fs.rm(this.transitionPath)
  }

  private async releaseLock(identity: string, ownerPath: string): Promise<void> {
    await this.acquireTransition(identity, true)
    let primary: unknown
    try {
      await this.releaseLockWhileGuarded(identity, ownerPath)
    } catch (error) {
      primary = error
    }
    try {
      await this.releaseTransition()
    } catch (error) {
      if (primary !== undefined) {
        throw new AggregateError([primary, error], 'State lock release and transition cleanup both failed')
      }
      throw error
    }
    if (primary !== undefined) throw primary
  }

  private async releaseLockWhileGuarded(identity: string, ownerPath: string): Promise<void> {
    let ownerStat: Awaited<ReturnType<typeof stat>>
    try {
      ownerStat = await this.fs.stat(ownerPath)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw new Error('Owned state lock identity is missing')
      throw error
    }

    let canonicalStat: Awaited<ReturnType<typeof stat>>
    try {
      canonicalStat = await this.fs.stat(this.lockPath)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        await this.fs.rm(ownerPath)
        return
      }
      throw error
    }

    if (!sameFile(ownerStat, canonicalStat)) {
      await this.fs.rm(ownerPath)
      return
    }

    const claimPath = join(this.root, `state.lock.claim-${identity}`)
    await this.fs.rename(this.lockPath, claimPath)
    const claimStat = await this.fs.stat(claimPath)
    const currentOwnerStat = await this.fs.stat(ownerPath)
    if (!sameFile(ownerStat, currentOwnerStat)) {
      await this.restoreForeignClaim(claimPath)
      throw new Error('Owned state lock identity path was replaced')
    }
    if (!sameFile(claimStat, currentOwnerStat)) {
      await this.restoreForeignClaim(claimPath)
      await this.fs.rm(ownerPath)
      return
    }

    try {
      await this.fs.rm(claimPath)
    } catch (error) {
      try {
        await this.fs.link(claimPath, this.lockPath)
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], 'Owned lock claim cleanup and restoration both failed')
      }
      throw error
    }
    await this.fs.rm(ownerPath)
  }

  private async restoreForeignClaim(claimPath: string): Promise<void> {
    try {
      await this.fs.link(claimPath, this.lockPath)
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
      const [claimStat, canonicalStat] = await Promise.all([
        this.fs.stat(claimPath),
        this.fs.stat(this.lockPath),
      ])
      if (!sameFile(claimStat, canonicalStat)) {
        throw new AggregateError([error], 'A foreign lock claim could not be restored without overwriting another lock')
      }
    }
    await this.fs.rm(claimPath)
  }
}
