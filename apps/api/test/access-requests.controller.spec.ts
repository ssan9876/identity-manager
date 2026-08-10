import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AccessRequestsController } from '../src/access-requests/access-requests.controller'
import { AccessRequestsRepository } from '../src/access-requests/access-requests.repository'
import {
  APPROVER_RESOLVERS,
  FALLBACK_APPROVER_ROLE,
  resolverForSubject,
} from '../src/access-requests/approver-resolver'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
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
import { businessRoleExceptions } from '../src/db/schema/business-roles'
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
        subject: 'access-requests-test',
        username: getUsername(),
        email: null,
      }
      return true
    },
  }
}

/**
 * The self-service access-request catalogue with manager approval.
 *
 * Only `JwtGuard` is stubbed — `PermissionEngine` runs for real, so the
 * global-manage admin path, the manager resolution and the fallback-role
 * resolution are all genuinely exercised against the throwaway Postgres.
 * `BusinessRolesController` is mounted alongside so the requestable toggle
 * and the draft/simulate/publish/enable pipeline run through the real routes.
 *
 * FIXTURE ISOLATION: one container per file, never truncated between tests —
 * every fixture keys on a per-call sequence number, exactly as
 * business-roles.controller.spec.ts does and for the same reason.
 */
describe('AccessRequestsController (access-request catalogue)', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let currentUsername = ''
  let rootOrgUnitId = ''
  let globalAdmin: User
  let organizationId = ''

  beforeAll(async () => {
    organizationId = (await new OrganizationsRepository(ctx.db).findMaster()).id
    const stamp = Date.now()
    const [root] = await ctx.db
      .insert(orgUnits)
      .values({ name: `AR Root ${stamp}`, path: `ar_root_${stamp}`, organizationId })
      .returning()
    rootOrgUnitId = root.id

    const moduleRef = await Test.createTestingModule({
      controllers: [AccessRequestsController, BusinessRolesController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        AccessRequestsRepository,
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

  async function makeActiveUser(
    roleKey?: 'super_admin' | 'user_admin' | 'read_only',
    managerId: string | null = null,
  ): Promise<User> {
    const tag = `ar${nextSeq()}-${Date.now()}`
    const created = await usersRepo().create({
      primaryEmail: `${tag}@example.com`,
      username: `${tag}@example.com`,
      firstName: 'Access',
      lastName: `Requests ${tag}`,
      orgUnitId: rootOrgUnitId,
    })
    const active = await usersRepo().changeStatus(created.id, 'active')
    if (managerId !== null) {
      await ctx.db.update(users).set({ managerId }).where(eq(users.id, created.id))
    }
    if (roleKey !== undefined) {
      await rolesRepo().assign({ userId: active.id, roleKey, scopeOrgUnitId: null })
    }
    return active
  }

  /** Acts as this person for the next request. */
  function as(actor: User): void {
    currentUsername = actor.username
  }

  async function membershipsFor(userId: string) {
    return ctx.db.select().from(groupUserMembers).where(eq(groupUserMembers.userId, userId))
  }

  async function exceptionsFor(roleId: string) {
    return ctx.db
      .select()
      .from(businessRoleExceptions)
      .where(eq(businessRoleExceptions.businessRoleId, roleId))
  }

  /**
   * A live, requestable role granting one group, whose condition keys on a
   * per-call jobTitle NOBODY holds — so the ONLY way anyone ever gets its
   * group is an include exception, which is exactly what an approval writes.
   */
  async function seedRequestableRole(): Promise<{ roleId: string; groupId: string; name: string }> {
    const n = nextSeq()
    const name = `AR Role ${n} ${Date.now()}`
    const [group] = await ctx.db
      .insert(groups)
      .values({ name: `AR Group ${n} ${Date.now()}`, organizationId })
      .returning()

    as(globalAdmin)
    const server = app.getHttpServer()
    const created = await request(server)
      .post('/business-roles')
      .send({ name, description: null })
      .expect(201)
    const roleId: string = created.body.id

    await request(server)
      .put(`/business-roles/${roleId}/draft`)
      .send({
        conditions: [{ field: 'jobTitle', operator: 'equals', value: `nobody-${n}-${Date.now()}` }],
        grants: [{ kind: 'group_membership', groupId: group.id, target: null }],
      })
      .expect(200)
    await request(server).post(`/business-roles/${roleId}/simulate`).expect(200)
    await request(server).post(`/business-roles/${roleId}/publish`).expect(200)
    await request(server).post(`/business-roles/${roleId}/enable`).expect(200)
    await request(server)
      .put(`/business-roles/${roleId}/requestable`)
      .send({ requestable: true })
      .expect(200)

    return { roleId, groupId: group.id, name }
  }

  async function createPendingRequest(
    requester: User,
    roleId: string,
    justification = 'I need this for the quarterly close',
    requestedExpiresAt: string | null = null,
  ): Promise<string> {
    as(requester)
    const res = await request(app.getHttpServer())
      .post('/access-requests')
      .send({ businessRoleId: roleId, justification, requestedExpiresAt })
      .expect(201)
    expect(res.body.state).toBe('pending')
    return res.body.id as string
  }

  // =========================================================================
  // The catalogue
  // =========================================================================

  it('lists only requestable AND enabled roles — the catalogue is an allowlist', async () => {
    const { roleId, name } = await seedRequestableRole()

    // A published-but-not-requestable role, created the same way minus the flag.
    as(globalAdmin)
    const other = await request(app.getHttpServer())
      .post('/business-roles')
      .send({ name: `AR Hidden ${nextSeq()} ${Date.now()}`, description: null })
      .expect(201)

    const employee = await makeActiveUser()
    as(employee)
    const res = await request(app.getHttpServer()).get('/access-requests/catalogue').expect(200)
    const ids = res.body.roles.map((r: { id: string }) => r.id)
    expect(ids).toContain(roleId)
    expect(ids).not.toContain(other.body.id)
    expect(res.body.roles.find((r: { id: string }) => r.id === roleId).name).toBe(name)
  })

  it('a disabled role leaves the catalogue even while still flagged requestable', async () => {
    const { roleId } = await seedRequestableRole()
    as(globalAdmin)
    await request(app.getHttpServer()).post(`/business-roles/${roleId}/disable`).expect(200)

    const employee = await makeActiveUser()
    as(employee)
    const res = await request(app.getHttpServer()).get('/access-requests/catalogue').expect(200)
    expect(res.body.roles.map((r: { id: string }) => r.id)).not.toContain(roleId)
  })

  it('withdrawing requestable blocks NEW requests without touching anything granted', async () => {
    const { roleId } = await seedRequestableRole()
    as(globalAdmin)
    await request(app.getHttpServer())
      .put(`/business-roles/${roleId}/requestable`)
      .send({ requestable: false })
      .expect(200)

    const employee = await makeActiveUser()
    as(employee)
    await request(app.getHttpServer())
      .post('/access-requests')
      .send({ businessRoleId: roleId, justification: 'Please' })
      .expect(404)
  })

  // =========================================================================
  // Creating a request
  // =========================================================================

  it('records requester = subject = the AUTHENTICATED caller, with the manager resolver', async () => {
    const { roleId } = await seedRequestableRole()
    const manager = await makeActiveUser()
    const employee = await makeActiveUser(undefined, manager.id)

    const id = await createPendingRequest(employee, roleId)

    as(employee)
    const mine = await request(app.getHttpServer()).get('/access-requests/mine').expect(200)
    const row = mine.body.requests.find((r: { id: string }) => r.id === id)
    expect(row.requesterUserId).toBe(employee.id)
    expect(row.subjectUserId).toBe(employee.id)
    expect(row.approverResolver).toBe('manager_of_subject')
    expect(row.businessRoleId).toBe(roleId)
  })

  it('a caller-supplied requester/subject id is a 400 naming the field, never trusted', async () => {
    const { roleId } = await seedRequestableRole()
    const employee = await makeActiveUser()
    const victim = await makeActiveUser()

    as(employee)
    const res = await request(app.getHttpServer())
      .post('/access-requests')
      .send({ businessRoleId: roleId, justification: 'sneaky', subjectUserId: victim.id })
      .expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
    expect(JSON.stringify(res.body)).toContain('subjectUserId')
  })

  it('an empty justification is rejected — the mandatory reason starts here', async () => {
    const { roleId } = await seedRequestableRole()
    const employee = await makeActiveUser()

    as(employee)
    await request(app.getHttpServer())
      .post('/access-requests')
      .send({ businessRoleId: roleId, justification: '' })
      .expect(400)
    await request(app.getHttpServer())
      .post('/access-requests')
      .send({ businessRoleId: roleId })
      .expect(400)
  })

  it('a subject with no manager falls back to role_holder:super_admin', async () => {
    const { roleId } = await seedRequestableRole()
    const orphan = await makeActiveUser() // no manager

    const id = await createPendingRequest(orphan, roleId)

    as(orphan)
    const mine = await request(app.getHttpServer()).get('/access-requests/mine').expect(200)
    expect(mine.body.requests.find((r: { id: string }) => r.id === id).approverResolver).toBe(
      'role_holder:super_admin',
    )
  })

  // =========================================================================
  // The inbox
  // =========================================================================

  it('shows a manager exactly their reports pending requests, and an uninvolved employee nothing', async () => {
    const { roleId } = await seedRequestableRole()
    const manager = await makeActiveUser()
    const employee = await makeActiveUser(undefined, manager.id)
    const bystander = await makeActiveUser()

    const id = await createPendingRequest(employee, roleId)

    as(manager)
    const inbox = await request(app.getHttpServer()).get('/access-requests/inbox').expect(200)
    const row = inbox.body.requests.find((r: { id: string }) => r.id === id)
    expect(row).toBeDefined()
    expect(row.subjectUsername).toBe(employee.username)

    as(bystander)
    const empty = await request(app.getHttpServer()).get('/access-requests/inbox').expect(200)
    expect(empty.body.requests.map((r: { id: string }) => r.id)).not.toContain(id)
  })

  it('routes manager-less subjects to super_admin holders via the fallback resolver', async () => {
    const { roleId } = await seedRequestableRole()
    const orphan = await makeActiveUser()
    const id = await createPendingRequest(orphan, roleId)

    as(globalAdmin)
    const inbox = await request(app.getHttpServer()).get('/access-requests/inbox').expect(200)
    expect(inbox.body.requests.map((r: { id: string }) => r.id)).toContain(id)
  })

  // =========================================================================
  // Approval — the effect is an INCLUDE EXCEPTION, never a bare membership
  // =========================================================================

  it('manager approval writes the include exception (request id + justification as reason, requested expiry as expiry) and the grant applies', async () => {
    const { roleId, groupId } = await seedRequestableRole()
    const manager = await makeActiveUser()
    const employee = await makeActiveUser(undefined, manager.id)
    const justification = `Need production read access #${nextSeq()}`
    const expiry = '2099-06-30T00:00:00.000Z'

    const id = await createPendingRequest(employee, roleId, justification, expiry)
    expect(await membershipsFor(employee.id)).toEqual([])

    as(manager)
    const res = await request(app.getHttpServer())
      .post(`/access-requests/${id}/approve`)
      .send({ comment: 'Approved for the audit season' })
      .expect(200)
    expect(res.body.state).toBe('approved')
    expect(res.body.decidedBy).toBe(manager.id)
    expect(res.body.decisionComment).toBe('Approved for the audit season')

    // The provenance-carrying exception, through the one existing path.
    const exceptions = await exceptionsFor(roleId)
    expect(exceptions).toEqual([
      expect.objectContaining({
        userId: employee.id,
        mode: 'include',
        grantedBy: manager.id,
      }),
    ])
    expect(exceptions[0].reason).toBe(`access request ${id}: ${justification}`)
    expect(exceptions[0].expiresAt?.toISOString()).toBe(expiry)

    // And the exception, not any imperative write, is what grants the group.
    expect(await membershipsFor(employee.id)).toEqual([
      expect.objectContaining({ groupId, grantSource: 'business_role' }),
    ])

    // Audit row, same transaction, naming the approver as actor.
    const audits = await ctx.db.select().from(auditLog).where(eq(auditLog.resourceId, id))
    const approveAudit = audits.find((a) => a.action === 'access_request:approve')
    expect(approveAudit).toBeDefined()
    expect(approveAudit?.actorUserId).toBe(manager.id)
  })

  it('a bystander (no admin grant, not the manager) cannot decide — 403', async () => {
    const { roleId } = await seedRequestableRole()
    const manager = await makeActiveUser()
    const employee = await makeActiveUser(undefined, manager.id)
    const bystander = await makeActiveUser()
    const id = await createPendingRequest(employee, roleId)

    as(bystander)
    await request(app.getHttpServer()).post(`/access-requests/${id}/approve`).send({}).expect(403)
    await request(app.getHttpServer()).post(`/access-requests/${id}/deny`).send({}).expect(403)
  })

  it('a global business_role:manage holder may decide as the admin path', async () => {
    const { roleId } = await seedRequestableRole()
    const manager = await makeActiveUser()
    const employee = await makeActiveUser(undefined, manager.id)
    const id = await createPendingRequest(employee, roleId)

    as(globalAdmin)
    const res = await request(app.getHttpServer())
      .post(`/access-requests/${id}/deny`)
      .send({ comment: 'Not during change freeze' })
      .expect(200)
    expect(res.body.state).toBe('denied')
    expect(res.body.decisionComment).toBe('Not during change freeze')
    expect(await exceptionsFor(roleId)).toEqual([])
  })

  it('NOBODY approves their own request — not even a global admin', async () => {
    const { roleId } = await seedRequestableRole()
    // The admin's own request: they hold business_role:manage globally AND
    // super_admin (the fallback approver role, since admins have no manager)
    // — every authority that could decide, and it must still be refused.
    const id = await createPendingRequest(globalAdmin, roleId)

    as(globalAdmin)
    const res = await request(app.getHttpServer())
      .post(`/access-requests/${id}/approve`)
      .send({})
      .expect(403)
    expect(res.body.message).toContain('your own')
    expect(await exceptionsFor(roleId)).toEqual([])

    // Someone else's super_admin can — the rule is self-decision, not admins.
    const otherAdmin = await makeActiveUser('super_admin')
    as(otherAdmin)
    await request(app.getHttpServer()).post(`/access-requests/${id}/approve`).send({}).expect(200)
  })

  // =========================================================================
  // Cancel, and the terminal-state rule
  // =========================================================================

  it('a requester can cancel their own pending request; anyone else gets a 404', async () => {
    const { roleId } = await seedRequestableRole()
    const manager = await makeActiveUser()
    const employee = await makeActiveUser(undefined, manager.id)
    const nosy = await makeActiveUser()
    const id = await createPendingRequest(employee, roleId)

    as(nosy)
    await request(app.getHttpServer()).post(`/access-requests/${id}/cancel`).expect(404)

    as(employee)
    const res = await request(app.getHttpServer()).post(`/access-requests/${id}/cancel`).expect(200)
    expect(res.body.state).toBe('cancelled')

    // Cancelled is terminal: the manager can no longer approve it.
    as(manager)
    const conflict = await request(app.getHttpServer())
      .post(`/access-requests/${id}/approve`)
      .send({})
      .expect(409)
    expect(conflict.body.message).toContain('cancelled')
  })

  it('a decided request never transitions again — no re-approve, no deny-after-approve, no cancel', async () => {
    const { roleId } = await seedRequestableRole()
    const manager = await makeActiveUser()
    const employee = await makeActiveUser(undefined, manager.id)
    const id = await createPendingRequest(employee, roleId)

    as(manager)
    await request(app.getHttpServer()).post(`/access-requests/${id}/approve`).send({}).expect(200)
    await request(app.getHttpServer()).post(`/access-requests/${id}/approve`).send({}).expect(409)
    await request(app.getHttpServer()).post(`/access-requests/${id}/deny`).send({}).expect(409)

    as(employee)
    await request(app.getHttpServer()).post(`/access-requests/${id}/cancel`).expect(409)
  })

  it('the decision follows a re-org: the CURRENT manager decides, the old one cannot', async () => {
    const { roleId } = await seedRequestableRole()
    const oldManager = await makeActiveUser()
    const newManager = await makeActiveUser()
    const employee = await makeActiveUser(undefined, oldManager.id)
    const id = await createPendingRequest(employee, roleId)

    await ctx.db.update(users).set({ managerId: newManager.id }).where(eq(users.id, employee.id))

    as(oldManager)
    await request(app.getHttpServer()).post(`/access-requests/${id}/approve`).send({}).expect(403)

    as(newManager)
    await request(app.getHttpServer()).post(`/access-requests/${id}/approve`).send({}).expect(200)
  })

  // =========================================================================
  // Resolvers are DATA, never code — the JML posture, applied here
  // =========================================================================

  describe('approver resolution is a closed vocabulary', () => {
    it('ships exactly the two documented resolvers', () => {
      expect([...APPROVER_RESOLVERS]).toEqual(['manager_of_subject', 'role_holder:super_admin'])
      expect(FALLBACK_APPROVER_ROLE).toBe('super_admin')
      expect(resolverForSubject({ managerId: 'someone' })).toBe('manager_of_subject')
      expect(resolverForSubject({ managerId: null })).toBe('role_holder:super_admin')
    })

    it('src/access-requests contains no eval(), no `new Function(...)`, and no bare Function(...) construction', () => {
      // The same static scan jml-rule-engine.spec.ts runs over src/jml.
      const dir = path.resolve(process.cwd(), 'src/access-requests')
      const files = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
        .map((entry) => path.join(dir, entry.name))
      expect(files.length).toBeGreaterThan(0)

      const offenders: string[] = []
      for (const file of files) {
        const text = readFileSync(file, 'utf8')
        if (
          /\beval\s*\(/.test(text) ||
          /\bnew\s+Function\s*\(/.test(text) ||
          /(?<!\w)Function\s*\(/.test(text)
        ) {
          offenders.push(path.relative(process.cwd(), file))
        }
      }
      expect(offenders).toEqual([])
    })
  })
})
