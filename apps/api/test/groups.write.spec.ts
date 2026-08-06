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
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { GroupsController } from '../src/groups/groups.controller'
import { GroupsRepository } from '../src/groups/groups.repository'
import { OrgUnitsRepository, type OrgUnit } from '../src/org-units/org-units.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { UsersRepository } from '../src/users/users.repository'
import { type TestDatabase, withTestDatabase } from './support/pg'

/**
 * Stamps `request.principal` from whatever `getUsername()` returns AT
 * REQUEST TIME — same technique as users.write.spec.ts / scope-narrowing.spec.ts.
 */
function stubJwtGuard(getUsername: () => string): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
        subject: 'kc-group-write-test',
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
 */
async function auditRowsFor(ctx: TestDatabase, resourceId: string): Promise<AuditLogRow[]> {
  const { rows } = await ctx.pool.query<AuditLogRow>(
    "SELECT * FROM audit_log WHERE resource_type = 'group' AND resource_id = $1 ORDER BY id ASC",
    [resourceId],
  )
  return rows
}

async function totalAuditCount(ctx: TestDatabase): Promise<number> {
  const { rows } = await ctx.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM audit_log')
  return rows[0]?.count ?? 0
}

const BOGUS_ID = '00000000-0000-0000-0000-000000000000'

/**
 * MILESTONE 3b, TASK 3: group write endpoints. Same audit-FK isolation
 * constraint as users.write.spec.ts (see its file-level comment for the
 * full explanation) — this file never does `DELETE FROM users`,
 * `DELETE FROM groups` or `DELETE FROM org_units` between tests. Every
 * fixture is uniquely named per call (`nextTag()`), rows accumulate for the
 * life of the file's own Testcontainer, and every assertion is scoped to
 * the specific resource/group each test created.
 *
 * `user_admin` holds `group:create`/`group:update`/`group:manage_members`
 * (see ROLE_PERMISSIONS in authz/actions.ts) — unlike org-units,
 * lower-privileged than `super_admin` is enough, so every "in scope" actor
 * fixture below is `user_admin`, scoped to the relevant org unit.
 */
describe('group write endpoints (Milestone 3b, Task 3)', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let currentUsername = ''

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [GroupsController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        GroupsRepository,
        PermissionEngine,
        PermissionGuard,
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
    return `gwr${fixtureSeq}`
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
  // POST /groups
  // =======================================================================
  describe('POST /groups', () => {
    it('creates a scoped group for an in-scope actor and writes exactly one audit row', async () => {
      const org = await makeOrgUnit('Create Root')
      const actor = await makeActiveUser('creator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const tag = nextTag()
      const res = await request(app.getHttpServer())
        .post('/groups')
        .send({ name: `Engineering ${tag}`, description: 'Eng team', orgUnitId: org.id })
        .expect(201)

      expect(res.body.orgUnitId).toBe(org.id)
      expect(res.body.description).toBe('Eng team')

      const rows = await auditRowsFor(ctx, res.body.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].action).toBe('group:create')
      expect(rows[0].actor_user_id).toBe(actor.id)
      expect(rows[0].before).toBeNull()
      expect(rows[0].after?.orgUnitId).toBe(org.id)
    })

    // Decision 1, applied to creation: a group created with no orgUnitId is
    // GLOBAL, and per GroupsController.create's doc comment that check is
    // SKIPPED (not escalated to a global-grant requirement) — a SCOPED
    // actor holding group:create may create one.
    it('creates a GLOBAL group (orgUnitId omitted) for a SCOPED actor, with no assertCanIn check', async () => {
      const org = await makeOrgUnit('Global Create Root')
      const actor = await makeActiveUser('scoped-creator', org.id)
      await grant(actor.id, 'user_admin', org.id) // SCOPED, not global
      currentUsername = actor.username

      const tag = nextTag()
      const res = await request(app.getHttpServer())
        .post('/groups')
        .send({ name: `All Staff ${tag}` })
        .expect(201)

      expect(res.body.orgUnitId).toBeNull()

      const rows = await auditRowsFor(ctx, res.body.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].after?.orgUnitId).toBeNull()
    })

    it('rejects a create targeting an out-of-scope org unit with 403 and writes no audit row', async () => {
      const root = await makeOrgUnit('Scope Root')
      const scopeOrg = await makeChildOrgUnit(root.id, 'In Scope')
      const otherOrg = await makeChildOrgUnit(root.id, 'Out Of Scope')
      const actor = await makeActiveUser('scoped-creator', scopeOrg.id)
      await grant(actor.id, 'user_admin', scopeOrg.id)
      currentUsername = actor.username

      const before = await totalAuditCount(ctx)
      const tag = nextTag()

      const res = await request(app.getHttpServer())
        .post('/groups')
        .send({ name: `Blocked ${tag}`, orgUnitId: otherOrg.id })
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await totalAuditCount(ctx)).toBe(before)
    })

    it('maps a nonexistent org unit to 404 NOT_FOUND rather than an unmapped 500', async () => {
      const org = await makeOrgUnit('Global Root')
      const actor = await makeActiveUser('global-creator', org.id)
      await grant(actor.id, 'super_admin', null) // global: assertCanIn short-circuits without
      currentUsername = actor.username // touching org_units, so this reaches the insert.

      const before = await totalAuditCount(ctx)
      const tag = nextTag()

      const res = await request(app.getHttpServer())
        .post('/groups')
        .send({ name: `Ghost ${tag}`, orgUnitId: BOGUS_ID })
        .expect(404)
      expect(res.body.code).toBe('NOT_FOUND')
      expect(res.body.message).toContain('org unit')

      expect(await totalAuditCount(ctx)).toBe(before)
    })

    it('rejects a malformed body with 400 VALIDATION_FAILED and writes no audit row', async () => {
      const org = await makeOrgUnit('Validation Root')
      const actor = await makeActiveUser('creator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const before = await totalAuditCount(ctx)

      const res = await request(app.getHttpServer())
        .post('/groups')
        .send({ orgUnitId: org.id }) // missing required `name`
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')

      expect(await totalAuditCount(ctx)).toBe(before)
    })

    it('rejects an unrecognized custom attribute by default (no active definitions exist)', async () => {
      const org = await makeOrgUnit('Attributes Root')
      const actor = await makeActiveUser('creator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const tag = nextTag()
      const res = await request(app.getHttpServer())
        .post('/groups')
        .send({ name: `Attr Test ${tag}`, orgUnitId: org.id, attributes: { costCenter: 'CC-1' } })
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
    })

    it('rejects a duplicate group name with 409 CONFLICT naming the right constraint, and the failed attempt writes no audit row', async () => {
      const org = await makeOrgUnit('Duplicate Root')
      const actor = await makeActiveUser('creator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const tag = nextTag()
      const name = `Duplicate Group ${tag}`

      const first = await request(app.getHttpServer())
        .post('/groups')
        .send({ name, orgUnitId: org.id })
        .expect(201)
      expect(await auditRowsFor(ctx, first.body.id)).toHaveLength(1)

      const before = await totalAuditCount(ctx)
      const res = await request(app.getHttpServer())
        .post('/groups')
        .send({ name, orgUnitId: org.id })
        .expect(409)
      expect(res.body.code).toBe('CONFLICT')
      expect(res.body.message).toContain(name)

      expect(await totalAuditCount(ctx)).toBe(before)
    })
  })

  // =======================================================================
  // PATCH /groups/:id
  // =======================================================================
  describe('PATCH /groups/:id', () => {
    it('updates an in-scope group and writes exactly one audit row with correct before/after', async () => {
      const org = await makeOrgUnit('Update Root')
      const actor = await makeActiveUser('updater', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const group = await groupsRepo().create({ name: `Target ${nextTag()}`, orgUnitId: org.id })
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .patch(`/groups/${group.id}`)
        .send({ description: 'Updated description' })
        .expect(200)
      expect(res.body.description).toBe('Updated description')

      const rows = await auditRowsFor(ctx, group.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].action).toBe('group:update')
      expect(rows[0].before?.description).toBeNull()
      expect(rows[0].after?.description).toBe('Updated description')
      // Untouched fields carry through unchanged in both snapshots.
      expect(rows[0].before?.name).toBe(group.name)
      expect(rows[0].after?.name).toBe(group.name)
    })

    it('leaves attributes untouched when the request body omits the key entirely', async () => {
      const org = await makeOrgUnit('Attr Preserve Root')
      const actor = await makeActiveUser('updater', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const group = await groupsRepo().create({ name: `Target ${nextTag()}`, orgUnitId: org.id })
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .patch(`/groups/${group.id}`)
        .send({ name: `Renamed ${nextTag()}` })
        .expect(200)
      expect(res.body.attributes).toEqual(group.attributes)
    })

    it('rejects updating an out-of-scope group with 403 and writes no audit row', async () => {
      const root = await makeOrgUnit('Update Scope Root')
      const scopeOrg = await makeChildOrgUnit(root.id, 'In Scope')
      const otherOrg = await makeChildOrgUnit(root.id, 'Out Of Scope')
      const actor = await makeActiveUser('scoped-updater', scopeOrg.id)
      await grant(actor.id, 'user_admin', scopeOrg.id)
      const group = await groupsRepo().create({ name: `Target ${nextTag()}`, orgUnitId: otherOrg.id })
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .patch(`/groups/${group.id}`)
        .send({ description: 'Should Not Land' })
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await auditRowsFor(ctx, group.id)).toHaveLength(0)
    })

    // The brief's explicit contract: "A global group (org_unit_id = NULL)
    // is writable by a scoped actor holding the action."
    it('updates a GLOBAL group as a SCOPED actor, with no assertCanIn check', async () => {
      const org = await makeOrgUnit('Global Update Root')
      const actor = await makeActiveUser('scoped-updater', org.id)
      await grant(actor.id, 'user_admin', org.id) // SCOPED, not global
      const globalGroup = await groupsRepo().create({ name: `Global Target ${nextTag()}` })
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .patch(`/groups/${globalGroup.id}`)
        .send({ description: 'Managed by a scoped actor' })
        .expect(200)
      expect(res.body.description).toBe('Managed by a scoped actor')
      expect(res.body.orgUnitId).toBeNull()

      expect(await auditRowsFor(ctx, globalGroup.id)).toHaveLength(1)
    })

    it('rejects a duplicate name on rename with 409 CONFLICT', async () => {
      const org = await makeOrgUnit('Rename Conflict Root')
      const actor = await makeActiveUser('updater', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const tag = nextTag()
      const existingName = `Existing ${tag}`
      await groupsRepo().create({ name: existingName, orgUnitId: org.id })
      const toRename = await groupsRepo().create({ name: `Renamable ${tag}`, orgUnitId: org.id })
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .patch(`/groups/${toRename.id}`)
        .send({ name: existingName })
        .expect(409)
      expect(res.body.code).toBe('CONFLICT')

      expect(await auditRowsFor(ctx, toRename.id)).toHaveLength(0)
    })

    it('returns 404 for a well-formed but nonexistent group id', async () => {
      const org = await makeOrgUnit('Missing Group Root')
      const actor = await makeActiveUser('updater', org.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .patch(`/groups/${BOGUS_ID}`)
        .send({ description: 'Nobody' })
        .expect(404)
      expect(res.body.code).toBe('NOT_FOUND')
    })

    it('rejects an update body with an unrecognized field with 400 VALIDATION_FAILED', async () => {
      const org = await makeOrgUnit('Strict Body Root')
      const actor = await makeActiveUser('updater', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const group = await groupsRepo().create({ name: `Target ${nextTag()}`, orgUnitId: org.id })
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .patch(`/groups/${group.id}`)
        .send({ notAField: 'nope' })
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
    })
  })

  // =======================================================================
  // POST /groups/:id/members, DELETE /groups/:id/members/:userId
  // =======================================================================
  describe('group membership', () => {
    it('adds a user to an in-scope group and writes exactly one audit row', async () => {
      const org = await makeOrgUnit('Member Root')
      const actor = await makeActiveUser('manager', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const group = await groupsRepo().create({ name: `Team ${nextTag()}`, orgUnitId: org.id })
      const target = await makeActiveUser('member', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/groups/${group.id}/members`)
        .send({ userId: target.id })
        .expect(201)
      expect(res.body).toEqual({ groupId: group.id, userId: target.id })

      const rows = await auditRowsFor(ctx, group.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].action).toBe('group:add_member')
      expect(rows[0].before).toBeNull()
      expect(rows[0].after).toEqual({ groupId: group.id, userId: target.id })
    })

    it('removing a member is audited, and the group ends with add-then-remove in its history', async () => {
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

      const res = await request(app.getHttpServer())
        .delete(`/groups/${group.id}/members/${target.id}`)
        .expect(200)
      expect(res.body).toEqual({ groupId: group.id, userId: target.id })

      const rows = await auditRowsFor(ctx, group.id)
      expect(rows).toHaveLength(2)
      expect(rows[0].action).toBe('group:add_member')
      expect(rows[1].action).toBe('group:remove_member')
      expect(rows[1].before).toEqual({ groupId: group.id, userId: target.id })
      expect(rows[1].after).toBeNull()
    })

    // Membership is scoped by the GROUP, not by the member's own org unit —
    // GroupsController.addMember/removeMember never check the target
    // user's orgUnitId (see the doc comment above those handlers).
    it('adds a member from a completely different org unit, since membership narrows on the group, not the member', async () => {
      const org = await makeOrgUnit('Member Group Root')
      const otherOrg = await makeOrgUnit('Member User Root')
      const actor = await makeActiveUser('manager', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const group = await groupsRepo().create({ name: `Team ${nextTag()}`, orgUnitId: org.id })
      const target = await makeActiveUser('outsider', otherOrg.id)
      currentUsername = actor.username

      await request(app.getHttpServer())
        .post(`/groups/${group.id}/members`)
        .send({ userId: target.id })
        .expect(201)
    })

    it('rejects adding a member to an out-of-scope group with 403 and writes no audit row', async () => {
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

      expect(await auditRowsFor(ctx, group.id)).toHaveLength(0)
    })

    it('adds and removes a member on a GLOBAL group as a SCOPED actor, with no assertCanIn check', async () => {
      const org = await makeOrgUnit('Global Member Root')
      const actor = await makeActiveUser('scoped-manager', org.id)
      await grant(actor.id, 'user_admin', org.id) // SCOPED, not global
      const globalGroup = await groupsRepo().create({ name: `Global Team ${nextTag()}` })
      const target = await makeActiveUser('member', org.id)
      currentUsername = actor.username

      await request(app.getHttpServer())
        .post(`/groups/${globalGroup.id}/members`)
        .send({ userId: target.id })
        .expect(201)
      await request(app.getHttpServer())
        .delete(`/groups/${globalGroup.id}/members/${target.id}`)
        .expect(200)

      expect(await auditRowsFor(ctx, globalGroup.id)).toHaveLength(2)
    })

    it('maps a nonexistent userId on add to 404 NOT_FOUND and writes no audit row', async () => {
      const org = await makeOrgUnit('Bogus Member Root')
      const actor = await makeActiveUser('manager', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const group = await groupsRepo().create({ name: `Team ${nextTag()}`, orgUnitId: org.id })
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/groups/${group.id}/members`)
        .send({ userId: BOGUS_ID })
        .expect(404)
      expect(res.body.code).toBe('NOT_FOUND')

      expect(await auditRowsFor(ctx, group.id)).toHaveLength(0)
    })

    it('rejects a malformed userId in the add-member body with 400 VALIDATION_FAILED', async () => {
      const org = await makeOrgUnit('Malformed Member Root')
      const actor = await makeActiveUser('manager', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const group = await groupsRepo().create({ name: `Team ${nextTag()}`, orgUnitId: org.id })
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/groups/${group.id}/members`)
        .send({ userId: 'not-a-uuid' })
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
    })
  })

  // =======================================================================
  // POST /groups/:id/child-groups, DELETE /groups/:id/child-groups/:childId
  // =======================================================================
  describe('nested child groups', () => {
    it('adds a child group to an in-scope parent and writes exactly one audit row', async () => {
      const org = await makeOrgUnit('Nest Root')
      const actor = await makeActiveUser('manager', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const parent = await groupsRepo().create({ name: `Parent ${nextTag()}`, orgUnitId: org.id })
      const child = await groupsRepo().create({ name: `Child ${nextTag()}`, orgUnitId: org.id })
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/groups/${parent.id}/child-groups`)
        .send({ childId: child.id })
        .expect(201)
      expect(res.body).toEqual({ parentGroupId: parent.id, childGroupId: child.id })

      const rows = await auditRowsFor(ctx, parent.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].action).toBe('group:add_child_group')
      expect(rows[0].after).toEqual({ parentGroupId: parent.id, childGroupId: child.id })
    })

    it('removing a child group is audited', async () => {
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

      const res = await request(app.getHttpServer())
        .delete(`/groups/${parent.id}/child-groups/${child.id}`)
        .expect(200)
      expect(res.body).toEqual({ parentGroupId: parent.id, childGroupId: child.id })

      const rows = await auditRowsFor(ctx, parent.id)
      expect(rows).toHaveLength(2)
      expect(rows[1].action).toBe('group:remove_child_group')
      expect(rows[1].before).toEqual({ parentGroupId: parent.id, childGroupId: child.id })
      expect(rows[1].after).toBeNull()
    })

    it('rejects nesting under an out-of-scope parent with 403 and writes no audit row', async () => {
      const root = await makeOrgUnit('Nest Scope Root')
      const scopeOrg = await makeChildOrgUnit(root.id, 'In Scope')
      const otherOrg = await makeChildOrgUnit(root.id, 'Out Of Scope')
      const actor = await makeActiveUser('scoped-manager', scopeOrg.id)
      await grant(actor.id, 'user_admin', scopeOrg.id)
      const parent = await groupsRepo().create({ name: `Parent ${nextTag()}`, orgUnitId: otherOrg.id })
      const child = await groupsRepo().create({ name: `Child ${nextTag()}`, orgUnitId: otherOrg.id })
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/groups/${parent.id}/child-groups`)
        .send({ childId: child.id })
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await auditRowsFor(ctx, parent.id)).toHaveLength(0)
    })

    it('nests under a GLOBAL parent group as a SCOPED actor, with no assertCanIn check', async () => {
      const org = await makeOrgUnit('Global Nest Root')
      const actor = await makeActiveUser('scoped-manager', org.id)
      await grant(actor.id, 'user_admin', org.id) // SCOPED, not global
      const globalParent = await groupsRepo().create({ name: `Global Parent ${nextTag()}` })
      const child = await groupsRepo().create({ name: `Child ${nextTag()}`, orgUnitId: org.id })
      currentUsername = actor.username

      await request(app.getHttpServer())
        .post(`/groups/${globalParent.id}/child-groups`)
        .send({ childId: child.id })
        .expect(201)

      expect(await auditRowsFor(ctx, globalParent.id)).toHaveLength(1)
    })

    it('maps a nonexistent childId to 404 NOT_FOUND and writes no audit row', async () => {
      const org = await makeOrgUnit('Bogus Child Root')
      const actor = await makeActiveUser('manager', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const parent = await groupsRepo().create({ name: `Parent ${nextTag()}`, orgUnitId: org.id })
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/groups/${parent.id}/child-groups`)
        .send({ childId: BOGUS_ID })
        .expect(404)
      expect(res.body.code).toBe('NOT_FOUND')

      expect(await auditRowsFor(ctx, parent.id)).toHaveLength(0)
    })

    // THE test the brief calls out by name: "Cycle attempt over HTTP -> 409,
    // audit count unchanged." Goes through GroupsRepository.addChildGroup's
    // existing advisory-locked cycle guard unchanged (see its doc comment
    // and GroupsController.addChildGroup's) — this proves the HTTP layer
    // wires into it correctly, not that the guard's own logic is correct
    // (that is exhaustively covered — self-edge, direct, transitive,
    // diamond, and a 20-iteration concurrent race — by
    // group-membership.spec.ts already, at the repository layer).
    it('a cycle attempt over HTTP returns 409 CYCLE_DETECTED, and writes no audit row for the rejected call', async () => {
      const org = await makeOrgUnit('Cycle Root')
      const actor = await makeActiveUser('manager', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const a = await groupsRepo().create({ name: `A ${nextTag()}`, orgUnitId: org.id })
      const b = await groupsRepo().create({ name: `B ${nextTag()}`, orgUnitId: org.id })
      currentUsername = actor.username

      // A -> B, a genuine successful nest, audited once against A.
      await request(app.getHttpServer())
        .post(`/groups/${a.id}/child-groups`)
        .send({ childId: b.id })
        .expect(201)
      expect(await auditRowsFor(ctx, a.id)).toHaveLength(1)
      expect(await auditRowsFor(ctx, b.id)).toHaveLength(0)

      const before = await totalAuditCount(ctx)

      // B -> A would close the loop: A is already reachable downward from B.
      const res = await request(app.getHttpServer())
        .post(`/groups/${b.id}/child-groups`)
        .send({ childId: a.id })
        .expect(409)
      expect(res.body.code).toBe('CYCLE_DETECTED')

      // The rejected call's resourceId is B (:id in the URL) — it must have
      // ZERO audit rows, and the table-wide count must not have moved at
      // all (not just "B has none" — nothing anywhere was written).
      expect(await auditRowsFor(ctx, b.id)).toHaveLength(0)
      expect(await totalAuditCount(ctx)).toBe(before)
    })

    it('a self-nesting attempt over HTTP returns 409 CYCLE_DETECTED, and writes no audit row', async () => {
      const org = await makeOrgUnit('Self Cycle Root')
      const actor = await makeActiveUser('manager', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const group = await groupsRepo().create({ name: `Self ${nextTag()}`, orgUnitId: org.id })
      currentUsername = actor.username

      const before = await totalAuditCount(ctx)

      const res = await request(app.getHttpServer())
        .post(`/groups/${group.id}/child-groups`)
        .send({ childId: group.id })
        .expect(409)
      expect(res.body.code).toBe('CYCLE_DETECTED')

      expect(await auditRowsFor(ctx, group.id)).toHaveLength(0)
      expect(await totalAuditCount(ctx)).toBe(before)
    })
  })

  // =======================================================================
  // Redaction: audit payloads are built from named fields, not `{ ...row }`.
  // =======================================================================
  describe('audit payload construction', () => {
    it('never carries a credential-shaped key in before/after, even scanned as raw JSON', async () => {
      const org = await makeOrgUnit('Redaction Root')
      const actor = await makeActiveUser('creator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const tag = nextTag()
      const res = await request(app.getHttpServer())
        .post('/groups')
        .send({ name: `Redact ${tag}`, orgUnitId: org.id })
        .expect(201)

      const rows = await auditRowsFor(ctx, res.body.id)
      const serialized = JSON.stringify(rows[0].after).toLowerCase()
      for (const forbidden of ['password', 'passwd', 'secret', 'hash', 'salt', 'credential', 'token']) {
        expect(serialized).not.toContain(forbidden)
      }
    })
  })
})
