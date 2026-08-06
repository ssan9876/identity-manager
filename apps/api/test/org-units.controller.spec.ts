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
import { OrgUnitsController } from '../src/org-units/org-units.controller'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { withTestDatabase } from './support/pg'

// This suite tests OrgUnitsController in isolation from the real auth stack
// — PermissionGuard is stubbed out below, same as before Milestone 3b. The
// difference is that the controller now depends on `request.actor` (set by
// the real guard in production) to narrow its results, so the stub must set
// one too. It attaches a GLOBAL assignment (scopeOrgUnitId: null) so
// scopePathsFor/canIn resolve unrestricted, matching this suite's original
// "sees everything" behaviour — scoped-actor narrowing itself is covered by
// test/scope-narrowing.spec.ts, not here.
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

describe('GET /org-units', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let rootId: string
  let salesId: string

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrgUnitsController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        OrgUnitsRepository,
        PermissionEngine,
        // Milestone 3b, Task 3: OrgUnitsController's write handler now also
        // depends on AuditWriter (to audit each mutation inside its
        // transaction) — required here purely for DI resolution, since this
        // suite only exercises the (unchanged) read routes.
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

  beforeEach(async () => {
    // DELETE, not TRUNCATE ... CASCADE: TRUNCATE on `users` always
    // structurally cascades into audit_log via its actor_user_id foreign
    // key, and audit_log's append-only trigger unconditionally rejects that.
    // DELETE respects each table's own onDelete action instead (audit_log is
    // 'restrict' and unreferenced here, so it's never touched).
    await ctx.pool.query('DELETE FROM users')
    await ctx.pool.query('DELETE FROM org_units')
    const repo = new OrgUnitsRepository(ctx.db)
    const root = await repo.createRoot('Acme Corp')
    rootId = root.id
    salesId = (await repo.createChild(root.id, 'Sales')).id
    await repo.createChild(salesId, 'EMEA')
  })

  it('lists org units as a page ordered by path', async () => {
    const res = await request(app.getHttpServer()).get('/org-units').expect(200)
    expect(res.body.total).toBe(3)
    expect(res.body.items.map((u: { path: string }) => u.path)).toEqual([
      'acme_corp',
      'acme_corp.sales',
      'acme_corp.sales.emea',
    ])
  })

  it('returns one org unit by id', async () => {
    const res = await request(app.getHttpServer()).get(`/org-units/${salesId}`).expect(200)
    expect(res.body.path).toBe('acme_corp.sales')
  })

  it('returns the subtree including its root', async () => {
    const res = await request(app.getHttpServer())
      .get(`/org-units/${salesId}/subtree`)
      .expect(200)
    expect(res.body.map((u: { path: string }) => u.path).sort()).toEqual([
      'acme_corp.sales',
      'acme_corp.sales.emea',
    ])
  })

  it('returns 404 for a missing org unit', async () => {
    const res = await request(app.getHttpServer())
      .get('/org-units/00000000-0000-0000-0000-000000000000')
      .expect(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })

  // Milestone 3b, Task 3 added POST /org-units — see
  // test/org-units.write.spec.ts for its full behavior (permission/scope/
  // audit/error-mapping checks). This pin narrows to what remains
  // permanently true: there is no route to delete an org unit.
  it('exposes no delete route', async () => {
    await request(app.getHttpServer()).delete(`/org-units/${rootId}`).expect(404)
  })
})
