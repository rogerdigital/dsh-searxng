/**
 * Type surface of scripts/certify-platform.mjs for the contract test in
 * test/scripts/certify-platform.test.ts. The implementation itself is plain
 * ESM JavaScript so it runs standalone with `node` on certification hosts.
 */

/** Result of one spawned command; never thrown for a nonzero exit. */
export interface CertifyProcessResult {
  code: number
  stdout: string
  stderr: string
  /** True when the command could not be spawned at all (ENOENT and friends). */
  spawnFailed: boolean
}

export interface CertifySpawnOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  timeoutMs?: number
}

/** Injected subprocess function; every command is an argument array. */
export type CertifySpawner = (
  file: string,
  args: readonly string[],
  options?: CertifySpawnOptions,
) => Promise<CertifyProcessResult>

/** Injected filesystem surface the journey needs beyond subprocesses. */
export interface CertifyFileSystem {
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  removeFile(path: string): Promise<void>
  pathExists(path: string): Promise<boolean>
  removeTree(path: string): Promise<void>
}

/** Versions and tarball identity recorded before any mutation runs. */
export interface PreflightResult {
  platform: string
  node: string
  docker: string
  compose: string
  /** Version derived from the tarball file name; null when not derivable. */
  packageVersion: string | null
  tarball: string
  tarballSha256: string
}

export type CertifyCheckStatus = 'pass' | 'fail' | 'skip'

/** schemaVersion 1 report; `checks` carries the eight lifecycle checks plus the additive `cleanup`. */
export interface CertificationReport {
  schemaVersion: number
  platform: string
  node: string
  docker: string
  compose: string
  packageVersion: string
  tarball: string
  tarballSha256: string
  profile: string
  startedAt: string
  durationMs: number
  checks: Record<string, CertifyCheckStatus>
  notes: string[]
  diagnostics?: {
    message: string
    command?: readonly string[]
    exitCode?: number
    stdout?: string
    stderr?: string
  }
}

export interface RunCertificationInput {
  preflight: PreflightResult
  spawner: CertifySpawner
  fileSystem: CertifyFileSystem
  makeTempDir: (prefix: string) => Promise<string>
  resolveNpm?: () => { file: string; args: string[] }
  node?: string
  baseEnv?: Record<string, string | undefined>
  profile?: string
  log?: (line: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export declare const CERTIFY_CHECKS: readonly string[]
export declare const MINIMUM_NODE_MAJOR: number
export declare const REPORT_SCHEMA_VERSION: number
export declare const MANAGED_LABEL: string
export declare const HOME_ID_LABEL: string

export declare class CertificationError extends Error {
  readonly code: string
  readonly action: string
  readonly exitCode: number
  constructor(code: string, message: string, action: string, exitCode?: number)
}

export declare function parseCertifyArgs(argv: readonly string[]): { tarball: string }
export declare function certifyHomeId(dshHome: string): string
export declare function certificationPlatform(): string
export declare function redactText(text: string): string
export declare function preflightCertification(input: {
  tarball: string
  spawner: CertifySpawner
  pathExists?: (path: string) => Promise<boolean>
  sha256File?: (path: string) => Promise<string>
  nodeVersion?: string
  platform?: string
}): Promise<PreflightResult>
export declare function runCertification(
  input: RunCertificationInput,
): Promise<{ report: CertificationReport; exitCode: number }>
