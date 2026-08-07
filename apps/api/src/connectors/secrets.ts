/**
 * Secret resolution — decision 4 (docs/superpowers/specs/2026-08-06-
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
export function resolveSecret(secretName: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[secretName]
  if (value === undefined || value.length === 0) {
    throw new MissingSecretError(secretName)
  }
  return value
}
