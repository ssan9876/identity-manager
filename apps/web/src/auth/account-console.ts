import { keycloakIssuer } from './oidc-config'

/**
 * Keycloak serves its own Account Console (password, MFA/OTP enrolment,
 * device sessions) at `${issuer}/account` for any realm. Derived from the
 * SAME issuer URL the OIDC client already signs in against
 * (`keycloakIssuer`, i.e. `VITE_KEYCLOAK_ISSUER`) rather than a second,
 * independently configured URL that could silently drift out of sync with
 * it.
 *
 * Credential management is a DEEP LINK to this page, never a
 * reimplementation (task-4-brief.md) — there is no password input and no
 * MFA enrolment UI anywhere in this codebase. That is mechanically enforced
 * by e2e/no-password-input.spec.ts, not merely a convention to remember.
 */
export function accountConsoleUrl(): string {
  if (keycloakIssuer === undefined || keycloakIssuer === '') {
    throw new Error('VITE_KEYCLOAK_ISSUER is not configured — cannot derive the Account Console URL')
  }
  return `${keycloakIssuer.replace(/\/+$/, '')}/account`
}
