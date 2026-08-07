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

/**
 * Deliberately carries NO `onSigninCallback` — that has to be supplied by
 * `AuthRoot` (auth/AuthRoot.tsx) instead, as a value produced by
 * react-router's own `useNavigate()`, which only exists inside a component
 * rendered under `<BrowserRouter>`. This file is plain, router-free
 * configuration (imported by AuthRoot, by main.tsx indirectly, and by
 * anything else that just needs the issuer/client id), so it cannot supply
 * that callback itself. See AuthRoot's own doc comment for why the callback
 * has to come from there at all — a real, Milestone-1-era bug this fixes.
 */
export const oidcConfig: AuthProviderProps = {
  authority: keycloakIssuer,
  client_id: import.meta.env.VITE_KEYCLOAK_CLIENT_ID,
  redirect_uri: `${window.location.origin}/`,
  post_logout_redirect_uri: `${window.location.origin}/`,
  response_type: 'code',
  scope: 'openid profile email',
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
}
