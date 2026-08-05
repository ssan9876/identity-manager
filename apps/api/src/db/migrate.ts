import { existsSync } from 'node:fs'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type { Pool } from 'pg'

const REQUIRED_EXTENSIONS = ['ltree'] as const

/**
 * Resolved from the working directory rather than `__dirname`, because this
 * module runs under both tsx (CommonJS, `__dirname` defined) and Vitest's SWC
 * transform (ES modules, `__dirname` undefined). Every script that loads it
 * runs with apps/api as the working directory.
 */
export const MIGRATIONS_FOLDER = path.resolve(process.cwd(), 'src/db/migrations')

/**
 * Extensions are created here rather than in a generated migration because
 * drizzle-kit does not emit CREATE EXTENSION statements. This runs first and
 * is safe to repeat.
 */
export async function runMigrations(pool: Pool): Promise<void> {
  for (const extension of REQUIRED_EXTENSIONS) {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS ${extension}`)
  }

  // No migrations have been generated yet at this point in the build order.
  // drizzle-kit creates the journal on its first `db:generate` run.
  if (!existsSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'))) {
    return
  }

  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER })
}
