import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard, type AuthorizedRequest } from '../src/authz/permission.guard'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { GroupsController } from '../src/groups/groups.controller'
import { GroupsRepository } from '../src/groups/groups.repository'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

// This suite tests GroupsController in isolation from the real auth stack —
// PermissionGuard is stubbed out below, same as before Milestone 3b. The
// difference is that the controller now depends on `request.actor` (set by
// the real guard in production) to narrow its results, so the stub must set
// one too. It attaches a GLOBAL assignment (scopeOrgUnitId: null) so
// scopePathsFor/canIn resolve unrestricted, matching this suite's original
// "sees everything" behaviour — scoped-actor narrowing itself (and the
// global-group visibility rule) is covered by test/scope-narrowing.spec.ts,
// not here.
const UNRESTRICTED_ACTOR: AuthorizedRequest['actor'] = {
  userId: '00000000-0000-0000-0000-0000000000a1',
  username: 'unrestricted-test-actor',
  orgUnitId: '00000000-0000-0000-0000-0000000000a1',
  assignments: [{ roleKey: 'super_admin', scopeOrgUnitId: null, scopePath: null }],
}

const stubPermissionGuard: CanActivate = {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthorizedRequest>()
    request.actor = UNRESTRICTED_ACTOR
    return true
  },
}

describe('GET /groups', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let allId: string
  let engId: string
  let adaId: string
  let orgUnitId: string

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [GroupsController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        GroupsRepository,
        PermissionEngine,
        // Milestone 3b, Task 3: GroupsController's write handlers now also
        // depend on AuditWriter (to audit each mutation inside its
        // transaction) — required here purely for DI resolution, since this
        // suite only exercises the (unchanged) read routes. Milestone 4,
        // Task 1 adds OutboxWriter alongside it for the same reason.
        AuditWriter,
        OutboxWriter,
        // Finding M-2/L-2 fix (docs/superpowers/audit-authz.md):
        // GroupsController now loads the target user for the ?userId= scope
        // check and for addMember's member-scope check — required here
        // purely for DI resolution; this suite's actor is UNRESTRICTED_ACTOR
        // (a global assignment), so those new checks never reject anything
        // this file already asserts on.
        UsersRepository,
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

  beforeEach(async () => {
    // Not TRUNCATE ... CASCADE: audit_log's append-only trigger fires
    // unconditionally (even on zero matching rows) for any statement that
    // would touch it, and TRUNCATE CASCADE on `users` always structurally
    // reaches audit_log via its actor_user_id foreign key. DELETE instead —
    // it respects each table's own onDelete action, so group_user_members,
    // group_group_members and role_assignments (if any) cascade away from
    // `groups`/`users`, and audit_log (onDelete: 'restrict', unreferenced
    // here) is never touched at all.
    await ctx.pool.query('DELETE FROM groups')
    await ctx.pool.query('DELETE FROM users')
    await ctx.pool.query('DELETE FROM org_units')
    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot('Acme Corp')).id
    const groups = new GroupsRepository(ctx.db)
    const users = new UsersRepository(ctx.db)

    allId = (await groups.create({ name: 'All Staff' })).id
    engId = (await groups.create({ name: 'Engineering' })).id
    await groups.addChildGroup(allId, engId)

    adaId = (
      await users.create({
        primaryEmail: 'ada@example.com',
        username: 'ada',
        firstName: 'Ada',
        lastName: 'Lovelace',
        orgUnitId,
      })
    ).id
    await groups.addUser(engId, adaId)
  })

  it('lists groups as a page ordered by name', async () => {
    const res = await request(app.getHttpServer()).get('/groups').expect(200)
    expect(res.body.total).toBe(2)
    expect(res.body.items.map((g: { name: string }) => g.name)).toEqual([
      'All Staff',
      'Engineering',
    ])
  })

  it('returns one group by id', async () => {
    const res = await request(app.getHttpServer()).get(`/groups/${engId}`).expect(200)
    expect(res.body.name).toBe('Engineering')
  })

  it('returns 404 for a missing group', async () => {
    const res = await request(app.getHttpServer())
      .get('/groups/00000000-0000-0000-0000-000000000000')
      .expect(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })

  it('returns direct members only', async () => {
    const res = await request(app.getHttpServer())
      .get(`/groups/${allId}/members`)
      .expect(200)
    expect(res.body.users).toEqual([])
    expect(res.body.groups).toEqual([engId])
  })

  it('returns effective members expanded through nesting', async () => {
    const res = await request(app.getHttpServer())
      .get(`/groups/${allId}/effective-members`)
      .expect(200)
    expect(res.body).toEqual([adaId])
  })

  it('distinguishes direct from effective membership', async () => {
    const direct = await request(app.getHttpServer())
      .get(`/groups/${allId}/members`)
      .expect(200)
    const effective = await request(app.getHttpServer())
      .get(`/groups/${allId}/effective-members`)
      .expect(200)
    expect(direct.body.users).toEqual([])
    expect(effective.body).toEqual([adaId])
  })

  // Milestone 3b, Task 3 added POST /groups, PATCH /groups/:id, and the
  // member/child-group mutation routes — see test/groups.write.spec.ts for
  // their full behavior (permission/scope/audit/cycle-guard checks). This
  // pin narrows to what remains permanently true: there is no route to
  // delete a whole GROUP (only individual members/child-groups can be
  // detached from one).
  it('exposes no route to delete a whole group', async () => {
    await request(app.getHttpServer()).delete(`/groups/${engId}`).expect(404)
  })

  describe('?userId= (effective membership filter)', () => {
    beforeEach(async () => {
      // An unrelated third group ada does NOT belong to. Its presence means
      // "ignore userId and return the full list" (the bug) and "filter to
      // ada's effective groups" (the fix) diverge on total/items in every
      // test below, so a coincidental pass against the unfiltered list is
      // impossible.
      await new GroupsRepository(ctx.db).create({ name: 'Marketing' })
    })

    it('for a user in a nested child group, returns the ancestor groups too (effective, not direct)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/groups?userId=${adaId}`)
        .expect(200)
      expect(res.body.total).toBe(2)
      expect(res.body.items.map((g: { name: string }) => g.name)).toEqual([
        'All Staff',
        'Engineering',
      ])
    })

    it('returns an empty page with total: 0 for a user in no groups', async () => {
      const lonely = await new UsersRepository(ctx.db).create({
        primaryEmail: 'lonely@example.com',
        username: 'lonely',
        firstName: 'Lonely',
        lastName: 'User',
        orgUnitId,
      })

      const res = await request(app.getHttpServer())
        .get(`/groups?userId=${lonely.id}`)
        .expect(200)
      expect(res.body).toEqual({ items: [], total: 0, limit: 50, offset: 0 })
    })

    it('returns an empty page, not the full list, for a well-formed userId that is not a user', async () => {
      const res = await request(app.getHttpServer())
        .get('/groups?userId=00000000-0000-0000-0000-000000000000')
        .expect(200)
      expect(res.body).toEqual({ items: [], total: 0, limit: 50, offset: 0 })
    })

    it('rejects a non-uuid userId with 400 VALIDATION_FAILED', async () => {
      const res = await request(app.getHttpServer())
        .get('/groups?userId=garbage')
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
    })

    it('composes with limit and offset', async () => {
      const page1 = await request(app.getHttpServer())
        .get(`/groups?userId=${adaId}&limit=1&offset=0`)
        .expect(200)
      expect(page1.body.total).toBe(2)
      expect(page1.body.items.map((g: { name: string }) => g.name)).toEqual(['All Staff'])

      const page2 = await request(app.getHttpServer())
        .get(`/groups?userId=${adaId}&limit=1&offset=1`)
        .expect(200)
      expect(page2.body.total).toBe(2)
      expect(page2.body.items.map((g: { name: string }) => g.name)).toEqual(['Engineering'])
    })
  })
})
