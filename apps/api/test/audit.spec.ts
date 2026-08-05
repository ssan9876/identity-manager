import { beforeEach, describe, expect, it } from 'vitest'
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

  beforeEach(async () => {
    await ctx.pool.query('TRUNCATE TABLE audit_log, users, org_units CASCADE')
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
    await writer.record(ctx.db, {
      actorUserId: actorId,
      action: 'user:update',
      resourceType: 'user',
      resourceId: actorId,
      before: { jobTitle: null },
      after: { jobTitle: 'Engineer' },
    })

    const rows = await audit.list({ limit: 10, offset: 0 })
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('user:update')
    expect(rows[0].resourceType).toBe('user')
    expect(rows[0].before).toEqual({ jobTitle: null })
    expect(rows[0].after).toEqual({ jobTitle: 'Engineer' })
  })

  it('allows a null actor for system-originated actions', async () => {
    await writer.record(ctx.db, {
      actorUserId: null,
      action: 'user:deactivate',
      resourceType: 'user',
      resourceId: actorId,
      before: { status: 'active' },
      after: { status: 'deactivated' },
    })

    const rows = await audit.list({ limit: 10, offset: 0 })
    expect(rows[0].actorUserId).toBeNull()
  })

  it('refuses UPDATE at the database level', async () => {
    await writer.record(ctx.db, {
      actorUserId: actorId,
      action: 'user:read',
      resourceType: 'user',
      resourceId: actorId,
      before: null,
      after: null,
    })

    await expect(
      ctx.pool.query(`UPDATE audit_log SET action = 'tampered'`),
    ).rejects.toThrow(/append-only/i)
  })

  it('refuses DELETE at the database level', async () => {
    await writer.record(ctx.db, {
      actorUserId: actorId,
      action: 'user:read',
      resourceType: 'user',
      resourceId: actorId,
      before: null,
      after: null,
    })

    await expect(ctx.pool.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/i)
  })

  it('rolls back the audit entry when its enclosing transaction fails', async () => {
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

    expect(await audit.count()).toBe(0)
  })

  it('keeps the audit entry when its enclosing transaction commits', async () => {
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

    expect(await audit.count()).toBe(1)
  })

  it('returns newest first and paginates', async () => {
    for (const action of ['a', 'b', 'c']) {
      await writer.record(ctx.db, {
        actorUserId: actorId,
        action,
        resourceType: 'user',
        resourceId: actorId,
        before: null,
        after: null,
      })
    }

    const page = await audit.list({ limit: 2, offset: 0 })
    expect(page.map((row) => row.action)).toEqual(['c', 'b'])
    expect(await audit.count()).toBe(3)
  })
})
