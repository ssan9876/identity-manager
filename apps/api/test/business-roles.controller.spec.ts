import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { and, eq } from 'drizzle-orm'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import { ALL_ACTIONS, ALL_ROLE_KEYS, ROLE_PERMISSIONS, type RoleKey } from '../src/authz/actions'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { BusinessRolesController } from '../src/business-roles/business-roles.controller'
import { BusinessRolesRepository } from '../src/business-roles/business-roles.repository'
import { RoleReconciler } from '../src/business-roles/role-reconciler'
import { RoleReconciliationJob } from '../src/business-roles/role-reconciliation.job'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { businessRoleConditions, businessRoleExceptions } from '../src/db/schema/business-roles'
import { groupUserMembers } from '../src/db/schema/group-members'
import { groups } from '../src/db/schema/groups'
import { orgUnits } from '../src/db/schema/org-units'
import { users } from '../src/db/schema/users'
import { OrganizationsRepository } from '../src/organizations/organizations.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { UsersRepository, type User } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

/** Same technique as connector-targets.controller.spec.ts / org-units.write.spec.ts. */
function stubJwtGuard(getUsername: () => string): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
        subject: 'business-roles-test',
        username: getUsername(),
        email: null,
      }
      return true
    },
  }
}

/**
 * MILESTONE 17, TASK 11 — the business-role admin API.
 *
 * Only `JwtGuard` is stubbed. `PermissionGuard` and `PermissionEngine` run
 * for real against the throwaway Postgres, so `business_role:read` /
 * `business_role:manage` — and, critically, the GLOBAL-grant requirement on
 * every mutating route (finding AUTHZ-M-2) — are genuinely exercised rather
 * than assumed.
 *
 * FIXTURE ISOLATION. `withTestDatabase()` starts ONE container per test FILE
 * and never truncates between `it` blocks, so every role a previous test
 * enabled is still enabled and still visible to `listEnabledForEvaluation`
 * when a later test sweeps. Every fixture below therefore keys its condition
 * on a value unique to the call (`... #<seq>`), exactly as
 * test/business-roles.spec.ts does and for the same reason: a shared literal
 * lets one test's role match another test's user, which is what produced a
 * bogus "5 of 19 failing" run here once already.
 */
describe('BusinessRolesController (Milestone 17, Task 11)', () => {
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
      .values({ name: `BR Root ${stamp}`, path: `br_root_${stamp}`, organizationId })
      .returning()
    const [sales] = await ctx.db
      .insert(orgUnits)
      .values({
        name: `BR Sales ${stamp}`,
        path: `br_root_${stamp}.sales`,
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
    roleKey?: RoleKey,
    scopeOrgUnitId: string | null = null,
  ): Promise<User> {
    const tag = `br${nextSeq()}-${Date.now()}`
    const created = await usersRepo().create({
      primaryEmail: `${tag}@example.com`,
      username: `${tag}@example.com`,
      firstName: 'Business',
      lastName: `Roles ${tag}`,
      orgUnitId: scopeOrgUnitId ?? rootOrgUnitId,
    })
    const active = await usersRepo().changeStatus(created.id, 'active')
    if (roleKey !== undefined) {
      await rolesRepo().assign({ userId: active.id, roleKey, scopeOrgUnitId })
    }
    return active
  }

  /** Acts as this person for the next request. */
  function as(actor: User): string {
    currentUsername = actor.username
    return actor.username
  }

  async function membershipsFor(userId: string) {
    return ctx.db.select().from(groupUserMembers).where(eq(groupUserMembers.userId, userId))
  }

  /**
   * A group, a matching user and a non-matching outsider, plus an EMPTY
   * business role — created through the API so the routes under test are what
   * built it. The role's eventual condition keys on a per-call `jobTitle`, so
   * nothing this fixture creates can be matched by any other test's role.
   */
  async function seedRoleAndPeople(): Promise<{
    roleId: string
    jobTitle: string
    groupId: string
    memberId: string
    outsiderId: string
  }> {
    const n = nextSeq()
    const organizationId = (await new OrganizationsRepository(ctx.db).findMaster()).id
    const jobTitle = `Account Executive #${n}`

    const [group] = await ctx.db
      .insert(groups)
      .values({ name: `BR Group ${n}`, organizationId })
      .returning()

    const member = await makeActiveUser()
    const outsider = await makeActiveUser()
    await ctx.db.update(users).set({ jobTitle }).where(eq(users.id, member.id))

    as(globalAdmin)
    const created = await request(app.getHttpServer())
      .post('/business-roles')
      .send({ name: `BR Role ${n}`, description: null })
      .expect(201)

    return {
      roleId: created.body.id,
      jobTitle,
      groupId: group.id,
      memberId: member.id,
      outsiderId: outsider.id,
    }
  }

  /** Draft → simulate → publish → enable, all through the routes under test. */
  async function goLive(roleId: string, jobTitle: string, groupId: string): Promise<void> {
    as(globalAdmin)
    await request(app.getHttpServer())
      .put(`/business-roles/${roleId}/draft`)
      .send({
        conditions: [{ field: 'jobTitle', operator: 'equals', value: jobTitle }],
        grants: [{ kind: 'group_membership', groupId, target: null }],
      })
      .expect(200)
    await request(app.getHttpServer()).post(`/business-roles/${roleId}/simulate`).expect(200)
    await request(app.getHttpServer()).post(`/business-roles/${roleId}/publish`).expect(200)
    await request(app.getHttpServer()).post(`/business-roles/${roleId}/enable`).expect(200)
  }

  // =========================================================================
  // The action catalog
  // =========================================================================

  it('declares both actions exactly once in ALL_ACTIONS', () => {
    expect(ALL_ACTIONS.filter((a) => a === 'business_role:read')).toHaveLength(1)
    expect(ALL_ACTIONS.filter((a) => a === 'business_role:manage')).toHaveLength(1)
  })

  it('business_role:manage is held by super_admin alone', () => {
    for (const role of ALL_ROLE_KEYS) {
      expect(ROLE_PERMISSIONS[role].includes('business_role:manage')).toBe(role === 'super_admin')
    }
  })

  it('business_role:read is held by super_admin, user_admin, auditor and read_only', () => {
    expect(
      ALL_ROLE_KEYS.filter((r) => ROLE_PERMISSIONS[r].includes('business_role:read')).sort(),
    ).toEqual(['auditor', 'read_only', 'super_admin', 'user_admin'].sort())
  })

  // =========================================================================
  // Authorization — the global-grant rule (finding AUTHZ-M-2)
  // =========================================================================

  it('rejects a caller holding no role at all with 403', async () => {
    as(await makeActiveUser())
    await request(app.getHttpServer()).get('/business-roles').expect(403)
  })

  it('allows read_only to list roles — a formula describes access, it does not confer it', async () => {
    as(await makeActiveUser('read_only'))
    await request(app.getHttpServer()).get('/business-roles').expect(200)
  })

  it('rejects an auditor creating a role — business_role:read is not business_role:manage', async () => {
    as(await makeActiveUser('auditor'))
    await request(app.getHttpServer())
      .post('/business-roles')
      .send({ name: `Auditor attempt ${nextSeq()}` })
      .expect(403)
  })

  it('a SCOPED super_admin cannot mutate a business role', async () => {
    // Mirrors commits 2648b9f (global connector infrastructure) and 617a0b4
    // (the audit log): a formula spans the whole directory and a grant can
    // place anyone into any group, so a scoped holding must never produce a
    // directory-wide effect.
    const scoped = await makeActiveUser('super_admin', salesOrgUnitId)
    as(scoped)

    const res = await request(app.getHttpServer())
      .post('/business-roles')
      .send({ name: `Scoped attempt ${nextSeq()}` })
      .expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  it('a SCOPED super_admin is refused on EVERY mutating route, not just create', async () => {
    const { roleId } = await seedRoleAndPeople()
    const scoped = await makeActiveUser('super_admin', salesOrgUnitId)
    as(scoped)
    const server = app.getHttpServer()

    await request(server).patch(`/business-roles/${roleId}`).send({ name: 'nope' }).expect(403)
    await request(server)
      .put(`/business-roles/${roleId}/draft`)
      .send({ conditions: [], grants: [] })
      .expect(403)
    await request(server).post(`/business-roles/${roleId}/simulate`).expect(403)
    await request(server).post(`/business-roles/${roleId}/publish`).expect(403)
    await request(server).post(`/business-roles/${roleId}/enable`).expect(403)
    await request(server).post(`/business-roles/${roleId}/disable`).expect(403)
    await request(server)
      .post(`/business-roles/${roleId}/exceptions`)
      .send({ userId: globalAdmin.id, mode: 'include', reason: 'no' })
      .expect(403)
    await request(server)
      .delete(`/business-roles/${roleId}/exceptions/${globalAdmin.id}`)
      .expect(403)
  })

  it('a SCOPED super_admin can still READ — reading a formula is not the escalation', async () => {
    const { roleId } = await seedRoleAndPeople()
    as(await makeActiveUser('super_admin', salesOrgUnitId))

    await request(app.getHttpServer()).get('/business-roles').expect(200)
    await request(app.getHttpServer()).get(`/business-roles/${roleId}`).expect(200)
  })

  it('a GLOBAL super_admin can', async () => {
    as(globalAdmin)
    const n = nextSeq()
    const res = await request(app.getHttpServer())
      .post('/business-roles')
      .send({ name: `Global admin role ${n}`, description: 'made by a global grant' })
      .expect(201)

    expect(res.body).toMatchObject({ name: `Global admin role ${n}`, enabled: false })
    expect(res.body.draftDefinition).toBeNull()
    expect(res.body.simulatedAt).toBeNull()
  })

  // =========================================================================
  // The draft / simulate / publish gate
  // =========================================================================

  it('publish returns 409 when the draft was not simulated', async () => {
    const { roleId, jobTitle, groupId } = await seedRoleAndPeople()
    as(globalAdmin)

    await request(app.getHttpServer())
      .put(`/business-roles/${roleId}/draft`)
      .send({
        conditions: [{ field: 'jobTitle', operator: 'equals', value: jobTitle }],
        grants: [{ kind: 'group_membership', groupId, target: null }],
      })
      .expect(200)

    const res = await request(app.getHttpServer())
      .post(`/business-roles/${roleId}/publish`)
      .expect(409)
    expect(res.body.code).toBe('CONFLICT')
    expect(res.body.message).toMatch(/simulat/i)
  })

  it('publish returns 409 when the draft changed AFTER the simulation', async () => {
    const { roleId, jobTitle, groupId } = await seedRoleAndPeople()
    as(globalAdmin)
    const server = app.getHttpServer()

    await request(server)
      .put(`/business-roles/${roleId}/draft`)
      .send({
        conditions: [{ field: 'jobTitle', operator: 'equals', value: jobTitle }],
        grants: [{ kind: 'group_membership', groupId, target: null }],
      })
      .expect(200)
    await request(server).post(`/business-roles/${roleId}/simulate`).expect(200)

    // Edited after simulating — the hash no longer matches, AND saveDraft
    // cleared the record. Two mechanisms, either one of which must refuse.
    await request(server)
      .put(`/business-roles/${roleId}/draft`)
      .send({
        conditions: [{ field: 'jobTitle', operator: 'not_equals', value: jobTitle }],
        grants: [{ kind: 'group_membership', groupId, target: null }],
      })
      .expect(200)

    await request(server).post(`/business-roles/${roleId}/publish`).expect(409)
  })

  it('a draft write does not change any membership', async () => {
    const { roleId, jobTitle, groupId, memberId } = await seedRoleAndPeople()
    as(globalAdmin)

    // Enabled FIRST, with no published definition — a role with zero
    // conditions matches nobody, so enabling it is safe and this test is
    // genuinely about the draft rather than about the kill switch.
    await request(app.getHttpServer()).post(`/business-roles/${roleId}/enable`).expect(200)
    await request(app.getHttpServer())
      .put(`/business-roles/${roleId}/draft`)
      .send({
        conditions: [{ field: 'jobTitle', operator: 'equals', value: jobTitle }],
        grants: [{ kind: 'group_membership', groupId, target: null }],
      })
      .expect(200)

    expect(await membershipsFor(memberId)).toEqual([])
    // Nothing was copied down either.
    expect(
      await ctx.db
        .select()
        .from(businessRoleConditions)
        .where(eq(businessRoleConditions.businessRoleId, roleId)),
    ).toEqual([])
  })

  it('simulate reports the diff, commits no membership, and unlocks publish', async () => {
    const { roleId, jobTitle, groupId, memberId, outsiderId } = await seedRoleAndPeople()
    as(globalAdmin)
    const server = app.getHttpServer()

    await request(server)
      .put(`/business-roles/${roleId}/draft`)
      .send({
        conditions: [{ field: 'jobTitle', operator: 'equals', value: jobTitle }],
        grants: [{ kind: 'group_membership', groupId, target: null }],
      })
      .expect(200)

    const simulated = await request(server).post(`/business-roles/${roleId}/simulate`).expect(200)

    // Exactly one person, because the fixture's jobTitle is unique to this
    // call — see this file's fixture-isolation note.
    expect(simulated.body.gainCount).toBe(1)
    expect(simulated.body.lossCount).toBe(0)
    expect(simulated.body.gains).toEqual([
      expect.objectContaining({ userId: memberId, groupIds: [groupId] }),
    ])
    expect(simulated.body.scanned).toBeGreaterThan(0)

    // Committed nothing.
    expect(await membershipsFor(memberId)).toEqual([])
    expect(await membershipsFor(outsiderId)).toEqual([])

    await request(server).post(`/business-roles/${roleId}/publish`).expect(200)
  })

  it('publishing an ENABLED role moves membership immediately, without waiting for the periodic sweep', async () => {
    const { roleId, jobTitle, groupId, memberId, outsiderId } = await seedRoleAndPeople()
    as(globalAdmin)
    const server = app.getHttpServer()

    await request(server).post(`/business-roles/${roleId}/enable`).expect(200)
    await request(server)
      .put(`/business-roles/${roleId}/draft`)
      .send({
        conditions: [{ field: 'jobTitle', operator: 'equals', value: jobTitle }],
        grants: [{ kind: 'group_membership', groupId, target: null }],
      })
      .expect(200)
    await request(server).post(`/business-roles/${roleId}/simulate`).expect(200)

    const published = await request(server).post(`/business-roles/${roleId}/publish`).expect(200)
    expect(published.body.reconciliation.changed).toBeGreaterThanOrEqual(1)

    expect(await membershipsFor(memberId)).toEqual([
      expect.objectContaining({ groupId, grantSource: 'business_role' }),
    ])
    expect(await membershipsFor(outsiderId)).toEqual([])
  })

  it('disable revokes, and says how many principals lost grants', async () => {
    const { roleId, jobTitle, groupId, memberId } = await seedRoleAndPeople()
    await goLive(roleId, jobTitle, groupId)
    expect(await membershipsFor(memberId)).toHaveLength(1)

    as(globalAdmin)
    const res = await request(app.getHttpServer())
      .post(`/business-roles/${roleId}/disable`)
      .expect(200)

    expect(res.body.enabled).toBe(false)
    // Not an exact equality: this database is never truncated between tests,
    // so an earlier test's converged users are visited by this sweep too. The
    // load-bearing assertions are that it is non-zero and that THIS person's
    // row is gone.
    expect(res.body.principalsRevoked).toBeGreaterThanOrEqual(1)
    expect(await membershipsFor(memberId)).toEqual([])
  })

  /**
   * A CONTRACT test, not a behaviour one, and it exists because the missing
   * contract was found the expensive way: `apps/web/e2e/business-roles.spec.ts`
   * (Task 20) drove enable through the real console and the detail page threw
   * on its next render — blank screen, no toast — because these two routes
   * alone answered with the bare `business_roles` row, while every other route
   * that returns a role (GET /:id, PATCH /:id, PUT /:id/draft, POST
   * /:id/publish) returns it WITH its published `conditions`, `grants` and
   * `exceptions`, which is what the console is typed against.
   *
   * Nothing about the VALUES was wrong, so no assertion on counts or on
   * membership could have caught it. Only the shape could.
   */
  it('enable and disable answer with the whole role — conditions, grants and exceptions — not the bare row', async () => {
    const { roleId, jobTitle, groupId } = await seedRoleAndPeople()
    await goLive(roleId, jobTitle, groupId)

    as(globalAdmin)
    const server = app.getHttpServer()

    // `goLive` already enabled it, so this is the idempotent re-enable — the
    // same response body a console reads after the button click either way.
    const enabled = await request(server).post(`/business-roles/${roleId}/enable`).expect(200)
    expect(enabled.body.enabled).toBe(true)
    expect(enabled.body.conditions).toEqual([
      expect.objectContaining({ field: 'jobTitle', operator: 'equals', value: jobTitle }),
    ])
    expect(enabled.body.grants).toEqual([expect.objectContaining({ kind: 'group_membership', groupId })])
    expect(enabled.body.exceptions).toEqual([])

    const disabled = await request(server).post(`/business-roles/${roleId}/disable`).expect(200)
    expect(disabled.body.enabled).toBe(false)
    expect(disabled.body.conditions).toHaveLength(1)
    expect(disabled.body.grants).toHaveLength(1)
    expect(disabled.body.exceptions).toEqual([])
  })

  // =========================================================================
  // Exceptions — live adjustments to a running role
  // =========================================================================

  it('an exception applies to a live role without touching its definition', async () => {
    const { roleId, jobTitle, groupId, outsiderId } = await seedRoleAndPeople()
    await goLive(roleId, jobTitle, groupId)

    as(globalAdmin)
    await request(app.getHttpServer())
      .post(`/business-roles/${roleId}/exceptions`)
      .send({
        userId: outsiderId,
        mode: 'include',
        reason: 'Covering for parental leave until March',
        expiresAt: '2099-03-01T00:00:00.000Z',
      })
      .expect(201)

    expect(await membershipsFor(outsiderId)).toEqual([
      expect.objectContaining({ groupId, grantSource: 'business_role' }),
    ])

    // The formula that governs everyone else is untouched.
    const conditions = await ctx.db
      .select()
      .from(businessRoleConditions)
      .where(eq(businessRoleConditions.businessRoleId, roleId))
    expect(conditions).toHaveLength(1)
    expect(conditions[0].value).toBe(jobTitle)
  })

  it('an exception without a reason is rejected', async () => {
    const { roleId, jobTitle, groupId, outsiderId } = await seedRoleAndPeople()
    await goLive(roleId, jobTitle, groupId)

    as(globalAdmin)
    const res = await request(app.getHttpServer())
      .post(`/business-roles/${roleId}/exceptions`)
      .send({ userId: outsiderId, mode: 'include' })
      .expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')

    expect(await membershipsFor(outsiderId)).toEqual([])
  })

  it('an exclude exception revokes a matching person, and removing it grants them back', async () => {
    const { roleId, jobTitle, groupId, memberId } = await seedRoleAndPeople()
    await goLive(roleId, jobTitle, groupId)
    expect(await membershipsFor(memberId)).toHaveLength(1)

    as(globalAdmin)
    const server = app.getHttpServer()
    await request(server)
      .post(`/business-roles/${roleId}/exceptions`)
      .send({ userId: memberId, mode: 'exclude', reason: 'Under investigation' })
      .expect(201)
    expect(await membershipsFor(memberId)).toEqual([])

    await request(server).delete(`/business-roles/${roleId}/exceptions/${memberId}`).expect(200)
    expect(await membershipsFor(memberId)).toEqual([
      expect.objectContaining({ groupId, grantSource: 'business_role' }),
    ])
    expect(
      await ctx.db
        .select()
        .from(businessRoleExceptions)
        .where(
          and(
            eq(businessRoleExceptions.businessRoleId, roleId),
            eq(businessRoleExceptions.userId, memberId),
          ),
        ),
    ).toEqual([])
  })

  it('an exception for an unknown user is a 404, and writes nothing', async () => {
    const { roleId, jobTitle, groupId } = await seedRoleAndPeople()
    await goLive(roleId, jobTitle, groupId)

    as(globalAdmin)
    const missing = '00000000-0000-4000-8000-000000000000'
    await request(app.getHttpServer())
      .post(`/business-roles/${roleId}/exceptions`)
      .send({ userId: missing, mode: 'include', reason: 'ghost' })
      .expect(404)

    expect(
      await ctx.db
        .select()
        .from(businessRoleExceptions)
        .where(eq(businessRoleExceptions.businessRoleId, roleId)),
    ).toEqual([])
  })

  it('removing an exception that does not exist is a 404', async () => {
    const { roleId } = await seedRoleAndPeople()
    as(globalAdmin)
    await request(app.getHttpServer())
      .delete(`/business-roles/${roleId}/exceptions/${globalAdmin.id}`)
      .expect(404)
  })

  // =========================================================================
  // Input handling — INJ-H-1 / INJ-H-2 / SEC-L2
  // =========================================================================

  it('rejects a JSON-escaped NUL inside a draft condition value instead of 500ing at the driver', async () => {
    const { roleId } = await seedRoleAndPeople()
    as(globalAdmin)

    // TWO backslashes in the source: the JSON TEXT carries the escape
    // sequence, which JSON.parse turns into a real NUL inside the string. A
    // RAW NUL byte is a different, already-safe case that JSON.parse itself
    // rejects — safe-string.ts draws exactly that distinction.
    const res = await request(app.getHttpServer())
      .put(`/business-roles/${roleId}/draft`)
      .set('Content-Type', 'application/json')
      .send(
        '{"conditions":[{"field":"jobTitle","operator":"equals","value":"Account\\u0000Exec"}],"grants":[]}',
      )
      .expect(400)

    expect(res.body.code).toBe('VALIDATION_FAILED')
    expect(JSON.stringify(res.body)).toMatch(/NUL/i)
  })

  it('rejects a JSON-escaped NUL in a role name', async () => {
    as(globalAdmin)
    await request(app.getHttpServer())
      .post('/business-roles')
      .set('Content-Type', 'application/json')
      .send('{"name":"Bad\\u0000Name"}')
      .expect(400)
  })

  it('reports a duplicate name as a conflict WITHOUT echoing the submitted name', async () => {
    as(globalAdmin)
    const name = `Duplicate role ${nextSeq()}`
    await request(app.getHttpServer()).post('/business-roles').send({ name }).expect(201)

    const res = await request(app.getHttpServer()).post('/business-roles').send({ name }).expect(409)
    expect(res.body.code).toBe('CONFLICT')
    // Finding SEC-L2: a conflict must not repeat the caller's own input back.
    expect(JSON.stringify(res.body)).not.toContain(name)
  })

  it('rejects an unknown field in a PATCH body rather than silently ignoring it', async () => {
    const { roleId } = await seedRoleAndPeople()
    as(globalAdmin)
    await request(app.getHttpServer())
      .patch(`/business-roles/${roleId}`)
      .send({ enabled: true })
      .expect(400)
  })

  it('rejects a non-UUID id with 400, and an unknown one with 404', async () => {
    as(globalAdmin)
    await request(app.getHttpServer()).get('/business-roles/not-a-uuid').expect(400)
    await request(app.getHttpServer())
      .get('/business-roles/00000000-0000-4000-8000-000000000000')
      .expect(404)
  })

  it('name and description are editable at any time — neither can affect access', async () => {
    const { roleId, jobTitle, groupId, memberId } = await seedRoleAndPeople()
    await goLive(roleId, jobTitle, groupId)

    as(globalAdmin)
    const renamed = `Renamed role ${nextSeq()}`
    const res = await request(app.getHttpServer())
      .patch(`/business-roles/${roleId}`)
      .send({ name: renamed, description: 'still the same formula' })
      .expect(200)

    expect(res.body.name).toBe(renamed)
    expect(await membershipsFor(memberId)).toHaveLength(1)
  })
})
