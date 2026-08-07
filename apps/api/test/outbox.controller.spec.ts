import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JwtGuard } from '../src/auth/jwt.guard'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { OrgUnitsRepository, type OrgUnit } from '../src/org-units/org-units.repository'
import { OutboxController } from '../src/outbox/outbox.controller'
import { OutboxRepository } from '../src/outbox/outbox.repository'
import { UsersRepository, type User } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

function stubJwtGuard(getUsername: () => string): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
        subject: 'outbox-controller-test',
        username: getUsername(),
        email: null,
      }
      return true
    },
  }
}

/**
 * Finding H3's second half (docs/superpowers/audit-integrity.md): "there is
 * no operator-facing view of dead letters at all." `GET /outbox/dead-letters`
 * is that view — gated behind `audit:read` (the `auditor` role), read-only,
 * reporting every `status = 'failed'` `outbox_events` row regardless of
 * whether it ever folds into any single user's derived `syncState`.
 */
describe('OutboxController (finding H3, docs/superpowers/audit-integrity.md)', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let currentUsername = ''
  let orgUnitId: string

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OutboxController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        OutboxRepository,
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

    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`Outbox Controller Root ${Date.now()}`)).id
  })

  afterAll(async () => {
    await app?.close()
  })

  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `oc${fixtureSeq}`
  }

  const usersRepo = () => new UsersRepository(ctx.db)
  const rolesRepo = () => new RoleAssignmentsRepository(ctx.db)

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

  async function insertOutboxEvent(
    aggregateType: 'user' | 'group' | 'membership',
    status: 'pending' | 'processing' | 'done' | 'failed',
    lastError: string | null = null,
    target: 'keycloak' | 'active_directory' | 'entra_id' | 'google_workspace' | null = null,
  ): Promise<number> {
    const { rows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, status, last_error, attempts, target)
       VALUES ($1, gen_random_uuid(), 'updated', '{}'::jsonb, $2, $3, 8, COALESCE($4, 'keycloak')::outbox_target)
       RETURNING id`,
      [aggregateType, status, lastError, target],
    )
    return Number(rows[0]!.id)
  }

  it('an actor holding auditor (audit:read) sees only status=failed rows, newest first', async () => {
    const auditor = await makeActiveUser('auditor')
    await rolesRepo().assign({ userId: auditor.id, roleKey: 'auditor', scopeOrgUnitId: null })
    currentUsername = auditor.username

    const pending = await insertOutboxEvent('user', 'pending')
    const done = await insertOutboxEvent('user', 'done')
    const processing = await insertOutboxEvent('user', 'processing')
    const failedOld = await insertOutboxEvent('group', 'failed', 'boom, attempt 1')
    const failedNew = await insertOutboxEvent('membership', 'failed', 'boom, attempt 2')

    const res = await request(app.getHttpServer()).get('/outbox/dead-letters?limit=100').expect(200)

    const ids: number[] = res.body.items.map((item: { id: number }) => item.id)
    expect(ids).toContain(failedOld)
    expect(ids).toContain(failedNew)
    // Newest first.
    expect(ids.indexOf(failedNew)).toBeLessThan(ids.indexOf(failedOld))
    // pending/done/processing never leak into a dead-letter view.
    expect(ids).not.toContain(pending)
    expect(ids).not.toContain(done)
    expect(ids).not.toContain(processing)

    const failedItem = res.body.items.find((item: { id: number }) => item.id === failedNew)
    expect(failedItem.aggregateType).toBe('membership')
    expect(failedItem.lastError).toBe('boom, attempt 2')
    expect(failedItem.attempts).toBe(8)
    expect(failedItem.target).toBe('keycloak')
  })

  // Milestone 10, Task 1: "/outbox/dead-letters gains a target dimension
  // without breaking its current response shape" — proven two ways: the
  // response still has exactly the same envelope (items/total/limit/offset,
  // asserted throughout this file's other tests, all still passing
  // unmodified) AND each item now names WHICH target failed, so an operator
  // (or Milestone 14's console) can tell a stalled Active Directory delivery
  // apart from a stalled Keycloak one at a glance.
  it('each dead letter names which target failed, not just which principal', async () => {
    const auditor = await makeActiveUser('auditor2')
    await rolesRepo().assign({ userId: auditor.id, roleKey: 'auditor', scopeOrgUnitId: null })
    currentUsername = auditor.username

    const adFailure = await insertOutboxEvent('user', 'failed', 'LDAP bind failed', 'active_directory')
    const kcFailure = await insertOutboxEvent('user', 'failed', 'Keycloak unreachable', 'keycloak')

    const res = await request(app.getHttpServer()).get('/outbox/dead-letters?limit=100').expect(200)

    const items: Array<{ id: number; target: string }> = res.body.items
    expect(items.find((item) => item.id === adFailure)?.target).toBe('active_directory')
    expect(items.find((item) => item.id === kcFailure)?.target).toBe('keycloak')
  })

  it('total/limit/offset reflect ONLY the failed count, not the whole outbox table', async () => {
    const auditor = await makeActiveUser('auditor')
    await rolesRepo().assign({ userId: auditor.id, roleKey: 'auditor', scopeOrgUnitId: null })
    currentUsername = auditor.username

    await insertOutboxEvent('user', 'pending')
    await insertOutboxEvent('user', 'done')
    for (let i = 0; i < 3; i++) {
      await insertOutboxEvent('user', 'failed', `err-${i}`)
    }

    const res = await request(app.getHttpServer()).get('/outbox/dead-letters?limit=2&offset=0').expect(200)
    expect(res.body.items).toHaveLength(2)
    expect(res.body.limit).toBe(2)
    expect(res.body.offset).toBe(0)
    expect(res.body.total).toBeGreaterThanOrEqual(3)
  })

  it('an actor without audit:read (read_only) is rejected with 403, never sees dead letters', async () => {
    const viewer = await makeActiveUser('readonly')
    await rolesRepo().assign({ userId: viewer.id, roleKey: 'read_only', scopeOrgUnitId: null })
    currentUsername = viewer.username

    const res = await request(app.getHttpServer()).get('/outbox/dead-letters').expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  it('an actor holding NO role at all is rejected with 403', async () => {
    const bare = await makeActiveUser('bare')
    currentUsername = bare.username

    await request(app.getHttpServer()).get('/outbox/dead-letters').expect(403)
  })
})
