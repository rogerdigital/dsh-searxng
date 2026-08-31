# CLI Audit Hardening Design

**Status:** Approved design

**Date:** 2026-08-31

## Problem

The published `dsh-searxng@0.2.0` artifact receives a C grade from dsh-vet for two medium findings in `lib/cli.mjs`:

1. `obf.eval-detect` finds Schemastery's dynamic `new Function` call. The CLI does not use dynamic evaluation directly. Its `DefaultSearxngProbe` imports `SearxngSearchProvider`, which pulls the DSH web provider dependency graph into the standalone CLI bundle. That graph includes Schemastery and makes the CLI 478,788 bytes even though the CLI needs only the SearXNG request behavior.
2. `perm.undeclared-fs-write` finds `rm(path, { recursive: true })`. The call is reached only after Docker ownership checks and the current function checks that the target is an absolute, normalized, non-symlink directory named `dsh-searxng`. However, the function accepts an arbitrary complete path, so the safety boundary is weaker and less reviewable than deriving the target inside the remover from the resolved DSH home.

The network finding is informational and correctly covered by the declared `web` seam. The release must not hide or suppress findings. It must remove the unnecessary dependency chain, make destructive scope explicit in code, and use dsh-vet's public dispute process where static analysis cannot follow a legitimate runtime-derived path.

## Decision

Version `0.2.1` will separate the protocol-level SearXNG client from the DSH provider adapter.

- A dependency-free SearXNG client module will own URL validation, bounded JSON requests, retries, response validation, and result normalization.
- `SearxngSearchProvider` will remain the DSH-facing adapter. It will call the shared client and translate client failures into `WebError` values.
- `DefaultSearxngProbe` will call the same shared client directly. It will no longer import the provider module or any DSH runtime package.
- Existing public provider exports and behavior will remain compatible.
- The CLI will remain fully bundled so `npx dsh-searxng ...` works before a DSH host resolves optional peer dependencies.

This is preferred over duplicating the request logic in the CLI, which could make setup validation disagree with runtime provider behavior. It is also preferred over externalizing DSH dependencies from the CLI bundle, which would make the standalone setup command depend on a preinstalled host.

## Shared Client Boundary

The shared client is a local module with no imports from:

- `@deepseek-ai/cordis`;
- `@deepseek-ai/dsh-launch-environment`;
- `@deepseek-ai/dsh-web`;
- `@deepseek-ai/schemastery`.

It exposes structural local types rather than DSH types. The normalized result shape remains assignable to the DSH web seam result shape, but the provider adapter owns that compatibility boundary.

The shared client performs the substantive runtime behavior that setup must validate:

1. validate an absolute HTTP or HTTPS base URL without credentials, query, or fragment;
2. construct the SearXNG JSON search request with language, engine, category, authorization, and attribution headers;
3. enforce cancellation, timeout, and bounded retry rules;
4. reject HTTP failures and malformed or non-JSON responses with typed client failures;
5. normalize only usable HTTP or HTTPS result URLs and optional metadata.

The provider adapter maps typed client failures to the existing `WEB_ABORTED` and `WEB_PROVIDER_ERROR` contracts. The CLI maps the same failures to its existing actionable `CliError` codes. This keeps the user-visible behavior of both entry points stable while eliminating the dependency cycle.

## Destructive Path Boundary

The recursive remover will no longer accept an arbitrary full directory path. It will accept the resolved DSH home, validate that input, derive the exact target as `<DSH_HOME>/dsh-searxng`, and then apply the existing non-symlink directory checks before deletion.

The removal orchestration will pass `resolved.dshHome`, not `resolved.managedDir`, to this boundary. Tests will prove that:

- the derived managed child is removed;
- a symlink or non-directory target is rejected;
- callers cannot select a sibling, parent, or different basename;
- an absent managed child is idempotent;
- recursive removal occurs only after profile, Docker ownership, and purge confirmation checks succeed.

`DSH_HOME` is intentionally configurable, so the final filesystem path remains a runtime value. The current dsh-vet rule reports every dynamic destructive target as medium/low confidence and does not perform data-flow analysis. If the published `0.2.1` artifact still receives this finding, the project will submit a false-positive dispute with the exact source boundary, tests, and intended configurable-home use case. No aliasing, scanner-specific renaming, or other audit evasion will be used.

## Artifact-Level Regression Gate

The release gate will inspect the built and packed CLI, not only source imports.

`lib/cli.mjs` and the installed tarball CLI must contain none of:

- `new Function` or `eval(` introduced by bundled dependencies;
- Schemastery package markers;
- DSH provider/runtime package markers.

The gate will also execute the packed CLI help command and retain the existing Docker asset checks. Source-level unit tests will cover shared-client behavior, provider error translation, CLI error translation, and deletion scope.

The plugin entry point may still depend on DSH and Schemastery because that is the declared runtime integration surface. The isolation requirement applies specifically to the standalone CLI entry point.

## Version and Release Sequence

The release sequence is:

1. bump `package.json` and lockfile metadata to `0.2.1`;
2. run typecheck, unit tests, build, package checks, and packed CLI checks;
3. run both real Docker workflows against the release commit;
4. merge the reviewed pull request;
5. publish `dsh-searxng@0.2.1` to npm;
6. create the `v0.2.1` Git tag and GitHub Release with concise release notes;
7. dispatch dsh-vet, which already targets version `0.2.1`, and verify the committed report and badge;
8. if the runtime-derived delete target remains, file and link the false-positive dispute.

Do not advertise an improved grade until the report against the published `0.2.1` tarball is available. The npm artifact, GitHub tag, GitHub Release, and dsh-vet report must all identify the same version.

## Verification

The change is complete only when all of the following are proven on the release candidate:

- shared-client tests pass after demonstrating the new dependency boundary with a failing regression test first;
- provider and CLI behavior tests pass;
- deletion-scope tests pass;
- `pnpm typecheck` passes;
- `pnpm test` passes;
- `pnpm build` passes;
- `pnpm pack:check` and `pnpm pack:test` pass;
- the built and packed CLI contain no dynamic evaluation or DSH/Schemastery dependency markers;
- the standard CI matrix passes on Ubuntu Node 20/24, macOS Node 20, and Windows Node 20;
- the packed managed setup journey passes in real Docker;
- the Docker adapter integration test passes in real Docker;
- after npm publication, dsh-vet resolves exactly `0.2.1` and produces no `obf.eval-detect` finding.

Any remaining medium/high-confidence finding blocks grade promotion and release publicity. The expected dynamic filesystem finding is acceptable only as a documented low-confidence limitation with a linked public dispute.
