import { CliError, redact } from './errors.ts'

type Writer = (text: string) => void
export interface PresenterOptions { format: 'human' | 'json'; stdout: Writer; stderr: Writer }

function stableJson(value: unknown): string {
  if (value === undefined || typeof value === 'bigint') return 'null'
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  return encoded === undefined ? 'null' : encoded
}

export function presentSuccess(value: unknown, options: PresenterOptions): void {
  if (options.format === 'json') { try { options.stdout(`${stableJson(redact(value))}\n`) } catch { options.stdout('{"code":"E_INTERNAL","message":"Unable to serialize output","action":"Inspect the command output"}\n') } }
  else options.stdout('Success\n')
}

export function presentError(error: unknown, options: PresenterOptions): void {
  const envelope = error instanceof CliError
    ? error.toJSON()
    : { code: 'E_INTERNAL' as const, message: 'An unexpected error occurred', action: 'Inspect the command output', cause: redact(error) }
  try {
    if (options.format === 'json') options.stderr(`${stableJson(redact(envelope))}\n`)
    else options.stderr(`${envelope.code}: ${redact(envelope.message)}\nNext: ${redact(envelope.action)}\n`)
  } catch { options.stderr('{"code":"E_INTERNAL","message":"Unable to serialize output","action":"Inspect the command output"}\n') }
}
