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
//
// CREATE only. This string must NOT be reused on ALTER — see
// `assertRuntimeRoleNotEscalated` below for why that is impossible on
// PostgreSQL 16 and what replaces it.
const RUNTIME_ROLE_ATTRIBUTES = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'

/**
 * The attributes the runtime role must NOT have, and the `pg_roles` column
 * that reports each. Kept beside RUNTIME_ROLE_ATTRIBUTES so the two cannot
 * drift: everything asserted at CREATE is verified here on every later run.
 */
const FORBIDDEN_RUNTIME_ATTRIBUTES = [
  ['rolsuper', 'SUPERUSER'],
  ['rolcreatedb', 'CREATEDB'],
  ['rolcreaterole', 'CREATEROLE'],
] as const

/**
 * Verifies — rather than re-asserts — that the runtime role has not been
 * escalated.
 *
 * The original code re-ran the full `RUNTIME_ROLE_ATTRIBUTES` string as
 * `ALTER ROLE ... WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE` on every
 * migrate. On PostgreSQL 16 that is IMPOSSIBLE for the owner role this
 * project deploys with, and it fails closed:
 *
 *     ERROR: permission denied to alter role
 *     DETAIL: Only roles with the SUPERUSER attribute may change the
 *             SUPERUSER attribute.
 *
 * PG16 tightened `CREATEROLE`: it may now only set attributes the altering
 * role itself holds. `idm_owner` is deliberately NOSUPERUSER/NOCREATEDB, so
 * it may not name SUPERUSER or CREATEDB in an ALTER — not even to set them to
 * the negative. `CREATE ROLE` with the same words is still fine, which is why
 * a fresh install works and only the SECOND migrate fails. Found by running
 * `pnpm db:migrate` against a real deployed container (Proxmox ct:101 clone,
 * PostgreSQL 16.14) rather than a throwaway test database, where the role is
 * always created fresh and the ALTER branch never runs.
 *
 * Verifying is also strictly stronger than the SET it replaces. `ALTER ROLE`
 * assumed the write succeeded and reported nothing; reading `pg_roles` and
 * refusing to migrate actually DETECTS a hand-escalated runtime role, which
 * is the threat the original comment names.
 */
async function assertRuntimeRoleNotEscalated(pool: Pool, username: string): Promise<void> {
  const {
    rows: [row],
  } = await pool.query<Record<string, boolean>>(
    'SELECT rolsuper, rolcreatedb, rolcreaterole, rolcanlogin FROM pg_roles WHERE rolname = $1',
    [username],
  )

  if (row === undefined) {
    throw new Error(`runtime role "${username}" vanished between existence check and verification`)
  }

  const escalated = FORBIDDEN_RUNTIME_ATTRIBUTES.filter(([column]) => row[column]).map(
    ([, label]) => label,
  )

  if (escalated.length > 0) {
    throw new Error(
      `runtime role "${username}" has been escalated: it holds ${escalated.join(', ')}. ` +
        'Migrations refuse to run against an over-privileged runtime role (finding H1). ' +
        `Revoke with: ALTER ROLE ${quoteIdent(username)} WITH ${RUNTIME_ROLE_ATTRIBUTES.replace('LOGIN ', '')} ` +
        '(as a superuser), then re-run.',
    )
  }

  if (!row.rolcanlogin) {
    throw new Error(
      `runtime role "${username}" cannot log in (NOLOGIN). The application would fail to start; ` +
        `fix with: ALTER ROLE ${quoteIdent(username)} WITH LOGIN`,
    )
  }
}

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
    // PASSWORD only — never the attribute string. Re-asserting the password
    // is what makes rotating RUNTIME_DATABASE_URL take effect on the next
    // migrate; re-asserting the attributes is not possible here at all (see
    // assertRuntimeRoleNotEscalated) and used to make every migrate after the
    // first fail outright.
    await pool.query(`ALTER ROLE ${role} WITH PASSWORD ${password}`)
  }

  // Runs on BOTH paths: a role this function just created should trivially
  // pass, and saying so costs one cheap catalog read.
  await assertRuntimeRoleNotEscalated(pool, credentials.username)

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

  // READ-ONLY access to drizzle's applied-migration ledger, for
  // `health/readiness.controller.ts`. The readiness probe answers "is this
  // instance's schema at the version its code was built for", which it can
  // only do by reading this table — and it runs on the RUNTIME connection
  // (app.module.ts's DB_CLIENT), which by design holds nothing outside
  // `public`, not even USAGE on this schema. Without these two grants the
  // probe would answer `migrations: 'unknown'` on every healthy instance in
  // production while passing against any owner-privileged handle, which is
  // the worst kind of green test.
  //
  // SELECT only, and on this one table only: nothing here weakens finding
  // H1's posture. The role still owns nothing, still has no CREATE on any
  // schema, and still cannot write to (or through) the ledger — reading
  // which migrations ran grants no ability to change what ran.
  //
  // Guarded on existence because `provisionRuntimeRole` is also reachable
  // before drizzle has ever created the ledger (`runMigrations` returns
  // early when no journal has been generated yet), and a GRANT on a missing
  // object is an error, not a no-op.
  const { rows: ledger } = await pool.query(
    `SELECT 1 FROM pg_tables WHERE schemaname = 'drizzle' AND tablename = '__drizzle_migrations'`,
  )
  if (ledger.length > 0) {
    await pool.query(`GRANT USAGE ON SCHEMA drizzle TO ${role}`)
    await pool.query(`GRANT SELECT ON TABLE drizzle.__drizzle_migrations TO ${role}`)
  }
}
