import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import type { RoleKey } from '../src/authz/actions'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import { PrivilegeGuards } from '../src/authz/privilege.guards'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { GroupsRepository } from '../src/groups/groups.repository'
import { KEYCLOAK_ADMIN_CONFIG, KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { OrgUnitsRepository, type OrgUnit } from '../src/org-units/org-units.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { SyncDetailRepository } from '../src/outbox/sync-detail.repository'
import { SyncStateRepository } from '../src/outbox/sync-state.repository'
import { UsersController } from '../src/users/users.controller'
import { UsersRepository, type User } from '../src/users/users.repository'
import { type TestDatabase, withTestDatabase } from './support/pg'

// Milestone 4, Task 4: UsersController's deactivate handler now attempts a
// SYNCHRONOUS Keycloak setEnabled/revokeSessions before returning. This file
// deliberately points that at an unreachable local port rather than a real
// Keycloak container — connecting fails FAST (ECONNREFUSED), so every
// deactivate test below incidentally exercises the "Keycloak down" branch
// (logged, swallowed, mutation still succeeds — see
// UsersController.revokeKeycloakAccess) for free. The behaviour this
// specific failure path proves end-to-end (a live session actually dying,
// syncState reflecting it) is covered properly, against a REAL Keycloak
// container, by test/revocation.spec.ts — this file stays focused on audit
// rows, same as before Milestone 4.
const UNREACHABLE_KEYCLOAK_CONFIG = {
  issuer: 'http://127.0.0.1:1/realms/unreachable',
  clientId: 'irrelevant',
  clientSecret: 'irrelevant',
}

/**
 * Stamps `request.principal` from whatever `getUsername()` returns AT
 * REQUEST TIME — same technique as scope-narrowing.spec.ts's fixture. Lets
 * one compiled app impersonate different actors across tests by mutating a
 * shared `currentUsername` the closure reads.
 */
function stubJwtGuard(getUsername: () => string): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
        subject: 'kc-write-test',
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

/**
 * Audit assertions in this file are always scoped to a specific
 * resource_id, never to "the newest row" or "the whole table's count" —
 * see the file-level comment below for why (audit rows can never be
 * deleted, so this file cannot reset between tests the way every other
 * spec file does).
 */
async function auditRowsFor(ctx: TestDatabase, resourceId: string): Promise<AuditLogRow[]> {
  const { rows } = await ctx.pool.query<AuditLogRow>(
    "SELECT * FROM audit_log WHERE resource_type = 'user' AND resource_id = $1 ORDER BY id ASC",
    [resourceId],
  )
  return rows
}

async function totalAuditCount(ctx: TestDatabase): Promise<number> {
  const { rows } = await ctx.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM audit_log')
  return rows[0]?.count ?? 0
}

const BOGUS_ID = '00000000-0000-0000-0000-000000000000'

/**
 * MILESTONE 3b, TASK 2: the project's FIRST mutation endpoints. Every audit
 * row this file's requests produce pins its actor/target users via
 * audit_log's `restrict` foreign key, and audit_log itself is append-only
 * at the database level (UPDATE/DELETE/TRUNCATE all rejected by trigger —
 * see db/migrate.ts and test/audit.spec.ts). So unlike every other spec
 * file in this suite, this one does NOT `DELETE FROM users` (or org_units,
 * which users.org_unit_id also references with `restrict`) between tests —
 * doing so would fail outright the moment any prior test in the file has
 * audited a mutation. Instead every fixture below is uniquely named per
 * call (see `nextTag()`), rows accumulate for the life of the file's own
 * Testcontainer, and every assertion is scoped to the specific
 * resource/org-unit each test created rather than to total table state.
 * Existing spec files are unaffected by this and are not changed for it —
 * see decision 3 in docs/archive/plans/2026-08-05-idp-milestone-3b-write-endpoints.md.
 */
describe('user write endpoints (Milestone 3b, Task 2)', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let currentUsername = ''

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        UsersRepository,
        PermissionEngine,
        PermissionGuard,
        PrivilegeGuards,
        AuditWriter,
        OutboxWriter,
        Reflector,
        // Milestone 4, Task 4 — see UNREACHABLE_KEYCLOAK_CONFIG's comment above.
        { provide: KEYCLOAK_ADMIN_CONFIG, useValue: UNREACHABLE_KEYCLOAK_CONFIG },
        KeycloakAdminClient,
        GroupsRepository,
        SyncStateRepository,
      SyncDetailRepository,
        SyncDetailRepository,
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
  // Fixture helpers. Every name embeds a monotonically unique tag so no
  // fixture in this file ever collides with another, regardless of test
  // order — see the file-level comment above for why nothing here can rely
  // on a table reset instead.
  // ---------------------------------------------------------------------
  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `wr${fixtureSeq}`
  }

  const orgUnitsRepo = () => new OrgUnitsRepository(ctx.db)
  const usersRepo = () => new UsersRepository(ctx.db)
  const rolesRepo = () => new RoleAssignmentsRepository(ctx.db)

  async function makeOrgUnit(label: string): Promise<OrgUnit> {
    return orgUnitsRepo().createRoot(`${label} ${nextTag()}`)
  }

  async function makeChildOrgUnit(parentId: string, label: string): Promise<OrgUnit> {
    return orgUnitsRepo().createChild(parentId, `${label} ${nextTag()}`)
  }

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

  /**
   * Left at the `pending` the column defaults to — deliberately NOT run
   * through `changeStatus`, unlike `makeActiveUser` above. This is the
   * state every newly created person is really in, and the one
   * POST /users/:id/activate exists to move them out of.
   */
  async function makePendingUser(role: string, orgUnitId: string): Promise<User> {
    const tag = nextTag()
    return usersRepo().create({
      primaryEmail: `${role}-${tag}@example.com`,
      username: `${role}-${tag}`,
      firstName: 'Test',
      lastName: 'User',
      orgUnitId,
    })
  }

  async function grant(userId: string, roleKey: RoleKey, scopeOrgUnitId?: string | null) {
    return rolesRepo().assign({ userId, roleKey, scopeOrgUnitId })
  }

  // =======================================================================
  // POST /users
  // =======================================================================
  describe('POST /users', () => {
    it('creates a user for an in-scope actor and writes exactly one audit row', async () => {
      const org = await makeOrgUnit('Create Root')
      const actor = await makeActiveUser('creator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const tag = nextTag()
      const res = await request(app.getHttpServer())
        .post('/users')
        .send({
          primaryEmail: `newhire-${tag}@example.com`,
          username: `newhire-${tag}`,
          firstName: 'New',
          lastName: 'Hire',
          orgUnitId: org.id,
          jobTitle: 'Engineer',
        })
        .expect(201)

      expect(res.body.status).toBe('pending')
      expect(res.body.username).toBe(`newhire-${tag}`)
      expect(res.body.displayName).toBe('New Hire')

      const rows = await auditRowsFor(ctx, res.body.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].action).toBe('user:create')
      expect(rows[0].actor_user_id).toBe(actor.id)
      expect(rows[0].before).toBeNull()
      expect(rows[0].after?.username).toBe(`newhire-${tag}`)
      expect(rows[0].after?.jobTitle).toBe('Engineer')
      expect(rows[0].after?.orgUnitId).toBe(org.id)
    })

    /**
     * Finding SEC-L2 (docs/archive/audits/carried-findings-verification.md).
     * `users_primary_email_unique` and `users_username_unique` are GLOBAL,
     * unscoped indexes, so a 409 that echoed the submitted value back with
     * "already exists" confirmed — one candidate per request, and silently,
     * because the transaction rolls back and writes no audit row — that an
     * address exists somewhere in the directory, including for principals this
     * actor cannot read at all. Wave D fixed this on the import path and left
     * the direct-create sibling; these two mirror
     * imports.write.spec.ts's pair so the rule is enforced on both paths.
     */
    it("a create re-using an out-of-scope user's email 409s without confirming the address exists", async () => {
      const root = await makeOrgUnit('Oracle Email Root')
      const mine = await makeChildOrgUnit(root.id, 'Oracle Email Mine')
      const theirs = await makeChildOrgUnit(root.id, 'Oracle Email Theirs')
      const victim = await makeActiveUser('oracle-email-victim', theirs.id)
      const actor = await makeActiveUser('oracle-email-actor', mine.id)
      await grant(actor.id, 'user_admin', mine.id)
      currentUsername = actor.username

      const tag = nextTag()
      const res = await request(app.getHttpServer())
        .post('/users')
        .send({
          primaryEmail: victim.primaryEmail,
          username: `oracle-email-probe-${tag}`,
          firstName: 'Probe',
          lastName: 'Attempt',
          orgUnitId: mine.id,
        })
        .expect(409)

      expect(res.body.message).not.toContain(victim.primaryEmail)
      expect(res.body.message).not.toMatch(/already exists/i)
      expect(res.body.message).toBe('primaryEmail: not available')
    })

    it("a create re-using an out-of-scope user's username 409s without confirming the username exists", async () => {
      const root = await makeOrgUnit('Oracle Name Root')
      const mine = await makeChildOrgUnit(root.id, 'Oracle Name Mine')
      const theirs = await makeChildOrgUnit(root.id, 'Oracle Name Theirs')
      const victim = await makeActiveUser('oracle-name-victim', theirs.id)
      const actor = await makeActiveUser('oracle-name-actor', mine.id)
      await grant(actor.id, 'user_admin', mine.id)
      currentUsername = actor.username

      const tag = nextTag()
      const res = await request(app.getHttpServer())
        .post('/users')
        .send({
          primaryEmail: `oracle-name-probe-${tag}@example.com`,
          username: victim.username,
          firstName: 'Probe',
          lastName: 'Attempt',
          orgUnitId: mine.id,
        })
        .expect(409)

      expect(res.body.message).not.toContain(victim.username)
      expect(res.body.message).not.toMatch(/already exists/i)
      expect(res.body.message).toBe('username: not available')
    })

    it('rejects a create targeting an out-of-scope org unit with 403 and writes no audit row', async () => {
      const root = await makeOrgUnit('Scope Root')
      const scopeOrg = await makeChildOrgUnit(root.id, 'In Scope')
      const otherOrg = await makeChildOrgUnit(root.id, 'Out Of Scope')
      const actor = await makeActiveUser('scoped-creator', scopeOrg.id)
      await grant(actor.id, 'user_admin', scopeOrg.id)
      currentUsername = actor.username

      const before = await totalAuditCount(ctx)
      const tag = nextTag()

      const res = await request(app.getHttpServer())
        .post('/users')
        .send({
          primaryEmail: `blocked-${tag}@example.com`,
          username: `blocked-${tag}`,
          firstName: 'No',
          lastName: 'Access',
          orgUnitId: otherOrg.id,
        })
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await totalAuditCount(ctx)).toBe(before)
    })

    it('maps a nonexistent org unit to 404 NOT_FOUND rather than an unmapped 500', async () => {
      const org = await makeOrgUnit('Global Root')
      const actor = await makeActiveUser('global-creator', org.id)
      await grant(actor.id, 'super_admin', null) // global: assertCanIn short-circuits without
      currentUsername = actor.username // touching org_units, so this reaches the insert.

      const before = await totalAuditCount(ctx)
      const tag = nextTag()

      const res = await request(app.getHttpServer())
        .post('/users')
        .send({
          primaryEmail: `ghost-${tag}@example.com`,
          username: `ghost-${tag}`,
          firstName: 'Ghost',
          lastName: 'User',
          orgUnitId: BOGUS_ID,
        })
        .expect(404)
      expect(res.body.code).toBe('NOT_FOUND')
      expect(res.body.message).toContain('org unit')

      expect(await totalAuditCount(ctx)).toBe(before)
    })

    it('maps a nonexistent manager to 404, correctly labelled "manager" — not mislabelled as the org unit FK', async () => {
      const org = await makeOrgUnit('Manager Root')
      const actor = await makeActiveUser('creator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const before = await totalAuditCount(ctx)
      const tag = nextTag()

      const res = await request(app.getHttpServer())
        .post('/users')
        .send({
          primaryEmail: `report-${tag}@example.com`,
          username: `report-${tag}`,
          firstName: 'Direct',
          lastName: 'Report',
          orgUnitId: org.id,
          managerId: BOGUS_ID,
        })
        .expect(404)
      expect(res.body.code).toBe('NOT_FOUND')
      expect(res.body.message).toContain('manager')
      expect(res.body.message).not.toContain('org unit')

      expect(await totalAuditCount(ctx)).toBe(before)
    })

    it('rejects a malformed body with 400 VALIDATION_FAILED and writes no audit row', async () => {
      const org = await makeOrgUnit('Validation Root')
      const actor = await makeActiveUser('creator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const before = await totalAuditCount(ctx)

      const res = await request(app.getHttpServer())
        .post('/users')
        .send({ username: `incomplete-${nextTag()}` }) // missing required fields
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')

      expect(await totalAuditCount(ctx)).toBe(before)
    })

    it('rejects an unrecognized custom attribute by default (no active definitions exist)', async () => {
      const org = await makeOrgUnit('Attributes Root')
      const actor = await makeActiveUser('creator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const tag = nextTag()
      const res = await request(app.getHttpServer())
        .post('/users')
        .send({
          primaryEmail: `attrs-${tag}@example.com`,
          username: `attrs-${tag}`,
          firstName: 'Attr',
          lastName: 'Test',
          orgUnitId: org.id,
          attributes: { costCenter: 'CC-1' },
        })
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
    })

    // docs/archive/audits/audit-injection.md HIGH finding — the JSON half of
    // the __proto__ silent-elision bug (the CSV half is covered in
    // imports.write.spec.ts). Pre-fix, `z.record(z.unknown())` silently
    // dropped a "__proto__" key WHILE PARSING (zod's own built-in
    // prototype-pollution defence, in `ParseStatus.mergeObjectSync`, refuses
    // to assign that key regardless of whether it's a genuine own property
    // — with no error raised), so `attributes: {"__proto__": {...}}` became
    // `attributes: {}` before validateAttributes ever ran, and the request
    // returned 201 with `attributes: {}` — nothing failed, the key just
    // vanished. Must now 400 exactly like an ordinary unrecognized key
    // (e.g. "constructor", already covered by the malformed-body test
    // above) already does.
    it('rejects a "__proto__" JSON attribute key with 400, never silently dropping it to {}', async () => {
      const org = await makeOrgUnit('Proto Attr Root')
      const actor = await makeActiveUser('proto-attr-creator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const tag = nextTag()
      const email = `protoattr-${tag}@example.com`
      // Raw JSON TEXT, not a JS object literal: `{__proto__: {x: 1}}`
      // written as a JS literal SETS the resulting object's actual
      // prototype instead of creating an own property (JSON.stringify-ing
      // it would then silently produce "{}", defeating this test before it
      // even reaches the server — see attribute-validator.spec.ts's own
      // comment on the identical hazard). `.type('json')` makes superagent
      // send this string VERBATIM rather than re-serializing it (confirmed
      // against the installed superagent@10.3.0's `_end`, lib/node/index.js:
      // it skips JSON.stringify entirely whenever the outgoing data is
      // already a string), so the SERVER's own JSON.parse is what creates
      // the genuine own "__proto__" property — exactly like a real
      // attacker's request over the wire.
      const body =
        `{"primaryEmail":"${email}","username":"protoattr-${tag}","firstName":"Proto",` +
        `"lastName":"Attr","orgUnitId":"${org.id}","attributes":{"__proto__":{"x":1}}}`

      const res = await request(app.getHttpServer())
        .post('/users')
        .type('json')
        .send(body)
        .expect(400)

      expect(res.body.code).toBe('VALIDATION_FAILED')
      expect(res.body.issues.join(' ')).toContain('__proto__')

      // No user was created either — this must fail before any write, not
      // succeed with the key merely missing from the response.
      expect(await usersRepo().findByEmail(email)).toBeNull()
    })

    // docs/archive/audits/audit-injection.md HIGH finding: a JSON-escaped NUL
    // (Unicode code point 0) is legal JSON and passed every check that
    // existed pre-fix (body-parser, Zod's .min()/.max()), only failing once
    // it reached Postgres as a raw, non-DomainError exception — an unmapped
    // 500. Confirmed live on exactly this endpoint. Must now be a clean 400
    // naming the field, writing no audit row, before the value can ever
    // reach the driver.
    it('rejects a NUL character in "firstName" with 400 VALIDATION_FAILED naming the field, never an unmapped 500', async () => {
      const org = await makeOrgUnit('Nul Field Root')
      const actor = await makeActiveUser('nul-creator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const before = await totalAuditCount(ctx)
      const tag = nextTag()
      const nul = String.fromCharCode(0)

      const res = await request(app.getHttpServer())
        .post('/users')
        .send({
          primaryEmail: `nulfield-${tag}@example.com`,
          username: `nulfield-${tag}`,
          firstName: `Fi${nul}rst`,
          lastName: 'Last',
          orgUnitId: org.id,
        })
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
      expect(res.body.issues.join(' ')).toContain('firstName')

      expect(await totalAuditCount(ctx)).toBe(before)
    })
  })

  // =======================================================================
  // PATCH /users/:id
  // =======================================================================
  describe('PATCH /users/:id', () => {
    it('updates an in-scope user and writes exactly one audit row with correct before/after', async () => {
      const org = await makeOrgUnit('Update Root')
      const actor = await makeActiveUser('updater', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .patch(`/users/${target.id}`)
        .send({ jobTitle: 'Staff Engineer' })
        .expect(200)
      expect(res.body.jobTitle).toBe('Staff Engineer')

      const rows = await auditRowsFor(ctx, target.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].action).toBe('user:update')
      expect(rows[0].actor_user_id).toBe(actor.id)
      expect(rows[0].before?.jobTitle).toBeNull()
      expect(rows[0].after?.jobTitle).toBe('Staff Engineer')
      // Untouched fields carry through unchanged in both snapshots.
      expect(rows[0].before?.username).toBe(target.username)
      expect(rows[0].after?.username).toBe(target.username)
    })

    // Finding M1 (docs/archive/audits/audit-integrity.md): `displayName` is
    // DERIVED from `patch.firstName ?? current.firstName` / `patch.lastName
    // ?? current.lastName` inside UsersRepository.update, from an UNLOCKED
    // `current` read — same lost-update mechanism as H4's attribute merge.
    // Two concurrent PATCHes, one naming only firstName and one naming only
    // lastName, each recomputed displayName from their own stale half.
    it(
      '30 iterations of two concurrent PATCH /users/:id (firstName vs lastName) leave displayName reflecting BOTH (30/30)',
      async () => {
        const org = await makeOrgUnit('DisplayName Race Root')
        const actor = await makeActiveUser('updater', org.id)
        await grant(actor.id, 'user_admin', org.id)
        currentUsername = actor.username

        for (let i = 0; i < 30; i++) {
          const target = await makeActiveUser('target', org.id)
          const firstName = `RaceFirst${i}`
          const lastName = `RaceLast${i}`

          const [resA, resB] = await Promise.all([
            request(app.getHttpServer()).patch(`/users/${target.id}`).send({ firstName }),
            request(app.getHttpServer()).patch(`/users/${target.id}`).send({ lastName }),
          ])
          expect(resA.status).toBe(200)
          expect(resB.status).toBe(200)

          const reloaded = await usersRepo().findById(target.id)
          expect(reloaded?.firstName).toBe(firstName)
          expect(reloaded?.lastName).toBe(lastName)
          // The headline regression assertion: pre-fix, this was 30/30
          // wrong — displayName recomputed from whichever half was already
          // stale by the time each request's own write landed, permanently
          // desynced from the fields it is supposed to derive from.
          expect(reloaded?.displayName).toBe(`${firstName} ${lastName}`)
        }
      },
      30_000,
    )

    it('leaves attributes untouched when the request body omits the key entirely', async () => {
      const org = await makeOrgUnit('Attr Preserve Root')
      const actor = await makeActiveUser('updater', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .patch(`/users/${target.id}`)
        .send({ location: 'Remote' })
        .expect(200)
      expect(res.body.location).toBe('Remote')
      expect(res.body.attributes).toEqual(target.attributes)
    })

    it('rejects updating an out-of-scope user with 403 and writes no audit row', async () => {
      const root = await makeOrgUnit('Update Scope Root')
      const scopeOrg = await makeChildOrgUnit(root.id, 'In Scope')
      const otherOrg = await makeChildOrgUnit(root.id, 'Out Of Scope')
      const actor = await makeActiveUser('scoped-updater', scopeOrg.id)
      await grant(actor.id, 'help_desk', scopeOrg.id) // holds user:update
      const target = await makeActiveUser('target', otherOrg.id)
      currentUsername = actor.username

      expect(await auditRowsFor(ctx, target.id)).toHaveLength(0)

      const res = await request(app.getHttpServer())
        .patch(`/users/${target.id}`)
        .send({ jobTitle: 'Should Not Land' })
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await auditRowsFor(ctx, target.id)).toHaveLength(0)
    })

    // The exact scenario the brief calls out: rank and scope are
    // independent, and neither check subsumes the other. `boss` sits
    // INSIDE the help_desk's own scope (same org unit) — assertCanIn alone
    // would allow this — but holds a GLOBAL super_admin assignment that
    // outranks the actor, so assertCanModifyPrincipal must be the one that
    // actually blocks it.
    it('blocks a help_desk from modifying a super_admin even when the target is in scope (privilege guard, not scope)', async () => {
      const org = await makeOrgUnit('Privilege Root')
      const helper = await makeActiveUser('helper', org.id)
      await grant(helper.id, 'help_desk', org.id)
      const boss = await makeActiveUser('boss', org.id) // same org unit as helper -> in scope
      await grant(boss.id, 'super_admin', null) // globally scoped -> outranks help_desk
      currentUsername = helper.username

      const res = await request(app.getHttpServer())
        .patch(`/users/${boss.id}`)
        .send({ jobTitle: 'Should Not Work' })
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await auditRowsFor(ctx, boss.id)).toHaveLength(0)
    })

    it('maps a nonexistent manager to 404 on update, and the failed write leaves the prior audit count unchanged (mid-transaction rollback)', async () => {
      const org = await makeOrgUnit('Update Manager Root')
      const actor = await makeActiveUser('updater', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      // One genuine prior success, so the count-unchanged assertion below
      // proves the FAILED attempt added nothing, not merely that the table
      // started empty.
      await request(app.getHttpServer())
        .patch(`/users/${target.id}`)
        .send({ location: 'HQ' })
        .expect(200)
      expect(await auditRowsFor(ctx, target.id)).toHaveLength(1)

      const res = await request(app.getHttpServer())
        .patch(`/users/${target.id}`)
        .send({ managerId: BOGUS_ID })
        .expect(404)
      expect(res.body.code).toBe('NOT_FOUND')
      expect(res.body.message).toContain('manager')

      expect(await auditRowsFor(ctx, target.id)).toHaveLength(1)
    })

    it('rejects an update body with an unrecognized field with 400 VALIDATION_FAILED', async () => {
      const org = await makeOrgUnit('Strict Body Root')
      const actor = await makeActiveUser('updater', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .patch(`/users/${target.id}`)
        .send({ notAField: 'nope' })
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
    })

    it('returns 404 for a well-formed but nonexistent user id', async () => {
      const org = await makeOrgUnit('Missing User Root')
      const actor = await makeActiveUser('updater', org.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .patch(`/users/${BOGUS_ID}`)
        .send({ jobTitle: 'Nobody' })
        .expect(404)
      expect(res.body.code).toBe('NOT_FOUND')
    })
  })

  // =======================================================================
  // POST /users/:id/deactivate
  // =======================================================================
  describe('POST /users/:id/deactivate', () => {
    it('deactivates an in-scope user and writes exactly one audit row', async () => {
      const org = await makeOrgUnit('Deactivate Root')
      const actor = await makeActiveUser('deactivator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/deactivate`)
        .expect(200)
      expect(res.body.status).toBe('deactivated')
      expect(res.body.deactivatedAt).not.toBeNull()

      const rows = await auditRowsFor(ctx, target.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].action).toBe('user:deactivate')
      expect(rows[0].before?.status).toBe('active')
      expect(rows[0].after?.status).toBe('deactivated')
    })

    it('deactivating twice returns 409 INVALID_TRANSITION on the second attempt and writes no second audit row', async () => {
      const org = await makeOrgUnit('Double Deactivate Root')
      const actor = await makeActiveUser('deactivator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      await request(app.getHttpServer()).post(`/users/${target.id}/deactivate`).expect(200)
      expect(await auditRowsFor(ctx, target.id)).toHaveLength(1)

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/deactivate`)
        .expect(409)
      expect(res.body.code).toBe('INVALID_TRANSITION')

      // Still exactly one row — the terminal re-attempt rolled back cleanly.
      expect(await auditRowsFor(ctx, target.id)).toHaveLength(1)
    })

    it('rejects deactivating an out-of-scope user with 403 and writes no audit row', async () => {
      const root = await makeOrgUnit('Deactivate Scope Root')
      const scopeOrg = await makeChildOrgUnit(root.id, 'In Scope')
      const otherOrg = await makeChildOrgUnit(root.id, 'Out Of Scope')
      const actor = await makeActiveUser('scoped-deactivator', scopeOrg.id)
      await grant(actor.id, 'user_admin', scopeOrg.id)
      const target = await makeActiveUser('target', otherOrg.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/deactivate`)
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await auditRowsFor(ctx, target.id)).toHaveLength(0)
    })

    it('blocks a help_desk from deactivating a super_admin even in scope (privilege guard)', async () => {
      const org = await makeOrgUnit('Deactivate Privilege Root')
      // help_desk does not itself hold user:deactivate, so use user_admin
      // (which does) to isolate this test to the PRIVILEGE guard rather
      // than PermissionGuard's own entry check, already covered elsewhere.
      const admin = await makeActiveUser('admin', org.id)
      await grant(admin.id, 'user_admin', org.id)
      const boss = await makeActiveUser('boss', org.id)
      await grant(boss.id, 'super_admin', null)
      currentUsername = admin.username

      const res = await request(app.getHttpServer())
        .post(`/users/${boss.id}/deactivate`)
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await auditRowsFor(ctx, boss.id)).toHaveLength(0)
    })

    it('returns 404 for a well-formed but nonexistent user id', async () => {
      const org = await makeOrgUnit('Deactivate Missing Root')
      const actor = await makeActiveUser('deactivator', org.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/users/${BOGUS_ID}/deactivate`)
        .expect(404)
      expect(res.body.code).toBe('NOT_FOUND')
    })
  })

  // =======================================================================
  // POST /users/:id/activate
  // =======================================================================
  describe('POST /users/:id/activate', () => {
    it('activates a pending user and writes exactly one audit row', async () => {
      const org = await makeOrgUnit('Activate Root')
      const actor = await makeActiveUser('activator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const target = await makePendingUser('target', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/activate`)
        .expect(200)
      expect(res.body.status).toBe('active')

      const rows = await auditRowsFor(ctx, target.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].action).toBe('user:activate')
      expect(rows[0].before?.status).toBe('pending')
      expect(rows[0].after?.status).toBe('active')
    })

    it('activates a suspended user', async () => {
      const org = await makeOrgUnit('Activate Suspended Root')
      const actor = await makeActiveUser('activator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const target = await makeActiveUser('target', org.id)
      await usersRepo().changeStatus(target.id, 'suspended')
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/activate`)
        .expect(200)
      expect(res.body.status).toBe('active')

      const rows = await auditRowsFor(ctx, target.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].before?.status).toBe('suspended')
    })

    it('returns 409 INVALID_TRANSITION for a deactivated user and writes no audit row', async () => {
      const org = await makeOrgUnit('Activate Terminal Root')
      const actor = await makeActiveUser('activator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      await request(app.getHttpServer()).post(`/users/${target.id}/deactivate`).expect(200)
      expect(await auditRowsFor(ctx, target.id)).toHaveLength(1)

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/activate`)
        .expect(409)
      expect(res.body.code).toBe('INVALID_TRANSITION')
      expect(res.body.message).toContain('terminal')

      // Still exactly the one deactivate row — the reactivation attempt
      // rolled back cleanly and left no trace.
      expect(await auditRowsFor(ctx, target.id)).toHaveLength(1)
    })

    it('returns 409 INVALID_TRANSITION for an already-active user', async () => {
      const org = await makeOrgUnit('Activate Idempotent Root')
      const actor = await makeActiveUser('activator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/activate`)
        .expect(409)
      expect(res.body.code).toBe('INVALID_TRANSITION')

      expect(await auditRowsFor(ctx, target.id)).toHaveLength(0)
    })

    it('rejects an actor holding only user:update with 403 and writes no audit row', async () => {
      const org = await makeOrgUnit('Activate Permission Root')
      const actor = await makeActiveUser('helper', org.id)
      await grant(actor.id, 'help_desk', org.id) // user:update, NOT user:activate
      const target = await makePendingUser('target', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/activate`)
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await auditRowsFor(ctx, target.id)).toHaveLength(0)
    })

    it('rejects activating an out-of-scope user with 403 and writes no audit row', async () => {
      const root = await makeOrgUnit('Activate Scope Root')
      const scopeOrg = await makeChildOrgUnit(root.id, 'In Scope')
      const otherOrg = await makeChildOrgUnit(root.id, 'Out Of Scope')
      const actor = await makeActiveUser('scoped-activator', scopeOrg.id)
      await grant(actor.id, 'user_admin', scopeOrg.id)
      const target = await makePendingUser('target', otherOrg.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/activate`)
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await auditRowsFor(ctx, target.id)).toHaveLength(0)
    })

    it('blocks a user_admin from activating a super_admin even in scope (privilege guard)', async () => {
      const org = await makeOrgUnit('Activate Privilege Root')
      const admin = await makeActiveUser('admin', org.id)
      await grant(admin.id, 'user_admin', org.id)
      const boss = await makePendingUser('boss', org.id)
      await grant(boss.id, 'super_admin', null)
      currentUsername = admin.username

      const res = await request(app.getHttpServer())
        .post(`/users/${boss.id}/activate`)
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await auditRowsFor(ctx, boss.id)).toHaveLength(0)
    })

    it('returns 404 for a well-formed but nonexistent user id', async () => {
      const org = await makeOrgUnit('Activate Missing Root')
      const actor = await makeActiveUser('activator', org.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/users/${BOGUS_ID}/activate`)
        .expect(404)
      expect(res.body.code).toBe('NOT_FOUND')
    })
  })

  // =======================================================================
  // No delete, ever.
  // =======================================================================
  describe('DELETE /users/:id', () => {
    it('does not exist — 404, not 403 or 405', async () => {
      const org = await makeOrgUnit('Delete Root')
      const actor = await makeActiveUser('actor', org.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      await request(app.getHttpServer()).delete(`/users/${BOGUS_ID}`).expect(404)
    })
  })

  // =======================================================================
  // Redaction: audit payloads are built from named fields, not `{ ...row }`.
  // =======================================================================
  describe('audit payload construction', () => {
    it('never carries a credential-shaped key in before/after, even scanned as raw JSON', async () => {
      const org = await makeOrgUnit('Redaction Root')
      const actor = await makeActiveUser('creator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const tag = nextTag()
      const res = await request(app.getHttpServer())
        .post('/users')
        .send({
          primaryEmail: `redact-${tag}@example.com`,
          username: `redact-${tag}`,
          firstName: 'Redact',
          lastName: 'Test',
          orgUnitId: org.id,
        })
        .expect(201)

      const rows = await auditRowsFor(ctx, res.body.id)
      const serialized = JSON.stringify(rows[0].after).toLowerCase()
      for (const forbidden of ['password', 'passwd', 'secret', 'hash', 'salt', 'credential', 'token']) {
        expect(serialized).not.toContain(forbidden)
      }
    })
  })
})
