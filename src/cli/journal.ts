import { createHash, randomBytes } from 'node:crypto'
import { chmod, link, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CliError } from './errors.ts'
import {
  type AtomicWriteFs,
  exactKeys,
  isCanonicalTimestamp,
  isNonEmptyString,
  writeAtomicFile,
} from './state.ts'

export type OperationKind = 'setup' | 'repair' | 'update' | 'remove'
export type OperationPhase = 'prepared' | 'mutating' | 'validating' | 'rolling-back'

export interface OperationJournal {
  schemaVersion: 1
  id: string
  kind: OperationKind
  phase: OperationPhase
  startedAt: string
  updatedAt: string
  beforeStateSha256: string
  target?: { deploymentVersion: number; image: string }
}

/**
 * Durable operation journal contract. `begin`, `transition`, and `clear`
 * perform no serialization of their own: they MUST only be called while
 * holding the associated StateStore lock. The store is not reentrant.
 * (`read` is safe anywhere — it is how doctor inspects an interrupted
 * operation without mutating anything.)
 */
export interface JournalStore {
  read(): Promise<OperationJournal | undefined>
  begin(input: Omit<OperationJournal, 'schemaVersion' | 'id' | 'startedAt' | 'updatedAt'>): Promise<OperationJournal>
  transition(id: string, phase: OperationPhase): Promise<OperationJournal>
  clear(id: string): Promise<void>
}

/** Recovery guidance for an interrupted operation, derived only from its recorded phase. */
export interface RecoveryRecommendation {
  action: 'clear-journal' | 'resume-rollback' | 'validate-target-or-rollback'
  summary: string
}

const RECOVERY_RECOMMENDATIONS: Readonly<Record<OperationPhase, RecoveryRecommendation>> = {
  prepared: {
    action: 'clear-journal',
    summary: 'No managed resources were mutated; run dsh-searxng repair to clear the journal',
  },
  mutating: {
    action: 'resume-rollback',
    summary: 'Managed resources may be partially mutated; run dsh-searxng repair to roll back to the recorded state',
  },
  validating: {
    action: 'validate-target-or-rollback',
    summary: 'The target deployment may be active but unvalidated; run dsh-searxng repair to validate it or roll back',
  },
  'rolling-back': {
    action: 'resume-rollback',
    summary: 'Rollback was interrupted; run dsh-searxng repair to resume it and validate the previous deployment',
  },
}

export function recommendRecovery(journal: OperationJournal): RecoveryRecommendation {
  return RECOVERY_RECOMMENDATIONS[journal.phase]
}

/**
 * SHA-256 of the canonical state serialization; digests only, never secrets.
 * The hash input is `JSON.stringify(state)` with NO trailing newline (state
 * file bytes have one), so recovery code re-deriving a digest from disk must
 * hash `JSON.stringify(JSON.parse(bytes))` and never the raw file bytes.
 */
export function stateSha256(state: unknown): string {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex')
}

interface JournalFs extends AtomicWriteFs {
  readFile: typeof readFile
}

const realJournalFs: JournalFs = { mkdir, open, rename, rm, chmod, link, readFile }

function journalInvalid(message: string): CliError {
  return new CliError(
    'E_STATE_INVALID',
    message,
    'Run dsh-searxng doctor and follow the interrupted-operation guidance',
  )
}

function journalOccupied(): CliError {
  return new CliError(
    'E_STATE_INVALID',
    'An interrupted operation is recorded in the journal',
    'Run dsh-searxng doctor and follow the interrupted-operation guidance',
  )
}

function journalReadFailed(): CliError {
  return new CliError(
    'E_INTERNAL',
    'Unable to read the operation journal',
    'Check the managed directory permissions and file type, then retry',
  )
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

const OPERATION_KINDS: readonly string[] = ['setup', 'repair', 'update', 'remove']
const OPERATION_PHASES: readonly string[] = ['prepared', 'mutating', 'validating', 'rolling-back']

function isOperationKind(value: unknown): value is OperationKind {
  return typeof value === 'string' && OPERATION_KINDS.includes(value)
}

function isOperationPhase(value: unknown): value is OperationPhase {
  return typeof value === 'string' && OPERATION_PHASES.includes(value)
}

function validateJournal(value: unknown): asserts value is OperationJournal {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw journalInvalid('Journal must be an object')
  const journal = value as Record<string, unknown>
  const keys = ['schemaVersion', 'id', 'kind', 'phase', 'startedAt', 'updatedAt', 'beforeStateSha256']
  if (journal.target !== undefined) keys.push('target')
  if (journal.schemaVersion !== 1 || !exactKeys(journal, keys)) throw journalInvalid('Unsupported journal schema')
  if (
    typeof journal.id !== 'string' ||
    !/^[a-f0-9]{32}$/.test(journal.id) ||
    !isOperationKind(journal.kind) ||
    !isOperationPhase(journal.phase) ||
    !isCanonicalTimestamp(journal.startedAt) ||
    !isCanonicalTimestamp(journal.updatedAt) ||
    typeof journal.beforeStateSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(journal.beforeStateSha256)
  ) {
    throw journalInvalid('Invalid journal operation')
  }
  if (journal.target === undefined) return
  if (
    journal.target === null ||
    typeof journal.target !== 'object' ||
    Array.isArray(journal.target) ||
    !exactKeys(journal.target, ['deploymentVersion', 'image'])
  ) {
    throw journalInvalid('Invalid journal target')
  }
  const target = journal.target as Record<string, unknown>
  if (
    !Number.isSafeInteger(target.deploymentVersion) ||
    (target.deploymentVersion as number) < 1 ||
    !isNonEmptyString(target.image)
  ) {
    throw journalInvalid('Invalid journal target')
  }
}

export interface FileJournalStoreOptions {
  now?: () => Date
}

/**
 * Durable operation journal stored as `journal.json` beside the state file.
 * A journal exists exactly while an operation is between its first mutation
 * and its validated completion; only doctor and repair may inspect or clear
 * an interrupted journal. `begin` refuses to overwrite any journal, including
 * an invalid one, and every write reuses the state store's atomic replace.
 */
export class FileJournalStore implements JournalStore {
  private readonly root: string
  private readonly fs: JournalFs
  private readonly now: () => Date
  private readonly journalPath: string

  constructor(managedDirectory: string, fsFacade: Partial<JournalFs> = {}, options: FileJournalStoreOptions = {}) {
    this.root = managedDirectory
    this.fs = { ...realJournalFs, ...fsFacade }
    this.now = options.now ?? (() => new Date())
    this.journalPath = join(managedDirectory, 'journal.json')
  }

  async read(): Promise<OperationJournal | undefined> {
    let source: string
    try {
      source = await this.fs.readFile(this.journalPath, 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined
      throw journalReadFailed()
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch {
      throw journalInvalid('Journal JSON is malformed')
    }
    validateJournal(parsed)
    return parsed
  }

  async begin(
    input: Omit<OperationJournal, 'schemaVersion' | 'id' | 'startedAt' | 'updatedAt'>,
  ): Promise<OperationJournal> {
    if (await this.read() !== undefined) throw journalOccupied()
    const startedAt = this.timestamp()
    const journal: OperationJournal = {
      schemaVersion: 1,
      id: randomBytes(16).toString('hex'),
      kind: input.kind,
      phase: input.phase,
      startedAt,
      updatedAt: startedAt,
      beforeStateSha256: input.beforeStateSha256,
      ...(input.target === undefined ? {} : { target: input.target }),
    }
    validateJournal(journal)
    await this.persist(journal)
    return journal
  }

  async transition(id: string, phase: OperationPhase): Promise<OperationJournal> {
    const current = await this.requireActive(id)
    const journal: OperationJournal = { ...current, phase, updatedAt: this.timestamp() }
    validateJournal(journal)
    await this.persist(journal)
    return journal
  }

  async clear(id: string): Promise<void> {
    await this.requireActive(id)
    await this.fs.rm(this.journalPath)
  }

  private async requireActive(id: string): Promise<OperationJournal> {
    const current = await this.read()
    if (current === undefined) throw journalInvalid('No journal operation is active')
    if (current.id !== id) throw journalInvalid('The journal operation is no longer active')
    return current
  }

  private async persist(journal: OperationJournal): Promise<void> {
    await writeAtomicFile(this.fs, this.root, this.journalPath, `${JSON.stringify(journal)}\n`)
  }

  private timestamp(): string {
    const timestamp = this.now().toISOString()
    if (!isCanonicalTimestamp(timestamp)) {
      throw new CliError('E_INTERNAL', 'Operation journal clock is invalid', 'Check the system clock and retry')
    }
    return timestamp
  }
}
