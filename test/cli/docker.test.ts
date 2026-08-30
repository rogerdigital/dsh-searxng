import { describe, expect, it } from 'vitest'
import { CliError } from '../../src/cli/errors.ts'
import { CliDockerAdapter } from '../../src/cli/docker.ts'
import { ProcessExecutionError, type CommandResult, type CommandRunner } from '../../src/cli/process.ts'
import type { ManagedIdentity } from '../../src/cli/assets.ts'

interface Invocation { command: string; args: readonly string[]; options?: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } }

class FakeRunner implements CommandRunner {
  readonly invocations: Invocation[] = []
  private readonly responses: Array<CommandResult | Error>
  constructor(...responses: Array<CommandResult | Error>) { this.responses = responses }
  async run(command: string, args: readonly string[], options?: Invocation['options']): Promise<CommandResult> {
    this.invocations.push({ command, args, options })
    const response = this.responses.shift()
    if (response === undefined) throw new Error('Unexpected invocation')
    if (response instanceof Error) throw response
    return response
  }
}

const ok = (stdout = '', stderr = ''): CommandResult => ({ exitCode: 0, stdout, stderr })
const failed = (stderr = ''): CommandResult => ({ exitCode: 1, stdout: '', stderr })
const identity: ManagedIdentity = {
  stateDir: '/private/state',
  composePath: '/private/state/compose.yml',
  homeId: '0123456789abcdef',
  projectName: 'dsh-searxng-0123456789abcdef',
  containerName: 'dsh-searxng-0123456789abcdef',
}
const ownedInspect = JSON.stringify([{ Config: { Labels: {
  'io.dsh-searxng.managed': 'true',
  'io.dsh-searxng.home-id': identity.homeId,
} } }])
const composePrefix = [
  'compose',
  '--project-directory', identity.stateDir,
  '-f', identity.composePath,
  '--project-name', identity.projectName,
]

async function expectCode(promise: Promise<unknown>, code: CliError['code']): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code })
}

describe('CliDockerAdapter preflight', () => {
  it('classifies a missing Docker executable separately from an offline daemon', async () => {
    const missing = new CliDockerAdapter(new FakeRunner(new ProcessExecutionError('spawn', 'missing')))
    await expectCode(missing.preflight(), 'E_DOCKER_MISSING')

    const offline = new CliDockerAdapter(new FakeRunner(failed('Cannot connect to the Docker daemon')))
    await expectCode(offline.preflight(), 'E_DOCKER_OFFLINE')
  })

  it('does not misclassify a started Docker process failure as a missing executable', async () => {
    const adapter = new CliDockerAdapter(new FakeRunner(new ProcessExecutionError('process-cleanup', 'cleanup failed')))
    await expectCode(adapter.preflight(), 'E_DOCKER_OFFLINE')
  })

  it.each(['1.29.2', 'Docker Compose version v1.29.2'])('rejects unsupported Compose %s', async (version) => {
    const adapter = new CliDockerAdapter(new FakeRunner(ok('27.5.1\n'), ok(`${version}\n`)))
    await expectCode(adapter.preflight(), 'E_COMPOSE_UNSUPPORTED')
  })

  it.each(['2.39.4', 'v2.39.4', 'Docker Compose version v2.39.4-desktop.1'])('accepts Compose %s', async (version) => {
    const runner = new FakeRunner(ok('27.5.1\n'), ok(`${version}\n`))
    await expect(new CliDockerAdapter(runner).preflight()).resolves.toEqual({ serverVersion: '27.5.1', composeVersion: version })
    expect(runner.invocations.map(({ command, args }) => [command, args])).toEqual([
      ['docker', ['version', '--format', '{{.Server.Version}}']],
      ['docker', ['compose', 'version', '--short']],
    ])
  })

  it('propagates cancellation without reclassification', async () => {
    const aborted = new Error('cancelled')
    aborted.name = 'AbortError'
    const adapter = new CliDockerAdapter(new FakeRunner(aborted))
    await expect(adapter.preflight()).rejects.toBe(aborted)
  })
})

describe('CliDockerAdapter ownership', () => {
  it('reports an absent derived container', async () => {
    const runner = new FakeRunner(failed('Error: No such object'))
    await expect(new CliDockerAdapter(runner).inspectOwnership(identity)).resolves.toBe('absent')
    expect(runner.invocations[0]).toMatchObject({ command: 'docker', args: ['container', 'inspect', identity.containerName] })
  })

  it('does not interpret an unrelated inspect failure as absence', async () => {
    await expectCode(
      new CliDockerAdapter(new FakeRunner(failed('permission denied'))).inspectOwnership(identity),
      'E_INTERNAL',
    )
  })

  it('accepts only the expected pair of ownership labels', async () => {
    await expect(new CliDockerAdapter(new FakeRunner(ok(ownedInspect))).inspectOwnership(identity)).resolves.toBe('owned')
  })

  it.each([
    JSON.stringify([{ Config: { Labels: {} } }]),
    JSON.stringify([{ Config: { Labels: { 'io.dsh-searxng.managed': 'true', 'io.dsh-searxng.home-id': 'ffffffffffffffff' } } }]),
    JSON.stringify([{ Config: { Labels: { 'io.dsh-searxng.managed': true, 'io.dsh-searxng.home-id': identity.homeId } } }]),
    JSON.stringify([{ Config: { Labels: [] } }]),
    '{}',
    'not-json',
    JSON.stringify([{ Config: { Labels: { 'io.dsh-searxng.managed': 'true', 'io.dsh-searxng.home-id': identity.homeId } } }, { Config: { Labels: {} } }]),
  ])('rejects foreign, malformed, or ambiguous inspect output %#', async (inspect) => {
    await expectCode(new CliDockerAdapter(new FakeRunner(ok(inspect))).inspectOwnership(identity), 'E_RESOURCE_FOREIGN')
  })

  it('propagates inspect cancellation', async () => {
    const aborted = new Error('cancelled')
    aborted.name = 'AbortError'
    await expect(new CliDockerAdapter(new FakeRunner(aborted)).inspectOwnership(identity)).rejects.toBe(aborted)
  })
})

describe('CliDockerAdapter Compose operations', () => {
  it('uses exact identity arguments for an absent resource up', async () => {
    const runner = new FakeRunner(failed('No such object'), ok())
    await new CliDockerAdapter(runner).up(identity)
    expect(runner.invocations[1]).toMatchObject({ command: 'docker', args: [...composePrefix, 'up', '--detach'] })
  })

  it('refuses up before Compose can touch a foreign same-name resource', async () => {
    const runner = new FakeRunner(ok(JSON.stringify([{ Config: { Labels: {} } }])))
    await expectCode(new CliDockerAdapter(runner).up(identity), 'E_RESOURCE_FOREIGN')
    expect(runner.invocations).toHaveLength(1)
  })

  it('down is a no-op when absent and includes volumes only when explicitly requested', async () => {
    const absentRunner = new FakeRunner(failed('No such object'))
    await new CliDockerAdapter(absentRunner).down(identity, true)
    expect(absentRunner.invocations).toHaveLength(1)

    const keepRunner = new FakeRunner(ok(ownedInspect), ok())
    await new CliDockerAdapter(keepRunner).down(identity, false)
    expect(keepRunner.invocations[1]).toMatchObject({ command: 'docker', args: [...composePrefix, 'down'] })

    const purgeRunner = new FakeRunner(ok(ownedInspect), ok())
    await new CliDockerAdapter(purgeRunner).down(identity, true)
    expect(purgeRunner.invocations[1]).toMatchObject({ command: 'docker', args: [...composePrefix, 'down', '--volumes'] })
  })

  it('maps a nonzero Compose result without leaking its output', async () => {
    const adapter = new CliDockerAdapter(new FakeRunner(failed('No such object'), failed('secret=a:b#c')))
    const error = await adapter.up(identity).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'E_INTERNAL' })
    expect(JSON.stringify((error as CliError).toJSON())).not.toContain('a:b#c')
  })

  it('validates a bounded positive logs tail before invoking Docker', async () => {
    for (const tail of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 1001]) {
      const runner = new FakeRunner()
      await expectCode(new CliDockerAdapter(runner).logs(identity, tail), 'E_USAGE')
      expect(runner.invocations).toHaveLength(0)
    }
  })

  it('caps and redacts logs after ownership validation', async () => {
    const secret = 'a:b#c'
    const runner = new FakeRunner(ok(ownedInspect), ok(`secret_key=${secret}\n${'x'.repeat(100)}`))
    const adapter = new CliDockerAdapter(runner, { maxLogBytes: 32 })
    const logs = await adapter.logs(identity, 50)
    expect(logs).not.toContain(secret)
    expect(Buffer.byteLength(logs)).toBeLessThanOrEqual(32)
    expect(runner.invocations[1]).toMatchObject({
      command: 'docker',
      args: [...composePrefix, 'logs', '--no-color', '--tail', '50', 'searxng'],
    })
  })

  it('passes bounded logs through the injected structural redactor', async () => {
    const runner = new FakeRunner(ok(ownedInspect), ok('public private'))
    const adapter = new CliDockerAdapter(runner, {
      redact(value) {
        const input = value as { output: string }
        return { output: input.output.replace('private', '[REDACTED]') }
      },
    })
    await expect(adapter.logs(identity, 10)).resolves.toBe('public [REDACTED]')
  })

  it('returns no logs for an absent resource without invoking Compose', async () => {
    const runner = new FakeRunner(failed('No such object'))
    await expect(new CliDockerAdapter(runner).logs(identity, 50)).resolves.toBe('')
    expect(runner.invocations).toHaveLength(1)
  })
})
