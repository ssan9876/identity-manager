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
