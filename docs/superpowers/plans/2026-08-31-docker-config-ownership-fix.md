# Docker Configuration Ownership Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Completed — merged through PR #10 and verified by the packed managed setup journey, Docker adapter integration, and unconditional labeled-resource cleanup. The unchecked boxes below preserve the original execution outline; this status line is authoritative.

**Goal:** Preserve host ownership of private generated SearXNG configuration and make the manual Linux Docker job run both real Docker release tests.

**Architecture:** Keep the existing private `0700` directories and `0600` files, but disable the pinned SearXNG entrypoint's recursive ownership rewrite through the packaged Compose environment. Extend the existing opt-in Ubuntu Docker job with two explicit, isolated Vitest invocations so the packed lifecycle and lower-level Docker adapter are both release gates.

**Tech Stack:** Docker Compose v2, SearXNG container image, TypeScript, Vitest, GitHub Actions, pnpm

---

### Task 1: Preserve generated configuration ownership

**Files:**
- Modify: `test/cli/assets.test.ts:18-38`
- Modify: `assets/docker/compose.yml:1-31`

- [ ] **Step 1: Write the failing asset assertion**

Add this assertion beside the existing service security assertions:

```ts
expect(service.environment).toEqual({ FORCE_OWNERSHIP: 'false' })
```

- [ ] **Step 2: Run the focused test and verify the assertion fails**

Run:

```bash
pnpm exec vitest run test/cli/assets.test.ts
```

Expected: FAIL because `compose.services.searxng.environment` is currently undefined.

- [ ] **Step 3: Add the minimal Compose configuration**

Add this mapping to the `searxng` service before `ports`:

```yaml
environment:
  FORCE_OWNERSHIP: "false"
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
pnpm exec vitest run test/cli/assets.test.ts
```

Expected: `test/cli/assets.test.ts` passes with no failures.

- [ ] **Step 5: Commit the ownership fix**

```bash
git add assets/docker/compose.yml test/cli/assets.test.ts
git commit -m "fix: preserve managed config ownership"
```

### Task 2: Run both real Docker release tests

**Files:**
- Modify: `.github/workflows/ci.yml:62-65`

- [ ] **Step 1: Replace the broad managed-test command with isolated commands**

Replace the existing Docker test step with:

```yaml
- name: Run packed managed setup journey
  run: DSH_SEARXNG_E2E=1 pnpm exec vitest run test/e2e/managed-setup.test.ts
- name: Run Docker adapter integration
  run: DSH_SEARXNG_DOCKER_INTEGRATION=1 pnpm exec vitest run test/cli/docker.integration.test.ts
```

Keep the existing `Remove any labeled test resources` step after both commands with `if: always()`.

- [ ] **Step 2: Parse and inspect the workflow commands**

Run:

```bash
node --input-type=module -e "import { readFileSync } from 'node:fs'; import { parse } from 'yaml'; const workflow=parse(readFileSync('.github/workflows/ci.yml','utf8')); const runs=workflow.jobs['docker-e2e'].steps.flatMap((step)=>typeof step.run==='string'?[step.run]:[]); console.log(runs.filter((run)=>run.includes('DSH_SEARXNG_')).join('\n')); if(!runs.some((run)=>run.includes('DSH_SEARXNG_E2E=1')&&run.includes('managed-setup.test.ts'))||!runs.some((run)=>run.includes('DSH_SEARXNG_DOCKER_INTEGRATION=1')&&run.includes('docker.integration.test.ts'))) process.exit(1)"
```

Expected: both environment-gated Vitest commands are printed and the command exits zero.

- [ ] **Step 3: Commit the workflow coverage**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run both managed Docker tests"
```

### Task 3: Run local release verification

**Files:**
- Verify: `package.json`
- Verify: generated npm tarball under `node_modules/.cache/pack/`

- [ ] **Step 1: Run the complete local gate**

Run:

```bash
pnpm verify
```

Expected: typecheck, unit tests, build, tarball creation, packed CLI installation, and Docker asset verification all exit zero. Environment-gated Docker tests remain skipped locally because this host has no Docker CLI.

- [ ] **Step 2: Confirm the fixed Compose asset is shipped**

Run:

```bash
tar -xOf node_modules/.cache/pack/dsh-searxng-0.2.0.tgz package/assets/docker/compose.yml
```

Expected: the packed `searxng` service contains `FORCE_OWNERSHIP: "false"`.

- [ ] **Step 3: Check repository hygiene**

Run:

```bash
git diff --check
git status --short --branch
```

Expected: no whitespace errors; only the pre-existing untracked `.pnpm-store/` remains outside committed changes.

### Task 4: Deliver and run real Docker validation

**Files:**
- No additional source files

- [ ] **Step 1: Push the branch and create a pull request**

```bash
git push -u origin fix/docker-config-ownership
gh pr create --base main --head fix/docker-config-ownership --title "fix: preserve managed Docker config ownership" --body "## Summary
- prevent the pinned SearXNG image from changing ownership of private generated configuration
- preserve existing 0700/0600 host permissions across repeated managed lifecycle commands
- run both real Docker release tests in the opt-in Linux job

## Verification
- pnpm verify
- packed Compose asset inspection
- opt-in Managed Docker journey"
```

Expected: GitHub returns a PR URL and reports the branch as mergeable after checks initialize.

- [ ] **Step 2: Dispatch the opt-in Docker job on the fix branch**

Run:

```bash
gh workflow run ci.yml --ref fix/docker-config-ownership -f run_docker_e2e=true
```

Expected: a workflow run URL or run identifier is created for the fix branch.

- [ ] **Step 3: Wait for the workflow and inspect both Docker steps**

Run:

```bash
gh run watch "$(gh run list --workflow CI --branch fix/docker-config-ownership --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
gh run view "$(gh run list --workflow CI --branch fix/docker-config-ownership --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId')" --log
```

Expected: `Run packed managed setup journey`, `Run Docker adapter integration`, and labeled-resource cleanup all complete successfully.

- [ ] **Step 4: Verify PR status**

Run:

```bash
gh pr checks fix/docker-config-ownership
gh pr view fix/docker-config-ownership --json mergeable,state,url
```

Expected: required PR checks pass and the PR is mergeable. Do not merge or publish without the user's explicit instruction.
