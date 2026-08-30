import type { FileHandle } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, parseDocument } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner } from '../../src/cli/process.ts'
import {
  NodeProfileManager,
  type ProfileFileSystem,
  type ProfileManager,
} from '../../src/cli/profile.ts'

const roots: string[] = []

class RecordingRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[] }> = []
  response: CommandResult = { exitCode: 0, stdout: '', stderr: '' }
  failure: unknown

  async run(command: string, args: readonly string[]): Promise<CommandResult> {
    this.calls.push({ command, args: [...args] })
    if (this.failure !== undefined) throw this.failure
    return this.response
  }
}

async function fixture(options: {
  packageJson?: unknown | string
  patch?: string
  fileSystem?: ProfileFileSystem
  runner?: RecordingRunner
} = {}) {
  const dshHome = await fs.mkdtemp(join(tmpdir(), 'dsh-profile-'))
  roots.push(dshHome)
  const dir = join(dshHome, 'profiles', 'web')
  await fs.mkdir(dir, { recursive: true })
  if (options.packageJson !== undefined) {
    const source = typeof options.packageJson === 'string'
      ? options.packageJson
      : `${JSON.stringify(options.packageJson, null, 2)}\n`
    await fs.writeFile(join(dir, 'package.json'), source)
  }
  if (options.patch !== undefined) await fs.writeFile(join(dir, 'cordis.patch.yml'), options.patch)
  const runner = options.runner ?? new RecordingRunner()
  const manager = new NodeProfileManager({
    commandRunner: runner,
    dshHome,
    fileSystem: options.fileSystem,
    randomId: () => 'fixed',
  })
  return { dshHome, dir, patchPath: join(dir, 'cordis.patch.yml'), manager, runner }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function ids(source: string): string[] {
  return (parse(source) as Array<{ id?: string }>).map((entry) => entry.id ?? '')
}

describe('ProfileManager contract and discovery', () => {
  it('is structural so a plain fake satisfies the public interface', async () => {
    const fake: ProfileManager = {
      inspect: async () => ({ installed: false, patchPath: '/profile/cordis.patch.yml' }),
      attach: async () => {},
      detach: async () => {},
    }
    await expect(fake.inspect('web')).resolves.toMatchObject({ installed: false })
  })

  it('resolves an empty profile to the official web profile layout', async () => {
    const { dshHome, manager } = await fixture()
    await expect(manager.inspect('')).resolves.toEqual({
      installed: false,
      patchPath: join(dshHome, 'profiles', 'web', 'cordis.patch.yml'),
    })
  })

  it.each([
    [{ dependencies: { 'dsh-searxng': '^0.1.0' } }, 'dependencies'],
    [{ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-searxng'] } } }, 'bundles'],
  ])('detects an installed plugin from %s', async (packageJson, _source) => {
    const { manager } = await fixture({ packageJson })
    await expect(manager.inspect('web')).resolves.toMatchObject({ installed: true })
  })

  it.each([
    ['invalid JSON', '{secret endpoint https://private.invalid?q=token'],
    ['invalid dependencies', { dependencies: [] }],
    ['invalid bundles', { dsh: { profile: { bundles: [42] } } }],
  ])('reports %s as a stable safe profile error without mutation', async (_name, packageJson) => {
    const patch = '# keep\n[]\n'
    const { manager, patchPath } = await fixture({ packageJson, patch })
    let error: unknown
    try { await manager.inspect('web') } catch (cause) { error = cause }
    expect(error).toMatchObject({ code: 'E_PROFILE_WRITE', details: {} })
    expect(JSON.stringify(error)).not.toContain('private.invalid')
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe(patch)
  })

  it.each(['../web', 'a/b', 'a\\b'])('rejects the unsafe profile name %s', async (profile) => {
    const { manager } = await fixture()
    await expect(manager.inspect(profile)).rejects.toMatchObject({ code: 'E_PROFILE_INVALID' })
  })
})

describe('transactional attachment', () => {
  it('installs with exact argv, writes an empty patch, then validates', async () => {
    const events: string[] = []
    const runner = new RecordingRunner()
    const originalRun = runner.run.bind(runner)
    runner.run = async (command, args) => {
      events.push('install')
      return originalRun(command, args)
    }
    const { manager, runner: recorded, patchPath } = await fixture({ patch: '[]\n', runner })

    await manager.attach('', 'http://127.0.0.1:8080', async () => {
      events.push('validate')
      expect(await fs.readFile(patchPath, 'utf8')).toContain('baseURL: http://127.0.0.1:8080')
    })

    expect(recorded.calls).toEqual([{
      command: 'dsh',
      args: ['plugin', '--profile', 'web', 'add', 'dsh-searxng'],
    }])
    expect(events).toEqual(['install', 'validate'])
    const output = await fs.readFile(patchPath, 'utf8')
    expect(ids(output)).toEqual(['web-search-searxng'])
    expect(output).toContain('# dsh-searxng managed attachment')
  })

  it('preserves comments, unrelated nodes, and the last effective full config', async () => {
    const patch = `# profile comment
- id: unrelated
  config:
    answer: 42 # inline survives
- id: web-search-searxng
  config:
    baseURL: http://first.invalid
    firstOnly: true
- id: web-search-searxng
  config:
    baseURL: http://last.invalid
    unknownKey: keep
    nested:
      enabled: true
`
    const { manager, patchPath } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '^0.1.0' } },
      patch,
    })

    await manager.attach('web', 'https://search.example/root///', async () => {})

    const output = await fs.readFile(patchPath, 'utf8')
    expect(output).toContain('# profile comment')
    expect(output).toContain('# inline survives')
    expect(ids(output)).toEqual([
      'unrelated',
      'web-search-searxng',
      'web-search-searxng',
      'web-search-searxng',
    ])
    const rows = parse(output) as Array<{ id: string; config?: Record<string, unknown> }>
    expect(rows.at(-1)).toEqual({
      id: 'web-search-searxng',
      config: {
        baseURL: 'https://search.example/root',
        unknownKey: 'keep',
        nested: { enabled: true },
      },
    })
  })

  it('replaces a prior managed patch idempotently without duplicating it', async () => {
    const patch = `- id: web-search-searxng
  config:
    timeoutMs: 5000
# dsh-searxng managed attachment
- id: web-search-searxng
  config:
    timeoutMs: 5000
    baseURL: http://old.invalid
`
    const { manager, patchPath } = await fixture({
      packageJson: { dsh: { profile: { bundles: ['dsh-searxng'] } } },
      patch,
    })
    await manager.attach('web', 'http://new.example/', async () => {})
    await manager.attach('web', 'http://newer.example', async () => {})

    const output = await fs.readFile(patchPath, 'utf8')
    expect(output.match(/dsh-searxng managed attachment/g)).toHaveLength(1)
    expect(ids(output)).toEqual(['web-search-searxng', 'web-search-searxng'])
    expect((parse(output) as Array<{ config: Record<string, unknown> }>).at(-1)?.config).toEqual({
      timeoutMs: 5000,
      baseURL: 'http://newer.example',
    })
  })

  it.each([
    'ftp://search.example',
    'https://user:password@search.example',
    'https://search.example?q=secret',
    'https://search.example/#secret',
  ])('rejects unsafe endpoint %s before install or writes', async (endpoint) => {
    const original = Buffer.from('[]\n')
    const { manager, runner, patchPath } = await fixture({ patch: original.toString() })
    await expect(manager.attach('web', endpoint, async () => {})).rejects.toMatchObject({ code: 'E_PROFILE_WRITE' })
    expect(runner.calls).toEqual([])
    await expect(fs.readFile(patchPath)).resolves.toEqual(original)
  })

  it.each([
    ['mapping root', 'key: value\n'],
    ['empty document', '# comment only\n'],
    ['invalid YAML', '- id: [\n'],
  ])('rejects a malformed %s without installing or changing bytes', async (_name, patch) => {
    const original = Buffer.from(patch)
    const { manager, runner, patchPath } = await fixture({ patch })
    await expect(manager.attach('web', 'http://localhost:8080', async () => {})).rejects.toMatchObject({ code: 'E_PROFILE_WRITE' })
    expect(runner.calls).toEqual([])
    await expect(fs.readFile(patchPath)).resolves.toEqual(original)
  })

  it('restores byte-identical content and removes only a transaction-added plugin after validation fails', async () => {
    const original = Buffer.from('# exact\n- id: other\n  config: { value: 1 }\n')
    const { manager, runner, patchPath } = await fixture({ patch: original.toString() })

    await expect(manager.attach('web', 'http://localhost:8080', async () => {
      throw new Error('validation secret https://private.invalid?q=token')
    })).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { primaryFailure: 'validation', rollbackFailures: [] },
    })

    expect(runner.calls).toEqual([
      { command: 'dsh', args: ['plugin', '--profile', 'web', 'add', 'dsh-searxng'] },
      { command: 'dsh', args: ['plugin', '--profile', 'web', 'remove', 'dsh-searxng'] },
    ])
    await expect(fs.readFile(patchPath)).resolves.toEqual(original)
  })

  it('restores original absence after validation fails', async () => {
    const { manager, patchPath } = await fixture()
    await expect(manager.attach('web', 'http://localhost:8080', async () => {
      throw new Error('no')
    })).rejects.toMatchObject({ code: 'E_PROFILE_WRITE' })
    await expect(fs.lstat(patchPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('never removes a pre-existing plugin when validation fails', async () => {
    const { manager, runner } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '^0.1.0' } },
      patch: '[]\n',
    })
    await expect(manager.attach('web', 'http://localhost:8080', async () => {
      throw new Error('no')
    })).rejects.toMatchObject({ code: 'E_PROFILE_WRITE' })
    expect(runner.calls).toEqual([])
  })
})

describe('rollback and file safety', () => {
  function proxiedHandle(handle: FileHandle, writeFile: FileHandle['writeFile']): FileHandle {
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'writeFile') return writeFile.bind(handle)
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  it('does not validate, cleans temporary files, restores bytes, and removes an added plugin after write failure', async () => {
    let failNextTempWrite = true
    const fileSystem: ProfileFileSystem = {
      ...fs,
      open: async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args)
        if (String(args[0]).includes('.tmp-') && failNextTempWrite) {
          failNextTempWrite = false
          return proxiedHandle(handle, async () => { throw new Error('write secret') })
        }
        return handle
      },
    }
    const original = Buffer.from('# exact\n[]\n')
    const { manager, runner, dir, patchPath } = await fixture({ patch: original.toString(), fileSystem })
    let validations = 0
    await expect(manager.attach('web', 'http://localhost:8080', async () => { validations += 1 }))
      .rejects.toMatchObject({ code: 'E_PROFILE_WRITE', details: { primaryFailure: 'write' } })
    expect(validations).toBe(0)
    expect(runner.calls.at(-1)?.args).toEqual(['plugin', '--profile', 'web', 'remove', 'dsh-searxng'])
    await expect(fs.readFile(patchPath)).resolves.toEqual(original)
    expect((await fs.readdir(dir)).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('reports patch rollback failure alongside the primary failure without leaking causes', async () => {
    let renames = 0
    const fileSystem: ProfileFileSystem = {
      ...fs,
      rename: async (...args: Parameters<typeof fs.rename>) => {
        renames += 1
        if (renames === 2) throw new Error('rollback endpoint https://private.invalid?q=token')
        await fs.rename(...args)
      },
    }
    const { manager } = await fixture({ patch: '[]\n', fileSystem })
    let error: unknown
    try {
      await manager.attach('web', 'http://localhost:8080', async () => { throw new Error('validation token') })
    } catch (cause) { error = cause }
    expect(error).toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { primaryFailure: 'validation', rollbackFailures: ['patch'] },
    })
    expect(JSON.stringify(error)).not.toContain('private.invalid')
    expect(JSON.stringify(error)).not.toContain('validation token')
  })

  it('reports plugin removal rollback failure alongside the primary failure', async () => {
    const runner = new RecordingRunner()
    const originalRun = runner.run.bind(runner)
    runner.run = async (command, args) => {
      const result = await originalRun(command, args)
      return args.includes('remove') ? { ...result, exitCode: 1, stderr: 'secret token' } : result
    }
    const { manager } = await fixture({ patch: '[]\n', runner })
    await expect(manager.attach('web', 'http://localhost:8080', async () => {
      throw new Error('validation failed')
    })).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { primaryFailure: 'validation', rollbackFailures: ['plugin'] },
    })
  })

  it('maps command cancellation and process failures to stable safe errors', async () => {
    const runner = new RecordingRunner()
    const cancellation = new Error('cancel secret endpoint https://private.invalid?q=token')
    cancellation.name = 'AbortError'
    runner.failure = cancellation
    const { manager, patchPath } = await fixture({ patch: '[]\n', runner })
    let error: unknown
    try { await manager.attach('web', 'http://localhost:8080', async () => {}) } catch (cause) { error = cause }
    expect(error).toMatchObject({ code: 'E_PROFILE_WRITE', details: { primaryFailure: 'install' } })
    expect(JSON.stringify(error)).not.toContain('private.invalid')
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe('[]\n')
  })

  it('writes user-only files and leaves no temporary artifacts', async () => {
    const { manager, dir, patchPath } = await fixture({ patch: '[]\n' })
    await manager.attach('web', 'http://localhost:8080', async () => {})
    expect((await fs.stat(patchPath)).mode & 0o777).toBe(0o600)
    expect((await fs.readdir(dir)).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('rejects symlinked profile files without following or changing them', async () => {
    const outside = await fs.mkdtemp(join(tmpdir(), 'dsh-profile-outside-'))
    roots.push(outside)
    const secret = join(outside, 'secret.yml')
    await fs.writeFile(secret, '[]\n')
    const { manager, patchPath } = await fixture()
    await fs.symlink(secret, patchPath)
    await expect(manager.attach('web', 'http://localhost:8080', async () => {}))
      .rejects.toMatchObject({ code: 'E_PROFILE_WRITE' })
    await expect(fs.readFile(secret, 'utf8')).resolves.toBe('[]\n')
  })
})

describe('detachment', () => {
  it('removes only marker-and-id matches, preserving marker-only and unmarked target patches', async () => {
    const patch = `# keep top
- id: web-search-searxng
  config: { baseURL: http://user.invalid }
# dsh-searxng managed attachment
- id: other
  config: { untouched: true }
# dsh-searxng managed attachment
- id: web-search-searxng
  config: { baseURL: http://managed.invalid }
`
    const { manager, runner, patchPath } = await fixture({ patch })
    await manager.detach('web')
    await manager.detach('web')

    const output = await fs.readFile(patchPath, 'utf8')
    expect(ids(output)).toEqual(['web-search-searxng', 'other'])
    expect(output).toContain('# keep top')
    expect(output).toContain('# dsh-searxng managed attachment')
    expect(output).toContain('http://user.invalid')
    expect(output).not.toContain('http://managed.invalid')
    expect(runner.calls).toEqual([])
  })
})

describe('YAML document shape', () => {
  it('retains unrelated anchors and styles as YAML AST nodes permit', async () => {
    const patch = `- id: unrelated
  config: &shared
    style: 'quoted'
- id: another
  config: *shared
`
    const { manager, patchPath } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.0' } },
      patch,
    })
    await manager.attach('web', 'http://localhost:8080', async () => {})
    const output = await fs.readFile(patchPath, 'utf8')
    expect(output).toContain('&shared')
    expect(output).toContain('*shared')
    expect(output).toContain("style: 'quoted'")
    expect(parseDocument(output).errors).toEqual([])
  })
})
