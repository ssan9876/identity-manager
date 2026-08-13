import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JwtGuard } from '../src/auth/jwt.guard'
import type { RoleKey } from '../src/authz/actions'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { AuditWriter } from '../src/audit/audit.writer'
import { AttributeTargetMappingsController } from '../src/attributes/attribute-target-mappings.controller'
import { AttributeTargetMappingsRepository } from '../src/attributes/attribute-target-mappings.repository'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { attributeDefinitions } from '../src/db/schema/attribute-definitions'
import { connectorTargets } from '../src/db/schema/connector-targets'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { UsersRepository, type User } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

/** Same technique as attribute-definitions.controller.spec.ts / connector-targets.controller.spec.ts. */
function stubJwtGuard(getUsername: () => string): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
        subject: 'attribute-target-mappings-test',
        username: getUsername(),
        email: null,
      }
      return true
    },
  }
}

/**
 * MILESTONE 14, TASK 9 — "Attribute mapping editor over
 * `attribute_target_mappings`." This is the write path Milestone 10, Task 3
 * deliberately shipped without ("Rows are admin-seeded directly against
 * Postgres until then" — that task's own report, Concerns #1).
 */
describe('AttributeTargetMappingsController (Milestone 14, Task 9)', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let currentUsername = ''
  let orgUnitId: string

  beforeAll(async () => {
    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`Mapping Editor Root ${Date.now()}`)).id

    const moduleRef = await Test.createTestingModule({
      controllers: [AttributeTargetMappingsController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        AttributeTargetMappingsRepository,
        AuditWriter,
        PermissionEngine,
        PermissionGuard,
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
    return `atm${fixtureSeq}`
  }

  const usersRepo = () => new UsersRepository(ctx.db)
  const rolesRepo = () => new RoleAssignmentsRepository(ctx.db)

  // `scopeOrgUnitId` was previously hardcoded `null` with no parameter, so
  // this helper could not construct a SCOPED actor at all — the coverage had
  // the same shape as the bug it needed to catch.
  async function makeActiveUser(roleKey?: RoleKey, scopeOrgUnitId: string | null = null): Promise<User> {
    const tag = nextTag()
    const created = await usersRepo().create({
      primaryEmail: `${tag}@example.com`,
      username: `${tag}@example.com`,
      firstName: 'Mapping',
      lastName: `Test${tag}`,
      orgUnitId,
    })
    const active = await usersRepo().changeStatus(created.id, 'active')
    if (roleKey !== undefined) {
      await rolesRepo().assign({ userId: active.id, roleKey, scopeOrgUnitId })
    }
    return active
  }

  async function makeAttributeDefinition(): Promise<{ id: string; key: string }> {
    const tag = nextTag()
    const [row] = await ctx.db
      .insert(attributeDefinitions)
      .values({ key: `custom_${tag}`, label: `Custom ${tag}`, dataType: 'string', appliesTo: 'user', isActive: true })
      .returning()
    return { id: row!.id, key: row!.key }
  }

  // =========================================================================
  // Authorization
  // =========================================================================

  it('rejects GET for a caller holding no role at all with 403', async () => {
    const actor = await makeActiveUser()
    currentUsername = actor.username
    await request(app.getHttpServer()).get('/attribute-target-mappings').expect(403)
  })

  it('allows GET for auditor (connector:read)', async () => {
    const actor = await makeActiveUser('auditor')
    currentUsername = actor.username
    await request(app.getHttpServer()).get('/attribute-target-mappings').expect(200)
  })

  it('rejects POST for auditor (connector:read only, not connector:manage) with 403', async () => {
    const actor = await makeActiveUser('auditor')
    currentUsername = actor.username
    const def = await makeAttributeDefinition()
    await request(app.getHttpServer())
      .post('/attribute-target-mappings')
      .send({ attributeDefinitionId: def.id, target: 'echo', remoteName: 'x' })
      .expect(403)
  })

  // Security audit finding, the same one `ConnectorTargetsController` carried:
  // these rows are GLOBAL (no orgUnitId), and creating one is the single write
  // that turns default-deny propagation ON for a (field, target) pair — for
  // EVERY user in the directory, not the actor's subtree. `@RequirePermission`
  // alone is satisfied by holding `connector:manage` anywhere, so a
  // departmentally-scoped super_admin could open that gate organisation-wide.
  it('rejects POST for a SCOPED super_admin — opening a propagation gate needs a global grant', async () => {
    const actor = await makeActiveUser('super_admin', orgUnitId)
    currentUsername = actor.username
    const def = await makeAttributeDefinition()
    const res = await request(app.getHttpServer())
      .post('/attribute-target-mappings')
      .send({ attributeDefinitionId: def.id, target: 'echo', remoteName: 'x' })
      .expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  it('rejects DELETE for a SCOPED super_admin — closing one is equally directory-wide', async () => {
    const actor = await makeActiveUser('super_admin', orgUnitId)
    currentUsername = actor.username
    const res = await request(app.getHttpServer())
      .delete('/attribute-target-mappings/00000000-0000-4000-8000-000000000001')
      .expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  it('does NOT block a GLOBAL super_admin at the scope gate', async () => {
    const actor = await makeActiveUser('super_admin')
    currentUsername = actor.username
    const def = await makeAttributeDefinition()
    const res = await request(app.getHttpServer())
      .post('/attribute-target-mappings')
      .send({ attributeDefinitionId: def.id, target: 'echo', remoteName: 'x' })
    expect(res.status).not.toBe(403)
  })

  // =========================================================================
  // Validation — exactly one of attributeDefinitionId / coreField
  // =========================================================================

  it('rejects a body naming NEITHER attributeDefinitionId nor coreField with 400 VALIDATION_FAILED', async () => {
    const admin = await makeActiveUser('super_admin')
    currentUsername = admin.username
    const res = await request(app.getHttpServer())
      .post('/attribute-target-mappings')
      .send({ target: 'echo', remoteName: 'x' })
      .expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('rejects a body naming BOTH attributeDefinitionId and coreField with 400 VALIDATION_FAILED', async () => {
    const admin = await makeActiveUser('super_admin')
    currentUsername = admin.username
    const def = await makeAttributeDefinition()
    const res = await request(app.getHttpServer())
      .post('/attribute-target-mappings')
      .send({ attributeDefinitionId: def.id, coreField: 'title', target: 'echo', remoteName: 'x' })
      .expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('rejects an unknown target with 400 VALIDATION_FAILED', async () => {
    const admin = await makeActiveUser('super_admin')
    currentUsername = admin.username
    const def = await makeAttributeDefinition()
    await request(app.getHttpServer())
      .post('/attribute-target-mappings')
      .send({ attributeDefinitionId: def.id, target: 'not-a-target', remoteName: 'x' })
      .expect(400)
  })

  // =========================================================================
  // Create / read / update / delete — the opt-in act default-deny requires
  // =========================================================================

  it('creates a CUSTOM attribute mapping, defaulting enabled to true, and it appears in the list under its OWN target only', async () => {
    const admin = await makeActiveUser('super_admin')
    currentUsername = admin.username
    const def = await makeAttributeDefinition()

    const createRes = await request(app.getHttpServer())
      .post('/attribute-target-mappings')
      .send({ attributeDefinitionId: def.id, target: 'echo', remoteName: 'echoRemoteName' })
      .expect(201)
    expect(createRes.body).toMatchObject({
      attributeDefinitionId: def.id,
      coreField: null,
      target: 'echo',
      remoteName: 'echoRemoteName',
      enabled: true,
    })

    const listRes = await request(app.getHttpServer()).get('/attribute-target-mappings').expect(200)
    const rows = listRes.body as Array<{ localKey: string; target: string; remoteName: string }>
    const echoRow = rows.find((r) => r.localKey === def.key && r.target === 'echo')
    expect(echoRow).toBeDefined()
    expect(echoRow!.remoteName).toBe('echoRemoteName')
    // Default-deny, visible structurally: no row for a DIFFERENT target.
    expect(rows.find((r) => r.localKey === def.key && r.target === 'keycloak')).toBeUndefined()
  })

  it('creates a CORE FIELD mapping (given_name/surname/title/department — no attribute_definitions row involved)', async () => {
    const admin = await makeActiveUser('super_admin')
    currentUsername = admin.username

    const res = await request(app.getHttpServer())
      .post('/attribute-target-mappings')
      .send({ coreField: 'title', target: 'echo', remoteName: 'jobTitle' })
      .expect(201)
    expect(res.body).toMatchObject({ attributeDefinitionId: null, coreField: 'title', target: 'echo', remoteName: 'jobTitle' })
  })

  it('rejects a SECOND mapping for the same (attribute, target) with a clean 409, not a raw constraint error', async () => {
    const admin = await makeActiveUser('super_admin')
    currentUsername = admin.username
    const def = await makeAttributeDefinition()

    await request(app.getHttpServer())
      .post('/attribute-target-mappings')
      .send({ attributeDefinitionId: def.id, target: 'entra_id', remoteName: 'first' })
      .expect(201)

    const res = await request(app.getHttpServer())
      .post('/attribute-target-mappings')
      .send({ attributeDefinitionId: def.id, target: 'entra_id', remoteName: 'second' })
      .expect(409)
    expect(res.body.code).toBe('CONFLICT')
  })

  it('PATCH toggles enabled without deleting the row — "disabled" and "no row" stay distinct states', async () => {
    const admin = await makeActiveUser('super_admin')
    currentUsername = admin.username
    const def = await makeAttributeDefinition()

    const created = await request(app.getHttpServer())
      .post('/attribute-target-mappings')
      .send({ attributeDefinitionId: def.id, target: 'google_workspace', remoteName: 'name' })
      .expect(201)

    const patched = await request(app.getHttpServer())
      .patch(`/attribute-target-mappings/${created.body.id}`)
      .send({ enabled: false })
      .expect(200)
    expect(patched.body.enabled).toBe(false)

    const listRes = await request(app.getHttpServer()).get('/attribute-target-mappings').expect(200)
    const rows = listRes.body as Array<{ id: string; enabled: boolean }>
    const row = rows.find((r) => r.id === created.body.id)
    // Still present — a disabled row is a DIFFERENT, distinguishable state
    // from a row that never existed at all (this task's own core UX point).
    expect(row).toBeDefined()
    expect(row!.enabled).toBe(false)
  })

  it('PATCH renames remoteName', async () => {
    const admin = await makeActiveUser('super_admin')
    currentUsername = admin.username
    const def = await makeAttributeDefinition()

    const created = await request(app.getHttpServer())
      .post('/attribute-target-mappings')
      .send({ attributeDefinitionId: def.id, target: 'active_directory', remoteName: 'oldName' })
      .expect(201)

    const patched = await request(app.getHttpServer())
      .patch(`/attribute-target-mappings/${created.body.id}`)
      .send({ remoteName: 'newName' })
      .expect(200)
    expect(patched.body.remoteName).toBe('newName')
  })

  it('PATCH of a nonexistent id 404s', async () => {
    const admin = await makeActiveUser('super_admin')
    currentUsername = admin.username
    await request(app.getHttpServer())
      .patch('/attribute-target-mappings/00000000-0000-0000-0000-000000000000')
      .send({ enabled: false })
      .expect(404)
  })

  it('DELETE removes the row — it no longer appears in the list at all', async () => {
    const admin = await makeActiveUser('super_admin')
    currentUsername = admin.username
    const def = await makeAttributeDefinition()

    const created = await request(app.getHttpServer())
      .post('/attribute-target-mappings')
      .send({ attributeDefinitionId: def.id, target: 'keycloak', remoteName: 'toDelete' })
      .expect(201)

    await request(app.getHttpServer()).delete(`/attribute-target-mappings/${created.body.id}`).expect(200)

    const listRes = await request(app.getHttpServer()).get('/attribute-target-mappings').expect(200)
    const rows = listRes.body as Array<{ id: string }>
    expect(rows.find((r) => r.id === created.body.id)).toBeUndefined()
  })

  it('DELETE of a nonexistent id 404s', async () => {
    const admin = await makeActiveUser('super_admin')
    currentUsername = admin.username
    await request(app.getHttpServer())
      .delete('/attribute-target-mappings/00000000-0000-0000-0000-000000000000')
      .expect(404)
  })
  // =========================================================================
  // GET export-impact — security finding 5
  // =========================================================================

  /**
   * Enables a target for the master organization, which is where every user
   * this spec seeds lands. `connector_targets.organization_id` defaults to
   * `master_organization_id()`.
   */
  async function enableTarget(target: 'active_directory' | 'entra_id'): Promise<void> {
    await ctx.db
      .insert(connectorTargets)
      .values({ target, enabled: true, config: {} })
      .onConflictDoUpdate({
        target: [connectorTargets.organizationId, connectorTargets.target],
        set: { enabled: true },
      })
  }

  it('reports the export impact of a custom attribute, as a count and a flag', async () => {
    const admin = await makeActiveUser('super_admin')
    currentUsername = admin.username
    const def = await makeAttributeDefinition()
    await enableTarget('active_directory')
    await usersRepo().create({
      primaryEmail: `impact-${nextTag()}@example.com`,
      username: `impact-${nextTag()}`,
      firstName: 'Impact',
      lastName: 'Holder',
      orgUnitId,
      attributes: { [def.key]: 'held' },
    })

    const res = await request(app.getHttpServer())
      .get(`/attribute-target-mappings/export-impact?target=active_directory&attributeDefinitionId=${def.id}`)
      .expect(200)

    expect(res.body).toMatchObject({ target: 'active_directory', sensitive: false })
    expect(res.body.holderCount).toBeGreaterThanOrEqual(1)
  })

  it('rejects an export-impact request naming both an attribute and a core field', async () => {
    const admin = await makeActiveUser('super_admin')
    currentUsername = admin.username
    const def = await makeAttributeDefinition()

    await request(app.getHttpServer())
      .get(
        `/attribute-target-mappings/export-impact?target=active_directory&coreField=title&attributeDefinitionId=${def.id}`,
      )
      .expect(400)
  })

  it('rejects an export-impact request naming neither', async () => {
    const admin = await makeActiveUser('super_admin')
    currentUsername = admin.username

    await request(app.getHttpServer())
      .get('/attribute-target-mappings/export-impact?target=active_directory')
      .expect(400)
  })

  /**
   * `connector:read`, not `connector:manage`. This route returns a COUNT and
   * a boolean and never a stored value, so it is gated exactly like the
   * sibling list it sits beside — an auditor who can see which mappings
   * exist can see how much each one carries.
   */
  it('allows an auditor — the route returns a count, never a value', async () => {
    const actor = await makeActiveUser('auditor')
    currentUsername = actor.username

    await request(app.getHttpServer())
      .get('/attribute-target-mappings/export-impact?target=active_directory&coreField=title')
      .expect(200)
  })

  it('rejects a caller holding no role at all with 403', async () => {
    const actor = await makeActiveUser()
    currentUsername = actor.username

    await request(app.getHttpServer())
      .get('/attribute-target-mappings/export-impact?target=active_directory&coreField=title')
      .expect(403)
  })
})
