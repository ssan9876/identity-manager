/**
 * Secret resolution — decision 4 (docs/archive/specs/2026-08-06-
 * directory-connectors-design.md): `connector_targets.config` stores a
 * secret's NAME, never its value. The value resolves from the environment
 * AT THE POINT OF USE, every time — never cached beyond one call, never
 * written back to any table, never returned by any endpoint, never logged,
 * never included in an error message or stack trace.
 *
 * This is the ONLY function in this codebase that may read a connector's
 * credential out of `process.env`. Every connector implementation goes
 * through it rather than reading `process.env` directly, so the "never log
 * it, never persist it" guarantee has exactly ONE place to hold, not one per
 * connector, and one place to audit rather than N. See
 * apps/api/test/connector-secrets.spec.ts for the sentinel-value proof that
 * this actually holds — a test that seeds a recognisable value into the
 * environment and greps every response, log line and thrown error for it.
 */

/**
 * Thrown when a connector's configured secret name has no value in the
 * environment. The message names the SECRET'S NAME (the admin-facing,
 * non-sensitive half of decision 4 — an operator needs to know WHICH
 * environment variable to set) and NEVER the value, because there is no
 * value to include — that is exactly the failure this error reports.
 * `secretName` is exposed as a field (not just interpolated into the
 * message) so a caller can build its OWN actionable message without
 * re-parsing this one.
 */
export class MissingSecretError extends Error {
  constructor(public readonly secretName: string) {
    super(
      `secret "${secretName}" is not set in the environment — set it (e.g. in .env) before this connector can authenticate`,
    )
    this.name = 'MissingSecretError'
  }
}

/**
 * Resolves `secretName` from `env` (defaults to the real `process.env`;
 * overridable so a test can pass a synthetic map instead of mutating the
 * real process environment). Treats an EMPTY string the same as "unset" —
 * `FOO=` in a `.env` file is almost always an accident, not a deliberately
 * blank credential, and treating it as present would let a connector
 * "successfully" authenticate with nothing, which is a worse failure mode
 * than a clean, actionable MissingSecretError.
 */
/**
 * The ONLY environment variable names a connector may resolve.
 *
 * Security audit, CRITICAL (0 of 6 adversarial verifiers could refute it).
 * `connector_targets.config` is admin-editable and names the environment
 * variable to read, and it ALSO names the destination host. With no
 * constraint on the name, a holder of `connector:manage` could set
 * `credentialSecretName` to `DATABASE_URL`, `RUNTIME_DATABASE_URL` or
 * `KEYCLOAK_ADMIN_CLIENT_SECRET`, point the target's base URL at a host they
 * control, and receive that value in an `Authorization: Bearer` header —
 * turning connector configuration into an exfiltration primitive for any
 * secret in the process environment. `healthDetail`, which surfaces the
 * response, made it a convenient oracle too.
 *
 * Namespacing is what makes that structurally impossible rather than merely
 * discouraged: a connector can only ever reach a variable deliberately
 * marked as connector-scoped, so the database URL and the Keycloak client
 * secret are unreachable no matter what an operator types into the console.
 *
 * It also closes a fail-open the audit flagged separately: `env[name]` walks
 * the prototype chain, so `hasOwnProperty` (or `__proto__`,
 * `isPrototypeOf`, …) resolved to an inherited FUNCTION — truthy, non-empty,
 * and duly sent as a credential. This project has been bitten by
 * prototype-chain lookups three times before (see authz/actions.ts). The
 * pattern rejects every one of those names, so the check below never
 * indexes with an inherited key at all.
 */
// The PREFIX carries the security property; case in the remainder does not.
// Requiring uppercase throughout would reject a legitimate `CONNECTOR_myVar`
// for no benefit, while `DATABASE_URL` and `hasOwnProperty` are excluded
// either way.
const CONNECTOR_SECRET_NAME = /^CONNECTOR_[A-Za-z0-9_]+$/

/** Thrown when a connector's configured secret name is not connector-scoped. Distinct from `MissingSecretError`: the variable may well exist, and that is precisely the problem. */
export class ForbiddenSecretNameError extends Error {
  constructor(public readonly secretName: string) {
    super(
      `secret name "${secretName}" is not permitted — a connector may only read environment ` +
        `variables named CONNECTOR_*. This is deliberate: connector configuration is ` +
        `admin-editable and also chooses the destination host, so an unrestricted name would ` +
        `let any process secret be sent to an arbitrary server.`,
    )
    this.name = 'ForbiddenSecretNameError'
  }
}

export function resolveSecret(secretName: string, env: NodeJS.ProcessEnv = process.env): string {
  // Validate BEFORE indexing, so a prototype-chain key is never even looked up.
  if (!CONNECTOR_SECRET_NAME.test(secretName)) {
    throw new ForbiddenSecretNameError(secretName)
  }
  // `Object.hasOwn` as well as the pattern: belt and braces, and it makes the
  // "own property only" intent explicit at the point of access.
  const value = Object.hasOwn(env, secretName) ? env[secretName] : undefined
  if (value === undefined || value.length === 0) {
    throw new MissingSecretError(secretName)
  }
  return value
}
