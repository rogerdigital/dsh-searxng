import { parseArgs } from 'node:util'

export type CliCommand =
  | {
      command: 'setup'
      profile: string
      url?: string
      port: number
      json: boolean
    }
  | {
      command: 'status' | 'doctor'
      profile: string
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

export function parseCliArgs(argv: readonly string[]): CliCommand {
  const parsed = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true })
  const [command, ...extra] = parsed.positionals
  if (!command || extra.length > 0 || !['setup', 'status', 'doctor', 'remove'].includes(command)) {
    invalid('expected one command: setup, status, doctor, or remove')
  }
  const cliCommand = command as CliCommand['command']

  if (cliCommand !== 'setup' && parsed.values.port !== undefined) {
    invalid('--port is only supported by setup')
  }

  const profile = parseProfile(parsed.values.profile)
  const port = parsePort(parsed.values.port)
  const json = parsed.values.json ?? false
  const url = parseUrl(parsed.values.url)
  const service = parsed.values.service ?? false
  const purgeData = parsed.values['purge-data'] ?? false
  const yes = parsed.values.yes ?? false

  if (cliCommand !== 'setup' && url !== undefined) invalid('--url is only supported by setup')
  if (cliCommand !== 'remove' && (service || purgeData || yes)) invalid('remove flags are only supported by remove')
  if (cliCommand === 'remove' && purgeData && !service) invalid('--purge-data requires --service')
  if (cliCommand === 'remove' && yes && !purgeData) invalid('--yes requires --purge-data')

  if (cliCommand === 'setup') return { command: cliCommand, profile, ...(url === undefined ? {} : { url }), port, json }
  if (cliCommand === 'remove') return { command: cliCommand, profile, json, service, purgeData, yes }
  return { command: cliCommand, profile, json }
}
