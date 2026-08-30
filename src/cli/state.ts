import { constants } from 'node:fs'
import { chmod, link, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { CliError } from './errors.ts'
import { assertValidProfile } from './environment.ts'

export interface StateV1 {
  schemaVersion: 1
  managed?: { deploymentVersion: 1; image: string; endpoint: string; port: number; homeId: string; projectName: string; containerName: string; lastHealthyAt: string }
  profiles: Record<string, { mode: 'managed' | 'external'; endpoint: string }>
}

const invalid = (message: string): CliError => new CliError('E_STATE_INVALID', message, 'Repair or remove the state file')
const exactKeys = (value: object, keys: readonly string[]): boolean => { const actual = Object.keys(value).sort(); return actual.length === keys.length && actual.every((key, i) => key === [...keys].sort()[i]) }
function endpoint(value: unknown): value is string { if (typeof value !== 'string') return false; try { const url = new URL(value); return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.search && !url.hash } catch { return false } }
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function validateState(value: unknown): asserts value is StateV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('State must be an object')
  const root = value as Record<string, unknown>
  if (root.schemaVersion !== 1 || !exactKeys(root, root.managed === undefined ? ['schemaVersion', 'profiles'] : ['schemaVersion', 'managed', 'profiles'])) throw invalid('Unsupported state schema')
  if (!root.profiles || typeof root.profiles !== 'object' || Array.isArray(root.profiles)) throw invalid('Invalid profiles')
  for (const [profile, entry] of Object.entries(root.profiles as Record<string, unknown>)) {
    try { assertValidProfile(profile) } catch { throw invalid('Invalid profile') }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !exactKeys(entry, ['mode', 'endpoint'])) throw invalid('Invalid profile state')
    const item = entry as Record<string, unknown>
    if ((item.mode !== 'managed' && item.mode !== 'external') || !endpoint(item.endpoint)) throw invalid('Invalid profile state')
  }
  if (root.managed !== undefined) {
    const managed = root.managed
    if (!managed || typeof managed !== 'object' || Array.isArray(managed) || !exactKeys(managed, ['deploymentVersion', 'image', 'endpoint', 'port', 'homeId', 'projectName', 'containerName', 'lastHealthyAt'])) throw invalid('Invalid managed state')
    const item = managed as Record<string, unknown>
    const timestamp = item.lastHealthyAt
    const validTimestamp = typeof timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) && !Number.isNaN(Date.parse(timestamp)) && new Date(timestamp).toISOString() === timestamp
    if (item.deploymentVersion !== 1 || !nonEmpty(item.image) || !endpoint(item.endpoint) || !Number.isSafeInteger(item.port) || (item.port as number) < 1 || (item.port as number) > 65535 || typeof item.homeId !== 'string' || !/^[0-9a-f]{16}$/.test(item.homeId) || !nonEmpty(item.projectName) || !nonEmpty(item.containerName) || !validTimestamp) throw invalid('Invalid managed state')
  }
}

interface FsFacade {
  mkdir: typeof mkdir; open: typeof open; readFile: typeof readFile; rename: typeof rename; rm: typeof rm; chmod: typeof chmod; stat: typeof stat; link: typeof link
}
const realFs: FsFacade = { mkdir, open, readFile, rename, rm, chmod, stat, link }

export class StateStore {
  private readonly root: string; private readonly fs: FsFacade; private readonly statePath: string; private readonly lockPath: string
  constructor(managedDirectory: string, fsFacade: Partial<FsFacade> = {}) { this.root = managedDirectory; this.fs = { ...realFs, ...fsFacade }; this.statePath = join(managedDirectory, 'state.json'); this.lockPath = join(managedDirectory, 'state.lock') }
  async read(): Promise<StateV1> {
    let text: string
    try { text = await this.fs.readFile(this.statePath, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, profiles: {} }; throw invalid('Unable to read state') }
    let parsed: unknown; try { parsed = JSON.parse(text) } catch { throw invalid('State JSON is malformed') }
    validateState(parsed); return parsed
  }
  async write(state: StateV1): Promise<void> {
    validateState(state)
    await this.fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    const temp = `${this.statePath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
    const backup = `${this.statePath}.backup-${process.pid}-${randomBytes(8).toString('hex')}`
    const failed = `${this.statePath}.failed-${process.pid}-${randomBytes(8).toString('hex')}`
    let handle: FileHandle | undefined
    let originalExists = true
    try { await this.fs.link(this.statePath, backup) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') originalExists = false; else throw error }
    let replaced = false
    try {
      handle = await this.fs.open(temp, 'wx', 0o600)
      await handle.writeFile(JSON.stringify(state) + '\n', 'utf8'); await handle.sync(); await handle.close(); handle = undefined
      await this.fs.chmod(temp, 0o600)
      await this.fs.rename(temp, this.statePath); replaced = true
      if (process.platform !== 'win32') { const dir = await this.fs.open(this.root, constants.O_RDONLY); try { await dir.sync() } finally { await dir.close() } }
    } catch (error) {
      try { await handle?.close() } catch {}
      try { await this.fs.rm(temp, { force: true }) } catch {}
      if (replaced && originalExists) {
        try { await this.fs.rename(backup, this.statePath) } catch {}
      } else if (replaced) {
        try { await this.fs.rename(this.statePath, failed); await this.fs.rm(failed, { force: true }) } catch {}
      }
      try { await this.fs.rm(backup, { force: true }) } catch {}
      throw error
    }
    try { if (originalExists) await this.fs.rm(backup, { force: true }) } catch {}
  }
  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    const identity = randomBytes(16).toString('hex'); const ownerPath = join(this.root, `state.lock.owner-${identity}`); let handle: FileHandle | undefined
    let acquired = false
    try {
      handle = await this.fs.open(ownerPath, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString(), identity }) + '\n', 'utf8'); await handle.sync(); await handle.close(); handle = undefined
      await this.fs.link(ownerPath, this.lockPath); acquired = true
    } catch (error) {
      try { await handle?.close() } catch {}
      if (acquired) await this.releaseLock(identity, ownerPath)
      else try { await this.fs.rm(ownerPath, { force: true }) } catch {}
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' && !acquired) throw new CliError('E_STATE_INVALID', 'State is locked', 'Wait and retry')
      throw error
    }
    try { return await operation() } finally { await this.releaseLock(identity, ownerPath) }
  }
  private async releaseLock(identity: string, ownerPath: string): Promise<void> {
    const claim = `${this.lockPath}.claim-${identity}`
    try { await this.fs.rename(this.lockPath, claim) } catch { try { await this.fs.rm(ownerPath, { force: true }) } catch {}; return }
    try {
      const current = await this.fs.readFile(claim, 'utf8'); const parsed = JSON.parse(current) as { identity?: string }
      if (parsed.identity === identity) await this.fs.rm(claim, { force: true })
      else { try { await this.fs.link(claim, this.lockPath) } catch {} ; if (!(await this.fs.readFile(this.lockPath, 'utf8').catch(() => ''))) await this.fs.rm(claim, { force: true }) }
    } catch {}
    try { await this.fs.rm(ownerPath, { force: true }) } catch {}
  }
}
