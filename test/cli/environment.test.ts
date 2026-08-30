import { describe, expect, it, vi } from 'vitest'
import { homedir as osHomedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { EnvironmentService, homeId, managedDir, profileDir, resolveDshHome } from '../../src/cli/environment.ts'

describe('environment helpers', () => {
  it('resolves injected DSH_HOME or the injected home directory', () => {
    expect(resolveDshHome({ DSH_HOME: '/tmp/dsh' }, '/Users/test')).toBe('/tmp/dsh')
    expect(resolveDshHome({ DSH_HOME: 'relative' }, '/Users/test')).toBe(join(process.cwd(), 'relative'))
    expect(resolveDshHome({ DSH_HOME: '~/relative' }, '/Users/test')).toBe(join(osHomedir(), 'relative'))
    expect(resolveDshHome({ DSH_HOME: '  ' }, '/Users/test')).toBe('/Users/test/.dsh')
    expect(resolveDshHome({}, '/Users/test')).toBe('/Users/test/.dsh')
  })

  it('derives profile and managed paths and rejects unsafe profiles', () => {
    expect(profileDir('/tmp/.dsh', 'web')).toBe(join('/tmp/.dsh', 'profiles', 'web'))
    expect(managedDir('/tmp/.dsh')).toBe(join('/tmp/.dsh', 'dsh-searxng'))
    for (const profile of ['', '.', '..', 'a/b', 'a\\b', 'node_modules', 'x/node_modules/y']) {
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
    const service = new EnvironmentService({
      env: { DSH_HOME: '/tmp/dsh' }, homedir: osHomedir(),
      portChecker: async (port) => port !== 8080,
      commandRunner: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    })
    await expect(service.resolve('web')).resolves.toMatchObject({ dshHome: '/tmp/dsh', profileDir: '/tmp/dsh/profiles/web', managedDir: '/tmp/dsh/dsh-searxng' })
    await expect(service.preflightManaged(8080)).rejects.toMatchObject({ code: 'E_PORT_CONFLICT' })
  })

  it('preflight invokes dsh --version exactly without shell options', async () => {
    const run = vi.fn(async (...args: Parameters<NonNullable<ConstructorParameters<typeof EnvironmentService>[0]['commandRunner']['run']>>) => ({ exitCode: 0, stdout: '', stderr: '' }))
    const service = new EnvironmentService({ portChecker: async () => true, commandRunner: { run } })
    await service.preflightManaged(8080)
    expect(run).toHaveBeenCalledWith('dsh', ['--version'], { signal: undefined })
  })

  it.each([0, 65536, -1, 1.5, Number.NaN])('rejects invalid preflight port %s with stable error', async (port) => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    await expect(new EnvironmentService({ portChecker: async () => true, commandRunner: { run } }).preflightManaged(port)).rejects.toMatchObject({ code: 'E_USAGE', action: 'Choose a valid port' })
    expect(run).not.toHaveBeenCalled()
  })

  it.each([{ exitCode: 127 }, { exitCode: 1 }])('reports missing or nonzero dsh with stable error', async (result) => {
    await expect(new EnvironmentService({ portChecker: async () => true, commandRunner: { run: async () => ({ ...result, stdout: '', stderr: '' }) } }).preflightManaged(8080)).rejects.toMatchObject({ code: 'E_DSH_MISSING', action: 'Install dsh and ensure it is on PATH' })
  })
})
