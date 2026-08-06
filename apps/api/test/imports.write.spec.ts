import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import type { RoleKey } from '../src/authz/actions'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import { PrivilegeGuards } from '../src/authz/privilege.guards'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { attributeDefinitions } from '../src/db/schema/attribute-definitions'
import { IMPORTS_CONFIG, ImportsController } from '../src/imports/imports.controller'
import { REQUIRED_IMPORT_HEADERS } from '../src/imports/import-row'
import { OrgUnitsRepository, type OrgUnit } from '../src/org-units/org-units.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { UsersRepository, type User } from '../src/users/users.repository'
import { type TestDatabase, withTestDatabase } from './support/pg'

/**
 * Stamps `request.principal` from whatever `getUsername()` returns AT
 * REQUEST TIME — same technique as users.write.spec.ts.
 */
function stubJwtGuard(getUsername: () => string): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
        subject: 'kc-imports-test',
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
  batch_id: string | null
  created_at: string
}

async function auditRowsFor(ctx: TestDatabase, resourceId: string): Promise<AuditLogRow[]> {
  const { rows } = await ctx.pool.query<AuditLogRow>(
    "SELECT * FROM audit_log WHERE resource_type = 'user' AND resource_id = $1 ORDER BY id ASC",
    [resourceId],
  )
  return rows
}

async function auditRowsForBatch(ctx: TestDatabase, batchId: string): Promise<AuditLogRow[]> {
  const { rows } = await ctx.pool.query<AuditLogRow>(
    'SELECT * FROM audit_log WHERE batch_id = $1 ORDER BY id ASC',
    [batchId],
  )
  return rows
}

async function totalAuditCount(ctx: TestDatabase): Promise<number> {
  const { rows } = await ctx.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM audit_log')
  return rows[0]?.count ?? 0
}

async function totalOutboxCount(ctx: TestDatabase): Promise<number> {
  const { rows } = await ctx.pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM outbox_events',
  )
  return rows[0]?.count ?? 0
}

async function outboxEventsFor(
  ctx: TestDatabase,
  aggregateId: string,
): Promise<Array<{ event_type: string; payload: Record<string, unknown> }>> {
  const { rows } = await ctx.pool.query<{ event_type: string; payload: Record<string, unknown> }>(
    "SELECT event_type, payload FROM outbox_events WHERE aggregate_type = 'user' AND aggregate_id = $1 ORDER BY id ASC",
    [aggregateId],
  )
  return rows
}

async function totalUserCount(ctx: TestDatabase): Promise<number> {
  const { rows } = await ctx.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM users')
  return rows[0]?.count ?? 0
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * Builds CSV text from an array of row objects. Every REQUIRED_IMPORT_HEADERS
 * column is always present in the header row, even if no row in this
 * particular call sets it — a row leaving a required CELL blank must reach
 * per-row validation as an empty value (a reported failure), not vanish from
 * the file's header row entirely (a different, structural failure mode —
 * see the "missing required column" tests below, which build their CSV text
 * by hand instead of through this helper for exactly that reason).
 */
function buildCsv(rows: Array<Record<string, string>>): string {
  const headerSet = new Set<string>(REQUIRED_IMPORT_HEADERS)
  for (const row of rows) {
    for (const key of Object.keys(row)) headerSet.add(key)
  }
  const headers = [...headerSet]
  const lines = [headers.join(',')]
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h] ?? '')).join(','))
  }
  return lines.join('\n')
}

/**
 * MILESTONE 5, TASKS 1+2: bulk import preview/commit. One shared Nest app,
 * same fixture shape as users.write.spec.ts (uniquely-tagged fixtures,
 * scoped assertions, no table resets — audit_log is append-only and this
 * file writes audit rows like every other write-spec file in this suite).
 */
describe('bulk import (Milestone 5, Tasks 1+2)', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let currentUsername = ''
  // Captured for the finding L-3 regression test below, which spies on the
  // REAL PermissionEngine instance the compiled module wires into
  // ImportsController — see that test's own comment.
  let engine: PermissionEngine
  // Captured for the "unexpected error mid-batch" regression test below,
  // which spies on the REAL UsersRepository instance the compiled module
  // wires into ImportsController (the same DI singleton `this.users` inside
  // the controller resolves to — NOT the throwaway `usersRepo()` instances
  // fixture helpers below construct for direct, out-of-band setup calls).
  let usersRepository: UsersRepository

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ImportsController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
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

    engine = moduleRef.get(PermissionEngine)
    usersRepository = moduleRef.get(UsersRepository)
    app = moduleRef.createNestApplication()
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
  })

  // ---------------------------------------------------------------------
  // Fixture helpers — same shape as users.write.spec.ts.
  // ---------------------------------------------------------------------
  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `imp${fixtureSeq}`
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

  async function grant(userId: string, roleKey: RoleKey, scopeOrgUnitId?: string | null) {
    return rolesRepo().assign({ userId, roleKey, scopeOrgUnitId })
  }

  function row(overrides: Record<string, string>): Record<string, string> {
    const tag = nextTag()
    return {
      employeeId: `E-${tag}`,
      primaryEmail: `${tag}@example.com`,
      username: `user-${tag}`,
      firstName: 'First',
      lastName: 'Last',
      orgUnitId: '',
      ...overrides,
    }
  }

  // =======================================================================
  // POST /imports/preview
  // =======================================================================
  describe('POST /imports/preview', () => {
    it('writes NOTHING about a user — user and outbox counts unchanged, even for otherwise-valid rows', async () => {
      const org = await makeOrgUnit('Preview Root')
      const actor = await makeActiveUser('previewer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const usersBefore = await totalUserCount(ctx)
      const outboxBefore = await totalOutboxCount(ctx)

      const csv = buildCsv([row({ orgUnitId: org.id }), row({ orgUnitId: org.id })])

      const res = await request(app.getHttpServer())
        .post('/imports/preview')
        .send({ csv })
        .expect(200)

      expect(res.body.summary.toCreate).toBe(2)
      expect(res.body.summary.failed).toBe(0)
      expect(res.body.toCreate).toHaveLength(2)

      expect(await totalUserCount(ctx)).toBe(usersBefore)
      expect(await totalOutboxCount(ctx)).toBe(outboxBefore)
    })

    // docs/superpowers/audit-secrets.md H1 (mirrored in audit-injection.md):
    // preview used to write ZERO audit rows under any circumstance, which is
    // exactly what let cross-scope directory enumeration through this
    // endpoint go completely untraced. It must now write EXACTLY ONE
    // audit row per successful invocation — never one per candidate row
    // (that would itself be an amplified write against the same unbounded
    // row count the audit flags) — recording who ran it and how large.
    it('writes exactly one invocation-level audit row per successful call, recording actor and row count', async () => {
      const org = await makeOrgUnit('Preview Audit Root')
      const actor = await makeActiveUser('audited-previewer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const auditBefore = await totalAuditCount(ctx)
      const csv = buildCsv([row({ orgUnitId: org.id }), row({ orgUnitId: org.id }), row({ orgUnitId: org.id })])

      await request(app.getHttpServer()).post('/imports/preview').send({ csv }).expect(200)

      expect(await totalAuditCount(ctx)).toBe(auditBefore + 1)

      const { rows } = await ctx.pool.query<{
        actor_user_id: string
        action: string
        resource_type: string
        resource_id: string | null
        after: { rowCount: number }
      }>(
        "SELECT actor_user_id, action, resource_type, resource_id, after FROM audit_log WHERE action = 'import:preview' AND actor_user_id = $1 ORDER BY id DESC LIMIT 1",
        [actor.id],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].resource_type).toBe('import')
      expect(rows[0].resource_id).toBeNull()
      expect(rows[0].after.rowCount).toBe(3)

      // Never one row per CANDIDATE — three rows in the file must still
      // produce exactly one audit row for this call, not three.
      expect(await totalAuditCount(ctx)).toBe(auditBefore + 1)
    })

    // The other half of "rejected requests write zero audit rows": a
    // request that never gets far enough to be a genuine enumeration
    // attempt (malformed input, or no permission at all) must not be
    // audited either — see the REQUIREMENTS section this fix wave was
    // built against.
    it('a malformed request (400) writes no audit row', async () => {
      const org = await makeOrgUnit('Preview Reject Audit Root')
      const actor = await makeActiveUser('reject-previewer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const auditBefore = await totalAuditCount(ctx)

      await request(app.getHttpServer())
        .post('/imports/preview')
        .send({ csv: 'employeeId,primaryEmail,username,firstName,lastName,orgUnitId\n"unterminated' })
        .expect(400)

      expect(await totalAuditCount(ctx)).toBe(auditBefore)
    })

    it('an actor with no user:create grant anywhere (403) writes no audit row', async () => {
      const org = await makeOrgUnit('Preview Reject Perm Audit Root')
      const actor = await makeActiveUser('reject-perm-previewer', org.id)
      await grant(actor.id, 'read_only', org.id)
      currentUsername = actor.username

      const auditBefore = await totalAuditCount(ctx)

      await request(app.getHttpServer())
        .post('/imports/preview')
        .send({ csv: buildCsv([row({ orgUnitId: org.id })]) })
        .expect(403)

      expect(await totalAuditCount(ctx)).toBe(auditBefore)
    })

    it('reports an out-of-scope row as a FAILURE, never a silent skip', async () => {
      const root = await makeOrgUnit('Preview Scope Root')
      const scopeOrg = await makeChildOrgUnit(root.id, 'In Scope')
      const otherOrg = await makeChildOrgUnit(root.id, 'Out Of Scope')
      const actor = await makeActiveUser('scoped-previewer', scopeOrg.id)
      await grant(actor.id, 'user_admin', scopeOrg.id)
      currentUsername = actor.username

      const csv = buildCsv([row({ orgUnitId: otherOrg.id })])

      const res = await request(app.getHttpServer())
        .post('/imports/preview')
        .send({ csv })
        .expect(200)

      expect(res.body.summary.toCreate).toBe(0)
      expect(res.body.summary.failed).toBe(1)
      expect(res.body.failures).toHaveLength(1)
      expect(res.body.failures[0].row).toBe(2)
    })

    // docs/superpowers/audit-secrets.md H1 — the flagship reproduction.
    // resolveRow's existence lookups (findByEmployeeId/findByEmail/
    // findByUsername) are globally UNSCOPED, so an actor holding
    // user:create in ONE org unit could learn, for a victim they get 403 on
    // via GET /users/:id: that the employeeId exists at all (routed to the
    // UPDATE branch), AND — given that employeeId — whether a guessed
    // email/username/orgUnitId is correct, one field at a time, since each
    // WRONG guess emitted its own named "cannot be changed" reason
    // alongside the scope rejection, and a CORRECT guess made that reason
    // silently vanish. ~1,500 candidates/request, 2.9s, and (pre the audit
    // row added above) zero trace.
    describe('cross-scope disclosure on a scope-rejected row', () => {
      it('discloses ONLY the scope rejection — no field-mismatch detail about a record the actor cannot read', async () => {
        const root = await makeOrgUnit('Oracle Root')
        const mine = await makeChildOrgUnit(root.id, 'Mine')
        const theirs = await makeChildOrgUnit(root.id, 'Theirs')
        const attacker = await makeActiveUser('attacker', mine.id)
        await grant(attacker.id, 'user_admin', mine.id)
        currentUsername = attacker.username

        const tag = nextTag()
        const victimEmployeeId = `EMP-SECRET-${tag}`
        await usersRepo().create({
          primaryEmail: `victim-${tag}@example.com`,
          username: `victim-${tag}`,
          firstName: 'Victim',
          lastName: 'User',
          orgUnitId: theirs.id,
          employeeId: victimEmployeeId,
        })

        // Every field below is a WRONG guess (the real values are the
        // victim's own, in `theirs` — the attacker cannot see them). Pre-fix,
        // each wrong guess surfaced as its own named reason.
        const csv = buildCsv([
          {
            employeeId: victimEmployeeId,
            primaryEmail: `guess-${tag}@example.com`,
            username: `guessuser-${tag}`,
            firstName: 'A',
            lastName: 'B',
            orgUnitId: mine.id,
          },
        ])

        const res = await request(app.getHttpServer())
          .post('/imports/preview')
          .send({ csv })
          .expect(200)

        expect(res.body.summary.failed).toBe(1)
        const reasons: string[] = res.body.failures[0].reasons

        // THE regression: pre-fix, this row's reasons additionally included
        // "primaryEmail: cannot be changed...", "username: cannot be
        // changed...", and "orgUnitId: cannot be changed..." alongside the
        // scope rejection — confirming all three guesses were wrong. Only
        // the scope/privilege rejection may appear now.
        expect(reasons).toHaveLength(1)
        expect(reasons[0]).toContain('not permitted')
        const joined = reasons.join(' ')
        expect(joined).not.toContain('primaryEmail')
        expect(joined).not.toContain('username')
        expect(joined).not.toContain('orgUnitId')
        expect(joined).not.toContain('cannot be changed')
      })

      // Positive control: the fix narrows DISCLOSURE for an out-of-scope
      // actor, not legitimate error detail for an in-scope one — an admin
      // fixing a real typo in their own org unit still sees exactly which
      // field is wrong.
      it('an in-scope row still reports field-mismatch detail normally', async () => {
        const org = await makeOrgUnit('Oracle InScope Root')
        const actor = await makeActiveUser('inscope-previewer', org.id)
        await grant(actor.id, 'user_admin', org.id)
        currentUsername = actor.username

        const tag = nextTag()
        const employeeId = `EIS-${tag}`
        await usersRepo().create({
          primaryEmail: `inscope-${tag}@example.com`,
          username: `inscope-${tag}`,
          firstName: 'In',
          lastName: 'Scope',
          orgUnitId: org.id,
          employeeId,
        })

        const csv = buildCsv([
          {
            employeeId,
            primaryEmail: `wrong-${tag}@example.com`,
            username: `wronguser-${tag}`,
            firstName: 'In',
            lastName: 'Scope',
            orgUnitId: org.id,
          },
        ])

        const res = await request(app.getHttpServer())
          .post('/imports/preview')
          .send({ csv })
          .expect(200)

        expect(res.body.summary.failed).toBe(1)
        const joined: string = res.body.failures[0].reasons.join(' ')
        expect(joined).toContain('primaryEmail')
        expect(joined).toContain('username')
      })
    })

    // Residual half of the enumeration oracle, left open by fix wave C
    // (fix-wave-c-report.md's own "Concerns" note): resolveCreateRow's
    // findByEmail/findByUsername checks are GLOBAL and UNSCOPED — unlike
    // the update-row case above, scope for a CREATE is checked against the
    // row's OWN target org unit, which genuinely IS in scope here; the
    // leak is that the COLLIDING existing user can be anyone, anywhere,
    // and the old message confirmed exactly who by echoing "already
    // exists" for a guessed value.
    describe('create-row email/username collision no longer confirms an out-of-scope victim (finding, docs/superpowers/fix-wave-c-report.md concerns)', () => {
      it('an in-scope create row naming an out-of-scope victim\'s email gets a non-confirming reason, never "already exists"', async () => {
        const root = await makeOrgUnit('Create Oracle Root')
        const mine = await makeChildOrgUnit(root.id, 'Create Mine')
        const theirs = await makeChildOrgUnit(root.id, 'Create Theirs')
        const attacker = await makeActiveUser('create-attacker', mine.id)
        await grant(attacker.id, 'user_admin', mine.id)
        currentUsername = attacker.username

        const tag = nextTag()
        const victimEmail = `secret-victim-${tag}@example.com`
        await usersRepo().create({
          primaryEmail: victimEmail,
          username: `secret-victim-${tag}`,
          firstName: 'Secret',
          lastName: 'Victim',
          orgUnitId: theirs.id,
        })

        // A genuinely NEW employeeId (never seen before) — this row goes
        // through resolveCreateRow, not resolveUpdateRow — targeting the
        // attacker's OWN in-scope org unit, but GUESSING the victim's real
        // email.
        const csv = buildCsv([row({ orgUnitId: mine.id, primaryEmail: victimEmail })])

        const res = await request(app.getHttpServer())
          .post('/imports/preview')
          .send({ csv })
          .expect(200)

        expect(res.body.summary.failed).toBe(1)
        const reasons: string[] = res.body.failures[0].reasons
        const joined = reasons.join(' ')

        // Still correctly rejected — the row IS un-creatable (a real
        // collision), just without confirming it by name or echoing the
        // guessed value back.
        expect(joined).toContain('primaryEmail')
        expect(joined).not.toContain('already exists')
        expect(joined).not.toContain(victimEmail)
      })

      it('an in-scope create row naming an out-of-scope victim\'s username gets a non-confirming reason, never "already exists"', async () => {
        const root = await makeOrgUnit('Create Oracle Root 2')
        const mine = await makeChildOrgUnit(root.id, 'Create Mine 2')
        const theirs = await makeChildOrgUnit(root.id, 'Create Theirs 2')
        const attacker = await makeActiveUser('create-attacker2', mine.id)
        await grant(attacker.id, 'user_admin', mine.id)
        currentUsername = attacker.username

        const tag = nextTag()
        const victimUsername = `secret-victim-user-${tag}`
        await usersRepo().create({
          primaryEmail: `${victimUsername}@example.com`,
          username: victimUsername,
          firstName: 'Secret',
          lastName: 'Victim',
          orgUnitId: theirs.id,
        })

        const csv = buildCsv([row({ orgUnitId: mine.id, username: victimUsername })])

        const res = await request(app.getHttpServer())
          .post('/imports/preview')
          .send({ csv })
          .expect(200)

        expect(res.body.summary.failed).toBe(1)
        const reasons: string[] = res.body.failures[0].reasons
        const joined = reasons.join(' ')

        expect(joined).toContain('username')
        expect(joined).not.toContain('already exists')
        expect(joined).not.toContain(victimUsername)
      })

      it('commit still correctly refuses to create a row whose email collides, writing no user despite the softer message', async () => {
        const org = await makeOrgUnit('Create Oracle Commit Root')
        const actor = await makeActiveUser('create-commit-actor', org.id)
        await grant(actor.id, 'user_admin', org.id)
        currentUsername = actor.username

        const tag = nextTag()
        const existingEmail = `already-here-${tag}@example.com`
        await usersRepo().create({
          primaryEmail: existingEmail,
          username: `already-here-${tag}`,
          firstName: 'Already',
          lastName: 'Here',
          orgUnitId: org.id,
        })

        const usersBefore = await totalUserCount(ctx)
        const csv = buildCsv([row({ orgUnitId: org.id, primaryEmail: existingEmail })])

        const res = await request(app.getHttpServer()).post('/imports/commit').send({ csv }).expect(200)
        expect(res.body.created).toBe(0)
        expect(res.body.failed).toBe(1)
        expect(res.body.failures[0].reasons.join(' ')).toContain('primaryEmail: not available')
        expect(await totalUserCount(ctx)).toBe(usersBefore)
      })
    })

    it('reports a duplicate employee_id within the same file rather than silently letting the last one win', async () => {
      const org = await makeOrgUnit('Preview Dup Root')
      const actor = await makeActiveUser('dup-previewer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const dupId = `DUP-${nextTag()}`
      const csv = buildCsv([
        row({ employeeId: dupId, orgUnitId: org.id }),
        row({ employeeId: dupId, orgUnitId: org.id }),
      ])

      const res = await request(app.getHttpServer())
        .post('/imports/preview')
        .send({ csv })
        .expect(200)

      expect(res.body.summary.toCreate).toBe(1)
      expect(res.body.summary.failed).toBe(1)
      expect(res.body.toCreate[0].row).toBe(2)
      expect(res.body.failures[0].row).toBe(3)
      expect(res.body.failures[0].reasons.join(' ')).toContain('duplicate')
    })

    it('previews an UPDATE for a row whose employee_id already exists, matched correctly', async () => {
      const org = await makeOrgUnit('Preview Update Root')
      const actor = await makeActiveUser('update-previewer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const tag = nextTag()
      const employeeId = `EU-${tag}`
      const existing = await usersRepo().create({
        primaryEmail: `eu-${tag}@example.com`,
        username: `eu-${tag}`,
        firstName: 'Old',
        lastName: 'Name',
        orgUnitId: org.id,
        employeeId,
      })

      const csv = buildCsv([
        {
          employeeId,
          primaryEmail: `eu-${tag}@example.com`,
          username: `eu-${tag}`,
          firstName: 'New',
          lastName: 'Name',
          orgUnitId: org.id,
        },
      ])

      const res = await request(app.getHttpServer())
        .post('/imports/preview')
        .send({ csv })
        .expect(200)

      expect(res.body.summary.toUpdate).toBe(1)
      expect(res.body.summary.toCreate).toBe(0)
      expect(res.body.toUpdate[0].userId).toBe(existing.id)
    })

    it('400 VALIDATION_FAILED on a malformed CSV (unterminated quote), never a 500', async () => {
      const org = await makeOrgUnit('Preview Malformed Root')
      const actor = await makeActiveUser('malformed-previewer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post('/imports/preview')
        .send({ csv: 'employeeId,primaryEmail,username,firstName,lastName,orgUnitId\n"unterminated' })
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
    })

    it('400 VALIDATION_FAILED when the file is missing a required column entirely', async () => {
      const org = await makeOrgUnit('Preview Missing Header Root')
      const actor = await makeActiveUser('header-previewer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post('/imports/preview')
        .send({ csv: 'employeeId,primaryEmail\nE1,e1@example.com' })
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
    })

    it('400 VALIDATION_FAILED on a completely empty file', async () => {
      const org = await makeOrgUnit('Preview Empty Root')
      const actor = await makeActiveUser('empty-previewer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post('/imports/preview')
        .send({ csv: '' })
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
    })

    it('a header-only file (zero data rows) is a valid, empty preview — not an error', async () => {
      const org = await makeOrgUnit('Preview Header Only Root')
      const actor = await makeActiveUser('header-only-previewer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post('/imports/preview')
        .send({ csv: buildCsv([]) })
        .expect(200)

      expect(res.body.summary).toEqual({ toCreate: 0, toUpdate: 0, failed: 0, total: 0 })
    })

    it('rejects the whole request with 403 for an actor holding no user:create grant anywhere', async () => {
      const org = await makeOrgUnit('Preview No Permission Root')
      const actor = await makeActiveUser('no-perm-previewer', org.id)
      // read_only holds no user:create anywhere.
      await grant(actor.id, 'read_only', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post('/imports/preview')
        .send({ csv: buildCsv([row({ orgUnitId: org.id })]) })
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')
    })

    // docs/superpowers/audit-injection.md HIGH finding: a JSON-escaped NUL
    // (Unicode code point 0) is legal JSON, passes body-parser, every Zod
    // check that existed pre-fix, and csv-parse — it only failed once it
    // reached Postgres as a raw, non-DomainError exception, an unmapped
    // 500. Confirmed live on exactly this endpoint (the "safe, read-only
    // dry run"). Must now fail cleanly as an ordinary per-row validation
    // failure, never a 500.
    it('a NUL character in a CSV cell fails that row cleanly with 200, never a 500', async () => {
      const org = await makeOrgUnit('Preview Nul Cell Root')
      const actor = await makeActiveUser('nul-previewer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const nul = String.fromCharCode(0)
      const csv = buildCsv([row({ orgUnitId: org.id, firstName: `Fi${nul}rst` })])

      const res = await request(app.getHttpServer())
        .post('/imports/preview')
        .send({ csv })
        .expect(200)

      expect(res.body.summary.toCreate).toBe(0)
      expect(res.body.summary.failed).toBe(1)
      expect(res.body.failures[0].reasons.join(' ')).toContain('firstName')
    })
  })

  // =======================================================================
  // POST /imports/commit
  // =======================================================================
  describe('POST /imports/commit', () => {
    it('a 3-row import produces 3 audit rows sharing one batch_id and 3 outbox events', async () => {
      const org = await makeOrgUnit('Commit Batch Root')
      const actor = await makeActiveUser('committer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const csv = buildCsv([
        row({ orgUnitId: org.id }),
        row({ orgUnitId: org.id }),
        row({ orgUnitId: org.id }),
      ])

      const res = await request(app.getHttpServer())
        .post('/imports/commit')
        .send({ csv })
        .expect(200)

      expect(res.body.created).toBe(3)
      expect(res.body.updated).toBe(0)
      expect(res.body.failed).toBe(0)
      expect(typeof res.body.batchId).toBe('string')

      const auditRows = await auditRowsForBatch(ctx, res.body.batchId)
      expect(auditRows).toHaveLength(3)
      expect(auditRows.every((r) => r.action === 'user:create')).toBe(true)
      expect(new Set(auditRows.map((r) => r.batch_id)).size).toBe(1)

      for (const auditRow of auditRows) {
        expect(auditRow.resource_id).not.toBeNull()
        const events = await outboxEventsFor(ctx, auditRow.resource_id as string)
        expect(events).toHaveLength(1)
        expect(events[0].event_type).toBe('created')
        expect(events[0].payload.batchId).toBe(res.body.batchId)
      }
    })

    it('re-running the identical file matches and reports rows unchanged, rather than duplicating OR re-writing them (finding M4, docs/superpowers/audit-integrity.md)', async () => {
      const org = await makeOrgUnit('Commit Idempotent Root')
      const actor = await makeActiveUser('idempotent-committer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const csv = buildCsv([row({ orgUnitId: org.id }), row({ orgUnitId: org.id })])

      const usersBefore = await totalUserCount(ctx)

      const first = await request(app.getHttpServer())
        .post('/imports/commit')
        .send({ csv })
        .expect(200)
      expect(first.body.created).toBe(2)
      expect(first.body.updated).toBe(0)
      expect(first.body.unchanged).toBe(0)
      expect(await totalUserCount(ctx)).toBe(usersBefore + 2)

      const auditBefore = await totalAuditCount(ctx)
      const outboxBefore = await totalOutboxCount(ctx)

      const second = await request(app.getHttpServer())
        .post('/imports/commit')
        .send({ csv })
        .expect(200)
      expect(second.body.created).toBe(0)
      // THE headline M4 regression assertion: pre-fix this was
      // `updated: 2` — a full round of no-op user:update audit rows
      // (before === after) and Keycloak sync events on every re-run of an
      // unchanged file. Every field in this row is IDENTICAL to what run 1
      // already wrote, so nothing should be written a second time.
      expect(second.body.updated).toBe(0)
      expect(second.body.unchanged).toBe(2)
      expect(second.body.failed).toBe(0)

      // No new users were added on the second run — same two rows, matched
      // by employee_id.
      expect(await totalUserCount(ctx)).toBe(usersBefore + 2)
      // ...and, now, no new audit or outbox rows either.
      expect(await totalAuditCount(ctx)).toBe(auditBefore)
      expect(await totalOutboxCount(ctx)).toBe(outboxBefore)

      // Different batch_id per commit request, even though the same file
      // was reused — each run is its own reviewable unit (the batchId
      // itself is still minted even when every row turns out unchanged).
      expect(second.body.batchId).not.toBe(first.body.batchId)
    })

    it('a re-run where ONE row genuinely changed writes exactly one audit/outbox pair, not a full round', async () => {
      const org = await makeOrgUnit('Commit Partial Change Root')
      const actor = await makeActiveUser('partial-committer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const unchangedRow = row({ orgUnitId: org.id })
      const changingRow = row({ orgUnitId: org.id })
      const firstCsv = buildCsv([unchangedRow, changingRow])

      const first = await request(app.getHttpServer())
        .post('/imports/commit')
        .send({ csv: firstCsv })
        .expect(200)
      expect(first.body.created).toBe(2)

      // Re-run with the SAME employeeId for both rows, but a genuinely new
      // jobTitle for only one of them.
      const secondCsv = buildCsv([
        unchangedRow,
        { ...changingRow, jobTitle: 'Genuinely New Title' },
      ])

      const auditBefore = await totalAuditCount(ctx)
      const outboxBefore = await totalOutboxCount(ctx)

      const second = await request(app.getHttpServer())
        .post('/imports/commit')
        .send({ csv: secondCsv })
        .expect(200)

      expect(second.body.created).toBe(0)
      expect(second.body.updated).toBe(1)
      expect(second.body.unchanged).toBe(1)
      expect(second.body.failed).toBe(0)

      // Exactly one new audit row and one new outbox event — for the row
      // that actually changed, never for the one that didn't.
      expect(await totalAuditCount(ctx)).toBe(auditBefore + 1)
      expect(await totalOutboxCount(ctx)).toBe(outboxBefore + 1)
    })

    it('a file mixing valid and invalid rows commits the valid ones and reports the rest — never a whole-batch rollback', async () => {
      const org = await makeOrgUnit('Commit Mixed Root')
      const actor = await makeActiveUser('mixed-committer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const goodTag = nextTag()
      const csv = buildCsv([
        row({ orgUnitId: org.id }), // valid
        row({ orgUnitId: '00000000-0000-0000-0000-000000000000' }), // bad org unit
        {
          // invalid: missing required firstName
          employeeId: `E-${goodTag}`,
          primaryEmail: `${goodTag}@example.com`,
          username: `user-${goodTag}`,
          firstName: '',
          lastName: 'Last',
          orgUnitId: org.id,
        },
      ])

      const usersBefore = await totalUserCount(ctx)

      const res = await request(app.getHttpServer())
        .post('/imports/commit')
        .send({ csv })
        .expect(200)

      expect(res.body.created).toBe(1)
      expect(res.body.failed).toBe(2)
      expect(res.body.failures).toHaveLength(2)
      expect(await totalUserCount(ctx)).toBe(usersBefore + 1)
    })

    it('an out-of-scope row commits nothing for that row, while an in-scope row in the same file still commits', async () => {
      const root = await makeOrgUnit('Commit Scope Root')
      const scopeOrg = await makeChildOrgUnit(root.id, 'In Scope')
      const otherOrg = await makeChildOrgUnit(root.id, 'Out Of Scope')
      const actor = await makeActiveUser('scoped-committer', scopeOrg.id)
      await grant(actor.id, 'user_admin', scopeOrg.id)
      currentUsername = actor.username

      const outOfScopeRow = row({ orgUnitId: otherOrg.id })
      const csv = buildCsv([row({ orgUnitId: scopeOrg.id }), outOfScopeRow])

      const usersBefore = await totalUserCount(ctx)
      const auditBefore = await totalAuditCount(ctx)

      const res = await request(app.getHttpServer())
        .post('/imports/commit')
        .send({ csv })
        .expect(200)

      expect(res.body.created).toBe(1)
      expect(res.body.failed).toBe(1)
      expect(res.body.failures[0].employeeId).toBe(outOfScopeRow.employeeId)

      // Exactly one user + one audit row landed — the out-of-scope row wrote nothing.
      expect(await totalUserCount(ctx)).toBe(usersBefore + 1)
      expect(await totalAuditCount(ctx)).toBe(auditBefore + 1)

      const stillAbsent = await usersRepo().findByEmployeeId(outOfScopeRow.employeeId)
      expect(stillAbsent).toBeNull()
    })

    it('400 VALIDATION_FAILED on a malformed CSV, and writes nothing', async () => {
      const org = await makeOrgUnit('Commit Malformed Root')
      const actor = await makeActiveUser('malformed-committer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const usersBefore = await totalUserCount(ctx)

      const res = await request(app.getHttpServer())
        .post('/imports/commit')
        .send({ csv: 'employeeId,primaryEmail,username,firstName,lastName,orgUnitId\n"unterminated' })
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
      expect(await totalUserCount(ctx)).toBe(usersBefore)
    })

    it('rejects the whole request with 403 for an actor holding no user:create grant anywhere, and writes nothing', async () => {
      const org = await makeOrgUnit('Commit No Permission Root')
      const actor = await makeActiveUser('no-perm-committer', org.id)
      await grant(actor.id, 'read_only', org.id)
      currentUsername = actor.username

      const usersBefore = await totalUserCount(ctx)

      const res = await request(app.getHttpServer())
        .post('/imports/commit')
        .send({ csv: buildCsv([row({ orgUnitId: org.id })]) })
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')
      expect(await totalUserCount(ctx)).toBe(usersBefore)
    })

    it('rejects a help_desk (holds no user:create) even though it holds user:update', async () => {
      const org = await makeOrgUnit('Commit Help Desk Root')
      const actor = await makeActiveUser('help-desk-committer', org.id)
      await grant(actor.id, 'help_desk', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post('/imports/commit')
        .send({ csv: buildCsv([row({ orgUnitId: org.id })]) })
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')
    })

    it('a row with a non-resolvable manager is reported as a failure and commits nothing for that row', async () => {
      const org = await makeOrgUnit('Commit Manager Root')
      const actor = await makeActiveUser('manager-committer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const csv = buildCsv([
        row({ orgUnitId: org.id, managerId: '00000000-0000-0000-0000-000000000000' }),
      ])

      const res = await request(app.getHttpServer())
        .post('/imports/commit')
        .send({ csv })
        .expect(200)

      expect(res.body.created).toBe(0)
      expect(res.body.failed).toBe(1)
      expect(res.body.failures[0].reasons.join(' ')).toContain('manager')
    })

    it('rejects changing an existing user\'s org unit via re-import as a named failure, not a silent no-op success', async () => {
      const org = await makeOrgUnit('Commit OrgUnit Change Root')
      const otherOrg = await makeOrgUnit('Commit OrgUnit Change Other')
      const actor = await makeActiveUser('orgchange-committer', org.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      const tag = nextTag()
      const employeeId = `EOC-${tag}`
      await usersRepo().create({
        primaryEmail: `eoc-${tag}@example.com`,
        username: `eoc-${tag}`,
        firstName: 'Static',
        lastName: 'User',
        orgUnitId: org.id,
        employeeId,
      })

      const csv = buildCsv([
        {
          employeeId,
          primaryEmail: `eoc-${tag}@example.com`,
          username: `eoc-${tag}`,
          firstName: 'Static',
          lastName: 'User',
          orgUnitId: otherOrg.id, // attempts to move org units
        },
      ])

      const res = await request(app.getHttpServer())
        .post('/imports/commit')
        .send({ csv })
        .expect(200)

      expect(res.body.updated).toBe(0)
      expect(res.body.failed).toBe(1)
      expect(res.body.failures[0].reasons.join(' ')).toContain('orgUnitId')
    })

    it('updates only fields the CSV states, going through the real UsersRepository.update path (audit before/after prove it)', async () => {
      const org = await makeOrgUnit('Commit Update Fields Root')
      const actor = await makeActiveUser('update-fields-committer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const tag = nextTag()
      const employeeId = `EUF-${tag}`
      const existing = await usersRepo().create({
        primaryEmail: `euf-${tag}@example.com`,
        username: `euf-${tag}`,
        firstName: 'Old',
        lastName: 'Name',
        orgUnitId: org.id,
        employeeId,
        jobTitle: 'Old Title',
      })

      const csv = buildCsv([
        {
          employeeId,
          primaryEmail: `euf-${tag}@example.com`,
          username: `euf-${tag}`,
          firstName: 'New',
          lastName: 'Name',
          orgUnitId: org.id,
          jobTitle: 'New Title',
        },
      ])

      const res = await request(app.getHttpServer())
        .post('/imports/commit')
        .send({ csv })
        .expect(200)
      expect(res.body.updated).toBe(1)

      const rows = await auditRowsFor(ctx, existing.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].action).toBe('user:update')
      expect(rows[0].before?.jobTitle).toBe('Old Title')
      expect(rows[0].after?.jobTitle).toBe('New Title')
      expect(rows[0].after?.firstName).toBe('New')
    })

    // Finding L-3 (docs/superpowers/audit-authz.md): resolveUpdateRow used
    // to narrow with 'user:create', not 'user:update' — a route/action
    // mismatch, not exploitable today (every role holding 'user:create'
    // also holds 'user:update' — see ROLE_PERMISSIONS in authz/actions.ts —
    // and this whole controller is gated on 'user:create' at PermissionGuard
    // besides, so there is no role that can reach an update row with
    // 'user:create' but not 'user:update' to prove a live 403 either way).
    // Pinned directly instead, by spying on the REAL PermissionEngine
    // instance this module wires into ImportsController and recording the
    // exact action string each row is narrowed with — a single request
    // mixing a CREATE row and an UPDATE row must produce one call with
    // EACH action, never 'user:create' for the update row.
    it('narrows a CREATE row with user:create and an UPDATE row with user:update, never the other way around', async () => {
      const org = await makeOrgUnit('L3 Action Root')
      const actor = await makeActiveUser('l3-committer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const tag = nextTag()
      const updateEmployeeId = `L3U-${tag}`
      await usersRepo().create({
        primaryEmail: `l3u-${tag}@example.com`,
        username: `l3u-${tag}`,
        firstName: 'Old',
        lastName: 'Name',
        orgUnitId: org.id,
        employeeId: updateEmployeeId,
      })

      const csv = buildCsv([
        row({ orgUnitId: org.id }), // CREATE row — a fresh employeeId
        {
          // UPDATE row — matches the existing employeeId above
          employeeId: updateEmployeeId,
          primaryEmail: `l3u-${tag}@example.com`,
          username: `l3u-${tag}`,
          firstName: 'New',
          lastName: 'Name',
          orgUnitId: org.id,
        },
      ])

      const spy = vi.spyOn(engine, 'assertCanIn')
      try {
        const res = await request(app.getHttpServer())
          .post('/imports/commit')
          .send({ csv })
          .expect(200)
        expect(res.body.created).toBe(1)
        expect(res.body.updated).toBe(1)

        // Exactly one assertCanIn call per row, in the SAME order
        // resolveRow processes them (row 1 = CREATE, row 2 = UPDATE — see
        // commit()'s own sequential `for` loop) — checked by call order, not
        // merely "both actions appeared somewhere," which is what pins the
        // fix to the RIGHT row rather than coincidentally passing if both
        // branches used the same (wrong) action.
        expect(spy.mock.calls).toHaveLength(2)
        expect(spy.mock.calls[0][1]).toBe('user:create') // the CREATE row
        expect(spy.mock.calls[1][1]).toBe('user:update') // the UPDATE row — was 'user:create' pre-fix
      } finally {
        spy.mockRestore()
      }
    })

    it('blocks a help_desk-ranked actor from using import to touch a super_admin, even in scope (privilege guard, not scope)', async () => {
      const org = await makeOrgUnit('Commit Privilege Root')
      const helper = await makeActiveUser('priv-helper', org.id)
      // help_desk does not hold user:create at all (would 403 at the route
      // gate, already covered above) — user_admin does hold it, but still
      // ranks below super_admin, isolating this test to the PRIVILEGE guard.
      await grant(helper.id, 'user_admin', org.id)
      const boss = await makeActiveUser('priv-boss', org.id)
      await grant(boss.id, 'super_admin', null)
      currentUsername = helper.username

      // employeeId must match for an UPDATE match — boss has none set yet,
      // so give boss one via a direct repository write first.
      const bossWithEmployeeId = await usersRepo().update(boss.id, {
        employeeId: `BOSS-${nextTag()}`,
      })

      const csv = buildCsv([
        {
          employeeId: bossWithEmployeeId.employeeId as string,
          primaryEmail: boss.primaryEmail,
          username: boss.username,
          firstName: 'Should',
          lastName: 'NotWork',
          orgUnitId: org.id,
        },
      ])

      const res = await request(app.getHttpServer())
        .post('/imports/commit')
        .send({ csv })
        .expect(200)

      expect(res.body.updated).toBe(0)
      expect(res.body.failed).toBe(1)
      expect(await auditRowsFor(ctx, boss.id)).toHaveLength(0)
    })

    it('supports a custom attribute column, validated against an active definition', async () => {
      const org = await makeOrgUnit('Commit Attribute Root')
      const actor = await makeActiveUser('attr-committer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      await ctx.db.insert(attributeDefinitions).values({
        key: 'costCenter',
        label: 'Cost Center',
        dataType: 'string',
        required: false,
        appliesTo: 'user',
        isActive: true,
      })

      const csv = buildCsv([row({ orgUnitId: org.id, costCenter: 'CC-42' })])

      const res = await request(app.getHttpServer())
        .post('/imports/commit')
        .send({ csv })
        .expect(200)
      expect(res.body.created).toBe(1)
      expect(res.body.failed).toBe(0)
    })

    it('reports an unrecognized attribute column by name rather than silently dropping it', async () => {
      const org = await makeOrgUnit('Commit Unknown Attribute Root')
      const actor = await makeActiveUser('unknown-attr-committer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const csv = buildCsv([row({ orgUnitId: org.id, mysteryColumn: 'x' })])

      const res = await request(app.getHttpServer())
        .post('/imports/commit')
        .send({ csv })
        .expect(200)
      expect(res.body.created).toBe(0)
      expect(res.body.failed).toBe(1)
      expect(res.body.failures[0].reasons.join(' ')).toContain('mysteryColumn')
    })

    // docs/superpowers/audit-injection.md HIGH finding — the fourth
    // recurrence of this project's prototype-chain defect class, this time
    // as silent key ELISION rather than pollution. Pre-fix: a CSV column
    // literally named "__proto__" was silently discarded while the file
    // still counted as "has extra headers", so the matched row's attributes
    // were validated as {} (nothing failed) and UsersRepository.update wrote
    // that {} WHOLESALE, destroying every existing custom attribute while
    // reporting a clean 200 {updated:1, failed:0} — worse than the
    // "mysteryColumn" control immediately above, which correctly fails the
    // row. The bug was SILENT DATA DESTRUCTION reported as success, so this
    // test does not stop at the status code: it asserts the stored
    // attributes are byte-for-byte unchanged.
    it('a CSV column named "__proto__" fails the row instead of silently wiping the matched user\'s attributes to {}', async () => {
      const org = await makeOrgUnit('Proto Header Root')
      const actor = await makeActiveUser('proto-committer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const tag = nextTag()
      const employeeId = `EPROTO-${tag}`
      const originalAttributes = { deptA: 'Finance', costA: 'CC-42' }
      const existing = await usersRepo().create({
        primaryEmail: `proto-${tag}@example.com`,
        username: `proto-${tag}`,
        firstName: 'Before',
        lastName: 'Attack',
        orgUnitId: org.id,
        employeeId,
        attributes: originalAttributes,
      })
      expect(existing.attributes).toEqual(originalAttributes)

      // Hand-written CSV text, matching the audit's own reproduction. Built
      // as a plain string (never via buildCsv()'s row-object helper): the
      // __proto__ hazard lives entirely inside csv.ts's own header-to-row
      // zip, which only exists once this text is tokenized server-side — at
      // the wire level a CSV file is just text, so there is no JS
      // object-literal subtlety to route around here.
      const csv =
        'employeeId,primaryEmail,username,firstName,lastName,orgUnitId,__proto__\n' +
        `${employeeId},${existing.primaryEmail},${existing.username},F,L,${org.id},anything`

      const res = await request(app.getHttpServer())
        .post('/imports/commit')
        .send({ csv })
        .expect(200)

      // Pre-fix this was {updated: 1, failed: 0}. A __proto__ column must
      // fail the row exactly like the "mysteryColumn" control case above —
      // never succeed silently.
      expect(res.body.created).toBe(0)
      expect(res.body.updated).toBe(0)
      expect(res.body.failed).toBe(1)
      expect(res.body.failures[0].employeeId).toBe(employeeId)
      expect(res.body.failures[0].reasons.join(' ')).toContain('__proto__')

      // THE regression check that matters: the user's attributes must be
      // completely untouched. A test that only checked failed:1 above would
      // miss a recurrence where the row is correctly rejected for some
      // OTHER reason while still, separately, wiping attributes as a side
      // effect (they are two different code paths — resolveRow's rejection
      // vs. UsersRepository.update's write).
      const reloaded = await usersRepo().findById(existing.id)
      expect(reloaded?.attributes).toEqual(originalAttributes)

      // And genuinely no prototype pollution occurred either, while here.
      expect(Object.getOwnPropertyNames(Object.prototype)).not.toContain('anything')
    })

    // docs/superpowers/audit-injection.md HIGH finding — the "sharp end":
    // pre-fix, a NUL in row 2 of a 3-row commit left row 1 already
    // committed, row 3 never attempted, and returned a bare 500 with NO
    // batchId — the admin could not even identify what had been written.
    // The root-cause fix (import-row.ts's shapeSchema now rejects a NUL
    // before any row resolves to a create/update) means row 2 is now a
    // clean per-row FAILURE from resolveRow itself, so rows 1 and 3 commit
    // normally in the same request.
    it('a NUL character in one row does not abort the batch — the other rows still commit and batchId is always returned', async () => {
      const org = await makeOrgUnit('Commit Nul Sharp End Root')
      const actor = await makeActiveUser('nul-committer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const nul = String.fromCharCode(0)
      const usersBefore = await totalUserCount(ctx)

      const csv = buildCsv([
        row({ orgUnitId: org.id }), // row 1: valid
        row({ orgUnitId: org.id, firstName: `Fi${nul}rst` }), // row 2: NUL
        row({ orgUnitId: org.id }), // row 3: valid
      ])

      const res = await request(app.getHttpServer())
        .post('/imports/commit')
        .send({ csv })
        .expect(200)

      expect(typeof res.body.batchId).toBe('string')
      expect(res.body.created).toBe(2)
      expect(res.body.failed).toBe(1)
      expect(res.body.failures[0].row).toBe(3) // CSV row 2 -> rowNumber 3 (header + 1-based)
      expect(res.body.failures[0].reasons.join(' ')).toContain('firstName')

      expect(await totalUserCount(ctx)).toBe(usersBefore + 2)
    })

    // Separate from the root-cause fix above: this pins the DEFENSIVE fix
    // (writeAttemptFailureReasons in imports.controller.ts) directly, for
    // ANY unexpected error reached during the actual WRITE attempt — not
    // just the NUL case, which the root-cause fix now intercepts earlier
    // and therefore never reaches this code path at all. Simulates a raw,
    // non-DomainError infrastructure failure (exactly the shape a `pg`
    // encoding error had) on the SECOND row's write by spying on the real
    // UsersRepository instance the compiled module wires into
    // ImportsController.
    it('an unexpected non-DomainError during a row write does not abort the batch — batchId and every other row\'s outcome are still returned', async () => {
      const org = await makeOrgUnit('Commit Unexpected Error Root')
      const actor = await makeActiveUser('unexpected-committer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const usersBefore = await totalUserCount(ctx)
      const csv = buildCsv([
        row({ orgUnitId: org.id }),
        row({ orgUnitId: org.id }),
        row({ orgUnitId: org.id }),
      ])

      const realCreate = usersRepository.create.bind(usersRepository)
      let callCount = 0
      const spy = vi
        .spyOn(usersRepository, 'create')
        .mockImplementation(async (input, db) => {
          callCount += 1
          if (callCount === 2) {
            // A raw Error, deliberately NOT a DomainError — simulates an
            // infrastructure failure translateWriteError does not
            // recognize (pre-fix, this is exactly what a NUL-encoding `pg`
            // error looked like to this code path).
            throw new Error('simulated infrastructure failure')
          }
          return realCreate(input, db)
        })

      try {
        const res = await request(app.getHttpServer())
          .post('/imports/commit')
          .send({ csv })
          .expect(200)

        // THE regression: pre-fix, a non-DomainError here was RETHROWN out
        // of the per-row loop (domainErrorReasons' rethrow-on-unknown
        // behaviour), aborting the whole request as an unmapped 500 with
        // NO batchId — losing the only handle on what the first row had
        // already committed.
        expect(typeof res.body.batchId).toBe('string')
        expect(res.body.created).toBe(2)
        expect(res.body.failed).toBe(1)
        expect(res.body.failures).toHaveLength(1)
        expect(res.body.failures[0].row).toBe(3) // the 2nd CSV row -> rowNumber 3

        // The raw error message is logged server-side, never echoed to the
        // caller — see writeAttemptFailureReasons' own doc comment.
        expect(res.body.failures[0].reasons.join(' ')).not.toContain('simulated')

        // Rows 1 and 3 genuinely committed despite row 2's failure.
        expect(await totalUserCount(ctx)).toBe(usersBefore + 2)
      } finally {
        spy.mockRestore()
      }
    })
  })
})

/**
 * Finding M6 (docs/superpowers/audit-integrity.md): "no explicit row-count
 * or file-size cap" — the practical ceiling before this fix was ~800 rows,
 * an ACCIDENT of express's own default 100 KiB body limit, not a control
 * anyone chose. A SEPARATE, small Nest app (its own `IMPORTS_CONFIG`
 * provider set to `maxRows: 3`) rather than reusing the main describe
 * block's app above — the point of this cap is to be CONFIGURABLE, and a
 * tiny configured value here proves the wiring without generating a
 * multi-thousand-row CSV just to cross the real production default.
 */
describe('bulk import row-count cap (finding M6, docs/superpowers/audit-integrity.md)', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let currentUsername = ''
  let orgUnitId: string

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ImportsController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        { provide: IMPORTS_CONFIG, useValue: { maxRows: 3 } },
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

    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`Import Cap Root ${Date.now()}`)).id
  })

  afterAll(async () => {
    await app?.close()
  })

  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `impcap${fixtureSeq}`
  }

  async function makeActiveAdmin(): Promise<User> {
    const tag = nextTag()
    const usersRepository = new UsersRepository(ctx.db)
    const created = await usersRepository.create({
      primaryEmail: `${tag}@example.com`,
      username: `impcap-${tag}`,
      firstName: 'Cap',
      lastName: 'Admin',
      orgUnitId,
    })
    const active = await usersRepository.changeStatus(created.id, 'active')
    await new RoleAssignmentsRepository(ctx.db).assign({
      userId: active.id,
      roleKey: 'user_admin',
      scopeOrgUnitId: orgUnitId,
    })
    return active
  }

  function csvRow(tag: string): Record<string, string> {
    return {
      employeeId: `E-${tag}`,
      primaryEmail: `${tag}@example.com`,
      username: `user-${tag}`,
      firstName: 'First',
      lastName: 'Last',
      orgUnitId,
    }
  }

  async function totalAuditCount(): Promise<number> {
    const { rows } = await ctx.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM audit_log')
    return rows[0]?.count ?? 0
  }
  async function totalOutboxCount(): Promise<number> {
    const { rows } = await ctx.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM outbox_events')
    return rows[0]?.count ?? 0
  }
  async function totalUserCount(): Promise<number> {
    const { rows } = await ctx.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM users')
    return rows[0]?.count ?? 0
  }

  it('POST /imports/commit rejects a file over the configured row cap, 400 naming both counts, before any row is touched', async () => {
    const admin = await makeActiveAdmin()
    currentUsername = admin.username

    const rows = [1, 2, 3, 4].map((n) => csvRow(`over-${nextTag()}-${n}`))
    const csv = buildCsv(rows)

    const auditBefore = await totalAuditCount()
    const outboxBefore = await totalOutboxCount()
    const usersBefore = await totalUserCount()

    const res = await request(app.getHttpServer()).post('/imports/commit').send({ csv }).expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
    expect(res.body.issues.join(' ')).toContain('4') // actual
    expect(res.body.issues.join(' ')).toContain('3') // configured max

    // Rejected before any row is touched — zero audit rows, zero outbox
    // events, zero users created, exactly like every other whole-request
    // rejection this codebase already guarantees (missing header, bad
    // permission, malformed CSV).
    expect(await totalAuditCount()).toBe(auditBefore)
    expect(await totalOutboxCount()).toBe(outboxBefore)
    expect(await totalUserCount()).toBe(usersBefore)
  })

  it('POST /imports/preview is ALSO rejected over the cap — the whole request, not just commit — writing no invocation audit row either', async () => {
    const admin = await makeActiveAdmin()
    currentUsername = admin.username
    const rows = [1, 2, 3, 4].map((n) => csvRow(`prevover-${nextTag()}-${n}`))
    const csv = buildCsv(rows)

    const auditBefore = await totalAuditCount()
    const res = await request(app.getHttpServer()).post('/imports/preview').send({ csv }).expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')

    // preview's own invocation-level audit row (audit-secrets.md H1) is
    // written only once parseAndPrepare has already SUCCEEDED — the row
    // cap check lives inside parseAndPrepare, so a request rejected by it
    // must not reach that write either.
    expect(await totalAuditCount()).toBe(auditBefore)
  })

  it('a file at exactly the configured cap is accepted, not rejected off-by-one', async () => {
    const admin = await makeActiveAdmin()
    currentUsername = admin.username
    const rows = [1, 2, 3].map((n) => csvRow(`atcap-${nextTag()}-${n}`))
    const csv = buildCsv(rows)

    const res = await request(app.getHttpServer()).post('/imports/commit').send({ csv }).expect(200)
    expect(res.body.created).toBe(3)
    expect(res.body.failed).toBe(0)
  })
})
