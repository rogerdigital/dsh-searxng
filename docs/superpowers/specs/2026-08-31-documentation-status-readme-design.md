# Documentation Status and README Design

**Status:** Approved

## Goal

Make the repository documentation match the released `0.2.1` product boundary. Historical implementation plans must show their real delivery status, while the README must lead users through the shortest supported setup path and distinguish verified behavior from unverified certification claims.

## Scope

Update these implementation plans:

- `2026-08-29-managed-searxng-core.md`
- `2026-08-29-managed-searxng-lifecycle.md`
- `2026-08-31-docker-config-ownership-fix.md`
- `2026-08-31-cli-audit-hardening.md`

Update `README.md`. Do not change runtime code, package metadata, CI behavior, or release artifacts.

## Plan Status Model

The managed core, Docker configuration ownership fix, and CLI audit hardening plans receive a `Completed` status near the top. Each status note records the delivered release or verification boundary that proves completion.

The managed lifecycle plan receives `Deferred / Not started`. Its note explicitly says that `repair`, transactional `update`, durable operation journals, state V2 migration, deployment catalogs, crash recovery, and three-platform release certification are not part of `0.2.1`.

Existing unchecked step boxes remain unchanged. They are historical execution instructions, not reliable after-the-fact evidence that every red/green command ran in the exact written order. The status note is the authoritative current marker.

## README Information Architecture

The first user path is managed setup:

```sh
npx dsh-searxng setup
dsh --profile web
```

The surrounding text states that setup installs and attaches the plugin, creates the owned loopback-only SearXNG deployment, validates real search, and activates the profile only after validation. A separate mandatory `dsh plugin add` step is removed from the primary path.

Manual plugin installation remains available as an advanced path for users who intentionally manage the profile configuration themselves. The existing SearXNG path stays first-class and remains explicitly Docker-free.

The README continues to document only shipped commands: `setup`, `status`, `doctor`, and `remove`. It must not mention deferred lifecycle commands or imply they are available.

## Trust and Support Language

Replace the stale `0.2.0` reference with `0.2.1`.

State the validation boundary precisely:

- the CLI, build, tests, and packed artifact are verified on Linux, macOS, and Windows;
- the real managed Docker journey and Docker adapter integration are verified in Linux CI;
- Docker Desktop on macOS and Windows is supported, but those managed paths have not completed formal release certification;
- external SearXNG mode does not require Docker;
- Podman remains unsupported.

Keep the dsh-vet badge and existing safety guarantees. Avoid release history, future roadmap, promotional claims not backed by the repository, or claims that macOS and Windows Docker paths are certified.

## Validation

The documentation update is complete only when:

1. Each of the four plans has exactly one explicit status and the lifecycle plan remains visibly deferred.
2. The README contains no stale `0.2.0` product reference.
3. The primary quickstart does not require a redundant manual plugin installation.
4. Every README command is accepted by the current CLI grammar or is an existing DSH command already used by the shipped documentation.
5. The README does not advertise `repair`, `update`, journal recovery, or cross-platform Docker certification.
6. `git diff --check` passes.
7. `pnpm verify` passes, proving the documentation-only change does not alter the packed release boundary.

## Delivery

Keep the implementation in one documentation commit after this design commit. Review the final diff against the current `main` branch before pushing or opening a pull request.
