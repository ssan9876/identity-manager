import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { and, eq } from 'drizzle-orm'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import { type RoleKey } from '../src/authz/actions'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { BusinessRolesController } from '../src/business-roles/business-roles.controller'
import { BusinessRolesRepository } from '../src/business-roles/business-roles.repository'
import { RoleConflictsRepository } from '../src/business-roles/role-conflicts.repository'
import { RoleReconciler } from '../src/business-roles/role-reconciler'
import { RoleReconciliationJob } from '../src/business-roles/role-reconciliation.job'
import { SodChecker } from '../src/business-roles/sod-checker'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { auditLog } from '../src/db/schema/audit-log'
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
        subject: 'role-conflicts-test',
        username: getUsername(),
        email: null,
      }
      return true
    },
  }
}

/**
 * Segregation of duties over business roles — the conflicts API and the
 * publish-time refusal, through the real routes with the real
 * `PermissionGuard` (only `JwtGuard` is stubbed), against a throwaway
 * Postgres. Same fixture-isolation rule as business-roles.controller.spec.ts:
 * one container per FILE, no truncation between `it` blocks, so every
 * condition keys on a per-call value and report assertions are containment,
 * never exact totals.
 */
describe('BusinessRolesController — segregation of duties', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let currentUsername = ''
  let rootOrgUnitId = ''
  let salesOrgUnitId = ''
  let globalAdmin: User

  beforeAll(async () => {
    const organizationId = (await new OrganizationsRepository(ctx.db).findMaster()).id
    const stamp = Date.now()
    const [root] = await ctx.db
      .insert(orgUnits)
      .values({ name: `SoD Root ${stamp}`, path: `sod_ctl_root_${stamp}`, organizationId })
      .returning()
    const [sales] = await ctx.db
      .insert(orgUnits)
      .values({
        name: `SoD Sales ${stamp}`,
        path: `sod_ctl_root_${stamp}.sales`,
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
        RoleConflictsRepository,
        SodChecker,
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

  async function makeActiveUser(roleKey?: RoleKey, scopeOrgUnitId: string | null = null): Promise<User> {
    const tag = `sodctl${nextSeq()}-${Date.now()}`
    const created = await usersRepo().create({
      primaryEmail: `${tag}@example.com`,
      username: `${tag}@example.com`,
      firstName: 'SoD',
      lastName: `Controller ${tag}`,
      orgUnitId: scopeOrgUnitId ?? rootOrgUnitId,
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

  async function auditRows(resourceId: string) {
    return ctx.db.select().from(auditLog).where(eq(auditLog.resourceId, resourceId))
  }

  /**
   * Two LIVE roles (published + enabled through the real routes), each
   * granting its own group, both matching ONE person via a per-call
   * jobTitle. The raw material for every conflict below.
   */
  async function seedLivePair() {
    const n = nextSeq()
    const organizationId = (await new OrganizationsRepository(ctx.db).findMaster()).id
    const jobTitle = `Payments Approver #${n}`

    const member = await makeActiveUser()
    await ctx.db.update(users).set({ jobTitle }).where(eq(users.id, member.id))

    const [groupA] = await ctx.db.insert(groups).values({ name: `SoD Ctl A${n}`, organizationId }).returning()
    const [groupB] = await ctx.db.insert(groups).values({ name: `SoD Ctl B${n}`, organizationId }).returning()

    as(globalAdmin)
    const server = app.getHttpServer()
    const goLive = async (name: string, groupId: string) => {
      const created = await request(server)
        .post('/business-roles')
        .send({ name, description: null })
        .expect(201)
      await request(server)
        .put(`/business-roles/${created.body.id}/draft`)
        .send({
          conditions: [{ field: 'jobTitle', operator: 'equals', value: jobTitle }],
          grants: [{ kind: 'group_membership', groupId, target: null }],
        })
        .expect(200)
      await request(server).post(`/business-roles/${created.body.id}/simulate`).expect(200)
      await request(server).post(`/business-roles/${created.body.id}/publish`).expect(200)
      await request(server).post(`/business-roles/${created.body.id}/enable`).expect(200)
      return created.body.id as string
    }

    const roleOneId = await goLive(`SoD Ctl One #${n}`, groupA.id)
    const roleTwoId = await goLive(`SoD Ctl Two #${n}`, groupB.id)

    return { n, jobTitle, memberId: member.id, groupAId: groupA.id, groupBId: groupB.id, roleOneId, roleTwoId }
  }

  async function createConflict(roleOneId: string, roleTwoId: string, reason: string) {
    as(globalAdmin)
    const res = await request(app.getHttpServer())
      .post('/business-roles/conflicts')
      .send({ roleAId: roleOneId, roleBId: roleTwoId, reason })
      .expect(201)
    return res.body as { id: string; roleAId: string; roleBId: string; enabled: boolean; reason: string }
  }

  // =========================================================================
  // Authorization — same posture as every other business-role route
  // =========================================================================

  it('a caller with no role at all cannot even list conflicts', async () => {
    as(await makeActiveUser())
    await request(app.getHttpServer()).get('/business-roles/conflicts').expect(403)
    await request(app.getHttpServer()).get('/business-roles/conflicts/violations').expect(403)
  })

  it('read_only can list conflicts and violations — a policy describes access, it does not confer it', async () => {
    as(await makeActiveUser('read_only'))
    await request(app.getHttpServer()).get('/business-roles/conflicts').expect(200)
    await request(app.getHttpServer()).get('/business-roles/conflicts/violations').expect(200)
  })

  it('an auditor cannot define a conflict — business_role:read is not business_role:manage', async () => {
    const { roleOneId, roleTwoId } = await seedLivePair()
    as(await makeActiveUser('auditor'))
    await request(app.getHttpServer())
      .post('/business-roles/conflicts')
      .send({ roleAId: roleOneId, roleBId: roleTwoId, reason: 'nope' })
      .expect(403)
  })

  it('a SCOPED super_admin is refused on EVERY conflict mutation (finding AUTHZ-M-2)', async () => {
    const { roleOneId, roleTwoId } = await seedLivePair()
    const conflict = await createConflict(roleOneId, roleTwoId, 'for the scoped-admin probe')

    as(await makeActiveUser('super_admin', salesOrgUnitId))
    const server = app.getHttpServer()
    await request(server)
      .post('/business-roles/conflicts')
      .send({ roleAId: roleOneId, roleBId: roleTwoId, reason: 'scoped attempt' })
      .expect(403)
    await request(server)
      .patch(`/business-roles/conflicts/${conflict.id}`)
      .send({ reason: 'scoped attempt' })
      .expect(403)
    await request(server).post(`/business-roles/conflicts/${conflict.id}/disable`).expect(403)
    await request(server).post(`/business-roles/conflicts/${conflict.id}/enable`).expect(403)
  })

  // =========================================================================
  // CRUD-minus-delete
  // =========================================================================

  it('creates a conflict in canonical order, audited in the same transaction', async () => {
    const { roleOneId, roleTwoId } = await seedLivePair()
    // Send the pair in whichever order is NOT canonical, to prove the API
    // canonicalises rather than trusting the caller.
    const [hi, lo] = roleOneId > roleTwoId ? [roleOneId, roleTwoId] : [roleTwoId, roleOneId]
    as(globalAdmin)
    const res = await request(app.getHttpServer())
      .post('/business-roles/conflicts')
      .send({ roleAId: hi, roleBId: lo, reason: 'approver must not also reconcile' })
      .expect(201)

    expect(res.body.roleAId < res.body.roleBId).toBe(true)
    expect(res.body.enabled).toBe(true)
    expect(res.body.reason).toBe('approver must not also reconcile')

    const audits = await auditRows(res.body.id)
    expect(audits).toHaveLength(1)
    expect(audits[0].action).toBe('business_role:conflict_create')
    expect(audits[0].resourceType).toBe('business_role_conflict')
    expect(audits[0].actorUserId).toBe(globalAdmin.id)
  })

  it('rejects a self-pair (400), an unknown role (404), a reversed duplicate (409), and a stray field (400)', async () => {
    const { roleOneId, roleTwoId } = await seedLivePair()
    as(globalAdmin)
    const server = app.getHttpServer()

    await request(server)
      .post('/business-roles/conflicts')
      .send({ roleAId: roleOneId, roleBId: roleOneId, reason: 'self' })
      .expect(400)
    await request(server)
      .post('/business-roles/conflicts')
      .send({ roleAId: roleOneId, roleBId: '00000000-0000-4000-8000-000000000000', reason: 'ghost' })
      .expect(404)
    await request(server)
      .post('/business-roles/conflicts')
      .send({ roleAId: roleOneId, roleBId: roleTwoId, reason: 'first' })
      .expect(201)
    await request(server)
      .post('/business-roles/conflicts')
      .send({ roleAId: roleTwoId, roleBId: roleOneId, reason: 'reversed duplicate' })
      .expect(409)
    await request(server)
      .post('/business-roles/conflicts')
      .send({ roleAId: roleOneId, roleBId: roleTwoId, reason: 'x', enabled: false })
      .expect(400)
    // reason is MANDATORY — an unexplained control is unreviewable.
    await request(server)
      .post('/business-roles/conflicts')
      .send({ roleAId: roleOneId, roleBId: roleTwoId })
      .expect(400)
  })

  it('lists conflicts with both role names; PATCH edits the reason (audited); retire/restore flips enabled (audited)', async () => {
    const { n, roleOneId, roleTwoId } = await seedLivePair()
    const conflict = await createConflict(roleOneId, roleTwoId, 'initial reason')
    as(globalAdmin)
    const server = app.getHttpServer()

    const listed = await request(server).get('/business-roles/conflicts').expect(200)
    const mine = listed.body.find((c: { id: string }) => c.id === conflict.id)
    expect(mine).toBeDefined()
    expect([mine.roleAName, mine.roleBName].sort()).toEqual([`SoD Ctl One #${n}`, `SoD Ctl Two #${n}`].sort())

    const patched = await request(server)
      .patch(`/business-roles/conflicts/${conflict.id}`)
      .send({ reason: 'sharper reason' })
      .expect(200)
    expect(patched.body.reason).toBe('sharper reason')

    const retired = await request(server).post(`/business-roles/conflicts/${conflict.id}/disable`).expect(200)
    expect(retired.body.enabled).toBe(false)
    const restored = await request(server).post(`/business-roles/conflicts/${conflict.id}/enable`).expect(200)
    expect(restored.body.enabled).toBe(true)

    const audits = await auditRows(conflict.id)
    expect(audits.map((a) => a.action).sort()).toEqual(
      [
        'business_role:conflict_create',
        'business_role:conflict_update',
        'business_role:conflict_disable',
        'business_role:conflict_enable',
      ].sort(),
    )
  })

  // =========================================================================
  // THE point: publish is PREVENTIVE, and hash-gated to the exact draft
  // =========================================================================

  it('simulate reports the violations the draft would create, and publish REFUSES on them', async () => {
    const { n, jobTitle, memberId, groupAId } = await seedLivePair()
    const server = app.getHttpServer()
    as(globalAdmin)

    // A THIRD role, drafted to overlap role one — and a conflict between them.
    const created = await request(server)
      .post('/business-roles')
      .send({ name: `SoD Ctl Three #${n}`, description: null })
      .expect(201)
    const roleThreeId = created.body.id as string

    const listed = await request(server).get('/business-roles').expect(200)
    const roleOneRow = listed.body.find((r: { name: string }) => r.name === `SoD Ctl One #${n}`)
    const conflict = await createConflict(roleOneRow.id, roleThreeId, 'one person must not hold both')

    await request(server)
      .put(`/business-roles/${roleThreeId}/draft`)
      .send({
        conditions: [{ field: 'jobTitle', operator: 'equals', value: jobTitle }],
        grants: [],
      })
      .expect(200)

    const simulated = await request(server).post(`/business-roles/${roleThreeId}/simulate`).expect(200)
    expect(simulated.body.sodViolationCount).toBe(1)
    expect(simulated.body.sodViolations).toHaveLength(1)
    expect(simulated.body.sodViolations[0]).toMatchObject({
      userId: memberId,
      conflictId: conflict.id,
      conflictReason: 'one person must not hold both',
      via: 'formula',
      otherRoleId: roleOneRow.id,
      otherRoleName: `SoD Ctl One #${n}`,
      otherVia: 'formula',
    })

    // Publish refuses — the simulation of this EXACT draft found violations.
    const refused = await request(server).post(`/business-roles/${roleThreeId}/publish`).expect(409)
    expect(refused.body.message).toMatch(/segregation-of-duties/)

    // PREVENTIVE, not detective: nothing was published, so nothing appears
    // in the standing-violations report for this conflict.
    const standing = await request(server).get('/business-roles/conflicts/violations').expect(200)
    expect(
      standing.body.violations.some((v: { conflictId: string }) => v.conflictId === conflict.id),
    ).toBe(false)

    // And the member's memberships are exactly what role one granted — the
    // refused publish moved nobody.
    const held = await ctx.db
      .select()
      .from(groupUserMembers)
      .where(and(eq(groupUserMembers.userId, memberId), eq(groupUserMembers.groupId, groupAId)))
    expect(held).toHaveLength(1)

    // Retiring the conflict does NOT unlock the stale simulation: the
    // recorded count belongs to the exact draft that was simulated, so the
    // gate still refuses until a FRESH simulation records a clean answer.
    await request(server).post(`/business-roles/conflicts/${conflict.id}/disable`).expect(200)
    const stillRefused = await request(server).post(`/business-roles/${roleThreeId}/publish`).expect(409)
    expect(stillRefused.body.message).toMatch(/segregation-of-duties/)

    // Re-simulate against the retired conflict: clean, and publish opens.
    const clean = await request(server).post(`/business-roles/${roleThreeId}/simulate`).expect(200)
    expect(clean.body.sodViolationCount).toBe(0)
    await request(server).post(`/business-roles/${roleThreeId}/publish`).expect(200)
  })

  // =========================================================================
  // The standing report — detective, and it names WHY each side is held
  // =========================================================================

  it('reports a standing violation (conflict defined after both roles were live) without revoking either side', async () => {
    const { memberId, groupAId, groupBId, roleOneId, roleTwoId } = await seedLivePair()
    const conflict = await createConflict(roleOneId, roleTwoId, 'defined after the fact')

    as(await makeActiveUser('auditor'))
    const res = await request(app.getHttpServer()).get('/business-roles/conflicts/violations').expect(200)
    const violation = res.body.violations.find(
      (v: { conflictId: string; userId: string }) => v.conflictId === conflict.id && v.userId === memberId,
    )
    expect(violation).toBeDefined()
    expect(violation.roleA.via).toBe('formula')
    expect(violation.roleB.via).toBe('formula')
    expect(res.body.violationCount).toBeGreaterThanOrEqual(1)

    // Report-only: the person still holds BOTH groups.
    const held = await ctx.db.select().from(groupUserMembers).where(eq(groupUserMembers.userId, memberId))
    const heldGroupIds = held.map((m) => m.groupId)
    expect(heldGroupIds).toContain(groupAId)
    expect(heldGroupIds).toContain(groupBId)
  })
})
