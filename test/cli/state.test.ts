import { constants } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import {
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

type HandleMethod = 'writeFile' | 'sync' | 'close'

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
    name.startsWith('state.lock.owner-') ||
    name.startsWith('state.lock.claim-') ||
    name === 'state.lock.transition',
  )
}

async function expectAggregate(promise: Promise<unknown>, fragments: readonly string[]): Promise<AggregateError> {
  try {
    await promise
    throw new Error('expected rejection')
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError)
    const aggregate = error as AggregateError
    const messages = aggregate.errors.map((item) => item instanceof Error ? item.message : String(item)).join('\n')
    for (const fragment of fragments) expect(messages).toContain(fragment)
    return aggregate
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

  it('preserves exact original bytes when the temporary write fails', async () => {
    await preservesOriginalWhen(() => ({
      open: injectedOpen((path, _flags, handle) => path.includes('.tmp-')
        ? wrappedHandle(handle, { writeFile: async () => { throw new Error('temp write failed') } })
        : handle),
    }))
  })

  it('preserves exact original bytes when the temporary fsync fails', async () => {
    await preservesOriginalWhen(() => ({
      open: injectedOpen((path, _flags, handle) => path.includes('.tmp-')
        ? wrappedHandle(handle, { sync: async () => { throw new Error('temp sync failed') } })
        : handle),
    }))
  })

  it('preserves exact original bytes when the temporary close fails', async () => {
    await preservesOriginalWhen(() => ({
      open: injectedOpen((path, _flags, handle) => {
        if (!path.includes('.tmp-')) return handle
        let first = true
        return wrappedHandle(handle, {
          close: async () => {
            if (!first) return handle.close()
            first = false
            await handle.close()
            throw new Error('temp close failed')
          },
        })
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

  it('rolls back exact original bytes and fsyncs the directory when commit directory fsync fails', async () => {
    let directorySyncs = 0
    await preservesOriginalWhen((root) => ({
      open: injectedOpen((path, flags, handle) => {
        if (path !== root || flags !== constants.O_RDONLY) return handle
        return wrappedHandle(handle, {
          sync: async () => {
            directorySyncs += 1
            if (directorySyncs === 1) throw new Error('commit directory sync failed')
            return handle.sync()
          },
        })
      }),
    }))
    expect(directorySyncs).toBe(2)
  })

  it('rolls back exact original bytes when opening the directory for commit fsync fails', async () => {
    let directoryOpens = 0
    await preservesOriginalWhen((root) => ({
      open: (async (...args: Parameters<typeof fsOpen>) => {
        if (String(args[0]) === root && args[1] === constants.O_RDONLY) {
          directoryOpens += 1
          if (directoryOpens === 1) throw new Error('commit directory open failed')
        }
        return fsOpen(...args)
      }) as typeof fsOpen,
    }))
    expect(directoryOpens).toBe(2)
  })

  it('restores original absence when commit directory fsync fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const statePath = join(root, 'state.json')
    let directorySyncs = 0
    try {
      const store = new StateStore(root, {
        open: injectedOpen((path, flags, handle) => {
          if (path !== root || flags !== constants.O_RDONLY) return handle
          return wrappedHandle(handle, {
            sync: async () => {
              directorySyncs += 1
              if (directorySyncs === 1) throw new Error('commit directory sync failed')
              return handle.sync()
            },
          })
        }),
      })
      await expect(store.write(valid)).rejects.toThrow('commit directory sync failed')
      await expect(readFile(statePath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(transactionArtifacts(root)).resolves.toEqual([])
      expect(directorySyncs).toBe(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retains the only backup and reports both errors when rollback restoration fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const statePath = join(root, 'state.json')
    const original = Buffer.from([222, 173, 190, 239])
    await writeFile(statePath, original, { mode: 0o600 })
    let directorySyncs = 0
    try {
      const store = new StateStore(root, {
        open: injectedOpen((path, flags, handle) => {
          if (path !== root || flags !== constants.O_RDONLY) return handle
          return wrappedHandle(handle, {
            sync: async () => {
              directorySyncs += 1
              if (directorySyncs === 1) throw new Error('commit directory sync failed')
              return handle.sync()
            },
          })
        }),
        link: (async (from: string, to: string) => {
          if (from.includes('.backup-') && to === statePath) throw new Error('rollback restore failed')
          return fsLink(from, to)
        }) as typeof fsLink,
      })

      await expectAggregate(store.write(valid), ['commit directory sync failed', 'rollback restore failed'])
      const artifacts = await transactionArtifacts(root)
      const backup = artifacts.find((name) => name.includes('.backup-'))
      expect(backup).toBeDefined()
      await expect(readFile(join(root, backup!))).resolves.toEqual(original)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('restores the old state and reports backup cleanup failure instead of silently succeeding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const statePath = join(root, 'state.json')
    const original = Buffer.from('{"schemaVersion":1,"profiles":{}}\n')
    await writeFile(statePath, original, { mode: 0o600 })
    try {
      const store = new StateStore(root, {
        rm: (async (path: string, options?: Parameters<typeof rm>[1]) => {
          if (path.includes('.backup-')) throw new Error('backup cleanup failed')
          return rm(path, options)
        }) as typeof rm,
      })

      await expectAggregate(store.write(valid), ['backup cleanup failed'])
      await expect(readFile(statePath)).resolves.toEqual(original)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports temporary cleanup failure while preserving the original state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const statePath = join(root, 'state.json')
    const original = Buffer.from('original state bytes')
    await writeFile(statePath, original, { mode: 0o600 })
    try {
      const store = new StateStore(root, {
        open: injectedOpen((path, _flags, handle) => path.includes('.tmp-')
          ? wrappedHandle(handle, { writeFile: async () => { throw new Error('temp write failed') } })
          : handle),
        rm: (async (path: string, options?: Parameters<typeof rm>[1]) => {
          if (path.includes('.tmp-')) throw new Error('temp cleanup failed')
          return rm(path, options)
        }) as typeof rm,
      })

      await expectAggregate(store.write(valid), ['temp write failed', 'temp cleanup failed'])
      await expect(readFile(statePath)).resolves.toEqual(original)
      expect((await transactionArtifacts(root)).some((name) => name.includes('.tmp-'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('StateStore exclusive lock', () => {
  it('writes a user-only identity record and removes canonical, owner, claim, and transition paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const lockPath = join(root, 'state.lock')
    try {
      const result = await new StateStore(root).withLock(async () => {
        expect((await stat(lockPath)).mode & 0o777).toBe(0o600)
        const metadata = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>
        expect(Object.keys(metadata).sort()).toEqual(['identity', 'pid', 'timestamp'])
        expect(metadata).toMatchObject({ pid: process.pid })
        expect(metadata.identity).toMatch(/^[a-f0-9]{32}$/)
        expect(new Date(String(metadata.timestamp)).toISOString()).toBe(metadata.timestamp)
        const owner = (await readdir(root)).find((name) => name.startsWith('state.lock.owner-'))
        expect(owner).toBeDefined()
        expect((await stat(join(root, owner!))).ino).toBe((await stat(lockPath)).ino)
        return 42
      })

      expect(result).toBe(42)
      await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(lockArtifacts(root)).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps a stale foreign lock untouched and tells a second holder to wait and retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const lockPath = join(root, 'state.lock')
    const foreign = Buffer.from('{"pid":123,"timestamp":"2020-01-01T00:00:00.000Z","identity":"foreign"}\n')
    await writeFile(lockPath, foreign, { mode: 0o600 })
    let invoked = false
    try {
      await expect(new StateStore(root).withLock(async () => { invoked = true })).rejects.toMatchObject({
        code: 'E_STATE_INVALID',
        action: 'Wait and retry',
      })
      expect(invoked).toBe(false)
      await expect(readFile(lockPath)).resolves.toEqual(foreign)
      await expect(lockArtifacts(root)).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports both occupied-lock and transition-cleanup failures without touching the foreign lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const lockPath = join(root, 'state.lock')
    const transitionPath = join(root, 'state.lock.transition')
    const foreign = Buffer.from('foreign canonical lock')
    await writeFile(lockPath, foreign, { mode: 0o600 })
    try {
      const store = new StateStore(root, {
        rm: (async (path: string, options?: Parameters<typeof rm>[1]) => {
          if (path === transitionPath) throw new Error('transition cleanup failed')
          return rm(path, options)
        }) as typeof rm,
      })
      await expectAggregate(store.withLock(async () => undefined), [
        'State is locked',
        'transition cleanup failed',
      ])
      await expect(readFile(lockPath)).resolves.toEqual(foreign)
      expect((await lockArtifacts(root)).filter((name) => name.startsWith('state.lock.owner-'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never removes a foreign transition guard when lock acquisition sees it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const transitionPath = join(root, 'state.lock.transition')
    const foreign = Buffer.from('foreign transition')
    await writeFile(transitionPath, foreign, { mode: 0o600 })
    try {
      await expect(new StateStore(root).withLock(async () => undefined)).rejects.toMatchObject({
        code: 'E_STATE_INVALID',
        action: 'Wait and retry',
      })
      await expect(readFile(transitionPath)).resolves.toEqual(foreign)
      expect((await lockArtifacts(root)).filter((name) => name.startsWith('state.lock.owner-'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never removes a foreign file at its proposed unique owner path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const foreign = Buffer.from('foreign owner')
    let foreignOwnerPath: string | undefined
    try {
      const store = new StateStore(root, {
        open: (async (...args: Parameters<typeof fsOpen>) => {
          const path = String(args[0])
          if (path.includes('state.lock.owner-') && foreignOwnerPath === undefined) {
            foreignOwnerPath = path
            await writeFile(path, foreign, { mode: 0o600 })
            throw Object.assign(new Error('owner already exists'), { code: 'EEXIST' })
          }
          return fsOpen(...args)
        }) as typeof fsOpen,
      })
      await expect(store.withLock(async () => undefined)).rejects.toMatchObject({ code: 'EEXIST' })
      expect(foreignOwnerPath).toBeDefined()
      await expect(readFile(foreignOwnerPath!)).resolves.toEqual(foreign)
      await expect(readFile(join(root, 'state.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lets the first holder release while a competing acquisition briefly owns the transition guard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const lockPath = join(root, 'state.lock')
    let finishFirst!: () => void
    const firstCanFinish = new Promise<void>((resolve) => { finishFirst = resolve })
    let secondAtLink!: () => void
    const secondReachedLink = new Promise<void>((resolve) => { secondAtLink = resolve })
    let continueSecond!: () => void
    const secondMayContinue = new Promise<void>((resolve) => { continueSecond = resolve })
    try {
      const first = new StateStore(root).withLock(async () => {
        await firstCanFinish
        return 'first'
      })
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          await stat(lockPath)
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 1))
        }
      }

      const second = new StateStore(root, {
        link: (async (from: string, to: string) => {
          if (to === lockPath) {
            secondAtLink()
            await secondMayContinue
          }
          return fsLink(from, to)
        }) as typeof fsLink,
      }).withLock(async () => 'second')
      await secondReachedLink
      finishFirst()
      await new Promise((resolve) => setTimeout(resolve, 5))
      continueSecond()

      await expect(second).rejects.toMatchObject({ code: 'E_STATE_INVALID', action: 'Wait and retry' })
      await expect(first).resolves.toBe('first')
      await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(lockArtifacts(root)).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not remove a replacement lock that reuses the acquired identity on a foreign inode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const lockPath = join(root, 'state.lock')
    let replaced: Buffer | undefined
    try {
      const store = new StateStore(root, {
        stat: (async (path: string) => {
          if (path === lockPath && replaced === undefined) {
            const metadata = await readFile(lockPath)
            await rm(lockPath)
            await writeFile(lockPath, metadata, { mode: 0o600 })
            replaced = metadata
          }
          return stat(path)
        }) as typeof stat,
      })
      await expect(store.withLock(async () => 'done')).resolves.toBe('done')
      await expect(readFile(lockPath)).resolves.toEqual(replaced)
      await expect(lockArtifacts(root)).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not remove or move a malformed replacement lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const lockPath = join(root, 'state.lock')
    const foreign = Buffer.from('not-json')
    let replaced = false
    try {
      const store = new StateStore(root, {
        stat: (async (path: string) => {
          if (path === lockPath && !replaced) {
            await rm(lockPath)
            await writeFile(lockPath, foreign, { mode: 0o600 })
            replaced = true
          }
          return stat(path)
        }) as typeof stat,
      })
      await expect(store.withLock(async () => 'done')).resolves.toBe('done')
      await expect(readFile(lockPath)).resolves.toEqual(foreign)
      expect((await lockArtifacts(root)).filter((name) => name.includes('.claim-'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('restores a foreign lock atomically claimed after the ownership check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const lockPath = join(root, 'state.lock')
    const foreign = Buffer.from('foreign replacement bytes')
    let replaced = false
    try {
      const store = new StateStore(root, {
        rename: (async (from: string, to: string) => {
          if (from === lockPath && to.includes('state.lock.claim-') && !replaced) {
            await rm(lockPath)
            await writeFile(lockPath, foreign, { mode: 0o600 })
            replaced = true
          }
          return fsRename(from, to)
        }) as typeof fsRename,
      })
      await expect(store.withLock(async () => 'done')).resolves.toBe('done')
      await expect(readFile(lockPath)).resolves.toEqual(foreign)
      await expect(lockArtifacts(root)).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('restores its canonical claim and preserves a replaced unique owner path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const lockPath = join(root, 'state.lock')
    const foreignOwner = Buffer.from('foreign owner replacement')
    let ownerStats = 0
    let ownerPath: string | undefined
    try {
      const store = new StateStore(root, {
        stat: (async (path: string) => {
          if (path.includes('state.lock.owner-')) {
            ownerStats += 1
            ownerPath = path
            if (ownerStats === 2) {
              await rm(path)
              await writeFile(path, foreignOwner, { mode: 0o600 })
            }
          }
          return stat(path)
        }) as typeof stat,
      })
      await expect(store.withLock(async () => 'done')).rejects.toThrow('Owned state lock identity path was replaced')
      await expect(readFile(lockPath, 'utf8')).resolves.toContain('"identity"')
      expect(ownerPath).toBeDefined()
      await expect(readFile(ownerPath!)).resolves.toEqual(foreignOwner)
      expect((await lockArtifacts(root)).filter((name) => name.startsWith('state.lock.claim-'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects when release cannot clean its owner instead of resolving with a stale artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    try {
      const store = new StateStore(root, {
        rm: (async (path: string, options?: Parameters<typeof rm>[1]) => {
          if (path.includes('state.lock.owner-')) throw new Error('owner cleanup failed')
          return rm(path, options)
        }) as typeof rm,
      })
      await expect(store.withLock(async () => 'done')).rejects.toThrow('owner cleanup failed')
      expect((await lockArtifacts(root)).some((name) => name.startsWith('state.lock.owner-'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves a foreign lock and reports failure to clean only its acquisition owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const lockPath = join(root, 'state.lock')
    const foreign = Buffer.from('foreign lock')
    await writeFile(lockPath, foreign, { mode: 0o600 })
    try {
      const store = new StateStore(root, {
        rm: (async (path: string, options?: Parameters<typeof rm>[1]) => {
          if (path.includes('state.lock.owner-')) throw new Error('acquisition owner cleanup failed')
          return rm(path, options)
        }) as typeof rm,
      })
      await expectAggregate(store.withLock(async () => undefined), [
        'State is locked',
        'acquisition owner cleanup failed',
      ])
      await expect(readFile(lockPath)).resolves.toEqual(foreign)
      expect((await lockArtifacts(root)).filter((name) => name.startsWith('state.lock.owner-'))).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('combines an operation failure with a release cleanup failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    try {
      const store = new StateStore(root, {
        rm: (async (path: string, options?: Parameters<typeof rm>[1]) => {
          if (path.includes('state.lock.owner-')) throw new Error('owner cleanup failed')
          return rm(path, options)
        }) as typeof rm,
      })
      await expectAggregate(store.withLock(async () => { throw new Error('operation failed') }), [
        'operation failed',
        'owner cleanup failed',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('releases in finally after an operation failure so a later operation can acquire', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-state-'))
    const store = new StateStore(root)
    try {
      await expect(store.withLock(async () => { throw new Error('operation failed') })).rejects.toThrow('operation failed')
      await expect(store.withLock(async () => 'next')).resolves.toBe('next')
      await expect(lockArtifacts(root)).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
