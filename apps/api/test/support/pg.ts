import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll } from 'vitest'
import { runMigrations } from '../../src/db/migrate'
import * as schema from '../../src/db/schema/index'

export interface TestDatabase {
  db: NodePgDatabase<typeof schema>
  pool: Pool
  runMigrationsAgain: () => Promise<void>
}

/**
 * Starts a throwaway Postgres container for the current test file and applies
 * all migrations. Real Postgres, never a mock — ltree, recursive CTEs, and
 * constraint behaviour cannot be faked.
 */
export function withTestDatabase(): TestDatabase {
  const ctx = {} as TestDatabase
  let container: StartedPostgreSqlContainer

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start()
    ctx.pool = new Pool({ connectionString: container.getConnectionUri() })
    ctx.db = drizzle(ctx.pool, { schema })
    ctx.runMigrationsAgain = () => runMigrations(ctx.pool)
    await runMigrations(ctx.pool)
  })

  afterAll(async () => {
    await ctx.pool?.end()
    await container?.stop()
  })

  return ctx
}
