import { randomUUID } from 'node:crypto'
import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AttributeTargetMappingsRepository } from '../src/attributes/attribute-target-mappings.repository'
import { JwtGuard } from '../src/auth/jwt.guard'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import type { RoleKey } from '../src/authz/actions'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { ConnectorTargetsRepository } from '../src/connectors/connector-targets.repository'
import { DataFlowsController, type DataFlowMap } from '../src/connectors/data-flows.controller'
import { organizations } from '../src/db/schema/organizations'
import { orgUnits } from '../src/db/schema/org-units'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OrganizationsRepository } from '../src/organizations/organizations.repository'
import { UsersRepository, type User } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

function stubJwtGuard(getUsername: () => string): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
        subject: 'data-flows-test',
        username: getUsername(),
        email: null,
      }
      return true
    },
  }
}

/**
 * `GET /data-flows` — the read-only "what of ours goes where" map.
 *
 * The properties worth pinning: it is guarded by `connector:read` like every
 * other connector read; it is organization-scoped the same way
 * `ConnectorTargetsController` is; it returns EVERY target in the catalog
 * (not only configured ones, so an operator can see what is available and
 * dormant); and it never returns `connector_targets.config`, which can hold
 * a secret NAME.
 */
describe('DataFlowsController', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let currentUsername = ''
  let orgUnitId: string

  beforeAll(async () => {
    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`Data Flows Root ${Date.now()}`)).id

    const moduleRef = await Test.createTestingModule({
      controllers: [DataFlowsController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        ConnectorTargetsRepository,
        AttributeTargetMappingsRepository,
        OrganizationsRepository,
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

  let seq = 0
  function nextTag(): string {
    seq += 1
    return `df${seq}`
  }

  async function makeActiveUser(roleKey?: RoleKey, scopeOrgUnitId: string | null = null): Promise<User> {
    const tag = nextTag()
    const repo = new UsersRepository(ctx.db)
    const created = await repo.create({
      primaryEmail: `${tag}@example.com`,
      username: `${tag}@example.com`,
      firstName: 'Data',
      lastName: `Flows${tag}`,
      orgUnitId,
    })
    const active = await repo.changeStatus(created.id, 'active')
    if (roleKey !== undefined) {
      await new RoleAssignmentsRepository(ctx.db).assign({ userId: active.id, roleKey, scopeOrgUnitId })
    }
    return active
  }

  async function insertTenant(): Promise<string> {
    const id = randomUUID()
    const tag = nextTag()
    await ctx.db.insert(organizations).values({
      id,
      name: `Tenant ${tag}`,
      slug: `tenant-${tag}-${Date.now()}`,
      realm: `tenant-${tag}`,
      isMaster: false,
      status: 'active',
    })
    await ctx.db.insert(orgUnits).values({
      id: randomUUID(),
      organizationId: id,
      name: `Tenant Root ${tag}`,
      path: `tenant_root_${tag.toLowerCase()}_${Date.now()}`,
      parentId: null,
    })
    return id
  }

  // ------------------------------------------------------------ authorization

  it('rejects a caller holding no role at all with 403', async () => {
    const user = await makeActiveUser()
    currentUsername = user.username
    await request(app.getHttpServer()).get('/data-flows').expect(403)
  })

  it('allows a caller holding connector:read', async () => {
    const user = await makeActiveUser('auditor')
    currentUsername = user.username
    await request(app.getHttpServer()).get('/data-flows').expect(200)
  })

  /**
   * PINS A DELIBERATE CHOICE, not an oversight. Connector READS have never
   * been org-scoped in this codebase — `ConnectorTargetsController` asserts a
   * global grant for `connector:manage` only, and its list route returns
   * `config` (which can hold a secret NAME) to any `connector:read` holder
   * for any organization. This endpoint returns strictly less than that, so
   * it matches rather than inventing a stricter model for one view. If that
   * rule should change, it changes in both controllers together — and this
   * test is what will fail to say so.
   */
  it('lets a scoped connector:read holder read another organization, matching the connector-targets route', async () => {
    const tenantId = await insertTenant()
    const user = await makeActiveUser('auditor', orgUnitId)
    currentUsername = user.username
    const res = await request(app.getHttpServer()).get('/data-flows').query({ organizationId: tenantId }).expect(200)
    expect((res.body as DataFlowMap).organizationId).toBe(tenantId)
  })

  it('404s a named organization that does not exist', async () => {
    const user = await makeActiveUser('super_admin')
    currentUsername = user.username
    await request(app.getHttpServer()).get('/data-flows').query({ organizationId: randomUUID() }).expect(404)
  })

  // -------------------------------------------------------------------- shape

  it('returns every target in the catalog, including unconfigured ones', async () => {
    const user = await makeActiveUser('super_admin')
    currentUsername = user.username

    const res = await request(app.getHttpServer()).get('/data-flows').expect(200)
    const body = res.body as DataFlowMap

    // The six SCIM slots are part of the catalog and must be visible even
    // before anyone configures them — the map's job is to show what CAN flow
    // as well as what does.
    const targets = body.outbound.map((edge) => edge.target)
    expect(targets).toContain('scim_slack')
    expect(targets).toContain('scim_generic')
    expect(targets).toContain('keycloak')
    expect(body.outbound.length).toBeGreaterThanOrEqual(13)
  })

  it('marks keycloak_sso as not carrying users', async () => {
    const user = await makeActiveUser('super_admin')
    currentUsername = user.username

    const res = await request(app.getHttpServer()).get('/data-flows').expect(200)
    const body = res.body as DataFlowMap

    expect(body.outbound.find((edge) => edge.target === 'keycloak_sso')?.carriesUsers).toBe(false)
    expect(body.outbound.find((edge) => edge.target === 'scim_slack')?.carriesUsers).toBe(true)
  })

  /** `connector_targets.config` can hold a secret NAME; this endpoint must not return it at all. */
  it('never returns connector config', async () => {
    const user = await makeActiveUser('super_admin')
    currentUsername = user.username
    // Written directly rather than through `ConnectorTargetsRepository.upsert`,
    // which takes an advisory lock and so needs a real transaction handle.
    const masterId = (await new OrganizationsRepository(ctx.db).findMaster()).id
    await ctx.pool.query(
      `INSERT INTO connector_targets (organization_id, target, enabled, config)
            VALUES ($1, 'echo', true, $2::jsonb)
       ON CONFLICT (organization_id, target)
       DO UPDATE SET enabled = true, config = EXCLUDED.config`,
      [masterId, JSON.stringify({ credentialSecretName: 'CONNECTOR_DATA_FLOWS_SENTINEL' })],
    )

    const res = await request(app.getHttpServer()).get('/data-flows').expect(200)

    expect(JSON.stringify(res.body)).not.toContain('CONNECTOR_DATA_FLOWS_SENTINEL')
    expect(JSON.stringify(res.body)).not.toContain('credentialSecretName')
    const echo = (res.body as DataFlowMap).outbound.find((edge) => edge.target === 'echo')
    expect(echo).not.toHaveProperty('config')
    expect(echo?.configured).toBe(true)
    expect(echo?.enabled).toBe(true)
  })

  it('reports an unconfigured target as configured:false rather than omitting it', async () => {
    const user = await makeActiveUser('super_admin')
    currentUsername = user.username
    await ctx.pool.query('DELETE FROM connector_targets WHERE target = $1', ['scim_zoom'])

    const res = await request(app.getHttpServer()).get('/data-flows').expect(200)
    const zoom = (res.body as DataFlowMap).outbound.find((edge) => edge.target === 'scim_zoom')

    expect(zoom).toBeDefined()
    expect(zoom?.configured).toBe(false)
    expect(zoom?.enabled).toBe(false)
    expect(zoom?.provisioningMode).toBe('all_users')
  })

  /** An organization with no HR sources has no inbound edges — an empty list, never another organization's. */
  it('scopes inbound sources to the named organization', async () => {
    const tenantId = await insertTenant()
    const user = await makeActiveUser('super_admin')
    currentUsername = user.username

    const res = await request(app.getHttpServer()).get('/data-flows').query({ organizationId: tenantId }).expect(200)
    const body = res.body as DataFlowMap

    expect(body.organizationId).toBe(tenantId)
    expect(body.inbound).toEqual([])
  })
})
