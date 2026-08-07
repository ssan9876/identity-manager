import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditController } from '../src/audit/audit.controller'
import { AuditRepository } from '../src/audit/audit.repository'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersRepository, type User } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

function stubJwtGuard(getUsername: () => string): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
        subject: 'audit-controller-test',
        username: getUsername(),
        email: null,
      }
      return true
    },
  }
}

/**
 * `GET /audit` — Milestone 8, Task 5. The `auditor` role (authz/actions.ts)
 * has existed since Milestone 2 with nothing behind `audit:read` to read;
 * `AuditRepository` has existed since Milestone 5 as `AuditWriter`'s
 * read-side sibling, but no controller ever exposed it over HTTP. This is
 * that controller — same gating pattern as `GET /outbox/dead-letters`
 * (outbox.controller.spec.ts), which this file mirrors structurally.
 */
describe('AuditController (Milestone 8, Task 5)', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let currentUsername = ''
  let orgUnitId: string

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        AuditRepository,
        AuditWriter,
        PermissionEngine,
        PermissionGuard,
        RoleAssignmentsRepository,
        Reflector,
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue(stubJwtGuard(() => currentUsername))
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()

    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`Audit Controller Root ${Date.now()}`)).id
  })

  afterAll(async () => {
    await app?.close()
  })

  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `ac${fixtureSeq}`
  }

  const usersRepo = () => new UsersRepository(ctx.db)
  const rolesRepo = () => new RoleAssignmentsRepository(ctx.db)
  const auditWriter = new AuditWriter()

  async function makeActiveUser(role: string): Promise<User> {
    const tag = nextTag()
    const created = await usersRepo().create({
      primaryEmail: `${role}-${tag}@example.com`,
      username: `${role}-${tag}`,
      firstName: 'Test',
      lastName: 'User',
      orgUnitId,
    })
    return usersRepo().changeStatus(created.id, 'active')
  }

  async function asAuditor(): Promise<User> {
    const auditor = await makeActiveUser('auditor')
    await rolesRepo().assign({ userId: auditor.id, roleKey: 'auditor', scopeOrgUnitId: null })
    currentUsername = auditor.username
    return auditor
  }

  async function recordRow(input: {
    actorUserId: string | null
    action: string
    resourceType: string
    resourceId: string | null
    batchId?: string
  }): Promise<void> {
    await ctx.db.transaction(async (tx) => {
      await auditWriter.record(tx, {
        actorUserId: input.actorUserId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        before: { was: 'old' },
        after: { now: 'new' },
        batchId: input.batchId ?? null,
      })
    })
  }

  it('an actor holding auditor (audit:read) sees rows, actor username/displayName resolved via the join', async () => {
    const auditor = await asAuditor()
    const marker = `ac:list:${Date.now()}`
    await recordRow({ actorUserId: auditor.id, action: marker, resourceType: 'user', resourceId: auditor.id })

    const res = await request(app.getHttpServer()).get(`/audit?action=${marker}`).expect(200)
    expect(res.body.items).toHaveLength(1)
    const row = res.body.items[0]
    expect(row.action).toBe(marker)
    expect(row.actorUsername).toBe(auditor.username)
    expect(row.actorDisplayName).toBe(auditor.displayName)
    expect(row.before).toEqual({ was: 'old' })
    expect(row.after).toEqual({ now: 'new' })
  })

  it('filters by actor — a case-insensitive substring on username/displayName', async () => {
    const auditor = await asAuditor()
    const other = await makeActiveUser('unrelated')
    const marker = `ac:actor:${Date.now()}`
    await recordRow({ actorUserId: auditor.id, action: marker, resourceType: 'user', resourceId: auditor.id })
    await recordRow({ actorUserId: other.id, action: marker, resourceType: 'user', resourceId: other.id })

    const res = await request(app.getHttpServer())
      .get(`/audit?action=${marker}&actor=${encodeURIComponent(auditor.username.toUpperCase())}`)
      .expect(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].actorUserId).toBe(auditor.id)
  })

  it('filters by resourceType and resourceId together', async () => {
    const auditor = await asAuditor()
    const marker = `ac:resource:${Date.now()}`
    await recordRow({ actorUserId: auditor.id, action: marker, resourceType: 'group', resourceId: auditor.id })
    await recordRow({ actorUserId: auditor.id, action: marker, resourceType: 'org_unit', resourceId: auditor.id })

    const res = await request(app.getHttpServer())
      .get(`/audit?action=${marker}&resourceType=group&resourceId=${auditor.id}`)
      .expect(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].resourceType).toBe('group')
  })

  it('filters by batchId — an import commit reviewed as one unit', async () => {
    const auditor = await asAuditor()
    const batchId = '11111111-1111-4111-8111-111111111111'
    const marker = `ac:batch:${Date.now()}`
    await recordRow({
      actorUserId: auditor.id,
      action: marker,
      resourceType: 'user',
      resourceId: auditor.id,
      batchId,
    })
    await recordRow({ actorUserId: auditor.id, action: marker, resourceType: 'user', resourceId: auditor.id })

    const res = await request(app.getHttpServer()).get(`/audit?action=${marker}&batchId=${batchId}`).expect(200)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].batchId).toBe(batchId)
  })

  it('a from/to date range excludes rows outside it and includes rows inside it', async () => {
    const auditor = await asAuditor()
    const marker = `ac:date:${Date.now()}`
    await recordRow({ actorUserId: auditor.id, action: marker, resourceType: 'user', resourceId: auditor.id })

    const withinRange = await request(app.getHttpServer())
      .get(`/audit?action=${marker}&from=2020-01-01&to=2099-12-31`)
      .expect(200)
    expect(withinRange.body.items).toHaveLength(1)

    const outsideRange = await request(app.getHttpServer())
      .get(`/audit?action=${marker}&to=2020-01-01`)
      .expect(200)
    expect(outsideRange.body.items).toHaveLength(0)
  })

  it('rejects a malformed resourceId with a 400 naming the field, never an unmapped 500', async () => {
    await asAuditor()
    const res = await request(app.getHttpServer()).get('/audit?resourceId=not-a-uuid').expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
    expect(res.body.issues.join(' ')).toContain('resourceId')
  })

  it('rejects a malformed date with a 400 naming the field', async () => {
    await asAuditor()
    const res = await request(app.getHttpServer()).get('/audit?from=not-a-date').expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
    expect(res.body.issues.join(' ')).toContain('from')
  })

  it('total/limit/offset reflect the FILTERED count, not the whole table', async () => {
    const auditor = await asAuditor()
    const marker = `ac:page:${Date.now()}`
    for (let i = 0; i < 3; i++) {
      await recordRow({ actorUserId: auditor.id, action: marker, resourceType: 'user', resourceId: auditor.id })
    }

    const res = await request(app.getHttpServer()).get(`/audit?action=${marker}&limit=2&offset=0`).expect(200)
    expect(res.body.items).toHaveLength(2)
    expect(res.body.total).toBe(3)
    expect(res.body.limit).toBe(2)
    expect(res.body.offset).toBe(0)
  })

  it('an actor without audit:read (read_only) is rejected with 403, never sees the audit log', async () => {
    const viewer = await makeActiveUser('readonly')
    await rolesRepo().assign({ userId: viewer.id, roleKey: 'read_only', scopeOrgUnitId: null })
    currentUsername = viewer.username

    const res = await request(app.getHttpServer()).get('/audit').expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  it('an actor holding no role at all is rejected with 403', async () => {
    const bare = await makeActiveUser('bare')
    currentUsername = bare.username

    await request(app.getHttpServer()).get('/audit').expect(403)
  })
})
