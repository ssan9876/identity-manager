import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { and, asc, eq, inArray } from 'drizzle-orm'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AttributeDefinitionsController } from '../src/attributes/attribute-definitions.controller'
import { AttributeDefinitionsRepository } from '../src/attributes/attribute-definitions.repository'
import { AttributeMigrationJob } from '../src/attributes/attribute-migration.job'
import { ATTRIBUTE_PREFIX } from '../src/business-roles/role-evaluator'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import type { RoleKey } from '../src/authz/actions'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { attributeDefinitions } from '../src/db/schema/attribute-definitions'
import { auditLog } from '../src/db/schema/audit-log'
import { businessRoleConditions, businessRoles } from '../src/db/schema/business-roles'
import { users } from '../src/db/schema/users'
import { OrganizationsRepository } from '../src/organizations/organizations.repository'
import { OrgUnitsRepository, type OrgUnit } from '../src/org-units/org-units.repository'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

/** Same technique as org-units.write.spec.ts / self-service.spec.ts — stamps `request.principal` from a closure variable read at request time. */
function stubJwtGuard(getUsername: () => string): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
        subject: 'attr-defs-test',
        username: getUsername(),
        email: null,
      }
      return true
    },
  }
}

/**
 * ONE container for the whole file (`withTestDatabase` registers file-scope
 * beforeAll/afterAll hooks and starts a Postgres per call), shared by the
 * read describe below and Milestone 8, Task 7's write describes.
 */
const ctx = withTestDatabase()

let app: INestApplication
let currentUsername = ''

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [AttributeDefinitionsController],
    providers: [
      { provide: DB_CLIENT, useFactory: () => ctx.db },
      AttributeDefinitionsRepository,
      AttributeMigrationJob,
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
  return `attrdef${fixtureSeq}`
}

/** Unique per call and legal under attributes/attribute-key.ts. */
function uniqueKey(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '_')}`.slice(0, 64)
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

/**
 * Signs the given role in as the current principal. `scopeOrgUnitId`
 * defaults to `null` — a GLOBAL grant — because that is what every
 * mutating route on this controller requires.
 */
async function actAs(roleKey: RoleKey, scopeOrgUnitId: string | null = null): Promise<string> {
  const org = await makeOrgUnit('Actor Home')
  const actor = await makeActiveUser(roleKey, org.id)
  await grant(actor.id, roleKey, scopeOrgUnitId === undefined ? null : scopeOrgUnitId)
  currentUsername = actor.username
  return actor.id
}

/** Every audit row for one definition, oldest first (`audit_log.id` is a bigserial, so insertion order IS this order). */
async function auditRowsFor(resourceId: string, action?: string) {
  const where =
    action === undefined
      ? eq(auditLog.resourceId, resourceId)
      : and(eq(auditLog.resourceId, resourceId), eq(auditLog.action, action))

  return ctx.db.select().from(auditLog).where(where).orderBy(asc(auditLog.id))
}

async function seedDefinition(
  over: Partial<typeof attributeDefinitions.$inferInsert> = {},
): Promise<{ id: string; key: string }> {
  const key = typeof over.key === 'string' ? over.key : uniqueKey('attr')
  const [row] = await ctx.db
    .insert(attributeDefinitions)
    .values({ key, label: 'Seeded', dataType: 'string', appliesTo: 'user', ...over })
    .returning()
  return { id: row.id, key: row.key }
}

/** A business role whose PUBLISHED formula names `field` — what role-evaluator.ts actually reads. */
async function seedRoleWithCondition(field: string): Promise<string> {
  const name = `Role ${randomUUID()}`
  const master = await new OrganizationsRepository(ctx.db).findMaster()
  const [role] = await ctx.db
    .insert(businessRoles)
    .values({ name, organizationId: master.id, enabled: true })
    .returning()
  await ctx.db
    .insert(businessRoleConditions)
    .values({ businessRoleId: role.id, field, operator: 'equals', value: 'yes' })
  return name
}

/**
 * MILESTONE 8, TASK 3 — `GET /attribute-definitions`. Only JwtGuard is
 * stubbed; PermissionGuard/PermissionEngine run for real (same pattern as
 * org-units.write.spec.ts) so the permission gate itself is genuinely
 * exercised, not assumed.
 */
describe('GET /attribute-definitions (Milestone 8, Task 3)', () => {
  it('rejects a request with no appliesTo query param with 400 VALIDATION_FAILED', async () => {
    await actAs('read_only')

    const res = await request(app.getHttpServer()).get('/attribute-definitions').expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('rejects an appliesTo value outside the user/group enum with 400 VALIDATION_FAILED', async () => {
    await actAs('read_only')

    const res = await request(app.getHttpServer())
      .get('/attribute-definitions?appliesTo=bogus')
      .expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('rejects a caller holding no role at all with 403', async () => {
    const org = await makeOrgUnit('No Role')
    const actor = await makeActiveUser('roleless', org.id)
    currentUsername = actor.username

    const res = await request(app.getHttpServer())
      .get('/attribute-definitions?appliesTo=user')
      .expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  it('rejects a deactivated caller with 403', async () => {
    const org = await makeOrgUnit('Deactivated Caller')
    const actor = await makeActiveUser('willdeactivate', org.id)
    await grant(actor.id, 'read_only', null)
    await usersRepo().changeStatus(actor.id, 'deactivated')
    currentUsername = actor.username

    const res = await request(app.getHttpServer())
      .get('/attribute-definitions?appliesTo=user')
      .expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  /**
   * MILESTONE 8, TASK 7 — the deliberate narrowing. `help_desk` holds
   * `user:read` and could list definitions while this route was gated on
   * that action; it does NOT hold `attribute:read` (pinned by
   * actions.spec.ts's exact holder set), and help desk reads people, not
   * schema. If someone re-gates this route back onto `user:read` — or
   * grants `attribute:read` to help_desk to make a failure "go away" — this
   * test is what says so.
   */
  it('refuses a help_desk caller now that the route requires attribute:read, not user:read', async () => {
    await actAs('help_desk')

    const res = await request(app.getHttpServer())
      .get('/attribute-definitions?appliesTo=user')
      .expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  it('allows an auditor, who holds attribute:read', async () => {
    await actAs('auditor')

    await request(app.getHttpServer()).get('/attribute-definitions?appliesTo=user').expect(200)
  })

  it('returns only active, user-scoped definitions, ordered by sortOrder then key, for a caller holding attribute:read', async () => {
    await actAs('read_only')

    const tag = nextTag()
    await ctx.db.insert(attributeDefinitions).values([
      {
        key: `zLast_${tag}`,
        label: 'Z Last',
        dataType: 'string',
        appliesTo: 'user',
        isActive: true,
        sortOrder: 5,
      },
      {
        key: `aFirst_${tag}`,
        label: 'A First',
        dataType: 'string',
        appliesTo: 'user',
        isActive: true,
        sortOrder: 1,
      },
      {
        key: `inactive_${tag}`,
        label: 'Inactive',
        dataType: 'string',
        appliesTo: 'user',
        isActive: false,
        sortOrder: 0,
      },
      {
        key: `groupScoped_${tag}`,
        label: 'Group Scoped',
        dataType: 'string',
        appliesTo: 'group',
        isActive: true,
        sortOrder: 0,
      },
    ])

    const res = await request(app.getHttpServer())
      .get('/attribute-definitions?appliesTo=user')
      .expect(200)

    const keys = (res.body as { key: string }[])
      .map((d) => d.key)
      .filter((k) => k.endsWith(tag))
    expect(keys).toEqual([`aFirst_${tag}`, `zLast_${tag}`])
  })

  it('returns active, group-scoped definitions (appliesTo=group), never a user-scoped sibling', async () => {
    await actAs('read_only')

    const tag = nextTag()
    await ctx.db.insert(attributeDefinitions).values([
      { key: `groupOnly_${tag}`, label: 'Group Only', dataType: 'string', appliesTo: 'group', isActive: true },
      { key: `userSibling_${tag}`, label: 'User Sibling', dataType: 'string', appliesTo: 'user', isActive: true },
    ])

    const res = await request(app.getHttpServer())
      .get('/attribute-definitions?appliesTo=group')
      .expect(200)

    const keys = (res.body as { key: string }[]).map((d) => d.key)
    expect(keys).toContain(`groupOnly_${tag}`)
    expect(keys).not.toContain(`userSibling_${tag}`)
  })

  it('returns the full definition shape a client needs to render a field', async () => {
    await actAs('read_only')

    const tag = nextTag()
    await ctx.db.insert(attributeDefinitions).values({
      key: `shaped_${tag}`,
      label: 'Shaped Field',
      dataType: 'enum',
      required: true,
      validationRules: { options: ['a', 'b'] },
      appliesTo: 'user',
      isActive: true,
      selfEditable: false,
    })

    const res = await request(app.getHttpServer())
      .get('/attribute-definitions?appliesTo=user')
      .expect(200)

    const shaped = (res.body as Record<string, unknown>[]).find((d) => d.key === `shaped_${tag}`)
    expect(shaped).toMatchObject({
      key: `shaped_${tag}`,
      label: 'Shaped Field',
      dataType: 'enum',
      required: true,
      validationRules: { options: ['a', 'b'] },
      appliesTo: 'user',
      isActive: true,
      selfEditable: false,
    })
    // Milestone 10, Task 3: sync_to_keycloak is dropped from
    // attribute_definitions entirely — propagation is no longer part of
    // this shape at all, not merely defaulted false.
    expect(shaped).not.toHaveProperty('syncToKeycloak')
  })
})

/**
 * MILESTONE 8, TASK 7 — the write path over HTTP. This is where every
 * refusal Tasks 1-6 built first becomes reachable by a request, so these
 * tests assert the refusals SURFACE (as the right status, with the right
 * message), not that they exist — the repository's own spec already pins
 * the behaviour.
 */
describe('POST /attribute-definitions (Milestone 8, Task 7)', () => {
  const post = (body: object) => request(app.getHttpServer()).post('/attribute-definitions').send(body)

  function validBody(over: Record<string, unknown> = {}): Record<string, unknown> {
    return { key: uniqueKey('created'), label: 'Created', dataType: 'string', appliesTo: 'user', ...over }
  }

  it('rejects a caller holding attribute:read but not attribute:manage with 403', async () => {
    await actAs('user_admin')

    const res = await post(validBody()).expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  /**
   * `attribute_definitions` has no tenant or org-unit column at all — one
   * definition feeds every organization's users AND every organization's
   * business-role formulas (the repository's own `assertNoFormulaDependsOn`
   * says exactly this). `PermissionGuard` satisfies `@RequirePermission`
   * with `assertCanAnywhere`, so a super_admin scoped to ONE org unit —
   * who gets 403 merely reading a user outside it — would otherwise be able
   * to add a directory-wide attribute, or mark one self-editable. Identical
   * finding, and identical fix, to the sibling
   * `AttributeTargetMappingsController`.
   */
  it('rejects an org-unit-scoped super_admin with 403, because a definition is directory-wide', async () => {
    const scope = await makeOrgUnit('Scoped Super')
    await actAs('super_admin', scope.id)

    const res = await post(validBody()).expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
    expect(res.body.message).toMatch(/global/i)
  })

  it('creates a definition, returns 201 with the stored shape, and persists the row', async () => {
    await actAs('super_admin')
    const body = validBody({ label: 'Cost centre', required: true, sortOrder: 3 })

    const res = await post(body).expect(201)
    expect(res.body).toMatchObject({
      key: body.key,
      label: 'Cost centre',
      dataType: 'string',
      appliesTo: 'user',
      required: true,
      isActive: true,
      selfEditable: false,
      sensitive: false,
    })
    expect(res.body.id).toEqual(expect.any(String))

    const [stored] = await ctx.db
      .select()
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.id, res.body.id))
    expect(stored).toMatchObject({ key: body.key, label: 'Cost centre', sortOrder: 3 })
  })

  it('writes exactly one attribute_definition:create audit row, attributed to the actor, with before null', async () => {
    const actorId = await actAs('super_admin')

    const res = await post(validBody()).expect(201)
    const rows = await auditRowsFor(res.body.id)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      action: 'attribute_definition:create',
      resourceType: 'attribute_definition',
      resourceId: res.body.id,
      actorUserId: actorId,
      before: null,
    })
    expect(rows[0].after).toMatchObject({ key: res.body.key, sensitive: false, selfEditable: false })
  })

  it('records a definition created sensitive with sensitive true in `after`, under the create action', async () => {
    await actAs('super_admin')

    const res = await post(validBody({ sensitive: true })).expect(201)
    const rows = await auditRowsFor(res.body.id)

    expect(rows.map((r) => r.action)).toEqual(['attribute_definition:create'])
    expect(rows[0].after).toMatchObject({ sensitive: true })
  })

  it('rejects an unknown body field with 400 rather than silently ignoring it', async () => {
    await actAs('super_admin')

    const res = await post(validBody({ syncToKeycloak: true })).expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('surfaces the repository key refusal as 400, naming the key', async () => {
    await actAs('super_admin')

    const res = await post(validBody({ key: 'has space' })).expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
    expect(JSON.stringify(res.body.issues)).toMatch(/key/)
  })

  it('surfaces the reserved-key refusal as 400', async () => {
    await actAs('super_admin')

    const res = await post(validBody({ key: '__proto__' })).expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('surfaces the validationRules.pattern refusal as 400 pointing at format', async () => {
    await actAs('super_admin')

    const res = await post(validBody({ validationRules: { pattern: '^(a+)+$' } })).expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
    expect(JSON.stringify(res.body.issues)).toMatch(/format/)
  })

  it('surfaces the closed validationRules schema as 400 for an unknown rule', async () => {
    await actAs('super_admin')

    const res = await post(validBody({ validationRules: { nonsense: 1 } })).expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('surfaces the selfEditable escalation refusal as 409, naming the business role', async () => {
    await actAs('super_admin')
    const key = uniqueKey('escalate')
    const roleName = await seedRoleWithCondition(`${ATTRIBUTE_PREFIX}${key}`)

    const res = await post(validBody({ key, selfEditable: true })).expect(409)
    expect(res.body.code).toBe('CONFLICT')
    expect(res.body.message).toContain(roleName)
  })

  it('surfaces the (key, appliesTo) uniqueness violation as 409 without echoing the key back', async () => {
    await actAs('super_admin')
    const existing = await seedDefinition()

    const res = await post(validBody({ key: existing.key, appliesTo: 'user' })).expect(409)
    expect(res.body.code).toBe('CONFLICT')
    expect(res.body.message).not.toContain(existing.key)
  })

  it('rejects a non-scalar defaultValue with 400 — an attribute value is a scalar in every dataType', async () => {
    await actAs('super_admin')

    const res = await post(validBody({ defaultValue: { nested: true } })).expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('leaves no row behind when the create is refused', async () => {
    await actAs('super_admin')
    const key = uniqueKey('rolledback')
    await seedRoleWithCondition(`${ATTRIBUTE_PREFIX}${key}`)

    await post(validBody({ key, selfEditable: true })).expect(409)

    const rows = await ctx.db
      .select()
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.key, key))
    expect(rows).toHaveLength(0)
  })

  // =========================================================================
  // A default has to be a value its own definition would accept
  // =========================================================================

  it('rejects a defaultValue that its own dataType could never accept', async () => {
    await actAs('super_admin')

    const res = await post(validBody({ dataType: 'number', defaultValue: 'not-a-number' })).expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
    expect(JSON.stringify(res.body.issues)).toMatch(/defaultValue/)
  })

  it('accepts a defaultValue that its own dataType does accept', async () => {
    await actAs('super_admin')

    await post(validBody({ dataType: 'number', defaultValue: 42 })).expect(201)
  })

  it('rejects a date defaultValue that is not a real calendar date', async () => {
    await actAs('super_admin')

    await post(validBody({ dataType: 'date', defaultValue: '2026-02-30' })).expect(400)
  })

  it('rejects an enum defaultValue outside the definition own options', async () => {
    await actAs('super_admin')

    await post(
      validBody({ dataType: 'enum', validationRules: { options: ['a', 'b'] }, defaultValue: 'c' }),
    ).expect(400)
  })

  it('accepts an enum defaultValue that is one of the definition own options', async () => {
    await actAs('super_admin')

    await post(
      validBody({ dataType: 'enum', validationRules: { options: ['a', 'b'] }, defaultValue: 'b' }),
    ).expect(201)
  })

  it('rejects a defaultValue that violates the definition validationRules, not just its dataType', async () => {
    await actAs('super_admin')

    await post(
      validBody({ dataType: 'number', validationRules: { min: 10, max: 20 }, defaultValue: 5 }),
    ).expect(400)
  })

  it('accepts a definition with no defaultValue at all', async () => {
    await actAs('super_admin')

    await post(validBody({ dataType: 'number' })).expect(201)
  })
})

describe('PATCH /attribute-definitions/:id (Milestone 8, Task 7)', () => {
  const patch = (id: string, body: object) =>
    request(app.getHttpServer()).patch(`/attribute-definitions/${id}`).send(body)

  it('rejects a caller holding attribute:read but not attribute:manage with 403', async () => {
    await actAs('user_admin')
    const definition = await seedDefinition()

    await patch(definition.id, { label: 'Nope' }).expect(403)
  })

  it('rejects an org-unit-scoped super_admin with 403', async () => {
    const scope = await makeOrgUnit('Scoped Patcher')
    await actAs('super_admin', scope.id)
    const definition = await seedDefinition()

    const res = await patch(definition.id, { label: 'Nope' }).expect(403)
    expect(res.body.message).toMatch(/global/i)
  })

  it('rejects a non-UUID id with 400', async () => {
    await actAs('super_admin')

    const res = await patch('not-a-uuid', { label: 'X' }).expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('returns 404 for an id that does not exist', async () => {
    await actAs('super_admin')

    const res = await patch(randomUUID(), { label: 'X' }).expect(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })

  /**
   * `dataType` and `appliesTo` rewrite every stored value in
   * `users.attributes`. Refused BY NAME, ahead of the generic `.strict()`
   * scan, so the caller is told what to use instead rather than getting
   * "unrecognized key" — the same idiom `parseValidationRules` uses for
   * `pattern`.
   */
  it('rejects a PATCH carrying dataType with 400 pointing at the preview/commit route', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition()

    const res = await patch(definition.id, { dataType: 'number' }).expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
    const issues = JSON.stringify(res.body.issues)
    expect(issues).toMatch(/dataType/)
    expect(issues).toMatch(/preview/i)
    expect(issues).toMatch(/commit/i)
  })

  it('rejects a PATCH carrying appliesTo with 400 pointing at the preview/commit route', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition()

    const res = await patch(definition.id, { appliesTo: 'group' }).expect(400)
    const issues = JSON.stringify(res.body.issues)
    expect(issues).toMatch(/appliesTo/)
    expect(issues).toMatch(/preview/i)
  })

  it('leaves dataType untouched in the database when a PATCH carrying it is refused', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ dataType: 'string' })

    await patch(definition.id, { dataType: 'number', label: 'Also renamed' }).expect(400)

    const [row] = await ctx.db
      .select()
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.id, definition.id))
    expect(row).toMatchObject({ dataType: 'string', label: 'Seeded' })
  })

  /**
   * `key` is immutable BY CONSTRUCTION — `SafeFieldPatch` excludes it (Task
   * 5), because a key is what every `users.attributes` blob is actually
   * keyed BY, so renaming the definition orphans every value already
   * written under the old name. Refused by name, with that reason.
   */
  it('rejects a PATCH carrying key with 400 explaining that a key is immutable', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition()

    const res = await patch(definition.id, { key: uniqueKey('renamed') }).expect(400)
    const issues = JSON.stringify(res.body.issues)
    expect(issues).toMatch(/key/)
    expect(issues).toMatch(/users\.attributes|orphan/i)
  })

  it('updates a safe field and writes one attribute_definition:update audit row carrying both sides', async () => {
    const actorId = await actAs('super_admin')
    const definition = await seedDefinition({ label: 'Before label' })

    const res = await patch(definition.id, { label: 'After label' }).expect(200)
    expect(res.body).toMatchObject({ label: 'After label' })

    const rows = await auditRowsFor(definition.id)
    expect(rows.map((r) => r.action)).toEqual(['attribute_definition:update'])
    expect(rows[0]).toMatchObject({ resourceType: 'attribute_definition', actorUserId: actorId })
    expect(rows[0].before).toMatchObject({ label: 'Before label' })
    expect(rows[0].after).toMatchObject({ label: 'After label' })
  })

  it('surfaces the selfEditable escalation refusal as 409 on the PATCH path too', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition()
    const roleName = await seedRoleWithCondition(`${ATTRIBUTE_PREFIX}${definition.key}`)

    const res = await patch(definition.id, { selfEditable: true }).expect(409)
    expect(res.body.message).toContain(roleName)

    const rows = await auditRowsFor(definition.id)
    expect(rows).toHaveLength(0)
  })

  // =========================================================================
  // The `sensitive` ordering
  // =========================================================================

  /**
   * Turning `sensitive` ON reduces what the audit log can show. If the row
   * for that change is written from a post-change read, the change that
   * blinds the audit is itself blinded — the one event that most needs to
   * be legible. `audit_log` is append-only at the database level, so there
   * is no fixing it afterwards.
   */
  it('records a sensitive flag change with the values that were visible before it', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ sensitive: false })

    await patch(definition.id, { sensitive: true }).expect(200)

    const rows = await auditRowsFor(definition.id, 'attribute_definition:sensitive_changed')
    expect(rows).toHaveLength(1)
    expect(rows[0].before).toMatchObject({ sensitive: false })
    expect(rows[0].after).toMatchObject({ sensitive: true })
  })

  it('gives the sensitive change its own action rather than folding it into a generic update', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ sensitive: false })

    await patch(definition.id, { sensitive: true }).expect(200)

    const rows = await auditRowsFor(definition.id)
    expect(rows.map((r) => r.action)).toEqual(['attribute_definition:sensitive_changed'])
  })

  it('records turning sensitive back OFF under the same distinct action, both sides intact', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ sensitive: true })

    await patch(definition.id, { sensitive: false }).expect(200)

    const rows = await auditRowsFor(definition.id, 'attribute_definition:sensitive_changed')
    expect(rows).toHaveLength(1)
    expect(rows[0].before).toMatchObject({ sensitive: true })
    expect(rows[0].after).toMatchObject({ sensitive: false })
  })

  /**
   * NON-VACUITY, in the test file itself: a check that fired on "the caller
   * mentioned `sensitive`" rather than "`sensitive` actually changed" would
   * pass every test above while filling the log with transitions that never
   * happened.
   */
  it('writes no sensitive_changed row when the patch restates the value it already had', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ sensitive: true, label: 'Restate' })

    await patch(definition.id, { sensitive: true, label: 'Restated' }).expect(200)

    const rows = await auditRowsFor(definition.id)
    expect(rows.map((r) => r.action)).toEqual(['attribute_definition:update'])
  })

  it('records the sensitive change first when one patch changes sensitive and another field', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ sensitive: false, label: 'Both' })

    await patch(definition.id, { sensitive: true, label: 'Both changed' }).expect(200)

    const rows = await auditRowsFor(definition.id)
    expect(rows.map((r) => r.action)).toEqual([
      'attribute_definition:sensitive_changed',
      'attribute_definition:update',
    ])
    // Both rows carry the PRE-change side, not a re-read of the row after
    // the UPDATE statement.
    expect(rows[0].before).toMatchObject({ sensitive: false, label: 'Both' })
    expect(rows[1].before).toMatchObject({ sensitive: false, label: 'Both' })
  })

  // =========================================================================
  // Deactivation
  // =========================================================================

  it('records deactivating a definition under attribute_definition:deactivate', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ isActive: true })

    await patch(definition.id, { isActive: false }).expect(200)

    const rows = await auditRowsFor(definition.id)
    expect(rows.map((r) => r.action)).toEqual(['attribute_definition:deactivate'])
    expect(rows[0].before).toMatchObject({ isActive: true })
    expect(rows[0].after).toMatchObject({ isActive: false })
  })

  it('records RE-activating under the generic update action, not deactivate', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ isActive: false })

    await patch(definition.id, { isActive: true }).expect(200)

    const rows = await auditRowsFor(definition.id)
    expect(rows.map((r) => r.action)).toEqual(['attribute_definition:update'])
  })

  it('writes no deactivate row when the patch restates isActive false', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ isActive: false })

    await patch(definition.id, { isActive: false }).expect(200)

    const rows = await auditRowsFor(definition.id)
    expect(rows.map((r) => r.action)).toEqual(['attribute_definition:update'])
  })

  it('records a no-op patch as a single generic update row rather than nothing at all', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition()

    await patch(definition.id, {}).expect(200)

    const rows = await auditRowsFor(definition.id)
    expect(rows.map((r) => r.action)).toEqual(['attribute_definition:update'])
  })

  // =========================================================================
  // A bundled patch must not erase its own evidence (fix round 1, Important 1)
  // =========================================================================

  /**
   * `sortOrder` and `defaultValue` are safe fields that are NOT in
   * `snapshotDefinition` — deliberately for `defaultValue` (it is a VALUE of
   * the attribute, and SEC-M1 is exactly that values must not land in an
   * append-only audit table). They therefore cannot make `genericChanged`
   * true, and in the first version of this controller they relied entirely on
   * the "no other action fired" fallback — WHICH A SPECIALISED ACTION
   * SUPPRESSES.
   *
   * Reproduced by the reviewer: `PATCH {sensitive: true, sortOrder: 42}`
   * returned 200, wrote 42 to the database, and logged only
   * `sensitive_changed`. `42` appeared nowhere in the audit log. One request
   * changing an inherited default while the log shows only a visibility
   * toggle is the exact failure this task exists to prevent.
   *
   * The single-field cases above all passed throughout and would never have
   * caught it — only the BUNDLED shape does.
   */
  it('still records a generic update row when a bundled patch also changes sortOrder, which the snapshot cannot see', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ sensitive: false, sortOrder: 1 })

    await patch(definition.id, { sensitive: true, sortOrder: 42 }).expect(200)

    const [stored] = await ctx.db
      .select()
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.id, definition.id))
    expect(stored.sortOrder).toBe(42)

    const rows = await auditRowsFor(definition.id)
    expect(rows.map((r) => r.action)).toEqual([
      'attribute_definition:sensitive_changed',
      'attribute_definition:update',
    ])
  })

  it('still records a generic update row when a bundled patch also sets defaultValue', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ sensitive: false })

    await patch(definition.id, { sensitive: true, defaultValue: 'bundled' }).expect(200)

    const [stored] = await ctx.db
      .select()
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.id, definition.id))
    expect(stored.defaultValue).toBe('bundled')

    const rows = await auditRowsFor(definition.id)
    expect(rows.map((r) => r.action)).toEqual([
      'attribute_definition:sensitive_changed',
      'attribute_definition:update',
    ])
  })

  it('still records a generic update row when a bundled patch deactivates AND changes sortOrder', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ isActive: true, sortOrder: 1 })

    await patch(definition.id, { isActive: false, sortOrder: 7 }).expect(200)

    const rows = await auditRowsFor(definition.id)
    expect(rows.map((r) => r.action)).toEqual([
      'attribute_definition:deactivate',
      'attribute_definition:update',
    ])
  })

  it('rejects a defaultValue the stored dataType could never accept, on the PATCH path too', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ dataType: 'number' })

    const res = await patch(definition.id, { defaultValue: 'not-a-number' }).expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('accepts null to clear a default, which is not a value to type-check', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ dataType: 'number', defaultValue: 5 })

    await patch(definition.id, { defaultValue: null }).expect(200)

    const [stored] = await ctx.db
      .select()
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.id, definition.id))
    expect(stored.defaultValue).toBeNull()
  })
})

/**
 * MILESTONE 8, TASK 10 — the migration over HTTP.
 *
 * Tasks 8 and 9 built and proved the job itself (attribute-migration.spec.ts
 * owns its refusals, its hash and its reversibility). Nothing here re-tests
 * those. What is new, and only testable here, is the SURFACE: who may reach
 * the two halves at all, that the preview hash is required rather than
 * optional, that each refusal arrives as the right status, and — the one
 * decision this task had to make itself — what a preview is allowed to say
 * out loud about a `sensitive` definition's values.
 */

/**
 * One active user per entry in `values`, each carrying that value under
 * `key`, all in one fresh org unit.
 *
 * The population walk selects HOLDERS of a key across the whole `users`
 * table (`attribute_definitions` has no tenant column), so every fixture
 * below takes a per-call unique key — otherwise one test's holders would
 * land in another test's population.
 */
async function seedHolders(key: string, values: readonly unknown[]): Promise<string[]> {
  const org = await makeOrgUnit('Holders')
  const ids: string[] = []
  for (const value of values) {
    const holder = await makeActiveUser('holder', org.id)
    await ctx.db
      .update(users)
      .set({ attributes: { [key]: value } })
      .where(eq(users.id, holder.id))
    ids.push(holder.id)
  }
  return ids
}

describe('POST /attribute-definitions/:id/preview (Milestone 8, Task 10)', () => {
  const preview = (id: string, body: object) =>
    request(app.getHttpServer()).post(`/attribute-definitions/${id}/preview`).send(body)

  it('rejects a caller holding attribute:read but not attribute:manage with 403', async () => {
    await actAs('user_admin')
    const definition = await seedDefinition()

    const res = await preview(definition.id, { dataType: 'number' }).expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  /**
   * Same finding as POST/PATCH above, and it bites HARDER here: a preview
   * walks every holder of the attribute in the whole deployment and hands
   * back a sample of their stored values, so an org-unit-scoped super_admin
   * would read values out of org units they are 403 on.
   */
  it('rejects an org-unit-scoped super_admin with 403, because a definition is directory-wide', async () => {
    const scope = await makeOrgUnit('Scoped Previewer')
    await actAs('super_admin', scope.id)
    const definition = await seedDefinition()

    const res = await preview(definition.id, { dataType: 'number' }).expect(403)
    expect(res.body.message).toMatch(/global/i)
  })

  it('rejects a non-UUID id with 400', async () => {
    await actAs('super_admin')

    const res = await preview('not-a-uuid', { dataType: 'number' }).expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('returns 404 for an id that does not exist', async () => {
    await actAs('super_admin')

    const res = await preview(randomUUID(), { dataType: 'number' }).expect(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })

  it('rejects a change naming neither dataType nor appliesTo with 400', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition()

    const res = await preview(definition.id, {}).expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
    expect(JSON.stringify(res.body.issues)).toMatch(/dataType/)
  })

  it('rejects an unknown body field with 400 rather than silently ignoring it', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition()

    // `force` is a COMMIT option. Accepted here it would read as "preview
    // with the guard off", which is not a thing a preview can be.
    const res = await preview(definition.id, { dataType: 'number', force: true }).expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('reports the population, the change count, the blast radius and a preview hash', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ dataType: 'string' })
    await seedHolders(definition.key, ['1', '2', '3'])

    const res = await preview(definition.id, { dataType: 'number' }).expect(200)
    expect(res.body).toMatchObject({ populationSize: 3, changedCount: 3, unconvertible: [] })
    expect(res.body.blastRadius).toMatchObject({
      tripped: false,
      populationSize: 3,
      changedCount: 3,
    })
    expect(res.body.previewHash).toEqual(expect.any(String))
    expect(res.body.previewHash.length).toBeGreaterThan(0)
  })

  it('names every value the change would not survive, with its reason', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ dataType: 'string' })
    const [, broken] = await seedHolders(definition.key, ['7', 'not a number'])

    const res = await preview(definition.id, { dataType: 'number' }).expect(200)
    expect(res.body.unconvertible).toHaveLength(1)
    expect(res.body.unconvertible[0]).toMatchObject({ userId: broken, value: 'not a number' })
    expect(res.body.unconvertible[0].reason).toMatch(/decimal number/)
  })

  /** PREVIEW WRITES NOTHING — asserted through the route, not only in the job's own spec. */
  it('writes nothing: no audit row, no converted value, no changed definition', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ dataType: 'string' })
    const [holder] = await seedHolders(definition.key, ['12'])

    await preview(definition.id, { dataType: 'number' }).expect(200)

    expect(await auditRowsFor(definition.id)).toEqual([])
    const [user] = await ctx.db.select().from(users).where(eq(users.id, holder))
    expect(user.attributes).toEqual({ [definition.key]: '12' })
    const [stored] = await ctx.db
      .select()
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.id, definition.id))
    expect(stored.dataType).toBe('string')
  })

  /**
   * THE DECISION TASK 9 LEFT TO TASK 10, and the reason it is not a
   * one-field redaction.
   *
   * `report.unconvertible` carries RAW stored values, which for a
   * `sensitive: true` definition are exactly the values finding SEC-M1 says
   * must not be handed around casually — `sensitive` exists to keep them out
   * of `audit_log`, and a report that prints them into a console (and into
   * whatever proxy log sits in front of it) walks them out through a
   * different door.
   *
   * Redacting `value` ALONE would be a fig leaf: `convertValue`'s reasons
   * QUOTE the value they refused (`"92000 GBP" is not a plain decimal
   * number`), so the reason string is a second copy of it. Both fields go.
   * `userId` stays — it is not the attribute's value, and it is the only
   * thing that makes the report actionable.
   */
  it('redacts BOTH the value and the reason in a sensitive definition preview sample', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ dataType: 'string', sensitive: true })
    const [holder] = await seedHolders(definition.key, ['92000 GBP'])

    const res = await preview(definition.id, { dataType: 'number' }).expect(200)

    expect(res.body.populationSize).toBe(1)
    expect(res.body.unconvertible).toHaveLength(1)
    expect(res.body.unconvertible[0].userId).toBe(holder)
    expect(res.body.unconvertible[0].value).toMatch(/redacted/i)
    expect(res.body.unconvertible[0].reason).toMatch(/redacted/i)
    expect(res.body.unconvertible[0].reason).toMatch(/sensitive/i)
    // The WHOLE payload, not just those two fields — a third copy anywhere
    // in the report would defeat the point.
    expect(JSON.stringify(res.body)).not.toContain('92000 GBP')
  })

  it('leaves the sample verbatim for a definition that is not sensitive', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ dataType: 'string', sensitive: false })
    await seedHolders(definition.key, ['92000 GBP'])

    const res = await preview(definition.id, { dataType: 'number' }).expect(200)
    expect(res.body.unconvertible[0].value).toBe('92000 GBP')
  })

  it('still reports the counts for a sensitive definition — the redaction is of values, not of the report', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ dataType: 'string', sensitive: true })
    await seedHolders(definition.key, ['1', '2', 'nope'])

    const res = await preview(definition.id, { dataType: 'number' }).expect(200)
    expect(res.body).toMatchObject({ populationSize: 3, changedCount: 2 })
    expect(res.body.unconvertible).toHaveLength(1)
  })
})

describe('POST /attribute-definitions/:id/commit (Milestone 8, Task 10)', () => {
  const commit = (id: string, body: object) =>
    request(app.getHttpServer()).post(`/attribute-definitions/${id}/commit`).send(body)

  /** Takes a real preview through the route and returns the hash it minted — the only thing that authorises a commit. */
  async function previewHashFor(id: string, change: object): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(`/attribute-definitions/${id}/preview`)
      .send(change)
      .expect(200)
    return res.body.previewHash as string
  }

  it('rejects a caller holding attribute:read but not attribute:manage with 403', async () => {
    await actAs('user_admin')
    const definition = await seedDefinition()

    const res = await commit(definition.id, { dataType: 'number', previewHash: 'x' }).expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  it('rejects an org-unit-scoped super_admin with 403', async () => {
    const scope = await makeOrgUnit('Scoped Committer')
    await actAs('super_admin', scope.id)
    const definition = await seedDefinition()

    const res = await commit(definition.id, { dataType: 'number', previewHash: 'x' }).expect(403)
    expect(res.body.message).toMatch(/global/i)
  })

  /**
   * THE HEADLINE REQUIREMENT of this task. A commit with no hash is a commit
   * nobody previewed, and the whole two-phase design collapses if the field
   * is optional — so it is refused by the DTO, before the job is reached and
   * before a single user row is read.
   */
  it('refuses a commit carrying no preview hash with 400', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ dataType: 'string' })
    const [holder] = await seedHolders(definition.key, ['5'])

    const res = await commit(definition.id, { dataType: 'number' }).expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
    expect(JSON.stringify(res.body.issues)).toMatch(/previewHash/)

    // And nothing moved on the way to that refusal.
    const [user] = await ctx.db.select().from(users).where(eq(users.id, holder))
    expect(user.attributes).toEqual({ [definition.key]: '5' })
  })

  it('refuses an empty preview hash with 400 rather than treating it as absent', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ dataType: 'string' })

    const res = await commit(definition.id, { dataType: 'number', previewHash: '' }).expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('rejects a non-UUID id with 400', async () => {
    await actAs('super_admin')

    const res = await commit('not-a-uuid', { dataType: 'number', previewHash: 'x' }).expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('returns 404 for an id that does not exist', async () => {
    await actAs('super_admin')

    const res = await commit(randomUUID(), { dataType: 'number', previewHash: 'x' }).expect(404)
    expect(res.body.code).toBe('NOT_FOUND')
  })

  it('surfaces a preview hash that no longer authorises the migration as 409', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ dataType: 'string' })
    const [holder] = await seedHolders(definition.key, ['5'])
    const hash = await previewHashFor(definition.id, { dataType: 'number' })

    // Somebody edits a holder's value between the preview and the commit —
    // the id set is identical, the value this migration would overwrite is
    // not.
    await ctx.db
      .update(users)
      .set({ attributes: { [definition.key]: '6' } })
      .where(eq(users.id, holder))

    const res = await commit(definition.id, { dataType: 'number', previewHash: hash }).expect(409)
    expect(res.body.code).toBe('CONFLICT')
    expect(res.body.message).toMatch(/preview/i)
  })

  it('applies the migration and records it against the HTTP caller', async () => {
    const actorId = await actAs('super_admin')
    const definition = await seedDefinition({ dataType: 'string' })
    const [holder] = await seedHolders(definition.key, ['42'])
    const hash = await previewHashFor(definition.id, { dataType: 'number' })

    const res = await commit(definition.id, { dataType: 'number', previewHash: hash }).expect(200)
    expect(res.body).toMatchObject({ populationSize: 1, changedCount: 1, unconvertible: [] })

    const [user] = await ctx.db.select().from(users).where(eq(users.id, holder))
    expect(user.attributes).toEqual({ [definition.key]: 42 })

    const [stored] = await ctx.db
      .select()
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.id, definition.id))
    expect(stored.dataType).toBe('number')

    const rows = await auditRowsFor(definition.id, 'attribute_definition:migrate')
    expect(rows).toHaveLength(1)
    expect(rows[0].actorUserId).toBe(actorId)
  })

  it('surfaces the sensitive refusal as 400, naming the flag', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ dataType: 'string', sensitive: true })
    await seedHolders(definition.key, ['1'])
    const hash = await previewHashFor(definition.id, { dataType: 'number' })

    const res = await commit(definition.id, { dataType: 'number', previewHash: hash }).expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
    expect(JSON.stringify(res.body.issues)).toMatch(/sensitive/i)
  })

  it('surfaces the unconvertible refusal as 400, which force cannot answer', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ dataType: 'string' })
    await seedHolders(definition.key, ['1', 'not a number'])
    const hash = await previewHashFor(definition.id, { dataType: 'number' })

    const res = await commit(definition.id, {
      dataType: 'number',
      previewHash: hash,
      force: true,
    }).expect(400)
    expect(JSON.stringify(res.body.issues)).toMatch(/cannot be converted/i)
  })

  /**
   * The one refusal `force` MAY answer, driven end to end through the route
   * so the flag is proved to reach the job rather than being parsed and
   * dropped.
   */
  it('refuses a migration past the blast radius with 400, and applies the same one with force', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition({ dataType: 'string' })
    const holders = await seedHolders(definition.key, ['1', '2', '3', '4', '5', '6'])
    const hash = await previewHashFor(definition.id, { dataType: 'number' })

    const refused = await commit(definition.id, {
      dataType: 'number',
      previewHash: hash,
    }).expect(400)
    expect(JSON.stringify(refused.body.issues)).toMatch(/force/i)

    // Nothing was applied, so the same hash still authorises the retry.
    await commit(definition.id, { dataType: 'number', previewHash: hash, force: true }).expect(200)

    const rows = await ctx.db.select().from(users).where(inArray(users.id, holders))
    const migrated = rows.map((row) => (row.attributes ?? {})[definition.key])
    expect(migrated.sort()).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('rejects an unknown body field with 400', async () => {
    await actAs('super_admin')
    const definition = await seedDefinition()

    await commit(definition.id, { dataType: 'number', previewHash: 'x', bogus: 1 }).expect(400)
  })
})
