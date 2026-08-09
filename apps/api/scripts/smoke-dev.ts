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

// Deliberately NOT KEYCLOAK_USERNAME. `username` must equal KEYCLOAK_USERNAME
// (that's what resolveActor matches against — see the doc comment below),
// but `primary_email` is an INDEPENDENT unique-constrained column, and a
// real pre-existing user can easily share that email while holding a
// different username (that is exactly the reviewer's Finding 2 scenario:
// primary_email='admin@example.com', username='not.the.token.user'). Seeding
// with primaryEmail: KEYCLOAK_USERNAME would collide with that unrelated
// row's email and crash `users.create` with a raw 23505, even once the
// username lookup/cleanup are both correct. A dedicated sentinel, on the
// reserved `.invalid` TLD (RFC 2606 — guaranteed never a real, resolvable,
// or assignable domain; the same convention app.module.spec.ts already uses
// for its Keycloak issuer stub), decouples the two columns completely: this
// script can only ever collide with pre-existing data on `username`, which
// the lookup below already handles correctly.
const SMOKE_USER_EMAIL = 'idm-smoke-dev@local.invalid'

interface SeededActor {
  /** Removes only what THIS run created and closes its pool. */
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
 * Looks the user up by `username` (`findByUsername`), because that is
 * exactly what `resolveActor` matches a principal against — never by email.
 * A prior version of this function matched on email instead, which found
 * (and its cleanup then deleted) a real pre-existing user and org unit in a
 * shared dev database that merely happened to share this email address but
 * had a different username: matching the wrong field reused a stranger's
 * row, and reusing it is what made deleting it look "safe" — see the fix
 * round in task-6-report.md, Finding 2.
 *
 * Cleanup deletes only what THIS run created — tracked explicitly below,
 * never inferred from "found vs. not found" — so a run that reuses a
 * leftover from an earlier *interrupted run of this same script* (a real
 * row whose username genuinely matches KEYCLOAK_USERNAME, left behind by a
 * crash before that run's own cleanup) does not delete it either; only the
 * run that actually created a row is ever responsible for removing it.
 *
 * Talks to Postgres directly, on its own pool — independent of the app
 * process this script spawns, so seeding/cleanup work whether or not that
 * process is up.
 *
 * Connects as the RUNTIME role (finding H1, docs/archive/audits/
 * audit-integrity.md), deliberately: every write here (create a user,
 * activate it, assign a role, delete each on cleanup) is exactly the shape
 * of DML the real application performs, so seeding this way doubles as a
 * live check that the runtime role's grants are actually sufficient for
 * ordinary app operation — not just a theoretical grant list.
 */
async function seedActor(runtimeDatabaseUrl: string): Promise<SeededActor> {
  const { db, pool } = createDbClient(runtimeDatabaseUrl)

  try {
    const orgUnits = new OrgUnitsRepository(db)
    const users = new UsersRepository(db)
    const roleAssignments = new RoleAssignmentsRepository(db)

    log('seeding an org unit, an active local user, and a super_admin role assignment ...')

    let user = await users.findByUsername(KEYCLOAK_USERNAME)
    let createdOrgUnitId: string | null = null
    let createdUserId: string | null = null

    if (user === null) {
      const orgUnit = await orgUnits.createRoot(SMOKE_ORG_UNIT_NAME)
      createdOrgUnitId = orgUnit.id
      user = await users.create({
        primaryEmail: SMOKE_USER_EMAIL,
        username: KEYCLOAK_USERNAME,
        firstName: 'Smoke',
        lastName: 'Test',
        orgUnitId: orgUnit.id,
      })
      createdUserId = user.id
    } else {
      log(
        `reusing a pre-existing local user matching username ${KEYCLOAK_USERNAME} (left by an interrupted earlier run) — this run will not delete it or its org unit`,
      )
    }

    if (user.status !== 'active') {
      user = await users.changeStatus(user.id, 'active')
    }

    const existingAssignments = await roleAssignments.listForUser(user.id)
    const hasSuperAdmin = existingAssignments.some(
      (assignment) => assignment.roleKey === 'super_admin' && assignment.scopeOrgUnitId === null,
    )
    let createdRoleAssignmentId: string | null = null
    if (!hasSuperAdmin) {
      const assignment = await roleAssignments.assign({ userId: user.id, roleKey: 'super_admin' })
      createdRoleAssignmentId = assignment.id
    }

    log(`seeded local user ${user.id} (${KEYCLOAK_USERNAME}) with super_admin`)

    return {
      async cleanup(): Promise<void> {
        log('cleaning up smoke-test data this run created ...')
        try {
          // Each delete is independently conditional on THIS run having
          // created that exact row — never on "found vs. not found" at the
          // top of this function, and never unconditional. Nothing here
          // touches audit_log: it is append-only (rows can never be
          // removed, by design — see db/migrate.ts), but GET routes write
          // no audit rows, so this run left none to clean up either way.
          if (createdRoleAssignmentId !== null) {
            await pool.query('DELETE FROM role_assignments WHERE id = $1', [
              createdRoleAssignmentId,
            ])
          }
          if (createdUserId !== null) {
            await pool.query('DELETE FROM users WHERE id = $1', [createdUserId])
          }
          if (createdOrgUnitId !== null) {
            await pool.query('DELETE FROM org_units WHERE id = $1', [createdOrgUnitId])
          }
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
  const seeded = await seedActor(env.runtimeDatabaseUrl)

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
