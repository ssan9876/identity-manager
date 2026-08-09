import { describe, expect, it, vi } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { BulkActivateJob } from '../src/users/bulk-activate.job'
import { type User, UsersRepository } from '../src/users/users.repository'
import { type TestDatabase, withTestDatabase } from './support/pg'

interface AuditLogRow {
  actor_user_id: string | null
  action: string
}

async function auditRowsFor(ctx: TestDatabase, resourceId: string): Promise<AuditLogRow[]> {
  const { rows } = await ctx.pool.query<AuditLogRow>(
    "SELECT actor_user_id, action FROM audit_log WHERE resource_type = 'user' AND resource_id = $1 ORDER BY id ASC",
    [resourceId],
  )
  return rows
}

async function outboxRowsFor(
  ctx: TestDatabase,
  aggregateId: string,
): Promise<{ event_type: string; payload: Record<string, unknown> }[]> {
  const { rows } = await ctx.pool.query<{ event_type: string; payload: Record<string, unknown> }>(
    "SELECT event_type, payload FROM outbox_events WHERE aggregate_type = 'user' AND aggregate_id = $1 ORDER BY id ASC",
    [aggregateId],
  )
  return rows
}

/**
 * The backfill half of activation. `POST /users/:id/activate` handles one
 * person at a time from the console; this handles the 441-row case that
 * motivated it (see docs/archive/specs/2026-08-08-user-activate-endpoint-design.md,
 * whose "Out of scope" section named bulk activation before the data showed
 * how many users were actually stranded).
 *
 * Postgres only — no Keycloak container, unlike jml-lifecycle.job.spec.ts.
 * This job makes no Keycloak call by design; propagation is the outbox's
 * job, exactly as with the single-user endpoint.
 */
describe('BulkActivateJob', () => {
  const ctx = withTestDatabase()

  const usersRepo = () => new UsersRepository(ctx.db)
  const orgUnitsRepo = () => new OrgUnitsRepository(ctx.db)
  const makeJob = () => new BulkActivateJob(usersRepo(), new AuditWriter(), new OutboxWriter(), ctx.db)

  let tag = 0
  const nextTag = () => `ba${Date.now().toString(36)}${tag++}`

  async function makePendingUser(orgUnitId: string): Promise<User> {
    const t = nextTag()
    return usersRepo().create({
      primaryEmail: `${t}@example.com`,
      username: t,
      firstName: 'Test',
      lastName: 'User',
      orgUnitId,
    })
  }

  it('reports candidates without mutating anything when apply is false', async () => {
    const org = await orgUnitsRepo().createRoot(`BulkDry ${nextTag()}`)
    const target = await makePendingUser(org.id)

    const report = await makeJob().run({ scopePath: org.path, apply: false })

    expect(report.dryRun).toBe(true)
    expect(report.candidates).toBe(1)
    expect(report.activatedUserIds).toEqual([])

    // The whole point of a dry run: nothing moved.
    const after = await usersRepo().findById(target.id)
    expect(after?.status).toBe('pending')
    expect(await auditRowsFor(ctx, target.id)).toHaveLength(0)
    expect(await outboxRowsFor(ctx, target.id)).toHaveLength(0)
  })

  it('activates every pending user in scope, with an audit row and an outbox event each', async () => {
    const org = await orgUnitsRepo().createRoot(`BulkApply ${nextTag()}`)
    const first = await makePendingUser(org.id)
    const second = await makePendingUser(org.id)

    const report = await makeJob().run({ scopePath: org.path, apply: true })

    expect(report.dryRun).toBe(false)
    expect(report.candidates).toBe(2)
    expect(report.activatedUserIds.sort()).toEqual([first.id, second.id].sort())
    expect(report.skipped).toEqual([])

    for (const user of [first, second]) {
      expect((await usersRepo().findById(user.id))?.status).toBe('active')

      const audit = await auditRowsFor(ctx, user.id)
      expect(audit).toHaveLength(1)
      expect(audit[0].action).toBe('user:bulk_activate')
      // System-originated: no human actor, same as LifecycleJob's rows.
      expect(audit[0].actor_user_id).toBeNull()

      const outbox = await outboxRowsFor(ctx, user.id)
      expect(outbox).toHaveLength(1)
      expect(outbox[0].event_type).toBe('status_changed')
      expect(outbox[0].payload.status).toBe('active')
      expect(outbox[0].payload.action).toBe('user:bulk_activate')
    }
  })

  it('leaves users outside the given org-unit subtree alone', async () => {
    const root = await orgUnitsRepo().createRoot(`BulkScope ${nextTag()}`)
    const inScope = await orgUnitsRepo().createChild(root.id, `In ${nextTag()}`)
    const outOfScope = await orgUnitsRepo().createRoot(`BulkOther ${nextTag()}`)
    const included = await makePendingUser(inScope.id)
    const excluded = await makePendingUser(outOfScope.id)

    const report = await makeJob().run({ scopePath: root.path, apply: true })

    // The child's user is included — this is a SUBTREE match, not an exact
    // org-unit-id match.
    expect(report.activatedUserIds).toContain(included.id)
    expect(report.activatedUserIds).not.toContain(excluded.id)
    expect((await usersRepo().findById(excluded.id))?.status).toBe('pending')
  })

  it('activates every pending user in the directory when no scope is given', async () => {
    const org = await orgUnitsRepo().createRoot(`BulkAll ${nextTag()}`)
    const target = await makePendingUser(org.id)

    const report = await makeJob().run({ apply: true })

    expect(report.activatedUserIds).toContain(target.id)
    expect((await usersRepo().findById(target.id))?.status).toBe('active')
  })

  it('never selects a deactivated user, so a terminal row cannot be resurrected', async () => {
    const org = await orgUnitsRepo().createRoot(`BulkTerminal ${nextTag()}`)
    const gone = await makePendingUser(org.id)
    await usersRepo().changeStatus(gone.id, 'deactivated')

    const report = await makeJob().run({ scopePath: org.path, apply: true })

    expect(report.candidates).toBe(0)
    expect(report.activatedUserIds).toEqual([])
    expect((await usersRepo().findById(gone.id))?.status).toBe('deactivated')
  })

  it('records a skip and keeps going when a candidate moves on mid-run', async () => {
    const org = await orgUnitsRepo().createRoot(`BulkRace ${nextTag()}`)
    const racer = await makePendingUser(org.id)
    const healthy = await makePendingUser(org.id)

    const repo = usersRepo()
    const job = new BulkActivateJob(repo, new AuditWriter(), new OutboxWriter(), ctx.db)

    // The benign race the job must survive: a row is selected as `pending`,
    // then moves on before its own transaction opens, so changeStatus
    // refuses it. Reproduced by freezing the selection — capture the
    // candidate list, let reality move past it, then hand the job that
    // now-stale list. Deactivating before run() would prove nothing: the
    // selector simply would not return the row, so there would be no skip
    // to record and the catch branch would never be exercised at all.
    const candidates = await repo.listPending(org.path)
    expect(candidates).toHaveLength(2)
    await repo.changeStatus(racer.id, 'deactivated')
    vi.spyOn(repo, 'listPending').mockResolvedValue(candidates)

    const report = await job.run({ scopePath: org.path, apply: true })

    expect(report.activatedUserIds).toEqual([healthy.id])
    expect(report.skipped).toHaveLength(1)
    expect(report.skipped[0].userId).toBe(racer.id)
    expect(report.skipped[0].reason).toContain('terminal')
  })
})
