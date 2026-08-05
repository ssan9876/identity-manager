import { type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { JwtGuard } from '../src/auth/jwt.guard'
import { PermissionGuard } from '../src/authz/permission.guard'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { OrgUnitsController } from '../src/org-units/org-units.controller'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { withTestDatabase } from './support/pg'

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
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
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

  it('exposes no write routes', async () => {
    await request(app.getHttpServer()).post('/org-units').send({ name: 'x' }).expect(404)
    await request(app.getHttpServer()).delete(`/org-units/${rootId}`).expect(404)
  })
})
