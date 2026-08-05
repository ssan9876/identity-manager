import { loadEnv } from '../config/env'
import { createDbClient } from './client'
import { runMigrations } from './migrate'

/**
 * The runtime entrypoint for applying migrations to a real database (dev,
 * CI, prod) — as opposed to `runMigrations` itself, which is also called
 * directly by the test harness against a throwaway Testcontainers Postgres.
 * Reuses `createDbClient` rather than constructing its own Pool so that
 * function has a real caller outside of tests.
 */
async function main(): Promise<void> {
  const env = loadEnv(process.env)
  const { pool } = createDbClient(env.databaseUrl)

  try {
    await runMigrations(pool)
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
