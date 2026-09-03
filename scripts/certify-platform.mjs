/**
 * NOTE: no shebang on purpose — vitest's SSR transform hoists imports above a
 * hashbang (vitejs/vite#23034); this module is imported by the contract test and
 * executed via `node scripts/certify-platform.mjs`.
 *
 * Platform certification runner for the packed dsh-searxng artifact.
 *
 * Installs an explicitly passed tarball into a throwaway npm project with an
 * isolated temporary DSH_HOME, then walks the full managed lifecycle against
 * real Docker: setup, repeated setup (reuse), status, doctor, an external
 * container restart with search recovery, a repair of an injected
 * generated-config failure, a real update transaction whose target validation
 * fails and must roll back, and a final remove --service --purge-data.
 *
 * The JSON report is emitted to stdout only after cleanup has completed. On
 * any failure the report carries redacted diagnostics and cleanup is still
 * attempted. Cleanup only ever removes Docker resources whose inspect output
 * carries this run's ownership labels (io.dsh-searxng.managed=true and this
 * DSH_HOME's io.dsh-searxng.home-id); same-name or same-label-prefix foreign
 * resources are never touched.
 *
 * The update check needs a second deployment version to move to, which the
 * shipped single-entry catalog cannot provide. The runner therefore injects a
 * synthetic next-version entry — same digest-pinned image, same compose asset,
 * a settings template with the json search format removed — into its OWN
 * temporary installed copy only. `update --deployment-version <n>` then runs a
 * real transaction: staging, activation, failed validation (SearXNG answers
 * 403 for format=json), and a verified rollback to the previous deployment.
 * Neither the real package nor any user home is ever modified.
 *
 * Every subprocess is spawned with argument arrays, never shell strings. The
 * only Windows shell fallback is a bounded retry for .cmd shims (see
 * `execArgv`); docker.exe, node.exe, and the CLI module run shell-free.
 *
 * The module exports its testable core (argument parsing, preflight, and the
 * journey orchestration with injected spawner and filesystem) for the
 * contract test in test/scripts/certify-platform.test.ts; running
 * `node scripts/certify-platform.mjs --tarball <path>` executes the real thing.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Ordered lifecycle checks; the report's `checks` object always lists all of them. */
export const CERTIFY_CHECKS = Object.freeze([
  'setup', 'repeatSetup', 'status', 'doctor', 'dockerRestart', 'repair', 'updateRollback', 'remove',
])

/** Mirrors package.json engines.node; the runner itself refuses older majors. */
export const MINIMUM_NODE_MAJOR = 20

export const REPORT_SCHEMA_VERSION = 1

export const MANAGED_LABEL = 'io.dsh-searxng.managed'
export const HOME_ID_LABEL = 'io.dsh-searxng.home-id'

const DIGEST_PINNED_IMAGE = /^[^\s@]+@sha256:[a-f0-9]{64}$/
const JSON_LIST_ITEM = /^[ \t]*-[ \t]*json[ \t]*(?:\r?\n|$)/m
const JSON_LIST_ITEM_GLOBAL = /^[ \t]*-[ \t]*json[ \t]*(?:\r?\n|$)/gm
const DIAGNOSTIC_LIMIT = 4000
const DEFAULT_DOCTOR_RECOVERY_MS = 240_000
const DOCTOR_POLL_INTERVAL_MS = 3_000

const TIMEOUTS = Object.freeze({
  install: 300_000,
  setup: 600_000,
  status: 90_000,
  doctor: 120_000,
  repair: 600_000,
  update: 600_000,
  remove: 180_000,
  docker: 60_000,
})

/**
 * Refusal or runner failure with a CLI-style code. Preflight refusals carry an
 * actionable `action`; the exit code mirrors the CLI's usage convention.
 */
export class CertificationError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} action
   * @param {number} exitCode
   */
  constructor(code, message, action, exitCode = 1) {
    super(message)
    this.name = 'CertificationError'
    this.code = code
    this.action = action
    this.exitCode = exitCode
  }
}

function usage(message) {
  return new CertificationError('E_USAGE', message, 'Run with: node scripts/certify-platform.mjs --tarball <packed-tarball>', 2)
}

/**
 * Parse the runner's argument vector. Exactly one `--tarball <path>` (or
 * `--tarball=<path>`) is required; anything else is a usage error.
 *
 * @param {readonly string[]} argv
 * @returns {{ tarball: string }}
 */
export function parseCertifyArgs(argv) {
  if (!Array.isArray(argv)) throw usage('Arguments must be an array')
  let tarball
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--tarball') {
      if (tarball !== undefined) throw usage('--tarball may be passed only once')
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw usage('--tarball requires a path')
      tarball = value
      index += 1
    } else if (argument.startsWith('--tarball=')) {
      if (tarball !== undefined) throw usage('--tarball may be passed only once')
      const value = argument.slice('--tarball='.length)
      if (value.length === 0) throw usage('--tarball requires a path')
      tarball = value
    } else {
      throw usage(`Unsupported argument: ${argument}`)
    }
  }
  if (tarball === undefined) throw usage('--tarball is required')
  return { tarball }
}

/**
 * The CLI's ownership identity for a DSH_HOME: first 16 hex of the sha256 of
 * the normalized absolute path (src/cli/environment.ts homeId). Duplicated
 * here because the runner ships as a standalone script, and asserted equal in
 * the contract test so the two can never drift silently.
 *
 * @param {string} dshHome
 * @returns {string}
 */
export function certifyHomeId(dshHome) {
  return createHash('sha256').update(normalize(resolve(dshHome))).digest('hex').slice(0, 16)
}

/** @returns {string} process.platform-process.arch, e.g. darwin-arm64 */
export function certificationPlatform() {
  return `${process.platform}-${process.arch}`
}

/**
 * Preflight: refuse to start unless dsh, Docker, Compose v2, Node, and the
 * packed tarball are all present. Records the exact versions the CLI's own
 * preflight observes (`docker version --format`, `docker compose version
 * --short`), so the report certifies against the same daemon the CLI uses.
 *
 * @param {object} input
 * @param {string} input.tarball
 * @param {import('./certify-platform.d.mts').CertifySpawner} input.spawner
 * @param {(path: string) => Promise<boolean>} [input.pathExists]
 * @param {(path: string) => Promise<string>} [input.sha256File]
 * @param {string} [input.nodeVersion] defaults to process.version
 * @param {string} [input.platform] defaults to certificationPlatform()
 * @returns {Promise<import('./certify-platform.d.mts').PreflightResult>}
 */
export async function preflightCertification(input) {
  const spawner = input.spawner
  if (typeof spawner !== 'function') throw new CertificationError('E_INTERNAL', 'A subprocess spawner is required', 'Provide the spawner dependency')
  const nodeVersion = input.nodeVersion ?? process.version
  const platform = input.platform ?? certificationPlatform()
  const pathExists = input.pathExists ?? realPathExists
  const sha256File = input.sha256File ?? realSha256File

  const major = /^v(\d+)\./.exec(nodeVersion)?.[1]
  if (major === undefined || Number(major) < MINIMUM_NODE_MAJOR) {
    throw new CertificationError(
      'E_NODE_UNSUPPORTED',
      `Node ${nodeVersion} is below the supported major ${MINIMUM_NODE_MAJOR}`,
      'Run the certification with Node.js 20 or newer',
    )
  }

  const tarball = isAbsolute(input.tarball) ? input.tarball : resolve(input.tarball)
  if (!(await pathExists(tarball))) {
    throw new CertificationError('E_TARBALL_MISSING', `Packed tarball not found: ${tarball}`, 'Run pnpm pack and pass the tarball with --tarball')
  }
  let tarballSha256
  try {
    tarballSha256 = await sha256File(tarball)
  } catch {
    throw new CertificationError('E_TARBALL_MISSING', `Packed tarball is unreadable: ${tarball}`, 'Re-run pnpm pack and pass the fresh tarball with --tarball')
  }
  const packageVersion = /dsh-searxng-(.+)\.tgz$/.exec(tarball)?.[1] ?? null

  const dsh = await spawner('dsh', ['--version'])
  if (dsh.spawnFailed || dsh.code !== 0) {
    throw new CertificationError('E_DSH_MISSING', 'The dsh executable is unavailable', 'Install dsh and ensure it is on PATH')
  }

  const docker = await spawner('docker', ['version', '--format', '{{.Server.Version}}'])
  if (docker.spawnFailed) {
    throw new CertificationError('E_DOCKER_MISSING', 'The Docker executable is unavailable', 'Install Docker and ensure it is on PATH')
  }
  const dockerVersion = docker.stdout.trim()
  if (docker.code !== 0 || dockerVersion.length === 0) {
    throw new CertificationError('E_DOCKER_OFFLINE', 'The Docker daemon is unavailable', 'Start Docker Desktop or the Docker daemon, then retry')
  }

  const compose = await spawner('docker', ['compose', 'version', '--short'])
  const composeVersion = compose.stdout.trim()
  const composeMajor = /^v?(\d+)/.exec(composeVersion)?.[1]
  if (compose.spawnFailed || compose.code !== 0 || composeMajor === undefined || Number(composeMajor) < 2) {
    throw new CertificationError('E_COMPOSE_UNSUPPORTED', 'Docker Compose v2 is unavailable', 'Install or enable Docker Compose v2')
  }

  return { platform, node: nodeVersion, docker: dockerVersion, compose: composeVersion, packageVersion, tarball, tarballSha256 }
}

/** Internal step failure carrying the offending command and its raw output for redacted diagnostics. */
function stepFailure(message, detail = {}) {
  const error = new Error(message)
  error.name = 'StepFailure'
  error.command = detail.command
  error.result = detail.result
  return error
}

function assert(condition, message, detail = {}) {
  if (!condition) throw stepFailure(message, detail)
}

/**
 * @param {string} text
 * @returns {string}
 */
export function redactText(text) {
  const redacted = String(text ?? '').replace(
    /(^|[\r\n])([^\r\n=:]*?(?:secret|token|password)[^\r\n=:]*[:=][ \t]*)(\S+)/gi,
    '$1$2[REDACTED]',
  )
  return redacted.length > DIAGNOSTIC_LIMIT ? `${redacted.slice(0, DIAGNOSTIC_LIMIT)}\n[truncated]` : redacted
}

function describeFailure(error) {
  const failure = { message: error instanceof Error ? error.message : String(error) }
  if (error?.command !== undefined) failure.command = error.command
  if (error?.result !== undefined) {
    failure.exitCode = error.result.code
    failure.stdout = redactText(error.result.stdout)
    failure.stderr = redactText(error.result.stderr)
  }
  return failure
}

function parseJson(text, what, detail = {}) {
  try {
    return JSON.parse(text)
  } catch {
    throw stepFailure(`${what} did not return valid JSON`, detail)
  }
}

/**
 * The certification journey. `checks` records pass/fail per lifecycle stage
 * and 'skip' for stages a prior failure made unreachable, plus the additive
 * `cleanup` verdict from the always-attempted ownership-checked sweep.
 *
 * @param {object} input
 * @param {import('./certify-platform.d.mts').PreflightResult} input.preflight
 * @param {import('./certify-platform.d.mts').CertifySpawner} input.spawner
 * @param {import('./certify-platform.d.mts').CertifyFileSystem} input.fileSystem
 * @param {(prefix: string) => Promise<string>} input.makeTempDir
 * @param {() => { file: string; args: string[] }} [input.resolveNpm]
 * @param {string} [input.node] defaults to process.execPath
 * @param {Record<string, string | undefined>} [input.baseEnv] defaults to process.env
 * @param {string} [input.profile] defaults to 'web'
 * @param {(line: string) => void} [input.log]
 * @param {(ms: number) => Promise<void>} [input.sleep]
 * @param {() => number} [input.now] Date.now semantics
 * @returns {Promise<{ report: import('./certify-platform.d.mts').CertificationReport; exitCode: number }>}
 */
export async function runCertification(input) {
  const preflight = input.preflight
  const spawner = input.spawner
  const fileSystem = input.fileSystem
  const makeTempDir = input.makeTempDir
  if (spawner === undefined || fileSystem === undefined || makeTempDir === undefined) {
    throw new CertificationError('E_INTERNAL', 'spawner, fileSystem, and makeTempDir are required', 'Provide the runner dependencies')
  }
  const profile = input.profile ?? 'web'
  const log = input.log ?? (() => {})
  const sleep = input.sleep ?? ((ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)))
  const now = input.now ?? Date.now
  const node = input.node ?? process.execPath
  const startedAt = now()

  const checks = Object.fromEntries(CERTIFY_CHECKS.map((name) => [name, 'skip']))
  let diagnostics
  let cleanup = 'pass'
  /** Why cleanup failed, recorded even when a step failure already set diagnostics. */
  const cleanupProblems = []
  let packageVersion = preflight.packageVersion ?? 'unknown'
  let injectedVersion

  const tempRoot = await makeTempDir(join(tmpdir(), 'dsh-searxng-cert-'))
  const dshHome = join(tempRoot, 'dsh-home')
  const installRoot = join(tempRoot, 'install')
  const npmCache = join(tempRoot, 'npm-cache')
  const homeId = certifyHomeId(dshHome)
  const managedDir = join(dshHome, 'dsh-searxng')
  const cliEnv = { ...(input.baseEnv ?? process.env), DSH_HOME: dshHome }

  /** @param {readonly string[]} args @param {{ timeoutMs?: number }} [options] */
  const runCli = async (args, options = {}) =>
    spawner(node, [cliModule(), ...args], { env: cliEnv, cwd: installRoot, timeoutMs: options.timeoutMs })
  const docker = (args) => spawner('docker', [...args], { timeoutMs: TIMEOUTS.docker })

  let cliInstalled = false
  let setupAttempted = false

  function cliModule() {
    return join(installRoot, 'node_modules', 'dsh-searxng', 'lib', 'cli.mjs')
  }

  function packageRoot() {
    return join(installRoot, 'node_modules', 'dsh-searxng')
  }

  async function readState() {
    return parseJson(
      await fileSystem.readFile(join(managedDir, 'state.json')),
      'The managed state file',
    )
  }

  async function currentDeployment() {
    const state = await readState()
    const current = state?.managed?.current
    assert(current !== undefined && typeof current === 'object', 'Managed deployment state is missing')
    assert(typeof current.containerName === 'string' && current.containerName.length > 0, 'Managed container name is missing from state')
    return current
  }

  async function containerIdFor(containerName) {
    const result = await docker(['container', 'inspect', '--format', '{{.Id}}', containerName])
    const id = result.stdout.trim()
    assert(result.code === 0 && id.length > 0, `Could not inspect the owned container ${containerName}`, { command: ['docker', 'container', 'inspect', '--format', '{{.Id}}', containerName], result })
    return id
  }

  async function requireDoctorHealthy(what, timeoutMs = TIMEOUTS.doctor) {
    const result = await runCli(['doctor', '--profile', profile, '--json'], { timeoutMs })
    const report = result.code === 0 ? parseJson(result.stdout, 'doctor', { command: doctorCommand(), result }) : undefined
    assert(result.code === 0 && report?.healthy === true, `${what}: doctor is not healthy`, { command: doctorCommand(), result })
    assert(report.interruptedOperation === undefined, `${what}: doctor reports an interrupted operation`, { command: doctorCommand(), result })
    return report
  }

  function doctorCommand() {
    return [node, cliModule(), 'doctor', '--profile', profile, '--json']
  }

  // ---- lifecycle steps -------------------------------------------------

  async function installTarball() {
    const npm = (input.resolveNpm ?? defaultNpmInvocation)()
    const command = [npm.file, ...npm.args, 'install', '--prefix', installRoot, '--cache', npmCache, '--ignore-scripts', '--no-audit', '--no-fund', preflight.tarball]
    log('Installing the packed tarball into a temporary npm project')
    const result = await spawner(npm.file, [...npm.args, 'install', '--prefix', installRoot, '--cache', npmCache, '--ignore-scripts', '--no-audit', '--no-fund', preflight.tarball], { cwd: tempRoot, timeoutMs: TIMEOUTS.install })
    if (result.spawnFailed || result.code !== 0) throw stepFailure('The packed tarball could not be installed', { command, result })
    const manifest = parseJson(await fileSystem.readFile(join(packageRoot(), 'package.json')), 'The installed package manifest')
    assert(typeof manifest?.version === 'string' && manifest.version.length > 0, 'The installed package manifest has no version')
    packageVersion = manifest.version
    cliInstalled = true
  }

  async function stepSetup() {
    setupAttempted = true
    const command = [node, cliModule(), 'setup', '--profile', profile, '--json']
    const result = await runCli(['setup', '--profile', profile, '--json'], { timeoutMs: TIMEOUTS.setup })
    const report = result.code === 0 ? parseJson(result.stdout, 'setup', { command, result }) : undefined
    assert(result.code === 0 && report?.profile === profile, `setup did not complete for profile ${profile}`, { command, result })
    assert(report.reused === false, 'the first setup reported reuse instead of creation', { command, result })
    assert(typeof report.endpoint === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(report.endpoint), 'setup did not report a loopback managed endpoint', { command, result })
    const current = await currentDeployment()
    assert(Number.isSafeInteger(current.deploymentVersion) && current.deploymentVersion >= 1, 'state records no deployment version')
    assert(typeof current.image === 'string' && DIGEST_PINNED_IMAGE.test(current.image), 'state records a non digest-pinned image')
    const digest = current.configurationSha256
    assert(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest), 'state records no configuration digest')
    assert(await fileSystem.pathExists(join(managedDir, `config-${digest}`, '.env')), 'the generated configuration bundle has no .env')
    await containerIdFor(current.containerName)
  }

  async function stepRepeatSetup() {
    const before = await currentDeployment()
    const firstId = await containerIdFor(before.containerName)
    const command = [node, cliModule(), 'setup', '--profile', profile, '--json']
    const result = await runCli(['setup', '--profile', profile, '--json'], { timeoutMs: TIMEOUTS.setup })
    const report = result.code === 0 ? parseJson(result.stdout, 'setup', { command, result }) : undefined
    assert(result.code === 0 && report?.reused === true, 'repeated setup did not reuse the existing deployment', { command, result })
    const after = await currentDeployment()
    assert(after.configurationSha256 === before.configurationSha256, 'repeated setup rendered a different configuration bundle', { command, result })
    assert(await containerIdFor(after.containerName) === firstId, 'repeated setup replaced the owned container', { command, result })
  }

  async function stepStatus() {
    const command = [node, cliModule(), 'status', '--profile', profile, '--json']
    const result = await runCli(['status', '--profile', profile, '--json'], { timeoutMs: TIMEOUTS.status })
    const report = result.code === 0 ? parseJson(result.stdout, 'status', { command, result }) : undefined
    assert(result.code === 0 && report?.healthy === true, 'status is not healthy', { command, result })
  }

  async function stepDoctor() {
    await requireDoctorHealthy('doctor')
  }

  async function stepDockerRestart() {
    const current = await currentDeployment()
    const containerId = await containerIdFor(current.containerName)
    log(`Restarting the owned container ${containerId} and waiting for search recovery`)
    const restart = await docker(['restart', containerId])
    assert(restart.code === 0, 'docker restart of the owned container failed', { command: ['docker', 'restart', containerId], result: restart })
    const deadline = now() + DEFAULT_DOCTOR_RECOVERY_MS
    let recovered = false
    let last
    while (!recovered) {
      last = await runCli(['doctor', '--profile', profile, '--json'], { timeoutMs: TIMEOUTS.doctor })
      if (last.code === 0) {
        try {
          recovered = JSON.parse(last.stdout)?.healthy === true
        } catch {
          recovered = false
        }
      }
      if (!recovered && now() >= deadline) break
      if (!recovered) await sleep(DOCTOR_POLL_INTERVAL_MS)
    }
    assert(recovered, 'the managed deployment did not recover search after the container restart', { command: doctorCommand(), result: last })
  }

  async function stepRepair() {
    const current = await currentDeployment()
    const digest = current.configurationSha256
    assert(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest), 'state records no configuration digest')
    const bundleEnv = join(managedDir, `config-${digest}`, '.env')
    assert(await fileSystem.pathExists(bundleEnv), 'the generated configuration bundle has no .env to injure')
    // One repairable generated-config failure: the bundle .env is deleted
    // while settings.yml stays intact, so the secret stays recoverable and
    // repair must take the render-assets rebuild path.
    log('Injecting a repairable failure: deleting the generated bundle .env')
    await fileSystem.removeFile(bundleEnv)
    const command = [node, cliModule(), 'repair', '--profile', profile, '--json']
    const result = await runCli(['repair', '--profile', profile, '--json'], { timeoutMs: TIMEOUTS.repair })
    const report = result.code === 0 ? parseJson(result.stdout, 'repair', { command, result }) : undefined
    assert(result.code === 0 && report?.healthy === true, 'repair did not restore health', { command, result })
    assert(
      Array.isArray(report.actions) && report.actions.some((action) => action?.type === 'render-assets'),
      'repair did not plan the render-assets rebuild for the injured bundle',
      { command, result },
    )
    assert(await fileSystem.pathExists(bundleEnv), 'repair did not rebuild the deleted bundle .env')
    const after = await currentDeployment()
    assert(after.configurationSha256 === digest, 'repair changed the configuration digest instead of rebuilding it', { command, result })
    await requireDoctorHealthy('repair')
  }

  async function stepUpdateRollback() {
    const current = await currentDeployment()
    const targetVersion = Number(current.deploymentVersion) + 1
    const image = current.image
    assert(DIGEST_PINNED_IMAGE.test(image), 'cannot inject a synthetic deployment without a digest-pinned image')

    // The injection below touches only this run's temporary installed copy.
    // The synthetic entry copies the state schemas of the catalog entry the
    // current deployment runs on, so a future schema bump does not dead-end
    // the runner with a misleading unsupported-schema failure.
    const catalogPath = join(packageRoot(), 'assets', 'deployments', 'v1.json')
    const catalog = parseJson(await fileSystem.readFile(catalogPath), 'The installed deployment catalog')
    const deployments = catalog?.deployments
    assert(Array.isArray(deployments) && deployments.length > 0, 'The installed deployment catalog is empty')
    assert(deployments.every((entry) => entry?.deploymentVersion !== targetVersion), 'The installed catalog already ships the synthetic target version')
    const baseEntry = deployments.find((entry) => entry?.deploymentVersion === Number(current.deploymentVersion)) ?? deployments[deployments.length - 1]
    const stateSchemas = baseEntry?.stateSchemas
    assert(Array.isArray(stateSchemas) && stateSchemas.length > 0, 'The installed catalog entry has no state schemas to copy')
    const templatePath = join(packageRoot(), 'assets', 'docker', 'settings.yml.template')
    const template = await fileSystem.readFile(templatePath)
    const jsonItems = template.match(JSON_LIST_ITEM_GLOBAL)
    assert(jsonItems !== null && jsonItems.length === 1, 'The packaged settings template has no single json formats entry to remove')
    const faultTemplate = template.replace(JSON_LIST_ITEM, '')
    assert(faultTemplate !== template, 'The fault settings template could not be produced')
    const faultAsset = 'docker/settings.cert-fault.yml.template'
    await fileSystem.writeFile(join(packageRoot(), 'assets', faultAsset), faultTemplate)
    await fileSystem.writeFile(catalogPath, `${JSON.stringify({
      ...catalog,
      deployments: [...deployments, {
        deploymentVersion: targetVersion,
        image,
        composeAsset: 'docker/compose.yml',
        settingsAsset: faultAsset,
        stateSchemas: [...stateSchemas],
      }],
    }, null, 2)}\n`)
    injectedVersion = targetVersion
    log(`Injected a synthetic deployment version ${targetVersion} (json format removed) into the temporary installed copy`)

    // A real transaction whose target validation must fail and roll back.
    const command = [node, cliModule(), 'update', '--profile', profile, '--deployment-version', String(targetVersion), '--json']
    const result = await runCli(['update', '--profile', profile, '--deployment-version', String(targetVersion), '--json'], { timeoutMs: TIMEOUTS.update })
    assert(result.code !== 0, 'the faulted update unexpectedly succeeded', { command, result })
    const envelope = parseJson(result.stderr, 'The failed update envelope', { command, result })
    assert(envelope?.code === 'E_JSON_DISABLED', 'the faulted update failed for an unexpected reason', { command, result })
    assert(envelope.rolledBack === true && envelope.targetVersion === targetVersion, 'the failed update did not report a verified rollback', { command, result })

    await requireDoctorHealthy('updateRollback')
    const after = await currentDeployment()
    assert(Number(after.deploymentVersion) === Number(current.deploymentVersion), 'the rollback did not restore the previous deployment version', { command, result })
    assert(after.image === image && after.configurationSha256 === current.configurationSha256, 'the rollback did not restore the previous deployment configuration', { command, result })
  }

  async function stepRemove() {
    const command = [node, cliModule(), 'remove', '--profile', profile, '--service', '--purge-data', '--yes', '--json']
    const result = await runCli(['remove', '--profile', profile, '--service', '--purge-data', '--yes', '--json'], { timeoutMs: TIMEOUTS.remove })
    const report = result.code === 0 ? parseJson(result.stdout, 'remove', { command, result }) : undefined
    assert(result.code === 0 && report?.serviceRemoved === true && report?.dataPurged === true, 'remove --service --purge-data did not complete', { command, result })
    await assertNoOwnedResources()
    assert(!(await fileSystem.pathExists(managedDir)), 'the managed directory survived --purge-data')
  }

  // ---- ownership-checked cleanup ---------------------------------------

  /** Docker ids whose labels carry this run's ownership labels. */
  async function listOwned(kind) {
    const result = await docker([kind, 'ls', '-aq', '--filter', `label=${MANAGED_LABEL}=true`, '--filter', `label=${HOME_ID_LABEL}=${homeId}`])
    if (result.spawnFailed || result.code !== 0) throw stepFailure(`Could not list ${kind} resources for cleanup`, { command: ['docker', kind, 'ls', '-aq'], result })
    return result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  }

  async function inspectLabels(kind, id) {
    const result = await docker([kind, 'inspect', id])
    if (result.spawnFailed || result.code !== 0) return undefined
    try {
      const parsed = JSON.parse(result.stdout)
      const first = Array.isArray(parsed) ? parsed[0] : undefined
      return kind === 'container' ? first?.Config?.Labels : first?.Labels
    } catch {
      return undefined
    }
  }

  /**
   * Remove only resources whose inspect output carries BOTH ownership labels
   * for this run's home id. A listing can never be trusted on its own: the
   * inspect gate is what makes the sweep ownership-checked.
   */
  async function sweepOwnedResources() {
    for (const kind of ['container', 'network', 'volume']) {
      for (const id of await listOwned(kind)) {
        const labels = await inspectLabels(kind, id)
        if (labels?.[MANAGED_LABEL] === 'true' && labels?.[HOME_ID_LABEL] === homeId) {
          const args = kind === 'container' ? ['container', 'rm', '--force', id] : [kind, 'rm', id]
          log(`Removing leftover owned ${kind} ${id}`)
          await docker(args)
        } else {
          log(`Skipping ${kind} ${id}: it does not carry this run's ownership labels`)
        }
      }
    }
  }

  async function assertNoOwnedResources() {
    for (const kind of ['container', 'network', 'volume']) {
      const remaining = await listOwned(kind)
      assert(remaining.length === 0, `owned ${kind} resources remain: ${remaining.join(', ')}`)
    }
  }

  async function cleanupEverything() {
    if (cliInstalled && setupAttempted) {
      try {
        await runCli(['remove', '--profile', profile, '--service', '--purge-data', '--yes'], { timeoutMs: TIMEOUTS.remove })
      } catch {
        // Tolerated by design: the CLI legitimately refuses once the journey
        // already removed everything; the sweep below is the cleanup
        // authority and records any genuine residual-resource failure.
      }
    }
    try {
      await sweepOwnedResources()
      await assertNoOwnedResources()
    } catch (error) {
      cleanupProblems.push(error instanceof Error ? error.message : String(error))
    }
    try {
      await fileSystem.removeTree(tempRoot)
    } catch (error) {
      cleanupProblems.push(`temporary directory removal failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (cleanupProblems.length > 0) {
      cleanup = 'fail'
      // Only when no step failed does the cleanup reason itself become the
      // headline diagnostics; otherwise it stays in cleanupProblems so both
      // the failure and the residual-resource cause remain visible.
      diagnostics ??= { message: `cleanup problems: ${cleanupProblems.join('; ')}` }
    }
  }

  // ---- orchestration ---------------------------------------------------

  const steps = [
    ['setup', stepSetup],
    ['repeatSetup', stepRepeatSetup],
    ['status', stepStatus],
    ['doctor', stepDoctor],
    ['dockerRestart', stepDockerRestart],
    ['repair', stepRepair],
    ['updateRollback', stepUpdateRollback],
    ['remove', stepRemove],
  ]

  try {
    await installTarball()
    for (const [name, step] of steps) {
      try {
        log(`Running check ${name}`)
        await step()
        checks[name] = 'pass'
      } catch (error) {
        checks[name] = 'fail'
        diagnostics = describeFailure(error)
        log(`Check ${name} failed: ${diagnostics.message}`)
        break
      }
    }
  } catch (error) {
    diagnostics = describeFailure(error)
    log(`Certification could not run: ${diagnostics.message}`)
  } finally {
    log('Running ownership-checked cleanup')
    await cleanupEverything()
  }

  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    platform: preflight.platform,
    node: preflight.node,
    docker: preflight.docker,
    compose: preflight.compose,
    packageVersion,
    tarball: preflight.tarball,
    tarballSha256: preflight.tarballSha256,
    profile,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Math.max(0, now() - startedAt),
    checks: { ...checks, cleanup },
    notes: [
      injectedVersion === undefined
        ? 'updateRollback: not reached; no synthetic catalog entry was injected'
        : `updateRollback: synthetic deployment version ${injectedVersion} (same digest-pinned image, settings template with the json search format removed) was injected into this run's temporary installed copy only, so update ran a real transaction whose failed validation forced the verified rollback`,
      'repair: the generated bundle .env was deleted (settings.yml intact) to force the render-assets rebuild path',
      `cleanup: only Docker resources whose inspect output carries ${MANAGED_LABEL}=true and ${HOME_ID_LABEL}=${homeId} are removed`,
    ],
    ...(cleanupProblems.length > 0 ? { cleanupProblems } : {}),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  }

  const everyCheckPassed = CERTIFY_CHECKS.every((name) => checks[name] === 'pass') && cleanup === 'pass'
  return { report, exitCode: everyCheckPassed ? 0 : 1 }
}

// ---- real adapters ------------------------------------------------------

/** Real spawner: argument arrays everywhere; never throws for nonzero exits. */
async function realSpawner(file, args, options = {}) {
  const spawnOptions = {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs ?? TIMEOUTS.docker,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  }
  try {
    const { stdout, stderr } = await execArgv(file, args, spawnOptions)
    return { code: 0, stdout, stderr, spawnFailed: false }
  } catch (error) {
    // promisified execFile: a numeric code is the process exit status, a
    // string code (ENOENT, EACCES) means the command could not be spawned,
    // and a timeout kill carries `killed` with a null code.
    const rawCode = error?.code
    return {
      code: typeof rawCode === 'number' ? rawCode : -1,
      stdout: error?.stdout ?? '',
      stderr: error?.stderr ?? String(error?.message ?? error),
      spawnFailed: typeof rawCode === 'string',
    }
  }
}

/**
 * execFile wrapper with one bounded Windows fallback: bare-name commands that
 * fail to spawn (a .cmd shim such as a dsh installed through npm) are retried
 * once through the shell. Node, docker.exe, and direct paths never hit it.
 */
async function execArgv(file, args, options) {
  try {
    return await execFileAsync(file, args, options)
  } catch (error) {
    if (process.platform === 'win32' && typeof error?.code === 'string' && !options.shell) {
      return execFileAsync(file, args, { ...options, shell: true })
    }
    throw error
  }
}

async function realPathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function realSha256File(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

const realFileSystem = {
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, data) => writeFile(path, data, 'utf8'),
  removeFile: (path) => unlink(path),
  pathExists: realPathExists,
  removeTree: (path) => rm(path, { recursive: true, force: true }),
}

/**
 * Prefer npm's CLI entry point behind the current Node executable: it keeps
 * the install a pure argument-array spawn on every platform. Systems without
 * a bundled npm fall back to the npm command.
 */
function defaultNpmInvocation() {
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(npmCli)) return { file: process.execPath, args: [npmCli] }
  return process.platform === 'win32' ? { file: 'npm.cmd', args: [] } : { file: 'npm', args: [] }
}

// ---- entry point --------------------------------------------------------

async function main() {
  let parsed
  try {
    parsed = parseCertifyArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.code}: ${error.message}\nNext: ${error.action}\n`)
    process.exitCode = error.exitCode
    return
  }
  try {
    const preflight = await preflightCertification({ tarball: parsed.tarball, spawner: realSpawner })
    const { report, exitCode } = await runCertification({
      preflight,
      spawner: realSpawner,
      fileSystem: realFileSystem,
      makeTempDir: (prefix) => mkdtemp(prefix),
      log: (line) => process.stderr.write(`${line}\n`),
    })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.exitCode = exitCode
  } catch (error) {
    if (error instanceof CertificationError) {
      process.stderr.write(`${error.code}: ${error.message}\nNext: ${error.action}\n`)
      process.exitCode = error.exitCode
      return
    }
    process.stderr.write(`E_INTERNAL: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

function isMainModule() {
  const executed = process.argv[1]
  if (executed === undefined) return false
  try {
    return resolve(executed) === resolve(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) {
  await main()
}
