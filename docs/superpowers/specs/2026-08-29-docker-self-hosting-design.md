# Optional Managed SearXNG Design

**Status:** Approved design

**Date:** 2026-08-29

## Summary

`dsh-searxng` will evolve from a SearXNG API adapter into the private-search onboarding and operational layer for DeepSeek Harness. The product promise is:

> Give DeepSeek Harness users stable, private web search without a search API key, starting from one setup command when Docker is already available.

Docker is the recommended quick-start path, not a mandatory runtime dependency. Users can still connect an existing local or remote SearXNG instance. The plugin owns the complete path from environment checks through a real search test, while leaving answer generation, crawling, multi-provider aggregation, and hosted public search out of scope.

## Product Decision

Three possible directions were considered:

1. Keep the plugin as a bring-your-own-SearXNG adapter. This has a narrow reachable audience and leaves the highest-friction part of activation to the user.
2. Add optional, explicit Docker-managed SearXNG while retaining existing-instance support. This improves activation, keeps the private self-hosted promise, and provides a clear community position.
3. Operate a public hosted search endpoint. This maximizes initial convenience but changes the product into a centralized service with shared availability, abuse, privacy, quota, and cost constraints.

The approved direction is option 2.

## Goals

- Make the default path a single `npx dsh-searxng setup` command for users who already have a supported Docker environment.
- End setup only after a real SearXNG JSON search succeeds and the selected DSH profile is configured.
- Support both a plugin-managed local SearXNG and user-managed existing instances.
- Make setup idempotent and all failures attributable to a specific layer.
- Provide safe lifecycle commands for status, diagnosis, repair, update, and removal.
- Preserve existing DSH profiles and every Docker resource not explicitly owned by `dsh-searxng`.
- Ship every required CLI and deployment asset in the npm package.
- Make the documented quick start match the behavior of the published tarball.

## Non-goals

- A maintainer-operated public SearXNG endpoint.
- Multi-provider search aggregation or automatic fallback to public providers.
- AI answer generation, RAG, knowledge-base indexing, or summarization.
- General-purpose crawling or browser automation.
- A SearXNG administration UI.
- Automatic Docker activity during npm install, plugin install, or DSH startup.
- Managing, upgrading, repairing, or deleting an existing user-owned SearXNG instance.
- Podman support in the first release.

## Supported Environments

The first release officially supports:

- macOS with Docker Desktop;
- Windows with Docker Desktop and WSL2;
- Linux with Docker Engine and Docker Compose v2;
- any supported OS connecting to an existing HTTP or HTTPS SearXNG endpoint.

Colima and Rancher Desktop may work when they expose a compatible Docker CLI and Compose v2 interface, but they are not part of the first-release support claim. Podman is explicitly unsupported until its different runtime semantics receive their own design and certification.

## Architecture

### 1. Search provider

The existing `SearxngSearchProvider` remains a pure runtime adapter. It:

- accepts SearXNG endpoint and search configuration;
- calls the SearXNG JSON search API;
- maps results into the DSH web capability source format;
- applies bounded timeouts and retries only to retryable transport or server failures;
- returns stable, actionable errors for authentication, rate limiting, invalid responses, and unavailable services;
- never starts, stops, repairs, updates, or removes Docker resources.

This separation keeps existing-instance users independent of the managed Docker feature and prevents system-level side effects during DSH startup.

### 2. Explicit management CLI

The npm package exposes a `dsh-searxng` binary used through `npx`:

```sh
npx dsh-searxng setup
npx dsh-searxng status
npx dsh-searxng doctor
npx dsh-searxng repair
npx dsh-searxng update
npx dsh-searxng remove
```

The CLI owns environment detection, managed service lifecycle, endpoint validation, DSH profile integration, health checks, and user-facing diagnostics. No management operation runs implicitly from `postinstall`, plugin activation, or provider construction.

The CLI is divided into focused units:

- **Environment detector:** resolves DSH home and profile, operating system, Docker CLI, Docker daemon, and Compose v2 capabilities.
- **Runtime adapter:** performs typed Docker and Compose operations without embedding product decisions.
- **Ownership registry:** reads labels and local state, and rejects foreign resources.
- **Managed deployment controller:** renders versioned assets and coordinates create, start, repair, update, rollback, and removal.
- **SearXNG client:** performs readiness, JSON API, authentication, and real-query checks for both managed and external endpoints.
- **DSH profile adapter:** parses and atomically updates only the `web-search-searxng` configuration row.
- **Diagnostic engine:** evaluates the same ordered checks for setup, status, doctor, and repair decisions.
- **Presenter:** produces concise human output and redacted structured diagnostic output.

### 3. Managed local service

One managed SearXNG service exists per resolved DSH home. Multiple profiles can attach to that service because language, engine, category, and result-count behavior remains request- or profile-specific.

Managed state is stored under `<resolved DSH home>/dsh-searxng/`. It records:

- schema version;
- deployment version;
- exact validated SearXNG image reference;
- loopback endpoint and port;
- managed resource identifiers;
- attached DSH profiles;
- last known healthy configuration;
- previous deployable version needed for rollback.

The Compose project, containers, networks, and volumes use stable names plus explicit ownership labels. At minimum, labels identify the manager as `dsh-searxng`, the state schema, deployment version, and resolved DSH-home identity. A matching name without valid ownership labels is always foreign.

The managed service:

- listens on `127.0.0.1` only by default;
- enables the SearXNG JSON output format;
- uses a cryptographically random secret generated at first setup;
- uses a tested, recorded image version rather than an unbounded `latest` reference;
- has a restart policy that restores service after Docker restarts;
- preserves its secret, port, and identity across repeated setup and repair operations.

The initial default port is `8080`. If another process owns it, setup stops without modifying that process and tells the user to rerun setup with an explicit free port. Once selected, the port never changes silently.

### 4. Existing-instance mode

`npx dsh-searxng setup --url <endpoint>` validates and attaches an existing instance. The endpoint is recorded as `external`. The CLI can run read-only health and search checks against it, but lifecycle commands never mutate it.

Current provider configuration for language, engines, categories, and authorization remains supported. Credentials are never printed or included in diagnostic reports.

## User Flows

### Default setup

```sh
npx dsh-searxng setup
```

The command:

1. Resolves the target DSH profile, using the default profile unless `--profile` is provided.
2. Checks Node.js, DSH, Docker, the Docker daemon, and Compose v2.
3. Records whether the profile already contains `dsh-searxng`, without changing it.
4. Reads managed state and ownership labels.
5. Reuses a healthy managed service, creates one when absent, or stops with diagnostics when existing managed state is unhealthy or inconsistent.
6. Generates the initial secret and versioned deployment files when creating the service.
7. Starts the service and waits for bounded readiness.
8. Calls the JSON API with a real query.
9. After the query passes, installs `dsh-searxng` through the standard DSH plugin command when needed and atomically applies the endpoint configuration.
10. Runs the provider using the final configuration and executes a final real query.
11. If final validation fails, restores the atomically owned profile patch but retains any plugin package installation as a diagnosed `plugin-residual`; rerunning setup reuses it. Shared profile package state is never auto-removed because atomic ownership cannot be proven across external DSH/package-manager processes.
12. Prints the profile, endpoint, successful test result, and the next `dsh` command.

Running `setup` is explicit authorization for ordinary resource creation and the scoped profile update, so the normal path has no redundant confirmation. Setup stops before changes when it detects foreign resources, an occupied port, invalid existing YAML, or another conflict that cannot be resolved without user choice.

### Existing-instance setup

```sh
npx dsh-searxng setup --url https://search.example.com
```

The command verifies URL validity, connectivity, JSON output, configured authentication, and a real search before changing the profile. A failed validation leaves the profile unchanged.

### Named profiles

```sh
npx dsh-searxng setup --profile work
```

Profiles attach independently to the one managed service. Detaching one profile does not disrupt other attached profiles.

### Idempotency

Repeated setup follows these rules:

- Healthy service and correct profile: report ready without mutation.
- Healthy service and unattached profile: update only that profile and attachment state.
- Healthy managed service but stale profile endpoint: restore the recorded endpoint.
- Old supported state schema or deployment: direct the user into the versioned upgrade path.
- Matching resource name without valid ownership labels: stop and refuse adoption.
- Occupied configured port owned by another process: stop and preserve both states.
- Existing secrets, ports, volumes, and healthy resource identities: preserve them.

## Lifecycle Commands

### `status`

Performs fast, read-only checks and answers whether the selected profile and its endpoint are currently usable. It does not repair or mutate state.

### `doctor`

Runs the complete ordered diagnostic chain. `doctor --json` emits a stable, redacted report suitable for issue reports and automation.

### `repair`

Shows the planned changes, then limits mutation to resources with valid ownership labels and matching state. It may:

- restart the managed container;
- recreate managed containers or networks from recorded configuration while preserving data;
- restore damaged generated deployment files;
- reconnect a stale DSH profile to a healthy managed endpoint;
- remove abandoned temporary resources created by an interrupted managed operation.

It does not install or start Docker Desktop, terminate an unrelated process, modify an external endpoint, bypass authentication or TLS policy, adopt foreign resources, or fall back to a public endpoint.

### `update`

Update is transactional:

1. Require the current deployment to be healthy, otherwise direct the user to diagnosis or repair.
2. Record the current image, generated configuration, and runtime state.
3. Obtain the tested target image and deployment assets.
4. Start the target version using the existing persistent data.
5. Run readiness, JSON API, and real-search checks.
6. Commit the new version to state only after every check passes.
7. On failure, restore the previous image and configuration and verify the restored deployment.

If rollback also fails, report both failures distinctly and retain the evidence needed by `doctor` without claiming the service is healthy.

### `remove`

Removal has three explicit levels:

```sh
npx dsh-searxng remove
npx dsh-searxng remove --service
npx dsh-searxng remove --service --purge-data
```

- The default command detaches only the selected profile and removes its plugin configuration.
- `--service` refuses removal while another profile remains attached, then removes owned containers and networks while retaining persistent data.
- `--service --purge-data` lists the exact owned volumes to delete and requires destructive-action confirmation.

Resource selection always requires both recorded identity and ownership labels. Name patterns alone are insufficient.

## DSH Profile Safety

Profile updates use structured YAML parsing rather than string replacement:

1. Read and parse the current file.
2. Update only the `web-search-searxng` row and preserve unrelated rows and unknown fields.
3. Write a temporary file with appropriate user-only permissions.
4. Parse and validate the temporary file.
5. Atomically replace the target and retain the most recent restorable backup.
6. Run the final provider test.
7. Restore the original profile if the final test fails.

An invalid or unsupported existing profile is reported without rewriting it.

## Diagnostics and Error Model

Checks run in this order:

```text
system environment
-> Docker CLI
-> Docker daemon
-> Compose v2
-> managed state and resource ownership
-> port availability
-> container state
-> SearXNG HTTP readiness
-> JSON search API
-> real search
-> DSH profile configuration
-> final provider search
```

Errors have stable codes, a one-line explanation, relevant redacted context, and one next action. Required categories include:

- Docker missing or offline;
- unsupported Compose;
- port conflict;
- foreign resource conflict;
- container exit or startup timeout;
- JSON output disabled;
- authentication failure;
- rate limiting;
- all search engines failing;
- profile read, parse, or atomic-write failure;
- real-search or final-provider validation failure;
- update and rollback failure.

Persistent logs contain stages, versions, and error summaries only. Authentication headers, generated secrets, sensitive environment values, and search queries are redacted or omitted. No logs, diagnostics, or telemetry are uploaded. A local failure never causes a silent request to a public endpoint.

## Testing Strategy

### Unit tests

Unit tests cover CLI parsing, profile selection, platform and runtime detection, ownership decisions, port classification, URL validation, error mapping, redaction, YAML updates, state migrations, lifecycle decision logic, provider timeout behavior, retry classification, and result normalization.

System calls are behind narrow interfaces so product decisions can be tested without a real Docker daemon.

### Integration tests

Temporary directories, fake command processes, and local HTTP servers cover:

- plugin-not-installed setup;
- reuse of a healthy service;
- external endpoint attachment;
- disabled JSON output;
- authentication failure;
- HTTP 403, 429, 5xx, timeouts, slow readiness, and empty results;
- profiles containing unrelated plugins and unknown fields;
- interrupted profile writes and recovery;
- stable, secret-free `doctor --json` output.

### Docker end-to-end tests

A clean environment verifies the published-package journey:

```text
install tarball
-> npx setup
-> pull and start SearXNG
-> install plugin
-> update profile
-> real search
-> repeated setup
-> status and doctor
-> Docker restart and recovery
-> repair
-> update
-> remove
```

Fault injection covers an occupied port, foreign same-name resources, immediate container exit, partial generated-config damage, target-image health-check failure, rollback, and removal while profiles remain attached.

### Platform certification

Docker-independent CLI tests run across macOS, Windows, and Linux CI. The full Docker journey runs automatically on Linux. Before a release claims official support, the same published tarball is exercised against real Docker Desktop on macOS, Docker Desktop with WSL2 on Windows, and Docker Engine with Compose v2 on Linux.

An environment that has not passed this certification is not listed as officially supported.

### npm artifact verification

The packed npm tarball must contain:

- the executable CLI entry;
- runtime libraries and type declarations;
- versioned Compose and SearXNG templates;
- the DSH bundle patch;
- every file referenced at runtime.

Verification installs the tarball into a clean temporary directory and runs the CLI from that artifact. No test may accidentally rely on repository-only files. Installation itself must not contact Docker or modify DSH state.

## Release Acceptance Criteria

A release implementing this design is ready only when:

- a user with a supported, running Docker environment reaches a successful real search through one setup command without editing files;
- the published npm package, not only the source checkout, passes the complete setup path;
- repeated setup creates no duplicate resources and preserves identity, secret, port, and data;
- an existing instance can be attached with `--url` and is never mutated;
- the managed service returns after a Docker restart;
- common failures identify a specific layer and next action;
- a failed profile update leaves the original profile intact;
- a failed managed update restores and verifies the previous version;
- removal cannot select a resource without both recorded identity and valid ownership labels;
- secrets and search queries do not appear in logs or diagnostic reports;
- macOS, Windows, and Linux complete their required release certification;
- README commands and support claims match the packed artifact exactly.

## Positioning

The external message should describe the user outcome, not Docker mechanics:

> One-command private web search for DeepSeek Harness.

Docker is the default delivery mechanism for users without SearXNG. Existing-instance support remains a first-class path. The product is complete when it reliably establishes, verifies, diagnoses, and preserves private search—not when it accumulates unrelated search-product features.
