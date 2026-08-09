import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { and, eq, isNull } from 'drizzle-orm'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard, type AuthorizedRequest } from '../src/authz/permission.guard'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { auditLog } from '../src/db/schema/audit-log'
import { orgUnits } from '../src/db/schema/org-units'
import { organizations } from '../src/db/schema/organizations'
import { outboxEvents } from '../src/db/schema/outbox-events'
import {
  KEYCLOAK_FACTORY_CONFIG,
  KeycloakAdminClientFactory,
  type KeycloakFactoryConfig,
} from '../src/keycloak/keycloak-admin-client.factory'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OrganizationsController } from '../src/organizations/organizations.controller'
import { OrganizationsRepository } from '../src/organizations/organizations.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

/**
 * Organizations milestone, Task 12 — `POST/GET/PATCH /organizations`.
 *
 * Postgres-only, with NO Keycloak container. Every question this controller
 * raises is answered before any Keycloak call happens: the realm is
 * provisioned asynchronously by the sync worker (Task 14), so the only thing
 * this surface asks of Keycloak is whether a provisioning CREDENTIAL is
 * configured — a pure, I/O-free read of the factory's own config
 * (`hasProvisioningCredentials`). Standing up a real Keycloak to answer that
 * would prove nothing this file does not already prove, and would triple the
 * file's runtime; `test/organization.connector.spec.ts` is where the real
 * container lives, because that is where the real realm calls do.
 *
 * The guard stack is stubbed exactly as org-units.controller.spec.ts stubs
 * it — a GLOBAL super_admin actor — because the interesting authorization
 * question here (a SCOPED grant is refused outright) is a
 * `requireGlobalGrant` question shared with SsoAppsController and already
 * covered against the real engine there. What is NOT shared, and so is
 * asserted below, is the tenant lifecycle itself.
 */

/** The master realm this deployment is pinned to — mirrors `KEYCLOAK_ISSUER`. */
const MASTER_REALM = 'identity-manager'

const PROVISIONING_CONFIG: KeycloakFactoryConfig = {
  issuer: `http://127.0.0.1:1/realms/${MASTER_REALM}`,
  clientId: 'irrelevant',
  clientSecret: 'irrelevant',
  provisionClientId: 'idm-provisioner',
  provisionClientSecret: 'irrelevant',
}

/**
 * The SAME config with both provisioning halves absent — what a deployment
 * that has never been given `KEYCLOAK_PROVISION_CLIENT_ID`/`_SECRET` looks
 * like, which is every deployment before an operator opts in.
 */
const UNPROVISIONED_CONFIG: KeycloakFactoryConfig = {
  ...PROVISIONING_CONFIG,
  provisionClientId: null,
  provisionClientSecret: null,
}

describe('OrganizationsController (Task 12)', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let unprovisionedApp: INestApplication
  let actorUserId: string
  let masterId: string

  /**
   * A real `users` row, because `audit_log.actor_user_id` is a FK with
   * `ON DELETE RESTRICT` — a synthetic UUID would make every audited write
   * below fail with a foreign-key violation rather than the outcome under
   * test.
   */
  const actor = (): AuthorizedRequest['actor'] => ({
    userId: actorUserId,
    username: 'org-test-actor',
    orgUnitId: actorUserId,
    assignments: [{ roleKey: 'super_admin', scopeOrgUnitId: null, scopePath: null }],
  })

  const stubPermissionGuard: CanActivate = {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<AuthorizedRequest>().actor = actor()
      return true
    },
  }

  async function buildApp(config: KeycloakFactoryConfig): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrganizationsController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        { provide: KEYCLOAK_FACTORY_CONFIG, useValue: config },
        KeycloakAdminClientFactory,
        OrganizationsRepository,
        OrgUnitsRepository,
        PermissionEngine,
        AuditWriter,
        OutboxWriter,
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionGuard)
      .useValue(stubPermissionGuard)
      .compile()

    const built = moduleRef.createNestApplication()
    built.useGlobalFilters(new DomainExceptionFilter())
    await built.init()
    return built
  }

  const post = (body: object) => request(app.getHttpServer()).post('/organizations').send(body)
  const patch = (id: string, body: object) =>
    request(app.getHttpServer()).patch(`/organizations/${id}`).send(body)

  beforeAll(async () => {
    // The root org unit and the actor both belong to master — the only
    // organization that exists before this suite creates any.
    const root = await new OrgUnitsRepository(ctx.db).createRoot('Platform')
    const user = await new UsersRepository(ctx.db).create({
      primaryEmail: 'org-test-actor@example.com',
      username: 'org-test-actor',
      firstName: 'Org',
      lastName: 'Actor',
      orgUnitId: root.id,
    })
    actorUserId = user.id

    // Master's `realm` is NULL until `adoptMasterRealm` runs at startup, and
    // nothing in this suite runs `main.ts`. Setting it here is what makes the
    // "reserved slug" check against master's own realm a real test rather
    // than a comparison with null.
    const [master] = await ctx.db
      .update(organizations)
      .set({ realm: MASTER_REALM })
      .where(eq(organizations.isMaster, true))
      .returning()
    masterId = master!.id

    app = await buildApp(PROVISIONING_CONFIG)
    unprovisionedApp = await buildApp(UNPROVISIONED_CONFIG)
  })

  afterAll(async () => {
    await app?.close()
    await unprovisionedApp?.close()
  })

  beforeEach(async () => {
    // Only the tenants this suite creates. Master, the actor, the root org
    // unit and every audit row they produced are deliberately left alone —
    // audit_log is append-only and its actor FK is `restrict`, so a blanket
    // delete would fail rather than clean up.
    await ctx.pool.query('DELETE FROM outbox_events')
    await ctx.pool.query("DELETE FROM org_units WHERE organization_id <> $1", [masterId])
    await ctx.pool.query('DELETE FROM organizations WHERE NOT is_master')
  })

  it('creates an organization, its root org unit, an audit row and one outbox event', async () => {
    const response = await post({ slug: 'acme', name: 'Acme Corp' })

    expect(response.status).toBe(201)
    expect(response.body).toMatchObject({ slug: 'acme', name: 'Acme Corp', status: 'active' })
    // The realm is NAMED at creation but not yet PROVISIONED — the console's
    // "Provisioning" badge is derived from exactly this pair.
    expect(response.body.realm).toBe('acme')
    expect(response.body.realmProvisionedAt).toBeNull()
    expect(response.body.isMaster).toBe(false)

    const [root] = await ctx.db
      .select()
      .from(orgUnits)
      .where(and(eq(orgUnits.organizationId, response.body.id), isNull(orgUnits.parentId)))
    expect(root!.path).toBe('acme_corp')

    const events = await ctx.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, response.body.id))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ aggregateType: 'organization', target: 'keycloak' })

    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.resourceId, response.body.id))
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ action: 'organization:create', resourceType: 'organization' })
  })

  it('rejects a reserved slug', async () => {
    expect((await post({ slug: 'master', name: 'X' })).status).toBe(409)
  })

  it("rejects the master organization's own realm as a slug", async () => {
    const response = await post({ slug: MASTER_REALM, name: 'X' })
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('CONFLICT')
  })

  it('rejects a malformed slug', async () => {
    expect((await post({ slug: 'Acme Corp!', name: 'X' })).status).toBe(400)
  })

  it('rejects a duplicate slug', async () => {
    expect((await post({ slug: 'acme', name: 'Acme' })).status).toBe(201)
    const duplicate = await post({ slug: 'acme', name: 'Again' })
    expect(duplicate.status).toBe(409)
    expect(duplicate.body.code).toBe('CONFLICT')
  })

  it('returns 503 when no provisioning credential is configured', async () => {
    const response = await request(unprovisionedApp.getHttpServer())
      .post('/organizations')
      .send({ slug: 'acme', name: 'Acme' })

    expect(response.status).toBe(503)
    expect(response.body.code).toBe('NOT_CONFIGURED')
    // Refused BEFORE the insert, not after — the whole point of the check.
    const rows = await ctx.db.select().from(organizations).where(eq(organizations.slug, 'acme'))
    expect(rows).toHaveLength(0)
  })

  it('refuses to change a slug', async () => {
    const created = await post({ slug: 'acme', name: 'Acme' })
    expect((await patch(created.body.id, { slug: 'other' })).status).toBe(400)
  })

  it('suspends and reactivates a tenant, auditing each transition', async () => {
    const created = await post({ slug: 'acme', name: 'Acme' })

    const suspended = await patch(created.body.id, { status: 'suspended' })
    expect(suspended.status).toBe(200)
    expect(suspended.body.status).toBe('suspended')

    const reactivated = await patch(created.body.id, { status: 'active' })
    expect(reactivated.body.status).toBe('active')

    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.resourceId, created.body.id), eq(auditLog.action, 'organization:update')))
    expect(audits).toHaveLength(2)
  })

  it('refuses to suspend the master organization', async () => {
    const response = await patch(masterId, { status: 'suspended' })
    expect(response.status).toBe(409)
  })

  it('404s an unknown organization', async () => {
    const response = await patch('00000000-0000-0000-0000-000000000000', { status: 'suspended' })
    expect(response.status).toBe(404)
    expect(response.body.code).toBe('NOT_FOUND')
  })

  it('lists organizations including master, as a page', async () => {
    await post({ slug: 'acme', name: 'Acme' })
    await post({ slug: 'globex', name: 'Globex' })

    const response = await request(app.getHttpServer()).get('/organizations').expect(200)
    expect(response.body.total).toBe(3)
    expect(response.body.items.map((o: { slug: string }) => o.slug)).toEqual([
      'acme',
      'globex',
      'master',
    ])
  })

  it('exposes no delete route', async () => {
    const created = await post({ slug: 'acme', name: 'Acme' })
    await request(app.getHttpServer()).delete(`/organizations/${created.body.id}`).expect(404)
  })
})
