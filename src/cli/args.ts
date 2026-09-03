import { parseArgs } from 'node:util'

export type CliCommand =
  | { command: 'help' }
  | {
      command: 'setup'
      profile: string
      url?: string
      port: number
      portExplicit: boolean
      json: boolean
    }
  | {
      command: 'status' | 'doctor'
      profile: string
      json: boolean
    }
  | {
      command: 'repair'
      profile: string
      json: boolean
    }
  | {
      command: 'update'
      profile: string
      deploymentVersion?: number
      json: boolean
    }
  | {
      command: 'remove'
      profile: string
      json: boolean
      service: boolean
      purgeData: boolean
      yes: boolean
    }

const options = {
  profile: { type: 'string' as const },
  port: { type: 'string' as const },
  json: { type: 'boolean' as const },
  url: { type: 'string' as const },
  service: { type: 'boolean' as const },
  'purge-data': { type: 'boolean' as const },
  yes: { type: 'boolean' as const },
  'deployment-version': { type: 'string' as const },
  help: { type: 'boolean' as const, short: 'h' },
}

function invalid(message: string): never {
  throw new Error(`Invalid CLI arguments: ${message}`)
}

function parseProfile(value: string | undefined): string {
  const profile = value ?? 'web'
  if (!profile || profile === '.' || profile === '..' || profile.includes('/') || profile.includes('\\')) {
    invalid('profile must be a safe name')
  }
  return profile
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 8080
  if (!/^\d+$/.test(value)) invalid('port must be an integer')
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) invalid('port must be between 1 and 65535')
  return port
}

function parseUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    invalid('url must be an absolute HTTP(S) URL')
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    invalid('url must be an absolute HTTP(S) URL without query, fragment, or credentials')
  }
  return value
}

function parseDeploymentVersion(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) invalid('deployment-version must be an integer')
  const version = Number(value)
  if (!Number.isSafeInteger(version) || version < 1 || version > 65535) {
    invalid('deployment-version must be between 1 and 65535')
  }
  return version
}

export function parseCliArgs(argv: readonly string[]): CliCommand {
  const parsed = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true })
  const [command, ...extra] = parsed.positionals
  if (parsed.values.help === true) {
    if (command !== undefined || extra.length > 0 || Object.entries(parsed.values).some(([key, value]) => key !== 'help' && value !== undefined)) {
      invalid('--help cannot be combined with a command or other options')
    }
    return { command: 'help' }
  }
  if (!command || extra.length > 0 || !['setup', 'status', 'doctor', 'repair', 'update', 'remove'].includes(command)) {
    invalid('expected one command: setup, status, doctor, repair, update, or remove')
  }
  const cliCommand = command as CliCommand['command']

  if (cliCommand !== 'setup' && parsed.values.port !== undefined) {
    invalid('--port is only supported by setup')
  }
  if (cliCommand !== 'update' && parsed.values['deployment-version'] !== undefined) {
    invalid('--deployment-version is only supported by update')
  }

  const profile = parseProfile(parsed.values.profile)
  const port = parsePort(parsed.values.port)
  const json = parsed.values.json ?? false
  const url = parseUrl(parsed.values.url)
  const service = parsed.values.service ?? false
  const purgeData = parsed.values['purge-data'] ?? false
  const yes = parsed.values.yes ?? false
  const deploymentVersion = parseDeploymentVersion(parsed.values['deployment-version'])

  if (cliCommand !== 'setup' && url !== undefined) invalid('--url is only supported by setup')
  if (cliCommand !== 'remove' && (service || purgeData || yes)) invalid('remove flags are only supported by remove')
  if (cliCommand === 'remove' && purgeData && !service) invalid('--purge-data requires --service')
  if (cliCommand === 'remove' && yes && !purgeData) invalid('--yes requires --purge-data')

  if (cliCommand === 'setup') return {
    command: cliCommand,
    profile,
    ...(url === undefined ? {} : { url }),
    port,
    portExplicit: parsed.values.port !== undefined,
    json,
  }
  if (cliCommand === 'update') return {
    command: cliCommand,
    profile,
    ...(deploymentVersion === undefined ? {} : { deploymentVersion }),
    json,
  }
  if (cliCommand === 'remove') return { command: cliCommand, profile, json, service, purgeData, yes }
  return { command: cliCommand, profile, json }
}
