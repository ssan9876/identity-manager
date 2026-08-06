import { beforeAll, describe, expect, it } from 'vitest'
import { AuditRepository } from '../src/audit/audit.repository'
import { AuditWriter } from '../src/audit/audit.writer'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

describe('audit log', () => {
  const ctx = withTestDatabase()
  let writer: AuditWriter
  let audit: AuditRepository
  let actorId: string

  // A single actor is created once for the whole file rather than reset with
  // beforeEach: audit_log is append-only, so once a row references this
  // user, the user can never be removed either (its foreign key is
  // onDelete: 'restrict' — see db/schema/audit-log.ts) — and audit_log
  // itself can never be cleared between tests (that is the property this
  // file exists to prove). Tests below compare against a baseline captured
  // at the start of each test, or rely on list()'s newest-first ordering,
  // rather than assuming a clean table.
  beforeAll(async () => {
    writer = new AuditWriter()
    audit = new AuditRepository(ctx.db)
    const orgUnits = new OrgUnitsRepository(ctx.db)
    const users = new UsersRepository(ctx.db)
    const root = await orgUnits.createRoot('Acme Corp')
    actorId = (
      await users.create({
        primaryEmail: 'ada@example.com',
        username: 'ada',
        firstName: 'Ada',
        lastName: 'Lovelace',
        orgUnitId: root.id,
      })
    ).id
  })

  it('records an entry with actor, action, resource and payloads', async () => {
    await ctx.db.transaction(async (tx) => {
      await writer.record(tx, {
        actorUserId: actorId,
        action: 'user:update',
        resourceType: 'user',
        resourceId: actorId,
        before: { jobTitle: null },
        after: { jobTitle: 'Engineer' },
      })
    })

    // limit: 1 rather than checking total table length — audit_log
    // accumulates across tests in this file (see the beforeAll comment
    // above), but list() orders newest-first and nothing else writes
    // concurrently, so the newest row is deterministically this test's own.
    const [newest] = await audit.list({ limit: 1, offset: 0 })
    expect(newest.action).toBe('user:update')
    expect(newest.resourceType).toBe('user')
    expect(newest.before).toEqual({ jobTitle: null })
    expect(newest.after).toEqual({ jobTitle: 'Engineer' })
  })

  it('allows a null actor for system-originated actions', async () => {
    await ctx.db.transaction(async (tx) => {
      await writer.record(tx, {
        actorUserId: null,
        action: 'user:deactivate',
        resourceType: 'user',
        resourceId: actorId,
        before: { status: 'active' },
        after: { status: 'deactivated' },
      })
    })

    const [newest] = await audit.list({ limit: 1, offset: 0 })
    expect(newest.actorUserId).toBeNull()
  })

  // ctx.pool/ctx.db run as the RUNTIME role (finding H1, docs/superpowers/
  // audit-integrity.md — test/support/pg.ts's withTestDatabase()). These
  // three now fail at the PRIVILEGE layer — Postgres checks table grants
  // before it ever invokes a BEFORE trigger — rather than the trigger's own
  // RAISE EXCEPTION, which is what they pinned before the role split. The
  // trigger is still very much alive underneath (see the dedicated "the
  // append-only trigger still blocks the OWNER role" describe below, which
  // is the only role for whom the trigger is actually the operative
  // defense, since an owner can always re-grant itself anything a REVOKE
  // takes away).
  it('refuses UPDATE at the database level (blocked by privilege — the runtime role has no UPDATE grant on audit_log)', async () => {
    await ctx.db.transaction(async (tx) => {
      await writer.record(tx, {
        actorUserId: actorId,
        action: 'user:read',
        resourceType: 'user',
        resourceId: actorId,
        before: null,
        after: null,
      })
    })

    await expect(
      ctx.pool.query(`UPDATE audit_log SET action = 'tampered'`),
    ).rejects.toThrow(/permission denied for table audit_log/i)
  })

  it('refuses DELETE at the database level (blocked by privilege — the runtime role has no DELETE grant on audit_log)', async () => {
    await ctx.db.transaction(async (tx) => {
      await writer.record(tx, {
        actorUserId: actorId,
        action: 'user:read',
        resourceType: 'user',
        resourceId: actorId,
        before: null,
        after: null,
      })
    })

    await expect(ctx.pool.query('DELETE FROM audit_log')).rejects.toThrow(
      /permission denied for table audit_log/i,
    )
  })

  it('refuses TRUNCATE at the database level (blocked by privilege — the runtime role has no TRUNCATE grant on audit_log)', async () => {
    const baseline = await audit.count()

    await ctx.db.transaction(async (tx) => {
      await writer.record(tx, {
        actorUserId: actorId,
        action: 'user:read',
        resourceType: 'user',
        resourceId: actorId,
        before: null,
        after: null,
      })
    })

    await expect(ctx.pool.query('TRUNCATE audit_log')).rejects.toThrow(
      /permission denied for table audit_log/i,
    )
    expect(await audit.count()).toBe(baseline + 1)
  })

  it('rolls back the audit entry when its enclosing transaction fails', async () => {
    const baseline = await audit.count()

    await expect(
      ctx.db.transaction(async (tx) => {
        await writer.record(tx, {
          actorUserId: actorId,
          action: 'user:update',
          resourceType: 'user',
          resourceId: actorId,
          before: null,
          after: { jobTitle: 'Engineer' },
        })
        throw new Error('mutation failed after the audit write')
      }),
    ).rejects.toThrow('mutation failed')

    expect(await audit.count()).toBe(baseline)
  })

  it('keeps the audit entry when its enclosing transaction commits', async () => {
    const baseline = await audit.count()

    await ctx.db.transaction(async (tx) => {
      await writer.record(tx, {
        actorUserId: actorId,
        action: 'user:update',
        resourceType: 'user',
        resourceId: actorId,
        before: null,
        after: { jobTitle: 'Engineer' },
      })
    })

    expect(await audit.count()).toBe(baseline + 1)
  })

  it('returns newest first and paginates', async () => {
    const baseline = await audit.count()

    for (const action of ['a', 'b', 'c']) {
      await ctx.db.transaction(async (tx) => {
        await writer.record(tx, {
          actorUserId: actorId,
          action,
          resourceType: 'user',
          resourceId: actorId,
          before: null,
          after: null,
        })
      })
    }

    const page = await audit.list({ limit: 2, offset: 0 })
    expect(page.map((row) => row.action)).toEqual(['c', 'b'])
    expect(await audit.count()).toBe(baseline + 3)
  })
})

/**
 * Finding H1 (docs/superpowers/audit-integrity.md): re-runs every bypass the
 * auditor demonstrated against the OLD single-role setup — where `idm` both
 * served runtime traffic and owned/could-alter its own schema — now that
 * `ctx.pool`/`ctx.db` (test/support/pg.ts's withTestDatabase()) are the
 * RUNTIME role: not a superuser, owns nothing, no CREATE on schema public.
 *
 * Each assertion pins the EXACT Postgres error, captured empirically against
 * a real Postgres (verified live, docs/superpowers/fix-wave-e-report.md) —
 * not guessed — because WHICH mechanism blocks a given statement differs and
 * is exactly the thing worth documenting:
 * - "permission denied for schema public": the runtime role has no CREATE
 *   on the schema, so it cannot bring a new/replacement object into being
 *   at all — this is what closes the function-hijack bypass, since
 *   CREATE OR REPLACE checks schema CREATE before it ever gets to an
 *   ownership check on the pre-existing function.
 * - "must be owner of table/relation audit_log": ALTER/DROP requires
 *   ownership outright: not having CREATE on the schema is enough to stop
 *   creating something, but ALTER/DROP on an EXISTING object is gated on
 *   owning that specific object, checked independently.
 * - "permission denied to set parameter": session_replication_role's GUC
 *   context is superuser-only; the runtime role is deliberately not one.
 * - "permission denied for table audit_log": ordinary DML privilege —
 *   UPDATE/DELETE/TRUNCATE were simply never granted here (db/roles.ts).
 */
describe('finding H1 — the runtime role cannot bypass append-only via DDL or ownership', () => {
  const ctx = withTestDatabase()

  it('function hijack — CREATE OR REPLACE FUNCTION audit_log_append_only() ... RETURN NULL — is blocked (no CREATE on schema public)', async () => {
    await expect(
      ctx.pool.query(`
        CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
        BEGIN RETURN NULL; END;
        $$ LANGUAGE plpgsql;
      `),
    ).rejects.toThrow(/permission denied for schema public/i)
  })

  it('ALTER TABLE audit_log DISABLE TRIGGER ALL is blocked (not the table owner)', async () => {
    await expect(ctx.pool.query('ALTER TABLE audit_log DISABLE TRIGGER ALL')).rejects.toThrow(
      /must be owner of table audit_log/i,
    )
  })

  it('ALTER TABLE audit_log ALTER COLUMN action TYPE ... USING ... (DDL rewrite) is blocked (not the table owner)', async () => {
    await expect(
      ctx.pool.query(`ALTER TABLE audit_log ALTER COLUMN action TYPE varchar(64) USING 'REDACTED'`),
    ).rejects.toThrow(/must be owner of table audit_log/i)
  })

  it('ALTER TABLE audit_log ALTER COLUMN before TYPE ... USING ... (wiping before-images) is blocked (not the table owner)', async () => {
    await expect(
      ctx.pool.query(`ALTER TABLE audit_log ALTER COLUMN before TYPE jsonb USING '{}'::jsonb`),
    ).rejects.toThrow(/must be owner of table audit_log/i)
  })

  it('ALTER TABLE audit_log DROP COLUMN before is blocked (not the table owner)', async () => {
    await expect(ctx.pool.query('ALTER TABLE audit_log DROP COLUMN before')).rejects.toThrow(
      /must be owner of table audit_log/i,
    )
  })

  it("SET session_replication_role = 'replica' is blocked (superuser-only parameter)", async () => {
    await expect(ctx.pool.query(`SET session_replication_role = 'replica'`)).rejects.toThrow(
      /permission denied to set parameter/i,
    )
  })

  it('DROP TRIGGER audit_log_no_delete ON audit_log is blocked (not the table owner)', async () => {
    await expect(
      ctx.pool.query('DROP TRIGGER audit_log_no_delete ON audit_log'),
    ).rejects.toThrow(/must be owner of relation audit_log/i)
  })

  it('DROP TABLE audit_log CASCADE is blocked (not the table owner)', async () => {
    await expect(ctx.pool.query('DROP TABLE audit_log CASCADE')).rejects.toThrow(
      /must be owner of table audit_log/i,
    )
  })

  it('the rename-and-swap opener (ALTER TABLE audit_log RENAME TO ...) is blocked at its first statement (not the table owner)', async () => {
    // The auditor's full bypass was RENAME the real table out of the way,
    // CREATE TABLE (LIKE ... INCLUDING ALL) under the original name, then
    // DROP the renamed original — proving the FIRST statement is rejected
    // is sufficient: the chain never gets any further.
    await expect(ctx.pool.query('ALTER TABLE audit_log RENAME TO audit_log_old')).rejects.toThrow(
      /must be owner of table audit_log/i,
    )
  })

  it('a rewriting CREATE OR REPLACE VIEW audit_log is blocked (no CREATE on schema public)', async () => {
    await expect(ctx.pool.query('CREATE OR REPLACE VIEW audit_log AS SELECT 1')).rejects.toThrow(
      /permission denied for schema public/i,
    )
  })

  it('shadowing audit_log with a NEW view is blocked (no CREATE on schema public)', async () => {
    await expect(
      ctx.pool.query('CREATE VIEW audit_log_shadow AS SELECT * FROM audit_log'),
    ).rejects.toThrow(/permission denied for schema public/i)
  })

  it('the upsert-shaped bypass (INSERT ... ON CONFLICT DO UPDATE) is now also blocked by privilege, not only by the trigger', async () => {
    // Previously blocked ONLY because the statement-level UPDATE trigger
    // fires for the DO UPDATE branch (docs/superpowers/audit-integrity.md's
    // "what I tried that did not work"). Postgres checks UPDATE privilege
    // for an ON CONFLICT DO UPDATE clause at permission-check time,
    // regardless of whether any row actually conflicts — so this is
    // rejected before the trigger is ever reached, same as a plain UPDATE.
    await expect(
      ctx.pool.query(`
        INSERT INTO audit_log (action, resource_type) VALUES ('probe', 'probe')
        ON CONFLICT (id) DO UPDATE SET action = 'tampered'
      `),
    ).rejects.toThrow(/permission denied for table audit_log/i)
  })

  it('grants the runtime role exactly SELECT and INSERT on audit_log — never UPDATE/DELETE/TRUNCATE', async () => {
    const { rows } = await ctx.pool.query<{ privilege_type: string }>(`
      SELECT privilege_type FROM information_schema.table_privileges
      WHERE table_schema = 'public' AND table_name = 'audit_log' AND grantee = current_user
      ORDER BY privilege_type
    `)
    expect(rows.map((row) => row.privilege_type)).toEqual(['INSERT', 'SELECT'])
  })

  it('grants the runtime role full SELECT/INSERT/UPDATE/DELETE on an ordinary table (users)', async () => {
    const { rows } = await ctx.pool.query<{ privilege_type: string }>(`
      SELECT privilege_type FROM information_schema.table_privileges
      WHERE table_schema = 'public' AND table_name = 'users' AND grantee = current_user
      ORDER BY privilege_type
    `)
    expect(rows.map((row) => row.privilege_type)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
  })

  it('the runtime role has no CREATE privilege on schema public', async () => {
    const { rows } = await ctx.pool.query<{ has_create: boolean }>(
      `SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS has_create`,
    )
    expect(rows[0]?.has_create).toBe(false)
  })

  it('the runtime role is not a superuser and owns no relation', async () => {
    const { rows } = await ctx.pool.query<{ rolsuper: boolean }>(
      `SELECT rolsuper FROM pg_roles WHERE rolname = current_user`,
    )
    expect(rows[0]?.rolsuper).toBe(false)

    const { rows: owned } = await ctx.pool.query<{ n: number }>(`
      SELECT count(*)::int AS n FROM pg_class
      WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
    `)
    expect(owned[0]?.n).toBe(0)
  })
})

/**
 * Finding H1: the runtime role's REVOKEd privileges are one of two
 * independent mechanisms — the append-only triggers (db/migrate.ts's
 * enforceAuditAppendOnly) are the other, and remain the operative defense
 * for anyone who legitimately holds table-owner-level DML, i.e. the OWNER
 * role itself. Ownership can never be meaningfully restricted by REVOKE (an
 * owner always retains implicit GRANT OPTION on its own object and can just
 * re-grant itself anything taken away), so privilege alone could never have
 * closed this for the owner — only the trigger can. This is what "two
 * independent mechanisms, so defeating one is not enough" means in practice:
 * even a role with EVERY privilege on audit_log still cannot rewrite history.
 */
describe('finding H1 — the append-only trigger still blocks the OWNER role directly (belt-and-braces)', () => {
  const ctx = withTestDatabase()

  it('UPDATE is blocked by the trigger even for the owner (who has implicit UPDATE on its own table)', async () => {
    await expect(
      ctx.ownerPool.query(`UPDATE audit_log SET action = 'tampered' WHERE false`),
    ).rejects.toThrow(/append-only/i)
  })

  it('DELETE is blocked by the trigger even for the owner (who has implicit DELETE on its own table)', async () => {
    await expect(ctx.ownerPool.query('DELETE FROM audit_log WHERE false')).rejects.toThrow(
      /append-only/i,
    )
  })

  it('TRUNCATE is blocked by the trigger even for the owner (who can always TRUNCATE a table it owns)', async () => {
    await expect(ctx.ownerPool.query('TRUNCATE audit_log')).rejects.toThrow(/append-only/i)
  })
})
