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
const configurationSha = 'a'.repeat(64)
const identity: ManagedIdentity = {
  stateDir: '/private/state',
  composePath: `/private/state/config-${configurationSha}/compose.yml`,
  homeId: '0123456789abcdef',
  projectName: 'dsh-searxng-0123456789abcdef',
  containerName: 'dsh-searxng-0123456789abcdef',
}
const networkName = `${identity.projectName}-network`
const cacheVolumeName = `${identity.projectName}-cache`
const ownedLabels = {
  'io.dsh-searxng.managed': 'true',
  'io.dsh-searxng.home-id': identity.homeId,
  'io.dsh-searxng.schema': '1',
  'io.dsh-searxng.deployment-version': '1',
}
const ownedContainerInspect = JSON.stringify([{ Config: { Labels: ownedLabels } }])
const ownedNetworkInspect = JSON.stringify([{ Labels: ownedLabels }])
const ownedVolumeInspect = JSON.stringify([{ Labels: ownedLabels }])
const deploymentContainerInspect = JSON.stringify([{
  Config: { Labels: {
    ...ownedLabels,
    'com.docker.compose.project': identity.projectName,
    'com.docker.compose.project.config_files': identity.composePath,
  } },
  State: { Running: true },
}])
const ownedResourceResults = (): CommandResult[] => [ok(ownedContainerInspect), ok(ownedNetworkInspect), ok(ownedVolumeInspect)]
const absentResourceResults = (): CommandResult[] => [
  failed('Error: No such container'),
  failed(`Error response from daemon: network ${networkName} not found`),
  failed('Error: No such volume'),
]
const composePrefix = [
  'compose',
  '--project-directory', identity.stateDir,
  '--env-file', joinForTest(identity.composePath, '.env'),
  '-f', identity.composePath,
  '--project-name', identity.projectName,
]

function joinForTest(composePath: string, file: string): string {
  return `${composePath.slice(0, composePath.lastIndexOf('/'))}/${file}`
}

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

describe('CliDockerAdapter deployment status', () => {
  it('returns the trusted Compose path and container state from owned labels', async () => {
    const adapter = new CliDockerAdapter(new FakeRunner(ok(deploymentContainerInspect), ok(ownedNetworkInspect), ok(ownedVolumeInspect)))
    await expect(adapter.deploymentStatus(identity)).resolves.toEqual({
      ownership: 'owned', container: 'running', composePath: identity.composePath,
    })
  })

  it('rejects an untrusted Compose path before removal can use it', async () => {
    const unsafe = JSON.stringify([{
      Config: { Labels: {
        ...ownedLabels,
        'com.docker.compose.project': identity.projectName,
        'com.docker.compose.project.config_files': '/tmp/foreign/compose.yml',
      } },
      State: { Running: true },
    }])
    const adapter = new CliDockerAdapter(new FakeRunner(ok(unsafe), ok(ownedNetworkInspect), ok(ownedVolumeInspect)))
    await expectCode(adapter.deploymentStatus(identity), 'E_RESOURCE_FOREIGN')
  })
})

describe('CliDockerAdapter ownership', () => {
  it('reports complete absence after inspecting the exact container, network, and volume', async () => {
    const runner = new FakeRunner(...absentResourceResults())
    await expect(new CliDockerAdapter(runner).inspectOwnership(identity)).resolves.toBe('absent')
    expect(runner.invocations.map(({ command, args }) => [command, args])).toEqual([
      ['docker', ['container', 'inspect', identity.containerName]],
      ['docker', ['network', 'inspect', networkName]],
      ['docker', ['volume', 'inspect', cacheVolumeName]],
    ])
  })

  it('does not interpret an unrelated inspect failure as absence', async () => {
    await expectCode(
      new CliDockerAdapter(new FakeRunner(failed('permission denied'))).inspectOwnership(identity),
      'E_INTERNAL',
    )
  })

  it('accepts all resources only with the four expected ownership labels', async () => {
    await expect(new CliDockerAdapter(new FakeRunner(...ownedResourceResults())).inspectOwnership(identity)).resolves.toBe('owned')
  })

  it.each([
    JSON.stringify([{ Config: { Labels: {} } }]),
    JSON.stringify([{ Config: { Labels: { 'io.dsh-searxng.managed': 'true', 'io.dsh-searxng.home-id': 'ffffffffffffffff' } } }]),
    JSON.stringify([{ Config: { Labels: { ...ownedLabels, 'io.dsh-searxng.managed': true } } }]),
    JSON.stringify([{ Config: { Labels: [] } }]),
    '{}',
    'not-json',
    JSON.stringify([{ Config: { Labels: ownedLabels } }, { Config: { Labels: ownedLabels } }]),
  ])('rejects foreign, malformed, or ambiguous inspect output %#', async (inspect) => {
    await expectCode(new CliDockerAdapter(new FakeRunner(ok(inspect))).inspectOwnership(identity), 'E_RESOURCE_FOREIGN')
  })

  it.each([
    ['network', [ok(ownedContainerInspect), ok(JSON.stringify([{ Labels: {} }]))]],
    ['volume', [ok(ownedContainerInspect), ok(ownedNetworkInspect), ok(JSON.stringify([{ Labels: { ...ownedLabels, 'io.dsh-searxng.schema': '2' } }]))]],
  ] as const)('rejects a foreign %s before any Compose command', async (_resource, responses) => {
    const runner = new FakeRunner(...responses)
    await expectCode(new CliDockerAdapter(runner).up(identity), 'E_RESOURCE_FOREIGN')
    expect(runner.invocations.every(({ args }) => args[0] !== 'compose')).toBe(true)
  })

  it('treats a partially present but fully owned resource set as owned', async () => {
    const runner = new FakeRunner(failed('No such container'), ok(ownedNetworkInspect), failed('No such volume'))
    await expect(new CliDockerAdapter(runner).inspectOwnership(identity)).resolves.toBe('owned')
  })

  it.each([
    { ...identity, homeId: 'ABCDEF0123456789', projectName: 'dsh-searxng-ABCDEF0123456789', containerName: 'dsh-searxng-ABCDEF0123456789' },
    { ...identity, projectName: 'foreign-project' },
    { ...identity, containerName: 'foreign-container' },
    { ...identity, stateDir: 'relative/state', composePath: `relative/state/config-${configurationSha}/compose.yml` },
    { ...identity, stateDir: '/private/state\nother', composePath: `/private/state\nother/config-${configurationSha}/compose.yml` },
    { ...identity, composePath: `/private/state/config-${configurationSha}/other.yml` },
    { ...identity, composePath: `/private/state/nested/config-${configurationSha}/compose.yml` },
    { ...identity, composePath: `/private/state/config-${'g'.repeat(64)}/compose.yml` },
    { ...identity, composePath: `/private/state/config-${configurationSha}/../compose.yml` },
  ])('rejects a non-canonical managed identity before invoking Docker: %#', async (invalidIdentity) => {
    const runner = new FakeRunner()
    await expectCode(new CliDockerAdapter(runner).inspectOwnership(invalidIdentity), 'E_USAGE')
    expect(runner.invocations).toEqual([])
  })

  it('propagates inspect cancellation', async () => {
    const aborted = new Error('cancelled')
    aborted.name = 'AbortError'
    await expect(new CliDockerAdapter(new FakeRunner(ok(ownedContainerInspect), aborted)).inspectOwnership(identity)).rejects.toBe(aborted)
  })
})

describe('CliDockerAdapter Compose operations', () => {
  it('restarts the exact owned container only after validating all owned resources', async () => {
    const signal = new AbortController().signal
    const runner = new FakeRunner(...ownedResourceResults(), ok('restarted'))
    await new CliDockerAdapter(runner).restart(identity, signal)
    expect(runner.invocations.map(({ command, args }) => [command, args])).toEqual([
      ['docker', ['container', 'inspect', identity.containerName]],
      ['docker', ['network', 'inspect', networkName]],
      ['docker', ['volume', 'inspect', cacheVolumeName]],
      ['docker', ['container', 'restart', identity.containerName]],
    ])
    expect(runner.invocations[3]?.options).toEqual({ signal })
  })

  it.each([
    ['container', [ok(JSON.stringify([{ Config: { Labels: {} } }]))]],
    ['network', [ok(ownedContainerInspect), ok(JSON.stringify([{ Labels: {} }]))]],
    ['volume', [ok(ownedContainerInspect), ok(ownedNetworkInspect), ok(JSON.stringify([{ Labels: {} }]))]],
  ] as const)('blocks restart when the %s is foreign', async (_kind, responses) => {
    const runner = new FakeRunner(...responses)
    await expectCode(new CliDockerAdapter(runner).restart(identity), 'E_RESOURCE_FOREIGN')
    expect(runner.invocations.every(({ args }) => args[1] !== 'restart')).toBe(true)
  })

  it('blocks restart when the managed container or another required resource is absent', async () => {
    const missingContainer = new FakeRunner(failed('No such container'), ok(ownedNetworkInspect), ok(ownedVolumeInspect))
    await expectCode(new CliDockerAdapter(missingContainer).restart(identity), 'E_STATE_INVALID')
    expect(missingContainer.invocations).toHaveLength(3)

    const missingVolume = new FakeRunner(ok(ownedContainerInspect), ok(ownedNetworkInspect), failed('No such volume'))
    await expectCode(new CliDockerAdapter(missingVolume).restart(identity), 'E_STATE_INVALID')
    expect(missingVolume.invocations).toHaveLength(3)
  })

  it('propagates restart cancellation and maps nonzero output without leaking it', async () => {
    const aborted = new Error('cancelled')
    aborted.name = 'AbortError'
    await expect(new CliDockerAdapter(new FakeRunner(...ownedResourceResults(), aborted)).restart(identity)).rejects.toBe(aborted)

    const failedRunner = new FakeRunner(...ownedResourceResults(), failed('secret=a:b#c'))
    const error = await new CliDockerAdapter(failedRunner).restart(identity).catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: 'E_INTERNAL',
      message: expect.stringMatching(/container restart/i),
      action: expect.stringMatching(/doctor/i),
    })
    expect(JSON.stringify((error as CliError).toJSON())).not.toContain('a:b#c')
  })

  it('uses exact identity arguments for an absent resource up', async () => {
    const runner = new FakeRunner(...absentResourceResults(), ok())
    await new CliDockerAdapter(runner).up(identity)
    expect(runner.invocations[3]).toMatchObject({ command: 'docker', args: [...composePrefix, 'up', '--detach'] })
  })

  it('refuses up before Compose can touch a foreign same-name resource', async () => {
    const runner = new FakeRunner(ok(JSON.stringify([{ Config: { Labels: {} } }])))
    await expectCode(new CliDockerAdapter(runner).up(identity), 'E_RESOURCE_FOREIGN')
    expect(runner.invocations).toHaveLength(1)
  })

  it('down is a no-op when absent and includes volumes only when explicitly requested', async () => {
    const absentRunner = new FakeRunner(...absentResourceResults())
    await new CliDockerAdapter(absentRunner).down(identity, true)
    expect(absentRunner.invocations).toHaveLength(3)

    const keepRunner = new FakeRunner(...ownedResourceResults(), ok())
    await new CliDockerAdapter(keepRunner).down(identity, false)
    expect(keepRunner.invocations[3]).toMatchObject({ command: 'docker', args: [...composePrefix, 'down'] })

    const purgeRunner = new FakeRunner(...ownedResourceResults(), ok())
    await new CliDockerAdapter(purgeRunner).down(identity, true)
    expect(purgeRunner.invocations[3]).toMatchObject({ command: 'docker', args: [...composePrefix, 'down', '--volumes'] })
  })

  it('runs down for a partially present owned set and blocks a foreign leftover volume', async () => {
    const partialRunner = new FakeRunner(failed('No such container'), ok(ownedNetworkInspect), failed('No such volume'), ok())
    await new CliDockerAdapter(partialRunner).down(identity, false)
    expect(partialRunner.invocations[3]).toMatchObject({ args: [...composePrefix, 'down'] })

    const foreignVolumeRunner = new FakeRunner(
      failed('No such container'),
      failed('No such network'),
      ok(JSON.stringify([{ Labels: {} }])),
    )
    await expectCode(new CliDockerAdapter(foreignVolumeRunner).down(identity, true), 'E_RESOURCE_FOREIGN')
    expect(foreignVolumeRunner.invocations).toHaveLength(3)
  })

  it('maps a nonzero Compose result without leaking its output', async () => {
    const adapter = new CliDockerAdapter(new FakeRunner(...absentResourceResults(), failed('secret=a:b#c')))
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
    const runner = new FakeRunner(...ownedResourceResults(), ok(`secret_key=${secret}\n${'x'.repeat(100)}`))
    const adapter = new CliDockerAdapter(runner, { maxLogBytes: 32 })
    const logs = await adapter.logs(identity, 50)
    expect(logs).not.toContain(secret)
    expect(Buffer.byteLength(logs)).toBeLessThanOrEqual(32)
    expect(runner.invocations[3]).toMatchObject({
      command: 'docker',
      args: [...composePrefix, 'logs', '--no-color', '--tail', '50', 'searxng'],
    })
  })

  it.each([
    'Authorization: Bearer test-token-123',
    'authorization=BEARER test-token-123',
    'AUTHORIZATION: bearer test-token-123',
    '{"Authorization":"Bearer test-token-123"}',
  ])('redacts the complete bearer credential in %s', async (line) => {
    for (const maxLogBytes of [1024, 32]) {
      const runner = new FakeRunner(...ownedResourceResults(), ok(`${line}\n${'x'.repeat(100)}`))
      const logs = await new CliDockerAdapter(runner, { maxLogBytes }).logs(identity, 10)
      expect(logs).not.toContain('test-token-123')
      expect(logs.toLowerCase()).not.toContain('bearer test-token-123')
      expect(Buffer.byteLength(logs)).toBeLessThanOrEqual(maxLogBytes)
    }
  })

  it.each([
    ['query=needleAlpha needleBeta needleGamma needleDelta\nstatus=ok', ['status=ok']],
    ['search_query: needleAlpha needleBeta needleGamma needleDelta, status=ok', []],
    ['SEARCH-QUERY=needleAlpha: needleBeta? needleGamma! needleDelta; elapsed=12', []],
    ['SearchQuery: needleAlpha,needleBeta needleGamma needleDelta\nlevel=info', ['level=info']],
    ['{"query":"needleAlpha needleBeta needleGamma needleDelta","status":"ok"}', ['"status":"ok"']],
    ['{"search_query":"needleAlpha, needleBeta; needleGamma needleDelta","status":"ok"}', ['"status":"ok"']],
    [
      'query=needleAlpha needleBeta\nstatus=ok\nsearch-query: needleGamma needleDelta\nlevel=info',
      ['status=ok', 'level=info'],
    ],
  ])('redacts complete multi-word search values while preserving following records: %s', async (line, safeFields) => {
    const runner = new FakeRunner(...ownedResourceResults(), ok(line))
    const logs = await new CliDockerAdapter(runner, { maxLogBytes: 4096 }).logs(identity, 10)
    for (const term of ['needleAlpha', 'needleBeta', 'needleGamma', 'needleDelta']) {
      expect(logs.toLowerCase()).not.toContain(term.toLowerCase())
    }
    for (const field of safeFields) expect(logs).toContain(field)
  })

  it('redacts all query terms before applying the byte cap', async () => {
    const line = `query=needleAlpha needleBeta needleGamma needleDelta\n${'x'.repeat(200)}`
    const runner = new FakeRunner(...ownedResourceResults(), ok(line))
    const logs = await new CliDockerAdapter(runner, { maxLogBytes: 32 }).logs(identity, 10)
    expect(Buffer.byteLength(logs)).toBeLessThanOrEqual(32)
    for (const term of ['needleAlpha', 'needleBeta', 'needleGamma', 'needleDelta']) {
      expect(logs.toLowerCase()).not.toContain(term.toLowerCase())
    }
  })

  it.each([
    ['query=private topic, site:example.com\nstatus=ok', ['private', 'topic', 'site', 'example.com']],
    ['search_query=private topic; author:Alice\nstatus=ok', ['private', 'topic', 'author', 'Alice']],
  ])('treats query-like operators as sensitive plain-text query content: %s', async (line, sensitiveTerms) => {
    const runner = new FakeRunner(...ownedResourceResults(), ok(line))
    const logs = await new CliDockerAdapter(runner).logs(identity, 10)
    for (const term of sensitiveTerms) expect(logs.toLowerCase()).not.toContain(term.toLowerCase())
    expect(logs).toContain('status=ok')
  })

  it.each([
    ['GET /search?q=private+topic&format=json HTTP/1.1', ['private', 'topic']],
    ['GET /search?Q=Private%20Topic&format=json HTTP/1.1', ['private', 'topic', '%20']],
    ['POST /search?search_query=private%2Btopic&format=json HTTP/1.1', ['private', 'topic', '%2b']],
    ['POST /search?Search-Query=Private+Topic&format=json HTTP/1.1', ['private', 'topic']],
    ['q=private+topic&format=json', ['private', 'topic']],
  ])('redacts access-log and form query parameters before capping: %s', async (line, sensitiveTerms) => {
    for (const maxLogBytes of [4096, 48]) {
      const runner = new FakeRunner(...ownedResourceResults(), ok(`${line}\n${'x'.repeat(100)}`))
      const logs = await new CliDockerAdapter(runner, { maxLogBytes }).logs(identity, 10)
      for (const term of sensitiveTerms) expect(logs.toLowerCase()).not.toContain(term)
      if (line.includes('/search')) expect(logs).toContain('/search')
      if (maxLogBytes === 4096) expect(logs).toContain('format=json')
    }
  })

  it('passes bounded logs through the injected structural redactor', async () => {
    const runner = new FakeRunner(...ownedResourceResults(), ok('public private'))
    const adapter = new CliDockerAdapter(runner, {
      redact(value) {
        const input = value as { output: string }
        return { output: input.output.replace('private', '[REDACTED]') }
      },
    })
    await expect(adapter.logs(identity, 10)).resolves.toBe('public [REDACTED]')
  })

  it('returns no logs for an absent resource without invoking Compose', async () => {
    const runner = new FakeRunner(...absentResourceResults())
    await expect(new CliDockerAdapter(runner).logs(identity, 50)).resolves.toBe('')
    expect(runner.invocations).toHaveLength(3)
  })
})
