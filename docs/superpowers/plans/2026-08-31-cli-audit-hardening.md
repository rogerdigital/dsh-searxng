# CLI Audit Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `dsh-searxng@0.2.1` with a standalone CLI that does not ship the DSH/Schemastery provider chain and with a stricter, reviewable managed-directory deletion boundary.

**Architecture:** Move protocol-level SearXNG request and normalization behavior into a dependency-free shared client. Keep DSH-specific error adaptation in `provider.ts`, make the CLI call the shared client directly, and derive the purge target inside the recursive remover from the resolved DSH home. Verify the actual packed CLI, not only the source graph.

**Tech Stack:** TypeScript, Node.js 20+, tsdown, Vitest, pnpm, npm package tarballs, GitHub Actions, Docker Compose v2, dsh-vet

---

### Task 1: Add a failing packed-CLI dependency regression gate

**Files:**
- Modify: `scripts/check-packed-cli.mjs`

- [ ] **Step 1: Inspect the installed CLI in the existing pack check**

Add `readFile` to the `node:fs/promises` import. After resolving `packageRoot`, read `lib/cli.mjs` and reject every forbidden marker:

```js
const cliSource = await readFile(join(packageRoot, 'lib', 'cli.mjs'), 'utf8')
const forbidden = [
  ['dynamic evaluation', /\bnew Function\s*\(|\beval\s*\(/],
  ['Schemastery', /schemastery/i],
  ['DSH web provider runtime', /@deepseek-ai[+/]dsh-web/i],
  ['DSH launch environment runtime', /@deepseek-ai[+/]dsh-launch-environment/i],
  ['Cordis runtime', /@deepseek-ai[+/]cordis/i],
]
for (const [label, pattern] of forbidden) {
  if (pattern.test(cliSource)) throw new Error(`Packed CLI unexpectedly contains ${label}`)
}
```

- [ ] **Step 2: Run the artifact gate and verify RED**

Run:

```bash
pnpm build
node scripts/check-packed-cli.mjs
```

Expected: FAIL with `Packed CLI unexpectedly contains dynamic evaluation` or `Schemastery`, proving the check detects the published `0.2.0` bundle problem.

### Task 2: Extract the dependency-free SearXNG client

**Files:**
- Create: `src/searxng-client.ts`
- Create: `test/searxng-client.test.ts`
- Modify: `src/provider.ts`
- Verify: `test/provider.test.ts`

- [ ] **Step 1: Write direct shared-client tests**

Create tests that import the wished-for client API and prove its independent behavior:

```ts
import { describe, expect, it, vi } from 'vitest'
import {
  SearxngClientError,
  isValidSearxngBaseUrl,
  searchSearxng,
} from '../src/searxng-client.ts'

describe('searchSearxng', () => {
  it('normalizes a real JSON search without DSH types', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      results: [{ url: 'https://example.com/result', title: 'Result', content: 'Snippet' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    await expect(searchSearxng({ baseURL: 'http://127.0.0.1:8080', fetch }, {
      query: 'deepseek harness',
    })).resolves.toEqual({
      sources: [{ url: 'https://example.com/result', title: 'Result', snippet: 'Snippet' }],
      truncated: false,
    })
  })

  it('returns a typed HTTP failure without leaking the response body', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('private body', { status: 403 }))
    const error = await searchSearxng({ baseURL: 'http://127.0.0.1:8080', fetch }, { query: 'q' })
      .then(() => undefined, (cause: unknown) => cause)
    expect(error).toBeInstanceOf(SearxngClientError)
    expect(error).toMatchObject({ kind: 'http', status: 403 })
    expect(JSON.stringify(error)).not.toContain('private body')
  })

  it('validates absolute credential-free HTTP endpoints', () => {
    expect(isValidSearxngBaseUrl('https://search.example.com/base')).toBe(true)
    expect(isValidSearxngBaseUrl('http://user:pass@localhost:8080')).toBe(false)
    expect(isValidSearxngBaseUrl('localhost:8080')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```bash
pnpm exec vitest run test/searxng-client.test.ts
```

Expected: FAIL because `src/searxng-client.ts` does not exist.

- [ ] **Step 3: Implement the shared local API**

Create these dependency-free public shapes in `src/searxng-client.ts`:

```ts
import type { SearxngResult, SearxngSearchResponse } from './types.ts'

export type SearxngClientFailureKind =
  | 'invalid-url'
  | 'caller-abort'
  | 'timeout'
  | 'network'
  | 'contract'
  | 'http'

export class SearxngClientError extends Error {
  constructor(
    readonly kind: SearxngClientFailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'SearxngClientError'
  }
}

export interface SearxngClientOptions {
  baseURL: string
  language?: string
  engines?: string
  categories?: string
  authHeader?: string
  timeoutMs?: number
  maxAttempts?: 1 | 2
  retryDelayMs?: number
  fetch?: typeof globalThis.fetch
}

export interface SearxngClientSource {
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
}

export interface SearxngClientResult {
  sources: SearxngClientSource[]
  truncated: false
}

export interface JsonRequestOptions {
  url: string
  headers: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  maxAttempts?: 1 | 2
  retryDelayMs?: number
  fetch?: typeof globalThis.fetch
}

export interface JsonRequestResult {
  response: Response
  payload?: unknown
}

export function isValidSearxngBaseUrl(baseURL: string): boolean
export function mapSearxngClientResult(result: unknown): SearxngClientSource | undefined
export function mapSearxngClientResponse(response: SearxngSearchResponse): SearxngClientResult
export async function requestJsonWithRetry(options: JsonRequestOptions): Promise<JsonRequestResult>
export async function searchSearxng(
  options: SearxngClientOptions,
  request: { query: string },
  signal?: AbortSignal,
): Promise<SearxngClientResult>
```

Move the existing bounded request, URL construction, response validation, result mapping, and retry behavior from `provider.ts` into this module. Use `dsh-searxng/0.2.1` as the attribution header. Do not import any DSH, Cordis, or Schemastery module.

- [ ] **Step 4: Convert the provider into a DSH adapter**

Keep the existing public provider types and map exports, but delegate their implementation:

```ts
import {
  SearxngClientError,
  isValidSearxngBaseUrl,
  mapSearxngClientResponse,
  mapSearxngClientResult,
  searchSearxng,
} from './searxng-client.ts'

export function mapSearxngResult(result: unknown): WebSearchSource | undefined {
  return mapSearxngClientResult(result)
}

export function mapSearxngResponse(response: SearxngSearchResponse): WebSearchResult {
  return mapSearxngClientResponse(response)
}
```

`available()` delegates to `isValidSearxngBaseUrl`. `search()` calls `searchSearxng(this.options, request, signal)` and converts `SearxngClientError` kinds to the existing `WebError` codes/messages, including status-specific 403 and 429 guidance. It must not expose the original error as a cause.

- [ ] **Step 5: Run shared-client and provider tests and verify GREEN**

Run:

```bash
pnpm exec vitest run test/searxng-client.test.ts test/provider.test.ts
```

Expected: both test files pass with the existing provider behavior preserved.

### Task 3: Remove the provider dependency from the CLI

**Files:**
- Modify: `test/cli/searxng.test.ts`
- Modify: `src/cli/searxng.ts`

- [ ] **Step 1: Replace provider-factory tests with shared-search injection tests**

Use a local structural search function instead of constructing a DSH provider:

```ts
const search = vi.fn(async () => ({
  sources: [{ url: 'https://example.com/provider' }],
  truncated: false as const,
}))
const probe = new DefaultSearxngProbe({ search })

await expect(probe.providerSearch(config, signal)).resolves.toMatchObject({
  endpoint: BASE,
  resultCount: 1,
})
expect(search).toHaveBeenCalledWith(
  expect.objectContaining(config),
  { query: PROBE_QUERY },
  signal,
)
```

Retain the cancellation, empty-result, credential-redaction, and error tests using the new `search` injection.

- [ ] **Step 2: Run the focused CLI test and verify RED**

Run:

```bash
pnpm exec vitest run test/cli/searxng.test.ts
```

Expected: FAIL because `DefaultSearxngProbeOptions` does not yet accept `search` and still requires `providerFactory`.

- [ ] **Step 3: Rewire the CLI to the shared client**

Replace the provider import with:

```ts
import {
  SearxngClientError,
  requestJsonWithRetry,
  searchSearxng,
  type SearxngClientOptions,
  type SearxngClientResult,
} from '../searxng-client.ts'

type ClientSearch = (
  options: SearxngClientOptions,
  request: { query: string },
  signal?: AbortSignal,
) => Promise<SearxngClientResult>

export interface DefaultSearxngProbeOptions {
  search?: ClientSearch
}
```

Store `options.search ?? searchSearxng`. `providerSearch` calls that function with the exact effective profile configuration and `{ query: PROBE_QUERY }`, then validates at least one normalized source. Update cancellation/transient conversion so `SearxngClientError.kind` maps to the existing CLI errors without leaking credentials.

- [ ] **Step 4: Run the CLI behavior test and verify GREEN**

Run:

```bash
pnpm exec vitest run test/cli/searxng.test.ts test/cli/setup.test.ts
```

Expected: both CLI test files pass.

- [ ] **Step 5: Build and verify the packed dependency gate turns GREEN**

Run:

```bash
pnpm build
node scripts/check-packed-cli.mjs
```

Expected: the packed CLI installs and runs, and no dynamic-evaluation, Schemastery, Cordis, DSH web, or DSH launch-environment marker is present.

- [ ] **Step 6: Commit the shared-client isolation**

```bash
git add src/searxng-client.ts src/provider.ts src/cli/searxng.ts test/searxng-client.test.ts test/cli/searxng.test.ts scripts/check-packed-cli.mjs
git commit -m "fix: isolate standalone CLI dependencies"
```

### Task 4: Constrain managed-directory removal to DSH home

**Files:**
- Modify: `test/cli/remove.test.ts`
- Modify: `src/cli/remove.ts`

- [ ] **Step 1: Add direct filesystem boundary tests**

Import `access`, `mkdir`, `mkdtemp`, `rm`, `symlink`, `writeFile` from `node:fs/promises`, `tmpdir` from `node:os`, and `join` from `node:path`. Add tests that create a temporary DSH home and call `removeManagedDirectory(dshHome)`:

```ts
it('derives and removes only the managed child of DSH home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-searxng-remove-'))
  const dshHome = join(root, 'dsh-home')
  const managed = join(dshHome, 'dsh-searxng')
  const sibling = join(dshHome, 'keep.txt')
  try {
    await mkdir(managed, { recursive: true })
    await writeFile(sibling, 'keep')
    await removeManagedDirectory(dshHome)
    await expect(access(managed)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(sibling)).resolves.toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
```

Add sibling cases for an absent target, a symlink target, a regular-file target, a relative DSH home, and a non-normalized DSH home. Each unsafe case must reject with `E_INTERNAL` without deleting the referenced directory or sibling files.

Change the orchestration expectation from `remove-dir:/dsh/dsh-searxng` to `remove-dir:/dsh`; this test must fail before the implementation changes.

- [ ] **Step 2: Run removal tests and verify RED**

Run:

```bash
pnpm exec vitest run test/cli/remove.test.ts
```

Expected: FAIL because the remover treats the supplied DSH home as the deletion target and orchestration still passes `managedDir`.

- [ ] **Step 3: Derive the exact managed child inside the remover**

Change the boundary to:

```ts
export async function removeManagedDirectory(dshHome: string): Promise<void> {
  if (!isAbsolute(dshHome) || normalize(dshHome) !== dshHome) {
    throw removalFailed('DSH home path is unsafe')
  }
  const path = join(dshHome, 'dsh-searxng')
  if (dirname(path) !== dshHome || basename(path) !== 'dsh-searxng') {
    throw removalFailed('Managed directory path is unsafe')
  }
  let info
  try { info = await lstat(path) } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return
    throw removalFailed('Unable to inspect the managed directory')
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw removalFailed('Managed directory is not a safe directory')
  }
  try { await rm(path, { recursive: true }) } catch {
    throw removalFailed('Unable to remove the managed directory')
  }
}
```

Update imports to include `dirname` and `join`. Rename the deferred variable in `remove()` to `purgeDshHome`, assign `resolved.dshHome`, and pass it to the dependency after the state lock completes. Update `RemoveDependencies` parameter naming to `dshHome`.

- [ ] **Step 4: Run removal and CLI wiring tests and verify GREEN**

Run:

```bash
pnpm exec vitest run test/cli/remove.test.ts test/cli/setup.test.ts
```

Expected: all tests pass, including direct unsafe-target rejection and the `/dsh` orchestration argument.

- [ ] **Step 5: Commit deletion hardening**

```bash
git add src/cli/remove.ts test/cli/remove.test.ts
git commit -m "fix: constrain managed data removal"
```

### Task 5: Prepare and verify release metadata

**Files:**
- Modify: `package.json`
- Verify unchanged: `pnpm-lock.yaml`
- Verify: `.github/workflows/dsh-vet.yml`

- [ ] **Step 1: Bump package metadata to 0.2.1**

Change the root package version in `package.json` from `0.2.0` to `0.2.1`. This pnpm lockfile does not record the workspace package's own version, so `pnpm-lock.yaml` must remain unchanged. Do not change dependency ranges or the existing `dsh.seams` declaration.

- [ ] **Step 2: Verify dsh-vet targets the release version**

Run:

```bash
rg -n "specifier: 'dsh-searxng'|version: '0.2.1'" .github/workflows/dsh-vet.yml
```

Expected: the workflow scans `dsh-searxng` version `0.2.1`.

- [ ] **Step 3: Run the complete local release gate**

Run:

```bash
pnpm verify
```

Expected: typecheck, all unit tests, build, package creation, packed CLI installation, forbidden-marker inspection, and Docker asset checks all exit zero.

- [ ] **Step 4: Inspect the exact tarball**

Run:

```bash
tar -xOf node_modules/.cache/pack/dsh-searxng-0.2.1.tgz package/package.json
tar -xOf node_modules/.cache/pack/dsh-searxng-0.2.1.tgz package/lib/cli.mjs | rg -n "new Function|eval\(|schemastery|@deepseek-ai[+/](dsh-web|dsh-launch-environment|cordis)"
```

Expected: the package metadata reports `0.2.1` with `dsh.seams` equal to `web`, `fs`, and `shell`; the second command prints nothing and exits one because no forbidden marker exists.

- [ ] **Step 5: Commit release metadata**

```bash
git add package.json
git commit -m "chore: prepare 0.2.1 release"
```

### Task 6: Deliver the release candidate and run real Docker validation

**Files:**
- No additional source files

- [ ] **Step 1: Check repository hygiene and commit history**

Run:

```bash
git diff main...HEAD --check
git status --short --branch
git log --oneline main..HEAD
```

Expected: no whitespace errors; only the pre-existing untracked `.pnpm-store/` remains; commits separate design, plan, CLI isolation, deletion hardening, and release metadata.

- [ ] **Step 2: Push and open the pull request**

Use an English title and body without tool attribution. Summarize the shared-client boundary, deletion constraint, `0.2.1` metadata, and local verification.

- [ ] **Step 3: Wait for the CI matrix**

Run `gh pr checks` until Ubuntu Node 20/24, macOS Node 20, Windows Node 20, and dsh-vet PR checks complete. Inspect failures rather than retrying blindly.

- [ ] **Step 4: Dispatch and verify both real Docker tests**

Run the `CI` workflow on the feature branch with `run_docker_e2e=true`. Verify `Run packed managed setup journey`, `Run Docker adapter integration`, and the `always()` cleanup step from the workflow logs.

- [ ] **Step 5: Report the merge-ready PR**

Provide the PR URL, exact local/CI/Docker evidence, expected remaining dsh-vet limitation, and request merge. Do not publish before the PR is merged.

### Task 7: Publish 0.2.1 and refresh trust metadata after merge

**Files:**
- Verify: published npm tarball
- Verify: `.dsh-vet/report.json`
- Verify: `.dsh-vet/badge.json`

- [ ] **Step 1: Synchronize merged main and rerun the local gate**

Fast-forward local `main`, verify the merge commit includes the release metadata, and rerun `pnpm verify` on the exact publish candidate.

- [ ] **Step 2: Publish npm 0.2.1**

Run `npm publish` only from clean, verified `main`. Confirm `npm view dsh-searxng@0.2.1 version dist.integrity dist.tarball` resolves the newly published artifact.

- [ ] **Step 3: Create the matching GitHub release**

Create and push annotated tag `v0.2.1`, then create a non-draft, non-prerelease GitHub Release whose notes describe CLI dependency isolation and safer managed-data cleanup.

- [ ] **Step 4: Dispatch dsh-vet and verify the published artifact**

Dispatch `.github/workflows/dsh-vet.yml` on `main`. Confirm the committed report resolves version `0.2.1`, contains no `obf.eval-detect`, and records the resulting grade.

- [ ] **Step 5: Dispute the remaining dynamic-delete finding if present**

If `perm.undeclared-fs-write` remains medium/low, open a false-positive issue in `rogerdigital/dsh-vet` containing:

- the published package/version and report evidence;
- a permalink to the function deriving `<DSH_HOME>/dsh-searxng`;
- a permalink to its direct filesystem safety tests;
- the fact that `DSH_HOME` is intentionally configurable;
- a request for documented handling of validated config-derived targets, not a package-specific silent suppression.

Link the dispute in the final release report. If a medium/high-confidence finding remains, stop and investigate before publicizing a grade improvement.
