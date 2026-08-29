# Managed SearXNG Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic repair, crash recovery, transactional image updates with verified rollback, and release certification on every officially supported platform.

**Architecture:** Extend the core CLI with a durable operation journal and pure repair/update planners. Executors may mutate only state-backed, ownership-verified resources; every update preserves a deployable prior snapshot and commits state only after a real search passes.

**Tech Stack:** TypeScript 5.8+, Node.js 20+ ESM, Vitest fake adapters and fault injection, Docker Compose v2, packed npm artifact certification.

**Prerequisite:** Complete `docs/superpowers/plans/2026-08-29-managed-searxng-core.md` and pass its completion gate.

**Design:** `docs/superpowers/specs/2026-08-29-docker-self-hosting-design.md`

---

## File Map

- `src/cli/journal.ts` — durable operation journal and interrupted-operation classification.
- `src/cli/repair.ts` — pure repair planning plus ownership-checked executor.
- `src/cli/deployments.ts` — packaged deployment catalog and compatibility validation.
- `src/cli/update.ts` — update transaction and rollback.
- `assets/deployments/v1.json` — exact supported image/deployment metadata.
- `scripts/certify-platform.mjs` — packed-artifact certification runner using real DSH and Docker.
- `docs/release-certification.md` — required platform evidence template.

Existing adapters from the core plan remain the only process, Docker, state, probe, profile, and presentation boundaries.

### Task 1: Add a durable operation journal and state migration

**Files:**
- Create: `src/cli/journal.ts`
- Create: `test/cli/journal.test.ts`
- Modify: `src/cli/state.ts`
- Modify: `test/cli/state.test.ts`

- [ ] **Step 1: Write failing journal and migration tests**

Use this journal model:

```ts
export type OperationKind = 'setup' | 'repair' | 'update' | 'remove'
export type OperationPhase = 'prepared' | 'mutating' | 'validating' | 'rolling-back'

export interface OperationJournal {
  schemaVersion: 1
  id: string
  kind: OperationKind
  phase: OperationPhase
  startedAt: string
  updatedAt: string
  beforeStateSha256: string
  target?: { deploymentVersion: number; image: string }
}

export interface JournalStore {
  read(): Promise<OperationJournal | undefined>
  begin(input: Omit<OperationJournal, 'schemaVersion' | 'id' | 'startedAt' | 'updatedAt'>): Promise<OperationJournal>
  transition(id: string, phase: OperationPhase): Promise<OperationJournal>
  clear(id: string): Promise<void>
}
```

Tests assert atomic write/read/clear, invalid journal preservation, phase transitions retaining the same ID, and an interrupted `update` in each phase mapping to an explicit recovery recommendation.

Add a state migration test from core `StateV1` to:

```ts
export interface DeploymentSnapshot {
  deploymentVersion: number
  image: string
  endpoint: string
  port: number
  projectName: string
  containerName: string
  configurationSha256: string
}

export interface StateV2 {
  schemaVersion: 2
  homeId: string
  managed?: {
    current: DeploymentSnapshot
    previous?: DeploymentSnapshot
    lastHealthyAt: string
  }
  profiles: Record<string, { mode: 'managed' | 'external'; endpoint: string }>
}

export interface StateStore {
  read(): Promise<StateV2>
  write(state: StateV2): Promise<void>
  withLock<T>(operation: () => Promise<T>): Promise<T>
}
```

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm test -- test/cli/journal.test.ts test/cli/state.test.ts`

Expected: FAIL because journal and schema-v2 migration are absent.

- [ ] **Step 3: Implement durable transitions**

Reuse the state store's atomic-write primitive. Hash serialized pre-operation state with SHA-256. `begin` must fail when a journal already exists; only `doctor` and `repair` may inspect or clear an interrupted journal. Clear only after successful validation or successful rollback validation.

Migrate v1 in memory and atomically persist v2 only after validation. Unknown future schemas remain untouched and return `E_STATE_INVALID`.

- [ ] **Step 4: Run tests**

Run: `pnpm test -- test/cli/journal.test.ts test/cli/state.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/journal.ts src/cli/state.ts test/cli/journal.test.ts test/cli/state.test.ts
git commit -m "feat: journal managed SearXNG operations"
```

### Task 2: Plan and execute safe repairs

**Files:**
- Create: `src/cli/repair.ts`
- Create: `test/cli/repair.test.ts`
- Modify: `src/cli/args.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli/diagnostics.ts`

- [ ] **Step 1: Write failing pure-planner tests**

Define actions as a closed union:

```ts
export interface DiagnosticSnapshot {
  stateHash: string
  mode: 'managed' | 'external'
  docker: 'healthy' | 'offline'
  ownership: 'owned' | 'absent' | 'foreign'
  container: 'running' | 'stopped' | 'missing'
  generatedAssets: 'valid' | 'missing' | 'invalid'
  port: 'available' | 'owned' | 'foreign'
  endpoint: 'healthy' | 'unreachable' | 'auth-failed' | 'tls-failed'
  profileEndpoint?: { profile: string; expected: string; actual?: string }
  ownedTemporaryResourceIds: string[]
  interruptedOperation?: OperationJournal
}

export type RepairAction =
  | { type: 'restart-container' }
  | { type: 'render-assets'; preserveSecret: true }
  | { type: 'recreate-runtime'; preserveData: true }
  | { type: 'reattach-profile'; profile: string; endpoint: string }
  | { type: 'remove-owned-temporary'; resourceIds: string[] }
```

Test the planner matrix:

- healthy system -> no actions;
- stopped owned container -> restart;
- missing generated settings with healthy state -> render with the same secret identity, then recreate;
- missing network/container with owned persistent volume -> recreate while preserving data;
- stale managed profile endpoint -> reattach profile only;
- foreign container, occupied foreign port, Docker offline, external endpoint failure, TLS failure, or authentication failure -> no actions and one blocking `CliError`;
- interrupted update -> direct to the rollback decision implemented in Task 4, not ordinary repair.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm test -- test/cli/repair.test.ts`

Expected: FAIL because repair does not exist.

- [ ] **Step 3: Implement the planner and executor**

Expose:

```ts
export interface RepairPlan { actions: RepairAction[]; summary: string[] }

export interface RepairDependencies {
  state: StateStore
  journal: JournalStore
  docker: DockerAdapter
  assets: AssetRenderer
  searxng: SearxngProbe
  profiles: ProfileManager
  diagnose(profile: string): Promise<DiagnosticSnapshot>
  now(): Date
}

export function planRepair(snapshot: DiagnosticSnapshot): RepairPlan

export async function executeRepair(
  plan: RepairPlan,
  dependencies: RepairDependencies,
  signal?: AbortSignal,
): Promise<{ actions: RepairAction[]; healthy: true }>
```

Execution rules:

1. Acquire the state lock.
2. Re-run ownership inspection and compare the state hash used by the plan.
3. Print the exact actions before mutation.
4. Begin a `repair` journal and advance to `mutating`.
5. Execute only the closed action union.
6. Advance to `validating` and run HTTP, JSON, real-search, profile, and provider checks.
7. Update `lastHealthyAt`, atomically persist state, and clear the journal.

Any failed validation leaves the journal and reports `E_SEARCH_FAILED`; it must not claim repair success.

- [ ] **Step 4: Wire `repair` and run tests**

Add `repair` to `CliCommand`, default it to profile `web`, and route it in `src/cli.ts`. Human output prints planned actions and final health; JSON output includes action IDs and redacted checks.

Run: `pnpm test -- test/cli/repair.test.ts test/cli/args.test.ts test/cli/diagnostics.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/repair.ts src/cli/args.ts src/cli.ts src/cli/diagnostics.ts test/cli
git commit -m "feat: add ownership-safe SearXNG repair"
```

### Task 3: Ship a versioned deployment catalog

**Files:**
- Create: `src/cli/deployments.ts`
- Create: `assets/deployments/v1.json`
- Create: `test/cli/deployments.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing catalog tests**

The asset has this exact schema:

```json
{
  "schemaVersion": 1,
  "deployments": [
    {
      "deploymentVersion": 1,
      "image": "ghcr.io/searxng/searxng:2026.8.20-8d3dd0cd4@sha256:e7bb47bebf338c52c55c7bed92293873cfe757b554b261829c0d710fd8307fa3",
      "composeAsset": "docker/compose.yml",
      "settingsAsset": "docker/settings.yml.template",
      "stateSchemas": [1, 2]
    }
  ]
}
```

Tests assert unique increasing deployment versions, digest-pinned images, existing packaged asset paths, support for current state schema, exact selection by version, and newest-compatible selection. Invalid or future catalog schemas must fail without attempting Docker.

- [ ] **Step 2: Verify failure**

Run: `pnpm test -- test/cli/deployments.test.ts`

Expected: FAIL because the catalog module and asset do not exist.

- [ ] **Step 3: Implement catalog loading and validation**

Expose immutable types:

```ts
export interface DeploymentDefinition {
  deploymentVersion: number
  image: string
  composeAsset: string
  settingsAsset: string
  stateSchemas: readonly number[]
}

export function loadDeploymentCatalog(assetRoot?: URL): readonly DeploymentDefinition[]
export function selectDeployment(
  catalog: readonly DeploymentDefinition[],
  stateSchema: number,
  requestedVersion?: number,
): DeploymentDefinition
```

Reject tags without `@sha256:<64 hex>`, duplicate versions, path traversal, and missing files. The latest npm package is the update channel: no remote manifest or executable content is fetched by the CLI.

- [ ] **Step 4: Verify package inclusion and tests**

Run: `pnpm test -- test/cli/deployments.test.ts && pnpm build && pnpm pack:check`

Expected: PASS and the tarball contains `assets/deployments/v1.json` plus its referenced files.

- [ ] **Step 5: Commit**

```bash
git add src/cli/deployments.ts assets/deployments package.json test/cli/deployments.test.ts
git commit -m "feat: add versioned SearXNG deployments"
```

### Task 4: Implement transactional update and verified rollback

**Files:**
- Create: `src/cli/update.ts`
- Create: `test/cli/update.test.ts`
- Modify: `src/cli/args.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli/docker.ts`
- Modify: `src/cli/assets.ts`

- [ ] **Step 1: Write failing transaction tests**

Use fake adapters and assert the successful event order:

```ts
expect(events).toEqual([
  'lock', 'diagnose-current', 'ownership', 'journal-prepared', 'pull-target',
  'journal-mutating', 'render-target', 'up-target', 'journal-validating',
  'readiness-target', 'search-target', 'provider-target', 'state-commit',
  'journal-clear', 'unlock',
])
```

Cover each injected failure point: pull, render, Compose up, readiness, real search, provider search, state write, and rollback validation. Assert:

- an unhealthy current deployment refuses ordinary update;
- failure before mutation leaves current files/state untouched;
- failure after mutation restores the previous image/configuration;
- state keeps `current` old until target validation passes;
- successful update moves the old current snapshot to `previous`;
- failed rollback reports target and rollback errors separately and retains the journal;
- no update path mutates an external endpoint.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm test -- test/cli/update.test.ts`

Expected: FAIL because update does not exist.

- [ ] **Step 3: Extend adapters for staged deployment**

Add:

```ts
interface DockerAdapter {
  pull(image: string, signal?: AbortSignal): Promise<void>
  imageExists(image: string, signal?: AbortSignal): Promise<boolean>
}

export interface StagedAssets {
  directory: string
  configurationSha256: string
  definition: DeploymentDefinition
}

interface AssetRenderer {
  stage(definition: DeploymentDefinition, state: StateV2): Promise<StagedAssets>
  activate(staged: StagedAssets): Promise<void>
  restore(snapshot: DeploymentSnapshot): Promise<void>
}
```

Staging writes to a sibling temporary directory, validates YAML and `.env`, computes `configurationSha256`, then atomically swaps generated files. Never edit the active `.env` in place.

- [ ] **Step 4: Implement update and rollback**

Expose:

```ts
export interface UpdateDependencies {
  state: StateStore
  journal: JournalStore
  docker: DockerAdapter
  assets: AssetRenderer
  searxng: SearxngProbe
  profiles: ProfileManager
  catalog: readonly DeploymentDefinition[]
  diagnose(profile: string): Promise<DiagnosticSnapshot>
  now(): Date
}

export async function updateManagedService(
  input: { profile: string; deploymentVersion?: number },
  dependencies: UpdateDependencies,
  signal?: AbortSignal,
): Promise<{ from: number; to: number; rolledBack: false }>
```

Require current end-to-end health before beginning. Journal each phase, validate ownership again immediately before Compose mutation, and use the same readiness/real/provider checks as setup. On any post-mutation failure, set `rolling-back`, restore the old generated files, run Compose with the previous digest, and validate it. Clear the journal only after successful target validation or successful rollback validation.

When rollback succeeds, throw an operational error explaining that the update failed but service health was restored. When rollback fails, return a distinct error carrying both redacted causes and an action to run `doctor --json`.

- [ ] **Step 5: Wire `update` and run tests**

Add `update`, optional `--deployment-version`, and profile default `web` to CLI args. Route human and JSON results in `src/cli.ts`.

Run: `pnpm test -- test/cli/update.test.ts test/cli/args.test.ts test/cli/docker.test.ts test/cli/assets.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/update.ts src/cli/args.ts src/cli.ts src/cli/docker.ts src/cli/assets.ts test/cli
git commit -m "feat: add transactional SearXNG updates"
```

### Task 5: Recover interrupted operations through doctor and repair

**Files:**
- Modify: `src/cli/diagnostics.ts`
- Modify: `src/cli/repair.ts`
- Modify: `src/cli/update.ts`
- Create: `test/cli/recovery.test.ts`

- [ ] **Step 1: Write failing crash-recovery tests**

Materialize a real state directory and journal for every update phase. Assert:

- `prepared` with untouched active files can be safely cleared by repair;
- `mutating` selects rollback to the state hash recorded in the journal;
- `validating` probes the target and either commits it when every check passes or rolls back;
- `rolling-back` resumes rollback and validates the previous snapshot;
- a state hash mismatch blocks automatic action;
- a stale lock whose PID is not alive is reported and can be removed only by repair after journal inspection;
- a live lock is never removed.

Repeat representative tests with process termination injected after each journal transition, then invoke a fresh CLI dependency graph to prove recovery does not rely on memory.

- [ ] **Step 2: Verify failure**

Run: `pnpm test -- test/cli/recovery.test.ts`

Expected: FAIL because interrupted-operation recovery is absent.

- [ ] **Step 3: Implement recovery classification and execution**

Add:

```ts
export type RecoveryDecision =
  | { type: 'clear-prepared' }
  | { type: 'validate-target'; target: DeploymentSnapshot }
  | { type: 'resume-rollback'; previous: DeploymentSnapshot }
  | { type: 'blocked'; error: CliError }
```

`doctor` reports journal ID, kind, phase, and age without secrets. `repair` computes a recovery decision from on-disk state, configuration hashes, image existence, and ownership. It never trusts only the journal. Successful recovery updates state and clears both journal and stale lock; failed recovery leaves evidence intact.

- [ ] **Step 4: Run the recovery and regression suites**

Run: `pnpm test -- test/cli/recovery.test.ts test/cli/repair.test.ts test/cli/update.test.ts test/cli/diagnostics.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/diagnostics.ts src/cli/repair.ts src/cli/update.ts test/cli/recovery.test.ts
git commit -m "feat: recover interrupted SearXNG operations"
```

### Task 6: Certify the packed artifact on supported platforms

**Files:**
- Create: `scripts/certify-platform.mjs`
- Create: `docs/release-certification.md`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `test/e2e/managed-setup.test.ts`

- [ ] **Step 1: Write the certification runner contract test**

Test the runner's preflight and cleanup through injected subprocess functions. It must refuse to start unless `dsh`, Docker, Compose v2, Node, and the packed tarball are present. It must allocate an isolated temporary `DSH_HOME`, use profile `web`, record versions, and clean only resources carrying its generated home ID.

Expected report schema:

```json
{
  "schemaVersion": 1,
  "platform": "darwin-arm64",
  "node": "v22.x",
  "docker": "x.y.z",
  "compose": "v2.x.y",
  "packageVersion": "0.x.y",
  "checks": {
    "setup": "pass",
    "repeatSetup": "pass",
    "status": "pass",
    "doctor": "pass",
    "dockerRestart": "pass",
    "repair": "pass",
    "updateRollback": "pass",
    "remove": "pass"
  }
}
```

The implementation must write real versions instead of the illustrative values above.

- [ ] **Step 2: Implement the cross-platform certification script**

The Node script:

1. Locates the tarball explicitly passed through `--tarball`.
2. Creates a temporary npm project and isolated `DSH_HOME`.
3. Installs the tarball without lifecycle Docker activity.
4. Runs setup, repeated setup, status, and doctor.
5. Captures the owned container ID, restarts it, and waits for search recovery.
6. Injects one repairable generated-config failure and verifies repair.
7. Runs an update fault that forces and verifies rollback.
8. Detaches the profile, removes service, purges data with `--yes`, and verifies no matching resources remain.
9. Emits the JSON report only after cleanup; on failure, emits redacted diagnostics and still attempts ownership-checked cleanup.

Use argument arrays, not shell strings, on every platform.

- [ ] **Step 3: Add release commands and CI coverage**

Add:

```json
{
  "scripts": {
    "certify:platform": "node scripts/certify-platform.mjs",
    "test:e2e": "vitest run test/e2e/managed-setup.test.ts"
  }
}
```

Linux Docker e2e stays automated in CI. Docker-independent tests and packed CLI checks run on Linux, macOS, and Windows. Do not claim automated Docker Desktop coverage where the runner does not provide Docker Desktop.

- [ ] **Step 4: Add the release evidence template**

`docs/release-certification.md` requires one report from:

- macOS + Docker Desktop;
- Windows + Docker Desktop + WSL2;
- Linux + Docker Engine + Compose v2.

It records tarball SHA-256, package version, date, architecture, Docker versions, report path, and pass/fail. A release may claim only environments with a complete passing report from the same tarball hash.

- [ ] **Step 5: Run full verification and one available platform certification**

Run: `pnpm verify`

Expected: PASS.

Run: `pnpm pack --pack-destination ./node_modules/.cache/pack`

Expected: one tarball for the current package version.

Run on each certification host: `pnpm certify:platform -- --tarball <absolute-tarball-path>`

Expected: exit 0, every report check is `pass`, and no certification-owned container, network, volume, or temporary DSH home remains.

- [ ] **Step 6: Update public documentation and commit**

README must distinguish officially certified Docker environments from compatible-but-uncertified runtimes, state that Podman is unsupported, document repair/update recovery semantics, and retain the external URL path.

```bash
git add scripts/certify-platform.mjs docs/release-certification.md package.json .github/workflows/ci.yml README.md test/e2e/managed-setup.test.ts
git commit -m "test: certify managed SearXNG lifecycle"
```

## Lifecycle Plan Completion Gate

Before preparing a release, prove all of the following from the same packed tarball:

- repair executes only a closed, displayed action plan against ownership-verified resources;
- a crash after every update phase is recoverable from disk alone;
- an update never becomes current until readiness, real search, and provider validation pass;
- every post-mutation failure either verifies rollback or reports target and rollback failures distinctly;
- external endpoints remain read-only through doctor, repair, update, and remove;
- macOS, Windows, and Linux certification reports share the same tarball hash;
- published README support claims match those reports exactly;
- `pnpm verify` and Linux Docker e2e pass with a clean worktree.
