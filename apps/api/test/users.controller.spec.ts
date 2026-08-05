import { type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { JwtGuard } from '../src/auth/jwt.guard'
import { DB_CLIENT } from '../src/common/db.token'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersController } from '../src/users/users.controller'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

describe('GET /users', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let orgUnitId: string

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        UsersRepository,
      ],
    })
      .overrideGuard(JwtGuard)
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
    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot('Acme Corp')).id
    const users = new UsersRepository(ctx.db)
    for (const username of ['ada', 'grace', 'alan']) {
      await users.create({
        primaryEmail: `${username}@example.com`,
        username,
        firstName: 'Test',
        lastName: 'User',
        orgUnitId,
      })
    }
  })

  it('returns a page with total, limit and offset', async () => {
    const res = await request(app.getHttpServer()).get('/users').expect(200)
    expect(res.body.total).toBe(3)
    expect(res.body.limit).toBe(50)
    expect(res.body.offset).toBe(0)
    expect(res.body.items).toHaveLength(3)
  })

  it('orders by username and honours limit/offset', async () => {
    const res = await request(app.getHttpServer())
      .get('/users?limit=2&offset=1')
      .expect(200)
    expect(res.body.items.map((u: { username: string }) => u.username)).toEqual([
      'alan',
      'grace',
    ])
  })

  it('filters by status', async () => {
    const res = await request(app.getHttpServer())
      .get('/users?status=pending')
      .expect(200)
    expect(res.body.total).toBe(3)
  })

  it('rejects an unknown status with 400 VALIDATION_FAILED', async () => {
    const res = await request(app.getHttpServer())
      .get('/users?status=nonsense')
      .expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('rejects a malformed limit with 400 rather than 500', async () => {
    const res = await request(app.getHttpServer()).get('/users?limit=lots').expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('never exposes a credential-shaped field', async () => {
    const res = await request(app.getHttpServer()).get('/users').expect(200)
    const serialized = JSON.stringify(res.body).toLowerCase()
    for (const forbidden of ['password', 'passwd', 'secret', 'hash', 'salt', 'token']) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('returns a single user by id', async () => {
    const list = await request(app.getHttpServer()).get('/users').expect(200)
    const id = list.body.items[0].id
    const res = await request(app.getHttpServer()).get(`/users/${id}`).expect(200)
    expect(res.body.id).toBe(id)
  })

  it('returns 404 NOT_FOUND for a missing user', async () => {
    const res = await request(app.getHttpServer())
      .get('/users/00000000-0000-0000-0000-000000000000')
      .expect(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })

  it('returns 400 for a non-uuid id rather than 500', async () => {
    const res = await request(app.getHttpServer()).get('/users/not-a-uuid').expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('exposes no write routes', async () => {
    await request(app.getHttpServer()).post('/users').send({ username: 'x' }).expect(404)
    await request(app.getHttpServer()).patch('/users/abc').send({}).expect(404)
    await request(app.getHttpServer()).delete('/users/abc').expect(404)
  })

  // Carried finding from Task 5's review: parsePageQuery had no upper bound
  // on `offset`. A preposterous offset like this one used to sail through
  // validation and hit Postgres as a raw bigint error — an unmapped 500, not
  // a clean domain-level 400. Now that pagination is wired to a real
  // endpoint, this proves the fix end-to-end through the actual HTTP stack.
  it('rejects a preposterously large offset with 400 VALIDATION_FAILED rather than crashing on Postgres', async () => {
    const res = await request(app.getHttpServer()).get('/users?offset=1e21').expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  describe('default deactivated-user exclusion', () => {
    it('omits a deactivated user from the default list and total', async () => {
      const repo = new UsersRepository(ctx.db)
      const toDeactivate = await repo.create({
        primaryEmail: 'gone@example.com',
        username: 'gone',
        firstName: 'Gone',
        lastName: 'User',
        orgUnitId,
      })
      await repo.changeStatus(toDeactivate.id, 'active')
      await repo.changeStatus(toDeactivate.id, 'deactivated')

      const res = await request(app.getHttpServer()).get('/users').expect(200)
      expect(res.body.total).toBe(3)
      expect(
        res.body.items.map((u: { username: string }) => u.username),
      ).not.toContain('gone')
    })

    it('returns deactivated users when status=deactivated is requested explicitly', async () => {
      const repo = new UsersRepository(ctx.db)
      const toDeactivate = await repo.create({
        primaryEmail: 'gone2@example.com',
        username: 'gone2',
        firstName: 'Gone',
        lastName: 'User',
        orgUnitId,
      })
      await repo.changeStatus(toDeactivate.id, 'active')
      await repo.changeStatus(toDeactivate.id, 'deactivated')

      const res = await request(app.getHttpServer())
        .get('/users?status=deactivated')
        .expect(200)
      expect(res.body.total).toBe(1)
      expect(res.body.items.map((u: { username: string }) => u.username)).toEqual(['gone2'])
    })
  })
})
