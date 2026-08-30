import { constants } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import {
  chmod,
  link as fsLink,
  mkdtemp,
  open as fsOpen,
  readFile,
  readdir,
  rename as fsRename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { StateStore, type StateV1 } from '../../src/cli/state.ts'

const valid: StateV1 = {
  schemaVersion: 1,
  profiles: { web: { mode: 'managed', endpoint: 'http://127.0.0.1:8080' } },
}

const populated: StateV1 = {
  schemaVersion: 1,
  managed: {
    deploymentVersion: 1,
    image: 'searxng:latest',
    endpoint: 'http://127.0.0.1:8080',
    port: 8080,
    homeId: '0123456789abcdef',
    projectName: 'dsh-searxng-web',
    containerName: 'dsh-searxng-web-1',
    lastHealthyAt: '2026-08-30T12:00:00.000Z',
  },
  profiles: {
    web: { mode: 'managed', endpoint: 'http://127.0.0.1:8080' },
    external: { mode: 'external', endpoint: 'https://search.example' },
  },
}

type HandleMethod = 'writeFile' | 'readFile' | 'stat' | 'sync' | 'close'

function wrappedHandle(
  handle: FileHandle,
  overrides: Partial<Record<HandleMethod, (...args: unknown[]) => Promise<unknown>>>,
): FileHandle {
  return new Proxy(handle, {
    get(target, property) {
      if (typeof property === 'string' && property in overrides) return overrides[property as HandleMethod]
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function injectedOpen(
  inject: (path: string, flags: string | number, handle: FileHandle) => FileHandle,
): typeof fsOpen {
  return (async (...args: Parameters<typeof fsOpen>) => {
    const handle = await fsOpen(...args)
    return inject(String(args[0]), args[1]!, handle)
  }) as typeof fsOpen
}

async function transactionArtifacts(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) =>
    name.includes('.tmp-') || name.includes('.backup-') || name.includes('.failed-'),
  )
}

async function lockArtifacts(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) =>
    name === 'state.lock' || name.startsWith('state.lock.release-'),
  )
}

function errorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.flatMap((item) => errorMessages(item))]
  }
  return [error instanceof Error ? error.message : String(error)]
}

async function expectAggregate(promise: Promise<unknown>, fragments: readonly string[]): Promise<void> {
  try {
    await promise
    throw new Error('expected rejection')
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError)
    const messages = errorMessages(error).join('\n')
    for (const fragment of fragments) expect(messages).toContain(fragment)
  }
}

describe('StateStore schema', () => {
  it('returns an in-memory empty state without creating its missing directory', async () => {
    const root = join(tmpdir(), `dsh-state-missing-${process.pid}-${Date.now()}`)
    await rm(root, { recursive: true, force: true })
    await expect(new StateStore(root).read()).resolves.toEqual({ schemaVersion: 1, profiles: {} })
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('round-trips the exact populated StateV1 schema with a user-only state file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    try {
      const store = new StateStore(root)
      await store.write(populated)
      await expect(store.read()).resolves.toEqual(populated)
      expect((await stat(join(root, 'state.json'))).mode & 0o777).toBe(0o600)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['future schema', { schemaVersion: 2, profiles: {} }],
    ['missing profiles', { schemaVersion: 1 }],
    ['non-object profiles', { schemaVersion: 1, profiles: [] }],
    ['managed endpoint missing', { ...populated, managed: { ...populated.managed!, endpoint: undefined } }],
    ['managed endpoint empty', { ...populated, managed: { ...populated.managed!, endpoint: '' } }],
    ['managed endpoint invalid', { ...populated, managed: { ...populated.managed!, endpoint: 'file:///tmp/search' } }],
    ['deployment version invalid', { ...populated, managed: { ...populated.managed!, deploymentVersion: 2 } }],
    ['managed port invalid', { ...populated, managed: { ...populated.managed!, port: 0 } }],
    ['managed home id invalid', { ...populated, managed: { ...populated.managed!, homeId: 'not-a-home-id' } }],
    ['managed image empty', { ...populated, managed: { ...populated.managed!, image: '' } }],
    ['managed project empty', { ...populated, managed: { ...populated.managed!, projectName: '' } }],
    ['managed container empty', { ...populated, managed: { ...populated.managed!, containerName: '' } }],
    ['managed timestamp invalid', { ...populated, managed: { ...populated.managed!, lastHealthyAt: 'tomorrow' } }],
    ['profile endpoint invalid', { ...populated, profiles: { web: { mode: 'managed', endpoint: 'not-url' } } }],
    ['profile mode invalid', { ...populated, profiles: { web: { mode: 'other', endpoint: 'http://localhost' } } }],
    ['profile name empty', { ...populated, profiles: { '': valid.profiles.web } }],
    ['profile name dot', { ...populated, profiles: { '.': valid.profiles.web } }],
    ['profile name dot-dot', { ...populated, profiles: { '..': valid.profiles.web } }],
    ['profile name slash', { ...populated, profiles: { 'a/b': valid.profiles.web } }],
    ['profile name backslash', { ...populated, profiles: { 'a\\b': valid.profiles.web } }],
    ['extra root field', { ...populated, extra: true }],
    ['extra managed field', { ...populated, managed: { ...populated.managed!, extra: true } }],
    ['extra profile field', { ...populated, profiles: { web: { ...populated.profiles.web, extra: true } } }],
  ])('rejects %s while preserving the exact source bytes', async (_name, value) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const statePath = join(root, 'state.json')
    const source = Buffer.from(` \n${JSON.stringify(value)}\n `)
    try {
      await writeFile(statePath, source)
      await expect(new StateStore(root).read()).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
      await expect(readFile(statePath)).resolves.toEqual(source)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects malformed arbitrary bytes without changing them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const statePath = join(root, 'state.json')
    const source = Buffer.from([0, 255, 123, 34, 120, 34, 58])
    try {
      await writeFile(statePath, source)
      await expect(new StateStore(root).read()).rejects.toMatchObject({ code: 'E_STATE_INVALID' })
      await expect(readFile(statePath)).resolves.toEqual(source)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('StateStore atomic write', () => {
  async function preservesOriginalWhen(
    createFacade: (root: string, statePath: string) => ConstructorParameters<typeof StateStore>[1],
  ): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const statePath = join(root, 'state.json')
    const original = Buffer.from([0, 255, 1, 2, 3, 10])
    await writeFile(statePath, original, { mode: 0o600 })
    try {
      await expect(new StateStore(root, createFacade(root, statePath)).write(valid)).rejects.toBeDefined()
      await expect(readFile(statePath)).resolves.toEqual(original)
      await expect(transactionArtifacts(root)).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  it.each([
    ['write', 'writeFile'],
    ['fsync', 'sync'],
  ] as const)('preserves exact original bytes when temporary %s fails', async (_name, method) => {
    await preservesOriginalWhen(() => ({
      open: injectedOpen((path, _flags, handle) => path.includes('.tmp-')
        ? wrappedHandle(handle, { [method]: async () => { throw new Error(`temp ${method} failed`) } })
        : handle),
    }))
  })

  it('preserves exact original bytes when the temporary close fails', async () => {
    await preservesOriginalWhen(() => ({
      open: injectedOpen((path, _flags, handle) => {
        if (!path.includes('.tmp-')) return handle
        let first = true
        return wrappedHandle(handle, { close: async () => {
          if (!first) return handle.close()
          first = false
          await handle.close()
          throw new Error('temp close failed')
        } })
      }),
    }))
  })

  it('preserves exact original bytes when the commit rename fails', async () => {
    await preservesOriginalWhen((_root, statePath) => ({
      rename: (async (from: string, to: string) => {
        if (from.includes('.tmp-') && to === statePath) throw new Error('commit rename failed')
        return fsRename(from, to)
      }) as typeof fsRename,
    }))
  })

  it.each(['open', 'sync'] as const)('rolls back and fsyncs after commit directory %s fails', async (failure) => {
    let attempts = 0
    await preservesOriginalWhen((root) => ({
      open: (async (...args: Parameters<typeof fsOpen>) => {
        if (String(args[0]) === root && args[1] === constants.O_RDONLY) {
          attempts += 1
          if (attempts === 1 && failure === 'open') throw new Error('directory open failed')
        }
        const handle = await fsOpen(...args)
        if (String(args[0]) === root && args[1] === constants.O_RDONLY && failure === 'sync') {
          return wrappedHandle(handle, { sync: async () => {
            if (attempts === 1) throw new Error('directory sync failed')
            return handle.sync()
          } })
        }
        return handle
      }) as typeof fsOpen,
    }))
    expect(attempts).toBe(2)
  })

  it('restores original absence when commit directory fsync fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const statePath = join(root, 'state.json')
    let syncs = 0
    try {
      const store = new StateStore(root, { open: injectedOpen((path, flags, handle) => {
        if (path !== root || flags !== constants.O_RDONLY) return handle
        return wrappedHandle(handle, { sync: async () => {
          syncs += 1
          if (syncs === 1) throw new Error('commit directory sync failed')
          return handle.sync()
        } })
      }) })
      await expect(store.write(valid)).rejects.toThrow('commit directory sync failed')
      await expect(readFile(statePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(transactionArtifacts(root)).resolves.toEqual([])
      expect(syncs).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retains the only backup and reports rollback restoration failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const statePath = join(root, 'state.json')
    const original = Buffer.from([222, 173, 190, 239])
    await writeFile(statePath, original, { mode: 0o600 })
    let syncs = 0
    try {
      const store = new StateStore(root, {
        open: injectedOpen((path, flags, handle) => path === root && flags === constants.O_RDONLY
          ? wrappedHandle(handle, { sync: async () => {
            syncs += 1
            if (syncs === 1) throw new Error('commit directory sync failed')
            return handle.sync()
          } })
          : handle),
        link: (async (from: string, to: string) => {
          if (from.includes('.backup-') && to === statePath) throw new Error('rollback restore failed')
          return fsLink(from, to)
        }) as typeof fsLink,
      })
      await expectAggregate(store.write(valid), ['commit directory sync failed', 'rollback restore failed'])
      const backup = (await transactionArtifacts(root)).find((name) => name.includes('.backup-'))
      expect(backup).toBeDefined()
      await expect(readFile(join(root, backup!))).resolves.toEqual(original)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['backup', '.backup-'],
    ['temporary', '.tmp-'],
  ] as const)('reports %s cleanup failure explicitly', async (_name, marker) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const statePath = join(root, 'state.json')
    const original = Buffer.from('original state bytes')
    await writeFile(statePath, original, { mode: 0o600 })
    try {
      const store = new StateStore(root, {
        ...(marker === '.tmp-' ? {
          open: injectedOpen((path, _flags, handle) => path.includes('.tmp-')
            ? wrappedHandle(handle, { writeFile: async () => { throw new Error('temp write failed') } })
            : handle),
        } : {}),
        rm: (async (path: string, options?: Parameters<typeof rm>[1]) => {
          if (path.includes(marker)) throw new Error(`${marker} cleanup failed`)
          return rm(path, options)
        }) as typeof rm,
      })
      await expectAggregate(store.write(valid), [`${marker} cleanup failed`])
      await expect(readFile(statePath)).resolves.toEqual(original)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('StateStore exclusive lock', () => {
  it('uses a direct 0600 identity lock in a 0700 managed directory and leaves no artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const lockPath = join(root, 'state.lock')
    await chmod(root, 0o777)
    try {
      await expect(new StateStore(root).withLock(async () => {
        expect((await stat(root)).mode & 0o777).toBe(0o700)
        expect((await stat(lockPath)).mode & 0o777).toBe(0o600)
        const metadata = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>
        expect(Object.keys(metadata).sort()).toEqual(['identity', 'pid', 'timestamp'])
        expect(metadata.pid).toBe(process.pid)
        expect(metadata.identity).toMatch(/^[a-f0-9]{32}$/)
        expect(new Date(String(metadata.timestamp)).toISOString()).toBe(metadata.timestamp)
        return 42
      })).resolves.toBe(42)
      await expect(lockArtifacts(root)).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a concurrent holder with wait-and-retry guidance and releases in finally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const store = new StateStore(root)
    let finish!: () => void
    const held = new Promise<void>((resolve) => { finish = resolve })
    try {
      const first = store.withLock(async () => { await held; return 'first' })
      while (!(await readdir(root)).includes('state.lock')) await new Promise((resolve) => setTimeout(resolve, 1))
      await expect(store.withLock(async () => 'second')).rejects.toMatchObject({
        code: 'E_STATE_INVALID', action: 'Wait and retry',
      })
      finish()
      await expect(first).resolves.toBe('first')
      await expect(store.withLock(async () => { throw new Error('operation failed') })).rejects.toThrow('operation failed')
      await expect(store.withLock(async () => 'next')).resolves.toBe('next')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never breaks or changes a stale foreign canonical lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const lockPath = join(root, 'state.lock')
    const foreign = Buffer.from('stale foreign lock')
    await writeFile(lockPath, foreign, { mode: 0o600 })
    try {
      await expect(new StateStore(root).withLock(async () => undefined)).rejects.toMatchObject({
        code: 'E_STATE_INVALID', action: 'Wait and retry',
      })
      await expect(readFile(lockPath)).resolves.toEqual(foreign)
      expect((await readdir(root)).filter((name) => name.startsWith('state.lock.release-'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['same-token foreign inode', 'malformed foreign'] as const)(
    'restores a canonical replacement before release: %s',
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
      const lockPath = join(root, 'state.lock')
      let foreign: Buffer | undefined
      try {
        const store = new StateStore(root, {
          rename: (async (from: string, to: string) => {
            if (from === lockPath && to.includes('state.lock.release-') && foreign === undefined) {
              foreign = kind === 'same-token foreign inode' ? await readFile(from) : Buffer.from('not-json')
              await rm(from)
              await writeFile(from, foreign, { mode: 0o600 })
            }
            return fsRename(from, to)
          }) as typeof fsRename,
        })
        await expect(store.withLock(async () => 'done')).resolves.toBe('done')
        await expect(readFile(lockPath)).resolves.toEqual(foreign)
        expect((await readdir(root)).filter((name) => name.startsWith('state.lock.release-'))).toEqual([])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('preserves quarantine and conflicting canonical when foreign restore cannot link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const lockPath = join(root, 'state.lock')
    const foreign = Buffer.from('foreign candidate')
    const conflict = Buffer.from('new canonical conflict')
    let replaced = false
    try {
      const store = new StateStore(root, {
        rename: (async (from: string, to: string) => {
          if (from === lockPath && to.includes('state.lock.release-') && !replaced) {
            await rm(from)
            await writeFile(from, foreign)
            replaced = true
          }
          const result = await fsRename(from, to)
          if (to.includes('state.lock.release-')) await writeFile(lockPath, conflict)
          return result
        }) as typeof fsRename,
      })
      await expect(store.withLock(async () => 'done')).rejects.toBeDefined()
      await expect(readFile(lockPath)).resolves.toEqual(conflict)
      const release = (await readdir(root)).find((name) => name.startsWith('state.lock.release-'))
      expect(release).toBeDefined()
      await expect(readFile(join(root, release!))).resolves.toEqual(foreign)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['open', 'read', 'fstat', 'close'] as const)(
    'restores canonical and preserves quarantine when release verification %s fails',
    async (failure) => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
      const lockPath = join(root, 'state.lock')
      try {
        const open = (async (...args: Parameters<typeof fsOpen>) => {
          const path = String(args[0])
          if (path.includes('state.lock.release-') && failure === 'open') throw new Error('release open failed')
          const handle = await fsOpen(...args)
          if (!path.includes('state.lock.release-')) return handle
          return wrappedHandle(handle, {
            ...(failure === 'read' ? { readFile: async () => { throw new Error('release read failed') } } : {}),
            ...(failure === 'fstat' ? { stat: async () => { throw new Error('release fstat failed') } } : {}),
            ...(failure === 'close' ? { close: async () => {
              await handle.close()
              throw new Error('release close failed')
            } } : {}),
          })
        }) as typeof fsOpen
        await expect(new StateStore(root, { open }).withLock(async () => 'done')).rejects.toBeDefined()
        await expect(readFile(lockPath, 'utf8')).resolves.toContain('"identity"')
        expect((await readdir(root)).some((name) => name.startsWith('state.lock.release-'))).toBe(true)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it.each(['write', 'sync', 'fstat', 'close'] as const)(
    'surfaces acquisition %s failure and performs safe cleanup',
    async (failure) => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
      try {
        const open = injectedOpen((path, flags, handle) => {
          if (path !== join(root, 'state.lock') || flags !== 'wx') return handle
          return wrappedHandle(handle, {
            ...(failure === 'write' ? { writeFile: async () => { throw new Error('acquire write failed') } } : {}),
            ...(failure === 'sync' ? { sync: async () => { throw new Error('acquire sync failed') } } : {}),
            ...(failure === 'fstat' ? { stat: async () => { throw new Error('acquire fstat failed') } } : {}),
            ...(failure === 'close' ? { close: async () => {
              await handle.close()
              throw new Error('acquire close failed')
            } } : {}),
          })
        })
        await expect(new StateStore(root, { open }).withLock(async () => undefined)).rejects.toBeDefined()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('reports release rename and removal failures without deleting evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const lockPath = join(root, 'state.lock')
    try {
      const renameFailure = new StateStore(root, { rename: (async (from: string, to: string) => {
        if (from === lockPath && to.includes('state.lock.release-')) throw new Error('release rename failed')
        return fsRename(from, to)
      }) as typeof fsRename })
      await expect(renameFailure.withLock(async () => 'done')).rejects.toThrow('release rename failed')
      await expect(readFile(lockPath, 'utf8')).resolves.toContain('"identity"')
      await rm(lockPath)

      const removeFailure = new StateStore(root, { rm: (async (path: string, options?: Parameters<typeof rm>[1]) => {
        if (path.includes('state.lock.release-')) throw new Error('release remove failed')
        return rm(path, options)
      }) as typeof rm })
      await expect(removeFailure.withLock(async () => 'done')).rejects.toThrow('release remove failed')
      expect((await readdir(root)).some((name) => name.startsWith('state.lock.release-'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('aggregates operation and release cleanup failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    try {
      const store = new StateStore(root, { rm: (async (path: string, options?: Parameters<typeof rm>[1]) => {
        if (path.includes('state.lock.release-')) throw new Error('release cleanup failed')
        return rm(path, options)
      }) as typeof rm })
      await expectAggregate(store.withLock(async () => { throw new Error('operation failed') }), [
        'operation failed', 'release cleanup failed',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
