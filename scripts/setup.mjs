#!/usr/bin/env node
// One-command install: clean clone -> ready to run `pnpm run bootstrap:admin`
// then `pnpm dev`. See README.md's Quickstart for the full three-command
// flow this script is one third of.
//
// Deliberately plain Node (built-ins only, no imports from node_modules): a
// fresh clone has no node_modules yet — this script's own job is to CREATE
// it (via `pnpm install`, below) — so it cannot depend on anything that
// install would provide. `apps/api`'s CLI scripts (db:migrate, reconcile,
// jml:lifecycle) can afford to be TypeScript run through `tsx` because they
// only ever run AFTER install has already happened; this one runs before.
//
// Runs, in order (matching the contract in
// .superpowers/sdd/2026-08-06-idp-milestone-8-admin-console/task-1-brief.md):
//   1. Preflight: Docker daemon reachable, ports 5432/8080/9000/3000/5173
//      free, Node >=20, pnpm >=9 — every failure collected and reported
//      together, with a specific, actionable message each, never a stack
//      trace.
//   2. `docker compose up -d`, then wait for Postgres healthy AND the
//      Keycloak realm discovery endpoint to answer — Keycloak takes 20-40s
//      on a first start; racing ahead of it is exactly the failure mode
//      this step exists to prevent.
//   3. Copy `.env.example` -> `.env` if absent, at BOTH the repo root (the
//      API's config) and apps/web (Vite's — `VITE_*` vars are read from
//      apps/web/.env, not the root one; Vite never sees the root file).
//      Never overwrites an existing `.env`.
//   4. `pnpm install`.
//   5. `pnpm --filter @idm/api run db:migrate` — applies the schema AND
//      provisions the runtime database role (see README's "Database roles").
//
// NOTE on the script's name: this is NOT called "setup". `setup` is a
// genuine, unrelated pnpm CLI built-in ("Sets up pnpm" itself — writes
// PNPM_HOME/PATH changes to the user's shell profile). Confirmed empirically
// (see task-1-report.md): a bare `pnpm setup` ALWAYS runs pnpm's own
// command, never a same-named package.json script, on any pnpm version
// tested — `pnpm run setup` was the only form that reached it, which is easy
// to get wrong for a command whose whole purpose is a frictionless first
// run. Task 2 renamed it to the colon-namespaced `setup:all`, matching the
// `bootstrap:admin` convention: no pnpm built-in command name ever contains
// a colon, so a colon-namespaced script name cannot collide with one, now or
// on any future pnpm version. `pnpm setup:all` (bare, no `run` needed) is
// the only form documented anywhere in this repo.

import { spawnSync } from 'node:child_process'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const REQUIRED_PORTS = [
  { port: 5432, label: 'Postgres' },
  { port: 8080, label: 'Keycloak' },
  { port: 9000, label: 'Keycloak management' },
  { port: 3000, label: 'the API (pnpm dev)' },
  { port: 5173, label: 'the web console (pnpm dev)' },
]

const MIN_NODE_MAJOR = 20
const MIN_PNPM_MAJOR = 9
const POSTGRES_HEALTHY_TIMEOUT_MS = 60_000
const KEYCLOAK_READY_TIMEOUT_MS = 120_000
const POLL_INTERVAL_MS = 1_500
const KEYCLOAK_DISCOVERY_URL =
  'http://localhost:8080/realms/identity-manager/.well-known/openid-configuration'

function log(message) {
  console.log(`[setup] ${message}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Runs a command with output streamed live to this process's own stdio. */
function runInherited(command, args, options = {}) {
  return spawnSync(command, args, { stdio: 'inherit', cwd: repoRoot, shell: true, ...options })
}

/** Runs a command and captures its output for parsing, rather than displaying it. */
function runCaptured(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', cwd: repoRoot, ...options })
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/**
 * `docker compose ps --format json` prints one JSON object per line (NDJSON),
 * not a single JSON array — confirmed against the real Docker Compose v2
 * bundled with Docker Desktop. Returns `[]` (never throws) when Docker isn't
 * reachable or the stack has never been started — both are ordinary states
 * this function's callers already handle by treating "not found" as "not
 * running".
 */
function getComposeStatus() {
  const result = runCaptured('docker', ['compose', 'ps', '--format', 'json'], { shell: true })
  if (result.error || result.status !== 0 || !result.stdout) return []
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((entry) => entry !== null)
}

/** Published TCP port -> compose service name, for THIS project's own containers only. */
function myComposePorts(entries) {
  const map = new Map()
  for (const entry of entries) {
    const publishers = Array.isArray(entry.Publishers) ? entry.Publishers : []
    for (const publisher of publishers) {
      if (publisher.PublishedPort) {
        map.set(Number(publisher.PublishedPort), entry.Service ?? entry.Name ?? 'unknown service')
      }
    }
  }
  return map
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '0.0.0.0')
  })
}

/** Best-effort "who is holding this port" via Docker, then (Windows-only) netstat/tasklist. */
function describeOccupant(port) {
  const dockerNames = runCaptured('docker', ['ps', '--filter', `publish=${port}`, '--format', '{{.Names}}'], {
    shell: true,
  })
  if (!dockerNames.error && dockerNames.status === 0 && dockerNames.stdout.trim()) {
    return `Docker container "${dockerNames.stdout.trim().split('\n')[0]}"`
  }

  if (process.platform === 'win32') {
    try {
      const netstatOut = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
        encoding: 'utf8',
      })
      const pids = [
        ...new Set(
          netstatOut
            .split('\n')
            .map((line) => line.trim().split(/\s+/).pop())
            .filter((pid) => pid && /^\d+$/.test(pid)),
        ),
      ]
      if (pids.length > 0) {
        const pid = pids[0]
        try {
          const taskOut = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' })
          const match = taskOut.match(/^"([^"]+)"/)
          return match ? `${match[1]} (pid ${pid})` : `an unidentified process (pid ${pid})`
        } catch {
          return `an unidentified process (pid ${pid})`
        }
      }
    } catch {
      // findstr exits non-zero when nothing matches — genuinely nothing found.
    }
  }

  return 'an unidentified process'
}

async function checkPorts(failures) {
  const composeEntries = getComposeStatus()
  const mine = myComposePorts(composeEntries)

  for (const { port, label } of REQUIRED_PORTS) {
    const free = await isPortFree(port)
    if (free) continue

    const owner = mine.get(port)
    if (owner) {
      log(`port ${port} (${label}) is already in use by this project's own "${owner}" container — reusing it.`)
      continue
    }

    const occupant = describeOccupant(port)
    failures.push(
      `port ${port} is required for ${label} but is already in use by ${occupant}. Stop whatever is using it (or, if it's a stale container from another project, remove it) and re-run \`pnpm setup:all\`.`,
    )
  }
}

function checkDocker(failures) {
  const result = runCaptured('docker', ['info'], { shell: true })
  if (result.error) {
    failures.push(
      'Docker was not found on PATH. Install Docker Desktop (https://www.docker.com/products/docker-desktop/), make sure it is running, and re-run `pnpm setup:all`.',
    )
    return
  }
  if (result.status !== 0) {
    failures.push(
      'Docker does not appear to be running (`docker info` failed). Start Docker Desktop and re-run `pnpm setup:all`.',
    )
  }
}

function checkNodeVersion(failures) {
  const major = Number(process.versions.node.split('.')[0])
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    failures.push(
      `Node ${process.versions.node} is running this script, but Node ${MIN_NODE_MAJOR}+ is required. Install a newer Node (https://nodejs.org/) and re-run \`pnpm setup:all\`.`,
    )
  }
}

function checkPnpmVersion(failures) {
  const result = runCaptured('pnpm', ['--version'], { shell: true })
  if (result.error || result.status !== 0) {
    failures.push('pnpm was not found on PATH. Install pnpm (https://pnpm.io/installation) and re-run `pnpm setup:all`.')
    return
  }
  const version = result.stdout.trim()
  const major = Number(version.split('.')[0])
  if (!Number.isFinite(major) || major < MIN_PNPM_MAJOR) {
    failures.push(
      `pnpm ${version || '(unknown version)'} was found, but pnpm ${MIN_PNPM_MAJOR}+ is required. Upgrade pnpm (\`npm install -g pnpm@latest\`) and re-run \`pnpm setup:all\`.`,
    )
  }
}

async function preflight() {
  log('running preflight checks ...')
  const failures = []

  checkNodeVersion(failures)
  checkPnpmVersion(failures)
  checkDocker(failures)
  // Port checks need Docker reachable to tell "mine" from "someone else's" —
  // skip them if Docker itself already failed above; the Docker failure
  // message alone is actionable enough, and every port check would otherwise
  // fail confusingly downstream of a Docker problem that hasn't been fixed
  // yet.
  if (failures.length === 0) {
    await checkPorts(failures)
  }

  if (failures.length > 0) {
    console.error('\n[setup] Preflight failed:\n')
    for (const failure of failures) {
      console.error(`  - ${failure}`)
    }
    console.error('')
    process.exit(1)
  }

  log('preflight OK — Docker is running, required ports are free, Node and pnpm versions are supported.')
}

// ---------------------------------------------------------------------------
// Compose stack
// ---------------------------------------------------------------------------

async function waitForPostgresHealthy() {
  log('waiting for Postgres to report healthy ...')
  const deadline = Date.now() + POSTGRES_HEALTHY_TIMEOUT_MS
  let lastStatus = 'not started yet'
  let lastLogAt = 0

  while (Date.now() < deadline) {
    const entries = getComposeStatus()
    const postgres = entries.find((entry) => entry.Service === 'postgres')
    lastStatus = postgres ? postgres.Health || postgres.State : 'container not found'

    if (postgres && postgres.Health === 'healthy') {
      log('Postgres is healthy.')
      return
    }

    if (Date.now() - lastLogAt > 10_000) {
      log(`... still waiting on Postgres (status: ${lastStatus})`)
      lastLogAt = Date.now()
    }
    await sleep(POLL_INTERVAL_MS)
  }

  throw new Error(`timed out waiting for Postgres to become healthy (last status: ${lastStatus})`)
}

async function waitForKeycloakReady() {
  log('waiting for the Keycloak realm discovery endpoint to answer (can take 20-40s on a first start) ...')
  const deadline = Date.now() + KEYCLOAK_READY_TIMEOUT_MS
  let lastError = 'no attempt made yet'
  let lastLogAt = 0

  while (Date.now() < deadline) {
    try {
      const response = await fetch(KEYCLOAK_DISCOVERY_URL)
      if (response.status === 200) {
        log('Keycloak realm discovery endpoint is answering.')
        return
      }
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }

    if (Date.now() - lastLogAt > 10_000) {
      log(`... still waiting on Keycloak (last attempt: ${lastError})`)
      lastLogAt = Date.now()
    }
    await sleep(POLL_INTERVAL_MS)
  }

  throw new Error(
    `timed out waiting for Keycloak's realm discovery endpoint at ${KEYCLOAK_DISCOVERY_URL} (last error: ${lastError})`,
  )
}

function startComposeStack() {
  log('starting the compose stack (`docker compose up -d`) ...')
  const result = runInherited('docker', ['compose', 'up', '-d'])
  if (result.status !== 0) {
    throw new Error('`docker compose up -d` failed — see output above.')
  }
}

// ---------------------------------------------------------------------------
// .env files
// ---------------------------------------------------------------------------

/**
 * Two independent `.env` files need seeding, not one: the API (`apps/api`,
 * via `--env-file-if-exists=../../.env` on every one of its scripts) reads
 * the REPO ROOT `.env`, but Vite only ever reads `.env` from its OWN project
 * root (`apps/web/.env`) and only exposes vars prefixed `VITE_` — the root
 * `.env` is invisible to it. Skipping the second copy would leave
 * `pnpm dev`'s web half booting against `undefined` Keycloak/API config.
 * Never overwrites a `.env` that already exists, at either location.
 */
function seedEnvFile(dir) {
  const example = path.join(dir, '.env.example')
  const target = path.join(dir, '.env')
  const relative = path.relative(repoRoot, target) || '.env'

  if (fs.existsSync(target)) {
    log(`${relative} already exists — leaving it untouched.`)
    return
  }
  fs.copyFileSync(example, target)
  log(`created ${relative} from ${path.basename(example)}.`)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  log('setting up identity-manager ...')

  await preflight()

  startComposeStack()
  await waitForPostgresHealthy()
  await waitForKeycloakReady()

  seedEnvFile(repoRoot)
  seedEnvFile(path.join(repoRoot, 'apps', 'web'))

  log('installing dependencies (`pnpm install`) ...')
  const install = runInherited('pnpm', ['install'])
  if (install.status !== 0) {
    throw new Error('`pnpm install` failed — see output above.')
  }

  log('applying database migrations and provisioning the runtime role (`db:migrate`) ...')
  const migrate = runInherited('pnpm', ['--filter', '@idm/api', 'run', 'db:migrate'])
  if (migrate.status !== 0) {
    throw new Error('`db:migrate` failed — see output above.')
  }

  console.log('')
  log('setup complete.')
  console.log('')
  console.log('Next steps:')
  console.log('  1. pnpm bootstrap:admin       (creates your local admin account — safe to re-run)')
  console.log('  2. pnpm dev                   (starts the API and the web console together)')
  console.log('  3. Open http://localhost:5173 and sign in with:')
  console.log('       username: admin@example.com')
  console.log('       password: dev_password_change_me')
  console.log('')
}

main().catch((error) => {
  console.error(`\n[setup] FAILED: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
