export type CliErrorCode =
  | 'E_USAGE' | 'E_DSH_MISSING' | 'E_PROFILE_INVALID' | 'E_PROFILE_WRITE'
  | 'E_DOCKER_MISSING' | 'E_DOCKER_OFFLINE' | 'E_COMPOSE_UNSUPPORTED'
  | 'E_PORT_CONFLICT' | 'E_RESOURCE_FOREIGN' | 'E_STATE_INVALID'
  | 'E_SEARXNG_START_TIMEOUT' | 'E_JSON_DISABLED' | 'E_AUTH_FAILED'
  | 'E_RATE_LIMITED' | 'E_SEARCH_FAILED' | 'E_REMOVE_BLOCKED' | 'E_INTERNAL'

const SENSITIVE_KEYS = /(?:^|_)(?:dsh_searxng_secret|secret_key|auth_header|authheader|authorization|api_key|apikey|access_token|accesstoken|refresh_token|refreshtoken|password|cookie|search_query|searchquery|query|token)(?:$|_)/
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null } catch { return false }
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value !== null && typeof value === 'object') { if (seen.has(value)) return '[REDACTED]'; seen.add(value) }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen))
  if (value instanceof Error) return '[REDACTED]'
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {}
    let keys: (string | symbol)[]
    try { keys = Reflect.ownKeys(value) } catch { return '[REDACTED]' }
    for (const key of keys) {
      if (typeof key !== 'string') continue
      let descriptor: PropertyDescriptor | undefined
      try { descriptor = Object.getOwnPropertyDescriptor(value, key) } catch { result[key] = '[REDACTED]'; continue }
      if (!descriptor || !('value' in descriptor)) { result[key] = '[REDACTED]'; continue }
      result[key] = SENSITIVE_KEYS.test(key.toLowerCase().replace(/[-.]/g, '_')) ? '[REDACTED]' : redactValue(descriptor.value, seen)
    }
    return result
  }
  if (value !== null && typeof value === 'object') return '[REDACTED]'
  return value
}

export function redact<T>(value: T): T { return redactValue(value, new WeakSet()) as T }

export class CliError extends Error {
  readonly code: CliErrorCode
  readonly action: string
  readonly details: Record<string, unknown>

  constructor(code: CliErrorCode, message: string, action: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.action = action
    this.details = details
  }

  toJSON() {
    const details = redact(this.details) as Record<string, unknown>
    const { code: _code, message: _message, action: _action, ...safeDetails } = details
    return { ...safeDetails, code: this.code, message: this.message, action: this.action }
  }
}
