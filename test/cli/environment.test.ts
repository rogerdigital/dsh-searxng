import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  NodeEnvironmentService,
  homeId,
  managedDir,
  profileDir,
  resolveDshHome,
  type EnvironmentService,
} from '../../src/cli/environment.ts'

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

describe('environment helpers', () => {
  it('resolves injected DSH_HOME or the injected home directory', () => {
    expect(resolveDshHome({ DSH_HOME: '/tmp/dsh' }, '/Users/test')).toBe('/tmp/dsh')
    expect(resolveDshHome({ DSH_HOME: 'relative' }, '/Users/test')).toBe(join(process.cwd(), 'relative'))
    expect(resolveDshHome({ DSH_HOME: '~/relative' }, '/Users/test')).toBe('/Users/test/relative')
    expect(resolveDshHome({ DSH_HOME: '  ' }, '/Users/test')).toBe('/Users/test/.dsh')
    expect(resolveDshHome({}, '/Users/test')).toBe('/Users/test/.dsh')
  })

  it('derives profile and managed paths and rejects unsafe profiles', () => {
    expect(profileDir('/tmp/.dsh', 'web')).toBe(join('/tmp/.dsh', 'profiles', 'web'))
    expect(profileDir('/tmp/.dsh', 'node_modules')).toBe(join('/tmp/.dsh', 'profiles', 'node_modules'))
    expect(managedDir('/tmp/.dsh')).toBe(join('/tmp/.dsh', 'dsh-searxng'))
    for (const profile of ['', '.', '..', 'a/b', 'a\\b']) {
      try { profileDir('/tmp/.dsh', profile); throw new Error('expected rejection') } catch (error) { expect(error).toMatchObject({ code: 'E_PROFILE_INVALID' }) }
    }
  })

  it('computes a stable, path-derived home id', () => {
    const normalized = '/tmp/dsh'
    const expected = createHash('sha256').update(normalized).digest('hex').slice(0, 16)
    expect(homeId(normalized)).toBe(expected)
    expect(homeId('/tmp/dsh/')).toBe(expected)
    expect(homeId('/tmp/other')).not.toBe(expected)
    expect(homeId(normalized)).not.toContain(normalized)
  })

  it('resolves a profile and preflights dsh and port through injected dependencies', async () => {
    const service = new NodeEnvironmentService({
      env: { DSH_HOME: '/tmp/dsh' }, homedir: '/Users/test',
      portChecker: async (port) => port !== 8080,
      commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    })
    await expect(service.resolve('web')).resolves.toMatchObject({ dshHome: '/tmp/dsh', profileDir: '/tmp/dsh/profiles/web', managedDir: '/tmp/dsh/dsh-searxng' })
    await expect(service.preflightManaged(8080)).rejects.toMatchObject({ code: 'E_PORT_CONFLICT' })
  })

  it('preflight invokes dsh --version exactly without shell options', async () => {
    const run = vi.fn(async (...args: Parameters<NonNullable<ConstructorParameters<typeof NodeEnvironmentService>[0]['commandRunner']['run']>>) => ({ exitCode: 0, stdout: '', stderr: '' }))
    const service = new NodeEnvironmentService({ portChecker: async () => true, commandRunner: { run } })
    await service.preflightManaged(8080)
    expect(run).toHaveBeenCalledWith('dsh', ['--version'], { signal: undefined })
  })

  it.each([0, 65536, -1, 1.5, Number.NaN])('rejects invalid preflight port %s with stable error', async (port) => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    await expect(new NodeEnvironmentService({ portChecker: async () => true, commandRunner: { run } }).preflightManaged(port)).rejects.toMatchObject({ code: 'E_USAGE', action: 'Choose a valid port' })
    expect(run).not.toHaveBeenCalled()
  })

  it.each([{ exitCode: 127 }, { exitCode: 1 }])('reports missing or nonzero dsh with stable error', async (result) => {
    await expect(new NodeEnvironmentService({ portChecker: async () => true, commandRunner: { run: async () => ({ ...result, stdout: '', stderr: '' }) } }).preflightManaged(8080)).rejects.toMatchObject({ code: 'E_DSH_MISSING', action: 'Install dsh and ensure it is on PATH' })
  })

  it('maps a thrown ENOENT from dsh --version to the stable missing-dsh error', async () => {
    const missing = Object.assign(new Error('spawn dsh ENOENT'), { code: 'ENOENT' })
    const service = new NodeEnvironmentService({
      portChecker: async () => true,
      commandRunner: { run: async () => { throw missing } },
    })

    await expect(service.preflightManaged(8080)).rejects.toMatchObject({
      code: 'E_DSH_MISSING',
      action: 'Install dsh and ensure it is on PATH',
    })
  })

  it('maps a port-checker failure to an actionable stable conflict error without invoking dsh', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const service = new NodeEnvironmentService({
      portChecker: async () => { throw new Error('socket probe failed') },
      commandRunner: { run },
    })

    await expect(service.preflightManaged(8080)).rejects.toMatchObject({
      code: 'E_PORT_CONFLICT',
      action: 'Choose another port or stop the process using it',
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('accepts a plain object as an EnvironmentService', async () => {
    const service: EnvironmentService = {
      resolve: async (profile) => ({
        dshHome: '/fake',
        profileDir: `/fake/profiles/${profile}`,
        managedDir: '/fake/dsh-searxng',
        homeId: '0123456789abcdef',
      }),
      preflightManaged: async () => {},
    }

    await expect(service.resolve('web')).resolves.toMatchObject({ profileDir: '/fake/profiles/web' })
    await expect(service.preflightManaged(8080)).resolves.toBeUndefined()
  })

  it('propagates an already-aborted signal unchanged without invoking dependencies', async () => {
    const cancellation = abortError('cancelled before preflight')
    const controller = new AbortController()
    controller.abort(cancellation)
    const portChecker = vi.fn(async () => true)
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const service = new NodeEnvironmentService({ portChecker, commandRunner: { run } })

    await expect(service.preflightManaged(8080, controller.signal)).rejects.toBe(cancellation)
    expect(portChecker).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('propagates cancellation during the port checker unchanged without invoking dsh', async () => {
    const cancellation = abortError('cancelled during port check')
    const controller = new AbortController()
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const service = new NodeEnvironmentService({
      portChecker: async () => {
        controller.abort(cancellation)
        return true
      },
      commandRunner: { run },
    })

    await expect(service.preflightManaged(8080, controller.signal)).rejects.toBe(cancellation)
    expect(run).not.toHaveBeenCalled()
  })

  it('propagates cancellation during dsh --version unchanged', async () => {
    const cancellation = abortError('cancelled during version check')
    const controller = new AbortController()
    const service = new NodeEnvironmentService({
      portChecker: async () => true,
      commandRunner: {
        run: async () => {
          controller.abort(cancellation)
          return { exitCode: 0, stdout: '', stderr: '' }
        },
      },
    })

    await expect(service.preflightManaged(8080, controller.signal)).rejects.toBe(cancellation)
  })

  it.each(['port checker', 'dsh --version'] as const)(
    'propagates an AbortError thrown by the %s unchanged without an aborted signal',
    async (dependency) => {
      const cancellation = abortError(`cancelled by ${dependency}`)
      const service = new NodeEnvironmentService({
        portChecker: dependency === 'port checker'
          ? async () => { throw cancellation }
          : async () => true,
        commandRunner: {
          run: dependency === 'dsh --version'
            ? async () => { throw cancellation }
            : async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        },
      })

      await expect(service.preflightManaged(8080)).rejects.toBe(cancellation)
    },
  )
})
