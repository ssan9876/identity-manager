import { existsSync } from 'node:fs'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type { Pool } from 'pg'
import { provisionRuntimeRole, type RuntimeRoleCredentials } from './roles'

const REQUIRED_EXTENSIONS = ['ltree'] as const

/**
 * Resolved from the working directory rather than `__dirname`, because this
 * module runs under both tsx (CommonJS, `__dirname` defined) and Vitest's SWC
 * transform (ES modules, `__dirname` undefined). Every script that loads it
 * runs with apps/api as the working directory.
 */
export const MIGRATIONS_FOLDER = path.resolve(process.cwd(), 'src/db/migrations')

/**
 * `pool` must be connected as the OWNER role — applying schema migrations,
 * (re)defining `audit_log_append_only()`, and provisioning the RUNTIME role
 * (`db/roles.ts`) all require owning the objects involved. `runtimeRole` is
 * a required argument, not an optional one with a skip-if-absent default:
 * the whole point of finding H1's fix is that the runtime role's privileges
 * are asserted every time migrations run, not something a caller can forget
 * to pass. `migrate-cli.ts` derives it from `RUNTIME_DATABASE_URL`;
 * `test/support/pg.ts` passes the throwaway container's own test role.
 */
export async function runMigrations(pool: Pool, runtimeRole: RuntimeRoleCredentials): Promise<void> {
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

  // Finding H1 (docs/archive/audits/audit-integrity.md): re-asserted last, on
  // every migrate run, so the runtime role's restricted privileges — and
  // its total lack of ownership/CREATE — can never silently drift from what
  // this function just created, and so a table added by a future migration
  // is granted to it automatically (provisionRuntimeRole reads the table
  // list fresh from pg_tables rather than a hardcoded registry).
  await provisionRuntimeRole(pool, runtimeRole)
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

  // TRUNCATE bypasses row-oriented DELETE triggers entirely — Postgres fires
  // a separate BEFORE TRUNCATE event, which needs its own trigger. The owning
  // role (the same `idm` role migrations and the app runtime both connect
  // as) can always TRUNCATE a table it owns, so this cannot be closed by
  // revoking a privilege; it must be a trigger, like UPDATE/DELETE above.
  await pool.query(`DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log`)
  await pool.query(`
    CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
  `)
}
