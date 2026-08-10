import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import type { RoleKey } from '../src/authz/actions'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { ConnectorTargetsRepository } from '../src/connectors/connector-targets.repository'
import { KeycloakSsoConnectorFactory, type SsoAdminApi } from '../src/connectors/keycloak-sso.connector'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OrganizationsRepository } from '../src/organizations/organizations.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { SsoAppsController } from '../src/sso-apps/sso-apps.controller'
import { SsoAppsRepository } from '../src/sso-apps/sso-apps.repository'
import { UsersRepository, type User } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'
import { assertNoLeak } from './support/secret-leak'

function stubJwtGuard(getUsername: () => string): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
        subject: 'sso-apps-test',
        username: getUsername(),
        email: null,
      }
      return true
    },
  }
}

const SECRET_SENTINEL = 'MINTED-SECRET-SENTINEL-do-not-store'

const TEST_PEM =
  '-----BEGIN CERTIFICATE-----\nMIIBszCCARygAwIBAgIBATANBgkqhkiG9w0BAQsFADAA\n-----END CERTIFICATE-----'

const VALID_SAML_BODY = {
  protocol: 'saml',
  entityId: 'https://hr.example.com/saml/metadata',
  name: 'HR Suite',
  description: 'HR SaaS',
  acsUrls: ['https://hr.example.com/saml/acs'],
  signAssertions: true,
  nameIdFormat: 'email',
  groupsClaim: true,
}

const VALID_BODY = {
  clientId: 'billing-portal',
  name: 'Billing Portal',
  description: 'Customer billing',
  publicClient: false,
  redirectUris: ['https://billing.example.com/cb'],
  webOrigins: ['https://billing.example.com'],
  groupsClaim: true,
}

/**
 * Only JwtGuard is stubbed. PermissionGuard and PermissionEngine run for
 * real, so `sso_app:read`/`sso_app:manage` and the global-grant rule are
 * genuinely exercised rather than assumed — same discipline as
 * connector-targets.controller.spec.ts.
 */
describe('SsoAppsController', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let currentUsername = ''
  let orgUnitId: string
  let mintCalls: string[]

  beforeAll(async () => {
    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`SSO Apps Root ${Date.now()}`)).id

    const fakeFactory = {
      configureAdmin(): SsoAdminApi {
        return {
          async mintClientSecret(uuid: string) {
            mintCalls.push(uuid)
            return SECRET_SENTINEL
          },
        } as unknown as SsoAdminApi
      },
    } as unknown as KeycloakSsoConnectorFactory

    const moduleRef = await Test.createTestingModule({
      controllers: [SsoAppsController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        { provide: KeycloakSsoConnectorFactory, useValue: fakeFactory },
        SsoAppsRepository,
        ConnectorTargetsRepository,
        OrganizationsRepository,
        AuditWriter,
        OutboxWriter,
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
  async function makeActiveUser(roleKey?: RoleKey, scopeOrgUnitId: string | null = null): Promise<User> {
    seq += 1
    const tag = `sso${seq}`
    const users = new UsersRepository(ctx.db)
    const created = await users.create({
      primaryEmail: `${tag}@example.com`,
      username: `${tag}@example.com`,
      firstName: 'Sso',
      lastName: `Test${tag}`,
      orgUnitId,
    })
    const active = await users.changeStatus(created.id, 'active')
    if (roleKey !== undefined) {
      await new RoleAssignmentsRepository(ctx.db).assign({ userId: active.id, roleKey, scopeOrgUnitId })
    }
    return active
  }

  async function asSuperAdmin(): Promise<void> {
    currentUsername = (await makeActiveUser('super_admin')).username
  }

  beforeEach(async () => {
    await ctx.pool.query('DELETE FROM outbox_events')
    await ctx.pool.query('DELETE FROM external_sso_app_identities')
    await ctx.pool.query('DELETE FROM sso_apps')
    await ctx.pool.query('DELETE FROM connector_targets')
    mintCalls = []
  })

  async function enableSsoTarget(): Promise<void> {
    await ctx.pool.query(
      `INSERT INTO connector_targets (target, enabled, config)
       VALUES ('keycloak_sso', true, $1::jsonb)`,
      [JSON.stringify({ baseUrl: 'https://kc.example.com', realm: 'idm', clientId: 'idm-sso-admin', credentialSecretName: 'CONNECTOR_KEYCLOAK_SSO_CLIENT_SECRET' })],
    )
  }

  // =========================================================================
  // Authorization
  // =========================================================================

  it('rejects a caller holding no role with 403', async () => {
    currentUsername = (await makeActiveUser()).username
    await request(app.getHttpServer()).get('/sso-apps').expect(403)
  })

  it('rejects user_admin — minting OAuth clients is not people administration', async () => {
    currentUsername = (await makeActiveUser('user_admin')).username
    await request(app.getHttpServer()).get('/sso-apps').expect(403)
    await request(app.getHttpServer()).post('/sso-apps').send(VALID_BODY).expect(403)
  })

  it('rejects a SCOPED super_admin grant — this action is global-only', async () => {
    // An application belongs to no org unit, so a scoped grant has nothing to
    // narrow to and must not be silently treated as global.
    currentUsername = (await makeActiveUser('super_admin', orgUnitId)).username
    const res = await request(app.getHttpServer()).post('/sso-apps').send(VALID_BODY).expect(403)
    expect(res.body.message).toMatch(/global grant/i)
  })

  // =========================================================================
  // Create + validation rails
  // =========================================================================

  it('creates an application with its audit row and exactly one outbox row', async () => {
    await asSuperAdmin()
    await enableSsoTarget()

    const res = await request(app.getHttpServer()).post('/sso-apps').send(VALID_BODY).expect(201)
    expect(res.body.clientId).toBe('billing-portal')
    expect(res.body.enabled).toBe(true)

    const audit = await ctx.pool.query(
      `SELECT action FROM audit_log WHERE resource_id = $1`, [res.body.id],
    )
    expect(audit.rows.map((r) => r.action)).toEqual(['sso_app:create'])

    // Fan-out: keycloak_sso and nothing else, even though it is the only
    // enabled target here — the assertion that matters is that no directory
    // target receives an application.
    const events = await ctx.pool.query(
      `SELECT target, aggregate_type FROM outbox_events WHERE aggregate_id = $1`, [res.body.id],
    )
    expect(events.rows).toEqual([{ target: 'keycloak_sso', aggregate_type: 'sso_app' }])
  })

  it('rejects an unknown key by name', async () => {
    await asSuperAdmin()
    const res = await request(app.getHttpServer())
      .post('/sso-apps')
      .send({ ...VALID_BODY, publicClinet: true })
      .expect(400)
    expect(JSON.stringify(res.body)).toMatch(/publicClinet/)
  })

  it('rejects a wildcard redirect URI and names it', async () => {
    await asSuperAdmin()
    const res = await request(app.getHttpServer())
      .post('/sso-apps')
      .send({ ...VALID_BODY, redirectUris: ['https://*'] })
      .expect(400)
    expect(JSON.stringify(res.body)).toMatch(/wildcard/)
  })

  it('reports every bad redirect URI at once, not just the first', async () => {
    await asSuperAdmin()
    const res = await request(app.getHttpServer())
      .post('/sso-apps')
      .send({ ...VALID_BODY, redirectUris: ['https://*', 'not-a-url'] })
      .expect(400)
    const body = JSON.stringify(res.body)
    expect(body).toMatch(/https:\/\/\*/)
    expect(body).toMatch(/not-a-url/)
  })

  it('rejects a reserved client id', async () => {
    await asSuperAdmin()
    const res = await request(app.getHttpServer())
      .post('/sso-apps')
      .send({ ...VALID_BODY, clientId: 'idm-console' })
      .expect(400)
    expect(JSON.stringify(res.body)).toMatch(/reserved/)
  })

  it('409s on a duplicate client id', async () => {
    await asSuperAdmin()
    await request(app.getHttpServer()).post('/sso-apps').send(VALID_BODY).expect(201)
    await request(app.getHttpServer()).post('/sso-apps').send(VALID_BODY).expect(409)
  })

  // =========================================================================
  // Patch
  // =========================================================================

  it('PATCH cannot change clientId', async () => {
    await asSuperAdmin()
    const created = await request(app.getHttpServer()).post('/sso-apps').send(VALID_BODY).expect(201)

    const res = await request(app.getHttpServer())
      .patch(`/sso-apps/${created.body.id}`)
      .send({ clientId: 'renamed' })
      .expect(400)
    expect(JSON.stringify(res.body)).toMatch(/clientId/)
  })

  it('PATCH cannot flip enabled — that is its own audited route', async () => {
    await asSuperAdmin()
    const created = await request(app.getHttpServer()).post('/sso-apps').send(VALID_BODY).expect(201)

    await request(app.getHttpServer())
      .patch(`/sso-apps/${created.body.id}`)
      .send({ enabled: false })
      .expect(400)
  })

  it('PATCH emits an updated event', async () => {
    await asSuperAdmin()
    await enableSsoTarget()
    const created = await request(app.getHttpServer()).post('/sso-apps').send(VALID_BODY).expect(201)

    await request(app.getHttpServer())
      .patch(`/sso-apps/${created.body.id}`)
      .send({ name: 'Renamed' })
      .expect(200)

    const events = await ctx.pool.query(
      `SELECT event_type FROM outbox_events WHERE aggregate_id = $1 ORDER BY id`, [created.body.id],
    )
    expect(events.rows.map((r) => r.event_type)).toEqual(['created', 'updated'])
  })

  // =========================================================================
  // Enable / disable
  // =========================================================================

  it('disable sets enabled false and audits it as its own action', async () => {
    await asSuperAdmin()
    await enableSsoTarget()
    const created = await request(app.getHttpServer()).post('/sso-apps').send(VALID_BODY).expect(201)

    const res = await request(app.getHttpServer())
      .post(`/sso-apps/${created.body.id}/disable`)
      .expect(200)
    expect(res.body.enabled).toBe(false)

    const audit = await ctx.pool.query(
      `SELECT action FROM audit_log WHERE resource_id = $1 ORDER BY id`, [created.body.id],
    )
    expect(audit.rows.map((r) => r.action)).toEqual(['sso_app:create', 'sso_app:disable'])
  })

  it('has no DELETE route', async () => {
    await asSuperAdmin()
    const created = await request(app.getHttpServer()).post('/sso-apps').send(VALID_BODY).expect(201)
    await request(app.getHttpServer()).delete(`/sso-apps/${created.body.id}`).expect(404)
  })

  it('404s for an unknown application', async () => {
    await asSuperAdmin()
    await request(app.getHttpServer())
      .get('/sso-apps/00000000-0000-0000-0000-000000000000')
      .expect(404)
  })

  // =========================================================================
  // Secret minting
  // =========================================================================

  it('409s when minting before the first sync', async () => {
    // The application exists HERE; there is simply no Keycloak client yet.
    await asSuperAdmin()
    await enableSsoTarget()
    const created = await request(app.getHttpServer()).post('/sso-apps').send(VALID_BODY).expect(201)

    const res = await request(app.getHttpServer())
      .post(`/sso-apps/${created.body.id}/client-secret`)
      .expect(409)
    expect(JSON.stringify(res.body)).toMatch(/has not synced/)
  })

  it('409s when minting for a public client', async () => {
    await asSuperAdmin()
    await enableSsoTarget()
    const created = await request(app.getHttpServer())
      .post('/sso-apps')
      .send({ ...VALID_BODY, publicClient: true })
      .expect(201)

    const res = await request(app.getHttpServer())
      .post(`/sso-apps/${created.body.id}/client-secret`)
      .expect(409)
    expect(JSON.stringify(res.body)).toMatch(/public client/)
  })

  it('mints against the stored Keycloak UUID and returns it once', async () => {
    await asSuperAdmin()
    await enableSsoTarget()
    const created = await request(app.getHttpServer()).post('/sso-apps').send(VALID_BODY).expect(201)
    await ctx.pool.query(
      `INSERT INTO external_sso_app_identities (app_id, system, external_id, sync_state)
       VALUES ($1, 'keycloak_sso', 'uuid-from-keycloak', 'synced')`,
      [created.body.id],
    )

    const res = await request(app.getHttpServer())
      .post(`/sso-apps/${created.body.id}/client-secret`)
      .expect(200)

    expect(res.body.secret).toBe(SECRET_SENTINEL)
    expect(mintCalls).toEqual(['uuid-from-keycloak'])
  })

  // =========================================================================
  // SAML
  // =========================================================================

  it('creates a SAML application — entity id as clientId, audit + one outbox row', async () => {
    await asSuperAdmin()
    await enableSsoTarget()

    const res = await request(app.getHttpServer()).post('/sso-apps').send(VALID_SAML_BODY).expect(201)
    expect(res.body.protocol).toBe('saml')
    expect(res.body.clientId).toBe('https://hr.example.com/saml/metadata')
    expect(res.body.publicClient).toBe(false)
    expect(res.body.samlAcsUrls).toEqual(['https://hr.example.com/saml/acs'])
    expect(res.body.samlNameIdFormat).toBe('email')
    expect(res.body.samlSignAssertions).toBe(true)

    const audit = await ctx.pool.query(
      `SELECT action FROM audit_log WHERE resource_id = $1`, [res.body.id],
    )
    expect(audit.rows.map((r) => r.action)).toEqual(['sso_app:create'])

    const events = await ctx.pool.query(
      `SELECT target, aggregate_type FROM outbox_events WHERE aggregate_id = $1`, [res.body.id],
    )
    expect(events.rows).toEqual([{ target: 'keycloak_sso', aggregate_type: 'sso_app' }])
  })

  it('rejects an OIDC-only field on a SAML create, NAMING it', async () => {
    await asSuperAdmin()
    const res = await request(app.getHttpServer())
      .post('/sso-apps')
      .send({ ...VALID_SAML_BODY, redirectUris: ['https://hr.example.com/cb'] })
      .expect(400)
    expect(JSON.stringify(res.body)).toMatch(/redirectUris/)
  })

  it('rejects a SAML-only field on an OIDC create, NAMING it', async () => {
    await asSuperAdmin()
    const res = await request(app.getHttpServer())
      .post('/sso-apps')
      .send({ ...VALID_BODY, acsUrls: ['https://hr.example.com/saml/acs'] })
      .expect(400)
    expect(JSON.stringify(res.body)).toMatch(/acsUrls/)
  })

  it('rejects a reserved entity id — it maps onto the Keycloak clientId', async () => {
    await asSuperAdmin()
    const res = await request(app.getHttpServer())
      .post('/sso-apps')
      .send({ ...VALID_SAML_BODY, entityId: 'idm-console' })
      .expect(400)
    expect(JSON.stringify(res.body)).toMatch(/reserved/)
  })

  it('rejects a plain-http ACS URL on a non-localhost host, and reports every bad one', async () => {
    await asSuperAdmin()
    const res = await request(app.getHttpServer())
      .post('/sso-apps')
      .send({ ...VALID_SAML_BODY, acsUrls: ['http://hr.example.com/acs', 'https://hr.example.com/*'] })
      .expect(400)
    const body = JSON.stringify(res.body)
    expect(body).toMatch(/http:\/\/hr.example.com\/acs/)
    expect(body).toMatch(/wildcard/)
  })

  it('accepts an http ACS URL for localhost — local SP development', async () => {
    await asSuperAdmin()
    await enableSsoTarget()
    await request(app.getHttpServer())
      .post('/sso-apps')
      .send({ ...VALID_SAML_BODY, acsUrls: ['http://localhost:8080/saml/acs'] })
      .expect(201)
  })

  it('rejects a malformed SP certificate by name', async () => {
    await asSuperAdmin()
    const res = await request(app.getHttpServer())
      .post('/sso-apps')
      .send({ ...VALID_SAML_BODY, spCertificate: 'not a pem' })
      .expect(400)
    expect(JSON.stringify(res.body)).toMatch(/spCertificate/)
  })

  it('409s on a duplicate entity id', async () => {
    await asSuperAdmin()
    await enableSsoTarget()
    await request(app.getHttpServer()).post('/sso-apps').send(VALID_SAML_BODY).expect(201)
    await request(app.getHttpServer()).post('/sso-apps').send(VALID_SAML_BODY).expect(409)
  })

  it('PATCH on a SAML app rejects OIDC fields and protocol by name', async () => {
    await asSuperAdmin()
    await enableSsoTarget()
    const created = await request(app.getHttpServer()).post('/sso-apps').send(VALID_SAML_BODY).expect(201)

    const uris = await request(app.getHttpServer())
      .patch(`/sso-apps/${created.body.id}`)
      .send({ redirectUris: ['https://hr.example.com/cb'] })
      .expect(400)
    expect(JSON.stringify(uris.body)).toMatch(/redirectUris/)

    // Switching protocol in place is a new application, not an edit.
    const protocol = await request(app.getHttpServer())
      .patch(`/sso-apps/${created.body.id}`)
      .send({ protocol: 'openid-connect' })
      .expect(400)
    expect(JSON.stringify(protocol.body)).toMatch(/protocol/)
  })

  it('PATCH edits SAML fields and emits an updated event', async () => {
    await asSuperAdmin()
    await enableSsoTarget()
    const created = await request(app.getHttpServer()).post('/sso-apps').send(VALID_SAML_BODY).expect(201)

    const res = await request(app.getHttpServer())
      .patch(`/sso-apps/${created.body.id}`)
      .send({ acsUrls: ['https://hr.example.com/saml/acs-v2'], nameIdFormat: 'persistent' })
      .expect(200)
    expect(res.body.samlAcsUrls).toEqual(['https://hr.example.com/saml/acs-v2'])
    expect(res.body.samlNameIdFormat).toBe('persistent')

    const events = await ctx.pool.query(
      `SELECT event_type FROM outbox_events WHERE aggregate_id = $1 ORDER BY id`, [created.body.id],
    )
    expect(events.rows.map((r) => r.event_type)).toEqual(['created', 'updated'])
  })

  it('PATCH spCertificate: null removes the certificate', async () => {
    await asSuperAdmin()
    await enableSsoTarget()
    const created = await request(app.getHttpServer())
      .post('/sso-apps')
      .send({ ...VALID_SAML_BODY, spCertificate: TEST_PEM })
      .expect(201)
    expect(created.body.samlSpCertificate).toBe(TEST_PEM)

    const res = await request(app.getHttpServer())
      .patch(`/sso-apps/${created.body.id}`)
      .send({ spCertificate: null })
      .expect(200)
    expect(res.body.samlSpCertificate).toBeNull()
  })

  it('409s when minting a client secret for a SAML application', async () => {
    // SAML SPs authenticate assertions by signature; there is no secret.
    await asSuperAdmin()
    await enableSsoTarget()
    const created = await request(app.getHttpServer()).post('/sso-apps').send(VALID_SAML_BODY).expect(201)

    const res = await request(app.getHttpServer())
      .post(`/sso-apps/${created.body.id}/client-secret`)
      .expect(409)
    expect(JSON.stringify(res.body)).toMatch(/SAML/)
  })

  it('never persists the minted secret anywhere', async () => {
    await asSuperAdmin()
    await enableSsoTarget()
    const created = await request(app.getHttpServer()).post('/sso-apps').send(VALID_BODY).expect(201)
    await ctx.pool.query(
      `INSERT INTO external_sso_app_identities (app_id, system, external_id, sync_state)
       VALUES ($1, 'keycloak_sso', 'uuid-from-keycloak', 'synced')`,
      [created.body.id],
    )

    await request(app.getHttpServer())
      .post(`/sso-apps/${created.body.id}/client-secret`)
      .expect(200)

    const apps = await ctx.pool.query('SELECT * FROM sso_apps')
    assertNoLeak(JSON.stringify(apps.rows), SECRET_SENTINEL, 'sso_apps rows')

    const audit = await ctx.pool.query('SELECT * FROM audit_log')
    assertNoLeak(JSON.stringify(audit.rows), SECRET_SENTINEL, 'audit_log rows')

    const events = await ctx.pool.query('SELECT * FROM outbox_events')
    assertNoLeak(JSON.stringify(events.rows), SECRET_SENTINEL, 'outbox_events rows')

    // The act IS recorded, just never the value. Scoped to THIS application:
    // audit_log is append-only, so beforeEach cannot clear it and earlier
    // tests in this file have left their own mint rows behind.
    const minted = await ctx.pool.query(
      `SELECT action FROM audit_log WHERE action = 'sso_app:mint_secret' AND resource_id = $1`,
      [created.body.id],
    )
    expect(minted.rows).toHaveLength(1)
  })
})
