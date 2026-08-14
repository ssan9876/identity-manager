import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import { PrivilegeGuards } from '../src/authz/privilege.guards'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { BusinessRolesRepository } from '../src/business-roles/business-roles.repository'
import { RoleReconciler } from '../src/business-roles/role-reconciler'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { organizations } from '../src/db/schema/organizations'
import { GroupsRepository } from '../src/groups/groups.repository'
import { KEYCLOAK_ADMIN_CONFIG, KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { SyncDetailRepository } from '../src/outbox/sync-detail.repository'
import { SyncStateRepository } from '../src/outbox/sync-state.repository'
import { UsersController } from '../src/users/users.controller'
import { UsersRepository, type User } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

const UNREACHABLE_KEYCLOAK = { issuer: 'http://127.0.0.1:1/realms/none', clientId: 'x', clientSecret: 'y' }

function stubJwtGuard(getUsername: () => string): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
        subject: 'tenant-isolation-audit',
        username: getUsername(),
        email: null,
      }
      return true
    },
  }
}

/**
 * ADVERSARIAL PASS — TENANT ISOLATION (the sixth audit dimension).
 *
 * docs/12-security.md constraint 12 makes a strong, falsifiable claim:
 *
 *   "every reference that could cross a tenant boundary — a user's org unit
 *   and manager, a group's org unit, an org unit's parent, both endpoints of
 *   every membership and nesting edge — is a composite foreign key including
 *   that column, so a cross-tenant row cannot be inserted by any writer: not
 *   the API, not a CSV import, not a connector write-back, NOT A FUTURE
 *   ENDPOINT, not a bug."
 *
 * "Not a future endpoint" is the part worth attacking, because endpoints have
 * been added since that sentence was written — `POST /users/:id/transfer`
 * among them, which moves a user between org units and is therefore the most
 * direct way to aim a user at another tenant's tree.
 *
 * These tests do not assert that the database ACCEPTS the write. They assert
 * what a caller sees when it refuses. A constraint that holds by 500 is still
 * a held constraint, but it is an unusable one: it tells an operator nothing,
 * it is indistinguishable from a genuine fault in monitoring, and it is the
 * shape of failure that gets "fixed" by someone catching the exception and
 * carrying on.
 */
describe('AUDIT: tenant isolation — cross-tenant references', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let currentUsername = ''

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        UsersRepository,
        OrgUnitsRepository,
        GroupsRepository,
        PermissionEngine,
        PermissionGuard,
        PrivilegeGuards,
        AuditWriter,
        OutboxWriter,
        SyncStateRepository,
        SyncDetailRepository,
        BusinessRolesRepository,
        RoleReconciler,
        RoleAssignmentsRepository,
        Reflector,
        { provide: KEYCLOAK_ADMIN_CONFIG, useValue: UNREACHABLE_KEYCLOAK },
        KeycloakAdminClient,
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

  let seq = 0
  const next = () => `ti${(seq += 1)}${Date.now().toString().slice(-5)}`

  const usersRepo = () => new UsersRepository(ctx.db)
  const orgUnitsRepo = () => new OrgUnitsRepository(ctx.db)
  const rolesRepo = () => new RoleAssignmentsRepository(ctx.db)

  /** A SECOND tenant, with its own root org unit — the other side of every boundary below. */
  async function makeTenant(label: string): Promise<{ id: string; rootId: string }> {
    const tag = next().toLowerCase()
    const [org] = await ctx.db
      .insert(organizations)
      .values({ slug: `${label}-${tag}`, name: `${label} ${tag}`, realm: `${label}-${tag}` })
      .returning()
    const root = await orgUnitsRepo().createRoot(`${label} ${tag} Root`, ctx.db, org!.id)
    return { id: org!.id, rootId: root.id }
  }

  async function makeActiveUserIn(orgUnitId: string): Promise<User> {
    const tag = next()
    const created = await usersRepo().create({
      primaryEmail: `${tag}@example.com`,
      username: tag,
      firstName: 'Cross',
      lastName: 'Tenant',
      orgUnitId,
    })
    return usersRepo().changeStatus(created.id, 'active')
  }

  /**
   * The actor lives in MASTER, always — `PermissionEngine.resolveActor` joins
   * `organizations.isMaster = true`, so a principal in a tenant does not
   * resolve at all. That is design decision 3 ("administrators are platform
   * operators authenticating against the master realm") enforced in code
   * rather than documented, and it is the first thing this pass confirmed:
   * an actor placed inside a tenant is refused as an unknown principal.
   */
  async function actAsGlobalAdmin(): Promise<User> {
    const masterUnit = await orgUnitsRepo().createRoot(`Audit Master ${next()}`)
    const actor = await makeActiveUserIn(masterUnit.id)
    await rolesRepo().assign({ userId: actor.id, roleKey: 'super_admin', scopeOrgUnitId: null })
    currentUsername = actor.username
    return actor
  }

  /**
   * THE ONE THAT MATTERS. `POST /users/:id/transfer` was added after constraint
   * 12 was written, and it is the most direct way to point a user at another
   * tenant's org unit: it sets `org_unit_id` and deliberately does not touch
   * `organization_id`, because a transfer is a move WITHIN a directory.
   *
   * A globally-granted super_admin passes every authorization check on both
   * ends — that is what a platform operator IS — so authorization does not
   * stop this. Only the composite foreign key does.
   */
  it('a global admin cannot transfer a user into another tenant, and is told why', async () => {
    const home = await makeTenant('home')
    const other = await makeTenant('other')
    await actAsGlobalAdmin()
    const subject = await makeActiveUserIn(home.rootId)

    const res = await request(app.getHttpServer())
      .post(`/users/${subject.id}/transfer`)
      .send({ orgUnitId: other.rootId })

    // The row must not have moved, whatever the status code.
    const after = await usersRepo().findById(subject.id)
    expect(after?.orgUnitId).toBe(home.rootId)

    // And the refusal must be legible. A 500 means the constraint held by
    // accident of the database rather than by the API's own reasoning, and
    // tells the caller nothing they can act on.
    expect(res.status).toBeLessThan(500)
    expect(String(res.body.message ?? '')).toMatch(/organization|tenant/i)
  })

  /**
   * The same boundary from the creation side, which predates the transfer
   * route and should already be covered.
   */
  it('a user cannot be created in another tenant while claiming this one', async () => {
    const home = await makeTenant('createhome')
    const other = await makeTenant('createother')
    await actAsGlobalAdmin()

    const tag = next()
    const res = await request(app.getHttpServer())
      .post('/users')
      .send({
        primaryEmail: `${tag}@example.com`,
        username: tag,
        firstName: 'A',
        lastName: 'B',
        orgUnitId: other.rootId,
      })

    // Creating INTO another tenant is legitimate for a platform operator —
    // the user simply belongs to that tenant. What must not happen is a row
    // whose organization_id disagrees with its org unit's.
    // Never let an auth failure satisfy this: a 401/403 would otherwise pass
    // a "did not create a bad row" assertion without exercising anything.
    expect([201, 400, 409]).toContain(res.status)

    if (res.status === 201) {
      const created = await usersRepo().findById(res.body.id)
      const unit = await orgUnitsRepo().findById(other.rootId)
      expect(created?.organizationId).toBe(unit?.organizationId)
    }
  })

  /**
   * A manager is the other cross-tenant reference constraint 12 names by hand.
   * `PATCH /users/:id` accepts `managerId` and nothing in the DTO says the
   * manager has to be a colleague.
   */
  it('a user cannot be given a manager from another tenant, and is told why', async () => {
    const home = await makeTenant('mgrhome')
    const other = await makeTenant('mgrother')
    await actAsGlobalAdmin()
    const subject = await makeActiveUserIn(home.rootId)
    const foreignManager = await makeActiveUserIn(other.rootId)

    const res = await request(app.getHttpServer())
      .patch(`/users/${subject.id}`)
      .send({ managerId: foreignManager.id })

    const after = await usersRepo().findById(subject.id)
    expect(after?.managerId ?? null).toBeNull()

    expect(res.status).toBeLessThan(500)
    expect(String(res.body.message ?? '')).toMatch(/organization|tenant|manager/i)
  })

  /**
   * The remaining edges constraint 12 names by hand, attacked at the
   * REPOSITORY level rather than through HTTP.
   *
   * That is deliberate and is the harder test: the controllers for these
   * were not built to be tenant-aware, so going through them would mostly
   * prove that authorization happens to refuse first. Calling the repository
   * directly removes every application-level opinion and leaves exactly what
   * constraint 12 actually claims — that the DATABASE refuses, so that no
   * future endpoint, import or connector write-back can produce the row
   * either.
   */
  describe('the database refuses, with no application check in front of it', () => {
    it('a group cannot be created in another tenant than its org unit', async () => {
      const other = await makeTenant('grouporg')
      const masterUnit = await orgUnitsRepo().createRoot(`Group Master ${next()}`)
      const masterOrgId = (await orgUnitsRepo().findById(masterUnit.id))!.organizationId

      // A group whose org unit belongs to `other` but which claims master.
      await expect(
        ctx.pool.query(
          `INSERT INTO groups (name, org_unit_id, organization_id) VALUES ($1, $2, $3)`,
          [`Cross ${next()}`, other.rootId, masterOrgId],
        ),
      ).rejects.toThrow(/foreign key|violates/i)
    })

    it('an org unit cannot be parented into another tenant', async () => {
      const other = await makeTenant('parent')
      const masterUnit = await orgUnitsRepo().createRoot(`Parent Master ${next()}`)
      const masterOrgId = (await orgUnitsRepo().findById(masterUnit.id))!.organizationId

      await expect(
        ctx.pool.query(
          `INSERT INTO org_units (name, parent_id, path, organization_id)
           VALUES ($1, $2, $3::ltree, $4)`,
          [`Cross ${next()}`, other.rootId, `cross_${next().toLowerCase()}`, masterOrgId],
        ),
      ).rejects.toThrow(/foreign key|violates/i)
    })

    /** Both endpoints of a membership edge, which is the classic leak shape. */
    it('a user from one tenant cannot be made a member of another tenant\u2019s group', async () => {
      const other = await makeTenant('member')
      const masterUnit = await orgUnitsRepo().createRoot(`Member Master ${next()}`)
      const masterOrgId = (await orgUnitsRepo().findById(masterUnit.id))!.organizationId
      const homeUser = await makeActiveUserIn(masterUnit.id)

      const { rows } = await ctx.pool.query<{ id: string }>(
        `INSERT INTO groups (name, org_unit_id, organization_id) VALUES ($1, $2, $3) RETURNING id`,
        [`Other ${next()}`, other.rootId, other.id],
      )
      const foreignGroupId = rows[0]!.id

      await expect(
        ctx.pool.query(
          `INSERT INTO group_user_members (group_id, user_id, organization_id, grant_source)
           VALUES ($1, $2, $3, 'manual')`,
          [foreignGroupId, homeUser.id, masterOrgId],
        ),
      ).rejects.toThrow(/foreign key|violates/i)
    })
  })
})
