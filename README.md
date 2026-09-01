# dsh-searxng

[![dsh-vet](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Frogerdigital%2Fdsh-searxng%2Fdsh-vet%2Freport%2F.dsh-vet%2Fbadge.json)](https://github.com/rogerdigital/dsh-searxng/blob/dsh-vet/report/.dsh-vet/report.json)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin that registers a
[SearXNG](https://docs.searxng.org/)-backed search provider into the web capability seam
(`ctx.web`), giving your agent `web_search` through a **free, self-hosted, key-less** metasearch
instance — instead of the paid Exa/Perplexity APIs.

## Quick start

Requirements: Node.js 20 or newer, `dsh`, Docker Engine or Docker Desktop, and Docker Compose v2.

The setup command installs and attaches `dsh-searxng` to the selected profile, so no separate
plugin-install step is required.

```sh
npx dsh-searxng setup
dsh --profile web
```

`setup` creates a loopback-only, pinned SearXNG Docker deployment, waits for the JSON API, runs a
real search through both SearXNG and the final DSH provider configuration, and only then activates
the profile. Repeating the command reuses the same owned container, port, configuration, and
secret.

Use another DSH profile or port when needed:

```sh
npx dsh-searxng setup --profile research --port 9080
dsh --profile research
```

Package installation and DSH plugin activation never start Docker. Docker is changed only by an
explicit `dsh-searxng setup` or `dsh-searxng remove --service` command.

## Existing SearXNG

An existing local, remote, authenticated, or independently managed SearXNG instance is a
first-class path:

```sh
npx dsh-searxng setup --profile web --url https://search.example.com
```

The endpoint must be HTTP(S), contain no credentials, query, or fragment, and enable JSON search.
Existing provider options such as `authHeader`, `language`, `engines`, and `categories` in the DSH
profile are preserved and used by validation. External mode never invokes Docker.

## Manual plugin installation

If you manage the DSH profile patch yourself and do not want the setup command to attach it,
install only the plugin package:

```sh
dsh plugin add dsh-searxng
```

With a named profile, use `dsh plugin --profile <name> add dsh-searxng`.

## Operations

```sh
# Fast health result; stops at the first failure.
npx dsh-searxng status --profile web

# Ordered environment, Docker, ownership, HTTP, JSON, search, profile, and provider checks.
npx dsh-searxng doctor --profile web

# Detach the profile and remove the plugin package from that profile.
npx dsh-searxng remove --profile web

# Also stop and remove the owned service; keep its data and local state.
npx dsh-searxng remove --profile web --service

# Permanently delete the exact owned data volume and managed directory.
npx dsh-searxng remove --profile web --service --purge-data
```

Permanent deletion prompts on an interactive terminal. Automation must add `--yes`. `--json` is
available on setup, status, doctor, and remove. Destructive Docker operations run only after the
container, network, and volume labels match this DSH home; same-name foreign resources are refused.

## Provider configuration

The setup command manages the `web-search-searxng` row in
`$DSH_HOME/profiles/<name>/cordis.patch.yml`. These optional values can be added to that row:

| Key | Default | Meaning |
|---|---|---|
| `baseURL` | managed or `--url` endpoint | SearXNG base URL. |
| `language` | none | SearXNG language, for example `zh-CN` or `en-US`. |
| `engines` | none | Comma-separated engine allowlist. |
| `categories` | none | Comma-separated category filter. |
| `authHeader` | none | Authorization header for a protected external instance. |

If several DSH search providers are available, select this one with
`DSH_WEB_SEARCH_PROVIDER=searxng` or the corresponding `searchProvider` DSH web configuration.

## Troubleshooting

- `E_DOCKER_MISSING` / `E_DOCKER_OFFLINE`: install or start Docker.
- `E_COMPOSE_UNSUPPORTED`: enable Docker Compose v2.
- `E_JSON_DISABLED`: add `json` to SearXNG `search.formats`.
- `E_AUTH_FAILED`: check the external instance's `authHeader` configuration.
- `E_RATE_LIMITED`: adjust the instance limiter or upstream engine selection.
- `E_RESOURCE_FOREIGN`: a same-name Docker resource does not carry this installation's ownership
  labels; it is never modified automatically.
- `E_PROFILE_CONCURRENT_MODIFICATION`: the DSH profile changed during the operation; review it and
  retry.

`doctor --json` returns the complete redacted check list and actionable error codes.

## Runtime support

- Node.js: 20 and newer.
- CLI, tests, build, and packed artifact: verified on Linux, macOS, and Windows.
- Managed Docker journey and Docker adapter integration: verified in Linux CI with Docker Engine
  and Compose v2.
- Docker Desktop on macOS and Windows is supported but has not completed formal release
  certification.
- External SearXNG mode does not require Docker.
- Podman and Podman Compose are not supported in the managed path.

dsh is in developer preview with breaking changes expected. Version 0.2.1 supports
`@deepseek-ai/dsh-web >=0.1.0-rc.6 <0.2.0` and
`@deepseek-ai/dsh-launch-environment >=0.0.1-rc.3 <0.2.0`.

## Development

```sh
pnpm install
pnpm verify
```

The repository Docker example is development-only. The packaged setup path is the supported
quickstart because it pins the image, generates a private secret, labels every owned resource, and
validates the final provider before activation. The opt-in Linux CI job runs both real Docker
release checks:

```sh
DSH_SEARXNG_E2E=1 pnpm test -- test/e2e/managed-setup.test.ts
DSH_SEARXNG_DOCKER_INTEGRATION=1 pnpm test -- test/cli/docker.integration.test.ts
```

## License

MIT
