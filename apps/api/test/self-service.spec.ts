import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import { ALL_ACTIONS } from '../src/authz/actions'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import { PrivilegeGuards } from '../src/authz/privilege.guards'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { attributeDefinitions } from '../src/db/schema/attribute-definitions'
import { GroupsRepository } from '../src/groups/groups.repository'
import { KEYCLOAK_ADMIN_CONFIG, KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { OrgUnitsRepository, type OrgUnit } from '../src/org-units/org-units.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { SyncDetailRepository } from '../src/outbox/sync-detail.repository'
import { SyncStateRepository } from '../src/outbox/sync-state.repository'
import { SelfServiceController } from '../src/self-service/self-service.controller'
import { BusinessRolesRepository } from '../src/business-roles/business-roles.repository'
import { RoleReconciler } from '../src/business-roles/role-reconciler'
import { UsersController } from '../src/users/users.controller'
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

/**
 * Resolves the principal from an `x-test-username` REQUEST HEADER rather
 * than a shared closure variable — needed for finding H4's self-vs-admin
 * race test below, which fires two requests for TWO DIFFERENT actors
 * (the target user, and an admin) truly concurrently via `Promise.all`. A
 * shared `currentUsername` variable (every other stub in this suite) cannot
 * express that: both requests' guards would read whatever the LAST
 * synchronous assignment left behind, resolving both to the SAME actor
 * regardless of which request the header was "meant" for. Each supertest
 * call sets its own header via `.set('x-test-username', ...)`, so the
 * per-request value travels with the request itself instead of racing a
 * variable.
 */
function stubJwtGuardByHeader(): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      const req = context
        .switchToHttp()
        .getRequest<{ principal?: unknown; headers: Record<string, string | string[] | undefined> }>()
      const raw = req.headers['x-test-username']
      const username = Array.isArray(raw) ? raw[0] : raw
      req.principal = { subject: 'self-service-h4-test', username: username ?? '', email: null }
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
    // Bind ONCE. `init()` alone leaves the http server unbound, so supertest
    // calls listen(0) itself per request — and the concurrency tests below
    // fire 30 at once via Promise.all, creating 30 ephemeral listeners. Under
    // CI contention one of those connections gets reset, and the test fails
    // with `read ECONNRESET`: a transport artifact wearing the costume of the
    // lost-update bug it exists to detect. Binding a single listener up front
    // keeps the test measuring what it means to measure.
    await new Promise<void>((resolve) => app.getHttpServer().listen(0, resolve))
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
  const roleAssignmentsRepo = () => new RoleAssignmentsRepository(ctx.db)

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

    // docs/archive/audits/audit-injection.md HIGH finding: a JSON-escaped NUL
    // (Unicode code point 0) is legal JSON and passed every check that
    // existed pre-fix, only failing once it reached Postgres as a raw,
    // non-DomainError exception — an unmapped 500. Confirmed live on
    // exactly this endpoint, and worth its own regression test beyond the
    // POST /org-units one: PATCH /self needs NO role at all, so any
    // authenticated user — not just an admin — could trigger it. Must now
    // be a clean 400 naming the field, writing no audit row, before the
    // value can ever reach the driver.
    it('rejects a NUL character in "location" with 400 VALIDATION_FAILED naming the field, never an unmapped 500', async () => {
      const org = await makeOrgUnit('Nul Location Root')
      const actor = await makeActiveUser('actor', org.id)
      currentUsername = actor.username
      const nul = String.fromCharCode(0)

      const res = await request(app.getHttpServer())
        .patch('/self')
        .send({ location: `loc${nul}x` })
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
      expect(res.body.issues.join(' ')).toContain('location')

      expect(await auditRowsFor(ctx, actor.id)).toHaveLength(0)
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

    // docs/archive/audits/audit-injection.md HIGH finding — the JSON half of
    // the __proto__ silent-elision bug, PATCH/merge variant. Pre-fix,
    // `z.record(z.unknown())` silently dropped the "__proto__" key WHILE
    // PARSING (zod's own built-in prototype-pollution defence in
    // `ParseStatus.mergeObjectSync` refuses to assign that key regardless of
    // whether it is a genuine own property, with no error raised), so
    // `attributes: {"__proto__": "x"}` became `attributes: {}` before
    // validateAttributes ever ran — and because PATCH /self MERGES onto the
    // existing attributes (never a wholesale replace, see this describe
    // block's "merges..." test below), an empty patch is a silent no-op
    // 200, not a visible data loss. It is still the same underlying bug:
    // the request named an invalid key and was reported as a clean success
    // instead of a 400, exactly like any other unrecognized key already is.
    it('rejects a "__proto__" JSON attribute key with 400, rather than silently succeeding as a no-op', async () => {
      const org = await makeOrgUnit('Proto Attr Root')
      const actor = await makeActiveUser('actor', org.id)
      currentUsername = actor.username

      // Raw JSON text, not a JS object literal: `{__proto__: 'x'}` written
      // as a JS literal is a no-op assignment (attempting to set the
      // object's prototype to a non-object value), which would produce a
      // genuinely EMPTY object client-side and never exercise this scenario
      // at all — see attribute-validator.spec.ts's own comment on the
      // identical hazard. `.type('json')` sends the string VERBATIM
      // (confirmed against the installed superagent@10.3.0: `_end` in
      // lib/node/index.js skips JSON.stringify whenever the outgoing data
      // is already a string), so the SERVER's own JSON.parse is what
      // creates the genuine own "__proto__" property.
      const res = await request(app.getHttpServer())
        .patch('/self')
        .type('json')
        .send('{"attributes":{"__proto__":"x"}}')
        .expect(400)

      expect(res.body.code).toBe('VALIDATION_FAILED')
      expect(res.body.issues.join(' ')).toContain('__proto__')
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

    // Finding H4 (docs/archive/audits/audit-integrity.md, HIGH): the merge used
    // to read `current.attributes` with a PLAIN (unlocked) SELECT, compute
    // `{...current.attributes, ...attributePatch}`, and write that back —
    // a classic lost update under READ COMMITTED. Two concurrent requests
    // could both read the same starting snapshot, both merge their own
    // patch onto it, and whichever's UPDATE committed LAST silently
    // overwrote the other's already-committed change. Measured 30/30 by the
    // audit. `findByIdForUpdate` (SELECT ... FOR UPDATE) fixes it: a second
    // concurrent caller's own locked read now blocks until the first
    // commits, then merges onto the up-to-date result instead of racing it.
    it(
      '30 concurrent PATCH /self calls, each setting a DIFFERENT attribute, never lose one to a stale-read merge (30/30)',
      async () => {
        const org = await makeOrgUnit('H4 Concurrent Merge Root')
        const actor = await makeActiveUser('actor', org.id)
        currentUsername = actor.username

        const N = 30
        const keys = Array.from({ length: N }, () => `h4self-${nextTag()}`)
        await ctx.db.insert(attributeDefinitions).values(
          keys.map((key) => ({
            key,
            label: key,
            dataType: 'string' as const,
            required: false,
            appliesTo: 'user' as const,
            isActive: true,
            selfEditable: true,
          })),
        )

        const responses = await Promise.all(
          keys.map((key, i) =>
            request(app.getHttpServer())
              .patch('/self')
              .send({ attributes: { [key]: `value-${i}` } }),
          ),
        )

        expect(responses.map((r) => r.status)).toEqual(Array(N).fill(200))

        const reloaded = await usersRepo().findById(actor.id)
        for (let i = 0; i < N; i++) {
          // The headline regression assertion: pre-fix, this was 30/30
          // fewer than N keys surviving — every request but the last
          // committer's merged onto a snapshot that predates every OTHER
          // request's own (already-committed-by-the-time-this-one-wrote)
          // change, silently dropping it.
          expect(reloaded?.attributes[keys[i]]).toBe(`value-${i}`)
        }
      },
      30_000,
    )

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

  // =======================================================================
  // GET /self/permissions (Milestone 8, Task 2)
  // =======================================================================
  describe('GET /self/permissions', () => {
    it('returns an empty action set for a user holding no role at all', async () => {
      const org = await makeOrgUnit('Permissions Empty Root')
      const actor = await makeActiveUser('actor', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer()).get('/self/permissions').expect(200)
      expect(res.body).toEqual({ actions: [] })
    })

    it('returns exactly the actions granted by a single scoped role assignment', async () => {
      const org = await makeOrgUnit('Permissions Help Desk Root')
      const actor = await makeActiveUser('actor', org.id)
      currentUsername = actor.username

      await roleAssignmentsRepo().assign({
        userId: actor.id,
        roleKey: 'help_desk',
        scopeOrgUnitId: org.id,
      })

      const res = await request(app.getHttpServer()).get('/self/permissions').expect(200)
      expect([...res.body.actions].sort()).toEqual(
        ['user:read', 'user:update', 'group:read', 'org_unit:read'].sort(),
      )
    })

    it('reports the identical action list whether the grant is scoped or global — scope narrows resources, never the action catalog', async () => {
      const org = await makeOrgUnit('Permissions Global Root')
      const actor = await makeActiveUser('actor', org.id)
      currentUsername = actor.username

      // scopeOrgUnitId omitted -> global, per RoleAssignmentsRepository.assign's own default.
      await roleAssignmentsRepo().assign({ userId: actor.id, roleKey: 'read_only' })

      const res = await request(app.getHttpServer()).get('/self/permissions').expect(200)
      expect([...res.body.actions].sort()).toEqual(['user:read', 'group:read', 'org_unit:read'].sort())
    })

    it('unions actions across multiple role assignments, with no duplicates', async () => {
      const orgA = await makeOrgUnit('Permissions Union Root A')
      const orgB = await makeOrgUnit('Permissions Union Root B')
      const actor = await makeActiveUser('actor', orgA.id)
      currentUsername = actor.username

      await roleAssignmentsRepo().assign({
        userId: actor.id,
        roleKey: 'help_desk',
        scopeOrgUnitId: orgA.id,
      })
      await roleAssignmentsRepo().assign({
        userId: actor.id,
        roleKey: 'auditor',
        scopeOrgUnitId: orgB.id,
      })

      const res = await request(app.getHttpServer()).get('/self/permissions').expect(200)
      const actions: string[] = res.body.actions
      expect(new Set(actions).size).toBe(actions.length) // no duplicate 'user:read'/'group:read'/'org_unit:read'
      // Milestone 14, Task 9: auditor also holds connector:read (per-target
      // health/dead-letter visibility, the same category of information
      // audit:read already grants — see authz/actions.ts's own doc comment).
      expect([...actions].sort()).toEqual(
        ['user:read', 'user:update', 'group:read', 'org_unit:read', 'audit:read', 'connector:read'].sort(),
      )
    })

    it('a super_admin sees every action in the catalog', async () => {
      const org = await makeOrgUnit('Permissions Super Admin Root')
      const actor = await makeActiveUser('actor', org.id)
      currentUsername = actor.username

      await roleAssignmentsRepo().assign({ userId: actor.id, roleKey: 'super_admin' })

      const res = await request(app.getHttpServer()).get('/self/permissions').expect(200)
      expect([...res.body.actions].sort()).toEqual([...ALL_ACTIONS].sort())
    })

    it("ignores another user's id supplied via query string — always the caller's own actions, never the named user's", async () => {
      const org = await makeOrgUnit('Permissions Query Id Root')
      const actor = await makeActiveUser('actor', org.id)
      const victim = await makeActiveUser('victim', org.id)
      currentUsername = actor.username

      await roleAssignmentsRepo().assign({ userId: victim.id, roleKey: 'super_admin' })

      const res = await request(app.getHttpServer())
        .get(`/self/permissions?id=${victim.id}&userId=${victim.id}`)
        .expect(200)
      // The caller (actor) holds no role — must NOT reflect the victim's super_admin.
      expect(res.body).toEqual({ actions: [] })
    })

    it('a deactivated user gets 403', async () => {
      const org = await makeOrgUnit('Permissions Deactivated Root')
      const actor = await makeActiveUser('actor', org.id)
      await usersRepo().changeStatus(actor.id, 'deactivated')
      currentUsername = actor.username

      const res = await request(app.getHttpServer()).get('/self/permissions').expect(403)
      expect(res.body.code).toBe('FORBIDDEN')
    })

    it('a pending (never activated) user gets 403 too', async () => {
      const org = await makeOrgUnit('Permissions Pending Root')
      const tag = nextTag()
      const pending = await usersRepo().create({
        primaryEmail: `permspending-${tag}@example.com`,
        username: `permspending-${tag}`,
        firstName: 'Pending',
        lastName: 'User',
        orgUnitId: org.id,
      })
      currentUsername = pending.username

      const res = await request(app.getHttpServer()).get('/self/permissions').expect(403)
      expect(res.body.code).toBe('FORBIDDEN')
    })

    it('has no id-parameterized variant of this route: GET /self/permissions/<uuid> is not found', async () => {
      const org = await makeOrgUnit('Permissions No Id Route Root')
      const actor = await makeActiveUser('actor', org.id)
      currentUsername = actor.username

      await request(app.getHttpServer())
        .get('/self/permissions/00000000-0000-0000-0000-000000000000')
        .expect(404)
    })
  })

  // =======================================================================
  // GET /self/roles — Milestone 8, Task 4. Backs the admin console's
  // role-assignment scope picker (see SelfRolesResponse's own doc comment):
  // unlike GET /self/permissions (a flat action list), this needs to expose
  // WHICH role at WHICH scope, so the client can replicate (for picker
  // options only — the server still re-decides for real on submit)
  // PrivilegeGuards.assertCanAssignRole's own "may only grant a role you
  // hold, at a scope your holding covers" logic.
  // =======================================================================
  describe('GET /self/roles', () => {
    it('returns an empty assignments array for a user holding no role at all', async () => {
      const org = await makeOrgUnit('Roles Empty Root')
      const actor = await makeActiveUser('actor', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer()).get('/self/roles').expect(200)
      expect(res.body).toEqual({ assignments: [] })
    })

    it('reports a scoped grant with its scope org unit id AND path', async () => {
      const org = await makeOrgUnit('Roles Scoped Root')
      const actor = await makeActiveUser('actor', org.id)
      currentUsername = actor.username

      await roleAssignmentsRepo().assign({
        userId: actor.id,
        roleKey: 'help_desk',
        scopeOrgUnitId: org.id,
      })

      const res = await request(app.getHttpServer()).get('/self/roles').expect(200)
      expect(res.body.assignments).toEqual([
        { roleKey: 'help_desk', scopeOrgUnitId: org.id, scopePath: org.path },
      ])
    })

    it('reports a global grant with scopeOrgUnitId AND scopePath both null', async () => {
      const org = await makeOrgUnit('Roles Global Root')
      const actor = await makeActiveUser('actor', org.id)
      currentUsername = actor.username

      // scopeOrgUnitId omitted -> global, per RoleAssignmentsRepository.assign's own default.
      await roleAssignmentsRepo().assign({ userId: actor.id, roleKey: 'super_admin' })

      const res = await request(app.getHttpServer()).get('/self/roles').expect(200)
      expect(res.body.assignments).toEqual([
        { roleKey: 'super_admin', scopeOrgUnitId: null, scopePath: null },
      ])
    })

    it('reports every assignment when the caller holds more than one', async () => {
      const orgA = await makeOrgUnit('Roles Multi Root A')
      const orgB = await makeOrgUnit('Roles Multi Root B')
      const actor = await makeActiveUser('actor', orgA.id)
      currentUsername = actor.username

      await roleAssignmentsRepo().assign({ userId: actor.id, roleKey: 'help_desk', scopeOrgUnitId: orgA.id })
      await roleAssignmentsRepo().assign({ userId: actor.id, roleKey: 'auditor', scopeOrgUnitId: orgB.id })

      const res = await request(app.getHttpServer()).get('/self/roles').expect(200)
      const byRole = new Map(
        (res.body.assignments as { roleKey: string; scopeOrgUnitId: string }[]).map((a) => [a.roleKey, a]),
      )
      expect(byRole.get('help_desk')).toMatchObject({ scopeOrgUnitId: orgA.id })
      expect(byRole.get('auditor')).toMatchObject({ scopeOrgUnitId: orgB.id })
    })

    it("ignores another user's id supplied via query string — always the caller's own assignments, never the named user's", async () => {
      const org = await makeOrgUnit('Roles Query Id Root')
      const actor = await makeActiveUser('actor', org.id)
      const victim = await makeActiveUser('victim', org.id)
      currentUsername = actor.username

      await roleAssignmentsRepo().assign({ userId: victim.id, roleKey: 'super_admin' })

      const res = await request(app.getHttpServer())
        .get(`/self/roles?id=${victim.id}&userId=${victim.id}`)
        .expect(200)
      // The caller (actor) holds no role — must NOT reflect the victim's super_admin.
      expect(res.body).toEqual({ assignments: [] })
    })

    it('a deactivated user gets 403', async () => {
      const org = await makeOrgUnit('Roles Deactivated Root')
      const actor = await makeActiveUser('actor', org.id)
      await usersRepo().changeStatus(actor.id, 'deactivated')
      currentUsername = actor.username

      const res = await request(app.getHttpServer()).get('/self/roles').expect(403)
      expect(res.body.code).toBe('FORBIDDEN')
    })

    it('a pending (never activated) user gets 403 too', async () => {
      const org = await makeOrgUnit('Roles Pending Root')
      const tag = nextTag()
      const pending = await usersRepo().create({
        primaryEmail: `rolespending-${tag}@example.com`,
        username: `rolespending-${tag}`,
        firstName: 'Pending',
        lastName: 'User',
        orgUnitId: org.id,
      })
      currentUsername = pending.username

      const res = await request(app.getHttpServer()).get('/self/roles').expect(403)
      expect(res.body.code).toBe('FORBIDDEN')
    })

    it('has no id-parameterized variant of this route: GET /self/roles/<uuid> is not found', async () => {
      const org = await makeOrgUnit('Roles No Id Route Root')
      const actor = await makeActiveUser('actor', org.id)
      currentUsername = actor.username

      await request(app.getHttpServer())
        .get('/self/roles/00000000-0000-0000-0000-000000000000')
        .expect(404)
    })
  })
})

/**
 * Finding H4's SECOND measured race (docs/archive/audits/audit-integrity.md):
 * "self-service racing an admin edit" — `PATCH /self` (merge) concurrent
 * with `PATCH /users/:id` (wholesale replace) on the SAME user, each naming
 * a DIFFERENT attribute key. `UsersController.update`'s own wholesale
 * replace is unchanged and intentional (see UpdateUserInput's doc comment) —
 * an admin write that lands chronologically LAST is ALLOWED to discard a
 * self-service attribute, by design. What must never happen, with or
 * without a fix, is the ADMIN's attribute vanishing: the whole reason
 * self-service merges instead of replacing is "a self-service edit cannot
 * erase admin-set attributes outside the caller's scope" — under the
 * pre-fix race, self-service's own STALE read (taken before the admin's
 * write) could still get merged and then blindly overwrite AFTER the
 * admin's write had already landed, erasing it despite self "winning" the
 * write race. `findByIdForUpdate` closes exactly that interleaving (see
 * self-service.controller.ts's own doc comment) — proven here against a
 * SEPARATE, combined module wiring both controllers, since this needs two
 * genuinely different actors racing each other.
 */
describe('PATCH /self racing PATCH /users/:id (finding H4, docs/archive/audits/audit-integrity.md)', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let orgUnitId: string
  let adminUsername: string

  const UNREACHABLE_KEYCLOAK_CONFIG = {
    issuer: 'http://127.0.0.1:1/realms/unreachable',
    clientId: 'irrelevant',
    clientSecret: 'irrelevant',
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SelfServiceController, UsersController],
      providers: [
        // Milestone 17, Task 9: UsersController now re-evaluates business roles
        // inside its own create/update transactions, and its RoleReconciler
        // parameter is deliberately NOT @Optional() (an absent reconciler would
        // mean every user write silently skips re-evaluation). Both providers are
        // therefore required to construct it, here exactly as in AppModule.
        BusinessRolesRepository,
        RoleReconciler,
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        UsersRepository,
        GroupsRepository,
        PermissionEngine,
        PermissionGuard,
        PrivilegeGuards,
        RoleAssignmentsRepository,
        AuditWriter,
        OutboxWriter,
        Reflector,
        { provide: KEYCLOAK_ADMIN_CONFIG, useValue: UNREACHABLE_KEYCLOAK_CONFIG },
        KeycloakAdminClient,
        SyncStateRepository,
      SyncDetailRepository,
        SyncDetailRepository,
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue(stubJwtGuardByHeader())
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()
    // Bind ONCE. `init()` alone leaves the http server unbound, so supertest
    // calls listen(0) itself per request — and the concurrency tests below
    // fire 30 at once via Promise.all, creating 30 ephemeral listeners. Under
    // CI contention one of those connections gets reset, and the test fails
    // with `read ECONNRESET`: a transport artifact wearing the costume of the
    // lost-update bug it exists to detect. Binding a single listener up front
    // keeps the test measuring what it means to measure.
    await new Promise<void>((resolve) => app.getHttpServer().listen(0, resolve))

    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`H4 Self Vs Admin Root ${Date.now()}`)).id

    const usersRepo = new UsersRepository(ctx.db)
    const tag = `h4admin-${Date.now()}`
    const created = await usersRepo.create({
      primaryEmail: `${tag}@example.com`,
      username: tag,
      firstName: 'H4',
      lastName: 'Admin',
      orgUnitId,
    })
    const admin = await usersRepo.changeStatus(created.id, 'active')
    adminUsername = admin.username
    await new RoleAssignmentsRepository(ctx.db).assign({
      userId: admin.id,
      roleKey: 'user_admin',
      scopeOrgUnitId: orgUnitId,
    })
  })

  afterAll(async () => {
    await app?.close()
  })

  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `h4sa${fixtureSeq}`
  }

  it(
    "30 iterations of a 1 admin vs 4 self-service concurrent write fan-in never lose the ADMIN's attribute to a stale self-service merge (30/30)",
    async () => {
      const usersRepo = new UsersRepository(ctx.db)
      const N = 30
      // A single 2-way race is too narrow to reliably land the specific bad
      // interleaving (self reads before the admin write, self writes after
      // it) — real scheduling could go either way on any given pair. Fanning
      // in several self-service writers against the SAME row, all racing
      // the ONE admin write, mirrors how the self-vs-self test above gets
      // its own reliability: more contenders on one row means it only takes
      // ONE of them to read-before/write-after the admin's commit.
      const SELF_WRITERS = 4

      for (let i = 0; i < N; i++) {
        const tag = nextTag()
        const adminKey = `h4sa-admin-${tag}`
        const selfKeys = Array.from({ length: SELF_WRITERS }, (_, j) => `h4sa-self-${tag}-${j}`)

        await ctx.db.insert(attributeDefinitions).values([
          {
            key: adminKey,
            label: adminKey,
            dataType: 'string',
            required: false,
            appliesTo: 'user',
            isActive: true,
            selfEditable: false,
          },
          ...selfKeys.map((key) => ({
            key,
            label: key,
            dataType: 'string' as const,
            required: false,
            appliesTo: 'user' as const,
            isActive: true,
            selfEditable: true,
          })),
        ])

        const created = await usersRepo.create({
          primaryEmail: `${tag}@example.com`,
          username: tag,
          firstName: 'Target',
          lastName: tag,
          orgUnitId,
        })
        const target = await usersRepo.changeStatus(created.id, 'active')

        const adminRequest = request(app.getHttpServer())
          .patch(`/users/${target.id}`)
          .set('x-test-username', adminUsername)
          .send({ attributes: { [adminKey]: 'fromAdmin' } })
        const selfRequests = selfKeys.map((key) =>
          request(app.getHttpServer())
            .patch('/self')
            .set('x-test-username', target.username)
            .send({ attributes: { [key]: 'fromSelf' } }),
        )

        const responses = await Promise.all([adminRequest, ...selfRequests])
        expect(responses.map((r) => r.status)).toEqual(Array(1 + SELF_WRITERS).fill(200))

        const reloaded = await usersRepo.findById(target.id)
        // The headline regression assertion: pre-fix, this was 30/30
        // missing at least once across the run — SOME self-service writer's
        // stale-read merge, landing after the admin's commit, silently
        // wiped it out even though self "won" the write race.
        expect(reloaded?.attributes[adminKey]).toBe('fromAdmin')
      }
    },
    60_000,
  )
})
