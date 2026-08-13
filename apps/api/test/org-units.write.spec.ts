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
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { OrgUnitsController } from '../src/org-units/org-units.controller'
import { OrgUnitsRepository, type OrgUnit } from '../src/org-units/org-units.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { UsersRepository } from '../src/users/users.repository'
import { type TestDatabase, withTestDatabase } from './support/pg'

/**
 * Stamps `request.principal` from whatever `getUsername()` returns AT
 * REQUEST TIME — same technique as users.write.spec.ts / scope-narrowing.spec.ts.
 */
function stubJwtGuard(getUsername: () => string): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
        subject: 'kc-orgunit-write-test',
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
 * Scoped to a specific resource_id, never "the newest row" or a table
 * count — same reasoning as users.write.spec.ts's file-level comment: audit
 * rows can never be deleted, so this file cannot reset between tests.
 */
async function auditRowsFor(ctx: TestDatabase, resourceId: string): Promise<AuditLogRow[]> {
  const { rows } = await ctx.pool.query<AuditLogRow>(
    "SELECT * FROM audit_log WHERE resource_type = 'org_unit' AND resource_id = $1 ORDER BY id ASC",
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
 * MILESTONE 3b, TASK 3: org.unit write endpoints. Same audit-FK isolation
 * constraint as users.write.spec.ts (see its file-level comment for the
 * full explanation) — this file never does `DELETE FROM users` or
 * `DELETE FROM org_units` between tests. Every fixture is uniquely named
 * per call (`nextTag()`), rows accumulate for the life of the file's own
 * Testcontainer, and every assertion is scoped to the specific
 * resource/org-unit each test created.
 *
 * Only `super_admin` holds `org_unit:create` in the static role catalog
 * (ROLE_PERMISSIONS in authz/actions.ts) — unlike users/groups, no
 * lower-privileged role grants it. Every actor fixture below is therefore
 * `super_admin`, either GLOBAL (`scopeOrgUnitId: null`) or SCOPED to a
 * specific org unit, exactly as the individual test requires; a role
 * assignment's scope is independent of the role's identity (see
 * RoleAssignmentsRepository.assign — `scopeOrgUnitId` is a free parameter),
 * so a "scoped super_admin" is an ordinary, already-exercised concept in
 * this codebase, not a special case invented for this file.
 */
describe('org unit write endpoints (Milestone 3b, Task 3)', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let currentUsername = ''

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrgUnitsController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        OrgUnitsRepository,
        PermissionEngine,
        PermissionGuard,
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

  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `ouwr${fixtureSeq}`
  }

  const orgUnitsRepo = () => new OrgUnitsRepository(ctx.db)
  const usersRepo = () => new UsersRepository(ctx.db)
  const rolesRepo = () => new RoleAssignmentsRepository(ctx.db)

  async function makeOrgUnit(label: string): Promise<OrgUnit> {
    return orgUnitsRepo().createRoot(`${label} ${nextTag()}`)
  }

  async function makeActiveUser(role: string, orgUnitId: string) {
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

  // =======================================================================
  // POST /org-units
  // =======================================================================
  describe('POST /org-units', () => {
    /**
     * Organizations multi-tenancy, Task 7. This used to be the happy path
     * for a GLOBAL actor. A root org unit is now the thing an ORGANIZATION
     * owns — exactly one, created by creating the organization — so there
     * is no route that makes one, not even for a super admin. The actor
     * here holds an UNRESTRICTED grant precisely so the 400 cannot be
     * mistaken for an authorization outcome.
     */
    it('rejects a root org unit — roots come only from creating an organization', async () => {
      const bootstrap = await makeOrgUnit('Bootstrap')
      const actor = await makeActiveUser('global-creator', bootstrap.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      const before = await totalAuditCount(ctx)

      const res = await request(app.getHttpServer())
        .post('/org-units')
        .send({ name: `Root ${nextTag()}` })
        .expect(400)

      expect(res.body.code).toBe('VALIDATION_FAILED')
      expect(res.body.issues.join(' ')).toContain('parentId')

      expect(await totalAuditCount(ctx)).toBe(before)
    })

    it('creates a CHILD for an actor scoped to the parent and writes exactly one audit row', async () => {
      const root = await makeOrgUnit('Scoped Parent Root')
      const actor = await makeActiveUser('scoped-creator', root.id)
      await grant(actor.id, 'super_admin', root.id) // SCOPED, not global
      currentUsername = actor.username

      const tag = nextTag()
      const res = await request(app.getHttpServer())
        .post('/org-units')
        .send({ name: `Child ${tag}`, parentId: root.id })
        .expect(201)

      expect(res.body.parentId).toBe(root.id)
      expect(res.body.path).toBe(`${root.path}.${res.body.path.split('.').pop()}`)

      const rows = await auditRowsFor(ctx, res.body.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].action).toBe('org_unit:create')
      expect(rows[0].after?.parentId).toBe(root.id)
    })

    /**
     * The same request from a SCOPED actor. It used to be a 403 (creating a
     * root required a GLOBAL grant); since Task 7 it is a 400, and the
     * change of code is the point: the request is now malformed for
     * everybody, so nobody's grant is consulted and no oracle exists about
     * what a wider grant would have been allowed to do.
     */
    it('rejects a root for a SCOPED actor too, as a 400 and not a 403, and writes no audit row', async () => {
      const root = await makeOrgUnit('No Root For Scoped')
      const actor = await makeActiveUser('scoped-creator', root.id)
      await grant(actor.id, 'super_admin', root.id)
      currentUsername = actor.username

      const before = await totalAuditCount(ctx)
      const tag = nextTag()

      const res = await request(app.getHttpServer())
        .post('/org-units')
        .send({ name: `Should Not Exist ${tag}` })
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')

      expect(await totalAuditCount(ctx)).toBe(before)
    })

    it('rejects creating a CHILD under an out-of-scope parent with 403 and writes no audit row', async () => {
      const root = await makeOrgUnit('Scope Root')
      const scopeOrg = await orgUnitsRepo().createChild(root.id, `In Scope ${nextTag()}`)
      const otherOrg = await orgUnitsRepo().createChild(root.id, `Out Of Scope ${nextTag()}`)
      const actor = await makeActiveUser('scoped-creator', scopeOrg.id)
      await grant(actor.id, 'super_admin', scopeOrg.id)
      currentUsername = actor.username

      const before = await totalAuditCount(ctx)
      const tag = nextTag()

      const res = await request(app.getHttpServer())
        .post('/org-units')
        .send({ name: `Blocked ${tag}`, parentId: otherOrg.id })
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await totalAuditCount(ctx)).toBe(before)
    })

    // A GLOBAL actor deliberately: a SCOPED actor given a bogus parentId
    // gets 403 from assertCanIn (the containment query finds no row,
    // indistinguishable from "exists but out of scope"), never reaching
    // createChild's own pre-check — same reasoning as
    // users.write.spec.ts's bogus-orgUnitId test. Here the 404 actually
    // comes from OrgUnitsRepository.createChild's own explicit
    // `findById(parentId)` pre-check, not constraint translation — see its
    // doc comment.
    it('maps a nonexistent parentId to 404 NOT_FOUND rather than an unmapped 500', async () => {
      const bootstrap = await makeOrgUnit('Bogus Parent Root')
      const actor = await makeActiveUser('global-creator', bootstrap.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      const before = await totalAuditCount(ctx)
      const tag = nextTag()

      const res = await request(app.getHttpServer())
        .post('/org-units')
        .send({ name: `Ghost ${tag}`, parentId: BOGUS_ID })
        .expect(404)
      expect(res.body.code).toBe('NOT_FOUND')
      expect(res.body.message).toContain('parent org unit')

      expect(await totalAuditCount(ctx)).toBe(before)
    })

    it('rejects a malformed body with 400 VALIDATION_FAILED and writes no audit row', async () => {
      const bootstrap = await makeOrgUnit('Validation Root')
      const actor = await makeActiveUser('creator', bootstrap.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      const before = await totalAuditCount(ctx)

      const res = await request(app.getHttpServer())
        .post('/org-units')
        .send({ parentId: bootstrap.id }) // missing required `name`
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')

      expect(await totalAuditCount(ctx)).toBe(before)
    })

    // docs/archive/audits/audit-injection.md HIGH finding: a JSON-escaped NUL
    // (Unicode code point 0) is legal JSON and passed every check that
    // existed pre-fix (body-parser, Zod's .min()/.max()), only failing once
    // it reached Postgres as a raw, non-DomainError exception — an unmapped
    // 500. Confirmed live on exactly this endpoint. Must now be a clean 400
    // naming the field, before the value can ever reach the driver.
    it('rejects a NUL character in "name" with 400 VALIDATION_FAILED naming the field, never an unmapped 500', async () => {
      const bootstrap = await makeOrgUnit('Nul Validation Root')
      const actor = await makeActiveUser('nul-creator', bootstrap.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      const before = await totalAuditCount(ctx)
      const nul = String.fromCharCode(0)

      const res = await request(app.getHttpServer())
        .post('/org-units')
        // `parentId` supplied since Task 7 made it required, so the ONLY
        // thing wrong with this body is the NUL in `name` — otherwise this
        // test would pass on the strength of the missing parent instead.
        .send({ name: `nul${nul}test`, parentId: bootstrap.id })
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
      expect(res.body.issues.join(' ')).toContain('name')

      expect(await totalAuditCount(ctx)).toBe(before)
    })

    it('rejects two siblings that resolve to the same label with 409 CONFLICT, and the failed attempt writes no audit row', async () => {
      const parent = await makeOrgUnit('Duplicate Sibling Root')
      const actor = await makeActiveUser('creator', parent.id)
      await grant(actor.id, 'super_admin', parent.id)
      currentUsername = actor.username

      const tag = nextTag()
      const name = `Duplicate Name ${tag}`

      const first = await request(app.getHttpServer())
        .post('/org-units')
        .send({ name, parentId: parent.id })
        .expect(201)
      expect(await auditRowsFor(ctx, first.body.id)).toHaveLength(1)

      const before = await totalAuditCount(ctx)
      const res = await request(app.getHttpServer())
        .post('/org-units')
        .send({ name, parentId: parent.id })
        .expect(409)
      expect(res.body.code).toBe('CONFLICT')
      expect(res.body.message).toContain(name)

      expect(await totalAuditCount(ctx)).toBe(before)
    })
  })

  // =======================================================================
  // No delete, ever.
  // =======================================================================
  describe('DELETE /org-units/:id', () => {
    it('does not exist — 404', async () => {
      await request(app.getHttpServer()).delete(`/org-units/${BOGUS_ID}`).expect(404)
    })
  })

  // =======================================================================
  // Redaction: audit payloads are built from named fields, not `{ ...row }`.
  // =======================================================================
  describe('audit payload construction', () => {
    it('never carries a credential-shaped key in before/after, even scanned as raw JSON', async () => {
      const bootstrap = await makeOrgUnit('Redaction Root')
      const actor = await makeActiveUser('creator', bootstrap.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      const tag = nextTag()
      const res = await request(app.getHttpServer())
        .post('/org-units')
        // A CHILD: since Task 7 there is no route that creates a root.
        .send({ name: `Redact ${tag}`, parentId: bootstrap.id })
        .expect(201)

      const rows = await auditRowsFor(ctx, res.body.id)
      const serialized = JSON.stringify(rows[0].after).toLowerCase()
      for (const forbidden of ['password', 'passwd', 'secret', 'hash', 'salt', 'credential', 'token']) {
        expect(serialized).not.toContain(forbidden)
      }
    })
  })

  // =======================================================================
  // PATCH /org-units/:id — renaming
  // =======================================================================

  describe('PATCH /org-units/:id', () => {
    /**
     * `path` is DERIVED from the name, so a rename is never a one-column
     * update: every descendant is prefixed by this unit's path and all of
     * them move together or the tree is inconsistent — and since scoped
     * grants resolve BY PATH, an inconsistent tree is an authorization bug,
     * not a cosmetic one.
     */
    it('rewrites the whole subtree', async () => {
      const root = await makeOrgUnit('Rename Root')
      const sales = await orgUnitsRepo().createChild(root.id, 'Sales')
      const emea = await orgUnitsRepo().createChild(sales.id, 'EMEA')
      const actor = await makeActiveUser('super_admin', root.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .patch('/org-units/' + sales.id)
        .send({ name: 'Revenue' })
        .expect(200)
      expect(res.body.path).toBe(root.path + '.revenue')

      const moved = await orgUnitsRepo().findById(emea.id)
      expect(moved?.path).toBe(root.path + '.revenue.emea')
      // The descendant kept its own name; only the inherited prefix moved.
      expect(moved?.name).toBe('EMEA')
    })

    /**
     * toLabel('Sales') and toLabel('SALES!') are both `sales`, so this
     * changes the display name and touches no path. Rewriting a subtree to
     * the value it already holds would be write amplification for nothing.
     */
    it('changes the name without touching paths when the label is unchanged', async () => {
      const root = await makeOrgUnit('Label Root')
      const sales = await orgUnitsRepo().createChild(root.id, 'Sales')
      const emea = await orgUnitsRepo().createChild(sales.id, 'EMEA')
      const actor = await makeActiveUser('super_admin', root.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .patch('/org-units/' + sales.id)
        .send({ name: 'SALES!' })
        .expect(200)
      expect(res.body.name).toBe('SALES!')
      expect(res.body.path).toBe(root.path + '.sales')
      expect((await orgUnitsRepo().findById(emea.id))?.path).toBe(root.path + '.sales.emea')
    })

    it('refuses a colliding rename and rolls the subtree back whole', async () => {
      const root = await makeOrgUnit('Collide Root')
      const sales = await orgUnitsRepo().createChild(root.id, 'Sales')
      const emea = await orgUnitsRepo().createChild(sales.id, 'EMEA')
      await orgUnitsRepo().createChild(root.id, 'Marketing')
      const actor = await makeActiveUser('super_admin', root.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .patch('/org-units/' + sales.id)
        .send({ name: 'Marketing' })
        .expect(409)
      expect(res.body.code).toBe('CONFLICT')

      expect((await orgUnitsRepo().findById(emea.id))?.path).toBe(root.path + '.sales.emea')
    })

    /**
     * The name is what a human changed; the PATH is what decides
     * authorization. An audit row recording only the former would not
     * explain a scope change that happened at the same instant.
     */
    it('records both paths, not just both names', async () => {
      const root = await makeOrgUnit('Audit Root')
      const sales = await orgUnitsRepo().createChild(root.id, 'Sales')
      const actor = await makeActiveUser('super_admin', root.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      await request(app.getHttpServer())
        .patch('/org-units/' + sales.id)
        .send({ name: 'Revenue' })
        .expect(200)

      const { rows } = await ctx.pool.query(
        "SELECT before, after FROM audit_log WHERE resource_id = $1 AND action = 'org_unit:rename'",
        [sales.id],
      )
      expect((rows[0] as { before: { path: string } }).before.path).toBe(root.path + '.sales')
      expect((rows[0] as { after: { path: string } }).after.path).toBe(root.path + '.revenue')
    })

    /** Re-parenting is a different operation with a different scope question. */
    it('refuses a body that tries to re-parent the unit', async () => {
      const root = await makeOrgUnit('Reparent Root')
      const sales = await orgUnitsRepo().createChild(root.id, 'Sales')
      const actor = await makeActiveUser('super_admin', root.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      await request(app.getHttpServer())
        .patch('/org-units/' + sales.id)
        .send({ name: 'Revenue', parentId: root.id })
        .expect(400)
    })

    it('refuses a scoped actor whose grant does not cover the unit', async () => {
      const root = await makeOrgUnit('Scoped Rename Root')
      const mine = await orgUnitsRepo().createChild(root.id, 'Mine')
      const theirs = await orgUnitsRepo().createChild(root.id, 'Theirs')
      const actor = await makeActiveUser('super_admin', mine.id)
      await grant(actor.id, 'super_admin', mine.id)
      currentUsername = actor.username

      await request(app.getHttpServer())
        .patch('/org-units/' + theirs.id)
        .send({ name: 'Taken' })
        .expect(403)
    })
  })

  // =======================================================================
  // DELETE /org-units/:id
  // =======================================================================

  describe('DELETE /org-units/:id', () => {
    it('deletes a unit that nothing depends on, and the record outlives it', async () => {
      const root = await makeOrgUnit('Delete Root')
      const spare = await orgUnitsRepo().createChild(root.id, 'Spare')
      const actor = await makeActiveUser('super_admin', root.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      await request(app.getHttpServer()).delete('/org-units/' + spare.id).expect(204)
      expect(await orgUnitsRepo().findById(spare.id)).toBeNull()

      // audit_log.resource_id is deliberately not a foreign key, which is
      // what lets the record of a deletion survive the thing deleted.
      const { rows } = await ctx.pool.query(
        "SELECT before FROM audit_log WHERE resource_id = $1 AND action = 'org_unit:delete'",
        [spare.id],
      )
      expect(rows).toHaveLength(1)
    })

    it('refuses a unit that still has children, and names them', async () => {
      const root = await makeOrgUnit('Blocked Root')
      const sales = await orgUnitsRepo().createChild(root.id, 'Sales')
      await orgUnitsRepo().createChild(sales.id, 'EMEA')
      const actor = await makeActiveUser('super_admin', root.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .delete('/org-units/' + sales.id)
        .expect(409)
      expect(String(res.body.message)).toMatch(/1 child org unit/)
    })

    it('refuses a unit that still has people in it', async () => {
      const root = await makeOrgUnit('Peopled Root')
      const branch = await orgUnitsRepo().createChild(root.id, 'Branch')
      await makeActiveUser('read_only', branch.id)
      const actor = await makeActiveUser('super_admin', root.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .delete('/org-units/' + branch.id)
        .expect(409)
      expect(String(res.body.message)).toMatch(/1 person/)
    })

    /**
     * THE one that would not have stopped itself. Three of the four foreign
     * keys into org_units are ON DELETE RESTRICT;
     * role_assignments.scope_org_unit_id CASCADES, so a delete that reached
     * the database would silently revoke every scoped grant pointing here,
     * with no audit row and no way to discover it afterwards.
     */
    it('refuses a unit scoped role assignments point at, rather than cascading them away', async () => {
      const root = await makeOrgUnit('Granted Root')
      const branch = await orgUnitsRepo().createChild(root.id, 'Branch')
      const scoped = await makeActiveUser('user_admin', root.id)
      await grant(scoped.id, 'user_admin', branch.id)
      const actor = await makeActiveUser('super_admin', root.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .delete('/org-units/' + branch.id)
        .expect(409)
      expect(String(res.body.message)).toMatch(/scoped role assignment/)

      // Still there, and so is the grant.
      expect(await orgUnitsRepo().findById(branch.id)).not.toBeNull()
      const { rows } = await ctx.pool.query(
        'SELECT 1 FROM role_assignments WHERE scope_org_unit_id = $1',
        [branch.id],
      )
      expect(rows).toHaveLength(1)
    })

    it('refuses a root org unit', async () => {
      const root = await makeOrgUnit('Root Delete')
      const actor = await makeActiveUser('super_admin', root.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      const res = await request(app.getHttpServer()).delete('/org-units/' + root.id).expect(409)
      expect(String(res.body.message)).toMatch(/root org unit/i)
    })

    it('404s for a unit that does not exist', async () => {
      const root = await makeOrgUnit('Missing Root')
      const actor = await makeActiveUser('super_admin', root.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      await request(app.getHttpServer())
        .delete('/org-units/00000000-0000-0000-0000-000000000000')
        .expect(404)
    })
  })
})
