import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import { PermissionEngine } from '../src/authz/permission.engine'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { attributeDefinitions } from '../src/db/schema/attribute-definitions'
import { GroupsRepository } from '../src/groups/groups.repository'
import { OrgUnitsRepository, type OrgUnit } from '../src/org-units/org-units.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { SelfServiceController } from '../src/self-service/self-service.controller'
import { UsersRepository, type User } from '../src/users/users.repository'
import { type TestDatabase, withTestDatabase } from './support/pg'

/**
 * Stamps `request.principal` from whatever `getUsername()` returns AT
 * REQUEST TIME — same technique as users.write.spec.ts / scope-narrowing.
 * spec.ts. `SelfServiceController` never depends on `request.actor`
 * (unlike every PermissionGuard-gated controller) — it resolves the actor
 * itself, from `request.principal`, exactly once per handler (see
 * `resolveCaller`'s doc comment) — so this suite only ever needs to stub
 * JwtGuard, never PermissionGuard.
 */
function stubJwtGuard(getUsername: () => string): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
        subject: 'self-service-test',
        username: getUsername(),
        email: null,
      }
      return true
    },
  }
}

interface AuditLogRow {
  id: number
  actor_user_id: string | null
  action: string
  resource_type: string
  resource_id: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  created_at: string
}

interface OutboxRow {
  id: number
  aggregate_type: string
  aggregate_id: string
  event_type: string
  payload: Record<string, unknown>
}

/**
 * Same rationale as users.write.spec.ts's identical helper: audit_log rows
 * pin their actor/target via a `restrict` FK and the table is append-only,
 * so this file (which mutates users through PATCH /self) never
 * `DELETE FROM users` between tests — every fixture below is uniquely
 * tagged instead (see `nextTag`), and every assertion is scoped to the
 * specific resource id each test created.
 */
async function auditRowsFor(ctx: TestDatabase, resourceId: string): Promise<AuditLogRow[]> {
  const { rows } = await ctx.pool.query<AuditLogRow>(
    "SELECT * FROM audit_log WHERE resource_type = 'user' AND resource_id = $1 ORDER BY id ASC",
    [resourceId],
  )
  return rows
}

async function outboxRowsFor(ctx: TestDatabase, aggregateId: string): Promise<OutboxRow[]> {
  const { rows } = await ctx.pool.query<OutboxRow>(
    "SELECT * FROM outbox_events WHERE aggregate_type = 'user' AND aggregate_id = $1 ORDER BY id ASC",
    [aggregateId],
  )
  return rows
}

/**
 * MILESTONE 6, TASK 3 — self-service API. Covers `GET /self`, `PATCH /self`
 * and `GET /self/groups`.
 *
 * THE FOUR THINGS THAT MATTER MOST, and which test(s) pin each one:
 *  1. No request-supplied id ever redirects the write/read — see the
 *     "supplies another user's id" tests under every describe block below,
 *     plus the "has no id-parameterized variant of this route" test.
 *  2. Works for a user holding NO role at all — every fixture in this file
 *     is a bare active user with zero role assignments (this file never
 *     calls a role-assignment repository), so every passing test already
 *     proves this; several are additionally titled to say so explicitly.
 *  3. Default-deny on edits — the "rejects each forbidden core field" and
 *     the attribute-editability tests below.
 *  4. Deactivated -> 403 — one test per route.
 */
describe('SelfServiceController (Milestone 6, Task 3)', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let currentUsername = ''

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SelfServiceController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        UsersRepository,
        GroupsRepository,
        PermissionEngine,
        AuditWriter,
        OutboxWriter,
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue(stubJwtGuard(() => currentUsername))
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
  })

  // ---------------------------------------------------------------------
  // Fixture helpers — see auditRowsFor's doc comment for why this file
  // never resets tables between tests.
  // ---------------------------------------------------------------------
  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `ss${fixtureSeq}`
  }

  const orgUnitsRepo = () => new OrgUnitsRepository(ctx.db)
  const usersRepo = () => new UsersRepository(ctx.db)
  const groupsRepo = () => new GroupsRepository(ctx.db)

  async function makeOrgUnit(label: string): Promise<OrgUnit> {
    return orgUnitsRepo().createRoot(`${label} ${nextTag()}`)
  }

  /** Active, with NO role assignment — every test in this file relies on exactly this. */
  async function makeActiveUser(role: string, orgUnitId: string): Promise<User> {
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

  // =======================================================================
  // GET /self
  // =======================================================================
  describe('GET /self', () => {
    it('returns the caller\'s own profile for a user holding no role at all', async () => {
      const org = await makeOrgUnit('Profile Root')
      const actor = await makeActiveUser('actor', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer()).get('/self').expect(200)
      expect(res.body.id).toBe(actor.id)
      expect(res.body.username).toBe(actor.username)
      expect(res.body.status).toBe('active')
      expect(res.body.editable.coreFields).toEqual(['location'])
      expect(res.body.editable.attributes).toEqual([])
    })

    it('advertises only active, self-editable attribute definitions as editable', async () => {
      const org = await makeOrgUnit('Editable Meta Root')
      const actor = await makeActiveUser('actor', org.id)
      currentUsername = actor.username

      await ctx.db.insert(attributeDefinitions).values([
        {
          key: `editableActive-${nextTag()}`,
          label: 'Editable Active',
          dataType: 'string',
          required: false,
          appliesTo: 'user',
          isActive: true,
          selfEditable: true,
        },
        {
          key: `lockedActive-${nextTag()}`,
          label: 'Locked Active',
          dataType: 'string',
          required: false,
          appliesTo: 'user',
          isActive: true,
          selfEditable: false,
        },
        {
          key: `editableInactive-${nextTag()}`,
          label: 'Editable Inactive',
          dataType: 'string',
          required: false,
          appliesTo: 'user',
          isActive: false,
          selfEditable: true,
        },
      ])

      const res = await request(app.getHttpServer()).get('/self').expect(200)
      const keys: string[] = res.body.editable.attributes.map((d: { key: string }) => d.key)
      expect(keys).toEqual(keys.filter((k) => k.startsWith('editableActive-')))
      expect(keys).toHaveLength(1)
    })

    it('a deactivated user gets 403', async () => {
      const org = await makeOrgUnit('Deactivated Root')
      const actor = await makeActiveUser('actor', org.id)
      await usersRepo().changeStatus(actor.id, 'deactivated')
      currentUsername = actor.username

      const res = await request(app.getHttpServer()).get('/self').expect(403)
      expect(res.body.code).toBe('FORBIDDEN')
    })

    it('a pending (never activated) user gets 403 too — resolveActor requires active, not merely existing', async () => {
      const org = await makeOrgUnit('Pending Root')
      const tag = nextTag()
      const pending = await usersRepo().create({
        primaryEmail: `pending-${tag}@example.com`,
        username: `pending-${tag}`,
        firstName: 'Pending',
        lastName: 'User',
        orgUnitId: org.id,
      })
      currentUsername = pending.username

      const res = await request(app.getHttpServer()).get('/self').expect(403)
      expect(res.body.code).toBe('FORBIDDEN')
    })

    it('ignores another user\'s id supplied via query string — always returns the caller\'s own record', async () => {
      const org = await makeOrgUnit('Query Id Root')
      const actor = await makeActiveUser('actor', org.id)
      const victim = await makeActiveUser('victim', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .get(`/self?id=${victim.id}&userId=${victim.id}`)
        .expect(200)

      expect(res.body.id).toBe(actor.id)
      expect(res.body.id).not.toBe(victim.id)
    })

    it('has no id-parameterized variant of this route: GET /self/<uuid> is not found', async () => {
      const org = await makeOrgUnit('No Id Route Root')
      const actor = await makeActiveUser('actor', org.id)
      currentUsername = actor.username

      await request(app.getHttpServer())
        .get('/self/00000000-0000-0000-0000-000000000000')
        .expect(404)
    })
  })

  // =======================================================================
  // PATCH /self
  // =======================================================================
  describe('PATCH /self', () => {
    it('updates the caller\'s own location, writing exactly one audit row (actor === target) and one outbox event, for a user holding no role at all', async () => {
      const org = await makeOrgUnit('Update Root')
      const actor = await makeActiveUser('actor', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .patch('/self')
        .send({ location: 'Remote' })
        .expect(200)

      expect(res.body.id).toBe(actor.id)
      expect(res.body.location).toBe('Remote')

      const auditRows = await auditRowsFor(ctx, actor.id)
      expect(auditRows).toHaveLength(1)
      expect(auditRows[0].action).toBe('user:self_update')
      expect(auditRows[0].actor_user_id).toBe(actor.id)
      expect(auditRows[0].resource_id).toBe(actor.id)
      expect(auditRows[0].before?.location).toBeNull()
      expect(auditRows[0].after?.location).toBe('Remote')

      const outboxRows = await outboxRowsFor(ctx, actor.id)
      expect(outboxRows).toHaveLength(1)
      expect(outboxRows[0].event_type).toBe('updated')
    })

    describe('rejects each forbidden core field by name, never silently dropping it', () => {
      const FORBIDDEN_CORE_FIELDS: Record<string, unknown> = {
        status: 'suspended',
        orgUnitId: '00000000-0000-0000-0000-000000000000',
        username: 'hacked-username',
        primaryEmail: 'hacked@example.com',
        employeeId: 'E-9999',
        managerId: '00000000-0000-0000-0000-000000000000',
        firstName: 'Hacked',
        lastName: 'Name',
        jobTitle: 'Emperor',
      }

      for (const [field, value] of Object.entries(FORBIDDEN_CORE_FIELDS)) {
        it(`rejects "${field}"`, async () => {
          const org = await makeOrgUnit('Forbidden Field Root')
          const actor = await makeActiveUser('actor', org.id)
          currentUsername = actor.username

          const res = await request(app.getHttpServer())
            .patch('/self')
            .send({ [field]: value })
            .expect(400)
          expect(res.body.code).toBe('VALIDATION_FAILED')
          expect(res.body.issues.join(' ')).toContain(field)

          expect(await auditRowsFor(ctx, actor.id)).toHaveLength(0)
        })
      }
    })

    it('rejects an update body with an unrecognized field with 400 VALIDATION_FAILED', async () => {
      const org = await makeOrgUnit('Strict Body Root')
      const actor = await makeActiveUser('actor', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .patch('/self')
        .send({ notAField: 'nope' })
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
    })

    it('rejects a body naming an id field, with 400, and modifies neither the caller nor the named user', async () => {
      const org = await makeOrgUnit('Body Id Root')
      const actor = await makeActiveUser('actor', org.id)
      const victim = await makeActiveUser('victim', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .patch('/self')
        .send({ location: 'Should Not Land', userId: victim.id })
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')

      const reloadedActor = await usersRepo().findById(actor.id)
      expect(reloadedActor?.location).toBeNull()
      const reloadedVictim = await usersRepo().findById(victim.id)
      expect(reloadedVictim?.location).toBeNull()
    })

    it('ignores an id supplied via query string; only the caller\'s own row changes, the named other user is untouched', async () => {
      const org = await makeOrgUnit('Patch Query Id Root')
      const actor = await makeActiveUser('actor', org.id)
      const victimBase = await makeActiveUser('victim', org.id)
      const victim = await usersRepo().update(victimBase.id, { location: 'Victim City' })
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .patch(`/self?id=${victim.id}&userId=${victim.id}`)
        .send({ location: 'Actor City' })
        .expect(200)

      expect(res.body.id).toBe(actor.id)
      expect(res.body.location).toBe('Actor City')

      const reloadedVictim = await usersRepo().findById(victim.id)
      expect(reloadedVictim?.location).toBe('Victim City')
    })

    it('rejects an unrecognized attribute key with 400 naming it (no active definitions)', async () => {
      const org = await makeOrgUnit('Unknown Attr Root')
      const actor = await makeActiveUser('actor', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .patch('/self')
        .send({ attributes: { costCenter: 'CC-1' } })
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
      expect(res.body.issues.join(' ')).toContain('costCenter')
    })

    it('rejects a non-self-editable but active attribute by name, and leaves its existing value untouched', async () => {
      const org = await makeOrgUnit('Non Editable Attr Root')
      const actor = await makeActiveUser('actor', org.id)
      currentUsername = actor.username
      const key = `costCenter-${nextTag()}`

      await ctx.db.insert(attributeDefinitions).values({
        key,
        label: 'Cost Center',
        dataType: 'string',
        required: false,
        appliesTo: 'user',
        isActive: true,
        selfEditable: false,
      })

      // Admin-set value, applied directly through the repository (no admin
      // HTTP path is exercised in this file) so this test can prove the
      // self-service PATCH neither applies its own attempted value NOR
      // drops the existing one.
      await usersRepo().update(actor.id, { attributes: { [key]: 'CC-ADMIN' } })

      const res = await request(app.getHttpServer())
        .patch('/self')
        .send({ attributes: { [key]: 'CC-HACK' } })
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
      expect(res.body.issues.join(' ')).toContain(key)

      const reloaded = await usersRepo().findById(actor.id)
      expect(reloaded?.attributes[key]).toBe('CC-ADMIN')
    })

    it('merges a self-editable attribute update, leaving other existing (non-self-editable) attributes untouched', async () => {
      const org = await makeOrgUnit('Merge Attr Root')
      const actor = await makeActiveUser('actor', org.id)
      currentUsername = actor.username
      const lockedKey = `costCenter-${nextTag()}`
      const editableKey = `nickname-${nextTag()}`

      await ctx.db.insert(attributeDefinitions).values([
        {
          key: lockedKey,
          label: 'Cost Center',
          dataType: 'string',
          required: false,
          appliesTo: 'user',
          isActive: true,
          selfEditable: false,
        },
        {
          key: editableKey,
          label: 'Nickname',
          dataType: 'string',
          required: false,
          appliesTo: 'user',
          isActive: true,
          selfEditable: true,
        },
      ])

      await usersRepo().update(actor.id, {
        attributes: { [lockedKey]: 'CC-1', [editableKey]: 'Old' },
      })

      const res = await request(app.getHttpServer())
        .patch('/self')
        .send({ attributes: { [editableKey]: 'New' } })
        .expect(200)

      expect(res.body.attributes[editableKey]).toBe('New')
      // The non-self-editable attribute survives the PATCH untouched — proves
      // the write MERGES onto the existing attributes object rather than
      // replacing it wholesale with only what this request named.
      expect(res.body.attributes[lockedKey]).toBe('CC-1')

      const reloaded = await usersRepo().findById(actor.id)
      expect(reloaded?.attributes[lockedKey]).toBe('CC-1')
      expect(reloaded?.attributes[editableKey]).toBe('New')
    })

    it('a deactivated user gets 403 on PATCH too, and writes no audit row', async () => {
      const org = await makeOrgUnit('Patch Deactivated Root')
      const actor = await makeActiveUser('actor', org.id)
      await usersRepo().changeStatus(actor.id, 'deactivated')
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .patch('/self')
        .send({ location: 'Should Not Land' })
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await auditRowsFor(ctx, actor.id)).toHaveLength(0)
    })
  })

  // =======================================================================
  // GET /self/groups
  // =======================================================================
  describe('GET /self/groups', () => {
    it('separates direct membership from the wider effective (inherited) set, for a user holding no role at all', async () => {
      const org = await makeOrgUnit('Groups Root')
      const actor = await makeActiveUser('actor', org.id)
      currentUsername = actor.username

      const groups = groupsRepo()
      const allStaff = await groups.create({ name: `All Staff ${nextTag()}` })
      const engineering = await groups.create({ name: `Engineering ${nextTag()}` })
      const backend = await groups.create({ name: `Backend ${nextTag()}` })
      await groups.addChildGroup(allStaff.id, engineering.id)
      await groups.addChildGroup(engineering.id, backend.id)
      await groups.addUser(backend.id, actor.id)

      const res = await request(app.getHttpServer()).get('/self/groups').expect(200)

      expect(res.body.direct.map((g: { id: string }) => g.id)).toEqual([backend.id])
      expect(res.body.effective.map((g: { id: string }) => g.id).sort()).toEqual(
        [allStaff.id, engineering.id, backend.id].sort(),
      )
    })

    it('returns empty arrays for a user in no groups', async () => {
      const org = await makeOrgUnit('Empty Groups Root')
      const actor = await makeActiveUser('actor', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer()).get('/self/groups').expect(200)
      expect(res.body).toEqual({ direct: [], effective: [] })
    })

    it('ignores another user\'s id supplied via query string — always the caller\'s own memberships', async () => {
      const org = await makeOrgUnit('Groups Query Id Root')
      const actor = await makeActiveUser('actor', org.id)
      const victim = await makeActiveUser('victim', org.id)
      currentUsername = actor.username

      const groups = groupsRepo()
      const victimGroup = await groups.create({ name: `Victim Group ${nextTag()}` })
      await groups.addUser(victimGroup.id, victim.id)

      const res = await request(app.getHttpServer())
        .get(`/self/groups?userId=${victim.id}`)
        .expect(200)
      expect(res.body).toEqual({ direct: [], effective: [] })
    })

    it('a deactivated user gets 403', async () => {
      const org = await makeOrgUnit('Groups Deactivated Root')
      const actor = await makeActiveUser('actor', org.id)
      await usersRepo().changeStatus(actor.id, 'deactivated')
      currentUsername = actor.username

      const res = await request(app.getHttpServer()).get('/self/groups').expect(403)
      expect(res.body.code).toBe('FORBIDDEN')
    })
  })
})
