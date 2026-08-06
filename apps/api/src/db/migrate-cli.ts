import { loadEnv } from '../config/env'
import { createDbClient } from './client'
import { runMigrations } from './migrate'
import { parseRoleCredentials } from './roles'

/**
 * The runtime entrypoint for applying migrations to a real database (dev,
 * CI, prod) — as opposed to `runMigrations` itself, which is also called
 * directly by the test harness against a throwaway Testcontainers Postgres.
 * Reuses `createDbClient` rather than constructing its own Pool so that
 * function has a real caller outside of tests.
 *
 * The ONLY script in this codebase that connects as the OWNER role
 * (`env.databaseUrl`) — see config/env.ts's doc comment on DATABASE_URL vs
 * RUNTIME_DATABASE_URL, and finding H1 (docs/superpowers/audit-integrity.md).
 * The runtime role's identity/password come from RUNTIME_DATABASE_URL
 * itself (parseRoleCredentials), so that connection string is the single
 * source of truth for who the role is; this script just makes it real in
 * Postgres and keeps its grants current on every run (db/roles.ts).
 */
async function main(): Promise<void> {
  const env = loadEnv(process.env)
  const { pool } = createDbClient(env.databaseUrl, { max: env.dbPoolMax })

  try {
    await runMigrations(pool, parseRoleCredentials(env.runtimeDatabaseUrl))
  } finally {
    await pool.end()
  }
}

main()
  .then(() => {
    console.log('Migrations applied successfully.')
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Migration failed: ${message}`)
    process.exitCode = 1
  })
