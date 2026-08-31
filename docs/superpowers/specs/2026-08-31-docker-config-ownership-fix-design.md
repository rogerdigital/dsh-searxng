# Docker Configuration Ownership Fix Design

**Status:** Approved design

**Date:** 2026-08-31

## Problem

The release-candidate `Managed Docker journey` starts the pinned SearXNG image successfully, but a repeated `dsh-searxng setup` fails with `EACCES` while reading the generated `searxng` configuration directory.

`dsh-searxng` deliberately creates managed directories with mode `0700` and files with mode `0600`. The pinned SearXNG entrypoint defaults `FORCE_OWNERSHIP` to `true` and recursively changes the bind-mounted `/etc/searxng` directory to the container's `searxng:searxng` owner. On Linux this changes the host owner to UID/GID 977 while retaining private permissions, so the host user can no longer traverse the directory during idempotent setup, diagnosis, or removal.

This is a release blocker because the managed path must preserve both host control of generated state and repeatable lifecycle operations.

## Decision

The generated Compose service will explicitly set:

```yaml
environment:
  FORCE_OWNERSHIP: "false"
```

The configuration is already complete before the container starts. Disabling the image's ownership rewrite preserves the host user's ownership and the existing `0700`/`0600` security boundary. The container still receives only the capabilities already required by the pinned image and reads the bind-mounted configuration without making host ownership part of its lifecycle.

The following alternatives are rejected:

- Relaxing generated directories to `0755`: this restores traversal but weakens protection of configuration containing the SearXNG secret.
- Changing ownership back after Docker operations: this requires elevated or platform-specific host privileges, introduces race conditions, and makes cleanup unreliable.
- Accepting UID/GID 977 as the host owner: this prevents ordinary users from managing their own generated deployment state.

## Scope

The fix changes only the packaged Compose asset and its verification coverage. It does not change CLI commands, state schema, resource names, ports, image identity, profile behavior, or external-instance mode.

The manual Linux Docker job will run both real Docker validations:

1. the packed CLI managed lifecycle journey;
2. the lower-level Docker adapter integration test.

Each test continues to use uniquely named labeled resources and bounded cleanup. The job-level `always()` cleanup remains the final defense against leaked containers, networks, and volumes.

## Verification

- Asset tests assert that the rendered Compose model disables SearXNG ownership rewriting.
- The normal `pnpm verify` gate must continue to pass.
- A manually dispatched Ubuntu Docker job must pass the packed managed setup journey, including repeated setup, status, doctor, restart, query, and removal.
- The same job must pass `docker.integration.test.ts`, including render, startup, JSON response, teardown, and ownership absence.
- Job logs must show that the labeled-resource cleanup step ran, including on failure.

## Release Boundary

Do not publish `0.2.0` until both real Docker tests pass on the release commit. No version bump is required for this pre-release correction because `0.2.0` has not been published.
