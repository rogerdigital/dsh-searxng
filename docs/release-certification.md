# Release certification

A release of `dsh-searxng` may claim a Docker environment as **certified**
only with a complete, passing certification report produced from the exact
tarball being published. This file is the evidence log: one row per required
environment per release, filled in by the human who ran the certification on
that host.

## Required environments

| Environment | Runtime | Required for |
|---|---|---|
| macOS + Docker Desktop | Docker Desktop with Compose v2 | macOS claims |
| Windows + Docker Desktop + WSL2 | Docker Desktop with WSL2 backend and Compose v2 | Windows claims |
| Linux + Docker Engine | Docker Engine with Compose v2 | Linux claims |

All three reports for one release must record the **same tarball SHA-256**.
Environments without a report stay "compatible but uncertified" in the README
and must not be advertised as certified.

## Running the certification

On each certification host (Node.js 20+, `dsh` on PATH, Docker running):

```sh
pnpm pack --pack-destination ./node_modules/.cache/pack
sha256sum ./node_modules/.cache/pack/dsh-searxng-<version>.tgz
pnpm certify:platform -- --tarball "$PWD/node_modules/.cache/pack/dsh-searxng-<version>.tgz" > <environment>-report.json
echo "exit: $?"
```

The runner refuses to start unless `dsh`, Docker, Compose v2, Node, and the
tarball are present. It installs the tarball into a throwaway npm project with
an isolated temporary `DSH_HOME`, never modifies the real package or any user
home, prints progress to stderr, emits the JSON report to stdout only after
cleanup, and exits 0 only when every check and the cleanup passed.

Accept a report only when:

- the exit code is 0;
- every check is `pass` and `checks.cleanup` is `pass`;
- no certification-owned container, network, volume, or temporary directory
  remains on the host afterwards;
- the recorded `tarballSha256` equals the hash of the tarball being published.

## Report schema

`schemaVersion` 1:

| Field | Meaning |
|---|---|
| `platform` | `<process.platform>-<process.arch>`, for example `darwin-arm64` |
| `node`, `docker`, `compose` | Versions observed by the run (the same probes the CLI's own preflight uses) |
| `packageVersion` | Version of the installed packed package |
| `tarball`, `tarballSha256` | Certified tarball path and hash |
| `profile` | Always `web` |
| `startedAt`, `durationMs` | When and how long the journey ran |
| `checks.setup` … `checks.remove` | The eight lifecycle checks: setup, repeatSetup, status, doctor, dockerRestart, repair, updateRollback, remove |
| `checks.cleanup` | Additive verdict of the ownership-checked cleanup sweep |
| `notes` | What the runner injected (see below) |
| `diagnostics` | Present only on failure: redacted command, exit code, and output |

Two faults are injected deliberately, and `notes` documents them:

- **repair**: the generated configuration bundle's `.env` is deleted while
  `settings.yml` stays intact, so repair must take the secret-preserving
  render-assets rebuild path.
- **updateRollback**: a synthetic next deployment version (same digest-pinned
  image, settings template with the `json` search format removed) is injected
  into the runner's own temporary installed copy, so `update` runs a real
  transaction whose target validation fails and must roll back to the previous
  deployment and revalidate it.

## Evidence log

Copy the block below once per release and fill every field. `Report path` is
where the full JSON report is archived (for example, attached to the release).

### v0.0.0 (template)

| Field | macOS + Docker Desktop | Windows + Docker Desktop + WSL2 | Linux + Docker Engine |
|---|---|---|---|
| Tarball SHA-256 | `<64 hex>` | `<same 64 hex>` | `<same 64 hex>` |
| Package version | | | |
| Date (UTC) | | | |
| Architecture | | | |
| Docker version | | | |
| Compose version | | | |
| Report path | | | |
| Result (pass/fail) | | | |

A release may claim only the environments whose row above shows `pass` with a
complete report from the same tarball hash.
