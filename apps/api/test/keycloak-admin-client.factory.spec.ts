import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  KEYCLOAK_FACTORY_CONFIG,
  KeycloakAdminClientFactory,
  type KeycloakFactoryConfig,
} from '../src/keycloak/keycloak-admin-client.factory'
import { startKeycloak, type TestKeycloak } from './support/keycloak'

const MASTER_ISSUER = 'http://kc:8080/realms/identity-manager'

function factoryWith(overrides: Partial<KeycloakFactoryConfig> = {}): KeycloakAdminClientFactory {
  return new KeycloakAdminClientFactory({
    issuer: MASTER_ISSUER,
    clientId: 'idm-admin',
    clientSecret: 'realm-scoped-secret',
    provisionClientId: 'idm-provisioner',
    provisionClientSecret: 'provisioning-secret',
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Pure unit tests — no container. Memoization, credential selection and the
// unconfigured refusal are all decided before any I/O happens.
// ---------------------------------------------------------------------------
describe('KeycloakAdminClientFactory (Organizations, Task 9)', () => {
  const factory = factoryWith()

  it('returns the same instance for the same realm', () => {
    // Memoization is not a micro-optimization here: each client owns a token
    // cache, so a fresh instance per call would re-run the client-credentials
    // grant before every admin request.
    expect(factory.forRealm('acme')).toBe(factory.forRealm('acme'))
  })

  it('returns different instances for different realms', () => {
    expect(factory.forRealm('acme')).not.toBe(factory.forRealm('globex'))
  })

  it('serves the master realm from the realm-scoped credential', () => {
    expect(factory.forRealm('identity-manager')).toBe(factory.forRealm('identity-manager'))
  })

  it('exposes the server root and the master realm parsed out of the issuer', () => {
    expect(factory.serverRoot()).toBe('http://kc:8080')
    expect(factory.masterRealmName()).toBe('identity-manager')
  })

  it('rejects an issuer with no /realms/<name> segment', () => {
    expect(() => factoryWith({ issuer: 'http://kc:8080/auth' })).toThrow(/realms/)
  })

  describe('without provisioning credentials', () => {
    const bare = factoryWith({ provisionClientId: null, provisionClientSecret: null })

    it('reports provisioning as unavailable', () => {
      expect(bare.hasProvisioningCredentials()).toBe(false)
    })

    it('refuses a tenant realm rather than handing back a client that would 401', () => {
      expect(() => bare.forRealm('acme')).toThrow(/provisioning credentials/)
    })

    it('still serves the master realm — nothing about the existing path changes', () => {
      expect(bare.forRealm('identity-manager')).toBe(bare.forRealm('identity-manager'))
    })

    // Half-configured is treated as unconfigured (see env.ts's own comment on
    // KEYCLOAK_PROVISION_CLIENT_ID): the operator gets an actionable message
    // naming both variables instead of a 401 from Keycloak's token endpoint.
    it('treats a half-configured pair as unconfigured', () => {
      expect(factoryWith({ provisionClientSecret: null }).hasProvisioningCredentials()).toBe(false)
      expect(factoryWith({ provisionClientId: null }).hasProvisioningCredentials()).toBe(false)
    })
  })

  // Secrets must never be logged, echoed in an API response, or written to an
  // audit row — the rule connectors/secrets.ts states for connector
  // credentials. The factory holds two secrets, so the same net has to cover
  // it: the refusal message an operator will actually see is the one string
  // this class builds, and it must name the VARIABLES, never their values.
  describe('never leaks a credential', () => {
    it('names the environment variables, not the values, when it refuses', () => {
      const bare = factoryWith({ provisionClientId: null, provisionClientSecret: null })
      let message = ''
      try {
        bare.forRealm('acme')
      } catch (error) {
        message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
      }
      expect(message).toMatch(/KEYCLOAK_PROVISION_CLIENT_SECRET/)
      expect(message).not.toContain('provisioning-secret')
      expect(message).not.toContain('realm-scoped-secret')
    })

    // A sentinel sweep in the spirit of connector-secrets.spec.ts: whatever a
    // future change makes this object serialize to, neither secret may appear
    // in it. Guards against, say, a debug `toJSON` or a logged config dump.
    it('keeps both secrets out of anything serialized from the factory', () => {
      const sentinel = 'SENTINEL-do-not-leak-9f3a'
      const seeded = factoryWith({
        clientSecret: sentinel,
        provisionClientSecret: sentinel,
      })
      const tenant = seeded.forRealm('acme')
      const master = seeded.forRealm('identity-manager')

      // The factory itself, and — just as important — each client it hands
      // out, since those are what get injected and logged elsewhere. Both
      // hold their config in a true `#private` field for exactly this
      // reason; a plain TS `private` would fail every line below.
      for (const held of [seeded, tenant, master]) {
        expect(JSON.stringify(held)).not.toContain(sentinel)
        expect(String(held)).not.toContain(sentinel)
        expect(JSON.stringify(Object.entries(held))).not.toContain(sentinel)
      }
    })
  })

  // The routing the plan's implementer note calls out: a tenant client
  // authenticates against MASTER but must address /admin/realms/<tenant>.
  // Asserted against a stubbed fetch so both URLs are observable directly;
  // the container test below then proves the same routing against real
  // Keycloak.
  describe('request routing', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    function stubFetch(): { calls: string[] } {
      const calls: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown) => {
          calls.push(String(input))
          if (String(input).endsWith('/protocol/openid-connect/token')) {
            return new Response(JSON.stringify({ access_token: 't', expires_in: 60 }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          }
          return new Response('[]', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }),
      )
      return { calls }
    }

    it('addresses a tenant realm at /admin/realms/<tenant> while authenticating against master', async () => {
      const { calls } = stubFetch()
      await factoryWith().forRealm('acme').findUserByUsername('someone@example.com')

      expect(calls[0]).toBe('http://kc:8080/realms/master/protocol/openid-connect/token')
      expect(calls[1]).toContain('http://kc:8080/admin/realms/acme/users')
      expect(calls[1]).not.toContain('/admin/realms/master/')
    })

    it('leaves the master realm addressing its own realm, from its own issuer', async () => {
      const { calls } = stubFetch()
      await factoryWith().forRealm('identity-manager').findUserByUsername('someone@example.com')

      expect(calls[0]).toBe(
        'http://kc:8080/realms/identity-manager/protocol/openid-connect/token',
      )
      expect(calls[1]).toContain('http://kc:8080/admin/realms/identity-manager/users')
    })
  })

  it('is constructible through its DI token', () => {
    // The token exists so app.module.ts can provide the config the same way
    // KEYCLOAK_ADMIN_CONFIG is provided; assert it is a distinct symbol so a
    // copy-paste of the other token would be caught.
    expect(typeof KEYCLOAK_FACTORY_CONFIG).toBe('symbol')
    expect(KEYCLOAK_FACTORY_CONFIG.description).toBe('KEYCLOAK_FACTORY_CONFIG')
  })
})

// ---------------------------------------------------------------------------
// Real Keycloak. Two questions only a real server can answer:
//
//  1. Does the `adminRealm` split actually work end to end — a master-realm
//     service-account token accepted at /admin/realms/<tenant>?
//  2. THE UNVERIFIED ASSUMPTION (plan, Task 11): does Keycloak grant a
//     realm's CREATING service account admin rights on that realm, or does
//     `ensureRealm` also have to grant itself the `<realm>-realm` client
//     roles afterwards? The design flags this as unverified; it is cheap to
//     settle here, so it is settled here.
// ---------------------------------------------------------------------------
describe('KeycloakAdminClientFactory against real Keycloak', () => {
  let keycloak: TestKeycloak
  let serverRoot: string
  let factory: KeycloakAdminClientFactory

  const PROVISION_CLIENT_ID = 'idm-provisioner'
  const PROVISION_CLIENT_SECRET = 'provision_test_secret'
  const TENANT_REALM = 'acme-provisioned'

  /** The container's own bootstrap admin — never the code under test. */
  async function bootstrapToken(): Promise<string> {
    const res = await fetch(`${serverRoot}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: 'admin',
        password: 'admin_dev_password',
      }),
    })
    if (!res.ok) throw new Error(`bootstrap token failed: ${res.status} ${await res.text()}`)
    return ((await res.json()) as { access_token: string }).access_token
  }

  async function adminCall(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    return fetch(`${serverRoot}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  }

  /**
   * Builds exactly what `.env.example` tells an operator to build: a
   * master-realm confidential client with a service account holding
   * `create-realm`, and nothing else.
   */
  async function createProvisioningClient(): Promise<void> {
    const token = await bootstrapToken()

    const created = await adminCall(token, 'POST', '/admin/realms/master/clients', {
      clientId: PROVISION_CLIENT_ID,
      secret: PROVISION_CLIENT_SECRET,
      publicClient: false,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: true,
      enabled: true,
    })
    if (created.status !== 201) {
      throw new Error(`provisioning client create failed: ${created.status} ${await created.text()}`)
    }

    const lookup = await adminCall(
      token,
      'GET',
      `/admin/realms/master/clients?clientId=${PROVISION_CLIENT_ID}`,
    )
    const [client] = (await lookup.json()) as { id: string }[]

    const saRes = await adminCall(
      token,
      'GET',
      `/admin/realms/master/clients/${client.id}/service-account-user`,
    )
    const serviceAccount = (await saRes.json()) as { id: string }

    const roleRes = await adminCall(token, 'GET', '/admin/realms/master/roles/create-realm')
    const role = (await roleRes.json()) as { id: string; name: string }

    const grant = await adminCall(
      token,
      'POST',
      `/admin/realms/master/users/${serviceAccount.id}/role-mappings/realm`,
      [{ id: role.id, name: role.name }],
    )
    if (!grant.ok) {
      throw new Error(`create-realm grant failed: ${grant.status} ${await grant.text()}`)
    }
  }

  /** A client-credentials token for the provisioning service account itself. */
  async function provisionToken(): Promise<string> {
    const res = await fetch(`${serverRoot}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: PROVISION_CLIENT_ID,
        client_secret: PROVISION_CLIENT_SECRET,
      }),
    })
    if (!res.ok) throw new Error(`provision token failed: ${res.status} ${await res.text()}`)
    return ((await res.json()) as { access_token: string }).access_token
  }

  beforeAll(async () => {
    keycloak = await startKeycloak()
    serverRoot = new URL(keycloak.issuer).origin
    await createProvisioningClient()

    factory = new KeycloakAdminClientFactory({
      issuer: keycloak.issuer,
      clientId: 'idm-sync-service',
      clientSecret: 'idm_sync_dev_secret_change_me',
      provisionClientId: PROVISION_CLIENT_ID,
      provisionClientSecret: PROVISION_CLIENT_SECRET,
    })

    // Realm creation itself is Task 11's `ensureRealm`; this is the raw call
    // it will make, done here only so there is a tenant realm to address.
    // Deliberately performed by the SAME service account the factory will
    // then use, because whether *creating* confers admin rights is exactly
    // the question below.
    const created = await adminCall(await provisionToken(), 'POST', '/admin/realms', {
      realm: TENANT_REALM,
      enabled: true,
    })
    if (created.status !== 201) {
      throw new Error(`realm create failed: ${created.status} ${await created.text()}`)
    }
  })

  afterAll(async () => {
    await keycloak?.stop()
  })

  it('creates a realm with the provisioning credential the master-realm one could not', async () => {
    const res = await adminCall(await provisionToken(), 'GET', `/admin/realms/${TENANT_REALM}`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { realm: string }).realm).toBe(TENANT_REALM)
  })

  /**
   * THE ASSUMPTION, settled. If this passes, the creating service account
   * can administer the realm it created with no further role grants, and
   * Task 11's `ensureRealm` needs no explicit `<realm>-realm` grant. If it
   * fails with a 403, it does.
   */
  it('administers the realm it created, with no extra role grant', async () => {
    const tenantClient = factory.forRealm(TENANT_REALM)
    // A read that requires `view-users` on the TENANT realm specifically —
    // a token with no rights there answers 403, not an empty list.
    await expect(tenantClient.findUserByUsername('nobody@example.com')).resolves.toBeNull()
  })

  it('writes to the realm it created, not only reads', async () => {
    // `ensureGroup` is a POST; read access alone would not be enough. Task 11
    // provisions real structure into a new realm, so prove a WRITE lands.
    const group = await factory.forRealm(TENANT_REALM).ensureGroup('provisioning-probe')
    expect(group.name).toBe('provisioning-probe')

    // And prove it landed in the TENANT realm rather than master or the
    // master organization's realm — the whole point of `adminRealm`.
    const res = await adminCall(
      await bootstrapToken(),
      'GET',
      `/admin/realms/${TENANT_REALM}/groups`,
    )
    const groups = (await res.json()) as { name: string }[]
    expect(groups.map((g) => g.name)).toContain('provisioning-probe')
  })

  it('still serves the master organization realm from its realm-scoped credential', async () => {
    // The existing single-tenant path is unchanged: same credential, same
    // realm, and it does NOT accidentally start routing through master.
    await expect(
      factory.forRealm('identity-manager').findUserByUsername('nobody@example.com'),
    ).resolves.toBeNull()
  })

  it('cannot reach a tenant realm with the realm-scoped credential', async () => {
    // The structural reason the second credential exists at all: a token
    // minted in `identity-manager` is not admin anywhere else. Constructed
    // by hand rather than through the factory, which would (correctly)
    // never build this combination.
    const { KeycloakAdminClient } = await import('../src/keycloak/keycloak-admin.client')
    const wrong = new KeycloakAdminClient({
      issuer: keycloak.issuer,
      clientId: 'idm-sync-service',
      clientSecret: 'idm_sync_dev_secret_change_me',
      adminRealm: TENANT_REALM,
    })
    await expect(wrong.findUserByUsername('nobody@example.com')).rejects.toThrow()
  })

  it('never puts a client secret into an error surfaced from a failed call', async () => {
    const bad = factory.forRealm('realm-that-does-not-exist')
    let message = ''
    try {
      await bad.findUserByUsername('nobody@example.com')
    } catch (error) {
      message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
    }
    expect(message).not.toContain(PROVISION_CLIENT_SECRET)
    expect(message).not.toContain('idm_sync_dev_secret_change_me')
  })
})
