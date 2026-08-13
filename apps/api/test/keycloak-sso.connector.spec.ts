import { describe, expect, it } from 'vitest'
import type { KeycloakClientRepresentation } from '../src/keycloak/keycloak-admin.client'
import { KeycloakSsoConnector, type SsoAdminApi } from '../src/connectors/keycloak-sso.connector'
import type { DesiredSsoApp } from '../src/connectors/connector'
import { assertNoLeak } from './support/secret-leak'

const SECRET_SENTINEL = 'MINTED-SECRET-SENTINEL'

interface Fake extends SsoAdminApi {
  clients: KeycloakClientRepresentation[]
  mappers: Map<string, { name: string }[]>
  samlMappers: Map<string, { name: string }[]>
  updateBodies: KeycloakClientRepresentation[]
}

function fakeAdmin(initial: KeycloakClientRepresentation[] = []): Fake {
  const clients = [...initial]
  const mappers = new Map<string, { name: string }[]>()
  const samlMappers = new Map<string, { name: string }[]>()
  const updateBodies: KeycloakClientRepresentation[] = []

  return {
    clients,
    mappers,
    samlMappers,
    updateBodies,
    async findClientByClientId(clientId) {
      return clients.find((c) => c.clientId === clientId) ?? null
    },
    async getClient(uuid) {
      const found = clients.find((c) => c.id === uuid)
      if (found === undefined) throw new Error(`no client ${uuid}`)
      return found
    },
    async createClient(rep) {
      const created = { ...rep, id: `uuid-${rep.clientId}` }
      clients.push(created)
      return created.id
    },
    async updateClient(uuid, rep) {
      updateBodies.push(rep)
      const index = clients.findIndex((c) => c.id === uuid)
      clients[index] = { ...rep, id: uuid }
    },
    async assertGroupMembershipMapper(uuid) {
      const existing = mappers.get(uuid) ?? []
      if (!existing.some((m) => m.name === 'groups')) {
        mappers.set(uuid, [...existing, { name: 'groups' }])
      }
    },
    async assertSamlGroupAttributeMapper(uuid) {
      const existing = samlMappers.get(uuid) ?? []
      if (!existing.some((m) => m.name === 'groups')) {
        samlMappers.set(uuid, [...existing, { name: 'groups' }])
      }
    },
    async mintClientSecret() {
      return SECRET_SENTINEL
    },
    async health() {
      return { ok: true, detail: 'reachable' }
    },
  }
}

const DESIRED: DesiredSsoApp = {
  clientId: 'billing-portal',
  name: 'Billing Portal',
  description: 'Customer billing',
  protocol: 'openid-connect',
  publicClient: false,
  redirectUris: ['https://billing.example.com/cb'],
  webOrigins: ['https://billing.example.com'],
  groupsClaim: true,
  enabled: true,
}

describe('KeycloakSsoConnector', () => {
  it('plans a create when no client exists', async () => {
    const connector = new KeycloakSsoConnector(fakeAdmin())
    const ops = await connector.planApp(DESIRED)
    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe('create')
  })

  it('applies a create and returns the Keycloak UUID, not the clientId', async () => {
    // Correlation is on the immutable UUID Keycloak assigns. A Keycloak admin
    // CAN rename clientId directly; correlating on it would turn that rename
    // into an orphaned client plus a second, empty one on the next sync.
    const connector = new KeycloakSsoConnector(fakeAdmin())
    const { externalId } = await connector.applyApp(DESIRED)
    expect(externalId).toBe('uuid-billing-portal')
    expect(externalId).not.toBe('billing-portal')
  })

  it('correlates on the stored UUID even when clientId was renamed in Keycloak', async () => {
    const admin = fakeAdmin([{ id: 'uuid-stored', clientId: 'renamed-by-an-admin' }])
    const connector = new KeycloakSsoConnector(admin)

    const { externalId } = await connector.applyApp({ ...DESIRED, existingExternalId: 'uuid-stored' })

    expect(externalId).toBe('uuid-stored')
    // Renamed back to what this system masters, on the SAME client — not
    // orphaned and duplicated.
    expect(admin.clients).toHaveLength(1)
    expect(admin.clients[0].clientId).toBe('billing-portal')
  })

  it('asserts the group mapper on UPDATE, not only on create', async () => {
    // Keycloak accepts protocolMappers on create and SILENTLY DROPS them on
    // update (scripts/keycloak-setup.sh records the same trap for the
    // audience mapper). Everything looks configured and the claim simply is
    // not there. This is that regression guard.
    const admin = fakeAdmin([{ id: 'uuid-billing-portal', clientId: 'billing-portal' }])
    const connector = new KeycloakSsoConnector(admin)

    await connector.applyApp({ ...DESIRED, existingExternalId: 'uuid-billing-portal' })

    expect(admin.mappers.get('uuid-billing-portal')).toEqual([{ name: 'groups' }])
  })

  it('does not assert the mapper when groupsClaim is off', async () => {
    const admin = fakeAdmin()
    const connector = new KeycloakSsoConnector(admin)
    await connector.applyApp({ ...DESIRED, groupsClaim: false })
    expect(admin.mappers.size).toBe(0)
  })

  it('preserves fields it does not manage', async () => {
    // Read-modify-write, never blind overwrite: Keycloak's update takes a
    // FULL ClientRepresentation, so anything omitted from the body is at risk.
    const admin = fakeAdmin([
      {
        id: 'uuid-billing-portal',
        clientId: 'billing-portal',
        defaultClientScopes: ['profile', 'custom-scope'],
        attributes: { 'admin.set.by.hand': 'keep me' },
      },
    ])
    const connector = new KeycloakSsoConnector(admin)

    await connector.applyApp({ ...DESIRED, existingExternalId: 'uuid-billing-portal' })

    const after = admin.clients.find((c) => c.id === 'uuid-billing-portal')
    expect(after?.defaultClientScopes).toEqual(['profile', 'custom-scope'])
    expect(after?.attributes?.['admin.set.by.hand']).toBe('keep me')
  })

  it('forces PKCE S256 on a public client', async () => {
    // Not an editable field. A public client without PKCE is an
    // authorization-code interception hole; unrepresentable beats a checkbox.
    const admin = fakeAdmin()
    const connector = new KeycloakSsoConnector(admin)
    await connector.applyApp({ ...DESIRED, publicClient: true })
    const created = admin.clients.find((c) => c.clientId === 'billing-portal')
    expect(created?.attributes?.['pkce.code.challenge.method']).toBe('S256')
  })

  it('carries enabled=false through to the client rather than deleting it', async () => {
    const admin = fakeAdmin([{ id: 'uuid-billing-portal', clientId: 'billing-portal', enabled: true }])
    const connector = new KeycloakSsoConnector(admin)

    await connector.applyApp({ ...DESIRED, existingExternalId: 'uuid-billing-portal', enabled: false })

    expect(admin.clients[0].enabled).toBe(false)
    expect(admin.clients).toHaveLength(1)
  })

  it('plans a disable when the desired state turns the app off', async () => {
    const admin = fakeAdmin([{ id: 'uuid-billing-portal', clientId: 'billing-portal', enabled: true }])
    const connector = new KeycloakSsoConnector(admin)

    const ops = await connector.planApp({
      ...DESIRED,
      existingExternalId: 'uuid-billing-portal',
      enabled: false,
    })

    expect(ops.some((op) => op.kind === 'disable')).toBe(true)
  })

  it('never returns a minted secret from applyApp', async () => {
    const connector = new KeycloakSsoConnector(fakeAdmin())
    const result = await connector.applyApp(DESIRED)
    assertNoLeak(JSON.stringify(result), SECRET_SENTINEL, 'applyApp result')
  })

  it('reports health from the admin API', async () => {
    const connector = new KeycloakSsoConnector(fakeAdmin())
    await expect(connector.health()).resolves.toEqual({ ok: true, detail: 'reachable' })
  })
})

// A syntactically valid PEM whose body is plain base64 — shape is all the
// connector cares about; Keycloak is what would reject a non-X.509 payload.
const TEST_PEM =
  '-----BEGIN CERTIFICATE-----\nMIIBszCCARygAwIBAgIBATANBgkqhkiG9w0BAQsFADAA\nMB4XDTI2MDEwMTAwMDAwMFoXDTM2MDEwMTAwMDAwMFow\n-----END CERTIFICATE-----'
const TEST_PEM_STRIPPED =
  'MIIBszCCARygAwIBAgIBATANBgkqhkiG9w0BAQsFADAAMB4XDTI2MDEwMTAwMDAwMFoXDTM2MDEwMTAwMDAwMFow'

const SAML_DESIRED: DesiredSsoApp = {
  clientId: 'https://hr.example.com/saml/metadata',
  name: 'HR Suite',
  description: 'HR SaaS',
  protocol: 'saml',
  publicClient: false,
  redirectUris: [],
  webOrigins: [],
  groupsClaim: true,
  enabled: true,
  samlAcsUrls: ['https://hr.example.com/saml/acs', 'https://hr.example.com/saml/acs2'],
  samlSpCertificate: null,
  samlSignAssertions: true,
  samlNameIdFormat: 'email',
}

describe('KeycloakSsoConnector — SAML', () => {
  it('creates a SAML client keyed by entity id, with the Keycloak 26 attribute map', async () => {
    const admin = fakeAdmin()
    const connector = new KeycloakSsoConnector(admin)

    await connector.applyApp(SAML_DESIRED)

    const created = admin.clients[0]
    expect(created.protocol).toBe('saml')
    // Keycloak keys a SAML client by entity id in the clientId field.
    expect(created.clientId).toBe('https://hr.example.com/saml/metadata')
    // Every ACS URL becomes a valid redirect URI — that is how Keycloak
    // scopes acceptable assertion destinations.
    expect(created.redirectUris).toEqual([
      'https://hr.example.com/saml/acs',
      'https://hr.example.com/saml/acs2',
    ])
    expect(created.attributes?.saml_assertion_consumer_url_post).toBe(
      'https://hr.example.com/saml/acs',
    )
    expect(created.attributes?.['saml.assertion.signature']).toBe('true')
    expect(created.attributes?.['saml.server.signature']).toBe('true')
    expect(created.attributes?.saml_name_id_format).toBe('email')
    expect(created.publicClient).toBe(false)
  })

  it('requires client signatures exactly when an SP certificate is supplied', async () => {
    const admin = fakeAdmin()
    const connector = new KeycloakSsoConnector(admin)

    await connector.applyApp({ ...SAML_DESIRED, samlSpCertificate: TEST_PEM })

    const created = admin.clients[0]
    expect(created.attributes?.['saml.client.signature']).toBe('true')
    // Stored as the PEM stripped to single-line base64 DER — Keycloak's shape.
    expect(created.attributes?.['saml.signing.certificate']).toBe(TEST_PEM_STRIPPED)
  })

  it('does not require client signatures without a certificate', async () => {
    const admin = fakeAdmin()
    const connector = new KeycloakSsoConnector(admin)
    await connector.applyApp(SAML_DESIRED)
    expect(admin.clients[0].attributes?.['saml.client.signature']).toBe('false')
    // Never set in the first place on a client that never had one, so absent
    // is right here — unlike the removal case below, where absent would be a
    // silent no-op.
    expect(admin.clients[0].attributes?.['saml.signing.certificate']).toBeUndefined()
  })

  it('CLEARS the stale stored certificate with an explicit empty value, never by omission', async () => {
    /**
     * This assertion used to read `toBeUndefined()`, and it was green and
     * WRONG. It checked the shape of the payload the connector builds, against
     * a fake that stores whatever it is handed — so the code dropped the key,
     * the fake dropped the key, and the two agreed with each other about a
     * Keycloak that does not behave that way.
     *
     * Measured on the lab host against Keycloak 26.4 (2026-08-13): the
     * `attributes` map MERGES. A key omitted from a PUT keeps its stored
     * value; only an explicit `""` or `null` clears it. Under the old code a
     * removed SP certificate stayed in Keycloak forever, which is the precise
     * half-state the connector's own comment promised to prevent.
     *
     * So the empty string is the assertion, and `toBeUndefined()` would now be
     * the bug.
     */
    const admin = fakeAdmin([
      {
        id: 'uuid-hr',
        clientId: 'https://hr.example.com/saml/metadata',
        attributes: {
          'saml.client.signature': 'true',
          'saml.signing.certificate': TEST_PEM_STRIPPED,
        },
      },
    ])
    const connector = new KeycloakSsoConnector(admin)

    await connector.applyApp({ ...SAML_DESIRED, existingExternalId: 'uuid-hr' })

    const after = admin.clients[0]
    expect(after.attributes?.['saml.client.signature']).toBe('false')
    expect(after.attributes?.['saml.signing.certificate']).toBe('')
  })

  it('asserts the SAML groups attribute mapper, never the OIDC claim mapper', async () => {
    const admin = fakeAdmin()
    const connector = new KeycloakSsoConnector(admin)

    await connector.applyApp(SAML_DESIRED)

    expect(admin.samlMappers.get('uuid-https://hr.example.com/saml/metadata')).toEqual([
      { name: 'groups' },
    ])
    expect(admin.mappers.size).toBe(0)
  })

  it('does not assert the mapper when groupsClaim is off', async () => {
    const admin = fakeAdmin()
    const connector = new KeycloakSsoConnector(admin)
    await connector.applyApp({ ...SAML_DESIRED, groupsClaim: false })
    expect(admin.samlMappers.size).toBe(0)
  })

  it('preserves SAML client fields it does not manage', async () => {
    const admin = fakeAdmin([
      {
        id: 'uuid-hr',
        clientId: 'https://hr.example.com/saml/metadata',
        defaultClientScopes: ['role_list'],
        attributes: { 'saml.artifact.binding': 'true' },
      },
    ])
    const connector = new KeycloakSsoConnector(admin)

    await connector.applyApp({ ...SAML_DESIRED, existingExternalId: 'uuid-hr' })

    const after = admin.clients[0]
    expect(after.defaultClientScopes).toEqual(['role_list'])
    expect(after.attributes?.['saml.artifact.binding']).toBe('true')
  })

  it('CONVERGES: asserting the identical desired state twice plans no further change', async () => {
    const admin = fakeAdmin()
    const connector = new KeycloakSsoConnector(admin)
    const desired = { ...SAML_DESIRED, samlSpCertificate: TEST_PEM, groupsClaim: false }

    const { externalId } = await connector.applyApp(desired)
    const ops = await connector.planApp({ ...desired, existingExternalId: externalId })

    expect(ops).toEqual([])
  })

  it('does not disturb the OIDC merge — an OIDC app still gets an OIDC client', async () => {
    const admin = fakeAdmin()
    const connector = new KeycloakSsoConnector(admin)
    await connector.applyApp(DESIRED)
    expect(admin.clients[0].protocol).toBe('openid-connect')
    expect(admin.clients[0].attributes?.saml_assertion_consumer_url_post).toBeUndefined()
  })
})
