# Documentation Status and README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make historical plan status and the public README accurately describe the released `0.2.1` product boundary and its verified support levels.

**Architecture:** Add authoritative status notes to the four existing implementation plans without rewriting their historical steps. Restructure only the README sections that affect the first-run path, manual installation, version, and support evidence; retain the shipped configuration, operations, troubleshooting, and safety guidance.

**Tech Stack:** Markdown, Git, pnpm verification, current TypeScript CLI grammar and GitHub Actions workflows as evidence

**Design:** `docs/superpowers/specs/2026-08-31-documentation-status-readme-design.md`

---

### Task 1: Record authoritative implementation-plan status

**Files:**
- Modify: `docs/superpowers/plans/2026-08-29-managed-searxng-core.md`
- Modify: `docs/superpowers/plans/2026-08-29-managed-searxng-lifecycle.md`
- Modify: `docs/superpowers/plans/2026-08-31-docker-config-ownership-fix.md`
- Modify: `docs/superpowers/plans/2026-08-31-cli-audit-hardening.md`

- [ ] **Step 1: Add completed status to the managed core plan**

Insert after the agentic-worker note:

```markdown
**Status:** Completed — delivered in `0.2.0` and reverified against the published `0.2.1` boundary. The unchecked boxes below preserve the original execution outline; this status line is authoritative.
```

- [ ] **Step 2: Mark the lifecycle plan as deferred**

Insert after the agentic-worker note:

```markdown
**Status:** Deferred / Not started — `repair`, transactional `update`, durable operation journals, state V2 migration, deployment catalogs, crash recovery, and three-platform Docker certification are not part of `0.2.1`. The unchecked boxes below remain the proposed future execution outline.
```

- [ ] **Step 3: Add completed status to the Docker ownership plan**

Insert after the agentic-worker note:

```markdown
**Status:** Completed — merged through PR #10 and verified by the packed managed setup journey, Docker adapter integration, and unconditional labeled-resource cleanup. The unchecked boxes below preserve the original execution outline; this status line is authoritative.
```

- [ ] **Step 4: Add completed status to the CLI audit plan**

Insert after the agentic-worker note:

```markdown
**Status:** Completed — delivered and published as `0.2.1`; the packed CLI dependency gate passes, dsh-vet reports grade A, and the remaining low-confidence delete-path finding is tracked in dsh-vet issue #10. The unchecked boxes below preserve the original execution outline; this status line is authoritative.
```

- [ ] **Step 5: Verify exactly four authoritative status lines**

Run:

```bash
rg -n '^\*\*Status:\*\*' docs/superpowers/plans/2026-08-29-managed-searxng-core.md docs/superpowers/plans/2026-08-29-managed-searxng-lifecycle.md docs/superpowers/plans/2026-08-31-docker-config-ownership-fix.md docs/superpowers/plans/2026-08-31-cli-audit-hardening.md
```

Expected: exactly four matches; three contain `Completed` and one contains `Deferred / Not started`.

### Task 2: Streamline the public README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Make managed setup the first path**

Remove the mandatory top-level `Install` section. Keep `Quick start` immediately after the introduction and add this sentence after its requirements:

```markdown
The setup command installs and attaches `dsh-searxng` to the selected profile, so no separate plugin-install step is required.
```

Retain the two-command quickstart:

```sh
npx dsh-searxng setup
dsh --profile web
```

- [ ] **Step 2: Preserve manual installation as an advanced path**

After the existing-SearXNG section, add:

````markdown
## Manual plugin installation

If you manage the DSH profile patch yourself and do not want the setup command to attach it, install only the plugin package:

```sh
dsh plugin add dsh-searxng
```

With a named profile, use `dsh plugin --profile <name> add dsh-searxng`.
````

- [ ] **Step 3: Correct the runtime support evidence**

Replace the runtime-support bullets with statements that distinguish validation layers:

```markdown
- Node.js: 20 and newer.
- CLI, tests, build, and packed artifact: verified on Linux, macOS, and Windows.
- Managed Docker journey and Docker adapter integration: verified in Linux CI with Docker Engine and Compose v2.
- Docker Desktop on macOS and Windows is supported but has not completed formal release certification.
- External SearXNG mode does not require Docker.
- Podman and Podman Compose are not supported in the managed path.
```

Change `Version 0.2.0 supports` to `Version 0.2.1 supports` without changing the dependency ranges.

- [ ] **Step 4: Keep the README limited to shipped capabilities**

Run:

```bash
rg -n 'repair|transactional update|operation journal|state V2|release certification' README.md
```

Expected: only the support sentence stating that Docker Desktop has not completed formal release certification may match; no command or feature claim for `repair`, `update`, journals, or state V2 appears.

### Task 3: Verify and commit the documentation update

**Files:**
- Verify: `README.md`
- Verify: the four modified historical plans
- Verify: `docs/superpowers/specs/2026-08-31-documentation-status-readme-design.md`
- Verify: `docs/superpowers/plans/2026-08-31-documentation-status-readme.md`

- [ ] **Step 1: Check stale version references and CLI command scope**

Run:

```bash
rg -n 'Version 0\.2\.0|npx dsh-searxng (repair|update)' README.md
```

Expected: no output and exit status 1.

Run:

```bash
rg -n "expected one command: setup, status, doctor, or remove" src/cli/args.ts
```

Expected: one match proving the documented command set matches the CLI grammar.

- [ ] **Step 2: Run documentation and release-boundary verification**

Run:

```bash
git diff --check
pnpm verify
```

Expected: no whitespace errors; typecheck, 541 unit tests, build, package creation, packed CLI installation, forbidden-marker inspection, and Docker asset checks pass. Environment-gated Docker tests remain skipped locally.

- [ ] **Step 3: Review scope and commit**

Run:

```bash
git diff --stat HEAD~1
git status --short --branch
```

Expected: only the design, implementation plan, README, and four historical plans are changed; no runtime or package files are modified.

Commit:

```bash
git add README.md docs/superpowers/specs/2026-08-31-documentation-status-readme-design.md docs/superpowers/plans/2026-08-31-documentation-status-readme.md docs/superpowers/plans/2026-08-29-managed-searxng-core.md docs/superpowers/plans/2026-08-29-managed-searxng-lifecycle.md docs/superpowers/plans/2026-08-31-docker-config-ownership-fix.md docs/superpowers/plans/2026-08-31-cli-audit-hardening.md
git commit -m "docs: align plans and README with 0.2.1"
```
