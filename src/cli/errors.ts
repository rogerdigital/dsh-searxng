export type CliErrorCode =
  | 'E_USAGE' | 'E_DSH_MISSING' | 'E_PROFILE_INVALID' | 'E_PROFILE_WRITE'
  | 'E_DOCKER_MISSING' | 'E_DOCKER_OFFLINE' | 'E_COMPOSE_UNSUPPORTED'
  | 'E_PORT_CONFLICT' | 'E_RESOURCE_FOREIGN' | 'E_STATE_INVALID'
  | 'E_SEARXNG_START_TIMEOUT' | 'E_JSON_DISABLED' | 'E_AUTH_FAILED'
  | 'E_RATE_LIMITED' | 'E_SEARCH_FAILED' | 'E_REMOVE_BLOCKED' | 'E_INTERNAL'

const REDACTED = '[REDACTED]'
const SENSITIVE_KEYS = /(?:^|_)(?:secret|secret_key|auth_header|authheader|authorization|api_key|apikey|access_token|accesstoken|refresh_token|refreshtoken|password|cookie|search_query|searchquery|query|token)(?:$|_)/
const normalizeKey = (key: string): string => key
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
  .replace(/([a-z\d])([A-Z])/g, '$1_$2')
  .replace(/[-.\s]+/g, '_')
  .toLowerCase()
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null } catch { return false }
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  try {
    if (value !== null && typeof value === 'object') { if (seen.has(value)) return REDACTED; seen.add(value) }
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
      if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return REDACTED
      const result = new Array(lengthDescriptor.value)
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || key === 'length') continue
        const index = Number(key)
        if (!Number.isSafeInteger(index) || index < 0 || index >= lengthDescriptor.value || String(index) !== key) continue
        let descriptor: PropertyDescriptor | undefined
        try { descriptor = Object.getOwnPropertyDescriptor(value, key) } catch { result[index] = REDACTED; continue }
        if (!descriptor?.enumerable) continue
        result[index] = 'value' in descriptor ? redactValue(descriptor.value, seen) : REDACTED
      }
      return result
    }
    if (value instanceof Error) return REDACTED
    if (isPlainObject(value)) {
      const result: Record<string, unknown> = {}
      const keys = Reflect.ownKeys(value)
      for (const key of keys) {
        if (typeof key !== 'string') continue
        let descriptor: PropertyDescriptor | undefined
        try { descriptor = Object.getOwnPropertyDescriptor(value, key) } catch { result[key] = REDACTED; continue }
        if (!descriptor?.enumerable) continue
        if (!('value' in descriptor)) { result[key] = REDACTED; continue }
        result[key] = SENSITIVE_KEYS.test(normalizeKey(key)) ? REDACTED : redactValue(descriptor.value, seen)
      }
      return result
    }
    if (value !== null && typeof value === 'object') return REDACTED
    return value
  } catch {
    return REDACTED
  }
}

export function redact(value: unknown): unknown { return redactValue(value, new WeakSet()) }

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
    const redactedDetails = redact(this.details)
    const details = redactedDetails !== null && typeof redactedDetails === 'object' && !Array.isArray(redactedDetails)
      ? Object.fromEntries(Object.entries(redactedDetails))
      : {}
    const { code: _code, message: _message, action: _action, ...safeDetails } = details
    return { ...safeDetails, code: this.code, message: this.message, action: this.action }
  }
}
