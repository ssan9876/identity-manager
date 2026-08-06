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
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { GroupsController } from '../src/groups/groups.controller'
import { GroupsRepository } from '../src/groups/groups.repository'
import { OrgUnitsController } from '../src/org-units/org-units.controller'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersController } from '../src/users/users.controller'
import { UsersRepository } from '../src/users/users.repository'
import { type TestDatabase, withTestDatabase } from './support/pg'

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
          { provide: DB_CLIENT, useFactory: () => ctx.db },
          UsersRepository,
          PermissionEngine,
          PermissionGuard,
          // Milestone 3b, Task 2: UsersController's write handlers also
          // depend on PrivilegeGuards and AuditWriter now — required here
          // purely for DI resolution; this describe block only exercises
          // the (unchanged) read routes.
          PrivilegeGuards,
          AuditWriter,
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
          { provide: DB_CLIENT, useFactory: () => ctx.db },
          UsersRepository,
          OrgUnitsRepository,
          GroupsRepository,
          PermissionEngine,
          // Milestone 3b, Task 2: UsersController's write handlers also
          // depend on PrivilegeGuards and AuditWriter now — required here
          // purely for DI resolution; this describe block only exercises
          // the (unchanged) read routes.
          PrivilegeGuards,
          AuditWriter,
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
})
