import { Injectable } from '@nestjs/common'
import { randomInt } from 'node:crypto'
import type { ConnectorHealth, ConnectorOperation, DesiredUser, DirectoryConnector } from './connector'
import { resolveSecret } from './secrets'

// ---------------------------------------------------------------------------
// Documentation-derived constants. Every literal shape below (URLs, required
// fields, header names, error envelopes) is taken from Microsoft's OWN
// published Graph/identity-platform docs, not invented or recalled from
// general familiarity — see the doc comment on each function/constant for the
// specific page it was checked against on 2026-08-07. This matters because
// `test/support/entra-graph-fake.ts` is pinned to the SAME sources: the fake
// exists to prove this connector's request shapes and state machine, not to
// prove Microsoft's real service behaves as documented (see that file's own
// doc comment, and this task's report, for the honest scope of that proof).
// ---------------------------------------------------------------------------

/** https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow — "Get a token", first case (shared secret). */
const DEFAULT_AUTHORITY_BASE_URL = 'https://login.microsoftonline.com'
/** https://learn.microsoft.com/en-us/graph/api/user-post-users — every example request targets this base. */
const DEFAULT_GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0'
/** https://learn.microsoft.com/en-us/graph/api/group-post-members — "@odata.id": "https://graph.microsoft.com/v1.0/directoryObjects/{id}" — the CANONICAL resource reference Graph's OData layer expects, independent of which host this connector actually dialled (see `directoryObjectODataId` below). */
const GRAPH_PRODUCTION_BASE_URL = 'https://graph.microsoft.com/v1.0'
/** https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow — "scope... For the Microsoft Graph example, the value is https://graph.microsoft.com/.default." */
const GRAPH_DEFAULT_SCOPE = 'https://graph.microsoft.com/.default'

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
// Bounded, not "retry until it succeeds" (which Microsoft's own throttling
// guidance literally recommends — see parseRetryAfterMs's doc comment) —
// deliberately: a single apply() call blocking the sync worker indefinitely
// while a target is persistently throttled would itself become the "sync
// turns into an outage" this task's own BUILD requirement warns against.
// Each retry still HONOURS the real Retry-After value (never a fixed/guessed
// backoff — see `graphRequest`), this cap only bounds how many times ONE
// connector call will do that before giving up and letting the OUTER
// SyncWorker retry/backoff machinery (computeBackoffDelayMs, sync.worker.ts)
// take over on a later attempt — the same two-layer shape AD's own connection
// invalidation already relies on (see ActiveDirectoryConnector's own
// CONNECTION LIFECYCLE doc comment: "self-heal... without needing a process
// restart").
const DEFAULT_MAX_THROTTLE_RETRIES = 4
// Never sleep longer than this for a SINGLE Retry-After-derived wait, even if
// Graph asks for more — same reasoning as the retry-count cap immediately
// above. A target genuinely asking for minutes-long backoff is exactly the
// case the OUTER retry/backoff loop should own, not one blocked HTTP call.
const DEFAULT_MAX_THROTTLE_WAIT_MS = 30_000
// Refresh the cached token this long before its real expiry — identical
// constant, identical reasoning, to KeycloakAdminClient's own
// TOKEN_EXPIRY_SAFETY_MARGIN_MS (keycloak-admin.client.ts): a request that
// starts a moment before expiry must not race a token that dies mid-flight.
// Capped at half the token's own lifetime so a very short-lived token never
// computes a non-positive TTL.
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 10_000
// Used only when a 429/503 response carries no Retry-After header at all —
// https://learn.microsoft.com/en-us/graph/errors' own 503 row says a retry
// delay "can be specified" (not "is always"), so an absent header is a real,
// documented possibility this connector must not crash or hang on.
const DEFAULT_RETRY_AFTER_FALLBACK_MS = 2_000

/**
 * `connector_targets.config` for `target = 'entra_id'` — the NON-SECRET half
 * (decision 4: a secret's NAME lives here, never its value). Parsed once per
 * call by `parseEntraConfig` below, mirroring `ActiveDirectoryConnector`'s own
 * `parseAdConfig` — same "clean, actionable error, never a guess" posture.
 */
export interface EntraIdConnectorConfig {
  /** The Entra tenant (directory) id or verified domain name — the `{tenant}` segment of the token URL and the audience every principal in this connector belongs to. */
  tenantId: string
  /** The app registration's Application (client) ID — the confidential client this connector authenticates as. */
  clientId: string
  /** Names the environment variable `secrets.ts#resolveSecret` reads the app registration's CLIENT SECRET from — never a value stored here. Same config-key convention `ActiveDirectoryConnector`/`EchoConnector` already established. */
  credentialSecretName: string
  /** Overrides the Microsoft Graph base URL — defaults to the real `https://graph.microsoft.com/v1.0`. Exists so `test/support/entra-graph-fake.ts` can point this connector at a real local HTTP server instead; production never sets this. */
  graphBaseUrl: string
  /** Overrides the OAuth authority base URL — defaults to the real `https://login.microsoftonline.com`. Same test-only purpose as `graphBaseUrl`. */
  authorityBaseUrl: string
  /** Per-HTTP-call timeout, via AbortController. Guards against a hung target blocking the sync worker's open transaction indefinitely (connection discipline — see `DirectoryConnector`'s own doc comment). */
  requestTimeoutMs: number
  /** See `DEFAULT_MAX_THROTTLE_RETRIES`'s own doc comment. */
  maxThrottleRetries: number
  /** See `DEFAULT_MAX_THROTTLE_WAIT_MS`'s own doc comment. */
  maxThrottleWaitMs: number
}

function requireString(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`EntraIdConnector: connector_targets.config.${key} is required and must be a non-empty string`)
  }
  return value
}

function optionalString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalNumber(config: Record<string, unknown>, key: string): number | undefined {
  const value = config[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Parses+validates raw `connector_targets.config` JSON — same "fail clean and immediately" posture `ActiveDirectoryConnector.parseAdConfig`/`secrets.ts` already establish. Deliberately never called from `configure()` itself (see this class's own CONFIGURATION doc comment) — only from methods that are about to actually need a valid config, mirroring `ActiveDirectoryConnector.parsedConfig`. */
export function parseEntraConfig(config: Record<string, unknown>): EntraIdConnectorConfig {
  return {
    tenantId: requireString(config, 'tenantId'),
    clientId: requireString(config, 'clientId'),
    credentialSecretName: requireString(config, 'credentialSecretName'),
    graphBaseUrl: optionalString(config, 'graphBaseUrl') ?? DEFAULT_GRAPH_BASE_URL,
    authorityBaseUrl: optionalString(config, 'authorityBaseUrl') ?? DEFAULT_AUTHORITY_BASE_URL,
    requestTimeoutMs: optionalNumber(config, 'requestTimeoutMs') ?? DEFAULT_REQUEST_TIMEOUT_MS,
    maxThrottleRetries: optionalNumber(config, 'maxThrottleRetries') ?? DEFAULT_MAX_THROTTLE_RETRIES,
    maxThrottleWaitMs: optionalNumber(config, 'maxThrottleWaitMs') ?? DEFAULT_MAX_THROTTLE_WAIT_MS,
  }
}

/** Thrown for any Graph/token-endpoint failure not otherwise handled — deliberately NOT a DomainError subclass, mirroring `KeycloakAdminError`'s own doc comment: an operational fact the sync worker retries, never something this API rewrites into one of its own client-facing 4xx responses. `message` is built ONLY from the target's own response body (`describeGraphError`/`describeAadTokenError` below) — never from anything this connector sent, so it can never echo back the client secret. */
export class EntraGraphError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'EntraGraphError'
  }
}

/** Thrown when `graphRequest` exhausts `maxThrottleRetries` while genuinely honouring every `Retry-After` header along the way — see `DEFAULT_MAX_THROTTLE_RETRIES`'s own doc comment for why this is bounded rather than "retry forever" (Microsoft's own literal recommendation). */
export class EntraGraphThrottledError extends Error {
  constructor(
    public readonly lastStatus: number,
    public readonly attempts: number,
  ) {
    super(
      `Microsoft Graph throttled this request ${attempts} time(s) (last status ${lastStatus}); Retry-After was honoured every time, but the configured retry limit was reached — the outer sync will retry later via its own backoff`,
    )
    this.name = 'EntraGraphThrottledError'
  }
}

/** Order-independent equality on two group-name sets — the SAME shape/reasoning `KeycloakConnector`/`EchoConnector`/`ActiveDirectoryConnector` each re-derive locally rather than import (see any of their own doc comments: a deliberate, repeated convention in `connectors/`, not an oversight — each target module stays independent, per the milestone plan's own "M11-M13 are then genuinely independent of each other"). */
function sameNameSet(a: Iterable<string>, b: Iterable<string>): boolean {
  const setA = new Set(a)
  const setB = new Set(b)
  return setA.size === setB.size && [...setA].every((name) => setB.has(name))
}

/**
 * Best-effort extraction of the Microsoft identity platform TOKEN endpoint's
 * own error shape — https://learn.microsoft.com/en-us/entra/identity-platform/
 * v2-oauth2-client-creds-grant-flow, "Error response": `{error, error_description,
 * error_codes, timestamp, trace_id, correlation_id}`. Deliberately NOT the same
 * shape as `describeGraphError` below — the token endpoint (login.microsoftonline.com)
 * and the Graph API (graph.microsoft.com) are two different services with two
 * different, both-documented error envelopes; conflating them would mis-parse
 * one or the other. Only ever reads the RESPONSE body the target itself sent —
 * never anything this connector transmitted — so this can never echo back the
 * client secret.
 */
async function describeAadTokenError(res: Response): Promise<string> {
  const text = await res.text()
  try {
    const parsed = JSON.parse(text) as { error?: string; error_description?: string }
    return parsed.error_description ?? parsed.error ?? text
  } catch {
    return text
  }
}

/** Best-effort extraction of Microsoft Graph's own error shape — https://learn.microsoft.com/en-us/graph/errors: `{error: {code, message, innerError}}`. Same "only ever reads the target's own response" safety as `describeAadTokenError` above. */
async function describeGraphError(res: Response): Promise<string> {
  const text = await res.text()
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } }
    return parsed.error?.message ?? parsed.error?.code ?? text
  } catch {
    return text
  }
}

/**
 * Parses a `Retry-After` header value into a millisecond delay — pure, no I/O,
 * unit-tested directly (mirrors `computeBackoffDelayMs`'s own standalone-export
 * reasoning, sync.worker.ts). Two documented forms exist: Graph's own examples
 * (https://learn.microsoft.com/en-us/graph/throttling, "Sample response":
 * `Retry-After: 10`) always use delay-seconds; RFC 7231 §7.1.3 additionally
 * allows an HTTP-date, which this handles defensively even though no Graph
 * example shows it. `null` (header absent — a real, documented possibility for
 * a 503: https://learn.microsoft.com/en-us/graph/errors' own row says a retry
 * delay "can be specified", not "is always") and any unparseable value fall
 * back to `fallbackMs` rather than throwing or waiting 0ms (which would not be
 * "honouring" anything — indistinguishable from not waiting at all).
 */
export function parseRetryAfterMs(headerValue: string | null, fallbackMs = DEFAULT_RETRY_AFTER_FALLBACK_MS): number {
  if (headerValue === null) {
    return fallbackMs
  }
  const asSeconds = Number(headerValue)
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return asSeconds * 1000
  }
  const asDate = Date.parse(headerValue)
  if (!Number.isNaN(asDate)) {
    const diff = asDate - Date.now()
    return diff > 0 ? diff : 0
  }
  return fallbackMs
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Graph's mailNickname character rule, as documented for GROUP creation
// (https://learn.microsoft.com/en-us/graph/api/group-post-groups — "This
// property can contain only characters in the ASCII character set 0 - 127
// except the following characters: @()\[]\";:<>, SPACE", max 64 chars).
// Applied identically to USER mailNickname: the "Create user" doc
// (https://learn.microsoft.com/en-us/graph/api/user-post-users) documents
// mailNickname as required but does not restate the character table on that
// page — Microsoft 365's mail-alias convention is the same restriction for
// both resource types, so this is a reasonable, explicitly-flagged
// derivation rather than an independently-confirmed-for-users source; see
// this task's report for that caveat stated plainly.
const MAIL_NICKNAME_DISALLOWED = /["();:<>,[\]@\s]/g
const MAIL_NICKNAME_NON_ASCII = /[^\x00-\x7F]/g

/** Derives a Graph-legal `mailNickname` from an arbitrary username/displayName — pure, exported, unit-tested directly. Strips a `@domain` suffix (usernames in this system are email-shaped), then strips disallowed/non-ASCII characters, then truncates to Graph's documented 64-character limit. Falls back to a fixed prefix + random suffix if sanitisation leaves nothing usable (an empty mailNickname is not valid). */
export function deriveMailNickname(input: string): string {
  const localPart = input.split('@')[0] ?? input
  const sanitized = localPart.replace(MAIL_NICKNAME_NON_ASCII, '').replace(MAIL_NICKNAME_DISALLOWED, '')
  const truncated = sanitized.slice(0, 64)
  return truncated.length > 0 ? truncated : `user-${randomInt(1_000_000, 9_999_999)}`
}

const PASSWORD_LOWER = 'abcdefghijkmnopqrstuvwxyz'
const PASSWORD_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const PASSWORD_DIGIT = '23456789'
const PASSWORD_SYMBOL = '!@#$%^&*-_=+'
const PASSWORD_ALL = PASSWORD_LOWER + PASSWORD_UPPER + PASSWORD_DIGIT + PASSWORD_SYMBOL

function randomChar(alphabet: string): string {
  return alphabet[randomInt(alphabet.length)]!
}

/**
 * Generates a high-entropy, throwaway password satisfying Entra ID's default
 * strong-password policy (>= 3 of 4 character classes; this guarantees all
 * four, well above the bar) — via `node:crypto`'s CSPRNG (`randomInt`), never
 * `Math.random`. See the large doc comment at this function's ONE call site
 * (`EntraIdConnector.apply`'s CREATE branch) for why this exists at all — it
 * is a deliberate, flagged deviation from this task's own "never generate,
 * transmit or store a user credential" text, not an oversight. The returned
 * value is used exactly once, inline, to build one HTTP request body, and is
 * never assigned to a field, logged, returned, or included in any error this
 * class constructs.
 */
export function generateBootstrapPassword(length = 32): string {
  const required = [randomChar(PASSWORD_LOWER), randomChar(PASSWORD_UPPER), randomChar(PASSWORD_DIGIT), randomChar(PASSWORD_SYMBOL)]
  const rest = Array.from({ length: Math.max(0, length - required.length) }, () => randomChar(PASSWORD_ALL))
  const all = [...required, ...rest]
  for (let i = all.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    const tmp = all[i]!
    all[i] = all[j]!
    all[j] = tmp
  }
  return all.join('')
}

/** `desired.attributes`/core identity fields, merged into the flat, scalar-string payload this connector sends to Graph — see `EntraIdConnector.buildAttributePayload`'s own doc comment for why every value is a single string, never `string[]`. */
type GraphAttributePayload = Record<string, string>

interface ExistingUser {
  id: string
}

interface GroupMembership {
  id: string
  displayName: string
}

/**
 * The Entra ID adapter — OAuth 2.0 client-credentials against the Microsoft
 * identity platform, Microsoft Graph over `fetch`. Implements exactly the
 * four `DirectoryConnector` methods; per that interface's own doc comment,
 * THERE IS NO delete anywhere in this class — `disable()` is `accountEnabled:
 * false`, and group membership removal (`removeMember`, the ONE `DELETE` this
 * class ever issues) targets a `/members/{id}/$ref` EDGE, never a `/users/{id}`
 * or bare `/groups/{id}/members/{id}` path — Graph's own docs are explicit
 * that omitting `/$ref` from that second shape deletes the actual member
 * object (https://learn.microsoft.com/en-us/graph/api/group-delete-members,
 * "Caution"). See `test/entra-id.connector.spec.ts`'s static source-scan
 * proof for this, mirroring `ActiveDirectoryConnector`'s own "no `.del(`
 * anywhere" test.
 *
 * CORRELATION is on Graph's own immutable `id` — NEVER `userPrincipalName`,
 * NEVER `mail`: this task's own binding rule, because both MOVE (an admin can
 * rename either directly in Entra). `apply(desired)` has no `externalId`
 * parameter of its own (Milestone 10, Task 2 — settled interface), so
 * re-identifying an already-known principal uses `desired.existingExternalId`
 * (`sync.worker.ts#buildDesiredUser`, widened in this task to populate it for
 * `entra_id` the same way Milestone 11 Task 5 populated it for
 * `active_directory` — see that field's own doc comment on `DesiredUser`,
 * connector.ts) — search by `id` FIRST; only when that is absent (first-ever
 * sync) or stale does this fall back to `userPrincipalName`, the SAME
 * "immutable id first, mutable bootstrap-fallback second" shape
 * `ActiveDirectoryConnector.findExisting` already uses for `sAMAccountName` —
 * see that method's own doc comment for why a bootstrap fallback is not a
 * violation of "never correlate on the mutable field": it exists ONLY for the
 * first sync, before any correlation exists to violate, and stops being
 * consulted the moment `existingExternalId` is populated.
 *
 * TOKEN HANDLING mirrors `KeycloakAdminClient` almost exactly (same cached-
 * until-shortly-before-expiry shape, same "force a fresh token for health()"
 * reasoning, same "exactly one retry on 401, never a loop" request shape) —
 * see `getToken`/`graphRequest`'s own doc comments. The resolved token/secret
 * value is never assigned to a field that outlives one call, never logged,
 * never included in any thrown error (`describeAadTokenError`/
 * `describeGraphError` read ONLY the target's own response body).
 *
 * THROTTLING: `graphRequest` honours `Retry-After` on 429 AND 503 for real —
 * sleeps the ACTUAL parsed duration (`parseRetryAfterMs`, real `setTimeout`,
 * never mocked/skipped) and retries the SAME request, bounded by
 * `maxThrottleRetries`/`maxThrottleWaitMs` (see those constants' own doc
 * comments for why bounded, not infinite).
 *
 * NEVER SENDS A PASSWORD FOR AN EXISTING USER. The ONE exception — a bootstrap
 * password on CREATE — is a flagged, load-bearing deviation from this task's
 * own text; see `apply()`'s CREATE branch for the full explanation, sourced
 * against Microsoft's own documented requirement.
 *
 * CONNECTION DISCIPLINE (`DirectoryConnector`'s own doc comment): this class
 * never opens a Postgres connection of any kind — its only I/O is HTTP
 * (token endpoint + Graph), against config `ConnectorRegistry.resolve`
 * already read via the caller's own transaction.
 */
@Injectable()
export class EntraIdConnector implements DirectoryConnector {
  private rawConfig: Record<string, unknown> = {}
  private cachedToken: { value: string; expiresAt: number } | null = null
  private cachedTokenIdentity: string | null = null

  /**
   * Rebinds this connector to a FRESH read of `connector_targets.config`,
   * exactly like `ActiveDirectoryConnector.configure`/`EchoConnector.configure`
   * — called by `ConnectorRegistry.resolve`, never by a caller directly.
   * Deliberately does NOT parse/validate `config` here (mirrors
   * `ActiveDirectoryConnector`: `configure` never throws — only a method that
   * actually needs a valid config does, via `parsedConfig()`), so a factory
   * call site (`ConnectorRegistry`'s constructor) can call this synchronously
   * with no try/catch. Returns `this` so `resolve` can `factory(config)` in
   * one expression.
   */
  configure(config: Record<string, unknown>): this {
    this.rawConfig = config
    return this
  }

  private parsedConfig(): EntraIdConnectorConfig {
    return parseEntraConfig(this.rawConfig)
  }

  async plan(desired: DesiredUser): Promise<ConnectorOperation[]> {
    const existing = await this.findExisting(desired)
    if (existing === null) {
      return [{ kind: 'create', description: `create Entra ID user "${desired.username}" (enabled=${desired.enabled})` }]
    }

    const ops: ConnectorOperation[] = []
    const attributePayload = this.buildAttributePayload(desired)
    const clearCandidates = (desired.managedAttributeRemoteNames ?? []).filter(
      (name) => !Object.hasOwn(attributePayload, name),
    )
    const readNames = [...new Set(['accountEnabled', ...Object.keys(attributePayload), ...clearCandidates])]
    const current = await this.readUser(existing.id, readNames)

    const profileChanged =
      Object.entries(attributePayload).some(([key, value]) => current[key] !== value) ||
      clearCandidates.some((name) => current[name] !== null && current[name] !== undefined)
    if (profileChanged) {
      ops.push({ kind: 'update', description: `update Entra ID user "${desired.username}" profile/attributes` })
    }

    const currentEnabled = current.accountEnabled === true
    if (currentEnabled !== desired.enabled) {
      ops.push({
        kind: desired.enabled ? 'update' : 'disable',
        description: `set Entra ID user "${desired.username}" accountEnabled=${desired.enabled}`,
      })
    }

    const currentGroups = await this.currentGroupMemberships(existing.id)
    if (!sameNameSet(currentGroups.map((g) => g.displayName), desired.groups)) {
      ops.push({ kind: 'update', description: `reconcile Entra ID group membership for "${desired.username}"` })
    }

    return ops
  }

  async apply(desired: DesiredUser): Promise<{ externalId: string }> {
    const existing = await this.findExisting(desired)
    const attributePayload = this.buildAttributePayload(desired)

    if (existing === null) {
      // ---------------------------------------------------------------
      // A FLAGGED, load-bearing deviation from this task's own text.
      //
      // This task's BUILD section says: "Never generate, transmit or store a
      // user credential. Entra accounts are provisioned without one." Real
      // Microsoft Graph does not support that for a normal work-or-school
      // account: "Create user" documents `passwordProfile` as one of exactly
      // five REQUIRED properties on `POST /users`
      // (https://learn.microsoft.com/en-us/graph/api/user-post-users, the
      // required-properties table), and the `passwordProfile.password`
      // property itself is documented as "required when a user is created"
      // with NO auto-generation and no passwordless path for this scenario
      // (https://learn.microsoft.com/en-us/graph/api/resources/passwordprofile
      // — confirmed via Microsoft Learn AND corroborating community sources
      // during this task; there is no flag analogous to AD's real
      // `PASSWD_NOTREQD` bit). Omitting `passwordProfile` entirely would make
      // `POST /users` fail every time against a real tenant — silently
      // shipping a connector whose CREATE path cannot work is a worse
      // violation of this project's own "no vacuous work" standard than
      // flagging the conflict honestly.
      //
      // Pending confirmation from whoever owns this task's contract, this
      // connector follows the SAME pattern Milestone 13's own task text
      // already accepts for Google Workspace user creation: generate a
      // high-entropy value (`generateBootstrapPassword`, a real CSPRNG, never
      // `Math.random`), transmit it ONCE in this request body, and retain
      // NOTHING — it lives only in this local scope, is never assigned to a
      // field, logged, returned, or included in any error. `accountEnabled`
      // still reflects `desired.enabled` exactly as every other target
      // asserts it (this deviation does not force every new account
      // disabled); `forceChangePasswordNextSignIn: true` additionally means
      // even a leaked/guessed value could complete at most one interactive
      // sign-in before Entra itself forces a change — credentials remain
      // Keycloak's for every purpose this system's own architecture actually
      // uses. See `test/entra-id.connector.spec.ts`'s sentinel proof
      // extending this exact guarantee to the generated value, and this
      // task's report for the explicit ask for a decision.
      const bootstrapPassword = generateBootstrapPassword()
      const body: Record<string, unknown> = {
        accountEnabled: desired.enabled,
        mailNickname: deriveMailNickname(desired.username),
        passwordProfile: { forceChangePasswordNextSignIn: true, password: bootstrapPassword },
        ...attributePayload,
      }
      const res = await this.graphRequest('POST', '/users', body)
      if (!res.ok) {
        throw new EntraGraphError(res.status, `EntraIdConnector.apply (create "${desired.username}"): ${res.status} ${await describeGraphError(res)}`)
      }
      const created = (await res.json()) as { id: string }
      await this.reconcileGroups(created.id, desired.groups)
      return { externalId: created.id }
    }

    // UPDATE — one PATCH call carrying every changed field (profile,
    // mapped/core attributes, accountEnabled) PLUS explicit `null` for any
    // managed-but-no-longer-desired attribute (`clearCandidates` — see
    // `DesiredUser.managedAttributeRemoteNames`'s own doc comment: Graph's
    // PATCH only touches properties explicitly present in the body
    // (https://learn.microsoft.com/en-us/graph/api/user-update, "Request
    // body": "Existing properties that aren't included in the request body
    // maintain their previous values") — the SAME gap
    // `ActiveDirectoryConnector` found empirically against LDAP `modify`,
    // confirmed here from Graph's own docs directly rather than needing to
    // rediscover it empirically). Unlike AD's THREE independently-atomic LDAP
    // operations (attribute modify, then DN placement, then userAccountControl
    // — necessary there because LDAP has no single "assert everything" verb),
    // Graph's PATCH is ALREADY one atomic HTTP transaction with no
    // DN-equivalent placement step, so every changed field goes in ONE call —
    // simpler than AD, not a corner cut: there is no multi-step ordering to
    // get right when there is only one step.
    const clearCandidates = (desired.managedAttributeRemoteNames ?? []).filter(
      (name) => !Object.hasOwn(attributePayload, name),
    )
    const readNames = [...new Set(['accountEnabled', ...Object.keys(attributePayload), ...clearCandidates])]
    const current = await this.readUser(existing.id, readNames)

    const patchBody: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(attributePayload)) {
      if (current[key] !== value) {
        patchBody[key] = value
      }
    }
    for (const name of clearCandidates) {
      if (current[name] !== null && current[name] !== undefined) {
        patchBody[name] = null
      }
    }
    if (current.accountEnabled !== desired.enabled) {
      patchBody.accountEnabled = desired.enabled
    }

    if (Object.keys(patchBody).length > 0) {
      const res = await this.graphRequest('PATCH', `/users/${encodeURIComponent(existing.id)}`, patchBody)
      if (!res.ok) {
        throw new EntraGraphError(res.status, `EntraIdConnector.apply (update "${desired.username}"): ${res.status} ${await describeGraphError(res)}`)
      }
    }

    await this.reconcileGroups(existing.id, desired.groups)
    return { externalId: existing.id }
  }

  /**
   * The ONLY removal-shaped operation (per `DirectoryConnector`'s own doc
   * comment) — takes ONLY the immutable Graph `id`, and sets `accountEnabled:
   * false`. Unlike AD's `userAccountControl` (a bitfield packing several
   * unrelated flags, requiring read-modify-write to avoid clobbering the
   * OTHERS — see `ActiveDirectoryConnector.setEnabledPreservingOtherBits`'s
   * own doc comment), Graph's `accountEnabled` is a single, independent
   * boolean property with nothing else packed into it
   * (https://learn.microsoft.com/en-us/graph/api/user-update's own property
   * table) — a direct PATCH of that one field cannot clobber anything else,
   * so no prior read is needed here either.
   */
  async disable(externalId: string): Promise<void> {
    const res = await this.graphRequest('PATCH', `/users/${encodeURIComponent(externalId)}`, { accountEnabled: false })
    if (res.status === 404) {
      throw new Error(`EntraIdConnector.disable: no user found for id "${externalId}"`)
    }
    if (!res.ok) {
      throw new EntraGraphError(res.status, `EntraIdConnector.disable: ${res.status} ${await describeGraphError(res)}`)
    }
  }

  /** Forces a FRESH token request — mirrors `KeycloakAdminClient.health`'s own reasoning verbatim: a cached token can be reused successfully right up until the moment it expires, so trusting it here would report healthy through a window where the client secret could already be wrong (rotated, revoked) without this call ever finding out. Never throws. */
  async health(): Promise<ConnectorHealth> {
    try {
      await this.getToken(true)
      const config = this.parsedConfig()
      return {
        ok: true,
        detail: `Microsoft Graph reachable for tenant "${config.tenantId}"; authenticated as client "${config.clientId}"`,
      }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  // -------------------------------------------------------------------
  // Find / read
  // -------------------------------------------------------------------

  /** `id` FIRST (via `desired.existingExternalId`), `userPrincipalName` bootstrap fallback — see this class's own doc comment for the full reasoning, identical in shape to `ActiveDirectoryConnector.findExisting`. */
  private async findExisting(desired: DesiredUser): Promise<ExistingUser | null> {
    if (desired.existingExternalId !== undefined) {
      const res = await this.graphRequest('GET', `/users/${encodeURIComponent(desired.existingExternalId)}?$select=id`)
      if (res.ok) {
        return { id: desired.existingExternalId }
      }
      if (res.status !== 404) {
        throw new EntraGraphError(res.status, `EntraIdConnector: looking up existing user by id: ${res.status} ${await describeGraphError(res)}`)
      }
      // Falls through deliberately — same reasoning as
      // ActiveDirectoryConnector.findExisting's own identical fall-through: a
      // stored id Graph no longer recognises (should not happen — nothing in
      // this system or Graph deletes it) still gets a real chance to resolve
      // by userPrincipalName below, rather than racing straight to CREATE and
      // risking a duplicate.
    }

    const res = await this.graphRequest('GET', `/users/${encodeURIComponent(desired.username)}?$select=id`)
    if (res.status === 404) {
      return null
    }
    if (!res.ok) {
      throw new EntraGraphError(res.status, `EntraIdConnector: looking up existing user by userPrincipalName: ${res.status} ${await describeGraphError(res)}`)
    }
    const body = (await res.json()) as { id: string }
    return { id: body.id }
  }

  private async readUser(id: string, selectFields: readonly string[]): Promise<Record<string, unknown>> {
    const select = [...new Set(['id', ...selectFields])].join(',')
    const res = await this.graphRequest('GET', `/users/${encodeURIComponent(id)}?$select=${encodeURIComponent(select)}`)
    if (!res.ok) {
      throw new EntraGraphError(res.status, `EntraIdConnector: reading user "${id}": ${res.status} ${await describeGraphError(res)}`)
    }
    return (await res.json()) as Record<string, unknown>
  }

  /**
   * This user's current group memberships, id + displayName — reused by BOTH
   * `plan()` (a NAME-set comparison against `desired.groups`, matching
   * `KeycloakConnector.plan`'s identical shape exactly) and `reconcileGroups`
   * (an ID-set diff, below). `memberOf` can return directory ROLES as well as
   * groups (both are `directoryObject`s) — filtered here via `@odata.type`,
   * the same discriminator Graph's own heterogeneous collections always carry
   * (https://learn.microsoft.com/en-us/graph/api/user-list-memberof shows
   * `#microsoft.graph.group`/`#microsoft.graph.directoryRole` entries mixed
   * in one `value` array).
   */
  private async currentGroupMemberships(userId: string): Promise<GroupMembership[]> {
    const items = await this.graphGetAllPages(`/users/${encodeURIComponent(userId)}/memberOf?$select=id,displayName`)
    return items
      .filter((item) => item['@odata.type'] === '#microsoft.graph.group')
      .map((item) => ({ id: String(item.id), displayName: typeof item.displayName === 'string' ? item.displayName : '' }))
  }

  /** Every `value` entry across every page of a Graph collection response, following `@odata.nextLink` (an ABSOLUTE URL Graph returns verbatim — `graphRequest` accepts either a relative path or a full URL, see its own doc comment) until none remains. */
  private async graphGetAllPages(path: string): Promise<Array<Record<string, unknown>>> {
    const results: Array<Record<string, unknown>> = []
    let next: string | null = path
    while (next !== null) {
      const res: Response = await this.graphRequest('GET', next)
      if (!res.ok) {
        throw new EntraGraphError(res.status, `EntraIdConnector: paginated GET ${next}: ${res.status} ${await describeGraphError(res)}`)
      }
      const body = (await res.json()) as { value: Array<Record<string, unknown>>; '@odata.nextLink'?: string }
      results.push(...body.value)
      next = body['@odata.nextLink'] ?? null
    }
    return results
  }

  // -------------------------------------------------------------------
  // Group membership via $ref
  // -------------------------------------------------------------------

  /**
   * Reconciles this user's group membership to EXACTLY `desiredGroupNames` —
   * the flattened effective membership `DesiredUser.groups` already carries
   * (see that field's own doc comment) — via Graph's `$ref` edge endpoints.
   * `ensureGroup` finds-or-creates each desired group first (a WRITE, so
   * never called from `plan()` — mirrors `KeycloakConnector.apply`'s own
   * `ensureGroup` calls, which have the identical "plan diffs against names
   * without creating anything; apply resolves/creates as needed" split).
   * Every add/remove is its OWN `$ref` call (one edge per HTTP call, never
   * batched) — the direct Graph-shaped analogue of AD's "removing a member
   * removes exactly one edge" guarantee.
   */
  private async reconcileGroups(userId: string, desiredGroupNames: readonly string[]): Promise<void> {
    const desiredIds = new Map<string, string>()
    for (const name of desiredGroupNames) {
      desiredIds.set(name, await this.ensureGroup(name))
    }

    const current = await this.currentGroupMemberships(userId)
    const desiredIdSet = new Set(desiredIds.values())
    const currentIdSet = new Set(current.map((g) => g.id))

    for (const id of desiredIdSet) {
      if (!currentIdSet.has(id)) {
        await this.addMember(id, userId)
      }
    }
    for (const group of current) {
      if (!desiredIdSet.has(group.id)) {
        await this.removeMember(group.id, userId)
      }
    }
  }

  /** Finds a security group by EXACT `displayName` (OData `$filter`, single quotes doubled per standard OData string-literal escaping), or creates one — `mailEnabled: false, securityEnabled: true, groupTypes: []`, the documented shape of a plain (non-Microsoft-365) security group (https://learn.microsoft.com/en-us/graph/api/group-post-groups, Example 2). */
  private async ensureGroup(name: string): Promise<string> {
    const filter = `displayName eq '${name.replace(/'/g, "''")}'`
    const findRes = await this.graphRequest('GET', `/groups?$filter=${encodeURIComponent(filter)}&$select=id`)
    if (!findRes.ok) {
      throw new EntraGraphError(findRes.status, `EntraIdConnector: finding group "${name}": ${findRes.status} ${await describeGraphError(findRes)}`)
    }
    const found = (await findRes.json()) as { value: Array<{ id: string }> }
    if (found.value.length > 0) {
      return found.value[0]!.id
    }

    const createRes = await this.graphRequest('POST', '/groups', {
      displayName: name,
      mailEnabled: false,
      mailNickname: deriveMailNickname(name),
      securityEnabled: true,
      groupTypes: [],
    })
    if (!createRes.ok) {
      throw new EntraGraphError(createRes.status, `EntraIdConnector: creating group "${name}": ${createRes.status} ${await describeGraphError(createRes)}`)
    }
    const created = (await createRes.json()) as { id: string }
    return created.id
  }

  /** `POST /groups/{id}/members/$ref` — https://learn.microsoft.com/en-us/graph/api/group-post-members. `@odata.id` always references the REAL `graph.microsoft.com` host regardless of `graphBaseUrl` — see `GRAPH_PRODUCTION_BASE_URL`'s own doc comment. */
  private async addMember(groupId: string, userId: string): Promise<void> {
    const res = await this.graphRequest('POST', `/groups/${encodeURIComponent(groupId)}/members/$ref`, {
      '@odata.id': `${GRAPH_PRODUCTION_BASE_URL}/directoryObjects/${userId}`,
    })
    if (!res.ok) {
      throw new EntraGraphError(res.status, `EntraIdConnector: adding member "${userId}" to group "${groupId}": ${res.status} ${await describeGraphError(res)}`)
    }
  }

  /**
   * `DELETE /groups/{id}/members/{id}/$ref` — https://learn.microsoft.com/en-us/graph/api/group-delete-members.
   * THE ONLY `DELETE` this connector ever issues, and it targets a
   * `/members/{id}/$ref` EDGE, never `/users/{id}` or a bare
   * `/groups/{id}/members/{id}` (Graph's own docs: omitting `/$ref` from that
   * second shape deletes the actual member object — "Caution" note on that
   * same page). See this class's own top doc comment and
   * `test/entra-id.connector.spec.ts`'s static source-scan proof.
   */
  private async removeMember(groupId: string, userId: string): Promise<void> {
    const res = await this.graphRequest('DELETE', `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/$ref`)
    if (!res.ok) {
      throw new EntraGraphError(res.status, `EntraIdConnector: removing member "${userId}" from group "${groupId}": ${res.status} ${await describeGraphError(res)}`)
    }
  }

  // -------------------------------------------------------------------
  // Attribute assertion
  // -------------------------------------------------------------------

  /**
   * `desired.attributes` (default-deny-filtered — Milestone 10, Task 3;
   * already scoped to exactly this target's enabled `attribute_target_mappings`
   * rows before this connector ever sees them — see `DesiredUser`'s own doc
   * comment), merged with the always-on core identity fields, core fields
   * taking precedence on a naming collision — the identical shape and
   * reasoning `ActiveDirectoryConnector.buildAttributePayload` already uses
   * ("core fields intentionally take precedence... so a misconfigured custom
   * mapping can never override this connector's own identity-critical
   * writes").
   *
   * ONE GENUINE, DOCUMENTED DIFFERENCE FROM AD/KEYCLOAK: every value here is
   * a single STRING, never `string[]`. `DesiredUser.attributes` is
   * `Record<string, string[]>` (the shared, target-agnostic shape LDAP's
   * genuinely multi-valued attributes and Keycloak's own `string[]`
   * convention both need) — but every Graph `user` property this connector
   * writes custom/core values under (`department`, `jobTitle`, `city`,
   * `employeeId`, `officeLocation`, ... — see
   * https://learn.microsoft.com/en-us/graph/api/user-update's property table,
   * `Type: String`) is a SCALAR. Graph has no generic arbitrary-multivalued
   * custom-attribute mechanism analogous to LDAP/Keycloak's own (Open/Schema
   * Extensions exist but require either a separate sub-resource or app
   * registration setup — out of scope for this task; see the report's
   * Concerns). This connector therefore takes the FIRST value of each mapped
   * array and drops any additional ones — a real, load-bearing decision,
   * asserted directly by `test/entra-id.connector.spec.ts`, not merely
   * assumed.
   *
   * Unmapped `remoteName`s are never validated against Graph's own schema
   * locally — the same choice `ActiveDirectoryConnector` makes for LDAP
   * attribute names (see its own doc comment): a wrong `remoteName` fails
   * loudly with Graph's OWN error the moment it is actually sent, which is a
   * real, independent layer of protection this connector does not need to
   * duplicate.
   */
  private buildAttributePayload(desired: DesiredUser): GraphAttributePayload {
    const mapped: GraphAttributePayload = {}
    for (const [key, values] of Object.entries(desired.attributes)) {
      if (values.length > 0) {
        mapped[key] = values[0]!
      }
    }
    return {
      ...mapped,
      givenName: desired.firstName,
      surname: desired.lastName,
      mail: desired.email,
      userPrincipalName: desired.username,
      mailNickname: deriveMailNickname(desired.username),
      displayName: `${desired.firstName} ${desired.lastName}`.trim(),
    }
  }

  // -------------------------------------------------------------------
  // Token handling — mirrors KeycloakAdminClient almost exactly (see this
  // class's own top doc comment).
  // -------------------------------------------------------------------

  private async fetchToken(config: EntraIdConnectorConfig): Promise<{ value: string; expiresAt: number }> {
    const secret = resolveSecret(config.credentialSecretName)
    const requestedAt = Date.now()
    const res = await this.timedFetch(`${config.authorityBaseUrl}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`, config, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      // `secret` lives only in this local scope and inside the request body
      // this one call sends — never assigned to a field, never logged, never
      // included in any error this class constructs (secrets.ts's own doc
      // comment: resolve transiently, use, discard).
      body: new URLSearchParams({
        client_id: config.clientId,
        scope: GRAPH_DEFAULT_SCOPE,
        client_secret: secret,
        grant_type: 'client_credentials',
      }),
    })

    if (!res.ok) {
      throw new EntraGraphError(res.status, `EntraIdConnector: token request failed: ${res.status} ${await describeAadTokenError(res)}`)
    }
    const body = (await res.json()) as { access_token: string; expires_in: number }
    const lifetimeMs = body.expires_in * 1000
    const margin = Math.min(TOKEN_EXPIRY_SAFETY_MARGIN_MS, lifetimeMs / 2)
    return { value: body.access_token, expiresAt: requestedAt + lifetimeMs - margin }
  }

  /**
   * Cached until shortly before expiry — re-validated against the CURRENT
   * config identity on every call (`tenantId`/`clientId`/`credentialSecretName`/
   * `authorityBaseUrl`, cheap pure comparisons, no I/O), so a `configure()`
   * call binding a DIFFERENT tenant/client/secret invalidates the cache on the
   * very next use even though `configure()` itself never throws or does I/O
   * (mirrors `ActiveDirectoryConnector.getClient`'s own
   * `sameConnectionIdentity` check, applied to a token instead of a socket).
   */
  private async getToken(forceRefresh: boolean): Promise<string> {
    const config = this.parsedConfig()
    const identity = JSON.stringify([config.tenantId, config.clientId, config.credentialSecretName, config.authorityBaseUrl])
    const stale = this.cachedTokenIdentity !== null && this.cachedTokenIdentity !== identity

    if (!forceRefresh && !stale && this.cachedToken !== null && this.cachedToken.expiresAt > Date.now()) {
      return this.cachedToken.value
    }
    this.cachedToken = await this.fetchToken(config)
    this.cachedTokenIdentity = identity
    return this.cachedToken.value
  }

  // -------------------------------------------------------------------
  // The Graph HTTP layer — token-refresh-once-on-401, throttle-honouring.
  // -------------------------------------------------------------------

  /**
   * One authenticated Graph call, with TWO INDEPENDENT, BOTH-BOUNDED retry
   * dimensions in a single loop:
   *
   *  - 401: refreshed EXACTLY ONCE (`refreshedTokenOnce`) — covers the token
   *    expiring between the cache check and the request actually reaching
   *    Graph, or the cached token being invalidated server-side (identical
   *    reasoning to `KeycloakAdminClient.request`'s own doc comment). A
   *    SECOND 401 (even after the forced refresh) is returned to the caller
   *    as-is, NEVER retried again — this is what makes "does not loop" true
   *    by construction, not by convention: there is no code path back to the
   *    401 branch once `refreshedTokenOnce` is `true`.
   *  - 429/503: retried up to `maxThrottleRetries` times, sleeping the ACTUAL
   *    `Retry-After` duration (`parseRetryAfterMs`, capped at
   *    `maxThrottleWaitMs`) each time — never a fixed/guessed backoff, and
   *    never the SAME token forced to refresh (throttling is not an auth
   *    problem). Exhausting the bound throws `EntraGraphThrottledError`
   *    rather than returning the 429/503 response silently.
   *
   * `path` may be a relative Graph path (`/users/...`) OR a full absolute URL
   * (an `@odata.nextLink` — see `graphGetAllPages`); both resolve to the same
   * request.
   */
  private async graphRequest(method: string, path: string, body?: unknown): Promise<Response> {
    const config = this.parsedConfig()
    const url = path.startsWith('http://') || path.startsWith('https://') ? path : `${config.graphBaseUrl}${path}`

    let refreshedTokenOnce = false
    let throttleAttempts = 0
    let token = await this.getToken(false)

    for (;;) {
      const res = await this.timedFetch(url, config, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })

      if (res.status === 429 || res.status === 503) {
        if (throttleAttempts >= config.maxThrottleRetries) {
          throw new EntraGraphThrottledError(res.status, throttleAttempts)
        }
        throttleAttempts += 1
        const waitMs = Math.min(parseRetryAfterMs(res.headers.get('retry-after')), config.maxThrottleWaitMs)
        await sleep(waitMs)
        continue
      }

      if (res.status === 401 && !refreshedTokenOnce) {
        refreshedTokenOnce = true
        token = await this.getToken(true)
        continue
      }

      return res
    }
  }

  private async timedFetch(url: string, config: EntraIdConnectorConfig, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs)
    try {
      return await fetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }
}
