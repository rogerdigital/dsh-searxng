import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CliError } from '../../src/cli/errors.ts'
import { remove, removeManagedDirectory, type RemoveDependencies } from '../../src/cli/remove.ts'
import type { StateV2 } from '../../src/cli/state.ts'

const HOME_ID = '0123456789abcdef'
const PROJECT = `dsh-searxng-${HOME_ID}`
const ENDPOINT = 'http://127.0.0.1:8080'
const COMPOSE = `/dsh/dsh-searxng/config-${'a'.repeat(64)}/compose.yml`

function managedState(extraProfiles: StateV2['profiles'] = {}): StateV2 {
  return {
    schemaVersion: 2,
    homeId: HOME_ID,
    managed: {
      current: {
        deploymentVersion: 1, image: 'image', endpoint: ENDPOINT, port: 8080,
        projectName: PROJECT, containerName: PROJECT,
      },
      lastHealthyAt: '2026-08-30T00:00:00.000Z',
    },
    profiles: { web: { mode: 'managed', endpoint: ENDPOINT }, ...extraProfiles },
  }
}

function harness(options: {
  state?: StateV2
  ownershipError?: unknown
  foreignOnSecondOwnership?: boolean
  confirmed?: boolean
  writeFailure?: boolean
  dshError?: unknown
  uninstallFailures?: number
} = {}) {
  let current = structuredClone(options.state ?? managedState())
  const events: string[] = []
  const writes: StateV2[] = []
  let ownershipCalls = 0
  let uninstallFailures = options.uninstallFailures ?? 0
  const dependencies: RemoveDependencies = {
    environment: {
      resolve: vi.fn(async () => ({ dshHome: '/dsh', profileDir: '/dsh/profiles/web', managedDir: '/dsh/dsh-searxng', homeId: HOME_ID })),
      preflightDsh: vi.fn(async () => { if (options.dshError !== undefined) throw options.dshError }), preflightManaged: vi.fn(),
    },
    state: {
      read: vi.fn(async () => structuredClone(current)),
      write: vi.fn(async (next) => { events.push('state-write'); if (options.writeFailure) throw new Error('write'); current = structuredClone(next); writes.push(structuredClone(next)) }),
      withLock: vi.fn(async (operation) => operation()),
    },
    docker: {
      preflight: vi.fn(async () => ({ serverVersion: '27', composeVersion: '2.30' })),
      inspectOwnership: vi.fn(async () => 'owned' as const), up: vi.fn(), restart: vi.fn(), logs: vi.fn(async () => ''),
      pull: vi.fn(), imageExists: vi.fn(async () => false),
      deploymentStatus: vi.fn(async () => {
        events.push('ownership')
        ownershipCalls += 1
        if (options.foreignOnSecondOwnership && ownershipCalls === 2) throw new CliError('E_RESOURCE_FOREIGN', 'foreign', 'repair')
        if (options.ownershipError !== undefined) throw options.ownershipError
        return { ownership: 'owned' as const, container: 'running' as const, composePath: COMPOSE }
      }),
      down: vi.fn(async (_identity, volumes) => { events.push(`down:${volumes}`) }),
    },
    profiles: {
      inspect: vi.fn(), preview: vi.fn(), validate: vi.fn(), attach: vi.fn(),
      detach: vi.fn(async () => { events.push('detach') }),
      uninstall: vi.fn(async () => { events.push('uninstall'); if (uninstallFailures > 0) { uninstallFailures -= 1; throw new CliError('E_PROFILE_WRITE', 'failed', 'retry') } }),
    },
    confirmPurge: vi.fn(async (volumes) => { events.push(`confirm:${volumes.join(',')}`); return options.confirmed ?? false }),
    removeManagedDirectory: vi.fn(async (path) => { events.push(`remove-dir:${path}`) }),
  }
  return { dependencies, events, writes, current: () => current }
}

describe('removeManagedDirectory', () => {
  it('derives and removes only the managed child of DSH home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-searxng-remove-'))
    const dshHome = join(root, 'dsh-home')
    const managed = join(dshHome, 'dsh-searxng')
    const sibling = join(dshHome, 'keep.txt')
    try {
      await mkdir(managed, { recursive: true })
      await writeFile(sibling, 'keep')

      await removeManagedDirectory(dshHome)

      await expect(access(managed)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(sibling)).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('is idempotent when the managed child is absent', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-searxng-remove-absent-'))
    try {
      await expect(removeManagedDirectory(dshHome)).resolves.toBeUndefined()
      await expect(access(dshHome)).resolves.toBeUndefined()
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it('rejects a symlink managed child without touching its target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-searxng-remove-link-'))
    const dshHome = join(root, 'dsh-home')
    const target = join(root, 'target')
    const marker = join(target, 'keep.txt')
    try {
      await mkdir(dshHome)
      await mkdir(target)
      await writeFile(marker, 'keep')
      await symlink(target, join(dshHome, 'dsh-searxng'), process.platform === 'win32' ? 'junction' : 'dir')

      await expect(removeManagedDirectory(dshHome)).rejects.toMatchObject({ code: 'E_INTERNAL' })
      await expect(access(marker)).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a regular-file managed child without removing it', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dsh-searxng-remove-file-'))
    const managed = join(dshHome, 'dsh-searxng')
    try {
      await writeFile(managed, 'keep')
      await expect(removeManagedDirectory(dshHome)).rejects.toMatchObject({ code: 'E_INTERNAL' })
      await expect(access(managed)).resolves.toBeUndefined()
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  })

  it.each([
    ['relative', 'relative-dsh-home'],
    ['non-normalized', `${tmpdir()}${sep}nested${sep}..`],
  ])('rejects a %s DSH home before filesystem access', async (_label, dshHome) => {
    await expect(removeManagedDirectory(dshHome)).rejects.toMatchObject({ code: 'E_INTERNAL' })
  })
})

describe('remove', () => {
  it('detaches only the selected profile and updates attachment state', async () => {
    const test = harness()
    const result = await remove({ profile: 'web', service: false, purgeData: false, confirmed: false }, test.dependencies)
    expect(result).toMatchObject({ profileRemoved: true, serviceRemoved: false, dataPurged: false })
    expect(test.current().profiles).toEqual({})
    expect(test.events).toEqual(['state-write', 'detach', 'uninstall'])
    expect(test.dependencies.docker.down).not.toHaveBeenCalled()
  })

  it('refuses service removal while another managed profile remains without mutation', async () => {
    const test = harness({ state: managedState({ other: { mode: 'managed', endpoint: ENDPOINT } }) })
    await expect(remove({ profile: 'web', service: true, purgeData: false, confirmed: false }, test.dependencies))
      .rejects.toMatchObject({ code: 'E_REMOVE_BLOCKED' })
    expect(test.events).toEqual([])
  })

  it('rechecks ownership immediately before Compose down and retains data without purge', async () => {
    const test = harness()
    const result = await remove({ profile: 'web', service: true, purgeData: false, confirmed: false }, test.dependencies)
    expect(result).toMatchObject({ serviceRemoved: true, dataPurged: false })
    expect(test.events).toEqual(['ownership', 'state-write', 'detach', 'uninstall', 'ownership', 'down:false'])
    expect(test.current().managed).toBeDefined()
    expect(test.dependencies.removeManagedDirectory).not.toHaveBeenCalled()
  })

  it('lists the exact owned volume and requires confirmation before purge', async () => {
    const declined = harness()
    await expect(remove({ profile: 'web', service: true, purgeData: true, confirmed: false }, declined.dependencies))
      .rejects.toMatchObject({ code: 'E_USAGE' })
    expect(declined.events).toEqual([`confirm:${PROJECT}-cache`])

    const accepted = harness({ confirmed: true })
    const result = await remove({ profile: 'web', service: true, purgeData: true, confirmed: false }, accepted.dependencies)
    expect(result.dataPurged).toBe(true)
    expect(accepted.events).toContain('down:true')
    expect(accepted.events.at(-1)).toBe('remove-dir:/dsh')
  })

  it('blocks foreign ownership before every destructive operation', async () => {
    const test = harness({ ownershipError: new CliError('E_RESOURCE_FOREIGN', 'foreign', 'repair') })
    await expect(remove({ profile: 'web', service: true, purgeData: false, confirmed: false }, test.dependencies))
      .rejects.toMatchObject({ code: 'E_RESOURCE_FOREIGN' })
    expect(test.events).toEqual(['ownership'])
    expect(test.dependencies.profiles.detach).not.toHaveBeenCalled()
    expect(test.dependencies.docker.down).not.toHaveBeenCalled()
  })

  it('never writes attachment state when DSH preflight fails', async () => {
    const test = harness({ dshError: new CliError('E_DSH_MISSING', 'missing', 'install') })
    await expect(remove({ profile: 'web', service: false, purgeData: false, confirmed: false }, test.dependencies))
      .rejects.toMatchObject({ code: 'E_DSH_MISSING' })
    expect(test.events).toEqual([])
  })

  it('can retry a plugin uninstall after state and patch were already detached', async () => {
    const test = harness({ uninstallFailures: 1 })
    await expect(remove({ profile: 'web', service: false, purgeData: false, confirmed: false }, test.dependencies))
      .rejects.toMatchObject({ code: 'E_PROFILE_WRITE' })
    await expect(remove({ profile: 'web', service: false, purgeData: false, confirmed: false }, test.dependencies))
      .resolves.toMatchObject({ profileRemoved: false })
    expect(test.dependencies.profiles.uninstall).toHaveBeenCalledTimes(2)
  })

  it('rechecks ownership and refuses Compose down if labels change mid-removal', async () => {
    const test = harness({ foreignOnSecondOwnership: true })
    await expect(remove({ profile: 'web', service: true, purgeData: false, confirmed: false }, test.dependencies))
      .rejects.toMatchObject({ code: 'E_RESOURCE_FOREIGN' })
    expect(test.dependencies.docker.down).not.toHaveBeenCalled()
  })
})
