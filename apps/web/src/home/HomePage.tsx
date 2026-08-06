import { useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { apiBaseUrl } from '../auth/oidc-config'

interface Principal {
  subject: string
  username: string
  email: string | null
}

/**
 * The original landing page content (Milestone 1). Unchanged in behaviour
 * from before Milestone 6 — the `signed-in-as`/`me-username` test ids below
 * are what e2e/login.spec.ts already asserts on, so this component's output
 * must keep matching that shape exactly. The "Sign out" control that used to
 * live here moved to the shared nav in App.tsx (Milestone 6, Task 4), since
 * it now needs to be reachable from every route, not just this one.
 */
export default function HomePage() {
  const auth = useAuth()
  const [principal, setPrincipal] = useState<Principal | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!auth.isAuthenticated || auth.user == null) {
      setPrincipal(null)
      return
    }

    void fetch(`${apiBaseUrl}/me`, {
      headers: { Authorization: `Bearer ${auth.user.access_token}` },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`API returned ${res.status}`)
        setPrincipal((await res.json()) as Principal)
      })
      .catch((cause: Error) => setError(cause.message))
  }, [auth.isAuthenticated, auth.user])

  return (
    <main>
      <h1>Identity Manager</h1>
      <p>
        Signed in as{' '}
        <strong data-testid="signed-in-as">{auth.user?.profile.preferred_username}</strong>
      </p>

      {error !== null && <p role="alert">Could not reach the API: {error}</p>}

      {principal !== null && (
        <dl>
          <dt>API says username</dt>
          <dd data-testid="me-username">{principal.username}</dd>
          <dt>Subject</dt>
          <dd data-testid="me-subject">{principal.subject}</dd>
        </dl>
      )}
    </main>
  )
}
