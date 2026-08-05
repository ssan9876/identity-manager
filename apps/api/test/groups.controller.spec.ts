import { type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { JwtGuard } from '../src/auth/jwt.guard'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { GroupsController } from '../src/groups/groups.controller'
import { GroupsRepository } from '../src/groups/groups.repository'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

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
      providers: [{ provide: DB_CLIENT, useFactory: () => ctx.db }, GroupsRepository],
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
    await ctx.pool.query(
      'TRUNCATE TABLE group_user_members, group_group_members, groups, users, org_units CASCADE',
    )
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

  it('exposes no write routes', async () => {
    await request(app.getHttpServer()).post('/groups').send({ name: 'x' }).expect(404)
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
