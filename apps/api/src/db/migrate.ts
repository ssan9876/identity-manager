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
  await enforceAuditAppendOnly(pool)
}

/**
 * The audit log's append-only property is enforced by the database, not by
 * application discipline. A compromised or buggy service must not be able to
 * rewrite history.
 */
async function enforceAuditAppendOnly(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit_log is append-only; % is not permitted', TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `)

  await pool.query(`DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log`)
  await pool.query(`
    CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
  `)

  await pool.query(`DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log`)
  await pool.query(`
    CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
  `)
}
