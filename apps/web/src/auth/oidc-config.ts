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
  /**
   * DO NOT move this to `localStorage` without reading this first.
   *
   * `sessionStorage` is scoped per-origin AND per top-level browsing context,
   * which is currently the only thing preventing clickjacking of this console:
   * a framed instance gets a fresh, empty store and therefore renders the
   * sign-in gate rather than an authenticated page. `localStorage` is shared
   * across contexts, so the framed instance would render as the signed-in
   * administrator and every "keep me signed in" request turns clickjacking of
   * an identity provider's admin console live in one line.
   *
   * The anti-framing header is now actually delivered (finding CS-M1 —
   * deploy/nginx/*.conf were silently dropping it), so this is defence in
   * depth rather than the sole control it used to be. It is still the reason
   * the window between those two states was not exploitable.
   */
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),

  /**
   * Finding SEC-L1. `stateStore` is SEPARATE from `userStore` and defaults
   * to `localStorage`, so leaving it unset persisted the PKCE
   * `code_verifier` and the `nonce` across browser restarts — long-lived
   * on-disk artefacts of an in-flight login that should not outlive the
   * tab that started it. Setting both to sessionStorage keeps the whole
   * auth surface in one storage tier rather than two.
   */
  stateStore: new WebStorageStateStore({ store: window.sessionStorage }),

  /**
   * Finding CS-L2. Defaults to `false`, which leaves the refresh token relying
   * on Keycloak's session teardown rather than being explicitly revoked. This
   * does NOT and cannot revoke an already-issued access token: that is a
   * stateless JWT and `JwtGuard` verifies it by signature and `exp` against
   * JWKS, so a captured one stays valid until it expires. Keep realm access
   * token lifetime short; this closes the refresh token only.
   */
  revokeTokensOnSignout: true,
}
