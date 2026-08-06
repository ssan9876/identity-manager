import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
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
import * as schema from '../src/db/schema/index'
import { GroupsController } from '../src/groups/groups.controller'
import { GroupsRepository } from '../src/groups/groups.repository'
import { KEYCLOAK_ADMIN_CONFIG, KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { OrgUnitsController } from '../src/org-units/org-units.controller'
import { OrgUnitsRepository, type OrgUnit } from '../src/org-units/org-units.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { SyncStateRepository } from '../src/outbox/sync-state.repository'
import { UsersController } from '../src/users/users.controller'
import { UsersRepository, type User } from '../src/users/users.repository'
import { type TestDatabase, withTestDatabase } from './support/pg'

// Milestone 4, Task 4 — see the identical comment in users.write.spec.ts:
// UsersController.deactivate now attempts a synchronous Keycloak call this
// file's tests don't otherwise need, so it is pointed at an unreachable
// local port (fails fast, logged and swallowed).
const UNREACHABLE_KEYCLOAK_CONFIG = {
  issuer: 'http://127.0.0.1:1/realms/unreachable',
  clientId: 'irrelevant',
  clientSecret: 'irrelevant',
}

/**
 * Stamps `request.principal` from whatever `getUsername()` returns AT
 * REQUEST TIME — same technique as users.write.spec.ts / groups.write.spec.ts.
 */
function stubJwtGuard(getUsername: () => string): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
        subject: 'kc-outbox-test',
        username: getUsername(),
        email: null,
      }
      return true
    },
  }
}

interface OutboxEventRow {
  id: string
  aggregate_type: string
  aggregate_id: string
  event_type: string
  payload: Record<string, unknown>
  target: string
  status: string
  attempts: number
  next_attempt_at: string
  last_error: string | null
  created_at: string
}

/**
 * Scoped to a specific (aggregateType, aggregateId), never "the newest row"
 * or a table count — same reasoning as every write-spec file's
 * `auditRowsFor` this milestone: this file writes audit rows too (every
 * controller call below still calls AuditWriter.record alongside
 * OutboxWriter.record, in the SAME transaction), and audit_log's actor/
 * resource FKs are `restrict` (see db/schema/audit-log.ts), so this file
 * never deletes users or org units between tests either — every fixture is
 * uniquely tagged (see `nextTag()`) and every assertion below is scoped.
 */
async function outboxEventsFor(
  ctx: TestDatabase,
  aggregateType: string,
  aggregateId: string,
): Promise<OutboxEventRow[]> {
  const { rows } = await ctx.pool.query<OutboxEventRow>(
    'SELECT * FROM outbox_events WHERE aggregate_type = $1 AND aggregate_id = $2 ORDER BY id ASC',
    [aggregateType, aggregateId],
  )
  return rows
}

async function totalOutboxCount(ctx: TestDatabase): Promise<number> {
  const { rows } = await ctx.pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM outbox_events',
  )
  return rows[0]?.count ?? 0
}

const BOGUS_ID = '00000000-0000-0000-0000-000000000000'

/**
 * MILESTONE 4, TASK 1: outbox event emission from every existing write
 * endpoint. One shared Nest app hosts all four write controllers together
 * (mirroring AppModule's own provider graph, minus JWT verification, which
 * is stubbed exactly like every Milestone 3b write-spec file), so every one
 * of the twelve write routes can be exercised against the same database and
 * the same set of outbox-reading helpers.
 *
 * The two properties this file exists to prove, mirrored directly off the
 * audit-row tests already covering the same endpoints (users.write.spec.ts,
 * groups.write.spec.ts, org-units.write.spec.ts, role-assignments.write.spec.ts):
 *   1. Every successful mutation writes EXACTLY ONE outbox event, with the
 *      right aggregateType/aggregateId/eventType.
 *   2. A rejected mutation (403, validation failure, cycle) writes ZERO
 *      outbox events — same assertion shape (before/after count, scoped
 *      lookup by resource id) already used for audit rows.
 * A dedicated rejection test is not repeated for every single one of the
 * many rejection paths those files already cover exhaustively for the audit
 * side — this file picks one representative case per resource area (a 403,
 * a validation failure, and the cycle-detection case named explicitly in
 * the milestone plan) since the AUDIT-row and OUTBOX-event writes share the
 * exact same transaction and therefore the exact same rollback behaviour.
 */
describe('outbox event emission (Milestone 4, Task 1)', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let currentUsername = ''

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController, GroupsController, OrgUnitsController, RoleAssignmentsController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        UsersRepository,
        GroupsRepository,
        OrgUnitsRepository,
        RoleAssignmentsRepository,
        PermissionEngine,
        PermissionGuard,
        PrivilegeGuards,
        AuditWriter,
        OutboxWriter,
        Reflector,
        // Milestone 4, Task 4 — see UNREACHABLE_KEYCLOAK_CONFIG's comment above.
        { provide: KEYCLOAK_ADMIN_CONFIG, useValue: UNREACHABLE_KEYCLOAK_CONFIG },
        KeycloakAdminClient,
        SyncStateRepository,
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

  // ---------------------------------------------------------------------
  // Fixture helpers — same shape as every Milestone 3b write-spec file.
  // ---------------------------------------------------------------------
  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `obx${fixtureSeq}`
  }

  const orgUnitsRepo = () => new OrgUnitsRepository(ctx.db)
  const usersRepo = () => new UsersRepository(ctx.db)
  const rolesRepo = () => new RoleAssignmentsRepository(ctx.db)
  const groupsRepo = () => new GroupsRepository(ctx.db)

  async function makeOrgUnit(label: string): Promise<OrgUnit> {
    return orgUnitsRepo().createRoot(`${label} ${nextTag()}`)
  }

  async function makeChildOrgUnit(parentId: string, label: string): Promise<OrgUnit> {
    return orgUnitsRepo().createChild(parentId, `${label} ${nextTag()}`)
  }

  async function makeActiveUser(role: string, orgUnitId: string): Promise<User> {
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
  // POST /users -> user/created
  // =======================================================================
  describe('POST /users', () => {
    it('emits exactly one user/created outbox event, targeting keycloak and pending', async () => {
      const org = await makeOrgUnit('Create Root')
      const actor = await makeActiveUser('creator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const tag = nextTag()
      const res = await request(app.getHttpServer())
        .post('/users')
        .send({
          primaryEmail: `newhire-${tag}@example.com`,
          username: `newhire-${tag}`,
          firstName: 'New',
          lastName: 'Hire',
          orgUnitId: org.id,
        })
        .expect(201)

      const events = await outboxEventsFor(ctx, 'user', res.body.id)
      expect(events).toHaveLength(1)
      expect(events[0].event_type).toBe('created')
      expect(events[0].target).toBe('keycloak')
      expect(events[0].status).toBe('pending')
      expect(events[0].attempts).toBe(0)
      expect(events[0].payload.action).toBe('user:create')
      expect(events[0].payload.username).toBe(`newhire-${tag}`)
    })

    it('rejects a create targeting an out-of-scope org unit with 403 and emits no outbox event', async () => {
      const root = await makeOrgUnit('Scope Root')
      const scopeOrg = await makeChildOrgUnit(root.id, 'In Scope')
      const otherOrg = await makeChildOrgUnit(root.id, 'Out Of Scope')
      const actor = await makeActiveUser('scoped-creator', scopeOrg.id)
      await grant(actor.id, 'user_admin', scopeOrg.id)
      currentUsername = actor.username

      const before = await totalOutboxCount(ctx)
      const tag = nextTag()

      const res = await request(app.getHttpServer())
        .post('/users')
        .send({
          primaryEmail: `blocked-${tag}@example.com`,
          username: `blocked-${tag}`,
          firstName: 'No',
          lastName: 'Access',
          orgUnitId: otherOrg.id,
        })
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await totalOutboxCount(ctx)).toBe(before)
    })

    it('rejects a malformed body with 400 VALIDATION_FAILED and emits no outbox event', async () => {
      const org = await makeOrgUnit('Validation Root')
      const actor = await makeActiveUser('creator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const before = await totalOutboxCount(ctx)

      const res = await request(app.getHttpServer())
        .post('/users')
        .send({ username: `incomplete-${nextTag()}` }) // missing required fields
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')

      expect(await totalOutboxCount(ctx)).toBe(before)
    })
  })

  // =======================================================================
  // PATCH /users/:id -> user/updated
  // =======================================================================
  describe('PATCH /users/:id', () => {
    it('emits exactly one user/updated outbox event', async () => {
      const org = await makeOrgUnit('Update Root')
      const actor = await makeActiveUser('updater', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      await request(app.getHttpServer())
        .patch(`/users/${target.id}`)
        .send({ jobTitle: 'Staff Engineer' })
        .expect(200)

      const events = await outboxEventsFor(ctx, 'user', target.id)
      expect(events).toHaveLength(1)
      expect(events[0].event_type).toBe('updated')
      expect(events[0].payload.action).toBe('user:update')
      expect(events[0].payload.jobTitle).toBe('Staff Engineer')
    })

    it('rejects updating an out-of-scope user with 403 and emits no outbox event', async () => {
      const root = await makeOrgUnit('Update Scope Root')
      const scopeOrg = await makeChildOrgUnit(root.id, 'In Scope')
      const otherOrg = await makeChildOrgUnit(root.id, 'Out Of Scope')
      const actor = await makeActiveUser('scoped-updater', scopeOrg.id)
      await grant(actor.id, 'help_desk', scopeOrg.id) // holds user:update
      const target = await makeActiveUser('target', otherOrg.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .patch(`/users/${target.id}`)
        .send({ jobTitle: 'Should Not Land' })
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await outboxEventsFor(ctx, 'user', target.id)).toHaveLength(0)
    })
  })

  // =======================================================================
  // POST /users/:id/deactivate -> user/status_changed (no 'deleted' type)
  // =======================================================================
  describe('POST /users/:id/deactivate', () => {
    it('emits exactly one user/status_changed outbox event carrying deactivated', async () => {
      const org = await makeOrgUnit('Deactivate Root')
      const actor = await makeActiveUser('deactivator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      await request(app.getHttpServer()).post(`/users/${target.id}/deactivate`).expect(200)

      const events = await outboxEventsFor(ctx, 'user', target.id)
      expect(events).toHaveLength(1)
      expect(events[0].event_type).toBe('status_changed')
      expect(events[0].payload.action).toBe('user:deactivate')
      expect(events[0].payload.status).toBe('deactivated')
    })

    it('deactivating twice returns 409 on the second attempt and emits no second outbox event', async () => {
      const org = await makeOrgUnit('Double Deactivate Root')
      const actor = await makeActiveUser('deactivator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      await request(app.getHttpServer()).post(`/users/${target.id}/deactivate`).expect(200)
      expect(await outboxEventsFor(ctx, 'user', target.id)).toHaveLength(1)

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/deactivate`)
        .expect(409)
      expect(res.body.code).toBe('INVALID_TRANSITION')

      expect(await outboxEventsFor(ctx, 'user', target.id)).toHaveLength(1)
    })
  })

  // =======================================================================
  // POST /groups -> group/created
  // =======================================================================
  describe('POST /groups', () => {
    it('emits exactly one group/created outbox event', async () => {
      const org = await makeOrgUnit('Group Create Root')
      const actor = await makeActiveUser('creator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const tag = nextTag()
      const res = await request(app.getHttpServer())
        .post('/groups')
        .send({ name: `Engineering ${tag}`, orgUnitId: org.id })
        .expect(201)

      const events = await outboxEventsFor(ctx, 'group', res.body.id)
      expect(events).toHaveLength(1)
      expect(events[0].event_type).toBe('created')
      expect(events[0].payload.action).toBe('group:create')
      expect(events[0].payload.name).toBe(`Engineering ${tag}`)
    })

    it('rejects a create targeting an out-of-scope org unit with 403 and emits no outbox event', async () => {
      const root = await makeOrgUnit('Group Scope Root')
      const scopeOrg = await makeChildOrgUnit(root.id, 'In Scope')
      const otherOrg = await makeChildOrgUnit(root.id, 'Out Of Scope')
      const actor = await makeActiveUser('scoped-creator', scopeOrg.id)
      await grant(actor.id, 'user_admin', scopeOrg.id)
      currentUsername = actor.username

      const before = await totalOutboxCount(ctx)

      const res = await request(app.getHttpServer())
        .post('/groups')
        .send({ name: `Blocked ${nextTag()}`, orgUnitId: otherOrg.id })
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await totalOutboxCount(ctx)).toBe(before)
    })

    // Finding M-2 (docs/superpowers/audit-authz.md) — representative case,
    // same reasoning as this file's header comment: audit-row and
    // outbox-event writes share the exact same transaction, so ONE
    // rejection test per NEW denial mechanism is enough to prove both halves
    // roll back together (groups.write.spec.ts's own M-2 tests already cover
    // the audit-row side of this and its sibling mechanisms — update,
    // manage_members — exhaustively).
    it('rejects creating a GLOBAL group as a SCOPED actor with 403 and emits no outbox event', async () => {
      const org = await makeOrgUnit('Global Group Scope Root')
      const actor = await makeActiveUser('scoped-creator', org.id)
      await grant(actor.id, 'user_admin', org.id) // SCOPED, not global
      currentUsername = actor.username

      const before = await totalOutboxCount(ctx)

      const res = await request(app.getHttpServer())
        .post('/groups')
        .send({ name: `Blocked Global ${nextTag()}` }) // orgUnitId omitted -> global
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await totalOutboxCount(ctx)).toBe(before)
    })
  })

  // =======================================================================
  // PATCH /groups/:id -> group/updated
  // =======================================================================
  describe('PATCH /groups/:id', () => {
    it('emits exactly one group/updated outbox event', async () => {
      const org = await makeOrgUnit('Group Update Root')
      const actor = await makeActiveUser('updater', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const group = await groupsRepo().create({ name: `Target ${nextTag()}`, orgUnitId: org.id })
      currentUsername = actor.username

      await request(app.getHttpServer())
        .patch(`/groups/${group.id}`)
        .send({ description: 'Updated description' })
        .expect(200)

      const events = await outboxEventsFor(ctx, 'group', group.id)
      expect(events).toHaveLength(1)
      expect(events[0].event_type).toBe('updated')
      expect(events[0].payload.action).toBe('group:update')
      expect(events[0].payload.description).toBe('Updated description')
    })
  })

  // =======================================================================
  // POST|DELETE /groups/:id/members, POST|DELETE /groups/:id/child-groups
  // -> membership/membership_changed, anchored on the PARENT group's id —
  // never the member's or the child group's — mirroring GroupsController's
  // own audit-row anchor (see its doc comment above addMember).
  // =======================================================================
  describe('group membership', () => {
    it('POST /groups/:id/members emits exactly one membership/membership_changed outbox event', async () => {
      const org = await makeOrgUnit('Member Root')
      const actor = await makeActiveUser('manager', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const group = await groupsRepo().create({ name: `Team ${nextTag()}`, orgUnitId: org.id })
      const target = await makeActiveUser('member', org.id)
      currentUsername = actor.username

      await request(app.getHttpServer())
        .post(`/groups/${group.id}/members`)
        .send({ userId: target.id })
        .expect(201)

      const events = await outboxEventsFor(ctx, 'membership', group.id)
      expect(events).toHaveLength(1)
      expect(events[0].event_type).toBe('membership_changed')
      expect(events[0].payload.action).toBe('group:add_member')
      expect(events[0].payload.userId).toBe(target.id)

      // NOT anchored on the group as a 'group' aggregate — the member add
      // is a different event stream from the group's own attributes.
      expect(await outboxEventsFor(ctx, 'group', group.id)).toHaveLength(0)
    })

    it('DELETE /groups/:id/members/:userId adds a second membership_changed event, ending with add-then-remove', async () => {
      const org = await makeOrgUnit('Remove Member Root')
      const actor = await makeActiveUser('manager', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const group = await groupsRepo().create({ name: `Team ${nextTag()}`, orgUnitId: org.id })
      const target = await makeActiveUser('member', org.id)
      currentUsername = actor.username

      await request(app.getHttpServer())
        .post(`/groups/${group.id}/members`)
        .send({ userId: target.id })
        .expect(201)

      await request(app.getHttpServer())
        .delete(`/groups/${group.id}/members/${target.id}`)
        .expect(200)

      const events = await outboxEventsFor(ctx, 'membership', group.id)
      expect(events).toHaveLength(2)
      expect(events[0].payload.action).toBe('group:add_member')
      expect(events[1].payload.action).toBe('group:remove_member')
      expect(events[1].event_type).toBe('membership_changed')
    })

    it('rejects adding a member to an out-of-scope group with 403 and emits no outbox event', async () => {
      const root = await makeOrgUnit('Member Scope Root')
      const scopeOrg = await makeChildOrgUnit(root.id, 'In Scope')
      const otherOrg = await makeChildOrgUnit(root.id, 'Out Of Scope')
      const actor = await makeActiveUser('scoped-manager', scopeOrg.id)
      await grant(actor.id, 'user_admin', scopeOrg.id)
      const group = await groupsRepo().create({ name: `Team ${nextTag()}`, orgUnitId: otherOrg.id })
      const target = await makeActiveUser('member', otherOrg.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/groups/${group.id}/members`)
        .send({ userId: target.id })
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await outboxEventsFor(ctx, 'membership', group.id)).toHaveLength(0)
    })

    // Finding M-2 (docs/superpowers/audit-authz.md) — representative case
    // for the MEMBER-side check specifically (the test above covers the
    // pre-existing GROUP-side check); groups.write.spec.ts's own test
    // already proves the audit-row side of this exact scenario.
    it('rejects adding an out-of-scope MEMBER to an in-scope group with 403 and emits no outbox event', async () => {
      const org = await makeOrgUnit('Member Group Root')
      const otherOrg = await makeOrgUnit('Member User Root')
      const actor = await makeActiveUser('manager', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const group = await groupsRepo().create({ name: `Team ${nextTag()}`, orgUnitId: org.id })
      const outsider = await makeActiveUser('outsider', otherOrg.id)
      currentUsername = actor.username

      const before = await totalOutboxCount(ctx)

      const res = await request(app.getHttpServer())
        .post(`/groups/${group.id}/members`)
        .send({ userId: outsider.id })
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await outboxEventsFor(ctx, 'membership', group.id)).toHaveLength(0)
      expect(await totalOutboxCount(ctx)).toBe(before)
    })

    it('POST /groups/:id/child-groups emits exactly one membership/membership_changed outbox event', async () => {
      const org = await makeOrgUnit('Nest Root')
      const actor = await makeActiveUser('manager', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const parent = await groupsRepo().create({ name: `Parent ${nextTag()}`, orgUnitId: org.id })
      const child = await groupsRepo().create({ name: `Child ${nextTag()}`, orgUnitId: org.id })
      currentUsername = actor.username

      await request(app.getHttpServer())
        .post(`/groups/${parent.id}/child-groups`)
        .send({ childId: child.id })
        .expect(201)

      const events = await outboxEventsFor(ctx, 'membership', parent.id)
      expect(events).toHaveLength(1)
      expect(events[0].event_type).toBe('membership_changed')
      expect(events[0].payload.action).toBe('group:add_child_group')
      expect(events[0].payload.childGroupId).toBe(child.id)
    })

    it('DELETE /groups/:id/child-groups/:childId adds a second membership_changed event', async () => {
      const org = await makeOrgUnit('Unnest Root')
      const actor = await makeActiveUser('manager', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const parent = await groupsRepo().create({ name: `Parent ${nextTag()}`, orgUnitId: org.id })
      const child = await groupsRepo().create({ name: `Child ${nextTag()}`, orgUnitId: org.id })
      currentUsername = actor.username

      await request(app.getHttpServer())
        .post(`/groups/${parent.id}/child-groups`)
        .send({ childId: child.id })
        .expect(201)

      await request(app.getHttpServer())
        .delete(`/groups/${parent.id}/child-groups/${child.id}`)
        .expect(200)

      const events = await outboxEventsFor(ctx, 'membership', parent.id)
      expect(events).toHaveLength(2)
      expect(events[1].payload.action).toBe('group:remove_child_group')
      expect(events[1].event_type).toBe('membership_changed')
    })

    // THE scenario the milestone plan calls out by name: "a rejected
    // mutation (403, validation failure, cycle) writes zero events" — same
    // shape as groups.write.spec.ts's own cycle test, applied to outbox
    // events instead of audit rows.
    it('a cycle attempt over HTTP returns 409 CYCLE_DETECTED and emits no outbox event', async () => {
      const org = await makeOrgUnit('Cycle Root')
      const actor = await makeActiveUser('manager', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const a = await groupsRepo().create({ name: `A ${nextTag()}`, orgUnitId: org.id })
      const b = await groupsRepo().create({ name: `B ${nextTag()}`, orgUnitId: org.id })
      currentUsername = actor.username

      // A -> B, a genuine successful nest, emitting one event against A.
      await request(app.getHttpServer())
        .post(`/groups/${a.id}/child-groups`)
        .send({ childId: b.id })
        .expect(201)
      expect(await outboxEventsFor(ctx, 'membership', a.id)).toHaveLength(1)

      const before = await totalOutboxCount(ctx)

      // B -> A would close the loop: A is already reachable downward from B.
      const res = await request(app.getHttpServer())
        .post(`/groups/${b.id}/child-groups`)
        .send({ childId: a.id })
        .expect(409)
      expect(res.body.code).toBe('CYCLE_DETECTED')

      expect(await outboxEventsFor(ctx, 'membership', b.id)).toHaveLength(0)
      expect(await totalOutboxCount(ctx)).toBe(before)
    })

    // Finding M-1 (docs/superpowers/audit-authz.md) — representative case,
    // same reasoning as the M-2 test in the POST /groups block above:
    // groups.write.spec.ts's own M-1 test already proves the audit-row side
    // (and the read-amplification never opening up); this proves the
    // SAME rejected request also emits no outbox event.
    it('rejects nesting a foreign, out-of-scope group as a CHILD with 403 and emits no outbox event', async () => {
      const root = await makeOrgUnit('Child Scope Root')
      const scopeOrg = await makeChildOrgUnit(root.id, 'In Scope')
      const otherOrg = await makeChildOrgUnit(root.id, 'Out Of Scope')
      const actor = await makeActiveUser('scoped-manager', scopeOrg.id)
      await grant(actor.id, 'user_admin', scopeOrg.id)
      const parent = await groupsRepo().create({ name: `Sales Team ${nextTag()}`, orgUnitId: scopeOrg.id })
      const foreignChild = await groupsRepo().create({
        name: `OtherCo Secret ${nextTag()}`,
        orgUnitId: otherOrg.id,
      })
      currentUsername = actor.username

      const before = await totalOutboxCount(ctx)

      const res = await request(app.getHttpServer())
        .post(`/groups/${parent.id}/child-groups`)
        .send({ childId: foreignChild.id })
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await outboxEventsFor(ctx, 'membership', parent.id)).toHaveLength(0)
      expect(await totalOutboxCount(ctx)).toBe(before)
    })
  })

  // =======================================================================
  // POST /org-units -> org_unit/created
  // =======================================================================
  describe('POST /org-units', () => {
    it('emits exactly one org_unit/created outbox event', async () => {
      const bootstrap = await makeOrgUnit('Bootstrap')
      const actor = await makeActiveUser('global-creator', bootstrap.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      const tag = nextTag()
      const res = await request(app.getHttpServer())
        .post('/org-units')
        .send({ name: `Root ${tag}` })
        .expect(201)

      const events = await outboxEventsFor(ctx, 'org_unit', res.body.id)
      expect(events).toHaveLength(1)
      expect(events[0].event_type).toBe('created')
      expect(events[0].payload.action).toBe('org_unit:create')
      expect(events[0].payload.name).toBe(`Root ${tag}`)
    })

    it('rejects creating a ROOT for a SCOPED actor with 403 and emits no outbox event', async () => {
      const root = await makeOrgUnit('No Root For Scoped')
      const actor = await makeActiveUser('scoped-creator', root.id)
      await grant(actor.id, 'super_admin', root.id) // SCOPED — no parent to scope against
      currentUsername = actor.username

      const before = await totalOutboxCount(ctx)

      const res = await request(app.getHttpServer())
        .post('/org-units')
        .send({ name: `Should Not Exist ${nextTag()}` })
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await totalOutboxCount(ctx)).toBe(before)
    })
  })

  // =======================================================================
  // POST /users/:id/roles, DELETE /users/:id/roles/:assignmentId ->
  // user/updated — NOT a bespoke 'role_assignment' aggregate (no such value
  // exists), and anchored on the TARGET USER's id, not the assignment's own
  // id (contrast the audit row for the same call, which anchors on the
  // assignment's id — see RoleAssignmentsController's file-level doc
  // comment).
  // =======================================================================
  describe('role assignment', () => {
    it('POST /users/:id/roles emits exactly one user/updated outbox event, anchored on the target user', async () => {
      const org = await makeOrgUnit('Role Assign Root')
      const admin = await makeActiveUser('admin', org.id)
      await grant(admin.id, 'super_admin', null)
      const target = await makeActiveUser('target', org.id)
      currentUsername = admin.username

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/roles`)
        .send({ roleKey: 'help_desk', scopeOrgUnitId: org.id })
        .expect(201)

      const events = await outboxEventsFor(ctx, 'user', target.id)
      expect(events).toHaveLength(1)
      expect(events[0].event_type).toBe('updated')
      expect(events[0].payload.action).toBe('role:assign')
      expect(events[0].payload.roleKey).toBe('help_desk')

      // Confirm it is NOT anchored on the assignment's own id — that is the
      // audit row's anchor, not the outbox event's.
      expect(await outboxEventsFor(ctx, 'user', res.body.id)).toHaveLength(0)
    })

    it('DELETE /users/:id/roles/:assignmentId adds a second user/updated outbox event', async () => {
      const org = await makeOrgUnit('Role Revoke Root')
      const admin = await makeActiveUser('admin', org.id)
      await grant(admin.id, 'super_admin', null)
      const target = await makeActiveUser('target', org.id)
      currentUsername = admin.username

      const assignRes = await request(app.getHttpServer())
        .post(`/users/${target.id}/roles`)
        .send({ roleKey: 'help_desk', scopeOrgUnitId: org.id })
        .expect(201)
      expect(await outboxEventsFor(ctx, 'user', target.id)).toHaveLength(1)

      await request(app.getHttpServer())
        .delete(`/users/${target.id}/roles/${assignRes.body.id}`)
        .expect(200)

      const events = await outboxEventsFor(ctx, 'user', target.id)
      expect(events).toHaveLength(2)
      expect(events[1].event_type).toBe('updated')
      expect(events[1].payload.action).toBe('role:revoke')
      expect(events[1].payload.roleKey).toBe('help_desk')
    })

    // Reachable rejection per PrivilegeGuards.assertCanAssignRole: "only a
    // global holding may create a global grant" — a SCOPED super_admin
    // still passes PermissionGuard's entry check (role:assign, held
    // globally-in-identity-if-not-in-scope is not required to REACH the
    // route — see privilege.guards.ts) but is refused the escalation.
    it('a scoped actor granting a GLOBAL role is rejected with 403 and emits no outbox event', async () => {
      const org = await makeOrgUnit('Scoped Grant Root')
      const scopedAdmin = await makeActiveUser('scoped-admin', org.id)
      await grant(scopedAdmin.id, 'super_admin', org.id) // SCOPED, not global
      const target = await makeActiveUser('target', org.id)
      currentUsername = scopedAdmin.username

      const before = await totalOutboxCount(ctx)

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/roles`)
        .send({ roleKey: 'help_desk' }) // scope omitted -> GLOBAL
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await totalOutboxCount(ctx)).toBe(before)
    })
  })

  // =======================================================================
  // OutboxWriter itself — mirrors audit.spec.ts's direct-writer tests.
  // =======================================================================
  describe('OutboxWriter', () => {
    it('records an event with target/status/attempts/nextAttemptAt defaulted, never caller-supplied', async () => {
      const writer = new OutboxWriter()
      const org = await makeOrgUnit('Writer Root')
      const user = await makeActiveUser('writer-subject', org.id)

      await ctx.db.transaction(async (tx) => {
        await writer.record(tx, {
          aggregateType: 'user',
          aggregateId: user.id,
          eventType: 'created',
          payload: { username: user.username },
        })
      })

      const events = await outboxEventsFor(ctx, 'user', user.id)
      expect(events).toHaveLength(1)
      expect(events[0].target).toBe('keycloak')
      expect(events[0].status).toBe('pending')
      expect(events[0].attempts).toBe(0)
      expect(events[0].last_error).toBeNull()
      expect(events[0].next_attempt_at).not.toBeNull()
      expect(events[0].payload).toEqual({ username: user.username })
    })

    // Property #1 from the brief: "the event, the audit row, and the
    // mutation commit together or not at all." Proven directly here rather
    // than only inferred from the HTTP-level rejection tests above: both
    // writers are called inside the SAME transaction, which then throws —
    // both rows must vanish together, not just the audit one.
    it('rolls back together with the audit row written alongside it, when the enclosing transaction fails', async () => {
      const outboxWriter = new OutboxWriter()
      const auditWriter = new AuditWriter()
      const org = await makeOrgUnit('Rollback Root')
      const user = await makeActiveUser('rollback-subject', org.id)

      const outboxBaseline = await totalOutboxCount(ctx)
      const { rows: auditBaselineRows } = await ctx.pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM audit_log',
      )
      const auditBaseline = auditBaselineRows[0]?.count ?? 0

      await expect(
        ctx.db.transaction(async (tx) => {
          await auditWriter.record(tx, {
            actorUserId: null,
            action: 'user:update',
            resourceType: 'user',
            resourceId: user.id,
            before: null,
            after: { jobTitle: 'Should Not Land' },
          })
          await outboxWriter.record(tx, {
            aggregateType: 'user',
            aggregateId: user.id,
            eventType: 'updated',
            payload: { jobTitle: 'Should Not Land' },
          })
          throw new Error('mutation failed after both writes')
        }),
      ).rejects.toThrow('mutation failed')

      expect(await totalOutboxCount(ctx)).toBe(outboxBaseline)
      const { rows: auditAfterRows } = await ctx.pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM audit_log',
      )
      expect(auditAfterRows[0]?.count ?? 0).toBe(auditBaseline)
    })

    it('keeps the event when its enclosing transaction commits', async () => {
      const writer = new OutboxWriter()
      const org = await makeOrgUnit('Commit Root')
      const user = await makeActiveUser('commit-subject', org.id)

      await ctx.db.transaction(async (tx) => {
        await writer.record(tx, {
          aggregateType: 'user',
          aggregateId: user.id,
          eventType: 'updated',
          payload: { jobTitle: 'Landed' },
        })
      })

      expect(await outboxEventsFor(ctx, 'user', user.id)).toHaveLength(1)
    })
  })
})

// ---------------------------------------------------------------------------
// Type-only regression pin: `OutboxWriter.record` must reject the POOLED
// handle at compile time. The function below is never called anywhere — it
// exists purely to be type-checked by `tsc` (the build step, which includes
// test/**/* per tsconfig.json). vitest's SWC transform strips types and
// transpiles the file without type-checking it, so this property is proven
// by `pnpm build`, not by `pnpm test` — see outbox.writer.ts's `DbHandle`
// doc comment for the underlying mechanism (Drizzle's `PgTransaction`
// structurally extends the pooled `NodePgDatabase`, never the reverse, so
// only a real `tx` from `db.transaction(async (tx) => ...)` satisfies the
// narrower parameter type).
//
// If this narrowing ever regresses (e.g. `DbHandle` loosened back to the
// wide `NodePgDatabase<typeof schema>` type), the `@ts-expect-error` below
// stops matching a real error, becomes an "Unused '@ts-expect-error'
// directive" error itself, and the build fails — so the regression cannot
// land silently. Same technique as permission.engine.spec.ts's
// `_typeOnly_canInRejectsPossiblyUndefinedTarget`.
// ---------------------------------------------------------------------------
function _typeOnly_recordRejectsThePooledHandle(
  writer: OutboxWriter,
  pooled: NodePgDatabase<typeof schema>,
) {
  // @ts-expect-error a pooled NodePgDatabase is not a DbHandle (live
  // transaction handle) — only what `db.transaction(async (tx) => ...)`
  // hands its own callback satisfies the parameter type.
  return writer.record(pooled, {
    aggregateType: 'user',
    aggregateId: '00000000-0000-0000-0000-000000000000',
    eventType: 'created',
    payload: {},
  })
}
