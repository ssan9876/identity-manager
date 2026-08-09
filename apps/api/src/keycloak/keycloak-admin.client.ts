import { Inject, Injectable } from '@nestjs/common'
import { ConflictError, NotFoundError } from '../common/errors'

/**
 * DI token carrying KeycloakAdminClientConfig into the client — same pattern
 * as JWT_GUARD_OPTIONS (see auth/jwt.guard.ts): a plain TS interface erases
 * at runtime (`design:paramtypes` would emit bare `Object`), so it cannot be
 * a constructor-injected DI token on its own.
 */
export const KEYCLOAK_ADMIN_CONFIG = Symbol('KEYCLOAK_ADMIN_CONFIG')

export interface KeycloakAdminClientConfig {
  /** Same shape as `env.keycloakIssuer` — e.g. http://localhost:8080/realms/identity-manager. */
  issuer: string
  clientId: string
  clientSecret: string
  /**
   * Per-request abort bound, applied to every outbound `fetch` (token
   * requests and admin REST calls alike) via `AbortSignal.timeout`. Optional
   * on this CONFIG type — `undefined` here means "use `DEFAULT_REQUEST_
   * TIMEOUT_MS`", not "no bound at all" (see that constant's own doc
   * comment for why unbounded is no longer an available behaviour for this
   * client). Overridable per instance, exactly like `EntraIdConnectorConfig.
   * requestTimeoutMs`/`GoogleWorkspaceConnectorConfig.requestTimeoutMs` are:
   * `app.module.ts`'s production wiring leaves this unset and gets the
   * default; `sync.worker.spec.ts` sets it explicitly to 20s (see that
   * file's own `KEYCLOAK_REQUEST_TIMEOUT_MS`) because it is the single most
   * Keycloak-round-trip-dense spec in the suite and wants a little more
   * headroom under full-suite host contention than the default gives.
   */
  requestTimeoutMs?: number
  /**
   * Which realm this client ADMINISTERS, when that is not the realm it
   * authenticates against. Defaults to the issuer's own realm, so every
   * construction that predates organizations is unchanged.
   *
   * Organizations, Task 9. `issuer` fixes the token endpoint; the admin base
   * URL is otherwise derived from it, which is right for a realm-scoped
   * service account (it authenticates against, and administers, one realm)
   * and wrong for the master-realm provisioning account (it authenticates
   * against `master` and administers a TENANT realm). Overriding only the
   * realm segment of `adminBaseUrl` keeps the two facts separable without a
   * second URL to keep in sync with the issuer's host and port.
   */
  adminRealm?: string
}

/** What this client reads back off Keycloak's own user representation. */
export interface KeycloakUser {
  id: string
  username: string
  email: string | null
  firstName: string | null
  lastName: string | null
  enabled: boolean
  emailVerified: boolean
  attributes: Record<string, string[]>
}

export interface DesiredKeycloakUser {
  username: string
  email: string
  firstName: string
  lastName: string
  enabled: boolean
  attributes: Record<string, unknown>
}

/**
 * `createUser`'s desired profile omits `enabled` on purpose — see
 * `updateUser`'s doc comment for why that field is `setEnabled`'s alone.
 */
export interface DesiredUserProfile {
  email: string
  firstName: string
  lastName: string
  attributes: Record<string, unknown>
}

/**
 * Keycloak's ClientRepresentation, narrowed to the fields Identity Manager
 * manages plus an index signature for everything it does not. The index
 * signature is load-bearing, not laziness: client update takes a FULL
 * representation, so `KeycloakSsoConnector` reads the current one and spreads
 * it before overlaying its own fields. Anything this interface failed to name
 * would be dropped from that spread and silently cleared on the next sync.
 */
export interface KeycloakClientRepresentation {
  id?: string
  clientId: string
  name?: string
  description?: string
  protocol?: string
  publicClient?: boolean
  enabled?: boolean
  standardFlowEnabled?: boolean
  redirectUris?: string[]
  webOrigins?: string[]
  attributes?: Record<string, string>
  defaultClientScopes?: string[]
  [key: string]: unknown
}

/**
 * The one protocol mapper this system asserts on an application's client.
 * Name and claim are FIXED rather than admin-editable: an application that
 * has to guess which claim carries its authorization data is a support call
 * waiting to happen. `full: 'false'` emits bare group names, matching the
 * flattened names the Keycloak user connector already writes as membership.
 */
export const GROUP_MEMBERSHIP_MAPPER = {
  name: 'groups',
  protocol: 'openid-connect',
  protocolMapper: 'oidc-group-membership-mapper',
  config: {
    'claim.name': 'groups',
    full: 'false',
    'access.token.claim': 'true',
    'id.token.claim': 'true',
    'userinfo.token.claim': 'true',
  },
} as const

export interface KeycloakGroup {
  id: string
  name: string
  path: string
}

export interface KeycloakCredentialSummary {
  id: string
  type: string
}

/**
 * Only the fields `buildSyncedAttributes` needs. Milestone 10, Task 3:
 * previously `Pick<AttributeDefinition, 'key' | 'syncToKeycloak'>` —
 * deliberately decoupled from that type now that `syncToKeycloak` no longer
 * exists on it (`attribute_definitions.sync_to_keycloak` is dropped;
 * default-deny propagation moved to the per-target
 * `attribute_target_mappings` table, see db/schema/attribute-target-
 * mappings.ts). This class and `buildSyncedAttributes` below are otherwise
 * COMPLETELY UNCHANGED by that migration: `KeycloakConnector.apply`
 * (connectors/keycloak.connector.ts) still builds a synthetic, all-`true`
 * `SyncableAttributeDefinition[]` from whichever keys survived the NEW
 * per-target filter (`connectors/attribute-mapping.ts`'s
 * `buildTargetAttributes`, run once in `SyncWorker.reconcileUser` before any
 * connector is called) — this type's own field name stays `syncToKeycloak`
 * so that passthrough construction, and this whole file's pre-existing,
 * extensive test coverage, needed no changes at all.
 */
export interface SyncableAttributeDefinition {
  key: string
  syncToKeycloak: boolean
}

const REQUIRED_ACTION_UPDATE_PASSWORD = 'UPDATE_PASSWORD'

// Refresh the cached token this long before its real expiry, so a request
// that starts a moment before expiry doesn't race a token that dies
// mid-flight. Capped at half the token's own lifetime so a very short-lived
// token (e.g. a misconfigured realm) never computes a non-positive TTL.
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 10_000

// The production default for `KeycloakAdminClientConfig.requestTimeoutMs`
// when a caller doesn't set one — including `app.module.ts`'s real DI
// wiring, which does not (see KEYCLOAK_ADMIN_CONFIG's factory there). Same
// value, same rationale, as `EntraIdConnector`'s/`GoogleWorkspaceConnector`'s
// own `DEFAULT_REQUEST_TIMEOUT_MS`: "a single apply() call blocking the sync
// worker indefinitely" is exactly as real for Keycloak as for either of
// those two targets — arguably more so, since Keycloak is the original
// Milestone-4 connector and is on the critical path for every login-
// affecting change, and has been in production the longest of the three.
// Before this, `KeycloakAdminClient` was the one connector in this codebase
// without any bound at all: a stalled admin-REST or token call could hang
// the caller (the sync worker's open transaction, or `UsersController`'s
// synchronous revocation path) indefinitely, holding that event's claim —
// and, per `SyncWorker.reconcileUser`'s own per-aggregate-user advisory
// lock, blocking every OTHER event queued behind it for the same user too.
// The H2 investigation (h2-race-flake-report.md) added the FIELD but scoped
// its use to one test file, flagging the production gap as a named,
// deliberately out-of-scope follow-up (that report's Concern #1) — this is
// that follow-up. A timeout firing surfaces as an ordinary thrown error from
// `fetch` (an `AbortError`/`TimeoutError`), which every caller already
// propagates as a plain rejected promise — no new error type, no new catch
// needed anywhere: `SyncWorker.runOnce`'s existing try/catch turns it into
// exactly the same retryable, backed-off `recordFailure` outcome as any
// other transient Keycloak failure (a 5xx, a dropped connection, ...), and
// `UsersController.revokeKeycloakAccess`'s existing catch-and-log already
// treats ANY Keycloak error, this one included, as non-fatal to the request
// it backs (see that method's own doc comment).
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

/**
 * Thrown for any Keycloak admin REST failure NOT mapped to a DomainError
 * (see `assertOk` below for the 404/409 mapping). Deliberately NOT a
 * DomainError subclass: DomainError is for errors OUR OWN HTTP layer maps
 * to a response status (see common/errors.ts's file doc comment) — a raw
 * Keycloak-side failure is an operational fact the sync worker (Milestone
 * 4, Task 3) retries, never something this API should turn into one of its
 * own client-facing 4xx responses.
 */
export class KeycloakAdminError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'KeycloakAdminError'
  }
}

/** Best-effort extraction of Keycloak's own `errorMessage`/`error` field; falls back to raw text. */
async function describeError(res: Response): Promise<string> {
  const text = await res.text()
  try {
    const parsed = JSON.parse(text) as { errorMessage?: string; error?: string }
    return parsed.errorMessage ?? parsed.error ?? text
  } catch {
    return text
  }
}

/**
 * Filters a desired-state attributes bag down to ONLY the keys whose
 * definition has `sync_to_keycloak = true` — the milestone's default-deny
 * constraint (see the global constraints in the milestone plan: "Attribute
 * propagation is default-deny... Anything sent to Keycloak can surface in a
 * JWT claim"). A free function called from every payload-building call site
 * inside this client (`createUser`, `updateUser`) rather than something
 * callers are trusted to have already filtered: `definitions` is a
 * mandatory, compile-time-enforced parameter on both, so a caller cannot
 * pass a raw, unfiltered `attributes` bag and skip this — even a caller
 * that forgets to pre-filter still cannot leak a non-synced key, because the
 * filtering happens HERE, unconditionally, not at the call site.
 *
 * Keycloak represents every custom attribute as `string[]`, never a bare
 * scalar. An array value is stringified element-wise; any other value
 * becomes a single-element array. `null`/`undefined` values are dropped
 * entirely (nothing meaningful to send), not sent as `[""]`/`["null"]`.
 */
export function buildSyncedAttributes(
  attributes: Record<string, unknown>,
  definitions: readonly SyncableAttributeDefinition[],
): Record<string, string[]> {
  const syncableKeys = new Set(
    definitions.filter((definition) => definition.syncToKeycloak).map((definition) => definition.key),
  )

  // Object.create(null), not {} — sweep from docs/archive/audits/audit-
  // injection.md's HIGH `__proto__` finding (see attribute-validator.ts's
  // rawAttributesSchema doc comment for the full root-cause writeup this
  // project has now been bitten by four times). Not reachable today (no
  // write path exists for attribute_definitions, so `key` can only ever be
  // one of a fixed, developer-seeded set — never attacker-controlled), but
  // this is exactly the kind of untrusted-key-onto-a-plain-object-literal
  // sink the audit asked to be swept, and the value here can be a genuine
  // Object (an array, after Array.isArray splits it — see below), which
  // WOULD actually reassign `result`'s own prototype rather than merely
  // no-op silently, the moment a write path for attribute_definitions ever
  // lands.
  const result: Record<string, string[]> = Object.create(null)
  for (const [key, value] of Object.entries(attributes)) {
    if (!syncableKeys.has(key)) continue
    if (value === null || value === undefined) continue
    result[key] = Array.isArray(value) ? value.map(String) : [String(value)]
  }
  return result
}

interface RawKeycloakUser {
  id: string
  username: string
  email?: string
  firstName?: string
  lastName?: string
  enabled?: boolean
  emailVerified?: boolean
  attributes?: Record<string, string[]>
}

function toKeycloakUser(raw: RawKeycloakUser): KeycloakUser {
  return {
    id: raw.id,
    username: raw.username,
    email: raw.email ?? null,
    firstName: raw.firstName ?? null,
    lastName: raw.lastName ?? null,
    enabled: raw.enabled ?? false,
    emailVerified: raw.emailVerified ?? false,
    attributes: raw.attributes ?? {},
  }
}

/**
 * Pushes user/group state OUT of this system INTO Keycloak — the Milestone 4
 * Admin REST client (Task 2). Every method expresses DESIRED STATE, never a
 * delta: `updateUser`/`setEnabled`/`setUserGroups` each fully re-assert what
 * SHOULD be true, so applying the same call twice converges to identical
 * Keycloak state instead of compounding. This is deliberate — it is the
 * property the sync worker's whole retry design rests on (Milestone 4, Task
 * 3): a retried event can safely re-run this client's methods without first
 * figuring out what already landed.
 *
 * Two binding constraints, enforced IN THIS CLASS, not left to callers:
 *  1. No method here ever sends a password, a credential array, or a
 *     temporary password. `createUser` sends only `enabled`, `emailVerified:
 *     false`, and a `UPDATE_PASSWORD` required action — Keycloak's
 *     required-action email flow owns credential setup from there.
 *  2. `attributes` payloads are filtered through `buildSyncedAttributes`,
 *     which admits only `sync_to_keycloak = true` keys — see its doc
 *     comment for why the enforcement point is there, not at the call site.
 *
 * Wired into AppModule (Milestone 4, Task 4) so `SyncWorker`, `UsersController`
 * (synchronous revocation) and the on-demand reconciliation job can all share
 * one instance/token-cache.
 */
@Injectable()
export class KeycloakAdminClient {
  private readonly tokenUrl: string
  private readonly adminBaseUrl: string
  private cachedToken: { value: string; expiresAt: number } | null = null

  /**
   * Held as a TRUE ECMAScript private field, not `private readonly config`.
   * A TS `private` is compile-time only: the property is still enumerable at
   * runtime, so `JSON.stringify(client)` — or any structured logger, error
   * reporter or Nest debug dump that walks a provider — would print
   * `clientSecret` verbatim. `#config` is invisible to all of them. Same
   * rule connectors/secrets.ts states for connector credentials, applied to
   * the one this class was constructed with (Organizations, Task 9, where a
   * SECOND secret — the realm-provisioning account's — started flowing
   * through this same constructor).
   */
  readonly #config: KeycloakAdminClientConfig

  constructor(@Inject(KEYCLOAK_ADMIN_CONFIG) config: KeycloakAdminClientConfig) {
    this.#config = config
    // `config.issuer` is `<serverRoot>/realms/<realm>` (identical shape to
    // env.keycloakIssuer) — split it into the two bases the admin REST API
    // and the token endpoint each need, rather than requiring a THIRD env
    // var that could drift out of sync with the issuer's own host/port.
    const url = new URL(config.issuer)
    const match = /^(.*)\/realms\/([^/]+)$/.exec(`${url.origin}${url.pathname}`)
    if (!match) {
      throw new Error(
        `KeycloakAdminClientConfig.issuer must contain /realms/<name>: ${config.issuer}`,
      )
    }
    const [, serverRoot, realm] = match
    this.tokenUrl = `${config.issuer}/protocol/openid-connect/token`
    // `adminRealm` when the caller set one, else the issuer's own realm —
    // see KeycloakAdminClientConfig.adminRealm. The two are deliberately
    // read from different places: the token endpoint always follows the
    // issuer, the admin path does not have to.
    this.adminBaseUrl = `${serverRoot}/admin/realms/${config.adminRealm ?? realm}`
  }

  // ---------------------------------------------------------------------
  // Token handling: client-credentials grant, cached until shortly before
  // expiry, forced refresh on a 401 from any admin call (see `request`).
  // ---------------------------------------------------------------------

  /** `config.requestTimeoutMs` when the caller set one, else `DEFAULT_REQUEST_TIMEOUT_MS` — see that constant's and `KeycloakAdminClientConfig.requestTimeoutMs`'s own doc comments. Every outbound `fetch` in this class carries this, unconditionally: there is no longer an unbounded call site. */
  private abortSignal(): AbortSignal {
    return AbortSignal.timeout(this.#config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
  }

  private async fetchToken(): Promise<{ value: string; expiresAt: number }> {
    const requestedAt = Date.now()
    const res = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.#config.clientId,
        client_secret: this.#config.clientSecret,
      }),
      signal: this.abortSignal(),
    })

    if (!res.ok) {
      throw new KeycloakAdminError(
        res.status,
        `Keycloak admin token request failed: ${res.status} ${await describeError(res)}`,
      )
    }

    const body = (await res.json()) as { access_token: string; expires_in: number }
    const lifetimeMs = body.expires_in * 1000
    const margin = Math.min(TOKEN_EXPIRY_SAFETY_MARGIN_MS, lifetimeMs / 2)
    return { value: body.access_token, expiresAt: requestedAt + lifetimeMs - margin }
  }

  private async getToken(forceRefresh: boolean): Promise<string> {
    if (!forceRefresh && this.cachedToken !== null && this.cachedToken.expiresAt > Date.now()) {
      return this.cachedToken.value
    }
    this.cachedToken = await this.fetchToken()
    return this.cachedToken.value
  }

  /**
   * Milestone 10, Task 2 — "can we reach and authenticate right now"
   * (`DirectoryConnector.health`, connectors/connector.ts), backing
   * `KeycloakConnector.health`. Forces a FRESH token request
   * (`forceRefresh: true`) rather than trusting a cached token: a cached
   * value can be reused successfully right up until the moment it expires,
   * so trusting it here would make `health()` report healthy through a
   * window where the admin credentials could already be wrong (rotated,
   * revoked) without this call ever finding out. Never throws — the whole
   * point of this method is to turn a connection/auth failure into an
   * ANSWER, not another exception for a caller to unwrap; `fetchToken`'s own
   * error message is already safe to surface as-is (Keycloak's token
   * endpoint error response never echoes back the client secret this class
   * sent it — confirmed against `describeError`/`fetchToken` above, which
   * only ever reads Keycloak's OWN response body).
   */
  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.getToken(true)
      return { ok: true, detail: 'authenticated with Keycloak' }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * One authenticated admin REST call, with EXACTLY one retry on a 401 —
   * covers the token expiring between the cache check and the request
   * actually reaching Keycloak, or the cached token being invalidated
   * server-side. `path` is relative to `/admin/realms/{realm}`.
   */
  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const attempt = async (token: string): Promise<Response> =>
      fetch(`${this.adminBaseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: this.abortSignal(),
      })

    const res = await attempt(await this.getToken(false))
    if (res.status !== 401) {
      return res
    }
    return attempt(await this.getToken(true))
  }

  /**
   * Shared status handling for every call below that doesn't need its own
   * bespoke success path (contrast `createUser`/`ensureGroup`, which parse a
   * Location header on success and so handle their own errors inline). Maps
   * 404 -> NotFoundError and 409 -> ConflictError — the milestone's exact
   * mapping — and throws KeycloakAdminError for anything else non-ok, so the
   * sync worker's retry loop sees a plain throw for every other failure.
   */
  private async assertOk(res: Response, notFound: { resource: string; id: string }): Promise<void> {
    if (res.ok) return

    if (res.status === 404) {
      throw new NotFoundError(notFound.resource, notFound.id)
    }
    if (res.status === 409) {
      throw new ConflictError(await describeError(res))
    }
    throw new KeycloakAdminError(res.status, `Keycloak admin request failed: ${res.status} ${await describeError(res)}`)
  }

  // ---------------------------------------------------------------------
  // Users
  // ---------------------------------------------------------------------

  /**
   * Exact-username lookup. Keycloak's search endpoint always returns 200
   * with an array (empty when nothing matches) — never a 404 — so this
   * returns `null` rather than throwing when there is no match.
   * `exact=true` is passed to Keycloak, but the result is still filtered
   * case-insensitively here as a defensive re-check: our own `users.username`
   * uniqueness is case-insensitive (see db/schema/users.ts), so a caller
   * relying on this to mirror that behaviour must get the same answer.
   *
   * `briefRepresentation=false` is load-bearing, not cosmetic: Keycloak's
   * search endpoint defaults `briefRepresentation` to `true`, which OMITS
   * `attributes` (and `requiredActions`) from every result — confirmed
   * empirically against a real container, not assumed. Without this, every
   * caller of this method — including the default-deny attribute tests —
   * would see an always-empty `attributes`, silently.
   */
  async findUserByUsername(username: string): Promise<KeycloakUser | null> {
    const res = await this.request(
      'GET',
      `/users?username=${encodeURIComponent(username)}&exact=true&briefRepresentation=false`,
    )
    if (!res.ok) {
      throw new KeycloakAdminError(res.status, `find user failed: ${res.status} ${await describeError(res)}`)
    }
    const rows = (await res.json()) as RawKeycloakUser[]
    const match = rows.find((row) => row.username.toLowerCase() === username.toLowerCase())
    return match ? toKeycloakUser(match) : null
  }

  private async requireUserId(username: string): Promise<string> {
    const user = await this.findUserByUsername(username)
    if (user === null) {
      throw new NotFoundError('keycloak user', username)
    }
    return user.id
  }

  /**
   * NEVER sends a password, a credential array, or a temporary password —
   * this milestone's foremost binding constraint (see this class's doc
   * comment). `emailVerified` is always `false` and `requiredActions`
   * always carries exactly `UPDATE_PASSWORD`: credential setup is entirely
   * Keycloak's required-action email flow, never this system's.
   *
   * A duplicate `username`/`email` surfaces from Keycloak as a 409, mapped
   * to ConflictError — reconciling that (e.g. falling back to a lookup +
   * `updateUser`) is the sync WORKER's job (Milestone 4, Task 3, decision
   * 2: "reconcile to desired state"), not this method's; this is a single
   * REST primitive, not an idempotent upsert.
   */
  async createUser(
    input: DesiredKeycloakUser,
    definitions: readonly SyncableAttributeDefinition[],
  ): Promise<{ id: string }> {
    const res = await this.request('POST', '/users', {
      username: input.username,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      enabled: input.enabled,
      emailVerified: false,
      requiredActions: [REQUIRED_ACTION_UPDATE_PASSWORD],
      attributes: buildSyncedAttributes(input.attributes, definitions),
    })

    if (res.status === 409) {
      throw new ConflictError(await describeError(res))
    }
    if (!res.ok) {
      throw new KeycloakAdminError(res.status, `create user failed: ${res.status} ${await describeError(res)}`)
    }

    const id = idFromLocation(res)
    if (!id) {
      throw new KeycloakAdminError(res.status, 'create user succeeded but returned no Location header')
    }
    return { id }
  }

  /**
   * Full desired-state overwrite of the user's profile + attributes — NEVER
   * a delta (see this class's doc comment on why every method here reads
   * this way). Deliberately excludes `enabled` (`setEnabled`'s job alone —
   * kept a standalone call so Task 4's synchronous revocation path can
   * flip it without resending the rest of the profile) and
   * `emailVerified`/`requiredActions` (owned by Keycloak/the user from
   * creation onward, never re-asserted by a routine sync).
   *
   * `attributes` is sent as a REPLACEMENT map on every call — Keycloak
   * replaces the whole map when the `attributes` key is present in a PUT
   * body, rather than merging entry-by-entry — so repeated calls converge
   * exactly, and an attribute whose definition later flips
   * `sync_to_keycloak` to `false` simply stops being resent, and is thereby
   * removed on the next sync rather than left stranded.
   */
  async updateUser(
    username: string,
    desired: DesiredUserProfile,
    definitions: readonly SyncableAttributeDefinition[],
  ): Promise<void> {
    const id = await this.requireUserId(username)

    const res = await this.request('PUT', `/users/${id}`, {
      email: desired.email,
      firstName: desired.firstName,
      lastName: desired.lastName,
      attributes: buildSyncedAttributes(desired.attributes, definitions),
    })

    await this.assertOk(res, { resource: 'keycloak user', id: username })
  }

  /**
   * A standalone desired-state assertion of JUST the enabled flag. Kept
   * separate from `updateUser` because Task 4's synchronous revocation path
   * (suspend/deactivate) calls this ALONE, inline, before the HTTP response
   * returns — see the milestone plan's "Suspend/deactivate is
   * synchronous-first" decision — and must not also resend the rest of the
   * profile to do so.
   */
  async setEnabled(username: string, enabled: boolean): Promise<void> {
    const id = await this.requireUserId(username)
    const res = await this.request('PUT', `/users/${id}`, { enabled })
    await this.assertOk(res, { resource: 'keycloak user', id: username })
  }

  /**
   * Milestone 10, Task 2 — sets `enabled` by the Keycloak user's OWN id
   * directly, with no username lookup. Backs `KeycloakConnector.disable`
   * (connectors/keycloak.connector.ts), which — per the connector interface
   * — is given only the target's immutable external id, never a username.
   * Deliberately a SECOND, independent method rather than a refactor of
   * `setEnabled` to call it: doing so would risk changing `setEnabled`'s own
   * NotFoundError message (username vs. this method's Keycloak-id) on the
   * rare user-deleted-mid-call race, which its own existing tests pin. Two
   * near-identical lines costs less than that risk.
   */
  async setEnabledById(id: string, enabled: boolean): Promise<void> {
    const res = await this.request('PUT', `/users/${id}`, { enabled })
    await this.assertOk(res, { resource: 'keycloak user', id })
  }

  /**
   * Ends every active session/token for this user, via Keycloak's own
   * admin `/logout` action. Paired with `setEnabled(false)` — never a
   * substitute for it: disabling blocks FUTURE authentication attempts,
   * this ends sessions/tokens already issued. Both together are what the
   * milestone plan's synchronous revocation path (Task 4) calls inline on
   * suspend/deactivate.
   */
  async revokeSessions(username: string): Promise<void> {
    const id = await this.requireUserId(username)
    const res = await this.request('POST', `/users/${id}/logout`)
    await this.assertOk(res, { resource: 'keycloak user', id: username })
  }

  /**
   * Exists to make "no credential is set" provable against Keycloak's OWN
   * state, not assumed: the plain user representation
   * (`findUserByUsername`) never echoes stored credential data — Keycloak
   * omits it from that endpoint by design, for every user, credentialed or
   * not — so it is not a valid signal either way. This calls the dedicated
   * credentials sub-resource, which lists exactly what Keycloak actually
   * holds for the user (type/id only, never a secret value). Not one of
   * this task's seven named methods, but necessary for the tests to assert
   * the project's foremost binding constraint against real Keycloak state
   * rather than against this client's own request body.
   */
  async listCredentials(username: string): Promise<KeycloakCredentialSummary[]> {
    const id = await this.requireUserId(username)
    const res = await this.request('GET', `/users/${id}/credentials`)
    await this.assertOk(res, { resource: 'keycloak user', id: username })
    const rows = (await res.json()) as { id: string; type: string }[]
    return rows.map((row) => ({ id: row.id, type: row.type }))
  }

  // ---------------------------------------------------------------------
  // Groups
  // ---------------------------------------------------------------------

  /**
   * Idempotent get-or-create by exact name, at the realm's top level. Local
   * group names are already globally unique (see db/schema/groups.ts's
   * `groups_name_unique` index), so a flat, name-keyed Keycloak group per
   * local group is a sufficient mapping for this milestone — nesting
   * Keycloak subgroups to mirror `group_group_members` is not something any
   * of this task's seven methods is asked to do.
   *
   * A concurrent create losing a race — two callers `ensureGroup`-ing the
   * SAME new name at once, realistic under Task 3's "two workers racing the
   * same backlog" property when two different aggregates both reference
   * this group — surfaces from Keycloak as a 409 on the POST. That is
   * swallowed here, not surfaced as ConflictError: `ensureGroup` means
   * "this group exists when I return," and it does, just created by the
   * other racer; re-fetching and returning it IS the desired-state result,
   * not a failure.
   */
  async ensureGroup(name: string): Promise<KeycloakGroup> {
    const existing = await this.findGroupByName(name)
    if (existing !== null) {
      return existing
    }

    const res = await this.request('POST', '/groups', { name })

    if (res.status === 409) {
      const nowExisting = await this.findGroupByName(name)
      if (nowExisting !== null) {
        return nowExisting
      }
      // A 409 that doesn't correspond to an existing group of this exact
      // name is a genuine, unexplained conflict — surface it rather than
      // silently swallowing it.
      throw new ConflictError(`group "${name}" could not be created or found after a 409`)
    }
    if (!res.ok) {
      throw new KeycloakAdminError(res.status, `create group failed: ${res.status} ${await describeError(res)}`)
    }

    const id = idFromLocation(res)
    if (!id) {
      throw new KeycloakAdminError(res.status, 'create group succeeded but returned no Location header')
    }
    return { id, name, path: `/${name}` }
  }

  private async findGroupByName(name: string): Promise<KeycloakGroup | null> {
    const res = await this.request('GET', `/groups?search=${encodeURIComponent(name)}&exact=true`)
    if (!res.ok) {
      throw new KeycloakAdminError(res.status, `find group failed: ${res.status} ${await describeError(res)}`)
    }
    const rows = (await res.json()) as { id: string; name: string; path: string }[]
    const match = rows.find((row) => row.name === name)
    return match ? { id: match.id, name: match.name, path: match.path } : null
  }

  /**
   * Full desired-state group membership: after this call, the user belongs
   * to EXACTLY `groupIds` — no more, no less. Diffs against Keycloak's
   * current membership list and issues only the adds/removes needed to
   * close the gap, so calling this twice with the same `groupIds` issues
   * zero writes the second time and leaves identical state either way.
   *
   * `groupIds` are Keycloak group ids (e.g. from `ensureGroup`), not local
   * group ids or names — this method does no name resolution of its own,
   * keeping it a pure membership-reconciliation primitive.
   */
  async setUserGroups(username: string, groupIds: readonly string[]): Promise<void> {
    const id = await this.requireUserId(username)

    const res = await this.request('GET', `/users/${id}/groups`)
    await this.assertOk(res, { resource: 'keycloak user', id: username })
    const current = (await res.json()) as { id: string }[]
    const currentIds = new Set(current.map((group) => group.id))
    const desiredIds = new Set(groupIds)

    for (const groupId of desiredIds) {
      if (!currentIds.has(groupId)) {
        const joinRes = await this.request('PUT', `/users/${id}/groups/${groupId}`)
        await this.assertOk(joinRes, { resource: 'keycloak group', id: groupId })
      }
    }
    for (const groupId of currentIds) {
      if (!desiredIds.has(groupId)) {
        const leaveRes = await this.request('DELETE', `/users/${id}/groups/${groupId}`)
        await this.assertOk(leaveRes, { resource: 'keycloak group', id: groupId })
      }
    }
  }

  /**
   * Read-only: the user's CURRENT Keycloak group membership. Not one of
   * Task 2's seven original methods — added for Milestone 4, Task 4's
   * on-demand reconciliation job, which must independently REPORT group
   * drift (what Keycloak currently has) before repairing it, rather than
   * blindly re-asserting via `setUserGroups` and never knowing whether
   * anything actually changed. Same GET `/users/{id}/groups` call
   * `setUserGroups` already issues internally to compute its own diff,
   * exposed here as a standalone read so a caller that only wants to
   * COMPARE (not write) never has to trigger a write to get an answer.
   */
  async listUserGroups(username: string): Promise<KeycloakGroup[]> {
    const id = await this.requireUserId(username)
    const res = await this.request('GET', `/users/${id}/groups`)
    await this.assertOk(res, { resource: 'keycloak user', id: username })
    const rows = (await res.json()) as { id: string; name: string; path: string }[]
    return rows.map((row) => ({ id: row.id, name: row.name, path: row.path }))
  }

  // ---------------------------------------------------------------------
  // OIDC CLIENTS (SSO application onboarding).
  //
  // Reached only by KeycloakSsoConnector, which builds its OWN instance of
  // this class bound to the `idm-sso-admin` credential -- a different service
  // account from the sync worker's, holding `manage-clients` and nothing
  // else. The user and group methods above run as `idm-sync-service`, whose
  // exactly-four realm-management roles do not include it, so the ordinary
  // sync path structurally cannot mint or alter a client rather than merely
  // declining to.
  // ---------------------------------------------------------------------

  async findClientByClientId(clientId: string): Promise<KeycloakClientRepresentation | null> {
    const res = await this.request('GET', `/clients?clientId=${encodeURIComponent(clientId)}`)
    if (!res.ok) {
      throw new KeycloakAdminError(res.status, `find client failed: ${res.status} ${await describeError(res)}`)
    }
    const rows = (await res.json()) as KeycloakClientRepresentation[]
    return rows[0] ?? null
  }

  async getClient(uuid: string): Promise<KeycloakClientRepresentation> {
    const res = await this.request('GET', `/clients/${uuid}`)
    await this.assertOk(res, { resource: 'keycloak client', id: uuid })
    return (await res.json()) as KeycloakClientRepresentation
  }

  /**
   * Returns the UUID Keycloak assigned. Create responds 201 with a `Location`
   * header and no body, same as `createUser`; the read-back is the fallback
   * for a deployment that strips it.
   */
  async createClient(rep: KeycloakClientRepresentation): Promise<string> {
    const res = await this.request('POST', '/clients', rep)
    if (!res.ok) {
      if (res.status === 409) {
        throw new ConflictError(await describeError(res))
      }
      throw new KeycloakAdminError(res.status, `create client failed: ${res.status} ${await describeError(res)}`)
    }
    const fromLocation = idFromLocation(res)
    if (fromLocation !== undefined && fromLocation.length > 0) {
      return fromLocation
    }
    const created = await this.findClientByClientId(rep.clientId)
    if (created?.id === undefined) {
      throw new Error(`created client "${rep.clientId}" but could not read back its id`)
    }
    return created.id
  }

  async updateClient(uuid: string, rep: KeycloakClientRepresentation): Promise<void> {
    const res = await this.request('PUT', `/clients/${uuid}`, rep)
    await this.assertOk(res, { resource: 'keycloak client', id: uuid })
  }

  /**
   * Keycloak accepts `protocolMappers` on client CREATE and silently drops
   * them on UPDATE -- scripts/keycloak-setup.sh records the identical trap for
   * the `idm-api` audience mapper and works around it the same way. So the
   * mapper is asserted against its own endpoint every time, rather than
   * trusted to ride along on the client body. Miss this and the failure is
   * the confusing one: the client looks fully configured and the `groups`
   * claim simply is not in the token.
   */
  async assertGroupMembershipMapper(uuid: string): Promise<void> {
    const res = await this.request('GET', `/clients/${uuid}/protocol-mappers/models`)
    await this.assertOk(res, { resource: 'keycloak client', id: uuid })
    const existing = (await res.json()) as { name: string }[]
    if (existing.some((mapper) => mapper.name === GROUP_MEMBERSHIP_MAPPER.name)) {
      return
    }
    const created = await this.request(
      'POST',
      `/clients/${uuid}/protocol-mappers/models`,
      GROUP_MEMBERSHIP_MAPPER,
    )
    await this.assertOk(created, { resource: 'keycloak client', id: uuid })
  }

  /**
   * Mints a NEW secret, invalidating the previous one. The value is returned
   * to exactly one caller and retained nowhere -- not in sso_apps, not in the
   * outbox, not in the audit snapshot, not in a log line. Same rule the Google
   * connector's one-time bootstrap password states: generate it, transmit it
   * once, retain nothing.
   */
  async mintClientSecret(uuid: string): Promise<string> {
    const res = await this.request('POST', `/clients/${uuid}/client-secret`)
    await this.assertOk(res, { resource: 'keycloak client', id: uuid })
    const body = (await res.json()) as { value?: string }
    if (body.value === undefined || body.value.length === 0) {
      throw new Error(`Keycloak returned no secret value for client ${uuid}`)
    }
    return body.value
  }
}

/** Keycloak's create endpoints return 201 with no body — just a `Location: .../<id>` header. */
function idFromLocation(res: Response): string | undefined {
  return res.headers.get('location')?.split('/').pop()
}
