import {
  Controller,
  Get,
  Inject,
  Param,
  Req,
  type ExecutionContext,
  type INestApplication,
  UseGuards,
} from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Reflector } from '@nestjs/core'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard, type AuthorizedRequest } from '../src/authz/permission.guard'
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
  constructor(@Inject(PermissionEngine) private readonly engine: PermissionEngine) {}

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

  // Milestone 3b: a minimal stand-in for what every real single-resource
  // read handler now does downstream of the guard (see
  // UsersController.findOne, OrgUnitsController.findOne, GroupsController's
  // requireGroup) — identify the target, then assertCanIn against it. The
  // guard above only gated ENTRY (assertCanAnywhere); this is the
  // per-resource narrowing decision, made in the handler, same as in every
  // real controller.
  @Get('resource/:orgUnitId')
  @RequirePermission('user:read')
  async resource(
    @Param('orgUnitId') orgUnitId: string,
    @Req() request: AuthorizedRequest,
  ): Promise<{ ok: true }> {
    await this.engine.assertCanIn(request.actor, 'user:read', orgUnitId)
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

  // MILESTONE 3b GATE (pair, historical). The final M3a whole-branch review
  // found that PermissionGuard checks route entry only, so a SCOPED actor's
  // request was never narrowed against any particular resource — that was
  // what assertCanAnywhere in permission.guard.ts actually did, no matter
  // how the comment there used to read. The two tests below pinned that gap
  // in executable form: together they said "the engine knows, the HTTP layer
  // never asks." Milestone 3b closed the gap by wiring `scopePathsFor` and
  // `assertCanIn` into every controller (users.controller.ts,
  // org-units.controller.ts, groups.controller.ts) — it did NOT change this
  // guard, which still only gates entry (see its updated comment). Both
  // tests are kept, not deleted, as the before/after record. Only the first
  // one's assertion changes: it was the only one of the pair exercising a
  // route with an actual per-resource check, and that route now denies.
  it('MILESTONE 3b GATE, CLOSED: bare route entry is still unnarrowed (unchanged) — but a per-resource check downstream now denies the out-of-scope target', async () => {
    const orgUnits = new OrgUnitsRepository(ctx.db)
    const users = new UsersRepository(ctx.db)
    const ada = await users.findByEmail('ada@example.com')
    const sales = await orgUnits.createChild(ada!.orgUnitId, 'Sales')
    const engineering = await orgUnits.createChild(ada!.orgUnitId, 'Engineering')

    // A SCOPED assignment, not global — confirm the row this test actually
    // exercises before trusting the requests below.
    const assignment = await grant('help_desk', sales.id)
    expect(assignment.scopeOrgUnitId).toBe(sales.id)
    expect(assignment.scopeOrgUnitId).not.toBeNull()

    // UNCHANGED by Milestone 3b, correctly so: PermissionGuard's own check
    // is still exactly assertCanAnywhere — "does this actor hold user:read
    // anywhere?" — and /probe/readable has no resource in its URL to narrow
    // against at all. This route is analogous to a LIST route (e.g. GET
    // /users): entry succeeds regardless of scope, and narrowing happens
    // downstream, in the handler, only where there is something to narrow
    // against. Per-resource narrowing living in controllers rather than the
    // guard is a deliberate design choice, not a gap — see
    // permission.guard.ts's updated comment.
    await request(app.getHttpServer()).get('/probe/readable').expect(200)

    // THIS is what actually changed. /probe/resource/:orgUnitId mirrors what
    // every real single-resource read handler now does downstream of the
    // guard: identify the target, then assertCanIn against it (see
    // ProbeController.resource above, and UsersController.findOne /
    // OrgUnitsController.findOne / GroupsController's requireGroup for the
    // real thing). Ada, scoped only to Sales, is now denied a target outside
    // it (Engineering) and allowed a target inside it (Sales) — the exact
    // per-resource decision the pre-3b HTTP layer never made.
    await request(app.getHttpServer())
      .get(`/probe/resource/${engineering.id}`)
      .expect(403)
    await request(app.getHttpServer())
      .get(`/probe/resource/${sales.id}`)
      .expect(200)
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
