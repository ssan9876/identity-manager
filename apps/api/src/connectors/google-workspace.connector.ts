import { Injectable } from '@nestjs/common'
import { randomInt } from 'node:crypto'
import { importPKCS8, SignJWT } from 'jose'
import type { ConnectorHealth, ConnectorOperation, DesiredUser, DirectoryConnector } from './connector'
import { resolveSecret } from './secrets'

// ---------------------------------------------------------------------------
// Documentation-derived constants. Every literal shape below (URLs, required
// fields, header/body shapes, error envelopes) is taken from Google's OWN
// published Admin SDK / identity documentation, not invented or recalled
// from general familiarity — see the doc comment on each function/constant
// for the specific page it was checked against on 2026-08-07. This matters
// because `test/support/google-admin-fake.ts` is pinned to the SAME
// sources: the fake exists to prove this connector's request shapes and
// state machine, not to prove Google's real service behaves as documented
// (see that file's own doc comment, and this task's report, for the honest
// scope of that proof).
// ---------------------------------------------------------------------------

/** https://developers.google.com/identity/protocols/oauth2/service-account — "Access token request", the JWT-bearer grant's token endpoint, used for every service account regardless of tenant. */
const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token'
/** https://developers.google.com/admin-sdk/directory/reference/rest/v1/users/insert (and every other Directory API reference page fetched for this task) — every example request targets this base. */
const DEFAULT_ADMIN_BASE_URL = 'https://admin.googleapis.com/admin/directory/v1'

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
// Bounded, not "retry until it succeeds" — the identical reasoning
// EntraIdConnector's own DEFAULT_MAX_THROTTLE_RETRIES doc comment gives: a
// single apply() call blocking the sync worker indefinitely while a target
// is persistently throttled would itself become the "sync turns into an
// outage" this task's own BUILD requirement warns against. Each retry still
// honours EITHER a real `Retry-After` header (when present — see
// `computeThrottleWaitMs`) OR Google's own documented exponential-backoff
// formula (when absent, the COMMON case for this specific API — see that
// function's own doc comment); this cap only bounds how many times ONE
// connector call will do that before giving up and letting the OUTER
// SyncWorker retry/backoff machinery (computeBackoffDelayMs, sync.worker.ts)
// take over on a later attempt — the same two-layer shape EntraIdConnector
// already established.
const DEFAULT_MAX_THROTTLE_RETRIES = 4
const DEFAULT_MAX_THROTTLE_WAIT_MS = 30_000
// Refresh the cached token this long before its real expiry — identical
// constant, identical reasoning, to KeycloakAdminClient's/EntraIdConnector's
// own TOKEN_EXPIRY_SAFETY_MARGIN_MS: a request that starts a moment before
// expiry must not race a token that dies mid-flight.
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 10_000

/**
 * `connector_targets.config` for `target = 'google_workspace'` — the
 * NON-SECRET half (decision 4: a secret's NAME lives here, never its
 * value). Parsed once per call by `parseGoogleWorkspaceConfig` below,
 * mirroring `EntraIdConnector`'s own `parseEntraConfig` — same "clean,
 * actionable error, never a guess" posture.
 */
export interface GoogleWorkspaceConnectorConfig {
  /**
   * The admin user to impersonate via domain-wide delegation — the JWT
   * "sub" claim (https://developers.google.com/identity/protocols/oauth2/
   * service-account, "Forming the JWT claim set": "the email address of the
   * user for which the application is requesting delegated access").
   * REQUIRED: a bare Google service account with no impersonation cannot
   * call the Admin SDK Directory API at all — every call is made "as" this
   * real admin user. Admin-editable, non-secret (decision 4).
   */
  impersonatedAdminEmail: string
  /**
   * The Workspace domain this connector mints GROUP email addresses under
   * (e.g. "corp.example.com") — see `deriveGroupEmail`. Google requires
   * every group to have a real, domain-valid email address
   * (https://developers.google.com/admin-sdk/directory/reference/rest/v1/groups/insert);
   * this system's own groups are named, not emailed, so this connector
   * derives one deterministically rather than requiring an admin to invent
   * one per group.
   */
  domain: string
  /**
   * Names the environment variable `secrets.ts#resolveSecret` reads the
   * FULL Google service-account key JSON from — `client_email` and
   * `private_key` together, exactly as Google's own downloadable key file
   * contains them (decision 4's "Google service-account key", singular: one
   * secret, the whole issued blob) — never a value stored here. Same
   * config-key convention every other connector already established.
   */
  credentialSecretName: string
  /** Overrides the Admin SDK Directory API base URL — defaults to the real `https://admin.googleapis.com/admin/directory/v1`. Exists so `test/support/google-admin-fake.ts` can point this connector at a real local HTTP server instead; production never sets this. */
  adminBaseUrl: string
  /** Overrides the OAuth token endpoint — defaults to the real `https://oauth2.googleapis.com/token`. Same test-only purpose as `adminBaseUrl`. */
  tokenUrl: string
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
    throw new Error(
      `GoogleWorkspaceConnector: connector_targets.config.${key} is required and must be a non-empty string`,
    )
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

/** Parses+validates raw `connector_targets.config` JSON — same "fail clean and immediately" posture `EntraIdConnector.parseEntraConfig`/`ActiveDirectoryConnector.parseAdConfig`/`secrets.ts` already establish. Deliberately never called from `configure()` itself (see this class's own CONFIGURATION doc comment) — only from methods that are about to actually need a valid config, mirroring both sibling connectors. */
export function parseGoogleWorkspaceConfig(config: Record<string, unknown>): GoogleWorkspaceConnectorConfig {
  return {
    impersonatedAdminEmail: requireString(config, 'impersonatedAdminEmail'),
    domain: requireString(config, 'domain'),
    credentialSecretName: requireString(config, 'credentialSecretName'),
    adminBaseUrl: optionalString(config, 'adminBaseUrl') ?? DEFAULT_ADMIN_BASE_URL,
    tokenUrl: optionalString(config, 'tokenUrl') ?? DEFAULT_TOKEN_URL,
    requestTimeoutMs: optionalNumber(config, 'requestTimeoutMs') ?? DEFAULT_REQUEST_TIMEOUT_MS,
    maxThrottleRetries: optionalNumber(config, 'maxThrottleRetries') ?? DEFAULT_MAX_THROTTLE_RETRIES,
    maxThrottleWaitMs: optionalNumber(config, 'maxThrottleWaitMs') ?? DEFAULT_MAX_THROTTLE_WAIT_MS,
  }
}

/** Thrown for any Admin SDK/token-endpoint failure not otherwise handled — deliberately NOT a DomainError subclass, mirroring `EntraGraphError`'s own doc comment: an operational fact the sync worker retries, never something this API rewrites into one of its own client-facing 4xx responses. `message` is built ONLY from the target's own response body (`describeGoogleError`/`describeTokenError` below) — never from anything this connector sent, so it can never echo back the service-account private key. */
export class GoogleAdminError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'GoogleAdminError'
  }
}

/** Thrown when `adminRequest` exhausts `maxThrottleRetries` while genuinely honouring every throttle signal along the way (a real `Retry-After` header when present, Google's own documented backoff formula otherwise) — see `DEFAULT_MAX_THROTTLE_RETRIES`'s own doc comment for why this is bounded rather than "retry forever". */
export class GoogleAdminThrottledError extends Error {
  constructor(
    public readonly lastStatus: number,
    public readonly attempts: number,
  ) {
    super(
      `Google Admin SDK throttled this request ${attempts} time(s) (last status ${lastStatus}); Retry-After/backoff was honoured every time, but the configured retry limit was reached — the outer sync will retry later via its own backoff`,
    )
    this.name = 'GoogleAdminThrottledError'
  }
}

/** Order-independent equality on two group-name sets — the SAME shape/reasoning `KeycloakConnector`/`EchoConnector`/`ActiveDirectoryConnector`/`EntraIdConnector` each re-derive locally rather than import (see any of their own doc comments: a deliberate, repeated convention in `connectors/`, not an oversight — each target module stays independent, per the milestone plan's own "M11-M13 are then genuinely independent of each other"). */
function sameNameSet(a: Iterable<string>, b: Iterable<string>): boolean {
  const setA = new Set(a)
  const setB = new Set(b)
  return setA.size === setB.size && [...setA].every((name) => setB.has(name))
}

interface GoogleErrorBody {
  error?: { code?: number; message?: string; errors?: Array<{ reason?: string; message?: string }> }
}

/**
 * The standard Google API JSON error envelope — `{error: {errors: [{domain,
 * reason, message}], code, message}}` — confirmed against multiple current
 * Google API references during this task (2026-08-07; the Admin SDK
 * Directory API's own dedicated error-reference page returned 404 when
 * fetched directly, so this shape is corroborated from Google's broader,
 * consistently-documented API error convention rather than that one
 * specific page — flagged here, and again in this task's report, exactly
 * as `EntraIdConnector`'s own less-than-fully-confirmed shapes are
 * flagged). Only ever reads the RESPONSE body the target itself sent —
 * never anything this connector transmitted — so this can never echo back
 * the service-account key.
 */
async function parseGoogleErrorBody(res: Response): Promise<{ message: string; reason: string | null }> {
  const text = await res.text()
  try {
    const parsed = JSON.parse(text) as GoogleErrorBody
    const reason = parsed.error?.errors?.[0]?.reason ?? null
    const message = parsed.error?.message ?? text
    return { message, reason }
  } catch {
    return { message: text, reason: null }
  }
}

async function describeGoogleError(res: Response): Promise<string> {
  return (await parseGoogleErrorBody(res)).message
}

/**
 * https://developers.google.com/identity/protocols/oauth2/service-account —
 * "Error response": `{error, error_description}` (the standard OAuth2
 * token-endpoint shape). Deliberately NOT the same parser as
 * `parseGoogleErrorBody` above — the token endpoint (oauth2.googleapis.com)
 * and the Admin SDK Directory API (admin.googleapis.com) are two different
 * services with two different, both-documented error envelopes; conflating
 * them would mis-parse one or the other, the identical reasoning
 * `EntraIdConnector`'s own `describeAadTokenError`/`describeGraphError`
 * split already documents.
 */
async function describeTokenError(res: Response): Promise<string> {
  const text = await res.text()
  try {
    const parsed = JSON.parse(text) as { error?: string; error_description?: string }
    return parsed.error_description ?? parsed.error ?? text
  } catch {
    return text
  }
}

/**
 * https://developers.google.com/admin-sdk/directory/v1/limits — the
 * Directory API's own documented quota-error shapes (checked directly,
 * 2026-08-07): "403 userRateLimitExceeded... the default value set in the
 * Google Cloud console is 2,400 queries per minute per user per Google
 * Cloud project", "403 quotaExceeded... the limit of concurrent requests
 * for a certain operation has been reached", "429 rateLimitExceeded...
 * [same]". A bare 429 is unconditionally throttled (checked by the caller
 * directly, never needing this function). A 403 is AMBIGUOUS — it is ALSO
 * Google's genuine "permission denied" status, a real authorization failure
 * this connector must NOT retry-loop on forever — so the response body's
 * own `error.errors[0].reason` is what actually distinguishes "throttled,
 * retry" from "not authorized, stop" for a 403; the status code alone
 * cannot. This is "the Admin SDK's quota errors" this task's own BUILD
 * section names as something to respect ALONGSIDE `Retry-After`, distinct
 * from it.
 *
 * Reads a CLONE of `res` (`res.clone()`) so the ORIGINAL response body
 * remains fully readable by the caller afterward regardless of which branch
 * this resolves to — a `Response` body can only be consumed once, and a
 * non-throttled 403 still needs its real body read again, by the call
 * site's own error-message construction.
 */
const QUOTA_ERROR_REASONS = new Set(['quotaExceeded', 'userRateLimitExceeded', 'rateLimitExceeded'])
async function isQuotaThrottleReason(res: Response): Promise<boolean> {
  const { reason } = await parseGoogleErrorBody(res.clone())
  return reason !== null && QUOTA_ERROR_REASONS.has(reason)
}

/**
 * Computes how long to wait before retrying a throttled request — pure, no
 * I/O, unit-tested directly (mirrors `EntraIdConnector.parseRetryAfterMs`'s
 * own standalone-export reasoning). Checks for a `Retry-After` header
 * FIRST, defensively, and honours it exactly like `EntraIdConnector` does
 * when present: several Google Cloud APIs' front-end infrastructure sends
 * one opportunistically even where a product's own docs are silent, and
 * honouring it costs nothing. Falls back to Google's OWN documented
 * exponential-backoff-WITH-JITTER formula when the header is absent —
 * https://developers.google.com/admin-sdk/directory/v1/limits (checked
 * directly, 2026-08-07): "Using exponential backoff... (2^n) +
 * random_number_milliseconds... waits approximately 32 seconds" before the
 * request is treated as an unrecoverable error. THIS IS A REAL, DOCUMENTED
 * DIFFERENCE FROM ENTRA: Microsoft Graph's own throttling guide shows a
 * worked `Retry-After` example; Google's Directory API rate-limit page
 * documents NO `Retry-After` header at all — "the header is absent" is the
 * COMMON case for THIS API, not the rare fallback path it is for Graph, so
 * this function's fallback branch is load-bearing far more often here than
 * `EntraIdConnector`'s own equivalent. `attempt` is 1-based (the retry
 * about to be made), matching Google's own `n` starting at 0 for the FIRST
 * retry's `2^0`... this connector starts `attempt` at 1 for its first
 * retry, so the first wait is `~(2^1)=2s` — a deliberately slightly more
 * conservative first backoff than Google's own worked example, never a
 * less conservative one.
 */
export function computeThrottleWaitMs(headerValue: string | null, attempt: number): number {
  if (headerValue !== null) {
    const asSeconds = Number(headerValue)
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
      return asSeconds * 1000
    }
    const asDate = Date.parse(headerValue)
    if (!Number.isNaN(asDate)) {
      const diff = asDate - Date.now()
      return diff > 0 ? diff : 0
    }
  }
  const exponentialSeconds = 2 ** attempt
  const jitterSeconds = Math.random()
  return Math.round((exponentialSeconds + jitterSeconds) * 1000)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface ServiceAccountKey {
  clientEmail: string
  privateKey: string
}

/**
 * Parses the resolved credential VALUE as the full downloaded Google
 * service-account key file's JSON contents — `{client_email, private_key,
 * ...}` — never a bare private-key string alone. This is decision 4's
 * "Google service-account key" (design doc), singular: Google issues this
 * as ONE JSON blob, so `connector_targets.config.credentialSecretName`
 * names exactly the ONE environment variable an operator sets to the
 * contents of their downloaded key file, and this connector splits it back
 * into its two needed fields at the point of use. Lives only in this
 * function's own local scope and its caller's (`fetchToken`) — never
 * assigned to a field, logged, or included in any error this class
 * constructs (see `secrets.ts`'s own "resolve transiently, use, discard"
 * doc comment).
 */
function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      'GoogleWorkspaceConnector: the resolved service-account credential is not valid JSON — expected the full contents of a downloaded Google service-account key file ({"client_email": ..., "private_key": ...})',
    )
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.client_email !== 'string' || obj.client_email.length === 0) {
    throw new Error('GoogleWorkspaceConnector: the resolved service-account credential is missing "client_email"')
  }
  if (typeof obj.private_key !== 'string' || obj.private_key.length === 0) {
    throw new Error('GoogleWorkspaceConnector: the resolved service-account credential is missing "private_key"')
  }
  return { clientEmail: obj.client_email, privateKey: obj.private_key }
}

/** https://developers.google.com/admin-sdk/directory/reference/rest/v1/users/insert — "Required OAuth scope: https://www.googleapis.com/auth/admin.directory.user". */
const ADMIN_SDK_USER_SCOPE = 'https://www.googleapis.com/auth/admin.directory.user'
/** https://developers.google.com/admin-sdk/directory/reference/rest/v1/groups/insert — group CRUD (create-if-missing, via `ensureGroup`). */
const ADMIN_SDK_GROUP_SCOPE = 'https://www.googleapis.com/auth/admin.directory.group'
/** https://developers.google.com/admin-sdk/directory/reference/rest/v1/members/insert — group MEMBERSHIP CRUD. Documented as an ALTERNATIVE to the broader group scope above ("Requires one of the following OAuth scopes"), requested explicitly here anyway as a legible statement of exactly what this connector needs, not because the broader scope above fails to already cover it. */
const ADMIN_SDK_GROUP_MEMBER_SCOPE = 'https://www.googleapis.com/auth/admin.directory.group.member'
const ADMIN_SDK_SCOPES = [ADMIN_SDK_USER_SCOPE, ADMIN_SDK_GROUP_SCOPE, ADMIN_SDK_GROUP_MEMBER_SCOPE].join(' ')

/**
 * Builds and signs the JWT-bearer assertion for domain-wide delegation —
 * https://developers.google.com/identity/protocols/oauth2/service-account
 * (checked directly, 2026-08-07), "Forming the JWT claim set": `iss` ("the
 * email address of the service account"), `scope` ("a space-delimited list
 * of the permissions that the application requests"), `aud` ("this value is
 * always https://oauth2.googleapis.com/token" in production — `config.
 * tokenUrl` generalises that correctly for a test fake standing in for the
 * real endpoint too, since a self-consistent token endpoint validates `aud`
 * against ITSELF, exactly as the real one validates it against its own real
 * URL), `exp`/`iat` (RS256-signed, "maximum of 1 hour after the issued
 * time" — this connector uses exactly 1 hour), and — for domain-wide
 * delegation specifically — `sub`, "the email address of the user for which
 * the application is requesting delegated access". Signed with `jose`'s
 * `SignJWT`/`importPKCS8` (RS256) — this codebase's own existing JWT
 * dependency (see `auth/jwt.guard.ts`, which already uses `jose` for
 * VERIFICATION; this is its first use for SIGNING in this codebase). The
 * private key is imported fresh from `key.privateKey` on every call — never
 * cached as a field that would outlive this call.
 */
async function buildAssertion(key: ServiceAccountKey, config: GoogleWorkspaceConnectorConfig): Promise<string> {
  const privateKey = await importPKCS8(key.privateKey, 'RS256')
  return new SignJWT({ scope: ADMIN_SDK_SCOPES })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(key.clientEmail)
    .setSubject(config.impersonatedAdminEmail)
    .setAudience(config.tokenUrl)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey)
}

// Google's group-creation reference (groups.insert) documents `email` as a
// required field but does not restate a character-restriction table on
// that page — this connector applies a CONSERVATIVE, RFC-5321-safe subset
// (lowercase ASCII letters, digits, dot, hyphen, underscore) rather than
// relying on an independently-confirmed Google-specific character table.
// Flagged explicitly — the same "reasonable, explicitly-labelled
// derivation, not an independently-confirmed source" caveat
// `EntraIdConnector.deriveMailNickname`'s own doc comment already applies
// to itself, for the identical reason (see this task's report).
const GROUP_EMAIL_DISALLOWED = /[^a-z0-9._-]/g

/** Derives a conservative, valid group email address from an arbitrary local group NAME — pure, exported, unit-tested directly. Lowercases, collapses whitespace to hyphens, strips anything outside the conservative allowed set, truncates the local part to 64 characters, and combines with `domain`. Falls back to a fixed prefix + random suffix if sanitisation leaves nothing usable (an empty local part is not a valid email). */
export function deriveGroupEmail(name: string, domain: string): string {
  const lower = name.toLowerCase().trim().replace(/\s+/g, '-')
  const sanitized = lower.replace(GROUP_EMAIL_DISALLOWED, '')
  const truncated = sanitized.slice(0, 64)
  const localPart = truncated.length > 0 ? truncated : `group-${randomInt(1_000_000, 9_999_999)}`
  return `${localPart}@${domain}`
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
 * Generates a high-entropy, throwaway password for Google user CREATION —
 * spec decision 5a (docs/superpowers/specs/2026-08-06-directory-connectors-
 * design.md), now SETTLED: "generate it, transmit it once, and retain
 * nothing... no storage, no log, no audit row, no response body, no return
 * value, no variable outliving the call." Google's own "Create user" schema
 * documents `password` as "required when creating a user account... never
 * returned in the API's response body"
 * (https://developers.google.com/admin-sdk/directory/reference/rest/v1/users
 * — the `password` field description, checked directly 2026-08-07) with no
 * passwordless creation path — the identical vendor requirement decision 5a
 * exists to resolve, corroborating the SAME requirement Milestone 12's
 * EntraIdConnector already flagged for Microsoft Graph.
 *
 * Via `node:crypto`'s CSPRNG (`randomInt`), never `Math.random`; guarantees
 * all four character classes (Google's own documented rule is "8-100 ASCII
 * characters", no explicit complexity table on that page — this connector
 * generates a strong value regardless, well above any plausible minimum).
 * The returned value is used exactly ONCE, inline, to build one HTTP
 * request body (`apply()`'s CREATE branch) and is NEVER assigned to a
 * field, logged, returned, or included in any error this class constructs
 * — see `test/google-workspace.connector.spec.ts`'s sentinel proof
 * (extending Milestone 10 Task 2's own secret-leak sentinel to this
 * generated value specifically), per decision 5a's own closing text: "It is
 * asserted by test at every such call site, not left to intent."
 */
export function generateBootstrapPassword(length = 32): string {
  const required = [
    randomChar(PASSWORD_LOWER),
    randomChar(PASSWORD_UPPER),
    randomChar(PASSWORD_DIGIT),
    randomChar(PASSWORD_SYMBOL),
  ]
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

/** `desired.attributes`, filtered to the flat, scalar-string payload this connector sends to the Admin SDK — see `GoogleWorkspaceConnector.buildAttributePayload`'s own doc comment for why core identity fields (`name`, `primaryEmail`) are handled SEPARATELY rather than folded into this same bag. */
type GoogleAttributePayload = Record<string, string>

interface ExistingUser {
  id: string
}

interface GroupMembership {
  id: string
  name: string
}

/**
 * The Google Workspace adapter — a service account with domain-wide
 * delegation, authenticating via a self-signed RS256 JWT-bearer assertion
 * exchanged for a bearer token, against the Admin SDK Directory API over
 * `fetch`. Implements exactly the four `DirectoryConnector` methods; per
 * that interface's own doc comment, THERE IS NO delete anywhere in this
 * class — `disable()` is `suspended: true`, and group membership removal
 * (`removeMember`, the ONE `DELETE` this class ever issues) targets a
 * `/groups/{id}/members/{memberKey}` EDGE, never a `/users/{id}` or
 * `/groups/{id}` object. See `test/google-workspace.connector.spec.ts`'s
 * static source-scan proof for this, mirroring `EntraIdConnector`'s own "no
 * other DELETE anywhere" test.
 *
 * CORRELATION is on Google's own immutable `id` — NEVER `primaryEmail`:
 * this task's own binding rule, because the primary email MOVES (an admin
 * can rename it directly in the Admin console). `apply(desired)` has no
 * `externalId` parameter of its own (Milestone 10, Task 2 — settled
 * interface), so re-identifying an already-known principal uses `desired.
 * existingExternalId` (`sync.worker.ts#buildDesiredUser`, widened in this
 * task to populate it for `google_workspace` the same way Milestones 11/12
 * populated it for `active_directory`/`entra_id` — see that field's own doc
 * comment on `DesiredUser`, connector.ts) — search by `id` FIRST; only when
 * that is absent (first-ever sync) or stale does this fall back to
 * `primaryEmail`, the SAME "immutable id first, mutable bootstrap-fallback
 * second" shape `ActiveDirectoryConnector`/`EntraIdConnector` already use.
 * Google's own `userKey`/`groupKey`/`memberKey` path parameters are
 * DOCUMENTED to accept EITHER the immutable id OR an email address
 * interchangeably (confirmed directly against `users.get`/`groups.get`,
 * 2026-08-07: "the value can be the user's primary email address, alias
 * email address, or unique user ID") — which is what makes a single `GET
 * /users/{userKey}` sufficient for BOTH the id-first lookup and the
 * email-fallback lookup, with no separate `$filter`-style search endpoint
 * needed (unlike `EntraIdConnector.ensureGroup`, which genuinely needs
 * Graph's OData `$filter` because Graph's own `id`-or-name path parameters
 * are NOT interchangeable the same way).
 *
 * TOKEN HANDLING is JWT-bearer, not client-credentials — see `buildAssertion`/
 * `fetchToken`'s own doc comments. Cached until shortly before expiry, force-
 * refreshed for `health()`, exactly-one-retry-on-401 request shape — the
 * SAME shape `EntraIdConnector`/`KeycloakAdminClient` already establish, just
 * with a self-signed assertion in place of a shared client secret. The
 * resolved service-account key is never assigned to a field that outlives
 * one call, never logged, never included in any thrown error
 * (`describeGoogleError`/`describeTokenError` read ONLY the target's own
 * response body).
 *
 * THROTTLING: `adminRequest` honours a `Retry-After` header when present
 * AND Google's own documented exponential-backoff-with-jitter formula when
 * absent (the COMMON case for this API — see `computeThrottleWaitMs`'s own
 * doc comment for exactly how this differs from `EntraIdConnector`'s
 * simpler fallback), for BOTH a bare `429` and a `403` whose response body
 * names a genuine QUOTA reason (`quotaExceeded`/`userRateLimitExceeded`/
 * `rateLimitExceeded` — "the Admin SDK's quota errors" this task's own
 * BUILD section names) — never for a `403` that is a genuine permission
 * failure, which throws immediately instead of retry-looping forever.
 *
 * GROUP MEMBERSHIP is FLAT, via the Members API — `DesiredUser.groups`
 * (matching Keycloak's/Entra's own shape, NOT AD's nested
 * `DirectoryGroupConnector`), reconciled one edge per HTTP call
 * (`POST .../groups/{id}/members` / `DELETE .../groups/{id}/members/{id}`).
 * This connector does NOT implement `DirectoryGroupConnector` — the
 * identical choice `EntraIdConnector` already made for Graph, for the
 * identical reason: `DesiredUser.groups` has already flattened this
 * system's own nested group DAG into an effective membership set by the
 * time any connector sees it, and Google's Members API (like Graph's
 * `$ref`) has no genuine need for this connector to preserve native nesting
 * on top of that.
 *
 * THE CREATION PASSWORD follows spec decision 5a, now settled — see
 * `generateBootstrapPassword`'s own doc comment for the full reasoning and
 * `apply()`'s CREATE branch for the one call site.
 *
 * CONNECTION DISCIPLINE (`DirectoryConnector`'s own doc comment): this
 * class never opens a Postgres connection of any kind — its only I/O is
 * HTTP (token endpoint + Admin SDK), against config `ConnectorRegistry.
 * resolve` already read via the caller's own transaction.
 */
@Injectable()
export class GoogleWorkspaceConnector implements DirectoryConnector {
  private rawConfig: Record<string, unknown> = {}
  private cachedToken: { value: string; expiresAt: number } | null = null
  private cachedTokenIdentity: string | null = null

  /**
   * Rebinds this connector to a FRESH read of `connector_targets.config`,
   * exactly like `EntraIdConnector.configure`/`ActiveDirectoryConnector.
   * configure` — called by `ConnectorRegistry.resolve`, never by a caller
   * directly. Deliberately does NOT parse/validate `config` here (mirrors
   * both sibling connectors: `configure` never throws — only a method that
   * actually needs a valid config does, via `parsedConfig()`), so a factory
   * call site (`ConnectorRegistry`'s constructor) can call this
   * synchronously with no try/catch. Returns `this` so `resolve` can
   * `factory(config)` in one expression.
   */
  configure(config: Record<string, unknown>): this {
    this.rawConfig = config
    return this
  }

  private parsedConfig(): GoogleWorkspaceConnectorConfig {
    return parseGoogleWorkspaceConfig(this.rawConfig)
  }

  async plan(desired: DesiredUser): Promise<ConnectorOperation[]> {
    const existing = await this.findExisting(desired)
    if (existing === null) {
      return [
        { kind: 'create', description: `create Google Workspace user "${desired.username}" (enabled=${desired.enabled})` },
      ]
    }

    const ops: ConnectorOperation[] = []
    const current = await this.readUser(existing.id)
    const attributePayload = this.buildAttributePayload(desired)
    const coreFields = this.buildCoreIdentityFields(desired)
    const clearCandidates = (desired.managedAttributeRemoteNames ?? []).filter(
      (name) => !Object.hasOwn(attributePayload, name),
    )

    const attributesChanged = Object.entries(attributePayload).some(([key, value]) => current[key] !== value)
    const clearNeeded = clearCandidates.some((name) => current[name] !== null && current[name] !== undefined)
    const currentName = current.name as { givenName?: unknown; familyName?: unknown } | undefined
    const nameChanged =
      currentName?.givenName !== coreFields.name.givenName || currentName?.familyName !== coreFields.name.familyName
    const emailChanged = current.primaryEmail !== coreFields.primaryEmail

    if (attributesChanged || clearNeeded || nameChanged || emailChanged) {
      ops.push({ kind: 'update', description: `update Google Workspace user "${desired.username}" profile/attributes` })
    }

    const currentSuspended = current.suspended === true
    const desiredSuspended = !desired.enabled
    if (currentSuspended !== desiredSuspended) {
      ops.push({
        kind: desired.enabled ? 'update' : 'disable',
        description: `set Google Workspace user "${desired.username}" suspended=${desiredSuspended}`,
      })
    }

    const currentGroups = await this.currentGroupMemberships(existing.id)
    if (!sameNameSet(currentGroups.map((g) => g.name), desired.groups)) {
      ops.push({ kind: 'update', description: `reconcile Google Workspace group membership for "${desired.username}"` })
    }

    return ops
  }

  async apply(desired: DesiredUser): Promise<{ externalId: string }> {
    const existing = await this.findExisting(desired)
    const attributePayload = this.buildAttributePayload(desired)
    const coreFields = this.buildCoreIdentityFields(desired)

    if (existing === null) {
      // ---------------------------------------------------------------
      // Spec decision 5a (now settled) — "where a vendor forces a password
      // at creation, generate it, transmit it once, and retain nothing."
      // Google's own "Create user" schema documents `password` as required
      // for creation with no passwordless path (see
      // `generateBootstrapPassword`'s own doc comment for the exact,
      // directly-checked citation). `bootstrapPassword` lives ONLY in this
      // local scope, used exactly once inline to build this ONE request
      // body — never assigned to a field, logged, returned, or included in
      // any error this class constructs. `changePasswordAtNextLogin: true`
      // additionally means even a leaked/guessed value could complete at
      // most one interactive sign-in before Google itself forces a change —
      // credentials remain Keycloak's for every purpose this system's own
      // architecture actually uses (interactive sign-in against Google is
      // not the intended path anyway — Keycloak issues the tokens).
      // `suspended` still reflects `!desired.enabled` exactly as every other
      // target asserts its own enabled/disabled state — this does not force
      // every new account into a disabled state.
      const bootstrapPassword = generateBootstrapPassword()
      const body: Record<string, unknown> = {
        ...attributePayload,
        ...coreFields,
        password: bootstrapPassword,
        changePasswordAtNextLogin: true,
        suspended: !desired.enabled,
      }
      const res = await this.adminRequest('POST', '/users', body)
      if (!res.ok) {
        throw new GoogleAdminError(
          res.status,
          `GoogleWorkspaceConnector.apply (create "${desired.username}"): ${res.status} ${await describeGoogleError(res)}`,
        )
      }
      const created = (await res.json()) as { id: string }
      await this.reconcileGroups(created.id, coreFields.primaryEmail, desired.groups)
      return { externalId: created.id }
    }

    // UPDATE — one PUT call ("patch semantics": omitted fields preserved,
    // fields set to `null` are cleared — confirmed directly against
    // https://developers.google.com/admin-sdk/directory/reference/rest/v1/users/update,
    // 2026-08-07: "you only need to include the fields you wish to
    // update... fields set to null will be cleared") carrying every changed
    // field (mapped attributes, core identity, suspended) PLUS explicit
    // `null` for any managed-but-no-longer-desired attribute
    // (`clearCandidates` — see `DesiredUser.managedAttributeRemoteNames`'s
    // own doc comment) — the identical gap `EntraIdConnector`/
    // `ActiveDirectoryConnector` each already close for their own targets'
    // partial-update semantics.
    const current = await this.readUser(existing.id)
    const clearCandidates = (desired.managedAttributeRemoteNames ?? []).filter(
      (name) => !Object.hasOwn(attributePayload, name),
    )

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
    // `name` is a NESTED object (`{givenName, familyName}`) — always sent
    // WHOLE when either half changes, never one half alone: Google's own
    // "omitted fields preserved" text is stated for top-level properties,
    // and nested-object partial-merge behaviour is not documented either
    // way, so sending both fields together whenever either changes is the
    // safe choice regardless of how Google actually treats an omission
    // inside a nested object.
    const currentName = current.name as { givenName?: unknown; familyName?: unknown } | undefined
    if (currentName?.givenName !== coreFields.name.givenName || currentName?.familyName !== coreFields.name.familyName) {
      patchBody.name = coreFields.name
    }
    if (current.primaryEmail !== coreFields.primaryEmail) {
      patchBody.primaryEmail = coreFields.primaryEmail
    }
    const currentSuspended = current.suspended === true
    const desiredSuspended = !desired.enabled
    if (currentSuspended !== desiredSuspended) {
      patchBody.suspended = desiredSuspended
    }

    if (Object.keys(patchBody).length > 0) {
      const res = await this.adminRequest('PUT', `/users/${encodeURIComponent(existing.id)}`, patchBody)
      if (!res.ok) {
        throw new GoogleAdminError(
          res.status,
          `GoogleWorkspaceConnector.apply (update "${desired.username}"): ${res.status} ${await describeGoogleError(res)}`,
        )
      }
    }

    await this.reconcileGroups(existing.id, coreFields.primaryEmail, desired.groups)
    return { externalId: existing.id }
  }

  /**
   * The ONLY removal-shaped operation (per `DirectoryConnector`'s own doc
   * comment) — takes ONLY the immutable Google `id`, and sets `suspended:
   * true`. A single, independent boolean, exactly like Entra's
   * `accountEnabled` (contrast AD's packed `userAccountControl` bitfield,
   * which needs read-modify-write to avoid clobbering unrelated bits) — a
   * direct PUT of just this one field cannot clobber anything else, so no
   * prior read is needed here either.
   */
  async disable(externalId: string): Promise<void> {
    const res = await this.adminRequest('PUT', `/users/${encodeURIComponent(externalId)}`, { suspended: true })
    if (res.status === 404) {
      throw new Error(`GoogleWorkspaceConnector.disable: no user found for id "${externalId}"`)
    }
    if (!res.ok) {
      throw new GoogleAdminError(res.status, `GoogleWorkspaceConnector.disable: ${res.status} ${await describeGoogleError(res)}`)
    }
  }

  /** Forces a FRESH token request — mirrors `EntraIdConnector.health`'s own reasoning verbatim: a cached token can be reused successfully right up until the moment it expires, so trusting it here would report healthy through a window where domain-wide delegation could already be revoked without this call ever finding out. Never throws. */
  async health(): Promise<ConnectorHealth> {
    try {
      await this.getToken(true)
      const config = this.parsedConfig()
      return {
        ok: true,
        detail: `Google Admin SDK reachable; authenticated as admin "${config.impersonatedAdminEmail}" via domain-wide delegation`,
      }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  // -------------------------------------------------------------------
  // Find / read
  // -------------------------------------------------------------------

  /** `id` FIRST (via `desired.existingExternalId`), `primaryEmail` bootstrap fallback — see this class's own doc comment for the full reasoning, identical in shape to `EntraIdConnector.findExisting`/`ActiveDirectoryConnector.findExisting`. Both branches hit the SAME `GET /users/{userKey}` shape — Google's `userKey` accepts id or email interchangeably (see this class's own top doc comment), so there is no separate search/filter endpoint needed the way Entra's `userPrincipalName`-fallback GET already avoids one too. */
  private async findExisting(desired: DesiredUser): Promise<ExistingUser | null> {
    if (desired.existingExternalId !== undefined) {
      const res = await this.adminRequest('GET', `/users/${encodeURIComponent(desired.existingExternalId)}`)
      if (res.ok) {
        return { id: desired.existingExternalId }
      }
      if (res.status !== 404) {
        throw new GoogleAdminError(
          res.status,
          `GoogleWorkspaceConnector: looking up existing user by id: ${res.status} ${await describeGoogleError(res)}`,
        )
      }
      // Falls through deliberately — same reasoning as
      // ActiveDirectoryConnector/EntraIdConnector's own identical
      // fall-through: a stored id Google no longer recognises (should not
      // happen — nothing in this system or Google deletes it) still gets a
      // real chance to resolve by primaryEmail below, rather than racing
      // straight to CREATE and risking a duplicate.
    }

    const res = await this.adminRequest('GET', `/users/${encodeURIComponent(desired.username)}`)
    if (res.status === 404) {
      return null
    }
    if (!res.ok) {
      throw new GoogleAdminError(
        res.status,
        `GoogleWorkspaceConnector: looking up existing user by primaryEmail: ${res.status} ${await describeGoogleError(res)}`,
      )
    }
    const body = (await res.json()) as { id: string }
    return { id: body.id }
  }

  private async readUser(id: string): Promise<Record<string, unknown>> {
    const res = await this.adminRequest('GET', `/users/${encodeURIComponent(id)}`)
    if (!res.ok) {
      throw new GoogleAdminError(res.status, `GoogleWorkspaceConnector: reading user "${id}": ${res.status} ${await describeGoogleError(res)}`)
    }
    return (await res.json()) as Record<string, unknown>
  }

  /**
   * This user's current group memberships, id + name — reused by BOTH
   * `plan()` (a NAME-set comparison against `desired.groups`, matching
   * `KeycloakConnector.plan`/`EntraIdConnector.plan`'s identical shape) and
   * `reconcileGroups` (an ID-set diff, below). `GET /groups?userKey={id}` —
   * https://developers.google.com/admin-sdk/directory/reference/rest/v1/groups/list,
   * `userKey` query parameter: "Email or immutable ID of the user if only
   * those groups are to be listed, the given user is a member of" (checked
   * directly, 2026-08-07) — the Google equivalent of Entra's `GET
   * /users/{id}/memberOf`.
   */
  private async currentGroupMemberships(userId: string): Promise<GroupMembership[]> {
    const items = await this.adminGetAllPages(`/groups?userKey=${encodeURIComponent(userId)}`, 'groups')
    return items.map((item) => ({ id: String(item.id), name: typeof item.name === 'string' ? item.name : '' }))
  }

  /** Every entry across every page of a `{[itemsKey]: [...], nextPageToken?}`-shaped Admin SDK list response, following `nextPageToken` (https://developers.google.com/admin-sdk/directory/reference/rest/v1/groups/list's own documented response shape) until none remains. */
  private async adminGetAllPages(path: string, itemsKey: 'groups' | 'members'): Promise<Array<Record<string, unknown>>> {
    const results: Array<Record<string, unknown>> = []
    let pageToken: string | null = null
    for (;;) {
      const pageUrl: string = pageToken === null ? path : `${path}${path.includes('?') ? '&' : '?'}pageToken=${encodeURIComponent(pageToken)}`
      const res = await this.adminRequest('GET', pageUrl)
      if (!res.ok) {
        throw new GoogleAdminError(res.status, `GoogleWorkspaceConnector: paginated GET ${path}: ${res.status} ${await describeGoogleError(res)}`)
      }
      const body = (await res.json()) as Record<string, unknown>
      const items = body[itemsKey]
      if (Array.isArray(items)) {
        results.push(...(items as Array<Record<string, unknown>>))
      }
      pageToken = typeof body.nextPageToken === 'string' ? body.nextPageToken : null
      if (pageToken === null) {
        return results
      }
    }
  }

  // -------------------------------------------------------------------
  // Group membership via the Members API
  // -------------------------------------------------------------------

  /**
   * Reconciles this user's group membership to EXACTLY `desiredGroupNames`
   * — the flattened effective membership `DesiredUser.groups` already
   * carries (see that field's own doc comment) — via the Members API.
   * `ensureGroup` finds-or-creates each desired group first (a WRITE, so
   * never called from `plan()` — mirrors `EntraIdConnector.reconcileGroups`'
   * own identical "plan diffs against names without creating anything;
   * apply resolves/creates as needed" split). Every add/remove is its OWN
   * HTTP call (one edge per call, never batched) — the direct Google-shaped
   * analogue of AD's "removing a member removes exactly one edge" guarantee
   * and Entra's own one-edge-per-`$ref`-call granularity.
   */
  private async reconcileGroups(userId: string, userEmail: string, desiredGroupNames: readonly string[]): Promise<void> {
    const desiredIds = new Map<string, string>()
    for (const name of desiredGroupNames) {
      desiredIds.set(name, await this.ensureGroup(name))
    }

    const current = await this.currentGroupMemberships(userId)
    const desiredIdSet = new Set(desiredIds.values())
    const currentIdSet = new Set(current.map((g) => g.id))

    for (const id of desiredIdSet) {
      if (!currentIdSet.has(id)) {
        await this.addMember(id, userEmail)
      }
    }
    for (const group of current) {
      if (!desiredIdSet.has(group.id)) {
        await this.removeMember(group.id, userId)
      }
    }
  }

  /** Finds a group by its DERIVED email (`deriveGroupEmail`), or creates one — `GET /groups/{groupKey}` accepts an email directly (https://developers.google.com/admin-sdk/directory/reference/rest/v1/groups/get, `groupKey`: "the group's email address, group alias, or the unique group ID", checked directly 2026-08-07), so no separate search/filter step is needed the way Entra's `ensureGroup` requires an OData `$filter` call. */
  private async ensureGroup(name: string): Promise<string> {
    const config = this.parsedConfig()
    const email = deriveGroupEmail(name, config.domain)

    const findRes = await this.adminRequest('GET', `/groups/${encodeURIComponent(email)}`)
    if (findRes.ok) {
      const found = (await findRes.json()) as { id: string }
      return found.id
    }
    if (findRes.status !== 404) {
      throw new GoogleAdminError(findRes.status, `GoogleWorkspaceConnector: finding group "${name}": ${findRes.status} ${await describeGoogleError(findRes)}`)
    }

    const createRes = await this.adminRequest('POST', '/groups', { email, name })
    if (!createRes.ok) {
      throw new GoogleAdminError(createRes.status, `GoogleWorkspaceConnector: creating group "${name}": ${createRes.status} ${await describeGoogleError(createRes)}`)
    }
    const created = (await createRes.json()) as { id: string }
    return created.id
  }

  /**
   * `POST /groups/{groupId}/members` —
   * https://developers.google.com/admin-sdk/directory/v1/guides/manage-group-members
   * (checked directly, 2026-08-07), whose own documented EXAMPLE request
   * body uses `"email"` (not `"id"`) to identify the member being added.
   * THIS IS THE ONE PLACE this connector references a principal by EMAIL
   * rather than its immutable Google `id` — a deliberate, narrow exception
   * to "correlate on the Google id, never the primary email" (this task's
   * own BUILD section): that rule governs what this system STORES as the
   * durable correlation key (`external_identities.external_id`, always the
   * immutable `id` — exactly as `findExisting`/`disable`/`removeMember` all
   * use it); it does not forbid a single, transient, in-the-moment API call
   * parameter that Google's OWN documented request shape requires to be an
   * email. `userEmail` is always `desired.username`, read fresh on every
   * `apply()` call, never cached or persisted anywhere.
   */
  private async addMember(groupId: string, userEmail: string): Promise<void> {
    const res = await this.adminRequest('POST', `/groups/${encodeURIComponent(groupId)}/members`, {
      email: userEmail,
      role: 'MEMBER',
    })
    if (!res.ok) {
      throw new GoogleAdminError(
        res.status,
        `GoogleWorkspaceConnector: adding member "${userEmail}" to group "${groupId}": ${res.status} ${await describeGoogleError(res)}`,
      )
    }
  }

  /**
   * `DELETE /groups/{groupId}/members/{memberKey}` —
   * https://developers.google.com/admin-sdk/directory/v1/guides/manage-group-members
   * documents `memberKey` as accepting "the user's or group's primary email
   * address, a user's alias email address, or the user's unique id" —
   * unlike `addMember` above, this call uses the immutable Google `id`,
   * consistent with `findExisting`/`disable`. THE ONLY `DELETE` this
   * connector ever issues, and it targets a group-MEMBERSHIP EDGE, never a
   * `/users/{id}` or `/groups/{id}` object. See this class's own top doc
   * comment and `test/google-workspace.connector.spec.ts`'s static
   * source-scan proof.
   */
  private async removeMember(groupId: string, userId: string): Promise<void> {
    const res = await this.adminRequest('DELETE', `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`)
    if (!res.ok) {
      throw new GoogleAdminError(
        res.status,
        `GoogleWorkspaceConnector: removing member "${userId}" from group "${groupId}": ${res.status} ${await describeGoogleError(res)}`,
      )
    }
  }

  // -------------------------------------------------------------------
  // Attribute assertion
  // -------------------------------------------------------------------

  /**
   * `desired.attributes` (default-deny-filtered — Milestone 10, Task 3;
   * already scoped to exactly this target's enabled `attribute_target_mappings`
   * rows before this connector ever sees them — see `DesiredUser`'s own doc
   * comment), taking the FIRST value of each mapped array (`DesiredUser.
   * attributes` is `Record<string, string[]>`, but every Admin SDK `User`
   * property this connector writes a mapped value under is a SCALAR — the
   * identical "no generic arbitrary-multivalued custom-attribute mechanism"
   * choice `EntraIdConnector.buildAttributePayload` already documents for
   * Graph; see this class's own top doc comment and this task's report for
   * the honest limitation this implies).
   *
   * UNLIKE `EntraIdConnector.buildAttributePayload`, core identity fields
   * (`primaryEmail`, `name`) are NOT folded into this same flat bag — see
   * `buildCoreIdentityFields` immediately below for why: Google's `name` is
   * a NESTED object
   * (https://developers.google.com/admin-sdk/directory/reference/rest/v1/users,
   * checked directly 2026-08-07), not a pair of flat scalar strings the way
   * Graph's `givenName`/`surname` are, so it cannot be spread into a
   * `Record<string, string>` the way AD's/Entra's own core fields can.
   * `apply()`/`plan()` always compute the two separately and apply core
   * identity fields to the outgoing body AFTER the mapped bag, so a
   * misconfigured custom mapping (e.g. one whose remote name happens to be
   * `"primaryEmail"`) can never override this connector's own
   * identity-critical writes — the identical "core fields intentionally
   * take precedence" reasoning `ActiveDirectoryConnector.buildAttributePayload`'s
   * own doc comment gives.
   *
   * Unmapped `remoteName`s are never validated against Google's own schema
   * locally — the same choice `ActiveDirectoryConnector`/`EntraIdConnector`
   * make for their own targets' attribute names: a wrong `remoteName` fails
   * loudly with the Admin SDK's OWN error the moment it is actually sent.
   */
  private buildAttributePayload(desired: DesiredUser): GoogleAttributePayload {
    const mapped: GoogleAttributePayload = {}
    for (const [key, values] of Object.entries(desired.attributes)) {
      if (values.length > 0) {
        mapped[key] = values[0]!
      }
    }
    return mapped
  }

  /** The core, always-on identity fields — never subject to default-deny, mirroring `DesiredUser`'s own top-level fields (see that interface's doc comment). `primaryEmail` is `desired.username` — this system's usernames are email-shaped (the same convention `EntraIdConnector.buildAttributePayload`'s own `userPrincipalName: desired.username` choice already documents), and Google has no separate "username" concept distinct from the primary email. */
  private buildCoreIdentityFields(desired: DesiredUser): { primaryEmail: string; name: { givenName: string; familyName: string } } {
    return {
      primaryEmail: desired.username,
      name: { givenName: desired.firstName, familyName: desired.lastName },
    }
  }

  // -------------------------------------------------------------------
  // Token handling — JWT-bearer domain-wide delegation, mirrors
  // EntraIdConnector's own cache/refresh shape (see this class's own top
  // doc comment).
  // -------------------------------------------------------------------

  private async fetchToken(config: GoogleWorkspaceConnectorConfig): Promise<{ value: string; expiresAt: number }> {
    const secretRaw = resolveSecret(config.credentialSecretName)
    const key = parseServiceAccountKey(secretRaw)
    const assertion = await buildAssertion(key, config)
    const requestedAt = Date.now()
    const res = await this.timedFetch(config.tokenUrl, config, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      // `assertion` is a SIGNED JWT, not the private key itself, but is
      // still treated with the same discipline: lives only in this local
      // scope and inside this one request body — never assigned to a
      // field, never logged, never included in any error this class
      // constructs.
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    })

    if (!res.ok) {
      throw new GoogleAdminError(res.status, `GoogleWorkspaceConnector: token request failed: ${res.status} ${await describeTokenError(res)}`)
    }
    const body = (await res.json()) as { access_token: string; expires_in: number }
    const lifetimeMs = body.expires_in * 1000
    const margin = Math.min(TOKEN_EXPIRY_SAFETY_MARGIN_MS, lifetimeMs / 2)
    return { value: body.access_token, expiresAt: requestedAt + lifetimeMs - margin }
  }

  /**
   * Cached until shortly before expiry — re-validated against the CURRENT
   * config identity on every call (`impersonatedAdminEmail`/
   * `credentialSecretName`/`tokenUrl`, cheap pure comparisons, no I/O), so a
   * `configure()` call binding a DIFFERENT admin/secret/endpoint
   * invalidates the cache on the very next use even though `configure()`
   * itself never throws or does I/O — mirrors `EntraIdConnector.getToken`'s
   * identical `cachedTokenIdentity` check.
   */
  private async getToken(forceRefresh: boolean): Promise<string> {
    const config = this.parsedConfig()
    const identity = JSON.stringify([config.impersonatedAdminEmail, config.credentialSecretName, config.tokenUrl])
    const stale = this.cachedTokenIdentity !== null && this.cachedTokenIdentity !== identity

    if (!forceRefresh && !stale && this.cachedToken !== null && this.cachedToken.expiresAt > Date.now()) {
      return this.cachedToken.value
    }
    this.cachedToken = await this.fetchToken(config)
    this.cachedTokenIdentity = identity
    return this.cachedToken.value
  }

  // -------------------------------------------------------------------
  // The Admin SDK HTTP layer — token-refresh-once-on-401, throttle- and
  // quota-honouring.
  // -------------------------------------------------------------------

  /**
   * One authenticated Admin SDK call, with TWO INDEPENDENT, BOTH-BOUNDED
   * retry dimensions in a single loop — mirrors `EntraIdConnector.
   * graphRequest`'s own shape exactly, adapted to Google's own throttle
   * signal (see `isQuotaThrottleReason`'s own doc comment for the 403-vs-429
   * distinction Graph does not need):
   *
   *  - 401: refreshed EXACTLY ONCE (`refreshedTokenOnce`) — covers the
   *    token expiring between the cache check and the request actually
   *    reaching Google, or the cached token being invalidated server-side.
   *    A SECOND 401 (even after the forced refresh) is returned to the
   *    caller as-is, NEVER retried again.
   *  - 429, or a 403 whose body names a genuine quota reason: retried up to
   *    `maxThrottleRetries` times, sleeping via `computeThrottleWaitMs` each
   *    time (a real `Retry-After` when present, Google's own documented
   *    backoff formula otherwise). Exhausting the bound throws
   *    `GoogleAdminThrottledError` rather than returning the throttled
   *    response silently. A 403 that is NOT a quota reason is a genuine
   *    permission failure and is returned to the caller immediately,
   *    unretried — retrying an authorization failure would hammer the
   *    target for no possible benefit.
   *
   * `path` may be a relative Admin SDK path (`/users/...`) OR a full
   * absolute URL (a paginated `nextPageToken` follow-up already carries the
   * base path forward as a relative string in this connector's own
   * `adminGetAllPages`, so this branch exists for symmetry with
   * `EntraIdConnector.graphRequest` and any future absolute-URL caller).
   */
  private async adminRequest(method: string, path: string, body?: unknown): Promise<Response> {
    const config = this.parsedConfig()
    const url = path.startsWith('http://') || path.startsWith('https://') ? path : `${config.adminBaseUrl}${path}`

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

      const throttled = res.status === 429 || (res.status === 403 && (await isQuotaThrottleReason(res)))
      if (throttled) {
        if (throttleAttempts >= config.maxThrottleRetries) {
          throw new GoogleAdminThrottledError(res.status, throttleAttempts)
        }
        throttleAttempts += 1
        const waitMs = Math.min(computeThrottleWaitMs(res.headers.get('retry-after'), throttleAttempts), config.maxThrottleWaitMs)
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

  private async timedFetch(url: string, config: GoogleWorkspaceConnectorConfig, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs)
    try {
      return await fetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }
}
