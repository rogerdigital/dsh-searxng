# Independent Audit Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the dsh-searxng adopter story into its owning repository and make dsh-vet a pinned, non-blocking post-merge audit integration.

**Architecture:** dsh-searxng owns the outreach artifact, report branch, badge, workflow, and scanner upgrade decisions. The audit runs only on `main` pushes and manual dispatch, while the repository ruleset requires only the four platform verification checks. dsh-vet retains frozen historical examples but no live operational control over dsh-searxng.

**Tech Stack:** Markdown, GitHub Actions YAML, GitHub repository rulesets REST API, GitHub Discussions GraphQL API, pnpm/Vitest/TypeScript.

---

### Task 1: Move the adopter story and pin the non-blocking audit

**Files:**
- Create: `docs/outreach/README.md`
- Create: `docs/outreach/dsh-searxng-adopters-post.md`
- Modify: `.github/workflows/dsh-vet.yml`

- [ ] **Step 1: Add the outreach registry**

Create `docs/outreach/README.md` with this content:

```markdown
# Outreach

Repository-owned drafts and publication records for dsh-searxng.

| Artifact | Destination | Status |
|---|---|---|
| [dsh-searxng adopter post](dsh-searxng-adopters-post.md) | [DeepSeek Harness: Show Your Plugins!](https://github.com/deepseek-ai/deepseek-harness/discussions/categories/show-your-plugins) | Draft |
```

- [ ] **Step 2: Copy the approved adopter post**

Copy the tracked content from
`/Users/Roger/Code/personal/dsh-vet/docs/outreach/dsh-searxng-adopters-post.md`
to `docs/outreach/dsh-searxng-adopters-post.md`. Preserve the public body and
its evidence links; change only the hidden ownership comment after publication.

- [ ] **Step 3: Make the audit post-merge-only and immutable**

Change `.github/workflows/dsh-vet.yml` so the relevant sections are:

```yaml
# dsh-vet pre-install security audit: report artifact and a committed report +
# grade badge on main (D3: the badge reads .dsh-vet/badge.json from this
# repository — no badge service).
#
# The audit targets the PUBLISHED npm artifact, not the source tree: this
# repo is TypeScript, so a '.' scan finds no .js to analyze. It is therefore a
# post-merge publication check, not a pull-request gate.
name: dsh-vet

on:
  push:
    branches: [main]
  workflow_dispatch: # refresh the badge after publishing a release

permissions:
  contents: write

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: rogerdigital/dsh-vet/action@3005968cc708d12b7e1f98f1a312239b5312ce7f # v0.3.0
        with:
          version: '0.3.0'
          specifier: 'dsh-searxng'
          comment: false
          commit-report: true
```

- [ ] **Step 4: Validate the workflow and repository invariants**

Run:

```bash
node --input-type=module -e "import { readFileSync } from 'node:fs'; import YAML from 'yaml'; const workflow=YAML.parse(readFileSync('.github/workflows/dsh-vet.yml','utf8')); if ('pull_request' in workflow.on) throw new Error('pull_request trigger remains'); if (workflow.jobs.audit.steps[1].uses !== 'rogerdigital/dsh-vet/action@3005968cc708d12b7e1f98f1a312239b5312ce7f') throw new Error('action SHA mismatch'); if (workflow.jobs.audit.steps[1].with.version !== '0.3.0') throw new Error('scanner version mismatch')"
node --input-type=module -e "import pkg from './package.json' with { type: 'json' }; const all={...pkg.dependencies,...pkg.devDependencies,...pkg.peerDependencies}; if ('dsh-vet' in all) throw new Error('dsh-vet became a package dependency')"
git diff --check
```

Expected: all three commands exit 0 with no output.

- [ ] **Step 5: Run the full repository verification**

Run: `pnpm verify`

Expected: typecheck, tests, build, pack inspection, and packed CLI smoke test all pass.

- [ ] **Step 6: Commit the repository changes**

```bash
git add .github/workflows/dsh-vet.yml docs/outreach
git commit -m "ci: make plugin audit non-blocking"
```

### Task 2: Publish the maintainer-owned adoption case

**Files:**
- Modify: `docs/outreach/README.md`
- Modify: `docs/outreach/dsh-searxng-adopters-post.md`

- [ ] **Step 1: Recheck for a duplicate discussion**

Run a GitHub Discussion search for the exact title
`dsh-searxng — self-hosted, key-less web search with continuous audit` in
`deepseek-ai/deepseek-harness`. Continue only when no matching discussion exists.

- [ ] **Step 2: Create the Show Your Plugins discussion**

Use repository ID `R_kgDOT3T1gw`, category ID
`DIC_kwDOT3T1g84DDSUe`, the exact title above, and the Markdown body from
`docs/outreach/dsh-searxng-adopters-post.md`. The post must contain no assistant
or automation attribution.

Expected: GitHub returns one new discussion URL under
`https://github.com/deepseek-ai/deepseek-harness/discussions/`.

- [ ] **Step 3: Record the publication URL**

Replace `Draft` in the registry row with a Markdown `Published` link using the
exact returned discussion URL. Update the post's hidden opening comment to
include the same URL and describe it as a maintainer-owned adoption case, not a
third-party adoption.

- [ ] **Step 4: Verify and commit the publication record**

Run:

```bash
rg -n 'Published|maintainer-owned adoption case|https://github.com/deepseek-ai/deepseek-harness/discussions/' docs/outreach
git diff --check
git add docs/outreach
git commit -m "docs: record dsh-searxng adoption post"
```

Expected: both files contain the same discussion URL and `git diff --check`
exits 0.

### Task 3: Remove the audit merge gate without weakening platform checks

**External state:**
- Modify: `rogerdigital/dsh-searxng` ruleset `21938569` (`protect-main`)

- [ ] **Step 1: Capture and verify the current ruleset**

Read ruleset `21938569` and assert that its required contexts are exactly:

```text
Verify (macos-latest, Node 20)
Verify (ubuntu-latest, Node 20)
Verify (ubuntu-latest, Node 24)
Verify (windows-latest, Node 20)
audit
```

Stop rather than overwriting the ruleset if any other condition, rule, or
required context differs from the design snapshot.

- [ ] **Step 2: Update only the required status check list**

Send the existing ruleset back through the repository rulesets API with the
`audit` context removed. Preserve the pull-request rule, strict required-check
policy, non-fast-forward rule, deletion rule, conditions, enforcement, and
empty bypass list byte-for-byte in meaning.

- [ ] **Step 3: Verify the live ruleset**

Read ruleset `21938569` again.

Expected: it is active on the default branch and requires exactly the four
`Verify` contexts above; `audit` is absent and all non-status-check rules are
unchanged.

### Task 4: Deliver and verify the repository change

**External state:**
- Create and merge: one pull request in `rogerdigital/dsh-searxng`
- Verify: GitHub Actions and `dsh-vet/report`

- [ ] **Step 1: Push and open the pull request**

Create `/tmp/dsh-searxng-independent-audit-pr.md` with a concise summary of
the ownership transfer, immutable v0.3.0 pin, removal of the PR trigger and
audit gate, the exact published discussion URL, and the fresh `pnpm verify`
result. Do not include assistant or automation attribution. Then run:

```bash
git push -u origin docs/independent-audit-boundary
gh pr create --base main --head docs/independent-audit-boundary --title "ci: decouple plugin audit from pull requests" --body-file /tmp/dsh-searxng-independent-audit-pr.md
```

- [ ] **Step 2: Verify required checks and merge**

Wait for these four checks to pass:

```text
Verify (macos-latest, Node 20)
Verify (ubuntu-latest, Node 20)
Verify (ubuntu-latest, Node 24)
Verify (windows-latest, Node 20)
```

Confirm no `audit` check is required, then merge the PR using the repository's
normal merge method.

- [ ] **Step 3: Verify the post-merge audit**

Wait for the `dsh-vet` workflow triggered by the merged `main` push.

Expected: it succeeds; the `dsh-vet/report` branch reports scanner `0.3.0`,
target `dsh-searxng@0.2.1`, and grade `A`; the README badge reads that branch.

- [ ] **Step 4: Clean both local branches**

In dsh-searxng, synchronize `main`, delete the merged local feature branch, and
verify the remote feature branch is absent. In dsh-vet, first verify the copied
post is present on dsh-searxng `main`, then switch to `main` and delete only the
abandoned local `docs/searxng-adopters-post` branch. Preserve the unrelated
untracked `.zcode/` directory.

- [ ] **Step 5: Final evidence check**

Verify:

```text
dsh-searxng main is clean
dsh-searxng package.json has no dsh-vet dependency
dsh-searxng ruleset requires only four platform Verify checks
dsh-searxng report uses scanner 0.3.0 and grade A
dsh-vet main remains unchanged by the adopter post
dsh-vet ROADMAP v0.3 marketplace, third-party emitter, feedback, and freeze items remain unchecked
```
