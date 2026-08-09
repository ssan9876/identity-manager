import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OrganizationConnector } from '../src/connectors/organization.connector'
import { KeycloakAdminClientFactory } from '../src/keycloak/keycloak-admin-client.factory'
import { startKeycloak, type TestKeycloak } from './support/keycloak'

/**
 * Organizations milestone, Task 11 — realm create, enable and disable.
 *
 * Against a REAL Keycloak 26 container throughout, with no fake of the Admin
 * API anywhere in the file. Every question this connector raises is a
 * question about Keycloak's own behaviour — what a second `POST /admin/realms`
 * answers, whether a partial realm PUT preserves the fields it omits, and
 * (the one the plan flagged as unverified) who may administer a realm — and a
 * fake would only prove this suite agrees with its own assumptions about
 * them. The one exception is the master-realm refusal, which is decided
 * before any I/O happens and is asserted without a container below.
 */

const PROVISION_CLIENT_ID = 'idm-provisioner'
const PROVISION_CLIENT_SECRET = 'provision_test_secret'
const BOOTSTRAP_PASSWORD = 'admin_dev_password'

describe('OrganizationConnector against real Keycloak', () => {
  let keycloak: TestKeycloak
  let serverRoot: string
  let factory: KeycloakAdminClientFactory
  let connector: OrganizationConnector

  /** The container's own bootstrap admin — never the code under test. */
  async function bootstrapToken(): Promise<string> {
    const res = await fetch(`${serverRoot}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: 'admin',
        password: BOOTSTRAP_PASSWORD,
      }),
    })
    if (!res.ok) throw new Error(`bootstrap token failed: ${res.status} ${await res.text()}`)
    return ((await res.json()) as { access_token: string }).access_token
  }

  async function adminCall(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await bootstrapToken()
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
   * Reads a realm through the BOOTSTRAP admin rather than through the
   * connector's own credential. Asserting the connector's writes with the
   * connector's own client would only prove it agrees with itself.
   */
  async function getRealm(realm: string): Promise<Record<string, unknown> | null> {
    const res = await adminCall('GET', `/admin/realms/${realm}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`get realm failed: ${res.status} ${await res.text()}`)
    return (await res.json()) as Record<string, unknown>
  }

  /**
   * Exactly what `.env.example` tells an operator to build: a master-realm
   * confidential client whose service account holds `create-realm`, and
   * nothing else. Identical to the factory spec's own fixture (Task 9) on
   * purpose — this connector's whole premise is that this credential, with
   * this single role, is sufficient.
   */
  async function createProvisioningClient(): Promise<void> {
    const created = await adminCall('POST', '/admin/realms/master/clients', {
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
      'GET',
      `/admin/realms/master/clients?clientId=${PROVISION_CLIENT_ID}`,
    )
    const [client] = (await lookup.json()) as { id: string }[]

    const saRes = await adminCall(
      'GET',
      `/admin/realms/master/clients/${client.id}/service-account-user`,
    )
    const serviceAccount = (await saRes.json()) as { id: string }

    const roleRes = await adminCall('GET', '/admin/realms/master/roles/create-realm')
    const role = (await roleRes.json()) as { id: string; name: string }

    const grant = await adminCall(
      'POST',
      `/admin/realms/master/users/${serviceAccount.id}/role-mappings/realm`,
      [{ id: role.id, name: role.name }],
    )
    if (!grant.ok) {
      throw new Error(`create-realm grant failed: ${grant.status} ${await grant.text()}`)
    }
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
    connector = new OrganizationConnector(factory)
  }, 240_000)

  afterAll(async () => {
    await keycloak?.stop()
  })

  it('creates a realm', async () => {
    await connector.ensureRealm({ realm: 'acme', displayName: 'Acme Corp' })
    expect(await getRealm('acme')).toMatchObject({
      realm: 'acme',
      enabled: true,
      displayName: 'Acme Corp',
    })
  })

  it('is idempotent — creating twice is not an error', async () => {
    await connector.ensureRealm({ realm: 'acme2', displayName: 'Acme Two' })
    // The second call takes the 409 path, which also runs `probeAdministrable`.
    // Passing therefore asserts BOTH halves of ensureRealm's contract: the
    // realm exists, and this credential can still administer it.
    await expect(
      connector.ensureRealm({ realm: 'acme2', displayName: 'Acme Two' }),
    ).resolves.toBeUndefined()
  })

  /**
   * Pins the token-staleness finding (see
   * `KeycloakAdminClient.invalidateCachedToken`). Keycloak grants the
   * `<realm>-realm` roles at creation time, so the token used to CREATE a
   * realm cannot administer it — and the factory hands out one memoized
   * client, with one token cache, per realm, which is precisely the client
   * that just made the create call.
   *
   * This test fails with `403` if `ensureRealm` stops invalidating. It is
   * separated from the disable/enable tests below so that failure reads as
   * "the token is stale" rather than "disabling is broken".
   */
  it('can administer a realm through the SAME client that just created it', async () => {
    await connector.ensureRealm({ realm: 'acme-fresh', displayName: 'Acme Fresh' })
    await expect(connector.setRealmEnabled('acme-fresh', false)).resolves.toBeUndefined()
    expect(await getRealm('acme-fresh')).toMatchObject({ enabled: false })
  })

  it('disables a realm without deleting it', async () => {
    await connector.ensureRealm({ realm: 'acme3', displayName: 'Acme Three' })
    await connector.setRealmEnabled('acme3', false)

    const realm = await getRealm('acme3')
    expect(realm).toMatchObject({ enabled: false })
    // The point of "without deleting": the realm object, its display name and
    // everything else about it survive being switched off, so re-enabling is
    // a one-field change and not a re-provision.
    expect(realm).toMatchObject({ realm: 'acme3', displayName: 'Acme Three' })
  })

  it('re-enables a disabled realm', async () => {
    await connector.setRealmEnabled('acme3', true)
    expect(await getRealm('acme3')).toMatchObject({ enabled: true })
  })

  it('setting enabled to the value it already has is not an error', async () => {
    // Idempotence for the outbox's benefit: a retried `organization` event
    // re-asserts desired state and must not fail because it already holds.
    await expect(connector.setRealmEnabled('acme3', true)).resolves.toBeUndefined()
    expect(await getRealm('acme3')).toMatchObject({ enabled: true })
  })

  it('leaves the fields it does not manage alone', async () => {
    // The realm PUT is partial by design (see setRealmEnabled's doc comment).
    // Set something through the bootstrap admin that the connector never
    // sends, toggle enabled twice, and prove it survived — otherwise
    // suspending an organization would silently reset an operator's realm
    // configuration.
    await connector.ensureRealm({ realm: 'acme-partial', displayName: 'Acme Partial' })
    const patch = await adminCall('PUT', '/admin/realms/acme-partial', {
      realm: 'acme-partial',
      loginTheme: 'keycloak',
      accessTokenLifespan: 1234,
    })
    expect(patch.ok).toBe(true)

    await connector.setRealmEnabled('acme-partial', false)
    await connector.setRealmEnabled('acme-partial', true)

    expect(await getRealm('acme-partial')).toMatchObject({
      displayName: 'Acme Partial',
      loginTheme: 'keycloak',
      accessTokenLifespan: 1234,
      enabled: true,
    })
  })

  /**
   * Task 9 settled this against a real container and it is not re-litigated
   * here — it is re-asserted, once, because it is the single fact that
   * decides whether `ensureRealm` needs to grant itself the `<realm>-realm`
   * composite role. If Keycloak ever changes, this is the test that says so,
   * and the remedy is written down in `probeAdministrable`'s error message.
   */
  it('leaves the provisioning account able to create users in the realm it created', async () => {
    await connector.ensureRealm({ realm: 'acme4', displayName: 'Acme Four' })

    await expect(
      factory.forRealm('acme4').createUser(
        {
          username: 'probe',
          email: 'probe@acme4.test',
          firstName: 'P',
          lastName: 'R',
          enabled: true,
          attributes: {},
        },
        [],
      ),
    ).resolves.toMatchObject({ id: expect.any(String) })
  })

  /**
   * THE BOUNDARY TASK 9 LEFT OPEN, settled here.
   *
   * Task 9 proved a `create-realm` service account keeps admin rights on a
   * realm IT created. It could not prove anything about a realm created by
   * someone ELSE — a realm an operator made by hand, or one that predates a
   * credential rotation. `ensureRealm`'s 409-is-success path is exactly where
   * that case becomes reachable, so this builds it: the container's bootstrap
   * admin (a different principal entirely) creates the realm, and the
   * connector then meets it as an already-existing one.
   */
  describe('a realm this credential did not create', () => {
    const FOREIGN_REALM = 'foreign-realm'

    beforeAll(async () => {
      const created = await adminCall('POST', '/admin/realms', {
        realm: FOREIGN_REALM,
        displayName: 'Made By Someone Else',
        enabled: true,
      })
      if (created.status !== 201) {
        throw new Error(`foreign realm create failed: ${created.status} ${await created.text()}`)
      }
    })

    it('is not silently adopted — ensureRealm reports it rather than returning success', async () => {
      // If this ever starts resolving, Keycloak has begun granting the
      // `create-realm` holder rights over realms it did not create, and the
      // probe in ensureRealm becomes a no-op round trip rather than a guard.
      await expect(
        connector.ensureRealm({ realm: FOREIGN_REALM, displayName: 'Made By Someone Else' }),
      ).rejects.toThrow(/not administrable/)
    })

    it('names the remedy without naming the credential', async () => {
      let message = ''
      try {
        await connector.ensureRealm({ realm: FOREIGN_REALM, displayName: 'x' })
      } catch (error) {
        message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
      }
      expect(message).toContain(`"${FOREIGN_REALM}-realm"`)
      expect(message).not.toContain(PROVISION_CLIENT_SECRET)
      expect(message).not.toContain('idm_sync_dev_secret_change_me')
    })

    it('answers GET /admin/realms/<realm> with 200 regardless — why the probe is not that call', async () => {
      // The Keycloak behaviour that makes the obvious probe useless, pinned
      // so the choice in `probeAdministrable` is defended by a test rather
      // than by a comment. A bare `create-realm` holder gets 200 and a STUB
      // representation for a realm it has no rights in at all; the first
      // version of this connector used exactly that call and "verified" a
      // realm made by a different administrator.
      const res = await factory
        .forRealm(FOREIGN_REALM)
        .requestServerLevel('GET', `/admin/realms/${FOREIGN_REALM}`)
      expect(res.status).toBe(200)

      // And it is not even distinguishable by its body: Keycloak 26's brief
      // representation still carries the realm name and display name, so
      // there is nothing here a caller could inspect to tell "I administer
      // this realm" from "I merely hold create-realm somewhere". Only a call
      // that actually requires a role IN the realm answers the question,
      // which is what `probeAdministrable` uses and what the test above
      // proves.
      const brief = (await res.json()) as Record<string, unknown>
      expect(brief.realm).toBe(FOREIGN_REALM)
    })

    it('did not modify the foreign realm on its way to failing', async () => {
      // The POST is rejected by Keycloak with a 409 before it changes
      // anything, and the probe is a GET. Asserted rather than assumed:
      // a connector that overwrote a stranger's realm display name while
      // deciding it could not manage it would be worse than one that failed.
      expect(await getRealm(FOREIGN_REALM)).toMatchObject({
        displayName: 'Made By Someone Else',
        enabled: true,
      })
    })
  })

  it('never leaks a secret out of a failed realm call', async () => {
    // An invalid realm name Keycloak rejects outright, so the error carries
    // Keycloak's own response body — the one place a credential could
    // plausibly be echoed back into a message this system raises.
    let message = ''
    try {
      await connector.ensureRealm({ realm: '', displayName: 'Nameless' })
    } catch (error) {
      message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
    }
    expect(message).not.toContain(PROVISION_CLIENT_SECRET)
    expect(message).not.toContain('idm_sync_dev_secret_change_me')
  })
})

/**
 * No container: the master-realm refusal is decided before any I/O, so it can
 * be asserted against a factory that could never reach a server.
 */
describe('OrganizationConnector and the master organization realm', () => {
  const factory = new KeycloakAdminClientFactory({
    issuer: 'http://kc:8080/realms/identity-manager',
    clientId: 'idm-sync-service',
    clientSecret: 'realm-scoped-secret',
    provisionClientId: 'idm-provisioner',
    provisionClientSecret: 'provisioning-secret',
  })
  const connector = new OrganizationConnector(factory)

  it('refuses to create or adopt it', async () => {
    await expect(
      connector.ensureRealm({ realm: 'identity-manager', displayName: 'Master' }),
    ).rejects.toThrow(/master organization/)
  })

  it('refuses to disable it — the lockout this guard exists for', async () => {
    // Disabling this realm would lock out every administrator at once,
    // including whoever would have to undo it.
    await expect(connector.setRealmEnabled('identity-manager', false)).rejects.toThrow(
      /master organization/,
    )
  })

  it('refuses to enable it too, so the guard cannot be half-applied', async () => {
    await expect(connector.setRealmEnabled('identity-manager', true)).rejects.toThrow(
      /master organization/,
    )
  })

  it('says nothing about either credential when it refuses', async () => {
    let message = ''
    try {
      await connector.setRealmEnabled('identity-manager', false)
    } catch (error) {
      message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
    }
    expect(message).not.toContain('provisioning-secret')
    expect(message).not.toContain('realm-scoped-secret')
  })
})
