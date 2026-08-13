import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard, type AuthorizedRequest } from '../src/authz/permission.guard'
import { PrivilegeGuards } from '../src/authz/privilege.guards'
import { RoleAssignmentsController } from '../src/authz/role-assignments.controller'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { GroupsController } from '../src/groups/groups.controller'
import { GroupsRepository } from '../src/groups/groups.repository'
import { KEYCLOAK_ADMIN_CONFIG, KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { OrgUnitsController } from '../src/org-units/org-units.controller'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { SyncDetailRepository } from '../src/outbox/sync-detail.repository'
import { SyncStateRepository } from '../src/outbox/sync-state.repository'
import { BusinessRolesRepository } from '../src/business-roles/business-roles.repository'
import { RoleReconciler } from '../src/business-roles/role-reconciler'
import { UsersController } from '../src/users/users.controller'
import { UsersRepository } from '../src/users/users.repository'
import { type TestDatabase, withTestDatabase } from './support/pg'

// Milestone 4, Task 4 — see the identical comment in users.write.spec.ts:
// UsersController now depends on KeycloakAdminClient/SyncStateRepository.
// This file's GET-only describe blocks never call deactivate, but DI still
// needs a well-formed (never-reachable) config to construct the controller.
const UNREACHABLE_KEYCLOAK_CONFIG = {
  issuer: 'http://127.0.0.1:1/realms/unreachable',
  clientId: 'irrelevant',
  clientSecret: 'irrelevant',
}

/**
 * Clears every table this file touches, in FK-safe order: `groups` first
 * (group_user_members/group_group_members cascade from it), then `users`
 * (role_assignments cascades from it), then `org_units` last — both
 * `groups.org_unit_id` and `users.org_unit_id` are `restrict`, so org_units
 * cannot be cleared while either still references it.
 *
 * Every describe block below shares ONE container/pool (see the single
 * `withTestDatabase()` call at the bottom of this file) purely for speed,
 * but every block still calls this before each of its own tests, so no
 * block can ever see another's leftover fixtures regardless of run order.
 */
async function resetTables(ctx: TestDatabase): Promise<void> {
  await ctx.pool.query('DELETE FROM groups')
  await ctx.pool.query('DELETE FROM users')
  await ctx.pool.query('DELETE FROM org_units')
}

/**
 * Stamps `request.principal` from whatever `getUsername()` returns AT
 * REQUEST TIME (not at stub-creation time) — same technique as
 * permission.guard.spec.ts's ProbeController fixture. Lets one compiled app
 * impersonate different actors across tests in the same describe block by
 * mutating a `let currentUsername` the getter closes over.
 */
function stubJwtGuard(getUsername: () => string): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
        subject: 'kc-scope-test',
        username: getUsername(),
        email: null,
      }
      return true
    },
  }
}

describe('scope narrowing (Milestone 3b, Task 1)', () => {
  const ctx = withTestDatabase()

  // ---------------------------------------------------------------------
  // GET /users
  // ---------------------------------------------------------------------
  describe('GET /users', () => {
    let app: INestApplication
    let currentUsername = 'helen'

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [UsersController],
        providers: [
          // UsersController resolves the DESTINATION org unit for POST :id/transfer.
          OrgUnitsRepository,
          // Milestone 17, Task 9: UsersController now re-evaluates business roles
          // inside its own create/update transactions, and its RoleReconciler
          // parameter is deliberately NOT @Optional() (an absent reconciler would
          // mean every user write silently skips re-evaluation). Both providers are
          // therefore required to construct it, here exactly as in AppModule.
          BusinessRolesRepository,
          RoleReconciler,
          { provide: DB_CLIENT, useFactory: () => ctx.db },
          UsersRepository,
          PermissionEngine,
          PermissionGuard,
          // Milestone 3b, Task 2: UsersController's write handlers also
          // depend on PrivilegeGuards and AuditWriter now — required here
          // purely for DI resolution; this describe block only exercises
          // the (unchanged) read routes. Milestone 4, Task 1 adds
          // OutboxWriter alongside AuditWriter for the same reason.
          PrivilegeGuards,
          AuditWriter,
          OutboxWriter,
          Reflector,
          // Milestone 4, Task 4 — see UNREACHABLE_KEYCLOAK_CONFIG's comment above.
          { provide: KEYCLOAK_ADMIN_CONFIG, useValue: UNREACHABLE_KEYCLOAK_CONFIG },
          KeycloakAdminClient,
          GroupsRepository,
          SyncStateRepository,
      SyncDetailRepository,
        SyncDetailRepository,
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

    let salesId: string
    let engineeringId: string
    let eveId: string
    let samId: string

    beforeEach(async () => {
      await resetTables(ctx)
      currentUsername = 'helen'

      const orgUnits = new OrgUnitsRepository(ctx.db)
      const users = new UsersRepository(ctx.db)
      const roles = new RoleAssignmentsRepository(ctx.db)

      const root = await orgUnits.createRoot('Acme Corp')
      const sales = await orgUnits.createChild(root.id, 'Sales')
      const engineering = await orgUnits.createChild(root.id, 'Engineering')
      salesId = sales.id
      engineeringId = engineering.id

      const activate = async (username: string, orgUnitId: string) => {
        const user = await users.create({
          primaryEmail: `${username}@example.com`,
          username,
          firstName: 'Test',
          lastName: 'User',
          orgUnitId,
        })
        return users.changeStatus(user.id, 'active')
      }

      // help_desk, scoped to Sales — the exact fixture shape the brief calls out.
      const helen = await activate('helen', sales.id)
      await roles.assign({ userId: helen.id, roleKey: 'help_desk', scopeOrgUnitId: sales.id })

      const sam = await activate('sam', sales.id)
      samId = sam.id

      const eve = await activate('eve', engineering.id)
      eveId = eve.id

      // A GLOBAL role, unaffected by scope — used by the "sees everything" test.
      const gina = await activate('gina', root.id)
      await roles.assign({ userId: gina.id, roleKey: 'super_admin', scopeOrgUnitId: null })
    })

    it('a help_desk scoped to Sales sees only the Sales-subtree users on the list, with total matching', async () => {
      const res = await request(app.getHttpServer()).get('/users').expect(200)
      expect(res.body.total).toBe(2)
      expect(res.body.items.map((u: { username: string }) => u.username).sort()).toEqual([
        'helen',
        'sam',
      ])
    })

    it('returns 200 for an in-scope user and 403 (not 404) for an out-of-scope one', async () => {
      await request(app.getHttpServer()).get(`/users/${samId}`).expect(200)
      const res = await request(app.getHttpServer()).get(`/users/${eveId}`).expect(403)
      expect(res.body.code).toBe('FORBIDDEN')
    })

    it('a global role sees everyone, and the unfiltered total differs from the scoped one', async () => {
      currentUsername = 'gina'
      const res = await request(app.getHttpServer()).get('/users').expect(200)
      expect(res.body.total).toBe(4)
      expect(res.body.items.map((u: { username: string }) => u.username).sort()).toEqual([
        'eve',
        'gina',
        'helen',
        'sam',
      ])
      await request(app.getHttpServer()).get(`/users/${eveId}`).expect(200)
    })

    it('moving a user into scope changes the very next request — no restart, no caching', async () => {
      await request(app.getHttpServer()).get(`/users/${eveId}`).expect(403)

      await ctx.pool.query('UPDATE users SET org_unit_id = $1 WHERE id = $2', [salesId, eveId])

      await request(app.getHttpServer()).get(`/users/${eveId}`).expect(200)
      const res = await request(app.getHttpServer()).get('/users').expect(200)
      expect(res.body.total).toBe(3)
      expect(res.body.items.map((u: { username: string }) => u.username).sort()).toEqual([
        'eve',
        'helen',
        'sam',
      ])
    })
  })

  // ---------------------------------------------------------------------
  // GET /org-units
  // ---------------------------------------------------------------------
  describe('GET /org-units', () => {
    let app: INestApplication
    let currentUsername = 'helen'

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [OrgUnitsController],
        providers: [
          { provide: DB_CLIENT, useFactory: () => ctx.db },
          OrgUnitsRepository,
          PermissionEngine,
          PermissionGuard,
          // Milestone 3b, Task 3: OrgUnitsController's write handler now
          // also depends on AuditWriter — required here purely for DI
          // resolution; this describe block only exercises the (unchanged)
          // read routes. Milestone 4, Task 1 adds OutboxWriter alongside it
          // for the same reason.
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

    let rootId: string
    let salesId: string
    let emeaId: string
    let engineeringId: string

    beforeEach(async () => {
      await resetTables(ctx)
      currentUsername = 'helen'

      const orgUnits = new OrgUnitsRepository(ctx.db)
      const users = new UsersRepository(ctx.db)
      const roles = new RoleAssignmentsRepository(ctx.db)

      const root = await orgUnits.createRoot('Acme Corp')
      const sales = await orgUnits.createChild(root.id, 'Sales')
      const emea = await orgUnits.createChild(sales.id, 'EMEA')
      const engineering = await orgUnits.createChild(root.id, 'Engineering')
      rootId = root.id
      salesId = sales.id
      emeaId = emea.id
      engineeringId = engineering.id

      const activate = async (username: string, orgUnitId: string) => {
        const user = await users.create({
          primaryEmail: `${username}@example.com`,
          username,
          firstName: 'Test',
          lastName: 'User',
          orgUnitId,
        })
        return users.changeStatus(user.id, 'active')
      }

      const helen = await activate('helen', sales.id)
      await roles.assign({ userId: helen.id, roleKey: 'help_desk', scopeOrgUnitId: sales.id })

      const gina = await activate('gina', root.id)
      await roles.assign({ userId: gina.id, roleKey: 'super_admin', scopeOrgUnitId: null })
    })

    it('a help_desk scoped to Sales sees only Sales and its descendants, with total matching', async () => {
      const res = await request(app.getHttpServer()).get('/org-units').expect(200)
      expect(res.body.total).toBe(2)
      expect(res.body.items.map((u: { path: string }) => u.path).sort()).toEqual([
        'acme_corp.sales',
        'acme_corp.sales.emea',
      ])
    })

    it('returns 200 inside scope (root of scope and a nested descendant) and 403 outside it (sibling and ancestor alike)', async () => {
      await request(app.getHttpServer()).get(`/org-units/${salesId}`).expect(200)
      await request(app.getHttpServer()).get(`/org-units/${emeaId}`).expect(200)

      const sibling = await request(app.getHttpServer()).get(`/org-units/${engineeringId}`).expect(403)
      expect(sibling.body.code).toBe('FORBIDDEN')

      // The root is an ANCESTOR of Sales, not a descendant — being scoped to
      // a subtree does not grant visibility upward to its parents.
      const ancestor = await request(app.getHttpServer()).get(`/org-units/${rootId}`).expect(403)
      expect(ancestor.body.code).toBe('FORBIDDEN')
    })

    it('subtree: 200 and correctly bounded for the in-scope root, 403 for an out-of-scope one', async () => {
      const res = await request(app.getHttpServer()).get(`/org-units/${salesId}/subtree`).expect(200)
      expect(res.body.map((u: { path: string }) => u.path).sort()).toEqual([
        'acme_corp.sales',
        'acme_corp.sales.emea',
      ])

      await request(app.getHttpServer()).get(`/org-units/${engineeringId}/subtree`).expect(403)
    })

    it('a global role sees every org unit', async () => {
      currentUsername = 'gina'
      const res = await request(app.getHttpServer()).get('/org-units').expect(200)
      expect(res.body.total).toBe(4)
    })
  })

  // ---------------------------------------------------------------------
  // GET /groups
  // ---------------------------------------------------------------------
  describe('GET /groups', () => {
    let app: INestApplication
    let currentUsername = 'helen'

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [GroupsController],
        providers: [
          { provide: DB_CLIENT, useFactory: () => ctx.db },
          GroupsRepository,
          PermissionEngine,
          PermissionGuard,
          // Milestone 3b, Task 3: GroupsController's write handlers now
          // also depend on AuditWriter — required here purely for DI
          // resolution; this describe block only exercises the (unchanged)
          // read routes. Milestone 4, Task 1 adds OutboxWriter alongside it
          // for the same reason.
          AuditWriter,
          OutboxWriter,
          Reflector,
          // Finding L-2 (docs/archive/audits/audit-authz.md): GroupsController
          // now loads the target user for the ?userId= scope check —
          // required here for DI resolution. See the "?userId=" tests below.
          UsersRepository,
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

    let rootId: string
    let salesTeamId: string
    let engTeamId: string
    let allStaffId: string
    let samId: string

    beforeEach(async () => {
      await resetTables(ctx)
      currentUsername = 'helen'

      const orgUnits = new OrgUnitsRepository(ctx.db)
      const users = new UsersRepository(ctx.db)
      const roles = new RoleAssignmentsRepository(ctx.db)
      const groups = new GroupsRepository(ctx.db)

      const root = await orgUnits.createRoot('Acme Corp')
      const sales = await orgUnits.createChild(root.id, 'Sales')
      const engineering = await orgUnits.createChild(root.id, 'Engineering')
      rootId = root.id

      const helen = await users.create({
        primaryEmail: 'helen@example.com',
        username: 'helen',
        firstName: 'Helen',
        lastName: 'Desk',
        orgUnitId: sales.id,
      })
      await users.changeStatus(helen.id, 'active')
      await roles.assign({ userId: helen.id, roleKey: 'help_desk', scopeOrgUnitId: sales.id })

      const sam = await users.create({
        primaryEmail: 'sam@example.com',
        username: 'sam',
        firstName: 'Sam',
        lastName: 'Sales',
        orgUnitId: sales.id,
      })
      await users.changeStatus(sam.id, 'active')
      samId = sam.id

      const salesTeam = await groups.create({ name: 'Sales Team', orgUnitId: sales.id })
      const engTeam = await groups.create({ name: 'Engineering Team', orgUnitId: engineering.id })
      const allStaff = await groups.create({ name: 'All Staff' }) // orgUnitId omitted -> global
      salesTeamId = salesTeam.id
      engTeamId = engTeam.id
      allStaffId = allStaff.id

      // sam belongs to BOTH groups directly, so the ?userId= branch below has
      // a real out-of-scope membership to filter, not just an absent one.
      await groups.addUser(salesTeamId, samId)
      await groups.addUser(engTeamId, samId)
    })

    it('a help_desk scoped to Sales sees Sales Team and the global All Staff, but not Engineering Team', async () => {
      const res = await request(app.getHttpServer()).get('/groups').expect(200)
      expect(res.body.total).toBe(2)
      expect(res.body.items.map((g: { name: string }) => g.name).sort()).toEqual([
        'All Staff',
        'Sales Team',
      ])
    })

    it('returns 200 for the in-scope group and the global group, 403 for the out-of-scope one', async () => {
      await request(app.getHttpServer()).get(`/groups/${salesTeamId}`).expect(200)
      // decision 1: orgUnitId = NULL is global — visible to any actor
      // holding group:read, regardless of their own scope.
      await request(app.getHttpServer()).get(`/groups/${allStaffId}`).expect(200)

      const res = await request(app.getHttpServer()).get(`/groups/${engTeamId}`).expect(403)
      expect(res.body.code).toBe('FORBIDDEN')
    })

    it('members and effective-members are narrowed the same way as findOne', async () => {
      await request(app.getHttpServer()).get(`/groups/${salesTeamId}/members`).expect(200)
      await request(app.getHttpServer()).get(`/groups/${engTeamId}/members`).expect(403)
      await request(app.getHttpServer()).get(`/groups/${allStaffId}/effective-members`).expect(200)
      await request(app.getHttpServer()).get(`/groups/${engTeamId}/effective-members`).expect(403)
    })

    it('?userId= is narrowed too: an out-of-scope membership never leaks through the effective-membership branch', async () => {
      const res = await request(app.getHttpServer()).get(`/groups?userId=${samId}`).expect(200)
      expect(res.body.total).toBe(1)
      expect(res.body.items.map((g: { name: string }) => g.name)).toEqual(['Sales Team'])
    })

    // Finding L-2 (docs/archive/audits/audit-authz.md): the test above proves
    // the RESULTING groups are narrowed; this proves the USER named by
    // ?userId= is now scope-checked too. Before this fix, a Sales-scoped
    // helen could query an Engineering user's id and get 200 back (an empty
    // or narrowed page, but still 200 — confirming the id resolves to a
    // real user) even though GET /users/<that id> itself 403s her directly.
    it('?userId= 403s for a user outside the actor\'s own scope, even though GET /groups?userId= for an in-scope user (above) 200s', async () => {
      const orgUnits = new OrgUnitsRepository(ctx.db)
      const users = new UsersRepository(ctx.db)
      // A THIRD org unit, disjoint from Sales (helen's own scope) — not the
      // shared 'Engineering' fixture, so this test cannot accidentally pass
      // because of some other test's leftover state.
      const marketing = await orgUnits.createChild(rootId, 'Marketing L2')
      const eve = await users.create({
        primaryEmail: 'eve-l2@example.com',
        username: 'eve-l2',
        firstName: 'Eve',
        lastName: 'Marketer',
        orgUnitId: marketing.id,
      })
      await users.changeStatus(eve.id, 'active')

      const res = await request(app.getHttpServer()).get(`/groups?userId=${eve.id}`).expect(403)
      expect(res.body.code).toBe('FORBIDDEN')
    })

    it('a global role sees every group, including the out-of-scope one', async () => {
      const users = new UsersRepository(ctx.db)
      const roles = new RoleAssignmentsRepository(ctx.db)
      const gina = await users.create({
        primaryEmail: 'gina@example.com',
        username: 'gina',
        firstName: 'Gina',
        lastName: 'Global',
        orgUnitId: rootId,
      })
      await users.changeStatus(gina.id, 'active')
      await roles.assign({ userId: gina.id, roleKey: 'super_admin', scopeOrgUnitId: null })

      currentUsername = 'gina'
      const res = await request(app.getHttpServer()).get('/groups').expect(200)
      expect(res.body.total).toBe(3)
      expect(res.body.items.map((g: { name: string }) => g.name).sort()).toEqual([
        'All Staff',
        'Engineering Team',
        'Sales Team',
      ])
    })
  })

  // ---------------------------------------------------------------------
  // The null-vs-[] trap, at HTTP level.
  // ---------------------------------------------------------------------
  describe('an actor entitled nowhere ([]) sees an empty page, never everything', () => {
    // Deliberately NOT reachable through the real guard: `canAnywhere` and
    // `scopePathsFor` are computed from the SAME action and the SAME
    // assignments (see permission.engine.ts), so an actor who fails
    // `canAnywhere` is denied with 403 at the guard, before any controller
    // code runs — they can never simultaneously reach a controller with
    // `scopePathsFor` returning `[]` for that identical action. PermissionGuard
    // is stubbed here to attach an actor with NO assignments directly,
    // bypassing that entry check, so each controller's OWN narrowing logic
    // can be exercised in isolation against exactly the trap the contract
    // calls out: `if (paths?.length)` would treat `[]` as "no filter" (i.e.
    // everything, the privilege-escalating bug); the correct `if (paths)`
    // filters correctly even when the array is empty. This is the same
    // guard-stubbing isolation already used by users.controller.spec.ts /
    // org-units.controller.spec.ts / groups.controller.spec.ts — the
    // difference is the attached actor is entitled to nothing rather than
    // everything.
    const NOWHERE_ACTOR: AuthorizedRequest['actor'] = {
      userId: '00000000-0000-0000-0000-0000000000e1',
      username: 'entitled-nowhere',
      orgUnitId: '00000000-0000-0000-0000-0000000000e1',
      assignments: [],
    }

    const stubPermissionGuard: CanActivate = {
      canActivate(context: ExecutionContext): boolean {
        context.switchToHttp().getRequest<AuthorizedRequest>().actor = NOWHERE_ACTOR
        return true
      },
    }

    let app: INestApplication

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [UsersController, OrgUnitsController, GroupsController],
        providers: [
          // Milestone 17, Task 9: UsersController now re-evaluates business roles
          // inside its own create/update transactions, and its RoleReconciler
          // parameter is deliberately NOT @Optional() (an absent reconciler would
          // mean every user write silently skips re-evaluation). Both providers are
          // therefore required to construct it, here exactly as in AppModule.
          BusinessRolesRepository,
          RoleReconciler,
          { provide: DB_CLIENT, useFactory: () => ctx.db },
          UsersRepository,
          OrgUnitsRepository,
          GroupsRepository,
          PermissionEngine,
          // Milestone 3b, Task 2: UsersController's write handlers also
          // depend on PrivilegeGuards and AuditWriter now — required here
          // purely for DI resolution; this describe block only exercises
          // the (unchanged) read routes. Milestone 4, Task 1 adds
          // OutboxWriter alongside AuditWriter for the same reason.
          PrivilegeGuards,
          AuditWriter,
          OutboxWriter,
          // Milestone 4, Task 4 — see UNREACHABLE_KEYCLOAK_CONFIG's comment above.
          { provide: KEYCLOAK_ADMIN_CONFIG, useValue: UNREACHABLE_KEYCLOAK_CONFIG },
          KeycloakAdminClient,
          SyncStateRepository,
      SyncDetailRepository,
        SyncDetailRepository,
        ],
      })
        .overrideGuard(JwtGuard)
        .useValue({ canActivate: () => true })
        .overrideGuard(PermissionGuard)
        .useValue(stubPermissionGuard)
        .compile()

      app = moduleRef.createNestApplication()
      app.useGlobalFilters(new DomainExceptionFilter())
      await app.init()
    })

    afterAll(async () => {
      await app?.close()
    })

    let globalGroupId: string

    beforeEach(async () => {
      await resetTables(ctx)

      const orgUnits = new OrgUnitsRepository(ctx.db)
      const users = new UsersRepository(ctx.db)
      const groups = new GroupsRepository(ctx.db)

      const root = await orgUnits.createRoot('Acme Corp')
      await orgUnits.createChild(root.id, 'Sales')

      const user = await users.create({
        primaryEmail: 'someone@example.com',
        username: 'someone',
        firstName: 'Some',
        lastName: 'One',
        orgUnitId: root.id,
      })
      await users.changeStatus(user.id, 'active')

      await groups.create({ name: 'Scoped Group', orgUnitId: root.id })
      const global = await groups.create({ name: 'Global Group' })
      globalGroupId = global.id
    })

    it('GET /users: empty page with total 0, even though active users exist', async () => {
      const res = await request(app.getHttpServer()).get('/users').expect(200)
      expect(res.body).toEqual({ items: [], total: 0, limit: 50, offset: 0 })
    })

    it('GET /org-units: empty page with total 0, even though org units exist', async () => {
      const res = await request(app.getHttpServer()).get('/org-units').expect(200)
      expect(res.body).toEqual({ items: [], total: 0, limit: 50, offset: 0 })
    })

    it('GET /groups: only the global group, never the scoped one — proves [] is "nothing", not "everything"', async () => {
      const res = await request(app.getHttpServer()).get('/groups').expect(200)
      expect(res.body.total).toBe(1)
      expect(res.body.items.map((g: { id: string }) => g.id)).toEqual([globalGroupId])
    })
  })

  // ---------------------------------------------------------------------
  // POST/DELETE /users/:id/roles — finding H-1 (docs/archive/audits/audit-authz.md).
  //
  // Every OTHER describe block in this file pins the scope-narrowing
  // property for a resource's own GET routes. This file had NO
  // role-assignment section at all before this fix — a real gap, not an
  // oversight noticed and skipped: `role-assignments.write.spec.ts` only
  // ever targets users INSIDE the acting super_admin's own scope, so
  // nothing anywhere in the original 554-test suite ever constructed a
  // target principal the actor could not reach. That is exactly the shape
  // every other block in this file exists to cover for every other
  // resource, and exactly the shape H-1 fell through. Fixtures below
  // reproduce the live audit finding verbatim: `acme` (containing
  // `acme.sales`) and a fully disjoint `otherco` root.
  //
  // Deliberately declared LAST in this file, and deliberately never calls
  // `resetTables` — see its own inline comment for why: every block ABOVE
  // this one either only exercises READ routes or seeds fixtures by calling
  // repositories directly, so `resetTables`'s `DELETE FROM users` between
  // their tests never conflicts with anything. THIS block makes real HTTP
  // writes through RoleAssignmentsController, so once the fix lands, its
  // positive-control test legitimately commits a real `audit_log` row —
  // and `audit_log` is append-only (no test, ever, in any file, deletes
  // from it), so any user it references can never be deleted again for the
  // rest of this process. Running last means no later block's
  // `resetTables` ever attempts that delete.
  // ---------------------------------------------------------------------
  describe('POST/DELETE /users/:id/roles (role assignment)', () => {
    let app: INestApplication
    let currentUsername = ''

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [RoleAssignmentsController],
        providers: [
          { provide: DB_CLIENT, useFactory: () => ctx.db },
          RoleAssignmentsRepository,
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

    // No `beforeEach`/`resetTables` — see the describe-level comment above.
    // Every fixture below is uniquely tagged (`nextTag()`) and rows
    // accumulate for the life of this block's own Testcontainer, the same
    // convention role-assignments.write.spec.ts uses for the identical
    // reason (see that file's own header comment).
    let fixtureSeq = 0
    function nextTag(): string {
      fixtureSeq += 1
      return `h1${fixtureSeq}`
    }

    async function totalAuditCount(): Promise<number> {
      const { rows } = await ctx.pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM audit_log',
      )
      return rows[0]?.count ?? 0
    }

    async function totalOutboxCount(): Promise<number> {
      const { rows } = await ctx.pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM outbox_events',
      )
      return rows[0]?.count ?? 0
    }

    async function makeActiveUser(role: string, orgUnitId: string) {
      const tag = nextTag()
      const users = new UsersRepository(ctx.db)
      const created = await users.create({
        primaryEmail: `${role}-${tag}@example.com`,
        username: `${role}-${tag}`,
        firstName: 'Test',
        lastName: 'User',
        orgUnitId,
      })
      return users.changeStatus(created.id, 'active')
    }

    /** `acme` (containing `acme.sales`) and a fully disjoint `otherco` root — the live audit reproduction's exact org shape. */
    async function makeDisjointOrgs(): Promise<{ salesId: string; othercoId: string }> {
      const orgUnits = new OrgUnitsRepository(ctx.db)
      const acme = await orgUnits.createRoot(`Acme ${nextTag()}`)
      const sales = await orgUnits.createChild(acme.id, `Sales ${nextTag()}`)
      const otherco = await orgUnits.createRoot(`OtherCo ${nextTag()}`)
      return { salesId: sales.id, othercoId: otherco.id }
    }

    // THE headline reproduction: pre-fix, this returned 201 — a Sales-scoped
    // super_admin granting itself-equivalent privilege to a principal it
    // cannot even read, in an org tree it has no relationship to at all.
    it('rejects granting a role to a victim outside the actor\'s scope, with 403 and writes no audit row or outbox event', async () => {
      const { salesId, othercoId } = await makeDisjointOrgs()
      const admin = await makeActiveUser('admin', salesId)
      const roles = new RoleAssignmentsRepository(ctx.db)
      await roles.assign({ userId: admin.id, roleKey: 'super_admin', scopeOrgUnitId: salesId })
      const victim = await makeActiveUser('victim', othercoId)
      currentUsername = admin.username

      const auditBefore = await totalAuditCount()
      const outboxBefore = await totalOutboxCount()

      const res = await request(app.getHttpServer())
        .post(`/users/${victim.id}/roles`)
        .send({ roleKey: 'super_admin', scopeOrgUnitId: salesId })
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await totalAuditCount()).toBe(auditBefore)
      expect(await totalOutboxCount()).toBe(outboxBefore)
    })

    // The revoke direction is symmetric per the audit report: a grant that
    // legitimately exists inside the victim's own tree (only a GLOBAL actor
    // could have made it) still cannot be stripped by the Sales-scoped actor.
    it('rejects revoking a victim\'s role from outside the actor\'s scope, with 403 and writes no NEW audit row or outbox event', async () => {
      const { salesId, othercoId } = await makeDisjointOrgs()
      const roles = new RoleAssignmentsRepository(ctx.db)

      // Bootstrap a GLOBAL actor purely to create the pre-existing grant —
      // this models "some other, legitimately global admin already granted
      // the victim a role," not a step the Sales-scoped admin performs.
      const bootstrap = await makeActiveUser('bootstrap', salesId)
      await roles.assign({ userId: bootstrap.id, roleKey: 'super_admin', scopeOrgUnitId: null })
      const admin = await makeActiveUser('admin', salesId)
      await roles.assign({ userId: admin.id, roleKey: 'super_admin', scopeOrgUnitId: salesId })
      const victim = await makeActiveUser('victim', othercoId)

      currentUsername = bootstrap.username
      const created = await request(app.getHttpServer())
        .post(`/users/${victim.id}/roles`)
        .send({ roleKey: 'read_only', scopeOrgUnitId: salesId })
        .expect(201)
      const assignmentId = created.body.id as string

      const auditBefore = await totalAuditCount()
      const outboxBefore = await totalOutboxCount()

      currentUsername = admin.username
      const res = await request(app.getHttpServer())
        .delete(`/users/${victim.id}/roles/${assignmentId}`)
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await totalAuditCount()).toBe(auditBefore)
      expect(await totalOutboxCount()).toBe(outboxBefore)
    })

    // Positive control, in the SAME fixture shape as the finding above: the
    // fix narrows WHO may be targeted, not the legitimate operation. The
    // Sales-scoped admin can still grant a role to a colleague who actually
    // lives in acme.sales.
    it('an in-scope role assignment still succeeds (201), proving the fix does not just break the feature', async () => {
      const { salesId } = await makeDisjointOrgs()
      const admin = await makeActiveUser('admin', salesId)
      const roles = new RoleAssignmentsRepository(ctx.db)
      await roles.assign({ userId: admin.id, roleKey: 'super_admin', scopeOrgUnitId: salesId })
      const colleague = await makeActiveUser('colleague', salesId)
      currentUsername = admin.username

      const res = await request(app.getHttpServer())
        .post(`/users/${colleague.id}/roles`)
        .send({ roleKey: 'help_desk', scopeOrgUnitId: salesId })
        .expect(201)
      expect(res.body.userId).toBe(colleague.id)

      await request(app.getHttpServer())
        .delete(`/users/${colleague.id}/roles/${res.body.id}`)
        .expect(200)
    })
  })
})
