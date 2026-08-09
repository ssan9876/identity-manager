import path from 'node:path'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import { setDevTestClientEnabled } from '../../scripts/dev-test-client'

export interface TokenPair {
  accessToken: string
  refreshToken: string
}

export interface RefreshAttempt {
  ok: boolean
  status: number
}

export interface FixtureUserInput {
  username: string
  email: string
  password: string
}

export interface TestKeycloak {
  issuer: string
  tokenFor: (username: string, password: string) => Promise<string>
  /**
   * Same direct grant as `tokenFor`, but returns the refresh token alongside
   * the access token — needed to prove session revocation genuinely ends a
   * session (Milestone 4, Task 2): `tokenFor` alone discards the refresh
   * token, since no test needed it before the sync client's
   * setEnabled/revokeSessions tests.
   */
  tokenPairFor: (username: string, password: string) => Promise<TokenPair>
  /**
   * Attempts a `grant_type=refresh_token` exchange and reports the outcome
   * instead of throwing, so a test can assert a revoked session's refresh
   * token is genuinely rejected.
   */
  attemptRefresh: (refreshToken: string) => Promise<RefreshAttempt>
  /**
   * Creates a user WITH a real password credential, via the container's own
   * bootstrap (master-realm) admin — never via the code under test. The
   * whole point of KeycloakAdminClient.createUser (Milestone 4, Task 2) is
   * that it NEVER sends a credential, so no fixture that needs a
   * password-authenticatable user can be built by calling it; this exists
   * so the session-revocation test can mint a real access+refresh token
   * pair via direct grant for a throwaway fixture user, independent of (and
   * never exercising) the client under test's own credential-free create
   * path. Returns the new user's Keycloak id.
   */
  createFixtureUserWithPassword: (input: FixtureUserInput) => Promise<string>
  /**
   * Reads a user's current Keycloak group membership DIRECTLY via the
   * container's bootstrap admin — independent of KeycloakAdminClient (the
   * code under test in keycloak-admin.client.spec.ts), so a `setUserGroups`
   * assertion proves real Keycloak state rather than re-querying through the
   * same client method that performed the write, which would only prove the
   * client agrees with itself.
   */
  getUserGroupNames: (username: string) => Promise<string[]>
  stop: () => Promise<void>
}

const REALM = 'identity-manager'
const BOOTSTRAP_ADMIN_USERNAME = 'admin'
const BOOTSTRAP_ADMIN_PASSWORD = 'admin_dev_password'

// Resolved from the working directory (apps/api) rather than `__dirname`,
// which Vitest's SWC/ESM transform does not define.
const REALM_IMPORT_DIR = path.resolve(process.cwd(), '../../keycloak/realm-import')

/**
 * Real Keycloak, imported with the project realm. The design depends on actual
 * Keycloak token behaviour, so mocking the JWKS would only validate our
 * assumptions about Keycloak rather than Keycloak itself.
 */
export async function startKeycloak(): Promise<TestKeycloak> {
  const container: StartedTestContainer = await new GenericContainer(
    'quay.io/keycloak/keycloak:26.0',
  )
    .withCommand(['start-dev', '--import-realm'])
    .withEnvironment({
      KC_BOOTSTRAP_ADMIN_USERNAME: 'admin',
      KC_BOOTSTRAP_ADMIN_PASSWORD: 'admin_dev_password',
    })
    .withCopyDirectoriesToContainer([
      { source: REALM_IMPORT_DIR, target: '/opt/keycloak/data/import' },
    ])
    .withExposedPorts(8080)
    .withWaitStrategy(
      Wait.forHttp(
        `/realms/${REALM}/.well-known/openid-configuration`,
        8080,
      ).withStartupTimeout(180_000),
    )
    .start()

  const host = container.getHost()
  const port = container.getMappedPort(8080)
  const serverRoot = `http://${host}:${port}`
  const issuer = `${serverRoot}/realms/${REALM}`

  // The realm import ships `idm-test-client` DISABLED (finding SEC-L5 —
  // docs/archive/audits/carried-findings-verification.md, open item 8), so the
  // committed fixture cannot become a live password-grant endpoint if anyone
  // imports it into a real Keycloak. Every direct grant below depends on that
  // client, so enable it here, on THIS disposable container only, via its own
  // bootstrap admin. See apps/api/scripts/dev-test-client.ts for why the
  // client could not simply be deleted or moved to a second import file.
  //
  // Deliberately not restored afterwards: the container is destroyed by
  // `stop()` at the end of the suite, so there is nothing to leak into.
  await setDevTestClientEnabled(true, {
    serverRoot,
    realm: REALM,
    adminUsername: BOOTSTRAP_ADMIN_USERNAME,
    adminPassword: BOOTSTRAP_ADMIN_PASSWORD,
  })

  /** Shared by `tokenFor`/`tokenPairFor` — one direct-grant call, both shapes. */
  async function passwordGrant(username: string, password: string): Promise<TokenPair> {
    const res = await fetch(`${issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'idm-test-client',
        scope: 'openid profile email',
        username,
        password,
      }),
    })

    if (!res.ok) {
      throw new Error(`token request failed: ${res.status} ${await res.text()}`)
    }

    const body = (await res.json()) as { access_token: string; refresh_token: string }
    return { accessToken: body.access_token, refreshToken: body.refresh_token }
  }

  /**
   * A token for the container's OWN bootstrap admin, scoped to the `master`
   * realm — distinct from this realm's `idm-sync-service` (the client under
   * test), and never used by anything except `createFixtureUserWithPassword`
   * below. Keycloak's bootstrap admin can manage any realm on the server,
   * exactly like the human operator using the admin console would.
   */
  async function masterAdminToken(): Promise<string> {
    const res = await fetch(`${serverRoot}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: BOOTSTRAP_ADMIN_USERNAME,
        password: BOOTSTRAP_ADMIN_PASSWORD,
      }),
    })

    if (!res.ok) {
      throw new Error(`master admin token request failed: ${res.status} ${await res.text()}`)
    }

    return ((await res.json()) as { access_token: string }).access_token
  }

  return {
    issuer,

    async tokenFor(username: string, password: string): Promise<string> {
      return (await passwordGrant(username, password)).accessToken
    },

    async tokenPairFor(username: string, password: string): Promise<TokenPair> {
      return passwordGrant(username, password)
    },

    async attemptRefresh(refreshToken: string): Promise<RefreshAttempt> {
      const res = await fetch(`${issuer}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: 'idm-test-client',
          refresh_token: refreshToken,
        }),
      })
      return { ok: res.ok, status: res.status }
    },

    async createFixtureUserWithPassword(input: FixtureUserInput): Promise<string> {
      const adminToken = await masterAdminToken()
      const res = await fetch(`${serverRoot}/admin/realms/${REALM}/users`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: input.username,
          email: input.email,
          // firstName/lastName are REQUIRED here, not cosmetic: Keycloak's
          // declarative User Profile (see the realm import's `components`
          // block) marks both required, and without them a direct-grant
          // token request for this fixture user fails with 400 "Account is
          // not fully set up" — Keycloak computes VERIFY_PROFILE as a
          // required action dynamically at login time for an incomplete
          // profile, regardless of the `requiredActions` list below
          // (confirmed empirically against a real container).
          firstName: 'Fixture',
          lastName: 'User',
          enabled: true,
          emailVerified: true,
          requiredActions: [],
          credentials: [{ type: 'password', value: input.password, temporary: false }],
        }),
      })

      if (res.status !== 201) {
        throw new Error(`fixture user create failed: ${res.status} ${await res.text()}`)
      }

      const location = res.headers.get('location')
      const id = location?.split('/').pop()
      if (!id) {
        throw new Error('fixture user create: response had no Location header')
      }
      return id
    },

    async getUserGroupNames(username: string): Promise<string[]> {
      const adminToken = await masterAdminToken()

      const searchRes = await fetch(
        `${serverRoot}/admin/realms/${REALM}/users?username=${encodeURIComponent(username)}&exact=true`,
        { headers: { Authorization: `Bearer ${adminToken}` } },
      )
      if (!searchRes.ok) {
        throw new Error(`user search failed: ${searchRes.status} ${await searchRes.text()}`)
      }
      const [user] = (await searchRes.json()) as { id: string }[]
      if (!user) {
        throw new Error(`getUserGroupNames: no such user "${username}"`)
      }

      const groupsRes = await fetch(`${serverRoot}/admin/realms/${REALM}/users/${user.id}/groups`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
      if (!groupsRes.ok) {
        throw new Error(`group list failed: ${groupsRes.status} ${await groupsRes.text()}`)
      }
      const groups = (await groupsRes.json()) as { name: string }[]
      return groups.map((group) => group.name)
    },

    async stop(): Promise<void> {
      await container.stop()
    },
  }
}
