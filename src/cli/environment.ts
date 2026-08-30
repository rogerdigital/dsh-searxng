import { createHash } from 'node:crypto'
import { homedir as defaultHomedir } from 'node:os'
import { isAbsolute, join, normalize, resolve as resolvePath } from 'node:path'
import type { CommandRunner } from './process.ts'
import { CliError } from './errors.ts'

export function assertValidProfile(profile: string): string {
  if (!profile || profile === '.' || profile === '..' || profile.includes('/') || profile.includes('\\') || profile === 'node_modules' || profile.split(/[\\/]/).includes('node_modules')) {
    throw new CliError('E_PROFILE_INVALID', 'Profile must be a safe name', 'Choose a profile without path separators or reserved names')
  }
  return profile
}

export function resolveDshHome(env: NodeJS.ProcessEnv = process.env, homedir: string = defaultHomedir()): string {
  const configured = env.DSH_HOME?.trim()
  if (!configured) return normalize(resolvePath(homedir, '.dsh'))
  const expanded = configured.replace(/^~(?=$|[\\/])/, defaultHomedir())
  return normalize(resolvePath(expanded))
}

export function profileDir(dshHome: string, profile: string): string {
  assertValidProfile(profile)
  return join(dshHome, 'profiles', profile)
}

export function managedDir(dshHome: string): string { return join(dshHome, 'dsh-searxng') }

export function homeId(dshHome: string): string {
  return createHash('sha256').update(normalize(resolvePath(dshHome))).digest('hex').slice(0, 16)
}

export interface ResolvedEnvironment { dshHome: string; profileDir: string; managedDir: string; homeId: string }
export interface PortChecker { (port: number, signal?: AbortSignal): Promise<boolean> }
export interface EnvironmentServiceOptions { env?: NodeJS.ProcessEnv; homedir?: string; portChecker: PortChecker; commandRunner: CommandRunner; dshCommand?: string }

export class EnvironmentService {
  private readonly env: NodeJS.ProcessEnv
  private readonly homedir: string
  private readonly portChecker: PortChecker
  private readonly commandRunner: CommandRunner
  private readonly dshCommand: string
  constructor(options: EnvironmentServiceOptions) {
    this.env = options.env ?? process.env
    this.homedir = options.homedir ?? defaultHomedir()
    this.portChecker = options.portChecker
    this.commandRunner = options.commandRunner
    this.dshCommand = options.dshCommand ?? 'dsh'
  }
  async resolve(profile: string): Promise<ResolvedEnvironment> {
    const dshHome = resolveDshHome(this.env, this.homedir)
    return { dshHome, profileDir: profileDir(dshHome, profile), managedDir: managedDir(dshHome), homeId: homeId(dshHome) }
  }
  async preflightManaged(port: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new CliError('E_USAGE', 'Port must be between 1 and 65535', 'Choose a valid port')
    let available: boolean
    try { available = await this.portChecker(port, signal) } catch { throw new CliError('E_PORT_CONFLICT', 'Unable to verify port availability', 'Choose another port or stop the process using it') }
    if (!available) throw new CliError('E_PORT_CONFLICT', `Port ${port} is already in use`, 'Choose another port')
    try {
      const result = await this.commandRunner.run(this.dshCommand, ['--version'], { signal })
      if (result.exitCode !== 0) throw new Error('nonzero')
    } catch { throw new CliError('E_DSH_MISSING', 'The dsh executable is unavailable', 'Install dsh and ensure it is on PATH') }
  }
}
