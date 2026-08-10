import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { and, desc, eq } from 'drizzle-orm'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import { ALL_ROLE_KEYS, ROLE_PERMISSIONS, type RoleKey } from '../src/authz/actions'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { BusinessRolesRepository } from '../src/business-roles/business-roles.repository'
import { RoleReconciler } from '../src/business-roles/role-reconciler'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { auditLog } from '../src/db/schema/audit-log'
import {
  businessRoleConditions,
  businessRoleExceptions,
  businessRoleGrants,
  businessRoles,
} from '../src/db/schema/business-roles'
import { groupUserMembers } from '../src/db/schema/group-members'
import { groups } from '../src/db/schema/groups'
import { orgUnits } from '../src/db/schema/org-units'
import { users } from '../src/db/schema/users'
import { OrganizationsRepository } from '../src/organizations/organizations.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { RecertCampaignsController } from '../src/recertification/recert-campaigns.controller'
import { RecertReviewsController } from '../src/recertification/recert-reviews.controller'
import { RecertRepository } from '../src/recertification/recert.repository'
import { UsersRepository, type User } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

/** Same technique as business-roles.controller.spec.ts. */
function stubJwtGuard(getUsername: () => string): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
        subject: 'recert-test',
        username: getUsername(),
        email: null,
      }
      return true
    },
  }
}

/**
 * RECERTIFICATION CAMPAIGNS over business-role entitlements.
 *
 * Only `JwtGuard` is stubbed; `PermissionGuard`/`PermissionEngine` run for
 * real, so `recert:read`/`recert:manage` — including the GLOBAL-grant
 * requirement on every mutating campaign route, and the identity-based
 * reviewer checks on the decide route — are genuinely exercised.
 *
 * FIXTURE ISOLATION: `withTestDatabase()` is one container per FILE with no
 * truncation between tests, and `RoleReconciler` evaluates EVERY enabled
 * role in the organization — so every fixture keys its role's condition on
 * a per-call jobTitle, every campaign is scoped to its own role ids, and
 * subjects are never shared between fixtures (exactly the discipline
 * business-roles.controller.spec.ts documents, for the same reason).
 */
describe('Recertification campaigns', () => {
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
      .values({ name: `Recert Root ${stamp}`, path: `recert_root_${stamp}`, organizationId })
      .returning()
    const [sales] = await ctx.db
      .insert(orgUnits)
      .values({
        name: `Recert Sales ${stamp}`,
        path: `recert_root_${stamp}.sales`,
        parentId: root.id,
        organizationId,
      })
      .returning()
    rootOrgUnitId = root.id
    salesOrgUnitId = sales.id

    const moduleRef = await Test.createTestingModule({
      controllers: [RecertCampaignsController, RecertReviewsController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        RecertRepository,
        BusinessRolesRepository,
        RoleReconciler,
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
    opts: { managerId?: string; jobTitle?: string } = {},
  ): Promise<User> {
    const tag = `rc${nextSeq()}-${Date.now()}`
    const created = await usersRepo().create({
      primaryEmail: `${tag}@example.com`,
      username: `${tag}@example.com`,
      firstName: 'Recert',
      lastName: `Fixture ${tag}`,
      orgUnitId: scopeOrgUnitId ?? rootOrgUnitId,
      ...(opts.managerId !== undefined ? { managerId: opts.managerId } : {}),
      ...(opts.jobTitle !== undefined ? { jobTitle: opts.jobTitle } : {}),
    })
    const active = await usersRepo().changeStatus(created.id, 'active')
    if (roleKey !== undefined) {
      await rolesRepo().assign({ userId: active.id, roleKey, scopeOrgUnitId })
    }
    return active
  }

  /** Acts as this person for the next request. */
  function as(actor: User): void {
    currentUsername = actor.username
  }

  /**
   * An ENABLED business role granting one group, keyed on a per-fixture
   * jobTitle — built directly in the database (the draft/simulate/publish
   * pipeline is business-roles.controller.spec.ts's subject, not this
   * file's).
   */
  async function makeEnabledRole(jobTitle: string): Promise<{ roleId: string; groupId: string }> {
    const n = nextSeq()
    const [group] = await ctx.db
      .insert(groups)
      .values({ name: `Recert Group ${n} ${Date.now()}`, organizationId })
      .returning()
    const [role] = await ctx.db
      .insert(businessRoles)
      .values({ name: `Recert Role ${n} ${Date.now()}`, organizationId, enabled: true })
      .returning()
    await ctx.db
      .insert(businessRoleConditions)
      .values({ businessRoleId: role.id, field: 'jobTitle', operator: 'equals', value: jobTitle })
    await ctx.db
      .insert(businessRoleGrants)
      .values({ businessRoleId: role.id, kind: 'group_membership', groupId: group.id, target: null })
    return { roleId: role.id, groupId: group.id }
  }

  async function addInclude(
    roleId: string,
    userId: string,
    reason: string,
    expiresAt: Date | null = null,
    mode: 'include' | 'exclude' = 'include',
  ): Promise<void> {
    await ctx.db
      .insert(businessRoleExceptions)
      .values({ businessRoleId: roleId, userId, mode, reason, expiresAt })
  }

  /** Makes the engine grant what it currently wants for this user — real provenance-carrying state for a snapshot to read. */
  async function reconcile(userId: string): Promise<void> {
    const reconciler = app.get(RoleReconciler)
    await ctx.db.transaction(async (tx) => {
      const outcome = await reconciler.reconcileUser(tx, userId, null, new Date())
      expect(outcome.status).toBe('applied')
    })
  }

  async function membershipsFor(userId: string) {
    return ctx.db.select().from(groupUserMembers).where(eq(groupUserMembers.userId, userId))
  }

  async function createCampaign(
    scopeRoleIds: string[],
    reviewerStrategy: 'manager_of_subject' | 'role_owner' = 'manager_of_subject',
  ): Promise<string> {
    as(globalAdmin)
    const created = await request(app.getHttpServer())
      .post('/recert-campaigns')
      .send({ name: `Campaign ${nextSeq()} ${Date.now()}`, scopeRoleIds, reviewerStrategy })
      .expect(201)
    expect(created.body.status).toBe('draft')
    return created.body.id as string
  }

  async function openCampaign(campaignId: string) {
    as(globalAdmin)
    const opened = await request(app.getHttpServer())
      .post(`/recert-campaigns/${campaignId}/open`)
      .expect(200)
    return opened.body as {
      status: string
      itemsTotal: number
      itemsDecided: number
      items: Array<{
        id: string
        itemKind: string
        businessRoleId: string
        subjectUserId: string | null
        memberCount: number | null
        exceptionReason: string | null
        reviewerUserId: string
        decision: string
      }>
    }
  }

  // =========================================================================
  // The action catalog
  // =========================================================================

  it('recert:manage is held by super_admin alone; recert:read mirrors business_role:read', () => {
    for (const role of ALL_ROLE_KEYS) {
      expect(ROLE_PERMISSIONS[role].includes('recert:manage')).toBe(role === 'super_admin')
    }
    expect(ALL_ROLE_KEYS.filter((r) => ROLE_PERMISSIONS[r].includes('recert:read')).sort()).toEqual(
      ['auditor', 'read_only', 'super_admin', 'user_admin'].sort(),
    )
  })

  // =========================================================================
  // Authorization on the operator surface
  // =========================================================================

  it('rejects a caller holding no role at all from the campaign list', async () => {
    as(await makeActiveUser())
    await request(app.getHttpServer()).get('/recert-campaigns').expect(403)
  })

  it('read_only can list campaigns — an attestation record describes access, it does not confer it', async () => {
    as(await makeActiveUser('read_only'))
    await request(app.getHttpServer()).get('/recert-campaigns').expect(200)
  })

  it('an auditor cannot create a campaign — recert:read is not recert:manage', async () => {
    as(await makeActiveUser('auditor'))
    await request(app.getHttpServer())
      .post('/recert-campaigns')
      .send({ name: `Auditor attempt ${nextSeq()}`, reviewerStrategy: 'manager_of_subject' })
      .expect(403)
  })

  it('a SCOPED super_admin cannot create a campaign — the grant must be global', async () => {
    as(await makeActiveUser('super_admin', salesOrgUnitId))
    await request(app.getHttpServer())
      .post('/recert-campaigns')
      .send({ name: `Scoped attempt ${nextSeq()}`, reviewerStrategy: 'manager_of_subject' })
      .expect(403)
  })

  it('rejects an unknown field on create — .strict(), never a silent drop', async () => {
    as(globalAdmin)
    await request(app.getHttpServer())
      .post('/recert-campaigns')
      .send({ name: 'x', reviewerStrategy: 'manager_of_subject', status: 'open' })
      .expect(400)
  })

  // =========================================================================
  // Opening: the snapshot
  // =========================================================================

  it('opening snapshots formula-per-role and exception-per-person, honouring the asymmetry', async () => {
    const jobTitle = `Recert AE #${nextSeq()}`
    const { roleId, groupId } = await makeEnabledRole(jobTitle)

    // Two people the FORMULA holds.
    await makeActiveUser(undefined, null, { jobTitle })
    await makeActiveUser(undefined, null, { jobTitle })

    // One live include (with a manager, so manager_of_subject resolves to
    // them), one expired include, one exclude — only the live include may
    // become an item.
    const manager = await makeActiveUser()
    const included = await makeActiveUser(undefined, null, { managerId: manager.id })
    await addInclude(roleId, included.id, 'temporary project access')
    const expired = await makeActiveUser()
    await addInclude(roleId, expired.id, 'expired long ago', new Date(Date.now() - 60_000))
    const excluded = await makeActiveUser(undefined, null, { jobTitle })
    await addInclude(roleId, excluded.id, 'on leave', null, 'exclude')

    const campaignId = await createCampaign([roleId])
    const detail = await openCampaign(campaignId)

    expect(detail.status).toBe('open')
    expect(detail.items).toHaveLength(2)
    expect(detail.itemsTotal).toBe(2)
    expect(detail.itemsDecided).toBe(0)

    const formula = detail.items.find((item) => item.itemKind === 'role_formula')
    expect(formula).toBeDefined()
    // The formula count is FORMULA matches: the two matching hires plus the
    // excluded matcher (the formula still matches them; the exception is
    // reviewed as data, not folded into the count) — and NOT the included
    // person, who the formula does not hold.
    expect(formula?.memberCount).toBe(3)
    expect(formula?.subjectUserId).toBeNull()
    expect(formula?.reviewerUserId).toBe(globalAdmin.id)

    const exception = detail.items.find((item) => item.itemKind === 'include_exception')
    expect(exception).toBeDefined()
    expect(exception?.subjectUserId).toBe(included.id)
    expect(exception?.exceptionReason).toBe('temporary project access')
    expect(exception?.reviewerUserId).toBe(manager.id)

    // The audit trail: one row for the open, in the same transaction.
    const [audit] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'recert_campaign:open'), eq(auditLog.resourceId, campaignId)))
    expect(audit).toBeDefined()
    expect((audit.after as { itemsTotal: number }).itemsTotal).toBe(2)

    // draft → open happened; open → open must not.
    as(globalAdmin)
    await request(app.getHttpServer()).post(`/recert-campaigns/${campaignId}/open`).expect(409)
  })

  it('refuses to open when the scope names a role that does not exist, leaving the campaign draft', async () => {
    const campaignId = await createCampaign(['00000000-0000-4000-8000-000000000000'])
    as(globalAdmin)
    await request(app.getHttpServer()).post(`/recert-campaigns/${campaignId}/open`).expect(404)
    const detail = await request(app.getHttpServer()).get(`/recert-campaigns/${campaignId}`).expect(200)
    expect(detail.body.status).toBe('draft')
    expect(detail.body.items).toHaveLength(0)
  })

  it('refuses to open when an include-exception subject has no reviewer other than themselves', async () => {
    const { roleId } = await makeEnabledRole(`Recert Self #${nextSeq()}`)
    // The campaign creator is the subject, and the subject has no manager:
    // every candidate in the chain IS the subject.
    await addInclude(roleId, globalAdmin.id, 'creator self-grant')
    const campaignId = await createCampaign([roleId], 'role_owner')
    as(globalAdmin)
    const refused = await request(app.getHttpServer())
      .post(`/recert-campaigns/${campaignId}/open`)
      .expect(409)
    expect(refused.body.message).toContain('nobody reviews their own access')
    const detail = await request(app.getHttpServer()).get(`/recert-campaigns/${campaignId}`).expect(200)
    expect(detail.body.status).toBe('draft')
  })

  // =========================================================================
  // The reviewer queue and decisions
  // =========================================================================

  it('my-reviews lists exactly the caller’s pending items; certify records the attestation and touches nothing else', async () => {
    const jobTitle = `Recert Certify #${nextSeq()}`
    const { roleId, groupId } = await makeEnabledRole(jobTitle)
    const manager = await makeActiveUser()
    const included = await makeActiveUser(undefined, null, { managerId: manager.id })
    await addInclude(roleId, included.id, 'quarter-end reporting access')
    await reconcile(included.id)
    expect((await membershipsFor(included.id)).map((m) => m.groupId)).toContain(groupId)

    const campaignId = await createCampaign([roleId])
    await openCampaign(campaignId)

    // The manager sees their one item, reason attached; a bystander sees none.
    as(manager)
    const queue = await request(app.getHttpServer()).get('/recert/my-reviews').expect(200)
    expect(queue.body).toHaveLength(1)
    expect(queue.body[0].subject.id).toBe(included.id)
    expect(queue.body[0].exceptionReason).toBe('quarter-end reporting access')
    expect(queue.body[0].campaign.id).toBe(campaignId)

    as(await makeActiveUser())
    const empty = await request(app.getHttpServer()).get('/recert/my-reviews').expect(200)
    expect(empty.body).toHaveLength(0)

    // Certify: attestation only.
    as(manager)
    const decided = await request(app.getHttpServer())
      .post(`/recert/items/${queue.body[0].id}/decide`)
      .send({ decision: 'certified', comment: 'still needed through Q3' })
      .expect(200)
    expect(decided.body.effect).toBe('attested')
    expect(decided.body.item.decision).toBe('certified')
    expect(decided.body.item.decidedBy).toBe(manager.id)

    // The membership and the exception both survive a certification.
    expect((await membershipsFor(included.id)).map((m) => m.groupId)).toContain(groupId)
    const [exception] = await ctx.db
      .select()
      .from(businessRoleExceptions)
      .where(
        and(
          eq(businessRoleExceptions.businessRoleId, roleId),
          eq(businessRoleExceptions.userId, included.id),
        ),
      )
    expect(exception.expiresAt).toBeNull()

    // Decided items leave the queue; deciding again is a 409, decisions are final.
    const drained = await request(app.getHttpServer()).get('/recert/my-reviews').expect(200)
    expect(drained.body).toHaveLength(0)
    await request(app.getHttpServer())
      .post(`/recert/items/${queue.body[0].id}/decide`)
      .send({ decision: 'certified' })
      .expect(409)

    // One audit row for the decision.
    const [audit] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'recert_item:decide'), eq(auditLog.resourceId, queue.body[0].id)))
    expect(audit).toBeDefined()

    // Progress moved.
    as(globalAdmin)
    const detail = await request(app.getHttpServer()).get(`/recert-campaigns/${campaignId}`).expect(200)
    expect(detail.body.itemsTotal).toBe(2)
    expect(detail.body.itemsDecided).toBe(1)
  })

  it('revoking an include-exception EXPIRES it and the reconciler revokes what it granted — manual grants survive', async () => {
    const jobTitle = `Recert Revoke #${nextSeq()}`
    const { roleId, groupId } = await makeEnabledRole(jobTitle)
    const manager = await makeActiveUser()
    const included = await makeActiveUser(undefined, null, { managerId: manager.id })
    await addInclude(roleId, included.id, 'contractor onboarding')
    await reconcile(included.id)
    const before = await membershipsFor(included.id)
    expect(before.find((m) => m.groupId === groupId)?.grantSource).toBe('business_role')

    // A bystander with a HAND-ADDED membership in the same group.
    const manual = await makeActiveUser()
    await ctx.db.insert(groupUserMembers).values({
      groupId,
      userId: manual.id,
      organizationId,
      grantSource: 'manual',
      grantedBy: globalAdmin.id,
      grantedAt: new Date(),
    })

    const campaignId = await createCampaign([roleId])
    const opened = await openCampaign(campaignId)
    const item = opened.items.find((i) => i.itemKind === 'include_exception')
    expect(item?.subjectUserId).toBe(included.id)

    as(manager)
    const decided = await request(app.getHttpServer())
      .post(`/recert/items/${item!.id}/decide`)
      .send({ decision: 'revoked_requested', comment: 'contract ended' })
      .expect(200)
    expect(decided.body.effect).toBe('exception_expired')

    // The exception is expired — never deleted — so the record of why it
    // existed survives; the reconciler removed the membership it granted.
    const [exception] = await ctx.db
      .select()
      .from(businessRoleExceptions)
      .where(
        and(
          eq(businessRoleExceptions.businessRoleId, roleId),
          eq(businessRoleExceptions.userId, included.id),
        ),
      )
    expect(exception.expiresAt).not.toBeNull()
    expect(exception.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now())
    expect(exception.reason).toBe('contractor onboarding')

    expect((await membershipsFor(included.id)).map((m) => m.groupId)).not.toContain(groupId)

    // The hand-added membership is untouched: the engine only ever revokes
    // what it granted.
    const manualRows = await membershipsFor(manual.id)
    expect(manualRows.find((m) => m.groupId === groupId)?.grantSource).toBe('manual')

    // Both audit rows exist: the decision, and the exception change written
    // in the SAME shape addException writes.
    const decideAudits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'recert_item:decide'), eq(auditLog.resourceId, item!.id)))
    expect(decideAudits).toHaveLength(1)
    const exceptionAudits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'business_role:exception_set'), eq(auditLog.resourceId, roleId)))
      .orderBy(desc(auditLog.createdAt))
    expect(exceptionAudits.length).toBeGreaterThan(0)
  })

  it('revoking a FORMULA item records the finding and strips nobody', async () => {
    const jobTitle = `Recert Formula #${nextSeq()}`
    const { roleId, groupId } = await makeEnabledRole(jobTitle)
    const holder = await makeActiveUser(undefined, null, { jobTitle })
    await reconcile(holder.id)
    expect((await membershipsFor(holder.id)).map((m) => m.groupId)).toContain(groupId)

    const campaignId = await createCampaign([roleId])
    const opened = await openCampaign(campaignId)
    const formula = opened.items.find((i) => i.itemKind === 'role_formula')
    expect(formula?.memberCount).toBe(1)

    as(globalAdmin)
    const decided = await request(app.getHttpServer())
      .post(`/recert/items/${formula!.id}/decide`)
      .send({ decision: 'revoked_requested', comment: 'formula looks too broad' })
      .expect(200)
    expect(decided.body.effect).toBe('finding_recorded')

    // The campaign performed NO revocation: the holder's derived membership
    // is exactly where it was. Removing it is the role editor's job, behind
    // the draft/simulate/publish gate.
    expect((await membershipsFor(holder.id)).map((m) => m.groupId)).toContain(groupId)
    const [role] = await ctx.db.select().from(businessRoles).where(eq(businessRoles.id, roleId))
    expect(role.enabled).toBe(true)
  })

  // =========================================================================
  // Who may decide
  // =========================================================================

  it('nobody reviews their own access — not even a global super_admin; a bystander is refused; another admin may decide', async () => {
    const { roleId } = await makeEnabledRole(`Recert Self-review #${nextSeq()}`)
    // The subject is themselves a GLOBAL super_admin — the strongest caller
    // the system has — with no manager, so the reviewer falls back to the
    // campaign's creator (globalAdmin).
    const adminSubject = await makeActiveUser('super_admin')
    await addInclude(roleId, adminSubject.id, 'admin holds elevated data access')

    const campaignId = await createCampaign([roleId])
    const opened = await openCampaign(campaignId)
    const item = opened.items.find((i) => i.itemKind === 'include_exception')
    expect(item?.reviewerUserId).toBe(globalAdmin.id)

    // The subject: refused BEFORE their adminhood is consulted.
    as(adminSubject)
    const refused = await request(app.getHttpServer())
      .post(`/recert/items/${item!.id}/decide`)
      .send({ decision: 'certified' })
      .expect(403)
    expect(refused.body.message).toContain('nobody reviews their own access')

    // An unrelated person with no grant: refused.
    as(await makeActiveUser())
    await request(app.getHttpServer())
      .post(`/recert/items/${item!.id}/decide`)
      .send({ decision: 'certified' })
      .expect(403)

    // A SCOPED super_admin is not an admin here — the grant must be global.
    as(await makeActiveUser('super_admin', salesOrgUnitId))
    await request(app.getHttpServer())
      .post(`/recert/items/${item!.id}/decide`)
      .send({ decision: 'certified' })
      .expect(403)

    // A DIFFERENT global admin — not the resolved reviewer — may decide.
    as(await makeActiveUser('super_admin'))
    const decided = await request(app.getHttpServer())
      .post(`/recert/items/${item!.id}/decide`)
      .send({ decision: 'certified' })
      .expect(200)
    expect(decided.body.effect).toBe('attested')
  })

  it('rejects an unknown field on decide — .strict()', async () => {
    const { roleId } = await makeEnabledRole(`Recert Strict #${nextSeq()}`)
    const campaignId = await createCampaign([roleId])
    const opened = await openCampaign(campaignId)
    as(globalAdmin)
    await request(app.getHttpServer())
      .post(`/recert/items/${opened.items[0].id}/decide`)
      .send({ decision: 'certified', decidedBy: globalAdmin.id })
      .expect(400)
  })

  // =========================================================================
  // Closing
  // =========================================================================

  it('close is terminal: a closed campaign accepts no decisions, cannot reopen, and empties queues honestly', async () => {
    const { roleId } = await makeEnabledRole(`Recert Close #${nextSeq()}`)
    const manager = await makeActiveUser()
    const included = await makeActiveUser(undefined, null, { managerId: manager.id })
    await addInclude(roleId, included.id, 'pending review at close time')

    const campaignId = await createCampaign([roleId])
    const opened = await openCampaign(campaignId)
    const item = opened.items.find((i) => i.itemKind === 'include_exception')

    as(globalAdmin)
    const closed = await request(app.getHttpServer())
      .post(`/recert-campaigns/${campaignId}/close`)
      .expect(200)
    expect(closed.body.status).toBe('closed')

    // The undecided item stays pending — an honest record — but leaves the
    // reviewer's queue, and can no longer be decided.
    as(manager)
    const queue = await request(app.getHttpServer()).get('/recert/my-reviews').expect(200)
    expect(queue.body.map((q: { id: string }) => q.id)).not.toContain(item!.id)
    await request(app.getHttpServer())
      .post(`/recert/items/${item!.id}/decide`)
      .send({ decision: 'certified' })
      .expect(409)

    // Terminal: no re-close, no reopen.
    as(globalAdmin)
    await request(app.getHttpServer()).post(`/recert-campaigns/${campaignId}/close`).expect(409)
    await request(app.getHttpServer()).post(`/recert-campaigns/${campaignId}/open`).expect(409)

    const [audit] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'recert_campaign:close'), eq(auditLog.resourceId, campaignId)))
    expect(audit).toBeDefined()
  })

  it('a DRAFT campaign cannot be closed — it was never open', async () => {
    const { roleId } = await makeEnabledRole(`Recert DraftClose #${nextSeq()}`)
    const campaignId = await createCampaign([roleId])
    as(globalAdmin)
    await request(app.getHttpServer()).post(`/recert-campaigns/${campaignId}/close`).expect(409)
  })
})
