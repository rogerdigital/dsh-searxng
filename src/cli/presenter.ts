import { CliError, redact } from './errors.ts'

type Writer = (text: string) => void
export interface PresenterOptions { format: 'human' | 'json'; stdout: Writer; stderr: Writer }
const SERIALIZATION_FALLBACK = '{"code":"E_INTERNAL","message":"Unable to serialize output","action":"Inspect the command output"}\n'

function stableJson(value: unknown): string {
  if (value === undefined || typeof value === 'bigint') return 'null'
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null'
  if (Array.isArray(value)) return `[${Array.from(value, stableJson).join(',')}]`
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  return encoded === undefined ? 'null' : encoded
}

export function presentSuccess(value: unknown, options: PresenterOptions): void {
  let output: string
  try {
    output = options.format === 'json' ? `${stableJson(redact(value))}\n` : 'Success\n'
  } catch {
    output = SERIALIZATION_FALLBACK
  }
  options.stdout(output)
}

export function presentError(error: unknown, options: PresenterOptions): void {
  let output: string
  try {
    const envelope = error instanceof CliError
      ? error.toJSON()
      : { code: 'E_INTERNAL' as const, message: 'An unexpected error occurred', action: 'Inspect the command output', cause: redact(error) }
    output = options.format === 'json'
      ? `${stableJson(redact(envelope))}\n`
      : `${envelope.code}: ${redact(envelope.message)}\nNext: ${redact(envelope.action)}\n`
  } catch {
    output = SERIALIZATION_FALLBACK
  }
  options.stderr(output)
}
