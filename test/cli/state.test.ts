import { describe, expect, it } from 'vitest'
import { chmod as fsChmod, mkdtemp, open as fsOpen, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore, type StateV1 } from '../../src/cli/state.ts'

const valid: StateV1 = { schemaVersion: 1, profiles: { web: { mode: 'managed', endpoint: 'http://127.0.0.1:8080' } } }
const populated: StateV1 = { schemaVersion: 1, managed: { deploymentVersion: 1, image: 'searxng:latest', endpoint: 'http://127.0.0.1:8080', port: 8080, homeId: '0123456789abcdef', projectName: 'dsh-searxng-web', containerName: 'dsh-searxng-web-1', lastHealthyAt: '2026-08-30T12:00:00.000Z' }, profiles: { web: { mode: 'managed', endpoint: 'http://127.0.0.1:8080' }, external: { mode: 'external', endpoint: 'https://search.example' } } }

describe('StateStore', () => {
  it('returns an in-memory empty state when missing and round-trips valid state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    try {
      const store = new StateStore(root)
      await expect(store.read()).resolves.toEqual({ schemaVersion: 1, profiles: {} })
      await store.write(valid)
      await expect(store.read()).resolves.toEqual(valid)
      expect((await stat(join(root, 'state.json'))).mode & 0o777).toBe(0o600)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects malformed or unknown state without changing bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-')); const path = join(root, 'state.json')
    try {
      const bytes = '{"schemaVersion":99,"profiles":{'
      await writeFile(path, bytes)
      await expect(new StateStore(root).read()).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
      await expect(readFile(path, 'utf8')).resolves.toBe(bytes)
      await expect(new StateStore(root).write({ schemaVersion: 2 } as never)).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
      await expect(readFile(path, 'utf8')).resolves.toBe(bytes)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('round-trips a fully populated managed object with exact fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-')); try { const store = new StateStore(root); await store.write(populated); expect(await store.read()).toEqual(populated) } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.each([
    ['future schema', { schemaVersion: 2, profiles: {} }],
    ['invalid port', { ...populated, managed: { ...populated.managed!, port: 0 } }],
    ['invalid URL', { ...populated, profiles: { web: { mode: 'managed', endpoint: 'not-url' } } }],
    ['invalid timestamp', { ...populated, managed: { ...populated.managed!, lastHealthyAt: 'tomorrow' } }],
    ['invalid mode', { ...populated, profiles: { web: { mode: 'other', endpoint: 'http://localhost' } } }],
    ['missing required field', { ...populated, managed: { ...populated.managed!, image: undefined } }],
    ['extra root field', { ...populated, extra: true }],
    ['extra managed field', { ...populated, managed: { ...populated.managed!, extra: true } }],
    ['extra profile field', { ...populated, profiles: { web: { ...populated.profiles.web, extra: true } } }],
  ])('rejects %s schema', async (_name, value) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-')); try { await writeFile(join(root, 'state.json'), JSON.stringify(value)); await expect(new StateStore(root).read()).rejects.toMatchObject({ code: 'E_STATE_INVALID' }) } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('missing state returns empty without filesystem mutation', async () => {
    const root = join(tmpdir(), `dsh-state-missing-${process.pid}-${Date.now()}`); await rm(root, { recursive: true, force: true });
    await expect(new StateStore(root).read()).resolves.toEqual({ schemaVersion: 1, profiles: {} }); await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans temporary output and preserves original bytes when finalization fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-')); const path = join(root, 'state.json'); const original = '{"schemaVersion":1,"profiles":{}}\n'
    await writeFile(path, original, { mode: 0o600 })
    try {
      const store = new StateStore(root, { open: async (...args: Parameters<typeof fsOpen>) => { if (args[0] === root) throw new Error('directory open failed'); return fsOpen(...args) } })
      await expect(store.write(valid)).rejects.toThrow('directory open failed')
      await expect(readFile(path, 'utf8')).resolves.toBe(original)
      expect((await readdir(root)).filter((name) => name.includes('.tmp-') || name.includes('.rollback-'))).toHaveLength(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('surfaces lock I/O failures and does not remove a pre-existing foreign lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-')); const lock = join(root, 'state.lock')
    try {
      const error = Object.assign(new Error('permission denied'), { code: 'EACCES' })
      await expect(new StateStore(root, { open: async (...args: Parameters<typeof fsOpen>) => { if (String(args[0]).includes('state.lock.owner-')) throw error; return fsOpen(...args) } }).withLock(async () => 1)).rejects.toMatchObject({ code: 'EACCES' })
      await expect(readFile(lock, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('serializes concurrent operations and releases its lock after throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-')); const store = new StateStore(root)
    try {
      let release!: () => void
      const held = new Promise<void>((resolve) => { release = resolve })
      const first = store.withLock(async () => { await held; return 1 })
      for (let attempt = 0; attempt < 20; attempt++) {
        try { await stat(join(root, 'state.lock')); break } catch { await new Promise((resolve) => setTimeout(resolve, 1)) }
      }
      await expect(store.withLock(async () => 2)).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
      release(); await expect(first).resolves.toBe(1)
      await expect(store.withLock(async () => { throw new Error('boom') })).rejects.toThrow('boom')
      await expect(store.withLock(async () => 3)).resolves.toBe(3)
      expect((await readdir(root)).filter((name) => name.startsWith('state.lock.owner-') || name.includes('.claim-'))).toHaveLength(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
