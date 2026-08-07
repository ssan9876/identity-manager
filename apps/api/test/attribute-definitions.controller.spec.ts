import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AttributeDefinitionsController } from '../src/attributes/attribute-definitions.controller'
import { AttributeDefinitionsRepository } from '../src/attributes/attribute-definitions.repository'
import { JwtGuard } from '../src/auth/jwt.guard'
import type { RoleKey } from '../src/authz/actions'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { attributeDefinitions } from '../src/db/schema/attribute-definitions'
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
 * MILESTONE 8, TASK 3 — `GET /attribute-definitions`. Only JwtGuard is
 * stubbed; PermissionGuard/PermissionEngine run for real (same pattern as
 * org-units.write.spec.ts) so the permission gate itself is genuinely
 * exercised, not assumed.
 */
describe('GET /attribute-definitions (Milestone 8, Task 3)', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let currentUsername = ''

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AttributeDefinitionsController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        AttributeDefinitionsRepository,
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

  it('rejects a request with no appliesTo query param with 400 VALIDATION_FAILED', async () => {
    const org = await makeOrgUnit('No AppliesTo')
    const actor = await makeActiveUser('reader', org.id)
    await grant(actor.id, 'read_only', null)
    currentUsername = actor.username

    const res = await request(app.getHttpServer()).get('/attribute-definitions').expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('rejects an appliesTo value outside the user/group enum with 400 VALIDATION_FAILED', async () => {
    const org = await makeOrgUnit('Bad AppliesTo')
    const actor = await makeActiveUser('reader', org.id)
    await grant(actor.id, 'read_only', null)
    currentUsername = actor.username

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

  it('returns only active, user-scoped definitions, ordered by sortOrder then key, for a caller holding user:read', async () => {
    const org = await makeOrgUnit('User Defs')
    const actor = await makeActiveUser('reader', org.id)
    await grant(actor.id, 'read_only', null)
    currentUsername = actor.username

    const tag = nextTag()
    await ctx.db.insert(attributeDefinitions).values([
      {
        key: `zLast-${tag}`,
        label: 'Z Last',
        dataType: 'string',
        appliesTo: 'user',
        isActive: true,
        sortOrder: 5,
      },
      {
        key: `aFirst-${tag}`,
        label: 'A First',
        dataType: 'string',
        appliesTo: 'user',
        isActive: true,
        sortOrder: 1,
      },
      {
        key: `inactive-${tag}`,
        label: 'Inactive',
        dataType: 'string',
        appliesTo: 'user',
        isActive: false,
        sortOrder: 0,
      },
      {
        key: `groupScoped-${tag}`,
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
    expect(keys).toEqual([`aFirst-${tag}`, `zLast-${tag}`])
  })

  it('returns active, group-scoped definitions for a caller holding group:read (appliesTo=group), never a user-scoped sibling', async () => {
    const org = await makeOrgUnit('Group Defs')
    const actor = await makeActiveUser('reader', org.id)
    await grant(actor.id, 'read_only', null)
    currentUsername = actor.username

    const tag = nextTag()
    await ctx.db.insert(attributeDefinitions).values([
      { key: `groupOnly-${tag}`, label: 'Group Only', dataType: 'string', appliesTo: 'group', isActive: true },
      { key: `userSibling-${tag}`, label: 'User Sibling', dataType: 'string', appliesTo: 'user', isActive: true },
    ])

    const res = await request(app.getHttpServer())
      .get('/attribute-definitions?appliesTo=group')
      .expect(200)

    const keys = (res.body as { key: string }[]).map((d) => d.key)
    expect(keys).toContain(`groupOnly-${tag}`)
    expect(keys).not.toContain(`userSibling-${tag}`)
  })

  it('returns the full definition shape a client needs to render a field', async () => {
    const org = await makeOrgUnit('Shape')
    const actor = await makeActiveUser('reader', org.id)
    await grant(actor.id, 'read_only', null)
    currentUsername = actor.username

    const tag = nextTag()
    await ctx.db.insert(attributeDefinitions).values({
      key: `shaped-${tag}`,
      label: 'Shaped Field',
      dataType: 'enum',
      required: true,
      validationRules: { options: ['a', 'b'] },
      appliesTo: 'user',
      isActive: true,
      syncToKeycloak: true,
      selfEditable: false,
    })

    const res = await request(app.getHttpServer())
      .get('/attribute-definitions?appliesTo=user')
      .expect(200)

    const shaped = (res.body as Record<string, unknown>[]).find((d) => d.key === `shaped-${tag}`)
    expect(shaped).toMatchObject({
      key: `shaped-${tag}`,
      label: 'Shaped Field',
      dataType: 'enum',
      required: true,
      validationRules: { options: ['a', 'b'] },
      appliesTo: 'user',
      isActive: true,
      syncToKeycloak: true,
      selfEditable: false,
    })
  })
})
