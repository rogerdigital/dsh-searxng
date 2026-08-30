import type { FileHandle } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, parseDocument } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { CliError } from '../../src/cli/errors.ts'
import type { CommandResult, CommandRunner } from '../../src/cli/process.ts'
import {
  NodeProfileManager,
  type ProfileFileSystem,
  type ProfileManager,
} from '../../src/cli/profile.ts'

const roots: string[] = []

class RecordingRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[] }> = []
  readonly signals: Array<AbortSignal | undefined> = []
  response: CommandResult = { exitCode: 0, stdout: '', stderr: '' }
  failure: unknown
  handler?: (
    command: string,
    args: readonly string[],
    options?: { signal?: AbortSignal },
  ) => Promise<CommandResult>

  async run(
    command: string,
    args: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<CommandResult> {
    this.calls.push({ command, args: [...args] })
    this.signals.push(options?.signal)
    if (this.handler !== undefined) return this.handler(command, args, options)
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

  it('copies a later managed config instead of an earlier unmarked target config', async () => {
    const patch = `- id: web-search-searxng
  config:
    timeoutMs: 1000
    source: user
# dsh-searxng managed attachment
- id: web-search-searxng
  config:
    timeoutMs: 9000
    source: managed
    laterOnly: keep
    baseURL: http://old.invalid
`
    const { manager, patchPath } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.0' } },
      patch,
    })

    await manager.attach('web', 'http://new.example', async () => {})

    const rows = parse(await fs.readFile(patchPath, 'utf8')) as Array<{
      id: string
      config: Record<string, unknown>
    }>
    expect(rows.at(-1)?.config).toEqual({
      timeoutMs: 9000,
      source: 'managed',
      laterOnly: 'keep',
      baseURL: 'http://new.example',
    })
  })

  it('copies a later unmarked target config after an earlier managed patch', async () => {
    const patch = `# dsh-searxng managed attachment
- id: web-search-searxng
  config:
    source: managed
    baseURL: http://old.invalid
- id: web-search-searxng
  config:
    source: later-user
    userOnly: keep
    baseURL: http://user.invalid
`
    const { manager, patchPath } = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.0' } },
      patch,
    })

    await manager.attach('web', 'http://new.example', async () => {})

    const rows = parse(await fs.readFile(patchPath, 'utf8')) as Array<{
      id: string
      config: Record<string, unknown>
    }>
    expect(rows.at(-1)?.config).toEqual({
      source: 'later-user',
      userOnly: 'keep',
      baseURL: 'http://new.example',
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

  it('rethrows a safe validation CliError unchanged after successful rollback', async () => {
    const validationError = new CliError(
      'E_AUTH_FAILED',
      'SearXNG authentication failed',
      'Check the configured authorization header and retry',
    )
    const { manager } = await fixture({ patch: '[]\n' })
    let error: unknown
    try {
      await manager.attach('web', 'http://localhost:8080', async () => { throw validationError })
    } catch (cause) { error = cause }
    expect(error).toBe(validationError)
  })

  it('rethrows validation cancellation unchanged after successful rollback', async () => {
    const cancellation = new Error('The operation was aborted')
    cancellation.name = 'AbortError'
    const { manager } = await fixture({ patch: '[]\n' })
    let error: unknown
    try {
      await manager.attach('web', 'http://localhost:8080', async () => { throw cancellation })
    } catch (cause) { error = cause }
    expect(error).toBe(cancellation)
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
      details: {
        primaryFailure: 'validation',
        primaryError: 'unknown',
        rollbackFailures: ['patch'],
      },
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

  it('restores the original only after successful remove-side patch recreation', async () => {
    const events: string[] = []
    const runner = new RecordingRunner()
    let patchPath = ''
    const fileSystem: ProfileFileSystem = {
      ...fs,
      rename: async (...args: Parameters<typeof fs.rename>) => {
        if (String(args[1]) === patchPath) events.push('write')
        await fs.rename(...args)
      },
    }
    const original = Buffer.from('# exact original\n[]\n')
    const created = await fixture({ patch: original.toString(), runner, fileSystem })
    patchPath = created.patchPath
    runner.handler = async (_command, args) => {
      if (args.includes('remove')) {
        events.push('remove')
        await fs.writeFile(patchPath, '# recreated by remove\n[]\n')
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    await expect(created.manager.attach('web', 'http://localhost:8080', async () => {
      events.push('validate')
      throw new Error('validation failed')
    })).rejects.toMatchObject({ code: 'E_PROFILE_WRITE' })

    expect(events).toEqual(['write', 'validate', 'remove', 'write'])
    await expect(fs.readFile(patchPath)).resolves.toEqual(original)
  })

  it('removes a patch recreated by successful plugin cleanup when the original was absent', async () => {
    const runner = new RecordingRunner()
    const { manager, patchPath } = await fixture({ runner })
    runner.handler = async (_command, args) => {
      if (args.includes('remove')) await fs.writeFile(patchPath, '# recreated by remove\n[]\n')
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    await expect(manager.attach('web', 'http://localhost:8080', async () => {
      throw new Error('validation failed')
    })).rejects.toMatchObject({ code: 'E_PROFILE_WRITE' })
    await expect(fs.lstat(patchPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a patch modified by failed plugin cleanup and reports the cleanup failure', async () => {
    const runner = new RecordingRunner()
    const partial = '# partial remove result\n- id: preserve-me\n'
    const { manager, patchPath } = await fixture({ patch: '[]\n', runner })
    runner.handler = async (_command, args) => {
      if (args.includes('remove')) {
        await fs.writeFile(patchPath, partial)
        return { exitCode: 1, stdout: '', stderr: 'private cleanup failure' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    await expect(manager.attach('web', 'http://localhost:8080', async () => {
      throw new Error('validation failed')
    })).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { rollbackFailures: expect.arrayContaining(['plugin']) },
    })
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe(partial)
  })

  it('preserves command cancellation after confirming there was no install side effect', async () => {
    const runner = new RecordingRunner()
    const cancellation = new Error('cancel secret endpoint https://private.invalid?q=token')
    cancellation.name = 'AbortError'
    runner.failure = cancellation
    const { manager, patchPath } = await fixture({ patch: '[]\n', runner })
    let error: unknown
    try { await manager.attach('web', 'http://localhost:8080', async () => {}) } catch (cause) { error = cause }
    expect(error).toBe(cancellation)
    expect(JSON.stringify(error)).not.toContain('private.invalid')
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe('[]\n')
  })

  it('passes the exact signal to add, detects an install side effect after abort, cleans it, then rethrows cancellation', async () => {
    const controller = new AbortController()
    const cancellation = new Error('cancelled')
    cancellation.name = 'AbortError'
    const runner = new RecordingRunner()
    const { manager, dir } = await fixture({ patch: '[]\n', runner })
    runner.handler = async (_command, args) => {
      if (args.includes('add')) {
        await fs.writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-searxng': '0.1.0' } }))
        throw cancellation
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    let error: unknown
    try {
      await manager.attach('web', 'http://localhost:8080', async () => {}, controller.signal)
    } catch (cause) { error = cause }

    expect(error).toBe(cancellation)
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['plugin', '--profile', 'web', 'add', 'dsh-searxng'],
      ['plugin', '--profile', 'web', 'remove', 'dsh-searxng'],
    ])
    expect(runner.signals[0]).toBe(controller.signal)
  })

  it('detects and removes an install side effect after a nonzero add result', async () => {
    const runner = new RecordingRunner()
    const { manager, dir } = await fixture({ patch: '[]\n', runner })
    runner.handler = async (_command, args) => {
      if (args.includes('add')) {
        await fs.writeFile(join(dir, 'package.json'), JSON.stringify({
          dsh: { profile: { bundles: ['dsh-searxng'] } },
        }))
        return { exitCode: 1, stdout: '', stderr: 'unsafe process output' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    await expect(manager.attach('web', 'http://localhost:8080', async () => {})).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { primaryFailure: 'install', primaryError: 'process' },
    })
    expect(runner.calls.at(-1)?.args).toEqual(['plugin', '--profile', 'web', 'remove', 'dsh-searxng'])
  })

  it('preserves a patch initialized by the add command', async () => {
    const runner = new RecordingRunner()
    const { manager, dir, patchPath } = await fixture({ runner })
    runner.handler = async () => {
      await fs.writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-searxng': '0.1.0' } }))
      await fs.writeFile(patchPath, '# initialized by dsh\n- id: initialized\n  config: { keep: true }\n')
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    await manager.attach('web', 'http://localhost:8080', async () => {})
    const output = await fs.readFile(patchPath, 'utf8')
    expect(output).toContain('# initialized by dsh')
    expect(ids(output)).toEqual(['initialized', 'web-search-searxng'])
  })

  it('renders from an existing patch edited during add', async () => {
    const runner = new RecordingRunner()
    const { manager, dir, patchPath } = await fixture({ patch: '[]\n', runner })
    runner.handler = async () => {
      await fs.writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-searxng': '0.1.0' } }))
      await fs.writeFile(patchPath, '# changed during add\n- id: concurrent-add\n')
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    await manager.attach('web', 'http://localhost:8080', async () => {})
    const output = await fs.readFile(patchPath, 'utf8')
    expect(output).toContain('# changed during add')
    expect(ids(output)).toEqual(['concurrent-add', 'web-search-searxng'])
  })

  it('does not overwrite a concurrent patch change observed before commit', async () => {
    const original = '# original\n[]\n'
    const concurrent = '# concurrent before commit\n- id: editor\n'
    let patchReads = 0
    let patchPath = ''
    const fileSystem: ProfileFileSystem = {
      ...fs,
      readFile: (async (...args: Parameters<typeof fs.readFile>) => {
        if (String(args[0]) === patchPath) {
          patchReads += 1
          if (patchReads === 3) await fs.writeFile(patchPath, concurrent)
        }
        return fs.readFile(...args)
      }) as typeof fs.readFile,
    }
    const created = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.0' } },
      patch: original,
      fileSystem,
    })
    patchPath = created.patchPath

    await expect(created.manager.attach('web', 'http://localhost:8080', async () => {})).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { primaryFailure: 'write', primaryError: 'profile-conflict' },
    })
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe(concurrent)
  })

  it('preserves a concurrent validation edit and reports rollback conflict', async () => {
    const concurrent = '# concurrent during validation\n- id: editor\n'
    const validationError = new CliError('E_SEARCH_FAILED', 'Search failed', 'Retry')
    const { manager, patchPath } = await fixture({ patch: '[]\n' })
    await expect(manager.attach('web', 'http://localhost:8080', async () => {
      await fs.writeFile(patchPath, concurrent)
      throw validationError
    })).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: {
        primaryFailure: 'validation',
        primaryError: 'E_SEARCH_FAILED',
        rollbackFailures: ['patch-conflict'],
      },
    })
    await expect(fs.readFile(patchPath, 'utf8')).resolves.toBe(concurrent)
  })

  it('treats a same-byte atomic replacement during validation as a rollback conflict', async () => {
    const validationError = new CliError('E_SEARCH_FAILED', 'Search failed', 'Retry')
    const { manager, patchPath } = await fixture({ patch: '[]\n' })
    let replacementInode: number | undefined
    await expect(manager.attach('web', 'http://localhost:8080', async () => {
      const managedBytes = await fs.readFile(patchPath)
      const replacement = `${patchPath}.editor`
      await fs.writeFile(replacement, managedBytes)
      await fs.rename(replacement, patchPath)
      replacementInode = (await fs.lstat(patchPath)).ino
      throw validationError
    })).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { rollbackFailures: ['patch-conflict'] },
    })
    expect((await fs.lstat(patchPath)).ino).toBe(replacementInode)
    expect(await fs.readFile(patchPath, 'utf8')).toContain('dsh-searxng managed attachment')
  })

  it('cleans temporary files and restores the original after a directory fsync failure', async () => {
    let failDirectorySync = true
    const fileSystem: ProfileFileSystem = {
      ...fs,
      open: async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args)
        if (args[1] === 'r' && failDirectorySync) {
          failDirectorySync = false
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'sync') return async () => { throw new Error('directory fsync failed') }
              const value = Reflect.get(target, property, target) as unknown
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        }
        return handle
      },
    }
    const original = Buffer.from('# exact\n[]\n')
    const { manager, dir, patchPath } = await fixture({ patch: original.toString(), fileSystem })
    await expect(manager.attach('web', 'http://localhost:8080', async () => {})).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { primaryFailure: 'write', primaryError: 'filesystem', rollbackFailures: [] },
    })
    await expect(fs.readFile(patchPath)).resolves.toEqual(original)
    expect((await fs.readdir(dir)).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('preserves a same-byte foreign replacement made while post-rename directory fsync fails', async () => {
    let replaceDuringDirectorySync = true
    let patchPath = ''
    let foreignInode: number | undefined
    const fileSystem: ProfileFileSystem = {
      ...fs,
      open: async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args)
        if (args[1] === 'r' && replaceDuringDirectorySync) {
          replaceDuringDirectorySync = false
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'sync') return async () => {
                const committedBytes = await fs.readFile(patchPath)
                const replacement = `${patchPath}.foreign`
                await fs.writeFile(replacement, committedBytes)
                await fs.rename(replacement, patchPath)
                foreignInode = (await fs.lstat(patchPath)).ino
                throw new Error('directory fsync failed after foreign replacement')
              }
              const value = Reflect.get(target, property, target) as unknown
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        }
        return handle
      },
    }
    const created = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.0' } },
      patch: '[]\n',
      fileSystem,
    })
    patchPath = created.patchPath

    await expect(created.manager.attach('web', 'http://localhost:8080', async () => {})).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { rollbackFailures: ['patch-conflict'] },
    })
    expect((await fs.lstat(patchPath)).ino).toBe(foreignInode)
    expect(await fs.readFile(patchPath, 'utf8')).toContain('dsh-searxng managed attachment')
  })

  it('rejects and preserves a same-byte foreign replacement made immediately after rename', async () => {
    let replaceAfterRename = true
    let patchPath = ''
    let foreignInode: number | undefined
    const fileSystem: ProfileFileSystem = {
      ...fs,
      rename: async (...args: Parameters<typeof fs.rename>) => {
        await fs.rename(...args)
        if (String(args[1]) === patchPath && replaceAfterRename) {
          replaceAfterRename = false
          const committedBytes = await fs.readFile(patchPath)
          const replacement = `${patchPath}.foreign-after-rename`
          await fs.writeFile(replacement, committedBytes)
          await fs.rename(replacement, patchPath)
          foreignInode = (await fs.lstat(patchPath)).ino
        }
      },
    }
    const created = await fixture({
      packageJson: { dependencies: { 'dsh-searxng': '0.1.0' } },
      patch: '[]\n',
      fileSystem,
    })
    patchPath = created.patchPath
    let validations = 0

    await expect(created.manager.attach('web', 'http://localhost:8080', async () => {
      validations += 1
    })).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { primaryError: 'profile-conflict', rollbackFailures: ['patch-conflict'] },
    })
    expect(validations).toBe(0)
    expect((await fs.lstat(patchPath)).ino).toBe(foreignInode)
    expect(await fs.readFile(patchPath, 'utf8')).toContain('dsh-searxng managed attachment')
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

  it('rejects and preserves a same-byte foreign replacement immediately after detach rename', async () => {
    const patch = `# dsh-searxng managed attachment
- id: web-search-searxng
  config: { baseURL: http://managed.invalid }
- id: user
  config: { keep: true }
`
    let replaceAfterRename = true
    let patchPath = ''
    let foreignInode: number | undefined
    const fileSystem: ProfileFileSystem = {
      ...fs,
      rename: async (...args: Parameters<typeof fs.rename>) => {
        await fs.rename(...args)
        if (String(args[1]) === patchPath && replaceAfterRename) {
          replaceAfterRename = false
          const detachedBytes = await fs.readFile(patchPath)
          const replacement = `${patchPath}.foreign-detach`
          await fs.writeFile(replacement, detachedBytes)
          await fs.rename(replacement, patchPath)
          foreignInode = (await fs.lstat(patchPath)).ino
        }
      },
    }
    const created = await fixture({ patch, fileSystem })
    patchPath = created.patchPath

    await expect(created.manager.detach('web')).rejects.toMatchObject({
      code: 'E_PROFILE_WRITE',
      details: { primaryError: 'profile-conflict', rollbackFailures: ['patch-conflict'] },
    })
    expect((await fs.lstat(patchPath)).ino).toBe(foreignInode)
    expect(ids(await fs.readFile(patchPath, 'utf8'))).toEqual(['user'])
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

  it('rejects an aliased target config safely before mutation', async () => {
    const patch = `- id: source
  config: &shared
    timeoutMs: 1000
- id: web-search-searxng
  config: *shared
`
    const original = Buffer.from(patch)
    const { manager, runner, patchPath } = await fixture({ patch })
    await expect(manager.attach('web', 'http://localhost:8080', async () => {}))
      .rejects.toMatchObject({ code: 'E_PROFILE_WRITE', details: {} })
    expect(runner.calls).toEqual([])
    await expect(fs.readFile(patchPath)).resolves.toEqual(original)
  })

  it('rejects removing a managed anchor referenced by a later retained alias', async () => {
    const patch = `# dsh-searxng managed attachment
- id: web-search-searxng
  config: &managed
    baseURL: http://old.invalid
- id: later
  config: *managed
`
    const original = Buffer.from(patch)
    const { manager, runner, patchPath } = await fixture({ patch })
    await expect(manager.attach('web', 'http://localhost:8080', async () => {}))
      .rejects.toMatchObject({ code: 'E_PROFILE_WRITE', details: {} })
    expect(runner.calls).toEqual([])
    await expect(fs.readFile(patchPath)).resolves.toEqual(original)
  })
})
