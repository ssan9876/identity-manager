import { Inject, Injectable } from '@nestjs/common'
import type { AttributeDefinition } from '../attributes/attribute-validator'
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
 * Only the fields `buildSyncedAttributes` needs — deliberately narrower than
 * the full `AttributeDefinition` (which also carries `dataType`,
 * `validationRules`, etc., none of which this client cares about). Every
 * real call site has a full `AttributeDefinition[]` on hand already (e.g.
 * `UsersRepository.listActiveAttributeDefinitions`) and can pass it straight
 * through — `Pick<...>` accepts that without requiring a caller to
 * re-shape anything.
 */
export type SyncableAttributeDefinition = Pick<AttributeDefinition, 'key' | 'syncToKeycloak'>

const REQUIRED_ACTION_UPDATE_PASSWORD = 'UPDATE_PASSWORD'

// Refresh the cached token this long before its real expiry, so a request
// that starts a moment before expiry doesn't race a token that dies
// mid-flight. Capped at half the token's own lifetime so a very short-lived
// token (e.g. a misconfigured realm) never computes a non-positive TTL.
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 10_000

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

  // Object.create(null), not {} — sweep from docs/superpowers/audit-
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

  constructor(@Inject(KEYCLOAK_ADMIN_CONFIG) private readonly config: KeycloakAdminClientConfig) {
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
    this.adminBaseUrl = `${serverRoot}/admin/realms/${realm}`
  }

  // ---------------------------------------------------------------------
  // Token handling: client-credentials grant, cached until shortly before
  // expiry, forced refresh on a 401 from any admin call (see `request`).
  // ---------------------------------------------------------------------

  private async fetchToken(): Promise<{ value: string; expiresAt: number }> {
    const requestedAt = Date.now()
    const res = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }),
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
}

/** Keycloak's create endpoints return 201 with no body — just a `Location: .../<id>` header. */
function idFromLocation(res: Response): string | undefined {
  return res.headers.get('location')?.split('/').pop()
}
