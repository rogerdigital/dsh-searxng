import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FileJournalStore,
  type JournalStore,
  type OperationJournal,
  type OperationPhase,
  recommendRecovery,
  stateSha256,
} from '../../src/cli/journal.ts'

const STATE_HASH = 'a'.repeat(64)
const START = '2026-08-30T12:00:00.000Z'

type BeginInput = Parameters<JournalStore['begin']>[0]

function beginInput(overrides: Partial<BeginInput> = {}): BeginInput {
  return { kind: 'update', phase: 'prepared', beforeStateSha256: STATE_HASH, ...overrides }
}

function journalStore(root: string, ticks = 0): FileJournalStore {
  let tick = ticks
  return new FileJournalStore(root, {}, { now: () => new Date(Date.parse(START) + tick++ * 1000) })
}

async function journalArtifacts(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) =>
    name.includes('.tmp-') || name.includes('.backup-') || name.includes('.failed-'),
  )
}

async function writeJournalBytes(root: string, source: string | Buffer): Promise<void> {
  await writeFile(join(root, 'journal.json'), source, { mode: 0o600 })
}

const invalidJournals: ReadonlyArray<readonly [string, string | Buffer]> = [
  ['malformed bytes', Buffer.from([0, 255, 123, 34])],
  ['future schema', `${JSON.stringify({ ...journalFixture(), schemaVersion: 2 })}\n`],
  ['missing id', `${JSON.stringify((({ id: _id, ...rest }) => rest)(journalFixture()))}\n`],
  ['unknown kind', `${JSON.stringify({ ...journalFixture(), kind: 'deploy' })}\n`],
  ['unknown phase', `${JSON.stringify({ ...journalFixture(), phase: 'done' })}\n`],
  ['state hash not a digest', `${JSON.stringify({ ...journalFixture(), beforeStateSha256: 'not-a-digest' })}\n`],
  ['non-canonical timestamp', `${JSON.stringify({ ...journalFixture(), startedAt: '2026-08-30 12:00:00Z' })}\n`],
  ['extra field', `${JSON.stringify({ ...journalFixture(), secret: 'private' })}\n`],
  ['target without image', `${JSON.stringify({ ...journalFixture(), target: { deploymentVersion: 2 } })}\n`],
  ['target with non-positive version', `${JSON.stringify({ ...journalFixture(), target: { deploymentVersion: 0, image: 'searxng:latest' } })}\n`],
]

function journalFixture(phase: OperationPhase = 'prepared'): OperationJournal {
  return {
    schemaVersion: 1,
    id: 'a'.repeat(32),
    kind: 'update',
    phase,
    startedAt: START,
    updatedAt: START,
    beforeStateSha256: STATE_HASH,
  }
}

describe('JournalStore schema', () => {
  it('accepts a plain object as a JournalStore', async () => {
    const store: JournalStore = {
      read: async () => undefined,
      begin: async () => journalFixture(),
      transition: async (_id, phase) => journalFixture(phase),
      clear: async () => {},
    }
    await expect(store.read()).resolves.toBeUndefined()
    await expect(store.begin(beginInput())).resolves.toMatchObject({ schemaVersion: 1 })
    await expect(store.transition('id', 'mutating')).resolves.toMatchObject({ phase: 'mutating' })
    await expect(store.clear('id')).resolves.toBeUndefined()
  })
})

describe('FileJournalStore begin and read', () => {
  it('begins a prepared journal with a private file and round-trips it exactly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-journal-'))
    try {
      const store = journalStore(root)
      const journal = await store.begin(beginInput({ target: { deploymentVersion: 2, image: 'searxng:latest' } }))
      expect(journal).toEqual({
        ...journalFixture(),
        id: expect.stringMatching(/^[a-f0-9]{32}$/),
        target: { deploymentVersion: 2, image: 'searxng:latest' },
      })
      await expect(store.read()).resolves.toEqual(journal)
      const path = join(root, 'journal.json')
      await expect(readFile(path, 'utf8')).resolves.toBe(`${JSON.stringify(journal)}\n`)
      if (process.platform !== 'win32') {
        expect((await stat(path)).mode & 0o777).toBe(0o600)
      }
      // begin serializes nothing itself: no state.lock or other artifact.
      expect(await readdir(root)).toEqual(['journal.json'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('omits the optional target when begin has none', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-journal-'))
    try {
      const journal = await journalStore(root).begin(beginInput())
      expect('target' in journal).toBe(false)
      await expect(journalStore(root).read()).resolves.toEqual(journal)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns undefined without creating a missing managed directory', async () => {
    const root = join(tmpdir(), `dsh-journal-missing-${process.pid}-${Date.now()}`)
    await rm(root, { recursive: true, force: true })
    await expect(new FileJournalStore(root).read()).resolves.toBeUndefined()
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects begin when any journal is already recorded and preserves it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-journal-'))
    try {
      const store = journalStore(root)
      const existing = await store.begin(beginInput())
      const before = await readFile(join(root, 'journal.json'))
      await expect(store.begin(beginInput({ kind: 'repair' }))).rejects.toMatchObject({
        code: 'E_STATE_INVALID',
        action: expect.stringContaining('doctor'),
      })
      await expect(readFile(join(root, 'journal.json'))).resolves.toEqual(before)
      await expect(store.read()).resolves.toEqual(existing)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(invalidJournals)('surfaces an invalid journal (%s) and never overwrites it', async (_name, source) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-journal-'))
    const bytes = Buffer.from(source)
    try {
      await writeJournalBytes(root, bytes)
      const store = journalStore(root)
      await expect(store.read()).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
      await expect(store.begin(beginInput())).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
      await expect(readFile(join(root, 'journal.json'))).resolves.toEqual(bytes)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports journal read I/O failure without invalid-journal guidance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-journal-'))
    const secret = 'private-journal-path'
    try {
      const store = new FileJournalStore(root, { readFile: async () => { throw Object.assign(new Error(secret), { code: 'EACCES' }) } })
      let reported: unknown
      try { await store.read() } catch (error) { reported = error }
      expect(reported).toMatchObject({ code: 'E_INTERNAL', details: {} })
      await expect(store.begin(beginInput())).rejects.toMatchObject({ code: 'E_INTERNAL' })
      expect(JSON.stringify(reported)).not.toContain(secret)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('FileJournalStore transitions', () => {
  it('retains the operation id across phase transitions and persists each phase', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-journal-'))
    try {
      const store = journalStore(root)
      const began = await store.begin(beginInput())
      let journal = began
      for (const phase of ['mutating', 'validating', 'rolling-back'] as const) {
        journal = await store.transition(journal.id, phase)
        expect(journal.id).toBe(began.id)
        expect(journal.phase).toBe(phase)
        expect(journal.startedAt).toBe(began.startedAt)
      }
      expect(journal.updatedAt > began.startedAt).toBe(true)
      await expect(store.read()).resolves.toEqual(journal)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a transition with a mismatched id and preserves the journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-journal-'))
    try {
      const store = journalStore(root)
      const began = await store.begin(beginInput())
      await expect(store.transition('b'.repeat(32), 'mutating')).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
      await expect(store.read()).resolves.toEqual(began)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a transition when no journal is active', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-journal-'))
    try {
      await expect(journalStore(root).transition('a'.repeat(32), 'mutating')).rejects.toMatchObject({
        code: 'E_STATE_INVALID',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('FileJournalStore clear', () => {
  it('clears the recorded operation and leaves no artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-journal-'))
    try {
      const store = journalStore(root)
      const began = await store.begin(beginInput())
      await store.clear(began.id)
      await expect(store.read()).resolves.toBeUndefined()
      await expect(stat(join(root, 'journal.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readdir(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects clearing with a mismatched or absent journal and preserves evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-journal-'))
    try {
      const store = journalStore(root)
      const began = await store.begin(beginInput())
      await expect(store.clear('b'.repeat(32))).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
      await expect(store.read()).resolves.toEqual(began)

      const empty = journalStore(root)
      await empty.clear(began.id)
      await expect(store.clear(began.id)).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('FileJournalStore atomic writes', () => {
  it('leaves no journal and no artifacts when the temporary write fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-journal-'))
    try {
      const failing = new FileJournalStore(root, {
        open: (async () => { throw new Error('journal temp open failed') }) as typeof import('node:fs/promises').open,
      })
      await expect(failing.begin(beginInput())).rejects.toThrow('journal temp open failed')
      await expect(stat(join(root, 'journal.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(journalArtifacts(root)).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves the exact journal bytes when a transition commit fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-journal-'))
    const journalPath = join(root, 'journal.json')
    try {
      const store = journalStore(root)
      const began = await store.begin(beginInput())
      const before = await readFile(journalPath)
      const failing = new FileJournalStore(root, {
        rename: (async () => { throw new Error('journal commit rename failed') }) as typeof import('node:fs/promises').rename,
      }, { now: () => new Date('2026-08-30T12:01:00.000Z') })
      await expect(failing.transition(began.id, 'mutating')).rejects.toBeDefined()
      await expect(readFile(journalPath)).resolves.toEqual(before)
      await expect(journalArtifacts(root)).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('interrupted operation recovery', () => {
  it.each([
    ['prepared', 'clear-journal'],
    ['mutating', 'resume-rollback'],
    ['validating', 'validate-target-or-rollback'],
    ['rolling-back', 'resume-rollback'],
  ] as const)('maps an interrupted update in %s to %s', async (phase, action) => {
    const recommendation = recommendRecovery(journalFixture(phase))
    expect(recommendation.action).toBe(action)
    expect(recommendation.summary.length).toBeGreaterThan(0)
    expect(recommendation.summary).toMatch(/repair|doctor/)
  })

  it('derives the recommendation from journals read back from disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-journal-'))
    try {
      const store = journalStore(root)
      const began = await store.begin(beginInput())
      const interrupted = await store.transition(began.id, 'mutating')
      expect(recommendRecovery(interrupted).action).toBe('resume-rollback')
      expect(recommendRecovery((await store.read())!)).toEqual(recommendRecovery(interrupted))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('state hashing', () => {
  it('hashes the serialized pre-operation state with sha-256', () => {
    const state = { schemaVersion: 2, homeId: '0123456789abcdef', profiles: {} }
    const expected = createHash('sha256').update(JSON.stringify(state)).digest('hex')
    expect(stateSha256(state)).toBe(expected)
    expect(stateSha256(state)).toBe(stateSha256(structuredClone(state)))
    expect(expected).toMatch(/^[a-f0-9]{64}$/)
  })
})
