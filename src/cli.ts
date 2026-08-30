#!/usr/bin/env node

import { createServer, type Server } from 'node:net'
import { realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseCliArgs } from './cli/args.ts'
import { FileAssetRenderer } from './cli/assets.ts'
import { CliDockerAdapter } from './cli/docker.ts'
import { diagnose } from './cli/diagnostics.ts'
import { managedDir, NodeEnvironmentService, resolveDshHome, type PortChecker } from './cli/environment.ts'
import { CliError } from './cli/errors.ts'
import { presentError, presentSuccess } from './cli/presenter.ts'
import { NodeProcessRunner, type CommandRunner } from './cli/process.ts'
import { NodeProfileManager } from './cli/profile.ts'
import { remove, removeManagedDirectory, type RemoveDependencies } from './cli/remove.ts'
import { DefaultSearxngProbe } from './cli/searxng.ts'
import { setup, type SetupDependencies } from './cli/setup.ts'
import { FileStateStore } from './cli/state.ts'

type Writer = (text: string) => void

export interface RunCliOptions {
  dependencies?: SetupDependencies | CliDependencies
  createDependencies?: () => SetupDependencies | CliDependencies
  signal?: AbortSignal
  stdout?: Writer
  stderr?: Writer
}

export interface CliDependencies extends SetupDependencies {
  confirmPurge: RemoveDependencies['confirmPurge']
  removeManagedDirectory: RemoveDependencies['removeManagedDirectory']
}

export interface ProductionDependencyOptions {
  env?: NodeJS.ProcessEnv
  homedir?: string
  runner?: CommandRunner
  portChecker?: PortChecker
}

export async function isMainModule(
  moduleUrl: string,
  executedPath: string | undefined,
  canonicalize: (path: string) => Promise<string> = realpath,
): Promise<boolean> {
  if (executedPath === undefined) return false
  let modulePath: string
  try { modulePath = fileURLToPath(moduleUrl) } catch { return false }
  try {
    const [canonicalModule, canonicalExecuted] = await Promise.all([
      canonicalize(modulePath),
      canonicalize(executedPath),
    ])
    return canonicalModule === canonicalExecuted
  } catch {
    return resolve(modulePath) === resolve(executedPath)
  }
}

function usageError(message: string): CliError {
  return new CliError('E_USAGE', message, 'Run dsh-searxng setup with supported options')
}

const HELP = `dsh-searxng

Usage:
  dsh-searxng setup [--profile NAME] [--port PORT] [--url URL] [--json]
  dsh-searxng status [--profile NAME] [--json]
  dsh-searxng doctor [--profile NAME] [--json]
  dsh-searxng remove [--profile NAME] [--service] [--purge-data --yes] [--json]

Commands:
  setup    Configure an external SearXNG endpoint or create an owned Docker service
  status   Stop at the first failed health check
  doctor   Report the complete ordered diagnostic chain
  remove   Detach a profile, optionally removing the owned service and data
`

export function createLoopbackPortChecker(serverFactory: () => Server = createServer): PortChecker {
  return async (port, signal) => {
    signal?.throwIfAborted()
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw usageError('Port must be between 1 and 65535')

    return new Promise<boolean>((resolveAvailability, reject) => {
      const server = serverFactory()
      let settled = false
      let abortedReason: unknown

      const cleanup = () => {
        server.removeListener('listening', onListening)
        server.removeListener('error', onError)
        signal?.removeEventListener('abort', onAbort)
      }
      const finish = (error: unknown, available?: boolean) => {
        if (settled) return
        settled = true
        cleanup()
        if (error !== undefined) reject(error)
        else resolveAvailability(available ?? false)
      }
      const finishAfterClose = (available: boolean) => {
        server.close((error) => {
          if (abortedReason !== undefined) finish(abortedReason)
          else if (error !== undefined) finish(error)
          else finish(undefined, available)
        })
      }
      const onListening = () => finishAfterClose(true)
      const onError = (error: NodeJS.ErrnoException) => {
        if (abortedReason !== undefined) finish(abortedReason)
        else if (error.code === 'EADDRINUSE' || error.code === 'EACCES') finish(undefined, false)
        else finish(error)
      }
      const onAbort = () => {
        abortedReason = signal?.reason ?? new DOMException('The operation was aborted', 'AbortError')
        if (server.listening) finishAfterClose(false)
      }

      server.once('listening', onListening)
      server.once('error', onError)
      signal?.addEventListener('abort', onAbort, { once: true })
      server.unref()
      try {
        server.listen({ port, host: '127.0.0.1', exclusive: true })
      } catch (error) {
        finish(error)
      }
    })
  }
}

async function confirmPurge(volumes: readonly string[]): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await terminal.question(`Permanently delete Docker volume ${volumes.join(', ')}? [y/N] `)
    return /^(?:y|yes)$/i.test(answer.trim())
  } finally {
    terminal.close()
  }
}

export function createProductionDependencies(options: ProductionDependencyOptions = {}): CliDependencies {
  const env = options.env ?? process.env
  const dshHome = resolveDshHome(env, options.homedir)
  const runner = options.runner ?? new NodeProcessRunner()
  const portChecker = options.portChecker ?? createLoopbackPortChecker()
  return {
    environment: new NodeEnvironmentService({ env, homedir: options.homedir, portChecker, commandRunner: runner }),
    state: new FileStateStore(managedDir(dshHome)),
    docker: new CliDockerAdapter(runner),
    assets: new FileAssetRenderer(),
    searxng: new DefaultSearxngProbe(),
    profiles: new NodeProfileManager({ commandRunner: runner, dshHome }),
    now: () => new Date(),
    confirmPurge,
    removeManagedDirectory,
  }
}

export async function runCli(argv: readonly string[], options: RunCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text))
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text))
  const format = argv.includes('--json') ? 'json' : 'human'
  const presenter = { format, stdout, stderr } as const

  let command
  try {
    command = parseCliArgs(argv)
  } catch {
    presentError(usageError('Invalid command arguments'), presenter)
    return 2
  }

  if (command.command === 'help') {
    stdout(HELP)
    return 0
  }

  try {
    const dependencies = options.dependencies ?? options.createDependencies?.() ?? createProductionDependencies()
    if (command.command === 'setup') {
      const result = await setup(
        {
          profile: command.profile,
          port: command.port,
          portExplicit: command.portExplicit,
          ...(command.url === undefined ? {} : { url: command.url }),
        },
        dependencies,
        options.signal,
      )
      if (format === 'json') presentSuccess(result, presenter)
      else stdout([
          'SearXNG ready',
          `Profile: ${result.profile}`,
          `Endpoint: ${result.endpoint}`,
          'Validation: real search and provider search passed',
          `Deployment: ${result.reused ? 'reused' : 'created or recovered'}`,
          `Next: dsh --profile ${result.profile}`,
          '',
        ].join('\n'))
      return 0
    }

    if (command.command === 'status' || command.command === 'doctor') {
      const result = await diagnose(command.profile, command.command, dependencies, options.signal)
      if (format === 'json') presentSuccess(result, presenter)
      else if (result.healthy) stdout(`${command.command === 'status' ? 'Status' : 'Doctor'}: healthy\n`)
      else {
        const failure = result.checks.find((check) => check.status === 'fail')?.error
        presentError(failure === undefined
          ? new CliError('E_INTERNAL', 'Diagnostics failed', 'Inspect the diagnostic output')
          : new CliError(failure.code, failure.message, failure.action), presenter)
      }
      return result.healthy ? 0 : 1
    }

    if (command.command !== 'remove') throw usageError('Unsupported command')
    const extras = dependencies as Partial<CliDependencies>
    const result = await remove(
      {
        profile: command.profile,
        service: command.service,
        purgeData: command.purgeData,
        confirmed: command.yes,
      },
      {
        ...dependencies,
        confirmPurge: extras.confirmPurge ?? (async () => false),
        removeManagedDirectory: extras.removeManagedDirectory ?? removeManagedDirectory,
      },
      options.signal,
    )
    if (format === 'json') presentSuccess(result, presenter)
    else stdout([
      `Profile ${result.profile}: ${result.profileRemoved ? 'detached' : 'not attached'}`,
      `Service: ${result.serviceRemoved ? 'removed' : 'retained'}`,
      `Data: ${result.dataPurged ? 'purged' : 'retained'}`,
      '',
    ].join('\n'))
    return 0
  } catch (error) {
    presentError(error, presenter)
    return error instanceof CliError && error.code === 'E_USAGE' ? 2 : 1
  }
}

async function main(): Promise<void> {
  const controller = new AbortController()
  const onInterrupt = () => controller.abort()
  process.once('SIGINT', onInterrupt)
  try {
    const dependencies = createProductionDependencies()
    process.exitCode = await runCli(process.argv.slice(2), { dependencies, signal: controller.signal })
  } finally {
    process.removeListener('SIGINT', onInterrupt)
  }
}

if (await isMainModule(import.meta.url, process.argv[1])) {
  await main()
}
