import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll } from 'vitest'
import { runMigrations } from '../../src/db/migrate'
import type { RuntimeRoleCredentials } from '../../src/db/roles'
import * as schema from '../../src/db/schema/index'

/**
 * Finding H1 (docs/archive/audits/audit-integrity.md): fixed, not derived from
 * anything per-file — safe because Testcontainers gives every file its OWN
 * throwaway Postgres CLUSTER (a separate container), so there is no
 * cross-file role-name collision to worry about, unlike a shared server
 * where concurrent test files would need distinct names.
 */
const TEST_RUNTIME_ROLE: RuntimeRoleCredentials = {
  username: 'idm_app_test',
  password: 'idm_app_test_password',
}

export interface TestDatabase {
  /** RUNTIME role (finding H1) — what the code under test runs as. */
  db: NodePgDatabase<typeof schema>
  /** RUNTIME role — same connection as `db`. */
  pool: Pool
  /**
   * OWNER role — owns the schema, same role migrations run as. For test
   * SETUP that genuinely needs elevated access (there is currently no such
   * case in this suite, but see e.g. audit.spec.ts's "the trigger still
   * blocks the owner role" tests, which deliberately probe the owner's own
   * — different — defense). Code under test must never be handed this.
   */
  ownerDb: NodePgDatabase<typeof schema>
  /** OWNER role — same connection as `ownerDb`. */
  ownerPool: Pool
  /** Re-runs the full migrate flow (schema + `provisionRuntimeRole`) as the OWNER, exactly like `db:migrate`. */
  runMigrationsAgain: () => Promise<void>
  /**
   * The RUNTIME role's own connection string. Exposed so a test can open a
   * SECOND, independent connection/pool against the same throwaway database
   * — e.g. test/pool-exhaustion.spec.ts, which needs the real
   * `createDbClient` (db/client.ts) — with its real `max`/
   * `connectionTimeoutMillis` behaviour — bound to the app under test,
   * separate from this helper's own ad-hoc `pool` (which fixture setup uses
   * and which does not represent production pool configuration). Points at
   * the RUNTIME role, not the owner: that is what the real app/SyncWorker
   * connect as (app.module.ts's DB_CLIENT), so a test simulating "the real
   * app's pool" must use the same privilege posture, not a superuser one.
   */
  connectionUri: string
  /** The OWNER role's own connection string, for the rare test that needs it directly rather than via `ownerPool`/`ownerDb`. */
  ownerConnectionUri: string
}

/**
 * A `pg.Pool` with no `'error'` listener turns any idle-client error into an
 * UNHANDLED error. During teardown that is guaranteed to happen: stopping the
 * container drops every still-open connection, and Postgres reports
 * `57P01` (admin_shutdown, "terminating connection due to administrator
 * command") on each one.
 *
 * CI failed on exactly that with all 71 test files GREEN — vitest reported
 * "Unhandled Errors" and failed the run after every test had passed, which is
 * the most misleading way a suite can fail. It does not reproduce reliably
 * locally because it depends on teardown ordering between this helper's
 * module-scope `afterAll` and a spec file's own.
 *
 * Only SHUTDOWN-CLASS errors are swallowed. A genuine connection error during
 * a test still surfaces, because hiding those would defeat the point of
 * running against a real Postgres at all.
 */
function swallowShutdownErrors(pool: Pool): void {
  pool.on('error', (error: NodeJS.ErrnoException & { code?: string }) => {
    const code = error?.code
    if (code === '57P01' || code === 'ECONNRESET' || code === 'EPIPE') return
    throw error
  })
}

/**
 * Starts a throwaway Postgres container for the current test file and
 * applies all migrations — including, as of finding H1, provisioning the
 * RUNTIME role and its grants exactly like a real `db:migrate` run does
 * (`runMigrations` is the same function `db/migrate-cli.ts` calls; nothing
 * here is test-only logic that could drift from production behaviour). Real
 * Postgres, never a mock — ltree, recursive CTEs, and constraint behaviour
 * cannot be faked.
 *
 * `db`/`pool`/`connectionUri` — the handles every existing test in this
 * suite already uses — now carry the RESTRICTED runtime role, not the
 * container's own bootstrap superuser: the suite exercises the real
 * privilege posture production runs under, not an accidentally-elevated
 * one. `ownerDb`/`ownerPool`/`ownerConnectionUri` expose the bootstrap
 * role (which owns the schema, mirroring the OWNER role `db:migrate`
 * connects as in production) for the rare case a test genuinely needs it.
 */
export function withTestDatabase(): TestDatabase {
  const ctx = {} as TestDatabase
  let container: StartedPostgreSqlContainer

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start()

    ctx.ownerConnectionUri = container.getConnectionUri()
    ctx.ownerPool = new Pool({ connectionString: ctx.ownerConnectionUri })
    swallowShutdownErrors(ctx.ownerPool)
    ctx.ownerDb = drizzle(ctx.ownerPool, { schema })

    ctx.runMigrationsAgain = () => runMigrations(ctx.ownerPool, TEST_RUNTIME_ROLE)
    await runMigrations(ctx.ownerPool, TEST_RUNTIME_ROLE)

    ctx.connectionUri = withCredentials(ctx.ownerConnectionUri, TEST_RUNTIME_ROLE)
    ctx.pool = new Pool({ connectionString: ctx.connectionUri })
    swallowShutdownErrors(ctx.pool)
    ctx.db = drizzle(ctx.pool, { schema })
  })

  afterAll(async () => {
    await ctx.pool?.end()
    await ctx.ownerPool?.end()
    await container?.stop()
  })

  return ctx
}

/** Swaps the username/password on a `postgres://...` connection URI, keeping host/port/database. */
function withCredentials(connectionUri: string, credentials: RuntimeRoleCredentials): string {
  const url = new URL(connectionUri)
  url.username = credentials.username
  url.password = credentials.password
  return url.toString()
}
