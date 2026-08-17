# First-Round Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing SearXNG provider easier to start, safer around base URLs, and continuously verifiable without expanding its search capability.

**Architecture:** Keep the provider contract unchanged. Normalize the configured base URL only when constructing the `/search` request, reject base URLs containing query or fragment components in the cheap local availability check, and add repository-level verification around the existing TypeScript/Vitest/tsdown package. Documentation will distinguish installed-plugin users from source-checkout users.

**Tech Stack:** TypeScript, Vitest, tsdown, pnpm, npm packaging, GitHub Actions, Docker Compose

---

### Task 1: Normalize SearXNG Search URLs

**Files:**
- Modify: `test/provider.test.ts`
- Modify: `src/provider.ts`

- [ ] **Step 1: Write failing URL behavior tests**

Add table-driven search tests that expect all of these base URLs to request exactly one `/search` path segment:

```ts
it.each([
  ['http://127.0.0.1:8080/', 'http://127.0.0.1:8080/search'],
  ['http://127.0.0.1:8080/searxng', 'http://127.0.0.1:8080/searxng/search'],
  ['http://127.0.0.1:8080/searxng/', 'http://127.0.0.1:8080/searxng/search'],
])('normalizes the base URL %s', async (baseURL, expectedPath) => {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }))
  vi.stubGlobal('fetch', fetchMock)

  await new SearxngSearchProvider({ baseURL }).search({ query: 'q' })

  const requested = new URL(fetchMock.mock.calls[0]![0] as string)
  expect(requested.origin + requested.pathname).toBe(expectedPath)
})
```

Extend the availability test so base URLs with `?query` or `#fragment` are unavailable:

```ts
expect(new SearxngSearchProvider({ baseURL: `${BASE}?x=1` }).available()).toBe(false)
expect(new SearxngSearchProvider({ baseURL: `${BASE}#section` }).available()).toBe(false)
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm test -- test/provider.test.ts`

Expected: the trailing-slash cases fail because the current implementation requests `//search`, and query/fragment availability assertions fail because those URLs are currently accepted.

- [ ] **Step 3: Implement minimal URL normalization**

In `src/provider.ts`, construct the request URL through a focused helper:

```ts
function buildSearchUrl(baseURL: string, params: URLSearchParams): string {
  const url = new URL(baseURL)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/search`
  url.search = params.toString()
  url.hash = ''
  return url.toString()
}
```

Use `buildSearchUrl(this.options.baseURL, params)` in `fetch`. Update `isValidBaseUrl` to reject parsed URLs whose `search` or `hash` is non-empty while continuing to accept only `http:` and `https:`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `pnpm test -- test/provider.test.ts`

Expected: all provider tests pass.

### Task 2: Make the Docker Quick Start Honest and Reproducible

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the checkout-only quick-start assumption**

Document two explicit paths:

```md
If you installed only the plugin, clone the small repository example first:

```sh
git clone --depth 1 https://github.com/rogerdigital/dsh-searxng.git dsh-searxng-example
docker compose -f dsh-searxng-example/examples/docker/docker-compose.yml up -d
```

From an existing source checkout, run `docker compose up -d` in `examples/docker`.
```

Keep the JSON verification curl command and describe `examples/docker` as a repository example rather than a file guaranteed to be exposed by the installed plugin.

- [ ] **Step 2: Check documentation references**

Run: `rg -n "bundled|examples/docker|docker compose" README.md package.json`

Expected: every `examples/docker` reference states when a source checkout is required, and no text claims the installed package exposes that directory.

### Task 3: Add a Single Local Verification Command

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add deterministic tool and verification metadata**

Add the package manager declaration and scripts:

```json
"packageManager": "pnpm@10.23.0",
"scripts": {
  "build": "tsdown",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "pack:check": "npm pack --dry-run --cache ./node_modules/.cache/npm",
  "verify": "pnpm typecheck && pnpm test && pnpm build && pnpm pack:check",
  "prepublishOnly": "pnpm run build"
}
```

The package cache stays under ignored `node_modules`, avoiding dependence on a potentially broken user-level npm cache.

- [ ] **Step 2: Run the unified verification command**

Run: `pnpm verify`

Expected: type checking passes, all tests pass, the ESM/types build succeeds, and npm prints a dry-run tarball containing the intended six release files.

### Task 4: Add Continuous Integration

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Add the minimum-version CI job**

Create this workflow:

```yaml
name: CI

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10.23.0
          run_install: false
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm verify
```

- [ ] **Step 2: Validate workflow syntax locally**

Run a YAML parse check using an already available parser, then inspect the workflow keys. Expected: the file parses and contains one `verify` job on Node.js 20.

### Task 5: Align Compatibility Claims With Tested Versions

**Files:**
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Raise unverified peer lower bounds**

Change the peer ranges to the versions actually installed and tested:

```json
"@deepseek-ai/dsh-launch-environment": ">=0.0.1-rc.3 <0.2.0",
"@deepseek-ai/dsh-web": ">=0.1.0-rc.6 <0.2.0"
```

Keep the exact development dependencies at `0.0.1-rc.3` and `0.1.0-rc.6`.

- [ ] **Step 2: Update the compatibility table**

State that plugin `0.1.0` is tested with `dsh-web 0.1.0-rc.6` and `dsh-launch-environment 0.0.1-rc.3`, and make the declared lower bounds match `package.json`.

- [ ] **Step 3: Run final verification and inspect the diff**

Run: `pnpm verify`

Run: `git diff --check`

Run: `git status --short`

Expected: verification succeeds, the diff has no whitespace errors, and only the planned source, tests, documentation, metadata, plan, and CI workflow are modified or added.
