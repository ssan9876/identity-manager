import { useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { apiBaseUrl } from './auth/oidc-config'

interface Principal {
  subject: string
  username: string
  email: string | null
}

export default function App() {
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

  if (auth.isLoading) {
    return <p>Loading…</p>
  }

  if (!auth.isAuthenticated) {
    return (
      <main>
        <h1>Identity Manager</h1>
        <button type="button" onClick={() => void auth.signinRedirect()}>
          Sign in
        </button>
      </main>
    )
  }

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

      <button type="button" onClick={() => void auth.signoutRedirect()}>
        Sign out
      </button>
    </main>
  )
}
