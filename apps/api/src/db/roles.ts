import type { Pool } from 'pg'

/**
 * Finding H1 (docs/archive/audits/audit-integrity.md): the audit log's
 * append-only guarantee rested on DML triggers alone, but the application's
 * own database role (`idm`) was BOTH superuser AND the owner of `audit_log`
 * — so it could simply redefine the guard (`CREATE OR REPLACE FUNCTION
 * audit_log_append_only() ... RETURN NULL`, one statement, leaving every
 * trigger present and `tgenabled = 'O'`) or bypass it entirely with DDL
 * (`ALTER TABLE ... ALTER COLUMN ... TYPE ... USING ...` rewrites every row
 * and fires no DML trigger at all — the same class as the shipped TRUNCATE
 * gap). A DML trigger cannot defend against a role that can redefine the
 * trigger function or rewrite the table out from under it.
 *
 * This module makes the guarantee real by making it a PRIVILEGE property,
 * not just a trigger property: the RUNTIME role the application and sync
 * worker actually connect as is provisioned here with no ownership of
 * anything, no CREATE on the schema (so it can never ALTER/DROP/CREATE OR
 * REPLACE any object, including `audit_log_append_only()` itself or
 * `audit_log` itself), and only the DML it needs — full SELECT/INSERT/
 * UPDATE/DELETE on ordinary tables, but only SELECT/INSERT on `audit_log`.
 * Revoking UPDATE/DELETE/TRUNCATE there is deliberately belt-and-braces
 * alongside `enforceAuditAppendOnly`'s triggers (db/migrate.ts): two
 * independent mechanisms, so defeating one is not enough. See
 * docs/archive/audits/fix-wave-e-report.md for the full bypass-by-bypass proof.
 */

export interface RuntimeRoleCredentials {
  username: string
  password: string
}

/**
 * Pulls `{ username, password }` out of a `postgres://user:pass@host/db`
 * connection string — used to derive the RUNTIME role's identity from
 * `RUNTIME_DATABASE_URL` itself, so that string is the single source of
 * truth for who the role is and `db:migrate` (connected as the OWNER) can
 * provision exactly that role, rather than the role's identity being
 * declared twice (once in the connection string, once in migration config)
 * and risking drift between them.
 */
export function parseRoleCredentials(connectionString: string): RuntimeRoleCredentials {
  const url = new URL(connectionString)
  if (!url.username) {
    throw new Error(`connection string has no username: ${connectionString}`)
  }
  return {
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  }
}

/** Safe Postgres identifier quoting (mirrors `quote_ident`) — doubles embedded `"`. */
function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/** Safe Postgres string-literal quoting (mirrors `quote_literal`) — doubles embedded `'`. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

// Explicit, even where some are already CREATE ROLE's own default (NOSUPERUSER,
// NOCREATEDB, NOCREATEROLE) — the point of this role is precisely that none of
// these are true of it, so the SQL itself should say so, not rely on defaults
// a future Postgres version or a hand-edited role could quietly change.
const RUNTIME_ROLE_ATTRIBUTES = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'

/**
 * Idempotently provisions the RUNTIME role and grants it exactly the
 * privileges the application needs — nothing more. Must be called with a
 * `pool` connected as the OWNER role: creating/altering a role and granting
 * privileges on tables the caller does not own both require it.
 *
 * Safe to call on every `db:migrate` run:
 * - `CREATE ROLE` only fires when the role doesn't exist yet; either way the
 *   password and attributes are re-asserted, so rotating
 *   `RUNTIME_DATABASE_URL`'s password takes effect on the next migrate run.
 * - Every GRANT/REVOKE below is naturally idempotent (re-granting an
 *   already-held privilege, or revoking one never granted, is a no-op).
 * - The table list is read fresh from `pg_tables` every call, so a table
 *   added by a future migration is picked up automatically the next time
 *   `db:migrate` runs — no separate table registry to keep in sync with
 *   `db/schema/index.ts`.
 */
export async function provisionRuntimeRole(pool: Pool, credentials: RuntimeRoleCredentials): Promise<void> {
  const role = quoteIdent(credentials.username)
  const password = quoteLiteral(credentials.password)

  const { rows: existing } = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
    credentials.username,
  ])
  if (existing.length === 0) {
    await pool.query(`CREATE ROLE ${role} ${RUNTIME_ROLE_ATTRIBUTES} PASSWORD ${password}`)
  } else {
    await pool.query(`ALTER ROLE ${role} WITH ${RUNTIME_ROLE_ATTRIBUTES} PASSWORD ${password}`)
  }

  const {
    rows: [{ current_database: database }],
  } = await pool.query<{ current_database: string }>('SELECT current_database()')

  // Belt-and-braces: CONNECT/USAGE on a freshly created database are already
  // granted to PUBLIC by default, so these are normally no-ops — but being
  // explicit means this role's access does not silently depend on a default
  // that a hardened template (or a future Postgres version) might revoke.
  await pool.query(`GRANT CONNECT ON DATABASE ${quoteIdent(database)} TO ${role}`)
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`)
  // Deliberately NO "GRANT CREATE ON SCHEMA public" — this is the privilege
  // that would let the runtime role create or replace ANY object, including
  // redefining `audit_log_append_only()` under a non-owner identity. Without
  // it, and without owning anything, the runtime role cannot ALTER, DROP, or
  // CREATE OR REPLACE a single object in this schema.

  const { rows: tables } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  )
  for (const { tablename } of tables) {
    const table = quoteIdent(tablename)
    if (tablename === 'audit_log') {
      // The one deliberate exception: append-only in practice, not just in
      // name. UPDATE/DELETE/TRUNCATE are explicitly revoked (never granted
      // in the first place, but revoked anyway so `\dp audit_log` shows the
      // restriction rather than relying on it never having been granted).
      await pool.query(`GRANT SELECT, INSERT ON TABLE ${table} TO ${role}`)
      await pool.query(`REVOKE UPDATE, DELETE, TRUNCATE ON TABLE ${table} FROM ${role}`)
    } else {
      await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${table} TO ${role}`)
    }
  }

  // Every bigserial primary key (audit_log.id, outbox_events.id) needs the
  // owning sequence's USAGE privilege for its DEFAULT nextval() to fire on
  // INSERT; SELECT is added too so the current value can be read back/
  // inspected. Applied blanket, across all sequences in the schema — a
  // sequence has no data-confidentiality property of its own the way
  // audit_log's ROWS do, so there is no equivalent restriction to carve out
  // here the way there is for tables.
  await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`)
}
