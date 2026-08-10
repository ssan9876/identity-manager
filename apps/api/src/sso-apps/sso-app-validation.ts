/**
 * The rails that make an over-broad OIDC client unrepresentable through this
 * API.
 *
 * Pure functions, no dependencies. Every one returns `null` for an acceptable
 * value and a human-readable reason otherwise, so a caller can collect several
 * problems into ONE `ValidationError` rather than failing on the first — an
 * admin pasting four redirect URIs should learn about all four bad ones in a
 * single round trip, not across four submissions. Each reason names the
 * offending value verbatim so the console can render it without re-deriving
 * which entry was at fault.
 *
 * Keycloak's own admin console accepts everything rejected here without
 * complaint. Refusing it is the entire point of moving client registration
 * into a reviewed system.
 */

/**
 * Clients this system depends on for its own security.
 *
 * `manage-clients` in Keycloak is realm-wide and does NOT scope to "clients
 * this principal created", so nothing on the Keycloak side stops
 * `idm-sso-admin` from rewriting `idm-console`'s redirectUris and harvesting
 * authorization codes for the admin console itself. This denylist is the
 * mitigation, and it should be read for exactly what it is: an
 * application-level guard on an application-level credential, strictly weaker
 * than the structural boundaries elsewhere in this system. The runtime
 * database role cannot violate append-only no matter what code runs; this
 * list holds only as long as the code consulting it is correct. Documented as
 * an OPEN risk in docs/12, not a solved problem.
 *
 * `test/sso-app-validation.spec.ts` scans scripts/keycloak-setup.sh and fails
 * if that script creates a client this list does not name, so adding a fourth
 * bootstrap client cannot silently leave it registerable-over.
 */
export const RESERVED_CLIENT_IDS: readonly string[] = [
  'idm-console',
  'idm-api',
  'idm-sync-service',
  'idm-sso-admin',
  // Keycloak's own built-ins. Overwriting any of these breaks the realm's
  // administration in ways that are tedious to diagnose and, for
  // `realm-management`, could hand out roles this system relies on.
  'realm-management',
  'account',
  'account-console',
  'security-admin-console',
  'broker',
]

const WILDCARD = '*'

export function clientIdProblem(clientId: string): string | null {
  if (clientId.trim().length === 0) {
    return 'clientId: must not be empty'
  }
  if (RESERVED_CLIENT_IDS.some((reserved) => reserved.toLowerCase() === clientId.toLowerCase())) {
    return `clientId: "${clientId}" is reserved — it names a client this system depends on for its own security`
  }
  return null
}

export function redirectUriProblem(uri: string): string | null {
  if (uri === WILDCARD) {
    return 'redirectUris: a bare "*" permits redirection to any host — reject'
  }

  // Checked BEFORE parsing: `http*://host/cb` does parse, as a URL whose
  // protocol is the nonsense scheme `http*:`, and the protocol check below
  // would then report it as "must use http or https" — technically true but
  // it buries the actual problem, which is the wildcard.
  const schemeEnd = uri.indexOf('://')
  if (schemeEnd > 0 && uri.slice(0, schemeEnd).includes(WILDCARD)) {
    return `redirectUris: "${uri}" contains a wildcard in the scheme`
  }

  let parsed: URL
  try {
    // Parsed with any path wildcards still present — a `*` in the path
    // survives URL parsing untouched, which is precisely the distinction
    // this function is drawing.
    parsed = new URL(uri)
  } catch {
    return `redirectUris: "${uri}" is not a valid absolute URL`
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `redirectUris: "${uri}" must use http or https`
  }

  if (parsed.host.includes(WILDCARD)) {
    return `redirectUris: "${uri}" contains a wildcard in the host — wildcards are permitted only in the path`
  }

  return null
}

export function webOriginProblem(origin: string): string | null {
  // Keycloak's marker for "the origins implied by the redirect URIs". Safe,
  // because it derives from values this module has already vetted.
  if (origin === '+') {
    return null
  }
  if (origin === WILDCARD) {
    return 'webOrigins: a bare "*" permits any origin to read responses — reject'
  }

  const schemeEnd = origin.indexOf('://')
  if (schemeEnd > 0 && origin.slice(0, schemeEnd).includes(WILDCARD)) {
    return `webOrigins: "${origin}" contains a wildcard in the scheme`
  }

  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return `webOrigins: "${origin}" is not a valid origin`
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `webOrigins: "${origin}" must use http or https`
  }
  if (parsed.host.includes(WILDCARD)) {
    return `webOrigins: "${origin}" contains a wildcard in the host`
  }
  // An origin is scheme + host + port and nothing else. Keycloak compares it
  // against the browser's `Origin` header, which never carries a path, so a
  // value with one silently matches nothing.
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    return `webOrigins: "${origin}" must be a bare scheme and host with no path`
  }

  return null
}

// ---------------------------------------------------------------------------
// SAML. Same contract as everything above: pure, null for acceptable, a
// reason NAMING the offending value otherwise, collectable into one
// ValidationError.
// ---------------------------------------------------------------------------

/**
 * A SAML entity id is, per the spec, a URI — in practice either an absolute
 * URL or a URN. It maps onto the Keycloak client's `clientId`, which is why
 * the RESERVED_CLIENT_IDS denylist applies here too: entity id "idm-console"
 * would otherwise register over the console's own client, the exact takeover
 * that list exists to stop. (No real SP names its entity id after a bare
 * Keycloak client, but the check costs nothing and the failure it prevents
 * is a realm takeover.)
 */
export function entityIdProblem(entityId: string): string | null {
  if (entityId.trim().length === 0) {
    return 'entityId: must not be empty'
  }
  if (RESERVED_CLIENT_IDS.some((reserved) => reserved.toLowerCase() === entityId.toLowerCase())) {
    return `entityId: "${entityId}" is reserved — it maps onto the Keycloak clientId of a client this system depends on for its own security`
  }
  // The spec caps entityID at 1024 characters; Keycloak stores longer ones
  // happily, but an SP that follows the spec will truncate and then never
  // match, which is the confusing failure. Reject it here instead.
  if (entityId.length > 1024) {
    return `entityId: "${entityId.slice(0, 64)}…" exceeds the SAML limit of 1024 characters`
  }
  if (entityId.includes(WILDCARD)) {
    return `entityId: "${entityId}" contains a wildcard — an entity id is an exact identifier`
  }
  if (/^urn:[a-z0-9][a-z0-9-]{0,31}:/i.test(entityId)) {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(entityId)
  } catch {
    return `entityId: "${entityId}" must be an absolute URI (https URL or urn:)`
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `entityId: "${entityId}" must be an http(s) URL or a urn:`
  }
  return null
}

const LOCALHOST_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]']

/**
 * Stricter than `redirectUriProblem`, deliberately. An OIDC redirect target
 * is protected downstream by the authorization code exchange; a SAML ACS URL
 * receives the SIGNED ASSERTION ITSELF, so a wrong destination is not a
 * detour — it is the credential delivered to the attacker. Hence: https
 * required (http only for the localhost forms, for local SP development),
 * and NO wildcards anywhere — SAML has no wildcard semantics, so a `*` here
 * is either a typo or an attempt to widen the destination set.
 */
export function acsUrlProblem(uri: string): string | null {
  if (uri.includes(WILDCARD)) {
    return `acsUrls: "${uri}" contains a wildcard — SAML has no wildcard matching; list every ACS URL exactly`
  }

  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return `acsUrls: "${uri}" is not a valid absolute URL`
  }

  if (parsed.protocol === 'http:') {
    if (!LOCALHOST_HOSTNAMES.includes(parsed.hostname === '::1' ? '[::1]' : parsed.hostname)) {
      return `acsUrls: "${uri}" must use https — an assertion posted over http is readable in transit (http is permitted only for localhost)`
    }
    return null
  }
  if (parsed.protocol !== 'https:') {
    return `acsUrls: "${uri}" must use https`
  }
  return null
}

/**
 * Shape only — this does not verify the certificate chains, is unexpired, or
 * even parses as X.509; Keycloak rejects garbage base64 on its side and the
 * sync surfaces that as a dead letter an operator can see. What IS rejected
 * here is the pastes that LOOK right and fail later confusingly: a private
 * key (which must never be sent to us at all), a PEM with the wrong block
 * label, or a mangled body.
 */
export function pemCertificateProblem(pem: string): string | null {
  if (/PRIVATE KEY/.test(pem)) {
    return 'spCertificate: contains a PRIVATE KEY block — the SP must keep its private key; only the certificate belongs here'
  }
  const match = /^-----BEGIN CERTIFICATE-----\r?\n([\s\S]+?)\r?\n-----END CERTIFICATE-----\s*$/.exec(
    pem.trim(),
  )
  if (match === null) {
    return 'spCertificate: must be one PEM certificate — a base64 body between "-----BEGIN CERTIFICATE-----" and "-----END CERTIFICATE-----"'
  }
  const body = match[1].replace(/\s+/g, '')
  if (body.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
    return 'spCertificate: the PEM body is not valid base64'
  }
  return null
}
