/**
 * Enables (and restores) the development realm's `idm-test-client` at runtime.
 *
 * WHY THIS EXISTS — finding SEC-L5
 * (docs/archive/audits/carried-findings-verification.md, open item 8; original
 * write-up in docs/archive/audits/audit-secrets.md).
 *
 * `keycloak/realm-import/identity-manager-realm.dev.json` is committed to a
 * public repository and contains real, working credentials. The audit's
 * required change was to rename it so its dev-only status is unmissable, set
 * `sslRequired: "external"`, and ship `idm-test-client` — a PUBLIC client with
 * the password grant (`directAccessGrantsEnabled`) — DISABLED, so that an
 * operator who imports that file into a real Keycloak by accident does not
 * thereby hand the internet a token-minting endpoint for the seeded
 * `admin@example.com` / `dev_password_change_me` account.
 *
 * The complication is that `idm-test-client` is genuinely load-bearing for two
 * paths that must keep working:
 *
 *   1. `apps/api/test/support/keycloak.ts` — the Testcontainers harness copies
 *      the realm-import directory into a DISPOSABLE Keycloak container and
 *      mints real tokens by direct grant. This is also what CI's `pnpm verify`
 *      runs (.github/workflows/ci.yml).
 *   2. `apps/api/scripts/smoke-dev.ts` — `pnpm --filter @idm/api smoke:dev`
 *      boots the real dev server against the Compose stack and makes one
 *      authenticated request through it.
 *
 * Neither can use another client: the `idm-api` audience mapper that the API's
 * `KEYCLOAK_AUDIENCE` check requires lives on `idm-test-client`, so Keycloak's
 * built-in `admin-cli` (public, direct grant enabled in every realm) issues
 * tokens the API correctly rejects with 401.
 *
 * Splitting the client into a second import file does not work either: files
 * in Keycloak's import directory each define a WHOLE realm, and a second file
 * naming an existing realm is skipped, not merged.
 *
 * So the client ships disabled and is switched on deliberately, at runtime, by
 * the two callers that need it — using the container's/stack's own bootstrap
 * (master-realm) admin, exactly as a human operator with the admin console
 * would. The security property this preserves is the one the finding is about:
 * the ARTEFACT in the repository is inert. Turning it on requires the Keycloak
 * admin password, which a production operator following
 * `scripts/keycloak-setup.sh` never applies to this file at all.
 *
 * Tradeoff, stated plainly: this is not as strong as deleting the client. An
 * attacker who already holds the Keycloak admin credential can re-enable it —
 * but that attacker can equally create their own direct-grant client, so the
 * client's presence adds nothing to their capability. What it removes is the
 * accident: import-and-forget no longer leaves a live password-grant endpoint.
 */

/** Compose (docker-compose.yml) and the test harness both bootstrap this admin. */
const DEFAULT_ADMIN_USERNAME = 'admin'
const DEFAULT_ADMIN_PASSWORD = 'admin_dev_password'
const DEFAULT_REALM = 'identity-manager'

export const DEV_TEST_CLIENT_ID = 'idm-test-client'

export interface DevTestClientOptions {
  /** Keycloak base URL with no `/realms` suffix, e.g. `http://localhost:8080`. */
  serverRoot: string
  realm?: string
  adminUsername?: string
  adminPassword?: string
}

interface ClientRepresentation {
  id: string
  clientId: string
  enabled: boolean
  [key: string]: unknown
}

/**
 * A token for the server's OWN bootstrap admin in the `master` realm — NOT
 * this realm's `idm-sync-service`. `idm-sync-service` deliberately holds only
 * four `realm-management` roles (manage-users, query-users, view-users,
 * query-groups) and structurally cannot alter a client, which is the whole
 * point of that split (see scripts/keycloak-setup.sh). Nothing in the
 * application ever takes this path; only dev tooling does.
 */
async function masterAdminToken(options: DevTestClientOptions): Promise<string> {
  const username = options.adminUsername ?? DEFAULT_ADMIN_USERNAME
  const password = options.adminPassword ?? DEFAULT_ADMIN_PASSWORD

  const res = await fetch(`${options.serverRoot}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username,
      password,
    }),
  })

  if (!res.ok) {
    throw new Error(
      `dev-test-client: could not authenticate as the Keycloak bootstrap admin ` +
        `("${username}") at ${options.serverRoot}: ${res.status} ${await res.text()}`,
    )
  }

  return ((await res.json()) as { access_token: string }).access_token
}

/**
 * Flips `idm-test-client`'s `enabled` flag and returns what it was BEFORE the
 * call, so a caller running against a long-lived stack can put it back (see
 * smoke-dev.ts). Returns without touching Keycloak when the flag already has
 * the requested value, which makes it safe to call unconditionally and safe to
 * call twice.
 *
 * The update is a read-modify-write of the full client representation rather
 * than a bare `{ enabled }` body: Keycloak's client PUT replaces the
 * representation, so posting only one field would silently drop the
 * `idm-api` audience mapper's siblings — the very configuration that makes
 * this client useful.
 */
export async function setDevTestClientEnabled(
  enabled: boolean,
  options: DevTestClientOptions,
): Promise<boolean> {
  const realm = options.realm ?? DEFAULT_REALM
  const token = await masterAdminToken(options)
  const authHeaders = { Authorization: `Bearer ${token}` }

  const lookup = await fetch(
    `${options.serverRoot}/admin/realms/${realm}/clients?clientId=${encodeURIComponent(DEV_TEST_CLIENT_ID)}`,
    { headers: authHeaders },
  )
  if (!lookup.ok) {
    throw new Error(
      `dev-test-client: client lookup failed: ${lookup.status} ${await lookup.text()}`,
    )
  }

  const [client] = (await lookup.json()) as ClientRepresentation[]
  if (!client) {
    throw new Error(
      `dev-test-client: realm "${realm}" has no "${DEV_TEST_CLIENT_ID}". This realm was ` +
        `probably not created from keycloak/realm-import/identity-manager-realm.dev.json — ` +
        `and if it is a REAL Keycloak built by scripts/keycloak-setup.sh, that is correct ` +
        `and intended: the test client has no business existing there (SEC-L5).`,
    )
  }

  const wasEnabled = client.enabled === true
  if (wasEnabled === enabled) return wasEnabled

  const update = await fetch(`${options.serverRoot}/admin/realms/${realm}/clients/${client.id}`, {
    method: 'PUT',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...client, enabled }),
  })
  if (!update.ok) {
    throw new Error(
      `dev-test-client: could not set enabled=${enabled}: ${update.status} ${await update.text()}`,
    )
  }

  return wasEnabled
}
