import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import type { RoleKey } from '../src/authz/actions'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import { PrivilegeGuards } from '../src/authz/privilege.guards'
import { RoleAssignmentsController } from '../src/authz/role-assignments.controller'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { OrgUnitsRepository, type OrgUnit } from '../src/org-units/org-units.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { UsersRepository } from '../src/users/users.repository'
import { type TestDatabase, withTestDatabase } from './support/pg'

/**
 * Stamps `request.principal` from whatever `getUsername()` returns AT
 * REQUEST TIME — same technique as users.write.spec.ts / groups.write.spec.ts.
 */
function stubJwtGuard(getUsername: () => string): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
        subject: 'kc-role-write-test',
        username: getUsername(),
        email: null,
      }
      return true
    },
  }
}

interface AuditLogRow {
  id: number
  actor_user_id: string | null
  action: string
  resource_type: string
  resource_id: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  created_at: string
}

/**
 * Scoped to a specific resource_id, never "the newest row" or a table
 * count — same reasoning as users.write.spec.ts's file-level comment: audit
 * rows can never be deleted, so this file cannot reset between tests.
 * `resourceId` here is the role_assignment's OWN id (see
 * role-assignments.controller.ts's doc comment for why it, not the target
 * user's id, is the anchor) — both `role:assign` and `role:revoke` for the
 * SAME grant land under the SAME resource_id, so this returns that grant's
 * full lifecycle in creation order.
 */
async function auditRowsFor(ctx: TestDatabase, resourceId: string): Promise<AuditLogRow[]> {
  const { rows } = await ctx.pool.query<AuditLogRow>(
    "SELECT * FROM audit_log WHERE resource_type = 'role_assignment' AND resource_id = $1 ORDER BY id ASC",
    [resourceId],
  )
  return rows
}

async function totalAuditCount(ctx: TestDatabase): Promise<number> {
  const { rows } = await ctx.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM audit_log')
  return rows[0]?.count ?? 0
}

/**
 * Table-wide, like `totalAuditCount` above — used by the finding H-1
 * regression block (docs/superpowers/audit-authz.md) to prove a rejected
 * assign/revoke leaves outbox_events untouched too, not just audit_log. No
 * other describe block in this file checks the outbox (that is
 * outbox-emission.spec.ts's job for the success paths); H-1's own "a
 * rejected request must still write ZERO audit rows and ZERO outbox events"
 * requirement is what earns it a dedicated check here.
 */
async function totalOutboxCount(ctx: TestDatabase): Promise<number> {
  const { rows } = await ctx.pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM outbox_events',
  )
  return rows[0]?.count ?? 0
}

const BOGUS_ID = '00000000-0000-0000-0000-000000000000'

/**
 * MILESTONE 3b, TASK 4: role assignment write endpoints — the final task of
 * this milestone, and the most security-sensitive writes in the system,
 * because getting them wrong is privilege escalation rather than mere
 * disclosure. Same audit-FK isolation constraint as every other write-spec
 * file this milestone (see users.write.spec.ts's file-level comment for the
 * full explanation): this file never does `DELETE FROM users` or
 * `DELETE FROM org_units` between tests. Every fixture is uniquely named per
 * call (`nextTag()`), rows accumulate for the life of the file's own
 * Testcontainer, and every assertion is scoped to the specific
 * role_assignment each test created.
 *
 * ONLY `super_admin` holds `role:assign` in today's static role catalog
 * (ROLE_PERMISSIONS in authz/actions.ts) — no lower-privileged role grants
 * it, unlike `user:update` or `group:manage_members`. Every actor fixture
 * below that is expected to REACH these routes at all therefore holds
 * `super_admin`, either GLOBAL (`scopeOrgUnitId: null`) or SCOPED to a
 * specific org unit, exactly as each test requires.
 *
 * REACHABILITY NOTE — read before assuming a "missing" test was overlooked.
 * task-4-brief.md's "Tests that matter" lists two rejection scenarios this
 * file deliberately does NOT attempt as HTTP-level tests, because they are
 * provably unreachable through this specific controller given today's
 * catalog:
 *
 *   - "An actor cannot grant a role they do not hold" (PrivilegeGuards
 *     .assertCanAssignRole's `holdings.length === 0` branch): that method
 *     treats holding `super_admin` itself as sufficient to grant ANY role
 *     (`assignment.roleKey === roleKey || assignment.roleKey ===
 *     'super_admin'` — see its own doc comment: a super_admin may grant
 *     literally anything, subject to scope). Since ONLY super_admin ever
 *     reaches this controller (PermissionGuard's entry check for
 *     `role:assign` requires it), EVERY actor that gets this far already
 *     satisfies that OR-clause for every possible `roleKey`, so
 *     `holdings.length === 0` can never fire here. It is fully reachable —
 *     and already exhaustively covered — at the unit level, directly
 *     against PrivilegeGuards, in privilege.guards.spec.ts ("refuses to let
 *     an actor grant a role they do not hold").
 *   - "An actor cannot assign a role to a principal who outranks them"
 *     (PrivilegeGuards.assertCanModifyPrincipal's rejection branch): that
 *     method throws only when the ACTOR's highest rank is LESS than the
 *     TARGET's. `super_admin` is the top of ROLE_RANK (40 — see actions.ts);
 *     nothing outranks it, tie included (`40 < 40` is false). Since every
 *     actor that reaches this controller holds `super_admin` (rank 40,
 *     regardless of whether that holding is scoped or global — rank is a
 *     pure function of `roleKey`, independent of scope), no legitimate
 *     target can ever exceed the acting principal's rank here. This is
 *     ALSO fully reachable and covered at the unit level in
 *     privilege.guards.spec.ts, using non-super_admin actors that cannot
 *     reach this controller's routes at all.
 *
 * Both methods are still called unconditionally by every route below (see
 * role-assignments.controller.ts) — required regardless of current
 * reachability, and load-bearing the moment a future catalog change ever
 * grants `role:assign` to a role below the rank ceiling. What IS exercised
 * here, reachable and specific to this controller's wiring: assertCanAssignRole's
 * SCOPE branches (global-grant-by-a-scoped-holder, and
 * grant-outside-the-holder's-own-subtree), the entry gate
 * (PermissionGuard, for an actor holding no `role:assign` grant at all),
 * and a positive equal-rank case proving assertCanModifyPrincipal does not
 * over-block.
 */
describe('role assignment write endpoints (Milestone 3b, Task 4)', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let currentUsername = ''

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RoleAssignmentsController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        RoleAssignmentsRepository,
        // Finding H-1 (docs/superpowers/audit-authz.md): RoleAssignmentsController
        // now loads the target user for the missing fourth check
        // (assertCanIn against the target's own org unit) — required here
        // for DI resolution.
        UsersRepository,
        PermissionEngine,
        PermissionGuard,
        PrivilegeGuards,
        AuditWriter,
        OutboxWriter,
        Reflector,
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue(stubJwtGuard(() => currentUsername))
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
  })

  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `rawr${fixtureSeq}`
  }

  const orgUnitsRepo = () => new OrgUnitsRepository(ctx.db)
  const usersRepo = () => new UsersRepository(ctx.db)
  const rolesRepo = () => new RoleAssignmentsRepository(ctx.db)

  async function makeOrgUnit(label: string): Promise<OrgUnit> {
    return orgUnitsRepo().createRoot(`${label} ${nextTag()}`)
  }

  async function makeChildOrgUnit(parentId: string, label: string): Promise<OrgUnit> {
    return orgUnitsRepo().createChild(parentId, `${label} ${nextTag()}`)
  }

  async function makeActiveUser(role: string, orgUnitId: string) {
    const tag = nextTag()
    const created = await usersRepo().create({
      primaryEmail: `${role}-${tag}@example.com`,
      username: `${role}-${tag}`,
      firstName: 'Test',
      lastName: 'User',
      orgUnitId,
    })
    return usersRepo().changeStatus(created.id, 'active')
  }

  async function grant(userId: string, roleKey: RoleKey, scopeOrgUnitId?: string | null) {
    return rolesRepo().assign({ userId, roleKey, scopeOrgUnitId })
  }

  // =======================================================================
  // POST /users/:id/roles
  // =======================================================================
  describe('POST /users/:id/roles', () => {
    it('a global super_admin assigns a role at a specific scope, audited exactly once', async () => {
      const org = await makeOrgUnit('Assign Root')
      const actor = await makeActiveUser('assigner', org.id)
      await grant(actor.id, 'super_admin', null)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/roles`)
        .send({ roleKey: 'user_admin', scopeOrgUnitId: org.id })
        .expect(201)

      expect(res.body.userId).toBe(target.id)
      expect(res.body.roleKey).toBe('user_admin')
      expect(res.body.scopeOrgUnitId).toBe(org.id)

      const rows = await auditRowsFor(ctx, res.body.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].action).toBe('role:assign')
      expect(rows[0].actor_user_id).toBe(actor.id)
      expect(rows[0].before).toBeNull()
      expect(rows[0].after?.userId).toBe(target.id)
      expect(rows[0].after?.roleKey).toBe('user_admin')
      expect(rows[0].after?.scopeOrgUnitId).toBe(org.id)
    })

    it('omitting scopeOrgUnitId assigns a GLOBAL role, audited once', async () => {
      const org = await makeOrgUnit('Global Assign Root')
      const actor = await makeActiveUser('assigner', org.id)
      await grant(actor.id, 'super_admin', null)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/roles`)
        .send({ roleKey: 'read_only' })
        .expect(201)

      expect(res.body.scopeOrgUnitId).toBeNull()
      expect(await auditRowsFor(ctx, res.body.id)).toHaveLength(1)
    })

    it('a scoped super_admin assigns a role at a narrower scope inside their own subtree, audited once', async () => {
      const root = await makeOrgUnit('Delegate Root')
      const child = await makeChildOrgUnit(root.id, 'Child')
      const actor = await makeActiveUser('delegator', root.id)
      await grant(actor.id, 'super_admin', root.id) // SCOPED, not global
      const target = await makeActiveUser('target', child.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/roles`)
        .send({ roleKey: 'help_desk', scopeOrgUnitId: child.id })
        .expect(201)

      expect(await auditRowsFor(ctx, res.body.id)).toHaveLength(1)
    })

    // THE headline escalation path the whole task exists to close: a SCOPED
    // holding must never produce a GLOBAL grant.
    it('rejects a scoped super_admin granting a GLOBAL role, with 403 and no audit row', async () => {
      const root = await makeOrgUnit('No Global Root')
      const actor = await makeActiveUser('delegator', root.id)
      await grant(actor.id, 'super_admin', root.id) // SCOPED
      const target = await makeActiveUser('target', root.id)
      currentUsername = actor.username

      const before = await totalAuditCount(ctx)

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/roles`)
        .send({ roleKey: 'help_desk' }) // no scopeOrgUnitId -> global
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await totalAuditCount(ctx)).toBe(before)
    })

    it('rejects a scoped super_admin granting a role outside their own subtree, with 403 and no audit row', async () => {
      const root = await makeOrgUnit('Subtree Root')
      const scopeOrg = await makeChildOrgUnit(root.id, 'In Scope')
      const otherOrg = await makeChildOrgUnit(root.id, 'Out Of Scope')
      const actor = await makeActiveUser('delegator', scopeOrg.id)
      await grant(actor.id, 'super_admin', scopeOrg.id)
      const target = await makeActiveUser('target', otherOrg.id)
      currentUsername = actor.username

      const before = await totalAuditCount(ctx)

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/roles`)
        .send({ roleKey: 'help_desk', scopeOrgUnitId: otherOrg.id })
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await totalAuditCount(ctx)).toBe(before)
    })

    // Positive coverage for assertCanModifyPrincipal: equal rank is not
    // "outranks" (strict `<`), so a super_admin granting an ADDITIONAL role
    // to another super_admin must succeed, not be over-blocked.
    it('a global super_admin grants a role to another super_admin (equal rank is not outranking)', async () => {
      const org = await makeOrgUnit('Equal Rank Root')
      const actor = await makeActiveUser('assigner', org.id)
      await grant(actor.id, 'super_admin', null)
      const boss = await makeActiveUser('boss', org.id)
      await grant(boss.id, 'super_admin', null)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/users/${boss.id}/roles`)
        .send({ roleKey: 'auditor', scopeOrgUnitId: org.id })
        .expect(201)

      expect(await auditRowsFor(ctx, res.body.id)).toHaveLength(1)
    })

    // Check 1 (PermissionGuard): an actor with real, substantial permissions
    // — just not role:assign — never reaches assertCanAssignRole /
    // assertCanModifyPrincipal at all.
    it('rejects an actor who does not hold role:assign at all, with 403 and no audit row', async () => {
      const org = await makeOrgUnit('No Permission Root')
      const actor = await makeActiveUser('mere-admin', org.id)
      await grant(actor.id, 'user_admin', org.id) // real grants, but not role:assign
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      const before = await totalAuditCount(ctx)

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/roles`)
        .send({ roleKey: 'read_only', scopeOrgUnitId: org.id })
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await totalAuditCount(ctx)).toBe(before)
    })

    it('rejects a duplicate SCOPED assignment with 409 CONFLICT naming the scope, and writes no audit row', async () => {
      const org = await makeOrgUnit('Duplicate Scoped Root')
      const actor = await makeActiveUser('assigner', org.id)
      await grant(actor.id, 'super_admin', null)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      const first = await request(app.getHttpServer())
        .post(`/users/${target.id}/roles`)
        .send({ roleKey: 'help_desk', scopeOrgUnitId: org.id })
        .expect(201)
      expect(await auditRowsFor(ctx, first.body.id)).toHaveLength(1)

      const before = await totalAuditCount(ctx)
      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/roles`)
        .send({ roleKey: 'help_desk', scopeOrgUnitId: org.id })
        .expect(409)
      expect(res.body.code).toBe('CONFLICT')
      expect(res.body.message).toContain('scope')
      expect(res.body.message).toContain(org.id)

      expect(await totalAuditCount(ctx)).toBe(before)
    })

    // The fix this task makes: the GLOBAL collision must NOT reuse the
    // scoped message ("at this scope" / "at scope ...") — there is no scope
    // to name for a duplicate GLOBAL grant.
    it('rejects a duplicate GLOBAL assignment with 409 CONFLICT naming it as global, not as a scope, and writes no audit row', async () => {
      const org = await makeOrgUnit('Duplicate Global Root')
      const actor = await makeActiveUser('assigner', org.id)
      await grant(actor.id, 'super_admin', null)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      const first = await request(app.getHttpServer())
        .post(`/users/${target.id}/roles`)
        .send({ roleKey: 'auditor' })
        .expect(201)
      expect(await auditRowsFor(ctx, first.body.id)).toHaveLength(1)

      const before = await totalAuditCount(ctx)
      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/roles`)
        .send({ roleKey: 'auditor' })
        .expect(409)
      expect(res.body.code).toBe('CONFLICT')
      expect(res.body.message).toContain('globally')
      expect(res.body.message).not.toContain('scope')

      expect(await totalAuditCount(ctx)).toBe(before)
    })

    it('maps a nonexistent target user to 404 NOT_FOUND and writes no audit row', async () => {
      const org = await makeOrgUnit('Bogus User Root')
      const actor = await makeActiveUser('assigner', org.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      const before = await totalAuditCount(ctx)

      const res = await request(app.getHttpServer())
        .post(`/users/${BOGUS_ID}/roles`)
        .send({ roleKey: 'read_only' })
        .expect(404)
      expect(res.body.code).toBe('NOT_FOUND')
      expect(res.body.message).toContain('user')

      expect(await totalAuditCount(ctx)).toBe(before)
    })

    // A GLOBAL actor deliberately: a SCOPED actor given a bogus
    // scopeOrgUnitId gets 403 from assertCanAssignRole's own containment
    // query (which finds no row — indistinguishable from "exists but out of
    // scope"), never reaching the repository's own pre-check — same
    // reasoning as org-units.write.spec.ts's bogus-parentId test.
    it('maps a nonexistent scopeOrgUnitId to 404 NOT_FOUND rather than an unmapped 500, and writes no audit row', async () => {
      const org = await makeOrgUnit('Bogus Scope Root')
      const actor = await makeActiveUser('assigner', org.id)
      await grant(actor.id, 'super_admin', null) // global: assertCanAssignRole short-circuits
      const target = await makeActiveUser('target', org.id) // without touching org_units.
      currentUsername = actor.username

      const before = await totalAuditCount(ctx)

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/roles`)
        .send({ roleKey: 'read_only', scopeOrgUnitId: BOGUS_ID })
        .expect(404)
      expect(res.body.code).toBe('NOT_FOUND')
      expect(res.body.message).toContain('org unit')

      expect(await totalAuditCount(ctx)).toBe(before)
    })

    it('rejects a malformed body (missing roleKey) with 400 VALIDATION_FAILED', async () => {
      const org = await makeOrgUnit('Validation Root')
      const actor = await makeActiveUser('assigner', org.id)
      await grant(actor.id, 'super_admin', null)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/roles`)
        .send({ scopeOrgUnitId: org.id })
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
    })

    it('rejects an unrecognized roleKey with 400 VALIDATION_FAILED', async () => {
      const org = await makeOrgUnit('Bad Role Root')
      const actor = await makeActiveUser('assigner', org.id)
      await grant(actor.id, 'super_admin', null)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/roles`)
        .send({ roleKey: 'galactic_emperor' })
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
    })

    it('rejects a body with an unrecognized field with 400 VALIDATION_FAILED', async () => {
      const org = await makeOrgUnit('Strict Body Root')
      const actor = await makeActiveUser('assigner', org.id)
      await grant(actor.id, 'super_admin', null)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/roles`)
        .send({ roleKey: 'read_only', notAField: true })
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
    })
  })

  // =======================================================================
  // GET /users/:id/roles — Milestone 8, Task 4. Lets the admin console's
  // Roles tab show a target's CURRENT grants before offering to revoke any
  // of them. Gated identically to assign/revoke (RequirePermission +
  // assertCanIn against the target's own org unit — see the class doc
  // comment's "check 2") — a caller who could not grant/revoke a role for
  // this target cannot enumerate their grants either.
  // =======================================================================
  describe('GET /users/:id/roles', () => {
    it("lists the target's existing assignments", async () => {
      const org = await makeOrgUnit('List Root')
      const actor = await makeActiveUser('lister', org.id)
      await grant(actor.id, 'super_admin', null)
      const target = await makeActiveUser('target', org.id)
      await grant(target.id, 'help_desk', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer()).get(`/users/${target.id}/roles`).expect(200)
      expect(res.body).toHaveLength(1)
      expect(res.body[0]).toMatchObject({
        userId: target.id,
        roleKey: 'help_desk',
        scopeOrgUnitId: org.id,
      })
    })

    it('returns an empty array for a target with no role assignments', async () => {
      const org = await makeOrgUnit('List Empty Root')
      const actor = await makeActiveUser('lister', org.id)
      await grant(actor.id, 'super_admin', null)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer()).get(`/users/${target.id}/roles`).expect(200)
      expect(res.body).toEqual([])
    })

    it("never includes a DIFFERENT user's assignments", async () => {
      const org = await makeOrgUnit('List Isolation Root')
      const actor = await makeActiveUser('lister', org.id)
      await grant(actor.id, 'super_admin', null)
      const target = await makeActiveUser('target', org.id)
      const other = await makeActiveUser('other', org.id)
      await grant(other.id, 'auditor', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer()).get(`/users/${target.id}/roles`).expect(200)
      expect(res.body).toEqual([])
    })

    it('returns 404 NOT_FOUND for a nonexistent target user', async () => {
      const org = await makeOrgUnit('List Missing User Root')
      const actor = await makeActiveUser('lister', org.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .get(`/users/${BOGUS_ID}/roles`)
        .expect(404)
      expect(res.body.code).toBe('NOT_FOUND')
    })

    it('rejects an actor holding no role:assign grant at all, with 403, before any query runs', async () => {
      const org = await makeOrgUnit('List No Permission Root')
      const actor = await makeActiveUser('nobody', org.id) // no role assignment at all
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer()).get(`/users/${target.id}/roles`).expect(403)
      expect(res.body.code).toBe('FORBIDDEN')
    })

    it("rejects listing a target outside the actor's own scope, with 403 — even though the actor holds role:assign elsewhere (H-1 symmetry)", async () => {
      const acme = await makeOrgUnit('List Scope Acme')
      const sales = await makeChildOrgUnit(acme.id, 'Sales')
      const otherco = await makeOrgUnit('List Scope OtherCo') // a separate root, disjoint from acme entirely
      const actor = await makeActiveUser('scoped-lister', sales.id)
      await grant(actor.id, 'super_admin', sales.id)
      const target = await makeActiveUser('target', otherco.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer()).get(`/users/${target.id}/roles`).expect(403)
      expect(res.body.code).toBe('FORBIDDEN')
    })
  })

  // =======================================================================
  // DELETE /users/:id/roles/:assignmentId
  // =======================================================================
  describe('DELETE /users/:id/roles/:assignmentId', () => {
    it('revokes an assignment and writes exactly one additional audit row', async () => {
      const org = await makeOrgUnit('Revoke Root')
      const actor = await makeActiveUser('assigner', org.id)
      await grant(actor.id, 'super_admin', null)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      const created = await request(app.getHttpServer())
        .post(`/users/${target.id}/roles`)
        .send({ roleKey: 'help_desk', scopeOrgUnitId: org.id })
        .expect(201)
      const assignmentId = created.body.id as string
      expect(await auditRowsFor(ctx, assignmentId)).toHaveLength(1)

      const res = await request(app.getHttpServer())
        .delete(`/users/${target.id}/roles/${assignmentId}`)
        .expect(200)
      expect(res.body.id).toBe(assignmentId)
      expect(res.body.userId).toBe(target.id)
      expect(res.body.roleKey).toBe('help_desk')

      const rows = await auditRowsFor(ctx, assignmentId)
      expect(rows).toHaveLength(2)
      expect(rows[0].action).toBe('role:assign')
      expect(rows[1].action).toBe('role:revoke')
      expect(rows[1].before?.roleKey).toBe('help_desk')
      expect(rows[1].before?.userId).toBe(target.id)
      expect(rows[1].after).toBeNull()
    })

    // Revoking requires the SAME privilege as granting would have: an actor
    // who could not have created this exact GLOBAL grant (a scoped holder
    // can never grant globally — the headline escalation path) must not be
    // able to destroy it either, or revocation becomes a side door around
    // assign's own narrowing.
    it('rejects a scoped actor revoking a GLOBAL assignment they could not have granted, with 403 and no new audit row', async () => {
      const org = await makeOrgUnit('Revoke Privilege Root')
      const globalActor = await makeActiveUser('global-assigner', org.id)
      await grant(globalActor.id, 'super_admin', null)
      const scopedActor = await makeActiveUser('scoped-assigner', org.id)
      await grant(scopedActor.id, 'super_admin', org.id) // SCOPED
      const target = await makeActiveUser('target', org.id)
      currentUsername = globalActor.username

      const created = await request(app.getHttpServer())
        .post(`/users/${target.id}/roles`)
        .send({ roleKey: 'auditor' }) // GLOBAL grant
        .expect(201)
      const assignmentId = created.body.id as string
      expect(await auditRowsFor(ctx, assignmentId)).toHaveLength(1)

      currentUsername = scopedActor.username
      const res = await request(app.getHttpServer())
        .delete(`/users/${target.id}/roles/${assignmentId}`)
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      // Still exactly the one row from the original grant — nothing new.
      expect(await auditRowsFor(ctx, assignmentId)).toHaveLength(1)
    })

    it('returns 404 for a well-formed but nonexistent assignment id', async () => {
      const org = await makeOrgUnit('Missing Assignment Root')
      const actor = await makeActiveUser('assigner', org.id)
      await grant(actor.id, 'super_admin', null)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .delete(`/users/${target.id}/roles/${BOGUS_ID}`)
        .expect(404)
      expect(res.body.code).toBe('NOT_FOUND')
    })

    it('returns 404 when the assignment exists but belongs to a different user', async () => {
      const org = await makeOrgUnit('Mismatched Owner Root')
      const actor = await makeActiveUser('assigner', org.id)
      await grant(actor.id, 'super_admin', null)
      const targetA = await makeActiveUser('owner', org.id)
      const targetB = await makeActiveUser('stranger', org.id)
      currentUsername = actor.username

      const created = await request(app.getHttpServer())
        .post(`/users/${targetA.id}/roles`)
        .send({ roleKey: 'read_only' })
        .expect(201)
      const assignmentId = created.body.id as string

      const res = await request(app.getHttpServer())
        .delete(`/users/${targetB.id}/roles/${assignmentId}`)
        .expect(404)
      expect(res.body.code).toBe('NOT_FOUND')

      // The assignment itself is untouched — still exactly one row, no revoke.
      expect(await auditRowsFor(ctx, assignmentId)).toHaveLength(1)
    })
  })

  // =======================================================================
  // Redaction: audit payloads are built from named fields, not `{ ...row }`.
  // =======================================================================
  describe('audit payload construction', () => {
    it('never carries a credential-shaped key in before/after, even scanned as raw JSON', async () => {
      const org = await makeOrgUnit('Redaction Root')
      const actor = await makeActiveUser('assigner', org.id)
      await grant(actor.id, 'super_admin', null)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/roles`)
        .send({ roleKey: 'read_only', scopeOrgUnitId: org.id })
        .expect(201)

      const rows = await auditRowsFor(ctx, res.body.id)
      const serialized = JSON.stringify(rows[0].after).toLowerCase()
      for (const forbidden of ['password', 'passwd', 'secret', 'hash', 'salt', 'credential', 'token']) {
        expect(serialized).not.toContain(forbidden)
      }
    })
  })

  // =======================================================================
  // Finding H-1 (docs/superpowers/audit-authz.md) — THE FOURTH CHECK.
  //
  // Every test above targets a user WITHIN the acting super_admin's own
  // scope (or the actor is global) — proving assertCanAssignRole's SCOPE
  // narrowing and assertCanModifyPrincipal's RANK narrowing, but never
  // exercising "can this actor reach the TARGET PRINCIPAL at all," because
  // no fixture here ever put the target somewhere the actor could not see.
  // That blind spot is exactly why H-1 survived the original 554-test suite
  // (see scope-narrowing.spec.ts's own new role-assignment section for the
  // same property pinned at the cross-endpoint level). This block reproduces
  // the audit's live finding directly: a super_admin scoped to `acme.sales`
  // reaches into a disjoint `otherco` tree.
  // =======================================================================
  describe('H-1 fix: the target principal must be reachable, not just the scope of the grant', () => {
    async function makeDisjointOrgs(): Promise<{ salesId: string; othercoId: string }> {
      const acme = await makeOrgUnit('Acme')
      const sales = await makeChildOrgUnit(acme.id, 'Sales')
      const otherco = await makeOrgUnit('OtherCo') // a SEPARATE root — disjoint from acme entirely
      return { salesId: sales.id, othercoId: otherco.id }
    }

    it('rejects granting a role to a target outside the actor\'s scope, with 403 and writes no audit row or outbox event — even though the grant\'s OWN scope is one the actor legitimately holds', async () => {
      const { salesId, othercoId } = await makeDisjointOrgs()
      const admin = await makeActiveUser('sales-admin', salesId)
      await grant(admin.id, 'super_admin', salesId) // SCOPED to acme.sales
      const victim = await makeActiveUser('victim', othercoId) // lives in the disjoint tree
      currentUsername = admin.username

      const auditBefore = await totalAuditCount(ctx)
      const outboxBefore = await totalOutboxCount(ctx)

      // The grant's own scope (salesId) is well within what assertCanAssignRole
      // would happily authorize for this actor — isolating this test to the
      // MISSING check (H-1), not the scope-of-the-grant check that already
      // existed and already worked.
      const res = await request(app.getHttpServer())
        .post(`/users/${victim.id}/roles`)
        .send({ roleKey: 'super_admin', scopeOrgUnitId: salesId })
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await totalAuditCount(ctx)).toBe(auditBefore)
      expect(await totalOutboxCount(ctx)).toBe(outboxBefore)

      // Confirmed not merely rejected but genuinely never persisted: the
      // victim holds no role_assignments row at all.
      expect(await rolesRepo().listForUser(victim.id)).toEqual([])
    })

    it('rejects revoking a role from a target outside the actor\'s scope, with 403 and writes no NEW audit row or outbox event', async () => {
      const { salesId, othercoId } = await makeDisjointOrgs()
      const globalAdmin = await makeActiveUser('global-admin', salesId)
      await grant(globalAdmin.id, 'super_admin', null) // GLOBAL — legitimately grants into otherco
      const salesAdmin = await makeActiveUser('sales-admin', salesId)
      await grant(salesAdmin.id, 'super_admin', salesId) // SCOPED to acme.sales
      const victim = await makeActiveUser('victim', othercoId)
      currentUsername = globalAdmin.username

      // A legitimate grant, made by the GLOBAL admin: the VICTIM lives in
      // otherco, but the grant's own SCOPE is salesId — deliberately, to
      // isolate this test to the missing check. scopeOrgUnitId has no
      // required relationship to the target's own org unit (see
      // RoleAssignmentsRepository.assign — they are independent fields);
      // this is the exact shape the live audit reproduced (a grant whose
      // SCOPE the actor legitimately reaches, on a TARGET they do not).
      // Using othercoId as the scope here instead would make
      // assertCanAssignRole reject the revoke below for an unrelated
      // reason (the SCOPE, not the target), which would prove nothing about
      // H-1 specifically.
      const created = await request(app.getHttpServer())
        .post(`/users/${victim.id}/roles`)
        .send({ roleKey: 'read_only', scopeOrgUnitId: salesId })
        .expect(201)
      const assignmentId = created.body.id as string
      expect(await auditRowsFor(ctx, assignmentId)).toHaveLength(1)

      const auditBefore = await totalAuditCount(ctx)
      const outboxBefore = await totalOutboxCount(ctx)

      // The Sales-scoped admin CAN reach this grant's scope (salesId, their
      // own) and does not get outranked by a read_only target — so
      // assertCanAssignRole and assertCanModifyPrincipal both pass. Only
      // the NEW check (can this actor reach the TARGET user, who lives in
      // the disjoint otherco tree) rejects this.
      currentUsername = salesAdmin.username
      const res = await request(app.getHttpServer())
        .delete(`/users/${victim.id}/roles/${assignmentId}`)
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await totalAuditCount(ctx)).toBe(auditBefore)
      expect(await totalOutboxCount(ctx)).toBe(outboxBefore)

      // Still exactly the one row from the original grant — the revoke
      // attempt left no trace.
      expect(await auditRowsFor(ctx, assignmentId)).toHaveLength(1)
    })

    // Positive control: the fix narrows WHO can be targeted, not the
    // legitimate operation itself. The same Sales-scoped admin can still
    // grant/revoke roles on a colleague who actually lives in their scope.
    it('an in-scope role assignment still succeeds end to end (grant, then revoke)', async () => {
      const { salesId } = await makeDisjointOrgs()
      const admin = await makeActiveUser('sales-admin', salesId)
      await grant(admin.id, 'super_admin', salesId)
      const colleague = await makeActiveUser('colleague', salesId) // SAME org as the actor's scope
      currentUsername = admin.username

      const res = await request(app.getHttpServer())
        .post(`/users/${colleague.id}/roles`)
        .send({ roleKey: 'help_desk', scopeOrgUnitId: salesId })
        .expect(201)
      expect(await auditRowsFor(ctx, res.body.id)).toHaveLength(1)

      await request(app.getHttpServer())
        .delete(`/users/${colleague.id}/roles/${res.body.id}`)
        .expect(200)
      expect(await auditRowsFor(ctx, res.body.id)).toHaveLength(2)
    })

    // The grantee follow-on from the live reproduction (audit-authz.md):
    // pre-fix, the newly (and wrongly) granted out-of-scope principal could
    // immediately use their new privilege. Since the grant itself is now
    // rejected, there is nothing left for the grantee to exploit — pinned
    // here directly, rather than asserted only implicitly.
    it('the would-be grantee never gains the privilege the rejected grant would have conferred', async () => {
      const { salesId, othercoId } = await makeDisjointOrgs()
      const admin = await makeActiveUser('sales-admin', salesId)
      await grant(admin.id, 'super_admin', salesId)
      const victim = await makeActiveUser('victim', othercoId)
      currentUsername = admin.username

      await request(app.getHttpServer())
        .post(`/users/${victim.id}/roles`)
        .send({ roleKey: 'super_admin', scopeOrgUnitId: salesId })
        .expect(403)

      // The victim holds no assignment at all, so PermissionEngine would
      // deny them everything — confirmed directly against the repository
      // rather than by a second HTTP call this controller has no route for.
      expect(await rolesRepo().listForUser(victim.id)).toEqual([])
    })
  })
})
