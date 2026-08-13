import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { sql } from 'drizzle-orm'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import { PrivilegeGuards } from '../src/authz/privilege.guards'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { BusinessRolesRepository } from '../src/business-roles/business-roles.repository'
import { hashDefinition, parseDefinition } from '../src/business-roles/draft'
import { RoleReconciler } from '../src/business-roles/role-reconciler'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { businessRoleConditions } from '../src/db/schema/business-roles'
import { groupUserMembers } from '../src/db/schema/group-members'
import { groups } from '../src/db/schema/groups'
import { orgUnits } from '../src/db/schema/org-units'
import { userTargetAccounts } from '../src/db/schema/user-target-accounts'
import { users } from '../src/db/schema/users'
import { GroupsRepository } from '../src/groups/groups.repository'
import { KEYCLOAK_ADMIN_CONFIG, KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { OrganizationsRepository } from '../src/organizations/organizations.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { SyncDetailRepository } from '../src/outbox/sync-detail.repository'
import { SyncStateRepository } from '../src/outbox/sync-state.repository'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersController } from '../src/users/users.controller'
import { UsersRepository } from '../src/users/users.repository'
import { type TestDatabase, withTestDatabase } from './support/pg'

/**
 * `GET /api/users/:id/entitlements` — Milestone 17, Task 12.
 *
 * Runs against the REAL `PermissionGuard`/`PermissionEngine` (only `JwtGuard`
 * is stubbed, and only to stamp a username onto the request the way a
 * verified JWT would), because two of the four things this endpoint has to
 * get right — `user:read`, and 403-not-404 for an out-of-scope user — are
 * decided by that stack and by nothing in the controller. A stubbed guard
 * would assert the controller against a fiction.
 *
 * NOTHING IS TRUNCATED BETWEEN TESTS, and that is load-bearing rather than
 * lazy. `withTestDatabase()` starts one container per test FILE, so every
 * business role a previous `it` published and ENABLED is still enabled and
 * still visible to `listEnabledForEvaluation` in the next one. Two
 * consequences shape every fixture below:
 *  - every condition compares against a value UNIQUE to its call
 *    (`Account Executive #<seq>`), never a shared literal — a shared literal
 *    would let an older test's role match a newer test's user and the row
 *    counts would drift (business-roles.spec.ts's own doc comment records
 *    the "expected 1, got 5" this exact mistake already produced here);
 *  - the one test that deliberately breaks a role re-disables it in a
 *    `finally`, because an enabled unevaluable role makes EVERY later
 *    evaluation in this file refuse.
 * Truncating instead is not an option: `business_role_grants.group_id` is
 * `onDelete: restrict`, so `DELETE FROM groups` fails while any role grants
 * one.
 */

const ctx = withTestDatabase()

const UNREACHABLE_KEYCLOAK_CONFIG = {
  issuer: 'http://127.0.0.1:1/realms/unreachable',
  clientId: 'irrelevant',
  clientSecret: 'irrelevant',
}

let app: INestApplication
/** Mutated per test; read at REQUEST time by the stubbed JwtGuard below. */
let currentUsername = ''

function stubJwtGuard(): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
        subject: 'kc-entitlements-test',
        username: currentUsername,
        email: null,
      }
      return true
    },
  }
}

function roles(): BusinessRolesRepository {
  return new BusinessRolesRepository(ctx.db)
}

/**
 * The `master` organization the organizations backfill migration creates.
 * `organization_id` is NOT NULL on org_units/users/groups and these fixtures
 * insert raw rather than through the repositories that resolve it
 * themselves, so they have to supply it.
 */
async function masterOrgId(): Promise<string> {
  const master = await new OrganizationsRepository(ctx.db).findMaster()
  return master.id
}

let seq = 0

interface Fixture {
  seq: number
  userId: string
  username: string
  orgUnitId: string
  groupId: string
  groupName: string
  roleId: string
  roleName: string
}

/**
 * An org unit of its own, a user in it carrying a jobTitle UNIQUE to this
 * call, a group, and one published + enabled role granting that group to
 * exactly that jobTitle. `options.matches: false` seeds a user the role does
 * NOT match, so a caller can hand-grant the group and watch it come back
 * unjustified.
 *
 * Each fixture gets its OWN root-level org unit (`entitlements_root_<seq>`)
 * because org-unit scoping is what the 403 tests turn on: two roots are
 * ltree-disjoint, so a help_desk scoped to one can never reach the other.
 */
async function seedRoleGrantingGroup(options: { matches: boolean }): Promise<Fixture> {
  seq += 1
  const mine = seq
  const organizationId = await masterOrgId()
  const matchingJobTitle = `Account Executive #${mine}`

  const [unit] = await ctx.db
    .insert(orgUnits)
    .values({ name: `Entitlements Unit ${mine}`, path: `entitlements_root_${mine}`, organizationId })
    .returning()

  const username = `entitlements-fixture-${mine}`
  const [user] = await ctx.db
    .insert(users)
    .values({
      status: 'active',
      organizationId,
      primaryEmail: `${username}@example.com`,
      username,
      firstName: 'Fixture',
      lastName: `User ${mine}`,
      displayName: `Fixture User ${mine}`,
      jobTitle: options.matches ? matchingJobTitle : `Manager #${mine}`,
      orgUnitId: unit.id,
    })
    .returning()

  const groupName = `Entitlements Group ${mine}`
  const [group] = await ctx.db.insert(groups).values({ name: groupName, organizationId }).returning()

  const roleName = `Entitlements Role ${mine}`
  const role = await roles().create({ name: roleName, description: null })
  const definition = {
    conditions: [{ field: 'jobTitle', operator: 'equals', value: matchingJobTitle }],
    grants: [{ kind: 'group_membership', groupId: group.id, target: null }],
  }
  await roles().saveDraft(role.id, definition)
  await roles().recordSimulation(role.id, hashDefinition(parseDefinition(definition)), 0)
  await roles().publish(role.id)
  await roles().setEnabled(role.id, true)

  return {
    seq: mine,
    userId: user.id,
    username,
    orgUnitId: unit.id,
    groupId: group.id,
    groupName,
    roleId: role.id,
    roleName,
  }
}

/**
 * An ACTIVE user holding `help_desk` scoped to one org unit — the "scoped
 * operator" the 403/200 pair turns on. `help_desk` holds `user:read`
 * (authz/actions.ts) and nothing wider, which is the point: the narrowest
 * grant that may reach this endpoint at all.
 */
async function grantScopedHelpDesk(scopeOrgUnitId: string): Promise<string> {
  seq += 1
  const mine = seq
  const organizationId = await masterOrgId()
  const username = `helpdesk-${mine}`

  const [actor] = await ctx.db
    .insert(users)
    .values({
      status: 'active',
      organizationId,
      primaryEmail: `${username}@example.com`,
      username,
      firstName: 'Help',
      lastName: `Desk ${mine}`,
      displayName: `Help Desk ${mine}`,
      orgUnitId: scopeOrgUnitId,
    })
    .returning()

  await new RoleAssignmentsRepository(ctx.db).assign({
    userId: actor.id,
    roleKey: 'help_desk',
    scopeOrgUnitId,
  })

  return username
}

function reconciler(): RoleReconciler {
  return new RoleReconciler(new BusinessRolesRepository(ctx.db), new AuditWriter(), new OutboxWriter())
}

interface EntitlementsBody {
  groups: {
    groupId: string
    groupName: string
    grantSource: string
    grantedBy: string | null
    grantedAt: string
    justifiedBy: { roleId: string; roleName: string }[] | null
  }[]
  targets: {
    target: string
    grantSource: string
    justifiedBy: { roleId: string; roleName: string }[] | null
  }[]
  unevaluable: { roleId: string; roleName: string; reason: string } | null
}

async function getEntitlements(userId: string, asUsername: string, expectStatus = 200) {
  currentUsername = asUsername
  const res = await request(app.getHttpServer()).get(`/users/${userId}/entitlements`).expect(expectStatus)
  return res
}

describe('GET /users/:id/entitlements (Milestone 17, Task 12)', () => {
  /** A GLOBAL super_admin — the "sees everything" actor most tests read as. */
  let globalAdmin: string

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        BusinessRolesRepository,
        RoleReconciler,
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        UsersRepository,
        // UsersController resolves the DESTINATION org unit for POST :id/transfer.
        OrgUnitsRepository,
        PermissionEngine,
        PermissionGuard,
        PrivilegeGuards,
        AuditWriter,
        OutboxWriter,
        Reflector,
        { provide: KEYCLOAK_ADMIN_CONFIG, useValue: UNREACHABLE_KEYCLOAK_CONFIG },
        KeycloakAdminClient,
        GroupsRepository,
        SyncStateRepository,
        SyncDetailRepository,
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue(stubJwtGuard())
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()

    seq += 1
    const organizationId = await masterOrgId()
    const [adminUnit] = await ctx.db
      .insert(orgUnits)
      .values({ name: 'Entitlements Admin', path: `entitlements_admin_${seq}`, organizationId })
      .returning()
    globalAdmin = `entitlements-admin-${seq}`
    const [admin] = await ctx.db
      .insert(users)
      .values({
        status: 'active',
        organizationId,
        primaryEmail: `${globalAdmin}@example.com`,
        username: globalAdmin,
        firstName: 'Global',
        lastName: 'Admin',
        displayName: 'Global Admin',
        orgUnitId: adminUnit.id,
      })
      .returning()
    await new RoleAssignmentsRepository(ctx.db).assign({
      userId: admin.id,
      roleKey: 'super_admin',
      scopeOrgUnitId: null,
    })
  })

  afterAll(async () => {
    await app?.close()
  })

  it('names the roles that justify a role-derived membership, computed live', async () => {
    const fixture = await seedRoleGrantingGroup({ matches: true })
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, fixture.userId, null, new Date()))

    const res = await getEntitlements(fixture.userId, globalAdmin)
    const body = res.body as EntitlementsBody

    expect(body.unevaluable).toBeNull()
    expect(body.groups).toEqual([
      expect.objectContaining({
        groupId: fixture.groupId,
        groupName: fixture.groupName,
        grantSource: 'business_role',
        justifiedBy: [{ roleId: fixture.roleId, roleName: fixture.roleName }],
      }),
    ])
  })

  it('is computed live, never stored: breaking the formula empties justifiedBy while the row stays', async () => {
    const fixture = await seedRoleGrantingGroup({ matches: true })
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, fixture.userId, null, new Date()))

    // The person moves. Nothing reconciles — the ROW is untouched — but the
    // justification must already be gone on the very next read, because it
    // is recomputed rather than remembered. This is the recertification
    // finding: a business_role row that no role currently wants.
    await ctx.pool.query('UPDATE users SET job_title = $1 WHERE id = $2', ['Moved On', fixture.userId])

    const res = await getEntitlements(fixture.userId, globalAdmin)
    const body = res.body as EntitlementsBody

    expect(body.groups).toEqual([
      expect.objectContaining({ groupId: fixture.groupId, grantSource: 'business_role', justifiedBy: [] }),
    ])
  })

  it('shows a manual membership with NO role behind it — the recertification queue', async () => {
    const fixture = await seedRoleGrantingGroup({ matches: false })
    await ctx.db
      .insert(groupUserMembers)
      // organizationId derived from the GROUP, as every production writer
      // does (Task 4 of the organizations milestone).
      .values({
        groupId: fixture.groupId,
        userId: fixture.userId,
        grantSource: 'manual',
        organizationId: sql`(SELECT organization_id FROM groups WHERE id = ${fixture.groupId})`,
      })

    const res = await getEntitlements(fixture.userId, globalAdmin)
    const body = res.body as EntitlementsBody

    expect(body.groups).toEqual([
      expect.objectContaining({ groupId: fixture.groupId, grantSource: 'manual', justifiedBy: [] }),
    ])
  })

  it('a manual row reports justifiedBy: [] even when a role WOULD justify it — the row is the human\'s', async () => {
    // The strong form of the rule, and the one that cannot be faked by a
    // fixture that simply has no matching role: this user DOES match the
    // role, and the role DOES grant this group. Reporting the role beside a
    // hand-made row would tell an operator the access is covered by the
    // role — so recertifying the role would appear to cover it — when in
    // fact the reconciler will never touch that row and disabling the role
    // would change nothing at all.
    const fixture = await seedRoleGrantingGroup({ matches: true })
    await ctx.db
      .insert(groupUserMembers)
      // organizationId derived from the GROUP, as every production writer
      // does (Task 4 of the organizations milestone).
      .values({
        groupId: fixture.groupId,
        userId: fixture.userId,
        grantSource: 'manual',
        organizationId: sql`(SELECT organization_id FROM groups WHERE id = ${fixture.groupId})`,
      })

    const res = await getEntitlements(fixture.userId, globalAdmin)
    const body = res.body as EntitlementsBody

    expect(body.groups).toEqual([
      expect.objectContaining({ groupId: fixture.groupId, grantSource: 'manual', justifiedBy: [] }),
    ])
    // ...and the role really would have justified it, proven by asking the
    // same engine about the same (user, group) pair through a business_role
    // row instead.
    await ctx.pool.query(
      `UPDATE group_user_members SET grant_source = 'business_role' WHERE group_id = $1 AND user_id = $2`,
      [fixture.groupId, fixture.userId],
    )
    const second = (await getEntitlements(fixture.userId, globalAdmin)).body as EntitlementsBody
    expect(second.groups[0].justifiedBy).toEqual([{ roleId: fixture.roleId, roleName: fixture.roleName }])
  })

  it('reports target accounts alongside groups, with the same justification rules', async () => {
    const fixture = await seedRoleGrantingGroup({ matches: true })
    await ctx.db
      .insert(userTargetAccounts)
      .values({ userId: fixture.userId, target: 'keycloak', grantSource: 'manual' })

    const res = await getEntitlements(fixture.userId, globalAdmin)
    const body = res.body as EntitlementsBody

    expect(body.targets).toEqual([
      expect.objectContaining({ target: 'keycloak', grantSource: 'manual', justifiedBy: [] }),
    ])
  })

  it('requires user:read and is narrowed by the actor\'s scope — out of scope is 403, not 404', async () => {
    const fixture = await seedRoleGrantingGroup({ matches: true })
    const elsewhere = await seedRoleGrantingGroup({ matches: false })
    const outOfScope = await grantScopedHelpDesk(elsewhere.orgUnitId)

    const res = await getEntitlements(fixture.userId, outOfScope, 403)
    expect(res.body.code).toBe('FORBIDDEN')
    // Finding SEC-L2: the message must not echo the submitted id back, or
    // the 403 becomes the existence oracle the 403 exists to prevent.
    expect(JSON.stringify(res.body)).not.toContain(fixture.userId)
  })

  it('a scoped help-desk operator CAN read it for someone inside their scope', async () => {
    const fixture = await seedRoleGrantingGroup({ matches: true })
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, fixture.userId, null, new Date()))
    const inScope = await grantScopedHelpDesk(fixture.orgUnitId)

    const res = await getEntitlements(fixture.userId, inScope)
    const body = res.body as EntitlementsBody

    expect(body.groups).toEqual([
      expect.objectContaining({
        groupId: fixture.groupId,
        justifiedBy: [{ roleId: fixture.roleId, roleName: fixture.roleName }],
      }),
    ])
  })

  it('a user who genuinely does not exist is still 404', async () => {
    await getEntitlements('00000000-0000-0000-0000-0000000000ff', globalAdmin, 404)
  })

  /**
   * MUST RUN LAST-ISH, and re-disables its role in a `finally`: an enabled
   * role the evaluator cannot understand makes EVERY evaluation in this
   * file refuse, not just this one (`evaluateRoles` refuses wholesale — see
   * its doc comment).
   */
  it('still renders the rows when the engine refuses, marking them unevaluable rather than 500ing', async () => {
    const fixture = await seedRoleGrantingGroup({ matches: true })
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, fixture.userId, null, new Date()))
    await ctx.db
      .insert(userTargetAccounts)
      .values({ userId: fixture.userId, target: 'keycloak', grantSource: 'manual' })

    // A published condition naming a field this binary has no extractor for
    // — the shape a migration newer than the running code produces. Written
    // straight to the published child table on purpose: the draft/publish
    // path validates, and the state under test is one that only arrives by
    // outliving the code that wrote it.
    const brokenName = `Entitlements Broken Role ${fixture.seq}`
    const broken = await roles().create({ name: brokenName, description: null })
    await ctx.db
      .insert(businessRoleConditions)
      .values({ businessRoleId: broken.id, field: 'favouriteColour', operator: 'equals', value: 'blue' })
    await roles().setEnabled(broken.id, true)

    try {
      const res = await getEntitlements(fixture.userId, globalAdmin)
      const body = res.body as EntitlementsBody

      // The whole point: 200, with the rows.
      expect(body.unevaluable).toEqual({
        roleId: broken.id,
        roleName: brokenName,
        reason: 'unknown field "favouriteColour"',
      })
      expect(body.groups).toEqual([
        expect.objectContaining({ groupId: fixture.groupId, grantSource: 'business_role', justifiedBy: null }),
      ])
      // A manual row is unaffected by the refusal — `[]`, never `null`.
      // The engine's ability to evaluate is not part of that row's answer.
      expect(body.targets).toEqual([
        expect.objectContaining({ target: 'keycloak', grantSource: 'manual', justifiedBy: [] }),
      ])
    } finally {
      await roles().setEnabled(broken.id, false)
    }
  })

  it('the refusal is transient: re-disabling the broken role restores justification with no other change', async () => {
    const fixture = await seedRoleGrantingGroup({ matches: true })
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, fixture.userId, null, new Date()))

    const body = (await getEntitlements(fixture.userId, globalAdmin)).body as EntitlementsBody
    expect(body.unevaluable).toBeNull()
    expect(body.groups[0].justifiedBy).toEqual([{ roleId: fixture.roleId, roleName: fixture.roleName }])
  })
})
