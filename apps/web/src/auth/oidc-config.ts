import { WebStorageStateStore } from 'oidc-client-ts'
import type { AuthProviderProps } from 'react-oidc-context'

export const apiBaseUrl =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000'

/**
 * The single canonical read of `VITE_KEYCLOAK_ISSUER`, as an unambiguous
 * `string`. `oidcConfig` below also carries this value (as `authority`),
 * but `AuthProviderProps` is a union type where `authority` exists on only
 * one branch — reading `oidcConfig.authority` back out from elsewhere does
 * not type-check (TS2339) even though the value is always present at
 * runtime. account-console.ts (Milestone 6, Task 4) needs this same issuer
 * URL to derive Keycloak's Account Console link, so it imports THIS
 * constant instead of reaching into `oidcConfig`.
 */
export const keycloakIssuer: string = import.meta.env.VITE_KEYCLOAK_ISSUER

export const oidcConfig: AuthProviderProps = {
  authority: keycloakIssuer,
  client_id: import.meta.env.VITE_KEYCLOAK_CLIENT_ID,
  redirect_uri: `${window.location.origin}/`,
  post_logout_redirect_uri: `${window.location.origin}/`,
  response_type: 'code',
  scope: 'openid profile email',
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  // Strip the ?code=&state= query params after the redirect completes.
  onSigninCallback: () => {
    window.history.replaceState({}, document.title, window.location.pathname)
  },
}
