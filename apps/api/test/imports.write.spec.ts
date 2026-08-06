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
import { attributeDefinitions } from '../src/db/schema/attribute-definitions'
import { ImportsController } from '../src/imports/imports.controller'
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
    it('writes NOTHING — user, audit and outbox counts all unchanged — even for otherwise-valid rows', async () => {
      const org = await makeOrgUnit('Preview Root')
      const actor = await makeActiveUser('previewer', org.id)
      await grant(actor.id, 'user_admin', org.id)
      currentUsername = actor.username

      const usersBefore = await totalUserCount(ctx)
      const auditBefore = await totalAuditCount(ctx)
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
      expect(await totalAuditCount(ctx)).toBe(auditBefore)
      expect(await totalOutboxCount(ctx)).toBe(outboxBefore)
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

    it('re-running the identical file updates rather than duplicating', async () => {
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
      expect(await totalUserCount(ctx)).toBe(usersBefore + 2)

      const second = await request(app.getHttpServer())
        .post('/imports/commit')
        .send({ csv })
        .expect(200)
      expect(second.body.created).toBe(0)
      expect(second.body.updated).toBe(2)
      expect(second.body.failed).toBe(0)

      // No new users were added on the second run — same two rows, matched
      // and updated by employee_id.
      expect(await totalUserCount(ctx)).toBe(usersBefore + 2)

      // Different batch_id per commit request, even though the same file
      // was reused — each run is its own reviewable unit.
      expect(second.body.batchId).not.toBe(first.body.batchId)
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
  })
})
