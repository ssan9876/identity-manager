import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { loadEnv } from '../src/config/env'
import { createDbClient } from '../src/db/client'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersRepository } from '../src/users/users.repository'

/**
 * Boots the app exactly the way a human does — `pnpm run start:dev` — waits
 * for it to come up, mints a REAL token from the running dev Keycloak, and
 * makes one authenticated request through the whole stack.
 *
 * Why this exists: `pnpm test` cannot catch a dev-runtime-only regression.
 * The test transform (unplugin-swc, via vitest.config.ts) and the build
 * transform (tsc) both emit `design:paramtypes` decorator metadata; only the
 * dev transform can silently fail to. A controller constructor typed by bare
 * class reference (no explicit `@Inject(Token)`) resolves fine under both
 * test and build, passes every unit/integration test, compiles cleanly —
 * and then 500s on every real request once run under a transform that
 * doesn't emit that metadata. No unit test can see this: it is a property of
 * *how the dev server is started*, not of the code vitest evaluates. This
 * script is the only check in the repo that starts the app the same way a
 * human running `pnpm run start:dev` would and proves an authenticated
 * request actually reaches a repository.
 *
 * Since Task 6 (PermissionGuard on every read route), a valid token alone is
 * no longer enough: the principal must also map to a local, active user
 * holding a role that grants the route's declared permission. `seedActor`
 * below provisions and tears down exactly that for this script's own
 * Keycloak test user before/after the checks run.
 */

const HEALTH_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 500
const KEYCLOAK_CLIENT_ID = 'idm-test-client'
const KEYCLOAK_USERNAME = 'admin@example.com'
const KEYCLOAK_PASSWORD = 'dev_password_change_me'

function log(message: string): void {
  console.log(`[smoke:dev] ${message}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const SMOKE_ORG_UNIT_NAME = 'Smoke Test Org (idm:smoke-dev)'

interface SeededActor {
  /** Removes exactly what this run seeded (or reused — see below) and closes its pool. */
  cleanup: () => Promise<void>
}

/**
 * Seeds what `PermissionGuard` (Task 6) now requires before any request can
 * reach a read endpoint: an org unit, a local `users` row whose `username`
 * matches the Keycloak token's `preferred_username` (KEYCLOAK_USERNAME),
 * ACTIVATED — `resolveActor` denies anything but `status: 'active'`, and
 * `UsersRepository.create()` defaults new rows to `pending` — and a global
 * `super_admin` role assignment.
 *
 * Idempotent against a previous run that crashed before its own cleanup ran:
 * a leftover local user with this exact username can only be this script's
 * own artifact (nothing else in the codebase creates one), so it is reused
 * rather than failing on a unique-constraint violation, and is still fully
 * removed by THIS run's cleanup rather than left to accumulate.
 *
 * Talks to Postgres directly, on its own pool — independent of the app
 * process this script spawns, so seeding/cleanup work whether or not that
 * process is up.
 */
async function seedActor(databaseUrl: string): Promise<SeededActor> {
  const { db, pool } = createDbClient(databaseUrl)

  try {
    const orgUnits = new OrgUnitsRepository(db)
    const users = new UsersRepository(db)
    const roleAssignments = new RoleAssignmentsRepository(db)

    log('seeding an org unit, an active local user, and a super_admin role assignment ...')

    let user = await users.findByEmail(KEYCLOAK_USERNAME)
    if (user === null) {
      const orgUnit = await orgUnits.createRoot(SMOKE_ORG_UNIT_NAME)
      user = await users.create({
        primaryEmail: KEYCLOAK_USERNAME,
        username: KEYCLOAK_USERNAME,
        firstName: 'Smoke',
        lastName: 'Test',
        orgUnitId: orgUnit.id,
      })
    }

    if (user.status !== 'active') {
      user = await users.changeStatus(user.id, 'active')
    }

    const existingAssignments = await roleAssignments.listForUser(user.id)
    const hasSuperAdmin = existingAssignments.some(
      (assignment) => assignment.roleKey === 'super_admin' && assignment.scopeOrgUnitId === null,
    )
    if (!hasSuperAdmin) {
      await roleAssignments.assign({ userId: user.id, roleKey: 'super_admin' })
    }

    const userId = user.id
    const orgUnitId = user.orgUnitId
    log(`seeded local user ${userId} (${KEYCLOAK_USERNAME}) with super_admin`)

    return {
      async cleanup(): Promise<void> {
        log('cleaning up seeded smoke-test data ...')
        try {
          // role_assignments cascades from users, but delete it explicitly
          // first anyway so cleanup order never depends on that cascade
          // being configured the way it happens to be today. Nothing here
          // touches audit_log: it is append-only (rows can never be
          // removed, by design — see db/migrate.ts), but GET routes write
          // no audit rows, so this run left none to clean up.
          await pool.query('DELETE FROM role_assignments WHERE user_id = $1', [userId])
          await pool.query('DELETE FROM users WHERE id = $1', [userId])
          await pool.query('DELETE FROM org_units WHERE id = $1', [orgUnitId])
        } finally {
          await pool.end()
        }
      },
    }
  } catch (error) {
    await pool.end()
    throw error
  }
}

/** PIDs currently LISTENING on `port`, Windows-only (netstat -ano parsing). */
function listeningPids(port: number): number[] {
  if (process.platform !== 'win32') return []
  try {
    const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
      encoding: 'utf8',
    })
    const pids = out
      .split('\n')
      .map((line) => line.trim().split(/\s+/).pop())
      .filter((pid): pid is string => !!pid && /^\d+$/.test(pid))
      .map(Number)
    return [...new Set(pids)]
  } catch {
    return [] // findstr exits non-zero when nothing matches — nothing listening.
  }
}

function killPid(pid: number): void {
  if (process.platform === 'win32') {
    try {
      // /T kills the whole tree rooted at pid. Necessary: `node --watch`
      // (like the `tsx watch` it replaced) supervises the real app in a
      // CHILD process with its own PID, so killing only the immediate
      // `pnpm run start:dev` process leaves the actual listener running.
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' })
    } catch {
      // Already gone — fine.
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone — fine.
    }
  }
}

/**
 * Belt-and-braces shutdown: kill the spawned child's tree, THEN directly
 * kill whatever the OS says is actually bound to the port. Task 6 found
 * that stopping only the tracked wrapper process can leave the real
 * listener alive under a different PID.
 */
function shutdown(child: ChildProcess): void {
  if (child.pid) {
    killPid(child.pid)
  }
  for (const pid of listeningPids(Number(process.env.PORT) || 3000)) {
    killPid(pid)
  }
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  let lastError = 'no attempt succeeded'

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`)
      if (res.status === 200) {
        const body = (await res.json()) as { status?: string }
        if (body.status === 'ok') return
        lastError = `unexpected /health body: ${JSON.stringify(body)}`
      } else {
        lastError = `/health returned ${res.status}`
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(POLL_INTERVAL_MS)
  }

  throw new Error(`timed out waiting for ${baseUrl}/health: ${lastError}`)
}

async function mintToken(issuer: string): Promise<string> {
  const res = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: KEYCLOAK_CLIENT_ID,
      scope: 'openid profile email',
      username: KEYCLOAK_USERNAME,
      password: KEYCLOAK_PASSWORD,
    }),
  })

  if (!res.ok) {
    throw new Error(`Keycloak token request failed: ${res.status} ${await res.text()}`)
  }

  const body = (await res.json()) as { access_token?: string }
  if (!body.access_token) {
    throw new Error(`Keycloak token response had no access_token: ${JSON.stringify(body)}`)
  }
  return body.access_token
}

/**
 * Calls an authenticated `GET <path>`, asserting 200 and a body shaped like
 * a `Page<T>` (an `items` array). Shared by every list-endpoint check below
 * so each one exercises the identical assertion — status, JSON-parseable,
 * `items` is an array — through the real HTTP stack.
 */
async function checkAuthenticatedList(
  baseUrl: string,
  token: string,
  path: string,
): Promise<number> {
  log(`calling GET ${path} with the token ...`)
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const text = await res.text()

  if (res.status !== 200) {
    throw new Error(`expected 200 from GET ${path}, got ${res.status}: ${text}`)
  }

  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`GET ${path} did not return valid JSON: ${text}`)
  }

  const items = (body as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) {
    throw new Error(`GET ${path} response had no "items" array: ${text}`)
  }

  log(`SMOKE OK — GET ${path} -> 200, items: array (length ${items.length})`)
  return items.length
}

async function main(): Promise<void> {
  const env = loadEnv(process.env)
  const baseUrl = `http://localhost:${env.port}`

  const preExisting = listeningPids(env.port)
  if (preExisting.length > 0) {
    throw new Error(
      `port ${env.port} is already in use (pid ${preExisting.join(', ')}) — free it before running smoke:dev`,
    )
  }

  // Since Task 6, PermissionGuard denies every request from a principal with
  // no local, active user and role assignment — including this script's own
  // Keycloak test user, which (deliberately) has neither by default. Seed
  // both before starting the server. This talks to Postgres directly and
  // does not depend on the app process below, so it runs first and its
  // cleanup is guaranteed via the outer `finally` regardless of how the
  // server checks turn out.
  const seeded = await seedActor(env.databaseUrl)

  let exitCode = 0
  try {
    log('starting the dev server the way a human does: `pnpm run start:dev`')
    // A single command string (not `[cmd, ...args]`) avoids Node's DEP0190
    // warning about unescaped args under shell:true — there's no untrusted
    // input here, but there's also no reason to trip it.
    const child = spawn('pnpm run start:dev', {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    })

    let serverOutput = ''
    child.stdout?.on('data', (chunk: Buffer) => (serverOutput += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (serverOutput += chunk.toString()))

    try {
      log(`waiting for ${baseUrl}/health ...`)
      await waitForHealth(baseUrl)
      log('health check ok')

      log(`minting a token from ${env.keycloakIssuer} (${KEYCLOAK_USERNAME}) ...`)
      const token = await mintToken(env.keycloakIssuer)
      log('token minted')

      await checkAuthenticatedList(baseUrl, token, '/users')

      // The GroupsController DI regression (bare-class constructor injection
      // relying on design:paramtypes) is exactly what this script exists to
      // catch — see the file header. GroupsRepository was dormant, unwired
      // into AppModule, until the groups controller landed, so /users alone
      // could pass this script while /groups 500ed under the dev transform.
      await checkAuthenticatedList(baseUrl, token, '/groups')
    } catch (error) {
      exitCode = 1
      console.error(`[smoke:dev] SMOKE FAILED: ${error instanceof Error ? error.message : String(error)}`)
      console.error('[smoke:dev] --- captured dev-server output ---')
      console.error(serverOutput || '(none captured)')
    } finally {
      log('shutting down the dev server ...')
      shutdown(child)
      await sleep(500)
    }
  } finally {
    await seeded.cleanup()
  }

  process.exit(exitCode)
}

main().catch((error: unknown) => {
  console.error('[smoke:dev] unexpected error:', error)
  process.exit(1)
})
