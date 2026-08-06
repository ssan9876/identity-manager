import { Controller, Get, type ExecutionContext, type INestApplication, UseGuards } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Reflector } from '@nestjs/core'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import { RequirePermission } from '../src/authz/require-permission.decorator'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { JwtGuard } from '../src/auth/jwt.guard'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { ForbiddenError } from '../src/common/errors'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

@Controller('probe')
@UseGuards(JwtGuard, PermissionGuard)
class ProbeController {
  @Get('readable')
  @RequirePermission('user:read')
  readable(): { ok: true } {
    return { ok: true }
  }

  @Get('auditable')
  @RequirePermission('audit:read')
  auditable(): { ok: true } {
    return { ok: true }
  }

  @Get('undeclared')
  undeclared(): { ok: true } {
    return { ok: true }
  }
}

describe('PermissionGuard', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let currentUsername = 'ada'

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        PermissionEngine,
        PermissionGuard,
        Reflector,
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({
        canActivate: (context: { switchToHttp: () => { getRequest: () => Record<string, unknown> } }) => {
          context.switchToHttp().getRequest().principal = {
            subject: 'kc-1',
            username: currentUsername,
            email: null,
          }
          return true
        },
      })
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
  })

  beforeEach(async () => {
    // DELETE, not TRUNCATE ... CASCADE: TRUNCATE on `users` always
    // structurally cascades into audit_log via its actor_user_id foreign
    // key, and audit_log's append-only trigger unconditionally rejects that.
    // DELETE respects each table's own onDelete action instead:
    // role_assignments cascades from users/org_units, audit_log
    // ('restrict', unreferenced here) is never touched.
    await ctx.pool.query('DELETE FROM users')
    await ctx.pool.query('DELETE FROM org_units')
    currentUsername = 'ada'
    const orgUnits = new OrgUnitsRepository(ctx.db)
    const users = new UsersRepository(ctx.db)
    const root = await orgUnits.createRoot('Acme Corp')
    const ada = await users.create({
      primaryEmail: 'ada@example.com',
      username: 'ada',
      firstName: 'Ada',
      lastName: 'Lovelace',
      orgUnitId: root.id,
    })
    // resolveActor requires status === 'active'; UsersRepository.create()
    // defaults new users to 'pending'. Without this, every request would be
    // denied regardless of role — including the "allowed" cases below — for
    // the wrong reason (an inactive actor), masking what this suite actually
    // tests. See permission.engine.ts's resolveActor doc comment.
    await users.changeStatus(ada.id, 'active')
  })

  const grant = async (
    roleKey: 'read_only' | 'auditor' | 'help_desk',
    scopeOrgUnitId?: string | null,
  ) => {
    const users = new UsersRepository(ctx.db)
    const user = await users.findByEmail('ada@example.com')
    return new RoleAssignmentsRepository(ctx.db).assign({
      userId: user!.id,
      roleKey,
      scopeOrgUnitId,
    })
  }

  it('denies a route when the actor lacks the permission', async () => {
    const res = await request(app.getHttpServer()).get('/probe/readable').expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  it('allows a route when the actor holds the permission', async () => {
    await grant('read_only')
    await request(app.getHttpServer()).get('/probe/readable').expect(200)
  })

  it('still denies a different permission the role does not grant', async () => {
    await grant('read_only')
    const res = await request(app.getHttpServer()).get('/probe/auditable').expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  it('allows the auditor role its own permission', async () => {
    await grant('auditor')
    await request(app.getHttpServer()).get('/probe/auditable').expect(200)
  })

  it('DENIES a route that declares no permission — fail closed', async () => {
    await grant('read_only')
    const res = await request(app.getHttpServer()).get('/probe/undeclared').expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  it('denies a principal that maps to no local user', async () => {
    currentUsername = 'ghost'
    const res = await request(app.getHttpServer()).get('/probe/readable').expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  it('reflects a revoked role on the very next request', async () => {
    await grant('read_only')
    await request(app.getHttpServer()).get('/probe/readable').expect(200)

    await ctx.pool.query('DELETE FROM role_assignments')
    await request(app.getHttpServer()).get('/probe/readable').expect(403)
  })

  // MILESTONE 3b GATE (pair). The final M3a whole-branch review found that
  // PermissionGuard checks route entry only, so a SCOPED actor's request is
  // never narrowed against any particular resource — that is what
  // assertCanAnywhere in permission.guard.ts actually does today, no matter
  // how the comment there used to read. The two tests below pin that gap in
  // executable form: together they say "the engine knows, the HTTP layer
  // never asks." See each test's own comment for what it proves and what is
  // supposed to happen to it once Milestone 3b wires per-resource narrowing
  // in — do not "fix" either test by weakening it when that day comes.
  it('MILESTONE 3b GATE: a scoped actor reaches a route their role permits, with no per-resource check at all', async () => {
    const orgUnits = new OrgUnitsRepository(ctx.db)
    const users = new UsersRepository(ctx.db)
    const ada = await users.findByEmail('ada@example.com')
    const sales = await orgUnits.createChild(ada!.orgUnitId, 'Sales')

    // A SCOPED assignment, not global — confirm the row this test actually
    // exercises before trusting the request below.
    const assignment = await grant('help_desk', sales.id)
    expect(assignment.scopeOrgUnitId).toBe(sales.id)
    expect(assignment.scopeOrgUnitId).not.toBeNull()

    // MILESTONE 3b GATE. This passes TODAY only because PermissionGuard's
    // check is assertCanAnywhere — "does this actor hold user:read
    // anywhere?" — with no resource here to narrow against at all, exactly
    // like the real UsersController routes (see permission.guard.ts). It
    // would pass identically no matter which org unit ada were scoped to,
    // or whether an out-of-scope org unit (e.g. Engineering — see the next
    // test) existed, because nothing on this path ever looks. Once
    // Milestone 3b wires per-resource narrowing in, this unqualified pass
    // is expected to stop happening — this assertion should start FAILING
    // then, and that failure is the correct signal 3b landed, not a
    // regression to "fix" by loosening the test.
    await request(app.getHttpServer()).get('/probe/readable').expect(200)
  })

  it('MILESTONE 3b GATE: the engine, asked directly about a resource outside that scope via canIn, already says no', async () => {
    const orgUnits = new OrgUnitsRepository(ctx.db)
    const users = new UsersRepository(ctx.db)
    const ada = await users.findByEmail('ada@example.com')
    const sales = await orgUnits.createChild(ada!.orgUnitId, 'Sales')
    const engineering = await orgUnits.createChild(ada!.orgUnitId, 'Engineering')

    // Same shape of assignment as the previous test: SCOPED, not global.
    const assignment = await grant('help_desk', sales.id)
    expect(assignment.scopeOrgUnitId).toBe(sales.id)
    expect(assignment.scopeOrgUnitId).not.toBeNull()

    // MILESTONE 3b GATE, the other half of the pair above.
    // PermissionEngine.canIn is correct today and has been since Task 3 — it
    // simply has no production caller yet (see permission.guard.ts: zero
    // call sites). This is the information Milestone 3b needs in order to
    // close the previous test's gap; its job is to start CALLING canIn from
    // the read (and write) paths, not to change what canIn itself returns.
    // This assertion should remain true, unchanged, after 3b lands — if it
    // ever needs to change, something more fundamental broke.
    const engine = new PermissionEngine(ctx.db)
    const actor = await engine.resolveActor({ subject: 'kc-1', username: 'ada', email: null })
    const allowed = await engine.canIn(actor, 'user:read', engineering.id)
    expect(allowed).toBe(false)
  })

  // Guard-order defense: PermissionGuard reads request.principal, which only
  // exists because JwtGuard ran first and set it. Nothing enforces that
  // order except every controller happening to declare `@UseGuards(JwtGuard,
  // PermissionGuard)` in that sequence — reversing it (or a controller that
  // wires PermissionGuard without JwtGuard at all) leaves request.principal
  // undefined. Exercised directly against the guard, bypassing the app/HTTP
  // stack entirely, so this is unaffected by every real controller's guard
  // order happening to be correct today.
  it('throws ForbiddenError, not a crash, when request.principal is missing (guard-order defense)', async () => {
    const guard = new PermissionGuard(new PermissionEngine(ctx.db), new Reflector())
    const fakeContext = {
      getHandler: () => ProbeController.prototype.readable,
      switchToHttp: () => ({ getRequest: () => ({}) }),
    } as unknown as ExecutionContext

    await expect(guard.canActivate(fakeContext)).rejects.toBeInstanceOf(ForbiddenError)
  })
})
