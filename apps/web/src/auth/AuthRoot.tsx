import type { ReactNode } from 'react'
import type { User } from 'oidc-client-ts'
import { AuthProvider } from 'react-oidc-context'
import { useNavigate } from 'react-router-dom'
import { oidcConfig } from './oidc-config'

/**
 * A PRE-EXISTING BUG, found by Task 3 and fixed here: `AuthProvider`'s
 * `onSigninCallback` used to be a plain function on the static `oidcConfig`
 * object (oidc-config.ts) that called `window.history.replaceState`
 * directly, to strip the `?state=&code=` query string Keycloak's redirect
 * leaves behind. That bypasses react-router's OWN history abstraction:
 * `pushState`/`replaceState` never fire a `popstate` event, so react-
 * router's internal notion of "current location" can be left out of sync
 * with the real URL the instant that direct call runs. The next
 * `useSearchParams`-driven update ANYWHERE in the app (e.g. a filter
 * `<select>`) then merges onto that stale internal location instead of the
 * real one, resurrecting the old OIDC params back into the URL. Confirmed
 * independent of any one screen — task-3-report.md reproduced it on Task
 * 2's own, unmodified People-list org-unit filter.
 *
 * The fix: let react-router do the URL update itself, via its own
 * `useNavigate()`, so its internal location is what actually changes —
 * there is nothing left to desync. `useNavigate` only exists inside a
 * component rendered under `<BrowserRouter>`, which is why this can't just
 * live in oidc-config.ts's plain object: it has to be a component. This one
 * renders `<AuthProvider>` itself (rather than, say, a hook returning the
 * callback for main.tsx to pass down) so `oidcConfig`'s other fields and
 * this one extra prop stay defined in exactly one place — main.tsx just
 * nests `<AuthRoot>` where `<AuthProvider {...oidcConfig}>` used to sit,
 * inside `<BrowserRouter>` and around `<App />` unchanged.
 *
 * `replace: true` preserves the original's own intent (a redirect callback
 * URL should not become a back-button stop), and `user?.state` is honoured
 * as the redirect target when present (nothing in this codebase sets it
 * today — `App.tsx`'s sign-in button calls plain `signinRedirect()` — but
 * respecting it costs nothing and is what `state` is FOR, per
 * react-oidc-context's own contract), falling back to the current pathname
 * exactly as the old direct call did.
 */
export function AuthRoot({ children }: { children: ReactNode }) {
  const navigate = useNavigate()

  function onSigninCallback(user: User | void): void {
    const state = user?.state as { path?: string } | null | undefined
    navigate(state?.path ?? window.location.pathname, { replace: true })
  }

  return (
    <AuthProvider {...oidcConfig} onSigninCallback={onSigninCallback}>
      {children}
    </AuthProvider>
  )
}
