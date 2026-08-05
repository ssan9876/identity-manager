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

  it('refuses UPDATE at the database level', async () => {
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
    ).rejects.toThrow(/append-only/i)
  })

  it('refuses DELETE at the database level', async () => {
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

    await expect(ctx.pool.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/i)
  })

  it('refuses TRUNCATE at the database level', async () => {
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

    await expect(ctx.pool.query('TRUNCATE audit_log')).rejects.toThrow(/append-only/i)
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
