import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import { PrivilegeGuards } from '../src/authz/privilege.guards'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { HrSourcesController } from '../src/hr/hr-sources.controller'
import { HrSourcesRepository } from '../src/hr/hr-sources.repository'
import { HrSyncService } from '../src/hr/hr-sync.service'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

function stubJwtGuard(getUsername: () => string): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
        subject: 'kc-hr-sources-test',
        username: getUsername(),
        email: null,
      }
      return true
    },
  }
}

/**
 * The HR sources admin surface: CRUD-minus-delete, audit-per-mutation, and
 * the global-grant requirement on every mutating route. The sync pipeline
 * itself is covered by test/hr-sync.spec.ts; this file is about the HTTP
 * contract around the table.
 */
describe('HrSourcesController', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let currentUsername = ''
  let organizationId: string
  let orgUnitId: string
  let globalAdminUsername: string
  let scopedAdminUsername: string
  let auditorUsername: string

  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `hrc${fixtureSeq}`
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HrSourcesController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        HrSourcesRepository,
        HrSyncService,
        UsersRepository,
        OrgUnitsRepository,
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

    const { rows } = await ctx.pool.query<{ id: string }>('SELECT id FROM organizations WHERE is_master')
    organizationId = rows[0].id

    const orgUnits = new OrgUnitsRepository(ctx.db)
    const usersRepo = new UsersRepository(ctx.db)
    const roles = new RoleAssignmentsRepository(ctx.db)
    const root = await orgUnits.createRoot('HR Sources Controller Root')
    orgUnitId = root.id

    async function activeUser(role: string): Promise<{ id: string; username: string }> {
      const tag = nextTag()
      const user = await usersRepo.create({
        primaryEmail: `${role}-${tag}@example.com`,
        username: `${role}-${tag}`,
        firstName: 'Test',
        lastName: 'User',
        orgUnitId: root.id,
      })
      await usersRepo.changeStatus(user.id, 'active')
      return { id: user.id, username: user.username }
    }

    const globalAdmin = await activeUser('global-admin')
    await roles.assign({ userId: globalAdmin.id, roleKey: 'super_admin' })
    globalAdminUsername = globalAdmin.username

    // A SCOPED super_admin — legitimate configuration, and exactly the
    // actor requireGlobalManageGrant exists to stop (the security-audit
    // finding recorded on ConnectorTargetsController).
    const scopedAdmin = await activeUser('scoped-admin')
    await roles.assign({ userId: scopedAdmin.id, roleKey: 'super_admin', scopeOrgUnitId: root.id })
    scopedAdminUsername = scopedAdmin.username

    const auditor = await activeUser('auditor')
    await roles.assign({ userId: auditor.id, roleKey: 'auditor' })
    auditorUsername = auditor.username
  })

  afterAll(async () => {
    await app?.close()
  })

  function sourceBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      organizationId,
      name: `Feed ${nextTag()}`,
      kind: 'csv_url',
      url: 'https://hr.example.test/export.csv',
      auth: { headerName: 'Authorization', secretName: 'CONNECTOR_HR_TEST' },
      columnMapping: { EMP_ID: 'employeeId' },
      ...overrides,
    }
  }

  it('creates a source (201) and writes exactly one hr_source:create audit row in the same transaction', async () => {
    currentUsername = globalAdminUsername
    const body = sourceBody()

    const res = await request(app.getHttpServer()).post('/hr-sources').send(body).expect(201)

    expect(res.body.name).toBe(body.name)
    expect(res.body.enabled).toBe(false)
    expect(res.body.kind).toBe('csv_url')
    expect(res.body.authSecretName).toBe('CONNECTOR_HR_TEST')
    expect(res.body.blastRadiusThreshold).toBe(20)
    expect(res.body.blastRadiusFloor).toBe(5)
    expect(res.body.lastRunOutcome).toBeNull()

    const { rows } = await ctx.pool.query<{ action: string; before: unknown; after: { name?: string } }>(
      "SELECT action, before, after FROM audit_log WHERE resource_type = 'hr_source' AND resource_id = $1",
      [res.body.id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('hr_source:create')
    expect(rows[0].before).toBeNull()
    expect(rows[0].after.name).toBe(body.name)
  })

  it('rejects a non-https url and a non-CONNECTOR_* secret name (400)', async () => {
    currentUsername = globalAdminUsername
    await request(app.getHttpServer())
      .post('/hr-sources')
      .send(sourceBody({ url: 'http://hr.example.test/export.csv' }))
      .expect(400)

    const res = await request(app.getHttpServer())
      .post('/hr-sources')
      .send(sourceBody({ auth: { headerName: 'Authorization', secretName: 'DATABASE_URL' } }))
      .expect(400)
    expect(JSON.stringify(res.body)).toContain('CONNECTOR_')
  })

  it('rejects an unknown body field — Zod .strict()', async () => {
    currentUsername = globalAdminUsername
    await request(app.getHttpServer())
      .post('/hr-sources')
      .send(sourceBody({ surprise: true }))
      .expect(400)
  })

  it('duplicate name within the organization is a 409', async () => {
    currentUsername = globalAdminUsername
    const body = sourceBody()
    await request(app.getHttpServer()).post('/hr-sources').send(body).expect(201)
    await request(app.getHttpServer()).post('/hr-sources').send(body).expect(409)
  })

  it('updates a source with a before/after hr_source:update audit row; enabled toggles instead of delete', async () => {
    currentUsername = globalAdminUsername
    const created = await request(app.getHttpServer())
      .post('/hr-sources')
      .send(sourceBody({ enabled: true }))
      .expect(201)

    const res = await request(app.getHttpServer())
      .patch(`/hr-sources/${created.body.id}`)
      .send({ enabled: false, blastRadiusThreshold: 40 })
      .expect(200)
    expect(res.body.enabled).toBe(false)
    expect(res.body.blastRadiusThreshold).toBe(40)

    const { rows } = await ctx.pool.query<{
      action: string
      before: { enabled?: boolean }
      after: { enabled?: boolean }
    }>(
      "SELECT action, before, after FROM audit_log WHERE resource_type = 'hr_source' AND resource_id = $1 AND action = 'hr_source:update'",
      [created.body.id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].before.enabled).toBe(true)
    expect(rows[0].after.enabled).toBe(false)
  })

  it('has NO delete route', async () => {
    currentUsername = globalAdminUsername
    const created = await request(app.getHttpServer()).post('/hr-sources').send(sourceBody()).expect(201)
    await request(app.getHttpServer()).delete(`/hr-sources/${created.body.id}`).expect(404)
    // Still there.
    await request(app.getHttpServer()).get(`/hr-sources/${created.body.id}`).expect(200)
  })

  it('a SCOPED connector:manage grant cannot mutate — global grant required (403)', async () => {
    currentUsername = globalAdminUsername
    const created = await request(app.getHttpServer()).post('/hr-sources').send(sourceBody()).expect(201)

    currentUsername = scopedAdminUsername
    await request(app.getHttpServer()).post('/hr-sources').send(sourceBody()).expect(403)
    await request(app.getHttpServer())
      .patch(`/hr-sources/${created.body.id}`)
      .send({ enabled: true })
      .expect(403)
    await request(app.getHttpServer()).post(`/hr-sources/${created.body.id}/preview`).send({}).expect(403)
  })

  /**
   * `HrSyncService.run` has taken a `commit` flag since it was written, and
   * before this route existed NOTHING in src/ ever passed it `true`: the
   * commit half of the pipeline was built, service-tested, and reachable from
   * nowhere. An operator could dry-run a feed for ever and never land a row.
   */
  describe('POST /hr-sources/:id/commit', () => {
    it('refuses to commit a DISABLED source, naming the flag, and still previews it', async () => {
      currentUsername = globalAdminUsername
      const created = await request(app.getHttpServer())
        .post('/hr-sources')
        .send(sourceBody())
        .expect(201)
      expect(created.body.enabled).toBe(false)

      const res = await request(app.getHttpServer())
        .post(`/hr-sources/${created.body.id}/commit`)
        .send({})
        .expect(400)
      expect(String(res.body.message ?? res.body.details)).toMatch(/disabled/i)

      // The gate is on COMMITTING, not on looking: a disabled source previews
      // freely, which is how an operator gets it right before enabling it.
      // (Whatever the feed itself does, the request is not refused for being
      // a preview of a disabled source.)
      const preview = await request(app.getHttpServer())
        .post(`/hr-sources/${created.body.id}/preview`)
        .send({})
      expect(preview.status).not.toBe(400)
    })

    it('is refused for a SCOPED connector:manage grant, exactly like preview', async () => {
      currentUsername = globalAdminUsername
      const created = await request(app.getHttpServer())
        .post('/hr-sources')
        .send(sourceBody())
        .expect(201)

      currentUsername = scopedAdminUsername
      await request(app.getHttpServer())
        .post(`/hr-sources/${created.body.id}/commit`)
        .send({})
        .expect(403)
    })

    it('is refused for an auditor, who may read runs but not cause one', async () => {
      currentUsername = globalAdminUsername
      const created = await request(app.getHttpServer())
        .post('/hr-sources')
        .send(sourceBody())
        .expect(201)

      currentUsername = auditorUsername
      await request(app.getHttpServer())
        .post(`/hr-sources/${created.body.id}/commit`)
        .send({})
        .expect(403)
    })

    it('404s for a source that does not exist', async () => {
      currentUsername = globalAdminUsername
      await request(app.getHttpServer())
        .post('/hr-sources/00000000-0000-0000-0000-000000000000/commit')
        .send({})
        .expect(404)
    })
  })

  it('an auditor (connector:read) can list and read runs, but not mutate', async () => {
    currentUsername = globalAdminUsername
    const created = await request(app.getHttpServer()).post('/hr-sources').send(sourceBody()).expect(201)

    currentUsername = auditorUsername
    const list = await request(app.getHttpServer()).get('/hr-sources').expect(200)
    expect(list.body.some((row: { id: string }) => row.id === created.body.id)).toBe(true)

    const runs = await request(app.getHttpServer()).get(`/hr-sources/${created.body.id}/runs`).expect(200)
    expect(runs.body).toEqual([])

    await request(app.getHttpServer()).post('/hr-sources').send(sourceBody()).expect(403)
    await request(app.getHttpServer())
      .patch(`/hr-sources/${created.body.id}`)
      .send({ enabled: true })
      .expect(403)
  })

  it('unknown organization is a named 400, not a raw FK 500', async () => {
    currentUsername = globalAdminUsername
    const res = await request(app.getHttpServer())
      .post('/hr-sources')
      .send(sourceBody({ organizationId: '00000000-0000-4000-8000-000000000000' }))
      .expect(400)
    expect(JSON.stringify(res.body)).toContain('organization not found')
  })
})
