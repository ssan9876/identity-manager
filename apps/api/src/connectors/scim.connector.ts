import { Injectable } from '@nestjs/common'
import type {
  ConnectorHealth,
  ConnectorOperation,
  DesiredUser,
  DirectoryConnector,
} from './connector'
import { resolveSecret } from './secrets'

/**
 * SCIM 2.0 (RFC 7643 schema / RFC 7644 protocol) — ONE adapter serving EVERY
 * SCIM-speaking target in the catalog (`scim_slack`, `scim_zoom`,
 * `scim_atlassian`, `scim_box`, `scim_snowflake`, `scim_generic`). Those are
 * six distinct `outbox_target` values, each with its own
 * `connector_targets` row, its own credential, its own attribute mappings and
 * its own enable/disable and blast-radius settings — but exactly one class,
 * because the PROTOCOL is the same and only the base URL, the credential and
 * the write mode differ.
 *
 * WHY SLOTS RATHER THAN INSTANCES. `connector_targets`'s primary key is
 * (organization_id, target) and `external_identities` is unique per
 * (user_id, system), so "one configured instance per target value" is a
 * load-bearing invariant of the whole outbox/correlation design, not an
 * accident. Naming each SCIM application as its own target value is what lets
 * an organization provision Slack AND Zoom AND Box without touching that
 * invariant. Adding a seventh is a migration widening two pgEnums plus one
 * line in `ConnectorRegistry` and one in the console's field catalog — no new
 * adapter logic at all.
 *
 * GROUPS ARE FLAT HERE, DELIBERATELY. This implements `DirectoryConnector`
 * and NOT the optional `DirectoryGroupConnector`, exactly like
 * `KeycloakConnector`/`EntraIdConnector`/`GoogleWorkspaceConnector`:
 * membership is asserted from `DesiredUser.groups` inside `apply()`, one
 * remote SCIM group per local group. RFC 7643 §4.2 does permit a Group
 * member to be another Group, but that capability exists to be advertised —
 * and the mainstream SCIM services these slots target do not implement it.
 * `DirectoryGroupConnector`'s own doc comment sets the bar for implementing
 * it as "a target with a genuine native group-nesting concept worth
 * preserving"; a target that would reject a nested member reference does not
 * clear that bar, and pretending otherwise would produce group writes that
 * fail at apply time rather than a flattened membership that is correct.
 *
 * NEVER SENDS A USER CREDENTIAL, with no exception to flag. Unlike Microsoft
 * Graph — whose `POST /users` documents `passwordProfile` as REQUIRED, the
 * conflict `EntraIdConnector.apply` had to flag at length — RFC 7643 §4.1.1
 * makes `password` an ordinary optional attribute, so a SCIM user is created
 * without one and this connector has no code path that can send, generate or
 * store a password for the person being provisioned. The service's OWN
 * credential (bearer token or OAuth2 client secret) is a service-level
 * secret, resolved by NAME through `secrets.ts` like every other connector's.
 *
 * NO DELETE. RFC 7644 §3.6 defines `DELETE /Users/{id}` and this connector
 * deliberately has no code path that emits it — `disable` sets `active:
 * false` and nothing else. Per `DirectoryConnector`'s standing rule, removing
 * the capability is what removes the class of disaster.
 *
 * CONNECTION DISCIPLINE: no database access in any interface method. Config
 * is bound by `ConnectorRegistry.resolve` before any of them is called, and
 * the ONE long-lived instance is rebound per resolve() via `configure` — the
 * same shape every other real target uses. Reading `process.env` for secret
 * resolution is fine and expected; a second pool connection is what is
 * forbidden.
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_MAX_THROTTLE_RETRIES = 3
const DEFAULT_MAX_THROTTLE_WAIT_MS = 30_000
const DEFAULT_PAGE_SIZE = 100

/** RFC 7643 §8.7.1 / §4.3 / §4.2 and RFC 7644 §3.5.2 — the schema URIs this connector sends and matches on. */
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User'
const ENTERPRISE_USER_SCHEMA = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group'
const PATCH_OP_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp'

/**
 * How this target accepts a modification.
 *
 * `patch` (RFC 7644 §3.5.2) is the default and the only mode that can express
 * "change these attributes and leave everything else alone". `put` (§3.5.1)
 * replaces the whole resource and exists because PATCH is an OPTIONAL feature
 * a service advertises in `/ServiceProviderConfig` — a service that does not
 * implement it would reject every write this connector makes.
 */
export type ScimWriteMode = 'patch' | 'put'

/**
 * `connector_targets.config` for any `scim_*` target — the NON-SECRET half
 * (decision 4: a secret's NAME lives here, never its value). Parsed per call
 * by `parseScimConfig`, mirroring `parseEntraConfig`/`parseAdConfig` and the
 * same "clean, actionable error, never a guess" posture.
 */
export interface ScimConnectorConfig {
  /** The SCIM service root, e.g. `https://api.slack.com/scim/v2`. A trailing slash is trimmed; `/Users` and `/Groups` are appended to it. */
  baseUrl: string
  /**
   * Names the environment variable holding a STATIC bearer token. Used when
   * `tokenUrl` is absent — the common case, and what Slack, Zoom, Box and
   * Snowflake all issue. Exactly one of this and the OAuth2 trio below must
   * be configured.
   */
  tokenSecretName: string | null
  /** OAuth2 client-credentials token endpoint, for services that mint short-lived tokens instead of issuing a static one. Absent means static-bearer mode. */
  tokenUrl: string | null
  /** OAuth2 client id — required when `tokenUrl` is set. */
  clientId: string | null
  /** Names the environment variable holding the OAuth2 client secret — required when `tokenUrl` is set. Never a value stored here. */
  clientSecretName: string | null
  /** Optional OAuth2 scope string. */
  scope: string | null
  writeMode: ScimWriteMode
  /** Per-HTTP-call timeout via AbortController — guards against a hung target holding the sync worker's open transaction open indefinitely. */
  requestTimeoutMs: number
  maxThrottleRetries: number
  maxThrottleWaitMs: number
  /** `count` for paged reads (RFC 7644 §3.4.2.4). */
  pageSize: number
}

function optionalString(config: Record<string, unknown>, key: string): string | null {
  const value = config[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function optionalNumber(config: Record<string, unknown>, key: string): number | undefined {
  const value = config[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Parses and validates raw `connector_targets.config` JSON. Deliberately not
 * called from `configure()` — only from a method about to genuinely need a
 * valid config, mirroring `EntraIdConnector.parsedConfig`, so merely
 * resolving an unconfigured target never throws.
 */
export function parseScimConfig(config: Record<string, unknown>): ScimConnectorConfig {
  const baseUrl = optionalString(config, 'baseUrl')
  if (baseUrl === null) {
    throw new Error('ScimConnector: connector_targets.config.baseUrl is required and must be a non-empty string')
  }

  const tokenSecretName = optionalString(config, 'tokenSecretName')
  const tokenUrl = optionalString(config, 'tokenUrl')
  const clientId = optionalString(config, 'clientId')
  const clientSecretName = optionalString(config, 'clientSecretName')

  // Exactly one auth mode. Accepting both would leave which credential is
  // actually in use decided by this function's internal ordering rather than
  // by what an operator configured; accepting neither would fail later, at
  // the first request, with a less actionable message.
  if (tokenUrl === null && tokenSecretName === null) {
    throw new Error(
      'ScimConnector: connector_targets.config needs either tokenSecretName (static bearer) or tokenUrl + clientId + clientSecretName (OAuth2 client credentials)',
    )
  }
  if (tokenUrl !== null && (clientId === null || clientSecretName === null)) {
    throw new Error('ScimConnector: connector_targets.config.tokenUrl requires clientId and clientSecretName')
  }
  if (tokenUrl !== null && tokenSecretName !== null) {
    throw new Error(
      'ScimConnector: connector_targets.config sets both tokenSecretName and tokenUrl — configure exactly one authentication mode',
    )
  }

  const rawWriteMode = optionalString(config, 'writeMode') ?? 'patch'
  if (rawWriteMode !== 'patch' && rawWriteMode !== 'put') {
    throw new Error(`ScimConnector: connector_targets.config.writeMode must be "patch" or "put", got "${rawWriteMode}"`)
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    tokenSecretName,
    tokenUrl,
    clientId,
    clientSecretName,
    scope: optionalString(config, 'scope'),
    writeMode: rawWriteMode,
    requestTimeoutMs: optionalNumber(config, 'requestTimeoutMs') ?? DEFAULT_REQUEST_TIMEOUT_MS,
    maxThrottleRetries: optionalNumber(config, 'maxThrottleRetries') ?? DEFAULT_MAX_THROTTLE_RETRIES,
    maxThrottleWaitMs: optionalNumber(config, 'maxThrottleWaitMs') ?? DEFAULT_MAX_THROTTLE_WAIT_MS,
    pageSize: optionalNumber(config, 'pageSize') ?? DEFAULT_PAGE_SIZE,
  }
}

/**
 * Any SCIM/token-endpoint failure not otherwise handled. Deliberately NOT a
 * DomainError subclass, mirroring `EntraGraphError`/`KeycloakAdminError`: an
 * operational fact the sync worker retries, never something this API rewrites
 * into a client-facing 4xx. `message` is built ONLY from the target's own
 * response, never from anything this connector SENT, so it can never echo
 * back a credential.
 */
export class ScimError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ScimError'
  }
}

/** Thrown when throttling retries are exhausted while honouring every `Retry-After` — bounded rather than "retry forever", same reasoning as `EntraGraphThrottledError`. */
export class ScimThrottledError extends Error {
  constructor(
    public readonly lastStatus: number,
    public readonly attempts: number,
  ) {
    super(
      `the SCIM service throttled this request ${attempts} time(s) (last status ${lastStatus}); Retry-After was honoured every time, but the configured retry limit was reached — the outer sync will retry later via its own backoff`,
    )
    this.name = 'ScimThrottledError'
  }
}

/**
 * RFC 7644 §3.12 error response, reduced to a short, safe sentence. Reads
 * only the target's own body; a body that is not the documented shape (an
 * HTML error page from a proxy, say) degrades to its own status text rather
 * than being echoed wholesale.
 */
async function describeScimError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown; scimType?: unknown }
    const detail = typeof body.detail === 'string' ? body.detail : null
    const scimType = typeof body.scimType === 'string' ? body.scimType : null
    if (detail !== null) return scimType !== null ? `${scimType}: ${detail}` : detail
  } catch {
    // fall through
  }
  return res.statusText || 'no detail provided'
}

/** RFC 7644 §3.4.2.2 — a filter's string literal is double-quoted, so an embedded quote or backslash must be escaped or the filter is malformed (and, against a permissive service, alterable by a crafted username). */
export function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Splits a SCIM attribute path into the object segments a POST/PUT body needs.
 *
 * A plain path splits on dots: `name.givenName` -> `['name', 'givenName']`.
 *
 * A fully-qualified EXTENSION path (RFC 7644 §3.10) is
 * `<schema-urn>:<attribute>[.<sub-attribute>]` — the URN and the attribute are
 * separated by a COLON, and RFC 7643 §3.3 puts the extension under its URN as
 * a single top-level key. Splitting such a path on dots alone is WRONG and
 * silently so: the standard enterprise URN
 * `urn:ietf:params:scim:schemas:extension:enterprise:2.0:User` contains `2.0`,
 * so a naive dot-split shears it into `...enterprise:2` and `0:User` and the
 * attribute lands under two nonsense keys that the service either rejects or,
 * worse, stores. The URN is therefore taken whole, up to its LAST colon, and
 * only the remainder is dot-split.
 */
function splitScimPath(path: string): string[] {
  const extension = /^(urn:.+):([^:]+)$/.exec(path)
  if (extension !== null) {
    return [extension[1]!, ...extension[2]!.split('.')]
  }
  return path.split('.')
}

/**
 * Writes `value` at a SCIM attribute path into a nested object, creating
 * intermediate objects as needed — `name.givenName` becomes
 * `{ name: { givenName } }`, which is what POST and PUT bodies require. See
 * `splitScimPath` for how an extension URN is kept intact.
 *
 * Prototype safety is enforced by REFUSING the three polluting segment names
 * outright rather than by null-prototyping every intermediate: these objects
 * are handed to `JSON.stringify`, which ignores inherited properties anyway,
 * so the only real hazard is an admin-configured remote name mutating
 * `Object.prototype` during the build.
 */
export function setScimPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = splitScimPath(path)
  let current = target
  for (const [index, segment] of segments.entries()) {
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
      throw new Error(`ScimConnector: refusing attribute path segment "${segment}" in "${path}"`)
    }
    if (index === segments.length - 1) {
      current[segment] = value
      return
    }
    const next = current[segment]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      const created: Record<string, unknown> = {}
      current[segment] = created
      current = created
    } else {
      current = next as Record<string, unknown>
    }
  }
}

interface ScimResource {
  id: string
  [key: string]: unknown
}

interface ScimListResponse {
  Resources?: unknown
  totalResults?: unknown
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Same `Retry-After` handling as `EntraIdConnector.parseRetryAfterMs` — seconds, or an HTTP-date, or nothing. */
export function parseScimRetryAfterMs(headerValue: string | null, fallbackMs = 1000): number {
  if (headerValue === null) return fallbackMs
  const seconds = Number(headerValue)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(headerValue)
  if (Number.isFinite(at)) return Math.max(0, at - Date.now())
  return fallbackMs
}

@Injectable()
export class ScimConnector implements DirectoryConnector {
  private rawConfig: Record<string, unknown> = {}
  private cachedToken: { value: string; expiresAt: number } | null = null
  /** What the cached token was minted FOR. A rebind to another slot's config must not reuse the previous slot's token — the same re-validation `EntraIdConnector.getToken` performs. */
  private cachedTokenIdentity: string | null = null

  /** Rebinds this one long-lived instance to a freshly-read config snapshot and returns `this` — the shape every real target's factory uses (see `ConnectorRegistry`). */
  configure(config: Record<string, unknown>): this {
    this.rawConfig = config
    return this
  }

  private parsedConfig(): ScimConnectorConfig {
    return parseScimConfig(this.rawConfig)
  }

  async plan(desired: DesiredUser): Promise<ConnectorOperation[]> {
    const existing = await this.findExisting(desired)
    const operations: ConnectorOperation[] = []

    if (existing === null) {
      operations.push({
        kind: 'create',
        description: `create SCIM user "${desired.username}" (${desired.email}), active=${desired.enabled}`,
      })
    } else {
      operations.push({
        kind: 'update',
        description: `update SCIM user "${desired.username}" (id ${existing.id}), active=${desired.enabled}`,
      })
      const clearing = this.clearCandidates(desired)
      if (clearing.length > 0) {
        operations.push({
          kind: 'update',
          description: `clear no-longer-mapped attribute(s): ${clearing.join(', ')}`,
        })
      }
    }

    for (const group of desired.groups) {
      operations.push({ kind: 'update', description: `ensure membership of SCIM group "${group}"` })
    }
    return operations
  }

  async apply(desired: DesiredUser): Promise<{ externalId: string }> {
    const existing = await this.findExisting(desired)

    if (existing === null) {
      // No `password`, deliberately and without exception — see this class's
      // own doc comment. RFC 7643 §4.1.1 makes it optional, so unlike the
      // Graph adapter there is nothing to flag here.
      const body: Record<string, unknown> = {
        schemas: [USER_SCHEMA, ENTERPRISE_USER_SCHEMA],
        userName: desired.username,
        active: desired.enabled,
        name: { givenName: desired.firstName, familyName: desired.lastName },
        displayName: `${desired.firstName} ${desired.lastName}`.trim(),
        emails: [{ value: desired.email, type: 'work', primary: true }],
      }
      for (const [path, value] of this.mappedAttributeEntries(desired)) {
        setScimPath(body, path, value)
      }

      const res = await this.scimRequest('POST', '/Users', body)
      if (!res.ok) {
        throw new ScimError(
          res.status,
          `ScimConnector.apply (create "${desired.username}"): ${res.status} ${await describeScimError(res)}`,
        )
      }
      const created = (await res.json()) as ScimResource
      if (typeof created.id !== 'string' || created.id === '') {
        throw new ScimError(res.status, `ScimConnector.apply (create "${desired.username}"): response carried no id`)
      }
      await this.reconcileGroups(created.id, desired.groups)
      return { externalId: created.id }
    }

    await this.writeExisting(existing, desired)
    await this.reconcileGroups(existing.id, desired.groups)
    return { externalId: existing.id }
  }

  /**
   * The ONLY removal-shaped operation, per `DirectoryConnector`'s standing
   * rule. `active: false` and nothing else — never `DELETE /Users/{id}`,
   * which RFC 7644 §3.6 defines and this connector deliberately cannot emit.
   *
   * Takes only the target's own immutable id, so it stays callable when the
   * rest of the desired state is unavailable. A 404 is treated as success:
   * the post-condition ("this principal is not active in the target") already
   * holds, and failing here would dead-letter an offboarding that has in fact
   * completed.
   */
  async disable(externalId: string): Promise<void> {
    const config = this.parsedConfig()
    const path = `/Users/${encodeURIComponent(externalId)}`

    const res =
      config.writeMode === 'patch'
        ? await this.scimRequest('PATCH', path, {
            schemas: [PATCH_OP_SCHEMA],
            Operations: [{ op: 'replace', path: 'active', value: false }],
          })
        : await this.scimRequest('PUT', path, await this.putBodyForDisable(externalId))

    if (res.status === 404) return
    if (!res.ok) {
      throw new ScimError(res.status, `ScimConnector.disable (${externalId}): ${res.status} ${await describeScimError(res)}`)
    }
  }

  /** Can we reach and authenticate to this target right now. Never throws — an unconfigured target or a missing secret resolves to `{ ok: false }` with an actionable, secret-VALUE-free message. */
  async health(): Promise<ConnectorHealth> {
    let config: ScimConnectorConfig
    try {
      config = this.parsedConfig()
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'invalid configuration' }
    }

    try {
      // RFC 7644 §4 — the one endpoint every compliant service exposes, and
      // the one that says what it supports rather than returning people.
      const res = await this.scimRequest('GET', '/ServiceProviderConfig')
      if (!res.ok) {
        return {
          ok: false,
          detail: `SCIM service at ${config.baseUrl} responded ${res.status} to /ServiceProviderConfig: ${await describeScimError(res)}`,
        }
      }
      return { ok: true, detail: `reachable and authenticated at ${config.baseUrl}` }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'unreachable' }
    }
  }

  // -------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------

  /**
   * Re-identifies this principal by IMMUTABLE id first (RFC 7643 §3.1 — `id`
   * is service-assigned and immutable), falling back to a `userName` filter
   * only when no prior correlation exists. That order is the whole point:
   * `userName` is mutable here exactly as a UPN or primary email is
   * elsewhere, so correlating on it would mint a duplicate account the first
   * time someone is renamed. See `DesiredUser.existingExternalId`.
   *
   * A stored id the service no longer recognises (404) falls through to the
   * filter rather than failing — self-healing, and the same posture the other
   * immutable-id targets take.
   */
  private async findExisting(desired: DesiredUser): Promise<ScimResource | null> {
    if (desired.existingExternalId !== undefined && desired.existingExternalId !== '') {
      const res = await this.scimRequest('GET', `/Users/${encodeURIComponent(desired.existingExternalId)}`)
      if (res.ok) return (await res.json()) as ScimResource
      if (res.status !== 404) {
        throw new ScimError(
          res.status,
          `ScimConnector.findExisting (id ${desired.existingExternalId}): ${res.status} ${await describeScimError(res)}`,
        )
      }
    }

    const filter = `userName eq "${escapeFilterValue(desired.username)}"`
    const res = await this.scimRequest('GET', `/Users?filter=${encodeURIComponent(filter)}`)
    if (!res.ok) {
      throw new ScimError(
        res.status,
        `ScimConnector.findExisting (userName "${desired.username}"): ${res.status} ${await describeScimError(res)}`,
      )
    }
    const resources = readResources(await res.json())
    return resources[0] ?? null
  }

  /** UPDATE path — PATCH (default) or PUT, per `writeMode`. */
  private async writeExisting(existing: ScimResource, desired: DesiredUser): Promise<void> {
    const config = this.parsedConfig()
    const path = `/Users/${encodeURIComponent(existing.id)}`

    if (config.writeMode === 'put') {
      // PUT replaces the whole resource, so it self-clears: an attribute
      // simply omitted is gone. `clearCandidates` is therefore irrelevant
      // here — the same reasoning Keycloak's "send the whole map" semantics
      // already get for free.
      const body: Record<string, unknown> = {
        ...existing,
        schemas: [USER_SCHEMA, ENTERPRISE_USER_SCHEMA],
        userName: desired.username,
        active: desired.enabled,
        name: { givenName: desired.firstName, familyName: desired.lastName },
        displayName: `${desired.firstName} ${desired.lastName}`.trim(),
        emails: [{ value: desired.email, type: 'work', primary: true }],
      }
      for (const remoteName of this.clearCandidates(desired)) {
        deleteScimPath(body, remoteName)
      }
      for (const [attrPath, value] of this.mappedAttributeEntries(desired)) {
        setScimPath(body, attrPath, value)
      }
      const res = await this.scimRequest('PUT', path, body)
      if (!res.ok) {
        throw new ScimError(
          res.status,
          `ScimConnector.apply (replace "${desired.username}"): ${res.status} ${await describeScimError(res)}`,
        )
      }
      return
    }

    // PATCH only touches paths named in the request — the same partial-update
    // clearing gap Graph's PATCH and the Admin SDK's update both have (see
    // `DesiredUser.managedAttributeRemoteNames`). So a remote name that USED
    // to be mapped and no longer is must be actively removed, not merely left
    // out: RFC 7644 §3.5.2.2 defines `remove` for exactly this.
    const operations: Array<Record<string, unknown>> = [
      { op: 'replace', path: 'userName', value: desired.username },
      { op: 'replace', path: 'active', value: desired.enabled },
      { op: 'replace', path: 'name.givenName', value: desired.firstName },
      { op: 'replace', path: 'name.familyName', value: desired.lastName },
      { op: 'replace', path: 'displayName', value: `${desired.firstName} ${desired.lastName}`.trim() },
      { op: 'replace', path: 'emails[type eq "work"].value', value: desired.email },
    ]
    for (const [attrPath, value] of this.mappedAttributeEntries(desired)) {
      operations.push({ op: 'replace', path: attrPath, value })
    }
    // Only paths the target ACTUALLY HOLDS a value at. RFC 7644 §3.5.2.2
    // lets a service reject a `remove` whose path matches nothing with a
    // `noTarget` 400, and a strict one does — which would fail the whole
    // sync for a user who simply never had the attribute set. The existing
    // resource is already in hand, so this is a filter, not an extra read.
    for (const remoteName of this.clearCandidates(desired)) {
      if (readScimPath(existing, remoteName) === undefined) continue
      operations.push({ op: 'remove', path: remoteName })
    }

    const res = await this.scimRequest('PATCH', path, { schemas: [PATCH_OP_SCHEMA], Operations: operations })
    if (!res.ok) {
      throw new ScimError(
        res.status,
        `ScimConnector.apply (update "${desired.username}"): ${res.status} ${await describeScimError(res)}`,
      )
    }
  }

  /** The current resource, with `active` forced false — only needed in `put` mode, where there is no way to change one field in isolation. */
  private async putBodyForDisable(externalId: string): Promise<Record<string, unknown>> {
    const res = await this.scimRequest('GET', `/Users/${encodeURIComponent(externalId)}`)
    if (!res.ok) {
      throw new ScimError(res.status, `ScimConnector.disable (read ${externalId}): ${res.status} ${await describeScimError(res)}`)
    }
    const current = (await res.json()) as ScimResource
    return { ...current, schemas: [USER_SCHEMA], active: false }
  }

  /**
   * The mapped attributes to WRITE, as [remote path, single value] pairs.
   * `DesiredUser.attributes` is already filtered to this target's own enabled
   * mappings by `SyncWorker`, so nothing here decides what should propagate —
   * only how a multi-valued local attribute lands on a single-valued SCIM
   * one. First value wins, matching `EntraIdConnector.buildAttributePayload`.
   */
  private mappedAttributeEntries(desired: DesiredUser): Array<[string, string]> {
    const entries: Array<[string, string]> = []
    for (const [remoteName, values] of Object.entries(desired.attributes)) {
      if (values.length > 0) entries.push([remoteName, values[0]!])
    }
    return entries
  }

  /**
   * Remote names this target is MANAGING that carry no value this time —
   * exactly the gap `managedAttributeRemoteNames` exists for. Empty when the
   * worker did not populate that field, so a target outside
   * `TARGETS_NEEDING_MANAGED_ATTRIBUTE_NAMES` degrades to "never clears"
   * rather than to "clears everything".
   */
  private clearCandidates(desired: DesiredUser): string[] {
    if (desired.managedAttributeRemoteNames === undefined) return []
    const carrying = new Set(this.mappedAttributeEntries(desired).map(([path]) => path))
    return desired.managedAttributeRemoteNames.filter((name) => !carrying.has(name))
  }

  // -------------------------------------------------------------------
  // Groups — flat membership, one remote group per local group. See this
  // class's own doc comment for why nesting is deliberately not attempted.
  // -------------------------------------------------------------------

  private async reconcileGroups(userId: string, desiredGroupNames: readonly string[]): Promise<void> {
    const desiredNames = new Set(desiredGroupNames)
    const current = await this.currentGroupsFor(userId)
    const currentNames = new Set(current.map((group) => group.displayName))

    for (const name of desiredNames) {
      if (!currentNames.has(name)) {
        await this.addMember(await this.ensureGroup(name), userId)
      }
    }
    // Membership this system no longer asserts is removed — reconcile to
    // desired state, never a one-way add (the same rule every other target
    // follows). A group this system does not manage at all never appears in
    // `desired.groups`, so this only ever removes what it once added.
    for (const group of current) {
      if (!desiredNames.has(group.displayName)) {
        await this.removeMember(group.id, userId)
      }
    }
  }

  private async currentGroupsFor(userId: string): Promise<Array<{ id: string; displayName: string }>> {
    const filter = `members.value eq "${escapeFilterValue(userId)}"`
    const res = await this.scimRequest('GET', `/Groups?filter=${encodeURIComponent(filter)}`)
    if (!res.ok) {
      throw new ScimError(res.status, `ScimConnector.currentGroupsFor (${userId}): ${res.status} ${await describeScimError(res)}`)
    }
    return readResources(await res.json())
      .map((resource) => ({
        id: resource.id,
        displayName: typeof resource.displayName === 'string' ? resource.displayName : '',
      }))
      .filter((group) => group.displayName !== '')
  }

  /** Finds a group by display name, creating it when absent — the same ensure-then-use shape `KeycloakConnector.ensureGroup` and `EntraIdConnector.ensureGroup` use. */
  private async ensureGroup(name: string): Promise<string> {
    const filter = `displayName eq "${escapeFilterValue(name)}"`
    const found = await this.scimRequest('GET', `/Groups?filter=${encodeURIComponent(filter)}`)
    if (!found.ok) {
      throw new ScimError(found.status, `ScimConnector.ensureGroup (find "${name}"): ${found.status} ${await describeScimError(found)}`)
    }
    const existing = readResources(await found.json())[0]
    if (existing !== undefined) return existing.id

    const created = await this.scimRequest('POST', '/Groups', { schemas: [GROUP_SCHEMA], displayName: name })
    if (!created.ok) {
      throw new ScimError(
        created.status,
        `ScimConnector.ensureGroup (create "${name}"): ${created.status} ${await describeScimError(created)}`,
      )
    }
    const body = (await created.json()) as ScimResource
    if (typeof body.id !== 'string' || body.id === '') {
      throw new ScimError(created.status, `ScimConnector.ensureGroup (create "${name}"): response carried no id`)
    }
    return body.id
  }

  private async addMember(groupId: string, userId: string): Promise<void> {
    const res = await this.scimRequest('PATCH', `/Groups/${encodeURIComponent(groupId)}`, {
      schemas: [PATCH_OP_SCHEMA],
      Operations: [{ op: 'add', path: 'members', value: [{ value: userId }] }],
    })
    if (!res.ok) {
      throw new ScimError(res.status, `ScimConnector.addMember (${userId} -> ${groupId}): ${res.status} ${await describeScimError(res)}`)
    }
  }

  private async removeMember(groupId: string, userId: string): Promise<void> {
    const res = await this.scimRequest('PATCH', `/Groups/${encodeURIComponent(groupId)}`, {
      schemas: [PATCH_OP_SCHEMA],
      Operations: [{ op: 'remove', path: `members[value eq "${escapeFilterValue(userId)}"]` }],
    })
    // A membership that is already gone is the post-condition this call
    // wanted; 404 must not fail the whole reconcile.
    if (res.status === 404) return
    if (!res.ok) {
      throw new ScimError(
        res.status,
        `ScimConnector.removeMember (${userId} from ${groupId}): ${res.status} ${await describeScimError(res)}`,
      )
    }
  }

  // -------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------

  private async scimRequest(method: string, path: string, body?: unknown): Promise<Response> {
    const config = this.parsedConfig()
    const url = path.startsWith('https://') ? path : `${config.baseUrl}${path}`

    let refreshedTokenOnce = false
    let throttleAttempts = 0
    let token = await this.getToken(false)

    for (;;) {
      const res = await this.timedFetch(url, config, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/scim+json, application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/scim+json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })

      if (res.status === 429 || res.status === 503) {
        if (throttleAttempts >= config.maxThrottleRetries) {
          throw new ScimThrottledError(res.status, throttleAttempts)
        }
        throttleAttempts += 1
        await res.body?.cancel().catch(() => undefined)
        const waitMs = Math.min(parseScimRetryAfterMs(res.headers.get('retry-after')), config.maxThrottleWaitMs)
        await sleep(waitMs)
        continue
      }

      // A static bearer cannot be refreshed, so only the OAuth2 mode retries
      // a 401 — otherwise this would burn a second identical request on every
      // genuinely-unauthorized call.
      if (res.status === 401 && !refreshedTokenOnce && config.tokenUrl !== null) {
        refreshedTokenOnce = true
        await res.body?.cancel().catch(() => undefined)
        token = await this.getToken(true)
        continue
      }

      return res
    }
  }

  /**
   * The credential in use, per mode. A static bearer is read fresh from the
   * environment each time (no caching to invalidate). An OAuth2 token is
   * cached with a 60-second safety margin and RE-VALIDATED against the
   * currently-bound config's identity, so rebinding this shared instance to
   * another slot can never reuse the previous slot's token — the identical
   * hazard `EntraIdConnector.getToken` guards.
   */
  private async getToken(forceRefresh: boolean): Promise<string> {
    const config = this.parsedConfig()

    if (config.tokenUrl === null) {
      // `tokenSecretName` is non-null whenever `tokenUrl` is null — parseScimConfig rejects the case where neither is set.
      return resolveSecret(config.tokenSecretName!)
    }

    const identity = `${config.tokenUrl}|${config.clientId}|${config.clientSecretName}|${config.scope ?? ''}`
    if (
      !forceRefresh &&
      this.cachedToken !== null &&
      this.cachedTokenIdentity === identity &&
      this.cachedToken.expiresAt > Date.now()
    ) {
      return this.cachedToken.value
    }

    const secret = resolveSecret(config.clientSecretName!)
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.clientId!,
      client_secret: secret,
    })
    if (config.scope !== null) params.set('scope', config.scope)

    const res = await this.timedFetch(config.tokenUrl, config, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    if (!res.ok) {
      // Names the endpoint and the status only — never the request body,
      // which holds the client secret.
      throw new ScimError(res.status, `ScimConnector: token endpoint responded ${res.status}`)
    }
    const payload = (await res.json()) as { access_token?: unknown; expires_in?: unknown }
    if (typeof payload.access_token !== 'string' || payload.access_token === '') {
      throw new ScimError(res.status, 'ScimConnector: token endpoint returned no access_token')
    }
    const expiresInSeconds = typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in) ? payload.expires_in : 3600
    this.cachedToken = { value: payload.access_token, expiresAt: Date.now() + Math.max(0, expiresInSeconds - 60) * 1000 }
    this.cachedTokenIdentity = identity
    return this.cachedToken.value
  }

  private async timedFetch(url: string, config: ScimConnectorConfig, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs)
    try {
      return await fetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }
}

/** RFC 7644 §3.4.2 ListResponse -> the resources with a usable `id`. A body that is not a ListResponse yields nothing rather than throwing: callers treat "no match" as a normal outcome. */
function readResources(payload: unknown): ScimResource[] {
  const list = payload as ScimListResponse | null
  if (list === null || typeof list !== 'object' || !Array.isArray(list.Resources)) return []
  return list.Resources.filter(
    (resource): resource is ScimResource =>
      typeof resource === 'object' && resource !== null && typeof (resource as { id?: unknown }).id === 'string',
  )
}

/** Reads the value at a SCIM attribute path, or `undefined` when any segment is absent. Own properties only, same discipline as `setScimPath`. */
function readScimPath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source
  for (const segment of splitScimPath(path)) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    if (!Object.hasOwn(current, segment)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Removes a dotted path from a PUT body — the `put`-mode counterpart of PATCH's `remove` op. Absent intermediate objects are a no-op, never an error. */
function deleteScimPath(target: Record<string, unknown>, path: string): void {
  const segments = splitScimPath(path)
  let current: Record<string, unknown> = target
  for (let index = 0; index < segments.length - 1; index += 1) {
    const next = current[segments[index]!]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return
    current = next as Record<string, unknown>
  }
  delete current[segments[segments.length - 1]!]
}
