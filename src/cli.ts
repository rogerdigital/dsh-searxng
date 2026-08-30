#!/usr/bin/env node

import { createServer, type Server } from 'node:net'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { parseCliArgs } from './cli/args.ts'
import { FileAssetRenderer } from './cli/assets.ts'
import { CliDockerAdapter } from './cli/docker.ts'
import { managedDir, NodeEnvironmentService, resolveDshHome, type PortChecker } from './cli/environment.ts'
import { CliError } from './cli/errors.ts'
import { presentError, presentSuccess } from './cli/presenter.ts'
import { NodeProcessRunner, type CommandRunner } from './cli/process.ts'
import { NodeProfileManager } from './cli/profile.ts'
import { DefaultSearxngProbe } from './cli/searxng.ts'
import { setup, type SetupDependencies } from './cli/setup.ts'
import { FileStateStore } from './cli/state.ts'

type Writer = (text: string) => void

export interface RunCliOptions {
  dependencies?: SetupDependencies
  createDependencies?: () => SetupDependencies
  signal?: AbortSignal
  stdout?: Writer
  stderr?: Writer
}

export interface ProductionDependencyOptions {
  env?: NodeJS.ProcessEnv
  homedir?: string
  runner?: CommandRunner
  portChecker?: PortChecker
}

function usageError(message: string): CliError {
  return new CliError('E_USAGE', message, 'Run dsh-searxng setup with supported options')
}

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

export function createProductionDependencies(options: ProductionDependencyOptions = {}): SetupDependencies {
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

  if (command.command !== 'setup') {
    presentError(usageError(`The ${command.command} command is not available yet`), presenter)
    return 2
  }

  try {
    const dependencies = options.dependencies ?? options.createDependencies?.() ?? createProductionDependencies()
    const result = await setup(
      { profile: command.profile, port: command.port, ...(command.url === undefined ? {} : { url: command.url }) },
      dependencies,
      options.signal,
    )
    presentSuccess(result, presenter)
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

const executedPath = process.argv[1]
if (executedPath !== undefined && import.meta.url === pathToFileURL(resolve(executedPath)).href) {
  void main()
}
