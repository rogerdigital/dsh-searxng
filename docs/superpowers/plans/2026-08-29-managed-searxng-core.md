# Managed SearXNG Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a published-package path that installs or connects `dsh-searxng`, reaches a real search through one setup command, and provides safe status, diagnosis, and removal.

**Architecture:** Keep the runtime provider independent from Docker. Add a Node CLI whose small adapters own process execution, state, Docker Compose, SearXNG probes, and DSH profile patches; orchestration composes those adapters and never performs implicit work during plugin activation.

**Tech Stack:** TypeScript 5.8+, Node.js 20+ ESM, `node:util.parseArgs`, `yaml`, `cross-spawn`, Vitest, tsdown, Docker Compose v2, SearXNG JSON API.

**Design:** `docs/superpowers/specs/2026-08-29-docker-self-hosting-design.md`

---

## File Map

Create these focused units:

- `src/cli.ts` — executable entry; converts argv into one command and exit code.
- `src/cli/args.ts` — CLI grammar and defaults (`web` profile, port `8080`).
- `src/cli/errors.ts` — stable error codes and redaction-safe `CliError`.
- `src/cli/process.ts` — injectable child-process runner.
- `src/cli/environment.ts` — DSH home, profile, Docker, Compose, and port preflight.
- `src/cli/state.ts` — versioned state model, atomic persistence, and operation lock.
- `src/cli/assets.ts` — copy/render packaged deployment assets.
- `src/cli/docker.ts` — Compose operations and ownership-label inspection.
- `src/cli/searxng.ts` — readiness and real-search probes shared by CLI commands.
- `src/cli/profile.ts` — DSH plugin installation and profile patch transaction.
- `src/cli/diagnostics.ts` — ordered, read-only diagnostic checks.
- `src/cli/setup.ts` — managed and external setup orchestration.
- `src/cli/remove.ts` — profile detach and owned-resource removal.
- `src/cli/presenter.ts` — human and JSON output with secret redaction.
- `assets/docker/compose.yml` — packaged one-service Compose definition.
- `assets/docker/settings.yml.template` — JSON-enabled, loopback-oriented SearXNG settings.

Create matching tests under `test/cli/`; keep the existing provider tests in `test/provider.test.ts`. The second plan adds repair and transactional update without changing these boundaries.

### Task 1: Define the CLI grammar and package deployment assets

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/cli/args.ts`
- Create: `assets/docker/compose.yml`
- Create: `assets/docker/settings.yml.template`
- Create: `test/cli/args.test.ts`

- [ ] **Step 1: Add the failing argument-parser tests**

```ts
import { describe, expect, it } from 'vitest'
import { parseCliArgs } from '../../src/cli/args.ts'

describe('parseCliArgs', () => {
  it('defaults setup to the web profile and port 8080', () => {
    expect(parseCliArgs(['setup'])).toEqual({
      command: 'setup', profile: 'web', port: 8080, json: false,
    })
  })

  it('parses an external endpoint without selecting managed Docker', () => {
    expect(parseCliArgs(['setup', '--profile', 'work', '--url', 'https://search.example'])).toEqual({
      command: 'setup', profile: 'work', url: 'https://search.example', port: 8080, json: false,
    })
  })

  it.each(['status', 'doctor', 'remove'] as const)('parses %s', (command) => {
    expect(parseCliArgs([command])).toMatchObject({ command, profile: 'web', json: false })
  })

  it('rejects unknown commands', () => {
    expect(() => parseCliArgs(['start'])).toThrow(/unknown command/i)
  })
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm test -- test/cli/args.test.ts`

Expected: FAIL because `src/cli/args.ts` does not exist.

- [ ] **Step 3: Add the CLI grammar and executable entry**

Use this public model in `src/cli/args.ts`:

```ts
import { parseArgs } from 'node:util'

export type CliCommand =
  | { command: 'setup'; profile: string; port: number; url?: string; json: boolean }
  | { command: 'status' | 'doctor'; profile: string; json: boolean }
  | { command: 'remove'; profile: string; service: boolean; purgeData: boolean; yes: boolean; json: boolean }

export function parseCliArgs(argv: readonly string[]): CliCommand {
  const [command, ...rest] = argv
  const parsed = parseArgs({
    args: rest,
    allowPositionals: false,
    options: {
      profile: { type: 'string', default: 'web' },
      port: { type: 'string', default: '8080' },
      url: { type: 'string' },
      json: { type: 'boolean', default: false },
      service: { type: 'boolean', default: false },
      'purge-data': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
    },
  })
  const profile = parsed.values.profile!
  if (profile === '' || profile.includes('/') || profile.includes('\\')) throw new Error('invalid profile name')
  if (command === 'setup') {
    const port = Number(parsed.values.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be 1..65535')
    return {
      command, profile, port, json: parsed.values.json!,
      ...(parsed.values.url === undefined ? {} : { url: parsed.values.url }),
    }
  }
  if (command === 'remove') {
    const service = parsed.values.service!
    const purgeData = parsed.values['purge-data']!
    if (purgeData && !service) throw new Error('--purge-data requires --service')
    return { command, profile, service, purgeData, yes: parsed.values.yes!, json: parsed.values.json! }
  }
  if (command === 'status' || command === 'doctor') {
    return { command, profile, json: parsed.values.json! }
  }
  throw new Error(`unknown command: ${command ?? '(missing)'}`)
}
```

- [ ] **Step 4: Add packaged assets and dependencies**

Add `yaml` and `cross-spawn` as direct runtime dependencies and `@types/cross-spawn` as a development dependency. Add assets to the package metadata:

```json
{
  "files": ["lib", "assets", "cordis.patch.yml"]
}
```

The Compose asset must use only variable-safe values produced by the CLI:

```yaml
services:
  searxng:
    image: ${DSH_SEARXNG_IMAGE}
    container_name: ${DSH_SEARXNG_CONTAINER}
    restart: unless-stopped
    ports:
      - "127.0.0.1:${DSH_SEARXNG_PORT}:8080"
    labels:
      io.dsh-searxng.managed: "true"
      io.dsh-searxng.home-id: ${DSH_SEARXNG_HOME_ID}
      io.dsh-searxng.schema: "1"
    volumes:
      - ./searxng:/etc/searxng
      - cache:/var/cache/searxng
    cap_drop: [ALL]
    cap_add: [CHOWN, SETGID, SETUID]
volumes:
  cache:
    labels:
      io.dsh-searxng.managed: "true"
      io.dsh-searxng.home-id: ${DSH_SEARXNG_HOME_ID}
```

Use a settings template containing a single `__DSH_SEARXNG_SECRET__` token, `use_default_settings: true`, `server.limiter: false`, and `search.formats: [html, json]`.

- [ ] **Step 5: Run tests and inspect the packed artifact**

Run: `pnpm install && pnpm test -- test/cli/args.test.ts && pnpm build && pnpm pack:check`

Expected: PASS; the tarball contains `assets/docker/compose.yml` and `assets/docker/settings.yml.template`.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/cli/args.ts assets/docker test/cli/args.test.ts
git commit -m "feat: add managed SearXNG CLI foundation"
```

### Task 2: Establish stable errors, process execution, and output

**Files:**
- Create: `src/cli/errors.ts`
- Create: `src/cli/process.ts`
- Create: `src/cli/presenter.ts`
- Create: `test/cli/errors.test.ts`
- Create: `test/cli/process.test.ts`
- Create: `test/cli/presenter.test.ts`

- [ ] **Step 1: Write failing tests for codes, process results, and redaction**

```ts
import { describe, expect, it } from 'vitest'
import { CliError, redact } from '../../src/cli/errors.ts'

describe('CLI errors', () => {
  it('carries one stable code and action', () => {
    const error = new CliError('E_DOCKER_OFFLINE', 'Docker is not running', 'Start Docker Desktop')
    expect(error.toJSON()).toEqual({
      code: 'E_DOCKER_OFFLINE', message: 'Docker is not running', action: 'Start Docker Desktop',
    })
  })

  it('redacts secrets and search query values', () => {
    expect(redact({ authorization: 'Bearer secret', secret: 'abc', query: 'private', port: 8080 }))
      .toEqual({ authorization: '[REDACTED]', secret: '[REDACTED]', query: '[REDACTED]', port: 8080 })
  })
})
```

Test `NodeProcessRunner` with `process.execPath -e "process.stdout.write('ok')"`, a nonzero child, and an abort signal. Test the presenter in human and JSON mode and assert neither output contains injected secret values.

- [ ] **Step 2: Run tests and verify missing-module failures**

Run: `pnpm test -- test/cli/errors.test.ts test/cli/process.test.ts test/cli/presenter.test.ts`

Expected: FAIL because the three modules do not exist.

- [ ] **Step 3: Implement the stable contracts**

Define explicit codes rather than accepting arbitrary strings:

```ts
export type CliErrorCode =
  | 'E_USAGE' | 'E_DSH_MISSING' | 'E_PROFILE_INVALID' | 'E_PROFILE_WRITE'
  | 'E_DOCKER_MISSING' | 'E_DOCKER_OFFLINE' | 'E_COMPOSE_UNSUPPORTED'
  | 'E_PORT_CONFLICT' | 'E_RESOURCE_FOREIGN' | 'E_STATE_INVALID'
  | 'E_SEARXNG_START_TIMEOUT' | 'E_JSON_DISABLED' | 'E_AUTH_FAILED'
  | 'E_RATE_LIMITED' | 'E_SEARCH_FAILED' | 'E_REMOVE_BLOCKED' | 'E_INTERNAL'

export class CliError extends Error {
  constructor(
    readonly code: CliErrorCode,
    message: string,
    readonly action: string,
    readonly details: Record<string, unknown> = {},
  ) { super(message) }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, action: this.action, ...redact(this.details) }
  }
}
```

Use an injectable runner contract:

```ts
export interface CommandResult { exitCode: number; stdout: string; stderr: string }
export interface CommandRunner {
  run(command: string, args: readonly string[], options?: {
    cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal
  }): Promise<CommandResult>
}
```

Implement with `cross-spawn`, argument arrays only, no caller-supplied shell string, and bounded output buffers. This preserves `.cmd` shim behavior on Windows without implementing custom quoting. Never concatenate a command and its arguments.

- [ ] **Step 4: Run tests**

Run: `pnpm test -- test/cli/errors.test.ts test/cli/process.test.ts test/cli/presenter.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/errors.ts src/cli/process.ts src/cli/presenter.ts test/cli
git commit -m "feat: add CLI execution contracts"
```

### Task 3: Resolve environment and persist managed state safely

**Files:**
- Create: `src/cli/environment.ts`
- Create: `src/cli/state.ts`
- Create: `test/cli/environment.test.ts`
- Create: `test/cli/state.test.ts`

- [ ] **Step 1: Write failing environment and state tests**

Test these exact decisions:

```ts
expect(resolveDshHome({ DSH_HOME: '/custom' }, '/Users/test')).toBe('/custom')
expect(resolveDshHome({}, '/Users/test')).toBe('/Users/test/.dsh')
expect(profileDir('/dsh', 'web')).toBe('/dsh/profiles/web')
expect(managedDir('/dsh')).toBe('/dsh/dsh-searxng')
expect(homeId('/dsh')).toMatch(/^[a-f0-9]{16}$/)
```

Write a round-trip test for this schema and assert a truncated or unknown-version JSON file raises `E_STATE_INVALID` without being overwritten:

```ts
export interface StateV1 {
  schemaVersion: 1
  managed?: {
    deploymentVersion: 1
    image: string
    endpoint: string
    port: number
    homeId: string
    projectName: string
    containerName: string
    lastHealthyAt: string
  }
  profiles: Record<string, { mode: 'managed' | 'external'; endpoint: string }>
}
```

Add a concurrent lock test: one holder succeeds, a second receives `E_STATE_INVALID` with an action to wait and retry, and the lock is released in `finally`.

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm test -- test/cli/environment.test.ts test/cli/state.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement environment resolution and atomic state**

`resolveDshHome` follows the official DSH rule: use an absolute resolved `$DSH_HOME` when non-empty, otherwise `<homedir>/.dsh`. Validate profile names using the same no-slash/no-dot-segment rule as DSH. Derive the non-reversible home identifier with SHA-256 and keep the first 16 hex characters; labels never expose the real home path.

Write state as `state.json.tmp-<pid>`, open with mode `0o600`, `fsync`, rename over `state.json`, and `fsync` the directory on POSIX. Implement `withStateLock` with an exclusive `open(..., 'wx', 0o600)` lock file containing PID and timestamp; remove it in `finally`. A stale lock is diagnostic-only in this plan and is repaired in the lifecycle plan.

Expose the boundaries used by later tasks:

```ts
export interface EnvironmentService {
  resolve(profile: string): Promise<{
    dshHome: string; profileDir: string; managedDir: string; homeId: string
  }>
  preflightManaged(port: number, signal?: AbortSignal): Promise<void>
}

export interface StateStore {
  read(): Promise<StateV1>
  write(state: StateV1): Promise<void>
  withLock<T>(operation: () => Promise<T>): Promise<T>
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test -- test/cli/environment.test.ts test/cli/state.test.ts`

Expected: PASS on the current platform; platform-path cases use injected `homedir` and `path` inputs rather than host assumptions.

- [ ] **Step 5: Commit**

```bash
git add src/cli/environment.ts src/cli/state.ts test/cli/environment.test.ts test/cli/state.test.ts
git commit -m "feat: add managed deployment state"
```

### Task 4: Render assets and enforce Docker ownership

**Files:**
- Create: `src/cli/assets.ts`
- Create: `src/cli/docker.ts`
- Create: `test/cli/assets.test.ts`
- Create: `test/cli/docker.test.ts`

- [ ] **Step 1: Write failing tests around the ownership boundary**

Use a fake `CommandRunner` and cover:

- `docker version --format {{.Server.Version}}` missing versus daemon offline;
- `docker compose version --short` below v2 versus supported;
- no container with the derived name;
- a container with both `io.dsh-searxng.managed=true` and the expected home ID;
- a same-name container with absent or mismatched labels returning `E_RESOURCE_FOREIGN`;
- every Compose call including the exact project directory, compose file, and derived project name.

Test asset rendering with secret `a:b#c` and assert the generated YAML parses, retains that exact secret value, binds only `127.0.0.1`, and contains the pinned image in `.env`.

- [ ] **Step 2: Run the tests and verify failure**

Run: `pnpm test -- test/cli/assets.test.ts test/cli/docker.test.ts`

Expected: FAIL because the asset and Docker adapters do not exist.

- [ ] **Step 3: Implement versioned asset rendering**

Use this initial validated image reference in a single exported constant:

```ts
export const SEARXNG_IMAGE =
  'ghcr.io/searxng/searxng:2026.8.20-8d3dd0cd4@sha256:e7bb47bebf338c52c55c7bed92293873cfe757b554b261829c0d710fd8307fa3'
```

Resolve packaged assets from `new URL('../assets/docker/', import.meta.url)` in the bundled CLI; tests inject an explicit asset-root URL because source files live one directory deeper. Render `settings.yml` through `yaml.stringify` from an object instead of raw token substitution, so arbitrary generated secret bytes cannot break YAML. Write `.env`, Compose, and settings with user-only permissions.

Expose this Docker interface:

```ts
export interface ManagedIdentity {
  stateDir: string
  composePath: string
  homeId: string
  projectName: string
  containerName: string
}

export interface DockerAdapter {
  preflight(signal?: AbortSignal): Promise<{ serverVersion: string; composeVersion: string }>
  inspectOwnership(identity: ManagedIdentity, signal?: AbortSignal): Promise<'absent' | 'owned'>
  up(identity: ManagedIdentity, signal?: AbortSignal): Promise<void>
  down(identity: ManagedIdentity, volumes: boolean, signal?: AbortSignal): Promise<void>
  logs(identity: ManagedIdentity, tail: number, signal?: AbortSignal): Promise<string>
}

export interface AssetRenderer {
  render(input: {
    stateDir: string
    identity: ManagedIdentity
    image: string
    port: number
    secret: string
  }): Promise<{ composePath: string; configurationSha256: string }>
}
```

Parse inspect JSON; do not infer ownership from names. Cap captured logs and pass them only through the redactor.

- [ ] **Step 4: Run tests**

Run: `pnpm test -- test/cli/assets.test.ts test/cli/docker.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/assets.ts src/cli/docker.ts test/cli/assets.test.ts test/cli/docker.test.ts
git commit -m "feat: add owned Docker deployment adapter"
```

### Task 5: Add SearXNG probes and bounded provider requests

**Files:**
- Create: `src/cli/searxng.ts`
- Create: `test/cli/searxng.test.ts`
- Modify: `src/provider.ts`
- Modify: `test/provider.test.ts`

- [ ] **Step 1: Write failing probe and provider reliability tests**

Probe tests use a local HTTP server or injected fetch and assert:

- a JSON response with at least one URL passes;
- HTTP 403 becomes `E_JSON_DISABLED`;
- HTTP 401 becomes `E_AUTH_FAILED`;
- HTTP 429 becomes `E_RATE_LIMITED`;
- non-JSON 200 becomes `E_JSON_DISABLED`;
- readiness retries transport/502 failures until the deadline;
- the persisted diagnostic record never contains the probe query.

Extend provider tests to assert a default timeout aborts a hanging fetch, caller abort remains `WEB_ABORTED`, one transport/502 retry succeeds, and 401/403/429 are never retried.

- [ ] **Step 2: Run focused tests and observe failures**

Run: `pnpm test -- test/cli/searxng.test.ts test/provider.test.ts`

Expected: FAIL because probes, timeout, and retries are absent.

- [ ] **Step 3: Implement one shared request policy**

Define:

```ts
export interface ProbeOptions {
  baseURL: string
  authHeader?: string
  timeoutMs?: number
  attempts?: number
  fetch?: typeof globalThis.fetch
}

export interface ProbeResult { endpoint: string; resultCount: number; elapsedMs: number }

export async function probeSearxng(options: ProbeOptions, signal?: AbortSignal): Promise<ProbeResult>

export interface SearxngProbe {
  readiness(options: ProbeOptions, signal?: AbortSignal): Promise<void>
  realSearch(options: ProbeOptions, signal?: AbortSignal): Promise<ProbeResult>
  providerSearch(options: ProbeOptions, signal?: AbortSignal): Promise<ProbeResult>
}
```

Use a constant probe term such as `deepseek harness`; never include it in persistent details. Validate that the response has a `results` array and at least one result with a non-empty URL for the final real-search check. Readiness may accept an empty but structurally valid result only while the container is warming.

Extract a provider-internal `requestJsonWithRetry` that combines the caller signal with a per-attempt timeout. Retry at most once for network errors and HTTP 502/503/504, with a short abortable delay. Never retry caller abort, timeout after the final attempt, authentication errors, 403, or 429.

- [ ] **Step 4: Run tests**

Run: `pnpm test -- test/cli/searxng.test.ts test/provider.test.ts`

Expected: PASS with deterministic fake timers for retry delays.

- [ ] **Step 5: Commit**

```bash
git add src/cli/searxng.ts src/provider.ts test/cli/searxng.test.ts test/provider.test.ts
git commit -m "feat: add bounded SearXNG health checks"
```

### Task 6: Make DSH profile attachment transactional

**Files:**
- Create: `src/cli/profile.ts`
- Create: `test/cli/profile.test.ts`

- [ ] **Step 1: Write failing profile tests**

Create temporary profiles with comments, unrelated entries, an empty `[]` patch, and a prior user `web-search-searxng` override. Assert:

- default profile resolution is `web`;
- plugin detection reads both `dependencies.dsh-searxng` and `dsh.profile.bundles`;
- installation invokes `dsh plugin --profile web add dsh-searxng` as an argument array;
- attachment appends one last id-targeted patch and copies existing config keys before setting `baseURL`;
- unrelated YAML nodes and comments survive;
- multiple pre-existing id-target patches remain in their original order, and the last effective config is copied into the final managed patch before `baseURL` is replaced;
- final validation failure restores the byte-identical original patch and removes the plugin only when this transaction added it;
- detachment removes only the managed patch and reveals the user's original override.

The managed patch carries an AST comment marker `dsh-searxng managed attachment`; removal identifies both the marker and `id`, never the marker alone.

- [ ] **Step 2: Verify failure**

Run: `pnpm test -- test/cli/profile.test.ts`

Expected: FAIL because `src/cli/profile.ts` does not exist.

- [ ] **Step 3: Implement the profile transaction**

Expose:

```ts
export interface ProfileManager {
  inspect(profile: string): Promise<{ installed: boolean; patchPath: string }>
  attach(profile: string, endpoint: string, validate: () => Promise<void>): Promise<void>
  detach(profile: string): Promise<void>
}
```

Resolve the official layout as `<DSH_HOME>/profiles/<profile>/package.json` and `cordis.patch.yml`. Use `yaml.parseDocument` and mutate its AST so comments and unrelated nodes remain. The final managed patch must be last because DSH applies patches in list order and an id-targeted patch replaces the row's whole `config`.

Before the first mutation, save the original bytes and whether the package was already installed. On failure, atomically restore the patch and run `dsh plugin --profile <profile> remove dsh-searxng` only when this transaction added it. If rollback fails, return `E_PROFILE_WRITE` containing both redacted failures.

- [ ] **Step 4: Run tests**

Run: `pnpm test -- test/cli/profile.test.ts`

Expected: PASS, including byte-identical rollback.

- [ ] **Step 5: Commit**

```bash
git add src/cli/profile.ts test/cli/profile.test.ts
git commit -m "feat: add transactional DSH profile attachment"
```

### Task 7: Orchestrate managed and external setup

**Files:**
- Create: `src/cli/setup.ts`
- Create: `test/cli/setup.test.ts`
- Create: `src/cli.ts`
- Modify: `package.json`
- Modify: `tsdown.config.ts`

- [ ] **Step 1: Write failing orchestration tests**

Use fake adapters and verify call order, not implementation details:

```ts
expect(events).toEqual([
  'lock', 'environment', 'ownership', 'render', 'docker-up',
  'readiness', 'real-search', 'profile-attach', 'provider-search',
  'state-write', 'unlock',
])
```

Cover healthy reuse (no render/up), external setup (no Docker calls), occupied port before Docker mutation, foreign resource refusal, failed real search before profile mutation, and final provider failure restoring the profile without marking state healthy.

- [ ] **Step 2: Verify failure**

Run: `pnpm test -- test/cli/setup.test.ts`

Expected: FAIL because setup orchestration is absent.

- [ ] **Step 3: Implement the use case**

Define injected dependencies:

```ts
export interface SetupDependencies {
  environment: EnvironmentService
  state: StateStore
  docker: DockerAdapter
  assets: AssetRenderer
  searxng: SearxngProbe
  profiles: ProfileManager
  now(): Date
}

export async function setup(
  input: { profile: string; port: number; url?: string },
  dependencies: SetupDependencies,
  signal?: AbortSignal,
): Promise<{ profile: string; endpoint: string; reused: boolean }>
```

For managed setup, generate the secret with `randomBytes(32).toString('hex')`, derive project/container names from the home ID, verify port availability before rendering, and write healthy state only after final provider validation. For external setup, validate the URL and real search first, attach it as mode `external`, and make zero Docker calls.

Create `src/cli.ts` with a Node shebang and wire it to construct production dependencies and present either the ready result or one `CliError`. Set exit code 2 for usage, 1 for operational failures, and 0 for success. Add `"bin": { "dsh-searxng": "./lib/cli.mjs" }` to `package.json` and add `src/cli.ts` as the second tsdown entry so this task ends with a functional setup command.

- [ ] **Step 4: Run tests**

Run: `pnpm test -- test/cli/setup.test.ts test/cli/args.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/cli/setup.ts package.json tsdown.config.ts test/cli/setup.test.ts
git commit -m "feat: add one-command SearXNG setup"
```

### Task 8: Add status, doctor, and safe removal

**Files:**
- Create: `src/cli/diagnostics.ts`
- Create: `src/cli/remove.ts`
- Create: `test/cli/diagnostics.test.ts`
- Create: `test/cli/remove.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Write failing diagnostic and removal tests**

Model ordered checks as data:

```ts
export interface DiagnosticCheck {
  id: string
  status: 'pass' | 'fail' | 'skip'
  message: string
  error?: ReturnType<CliError['toJSON']>
}
```

Assert managed doctor checks environment, Docker, ownership, container, HTTP, JSON, real search, profile, then provider. Assert external doctor skips every Docker check. Assert human output prints the first failure and action; JSON output contains the whole ordered, redacted array.

Removal tests cover profile-only detach, refusing `--service` with attached profiles, owned Compose down without volumes, `--purge-data` requiring confirmation, and foreign labels blocking every destructive Docker call.

- [ ] **Step 2: Verify failure**

Run: `pnpm test -- test/cli/diagnostics.test.ts test/cli/remove.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement read-only diagnostics and layered removal**

Expose `diagnose(profile, mode, dependencies)` and stop `status` after the first failed fast check while `doctor` records all safe downstream checks as `skip` after a prerequisite fails.

Removal follows:

```ts
export interface RemoveInput {
  profile: string
  service: boolean
  purgeData: boolean
  confirmed: boolean
}
```

Detach the profile transactionally, update attachment state, and invoke the standard DSH plugin remove command. For service removal, require zero remaining managed attachments and re-run ownership inspection immediately before `docker compose down`. Without purge, retain state and data; with purge, list exact owned volumes, require TTY confirmation unless `--yes`, run `down --volumes`, and remove only the managed directory after successful Docker deletion.

- [ ] **Step 4: Wire CLI commands and run tests**

Run: `pnpm test -- test/cli/diagnostics.test.ts test/cli/remove.test.ts test/cli/setup.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/cli/diagnostics.ts src/cli/remove.ts test/cli
git commit -m "feat: add SearXNG diagnostics and removal"
```

### Task 9: Verify the published user journey

**Files:**
- Create: `test/e2e/managed-setup.test.ts`
- Create: `scripts/check-packed-cli.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `examples/docker/docker-compose.yml`
- Modify: `examples/docker/searxng/settings.yml`

- [ ] **Step 1: Add a packed-artifact failure test**

`scripts/check-packed-cli.mjs` must create a temporary directory, install the tarball produced by `pnpm pack`, run `node_modules/.bin/dsh-searxng --help`, and assert that the resolved package contains both Docker assets. It must remove its own temporary directory in `finally`.

Add `pack:test` after `pack:check` and make `verify` run it. The first run should fail until the CLI help path and packed asset resolution are complete.

- [ ] **Step 2: Add opt-in Docker end-to-end coverage**

The e2e test runs only when `DSH_SEARXNG_E2E=1`. It uses a temporary `DSH_HOME`, a fake `dsh` executable that faithfully applies package/bundle changes required by the test, and an explicit free port. It executes setup from the packed tarball, verifies a real query, repeats setup and asserts the same container ID/secret/port, runs status and doctor, restarts Docker container state, and removes the owned service.

Every test resource includes a unique home ID and is deleted in `afterAll`; cleanup still verifies ownership before deletion.

- [ ] **Step 3: Update CI and documentation**

Run unit/type/build/pack verification on Linux, macOS, and Windows. Add the opt-in Docker e2e job on Linux with a job timeout and unconditional owned-resource cleanup.

Rewrite the README primary path to:

```sh
npx dsh-searxng setup
dsh web
```

Document `--profile`, `--url`, status, doctor, removal levels, official runtime support, unsupported Podman, and the guarantee that install/activation never starts Docker. Replace the old `latest` example image and fixed secret with the packaged, pinned model or label the repository example development-only.

- [ ] **Step 4: Run the complete release boundary**

Run: `pnpm verify`

Expected: typecheck, all unit/integration tests, both builds, packed CLI test, and tarball inspection pass.

Run with Docker available: `DSH_SEARXNG_E2E=1 pnpm test -- test/e2e/managed-setup.test.ts`

Expected: PASS; afterward a Docker query filtered by both `io.dsh-searxng.managed=true` and the test home ID shows no test-owned resources.

- [ ] **Step 5: Review the branch diff against the design**

Run: `git diff --check main...HEAD && git status --short`

Expected: no whitespace errors and only intentional implementation/documentation changes.

- [ ] **Step 6: Commit**

```bash
git add README.md package.json .github/workflows/ci.yml examples/docker scripts/check-packed-cli.mjs test/e2e/managed-setup.test.ts
git commit -m "test: verify managed SearXNG quickstart"
```

## Core Plan Completion Gate

Before starting the lifecycle plan, verify:

- `npx dsh-searxng setup` works from the packed tarball with no repository-only files;
- managed and external setup paths both execute a real query before profile activation;
- repeat setup is idempotent;
- status and doctor attribute failures without leaking secrets or queries;
- default removal detaches only one profile, while service/data removal enforces ownership and attachment checks;
- Docker-free provider use remains supported and all existing provider tests pass;
- no npm lifecycle or DSH activation hook performs Docker work.
