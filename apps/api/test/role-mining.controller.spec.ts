import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { and, eq } from 'drizzle-orm'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { BusinessRolesController } from '../src/business-roles/business-roles.controller'
import { BusinessRolesRepository } from '../src/business-roles/business-roles.repository'
import { RoleReconciler } from '../src/business-roles/role-reconciler'
import { RoleReconciliationJob } from '../src/business-roles/role-reconciliation.job'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { auditLog } from '../src/db/schema/audit-log'
import { businessRoleConditions } from '../src/db/schema/business-roles'
import { groupUserMembers } from '../src/db/schema/group-members'
import { groups } from '../src/db/schema/groups'
import { orgUnits } from '../src/db/schema/org-units'
import { users } from '../src/db/schema/users'
import { OrganizationsRepository } from '../src/organizations/organizations.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { UsersRepository, type User } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

/** Same technique as business-roles.controller.spec.ts. */
function stubJwtGuard(getUsername: () => string): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
        subject: 'role-mining-test',
        username: getUsername(),
        email: null,
      }
      return true
    },
  }
}

/**
 * ROLE MINING through the API — the analysis route and the adopt-as-draft
 * route, against a real Postgres, with `PermissionGuard`/`PermissionEngine`
 * running for real (only `JwtGuard` is stubbed, exactly as
 * business-roles.controller.spec.ts does).
 *
 * FIXTURE ISOLATION: one container per test FILE, nothing truncated between
 * `it` blocks — so every value a fixture keys on carries a per-call sequence
 * number, per the warning in business-roles.controller.spec.ts.
 */
describe('Role mining API', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let currentUsername = ''
  let organizationId = ''
  let rootOrgUnitId = ''
  let salesOrgUnitId = ''
  let globalAdmin: User

  beforeAll(async () => {
    organizationId = (await new OrganizationsRepository(ctx.db).findMaster()).id
    const stamp = Date.now()
    const [root] = await ctx.db
      .insert(orgUnits)
      .values({ name: `Mine Root ${stamp}`, path: `mine_root_${stamp}`, organizationId })
      .returning()
    const [sales] = await ctx.db
      .insert(orgUnits)
      .values({
        name: `Mine Sales ${stamp}`,
        path: `mine_root_${stamp}.sales`,
        parentId: root.id,
        organizationId,
      })
      .returning()
    rootOrgUnitId = root.id
    salesOrgUnitId = sales.id

    const moduleRef = await Test.createTestingModule({
      controllers: [BusinessRolesController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        BusinessRolesRepository,
        RoleReconciler,
        RoleReconciliationJob,
        UsersRepository,
        AuditWriter,
        OutboxWriter,
        PermissionEngine,
        PermissionGuard,
        Reflector,
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue(stubJwtGuard(() => currentUsername))
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()

    globalAdmin = await makeActiveUser('super_admin')
  })

  afterAll(async () => {
    await app?.close()
  })

  let seq = 0
  function nextSeq(): number {
    seq += 1
    return seq
  }

  const usersRepo = () => new UsersRepository(ctx.db)
  const rolesRepo = () => new RoleAssignmentsRepository(ctx.db)

  async function makeActiveUser(
    roleKey?: 'super_admin' | 'read_only',
    scopeOrgUnitId: string | null = null,
    orgUnitId?: string,
  ): Promise<User> {
    const tag = `mine${nextSeq()}-${Date.now()}`
    const created = await usersRepo().create({
      primaryEmail: `${tag}@example.com`,
      username: `${tag}@example.com`,
      firstName: 'Mining',
      lastName: `Fixture ${tag}`,
      orgUnitId: orgUnitId ?? rootOrgUnitId,
    })
    const active = await usersRepo().changeStatus(created.id, 'active')
    if (roleKey !== undefined) {
      await rolesRepo().assign({ userId: active.id, roleKey, scopeOrgUnitId })
    }
    return active
  }

  function as(actor: User): void {
    currentUsername = actor.username
  }

  /**
   * A group whose MANUAL membership perfectly tracks a per-call job title:
   * three matching members (in the sales subtree) plus two non-members with a
   * different title. The clean 1.0/1.0 recommendation case.
   */
  async function seedMinableGroup(): Promise<{
    groupId: string
    jobTitle: string
    memberIds: string[]
  }> {
    const n = nextSeq()
    const jobTitle = `Mined Engineer #${n}-${Date.now()}`
    const [group] = await ctx.db
      .insert(groups)
      .values({ name: `Mined Group ${n}-${Date.now()}`, organizationId })
      .returning()

    const memberIds: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const member = await makeActiveUser(undefined, null, salesOrgUnitId)
      await ctx.db.update(users).set({ jobTitle }).where(eq(users.id, member.id))
      await ctx.db.insert(groupUserMembers).values({
        groupId: group.id,
        userId: member.id,
        organizationId,
        grantSource: 'manual',
      })
      memberIds.push(member.id)
    }

    for (let i = 0; i < 2; i += 1) {
      const outsider = await makeActiveUser()
      await ctx.db
        .update(users)
        .set({ jobTitle: `Bystander #${n}-${i}` })
        .where(eq(users.id, outsider.id))
    }

    return { groupId: group.id, jobTitle, memberIds }
  }

  it('requires business_role:manage held GLOBALLY — no role, read-only and scoped-admin callers are all refused', async () => {
    as(await makeActiveUser())
    await request(app.getHttpServer()).get('/business-roles/mining/recommendations').expect(403)

    as(await makeActiveUser('read_only'))
    await request(app.getHttpServer()).get('/business-roles/mining/recommendations').expect(403)

    const scoped = await makeActiveUser('super_admin', salesOrgUnitId)
    as(scoped)
    await request(app.getHttpServer()).get('/business-roles/mining/recommendations').expect(403)
    await request(app.getHttpServer())
      .post('/business-roles/mining/drafts')
      .send({ name: 'nope', groupId: scoped.id, conditions: [] })
      .expect(403)
  })

  it('rejects unknown query parameters (Zod .strict()) and out-of-range thresholds with 400', async () => {
    as(globalAdmin)
    await request(app.getHttpServer())
      .get('/business-roles/mining/recommendations')
      .query({ minPrecison: 0.9 }) // typo on purpose
      .expect(400)
    await request(app.getHttpServer())
      .get('/business-roles/mining/recommendations')
      .query({ minPrecision: 1.5 })
      .expect(400)
  })

  it('404s a scope org unit that does not exist rather than mining a silently-empty population', async () => {
    as(globalAdmin)
    await request(app.getHttpServer())
      .get('/business-roles/mining/recommendations')
      .query({ scopeOrgUnitId: '00000000-0000-4000-8000-000000000000' })
      .expect(404)
  })

  it('recommends the aligned formula with exact scores and residuals, and writes nothing', async () => {
    const { groupId, jobTitle, memberIds } = await seedMinableGroup()
    const membershipsBefore = await ctx.db
      .select()
      .from(groupUserMembers)
      .where(eq(groupUserMembers.groupId, groupId))

    as(globalAdmin)
    const response = await request(app.getHttpServer())
      .get('/business-roles/mining/recommendations')
      .expect(200)

    expect(response.body.scannedUsers).toBeGreaterThanOrEqual(5)
    expect(response.body.params).toMatchObject({
      minPrecision: 0.9,
      minCoverage: 0.8,
      scopeOrgUnitId: null,
    })

    const rec = response.body.recommendations.find(
      (r: { groupId: string }) => r.groupId === groupId,
    )
    expect(rec).toBeDefined()
    expect(rec.memberCount).toBe(3)

    const candidate = rec.candidates.find(
      (c: { conditions: { field: string; value: unknown }[] }) =>
        c.conditions.length === 1 &&
        c.conditions[0].field === 'jobTitle' &&
        c.conditions[0].value === jobTitle,
    )
    expect(candidate).toBeDefined()
    expect(candidate.precision).toBe(1)
    expect(candidate.coverage).toBe(1)
    expect(candidate.cohortSize).toBe(3)
    expect(candidate.matchedCount).toBe(3)
    expect(candidate.gained).toEqual({ count: 0, sample: [], truncated: false })
    expect(candidate.lost).toEqual({ count: 0, sample: [], truncated: false })
    expect(candidate.conditions[0].operator).toBe('equals')

    // Read-only: the analysis changed no membership row.
    const membershipsAfter = await ctx.db
      .select()
      .from(groupUserMembers)
      .where(eq(groupUserMembers.groupId, groupId))
    expect(membershipsAfter).toEqual(membershipsBefore)
    expect(membershipsAfter.map((m) => m.userId).sort()).toEqual([...memberIds].sort())
  })

  it('surfaces gained/lost residuals when the cohort and membership disagree', async () => {
    const { groupId, jobTitle } = await seedMinableGroup()
    // A fourth person with the mined title who is NOT a member — the honest
    // "adopting this grants somebody new" case.
    const extra = await makeActiveUser()
    await ctx.db.update(users).set({ jobTitle }).where(eq(users.id, extra.id))

    as(globalAdmin)
    const response = await request(app.getHttpServer())
      .get('/business-roles/mining/recommendations')
      .query({ minPrecision: 0.7, minCoverage: 0.7 })
      .expect(200)

    const rec = response.body.recommendations.find(
      (r: { groupId: string }) => r.groupId === groupId,
    )
    const candidate = rec.candidates.find(
      (c: { conditions: { field: string; value: unknown }[] }) =>
        c.conditions.length === 1 && c.conditions[0].value === jobTitle,
    )
    expect(candidate).toBeDefined()
    expect(candidate.precision).toBe(3 / 4)
    expect(candidate.coverage).toBe(1)
    expect(candidate.gained.count).toBe(1)
    expect(candidate.gained.sample).toEqual([{ userId: extra.id, username: extra.username }])
    expect(candidate.lost.count).toBe(0)
  })

  it('scoping by org unit narrows the population to that subtree', async () => {
    const { groupId, jobTitle } = await seedMinableGroup()
    // Same title OUTSIDE the sales subtree: unscoped precision drops, scoped stays perfect.
    const outsideTwin = await makeActiveUser()
    await ctx.db.update(users).set({ jobTitle }).where(eq(users.id, outsideTwin.id))

    as(globalAdmin)
    const scoped = await request(app.getHttpServer())
      .get('/business-roles/mining/recommendations')
      .query({ scopeOrgUnitId: salesOrgUnitId })
      .expect(200)

    const rec = scoped.body.recommendations.find((r: { groupId: string }) => r.groupId === groupId)
    expect(rec).toBeDefined()
    const candidate = rec.candidates.find(
      (c: { conditions: { value: unknown }[] }) =>
        c.conditions.length === 1 && c.conditions[0].value === jobTitle,
    )
    expect(candidate).toBeDefined()
    expect(candidate.precision).toBe(1)
    // The out-of-scope twin exists but was never counted.
    expect(candidate.cohortSize).toBe(3)
  })

  it('adopts a recommendation as a DRAFT through the existing gate: created disabled, unpublished, audited, affecting nobody', async () => {
    const { groupId, jobTitle, memberIds } = await seedMinableGroup()
    const n = nextSeq()
    const name = `Mined role #${n}-${Date.now()}`

    as(globalAdmin)
    const created = await request(app.getHttpServer())
      .post('/business-roles/mining/drafts')
      .send({
        name,
        description: 'Recommended by role mining',
        groupId,
        conditions: [{ field: 'jobTitle', operator: 'equals', value: jobTitle }],
      })
      .expect(201)

    const roleId: string = created.body.id
    // A DRAFT and nothing more: disabled, nothing published, not simulated.
    expect(created.body.enabled).toBe(false)
    expect(created.body.simulatedAt).toBeNull()
    expect(created.body.conditions).toEqual([])
    expect(created.body.grants).toEqual([])
    expect(created.body.draftDefinition).toEqual({
      conditions: [{ field: 'jobTitle', operator: 'equals', value: jobTitle }],
      grants: [{ kind: 'group_membership', groupId, target: null }],
    })

    // No membership moved — the members' rows are still the manual ones.
    const memberships = await ctx.db
      .select()
      .from(groupUserMembers)
      .where(eq(groupUserMembers.groupId, groupId))
    expect(memberships).toHaveLength(3)
    expect(memberships.every((m) => m.grantSource === 'manual')).toBe(true)
    expect(memberships.map((m) => m.userId).sort()).toEqual([...memberIds].sort())

    // Both audit rows, committed with the writes they describe.
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.resourceType, 'business_role'), eq(auditLog.resourceId, roleId)))
    expect(audits.map((a) => a.action).sort()).toEqual(['business_role:create', 'business_role:draft'])
    expect(audits.every((a) => a.actorUserId === globalAdmin.id)).toBe(true)

    // Nothing was published behind the gate's back.
    const publishedConditions = await ctx.db
      .select()
      .from(businessRoleConditions)
      .where(eq(businessRoleConditions.businessRoleId, roleId))
    expect(publishedConditions).toEqual([])

    // And the gate itself still stands: publishing without a simulation is refused...
    await request(app.getHttpServer()).post(`/business-roles/${roleId}/publish`).expect(409)

    // ...while the normal simulate → publish walk accepts the mined draft as-is.
    const simulation = await request(app.getHttpServer())
      .post(`/business-roles/${roleId}/simulate`)
      .expect(200)
    expect(simulation.body.gainCount).toBe(3)
    await request(app.getHttpServer()).post(`/business-roles/${roleId}/publish`).expect(200)
  })

  it('404s an unknown group before writing anything', async () => {
    as(globalAdmin)
    const before = await ctx.db.select().from(auditLog)
    await request(app.getHttpServer())
      .post('/business-roles/mining/drafts')
      .send({
        name: `Ghost group role ${nextSeq()}-${Date.now()}`,
        groupId: '00000000-0000-4000-8000-000000000000',
        conditions: [{ field: 'jobTitle', operator: 'equals', value: 'anything' }],
      })
      .expect(404)
    const after = await ctx.db.select().from(auditLog)
    expect(after.length).toBe(before.length)
  })

  it('rejects a draft body with unknown keys or an empty condition list with 400', async () => {
    as(globalAdmin)
    await request(app.getHttpServer())
      .post('/business-roles/mining/drafts')
      .send({ name: 'x', groupId: '00000000-0000-4000-8000-000000000000', conditions: [], extra: true })
      .expect(400)
    await request(app.getHttpServer())
      .post('/business-roles/mining/drafts')
      .send({ name: 'x', groupId: '00000000-0000-4000-8000-000000000000', conditions: [] })
      .expect(400)
  })
})
