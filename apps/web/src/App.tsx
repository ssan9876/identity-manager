import { useAuth } from 'react-oidc-context'
import { Link, Route, Routes } from 'react-router-dom'
import HomePage from './home/HomePage'
import SelfServicePage from './self-service/SelfServicePage'

/**
 * Top-level shell: the authentication gate (unchanged from Milestone 1 —
 * still just a "Sign in" button, Keycloak's own hosted login page does the
 * rest) plus, once authenticated, the route table. `/` keeps its original
 * content (HomePage); `/self` is the self-service portal added in
 * Milestone 6, Task 4.
 */
export default function App() {
  const auth = useAuth()

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
    <>
      <nav aria-label="Primary">
        <Link to="/">Home</Link>
        {' | '}
        <Link to="/self">My Profile</Link>
        {' | '}
        <button type="button" onClick={() => void auth.signoutRedirect()}>
          Sign out
        </button>
      </nav>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/self" element={<SelfServicePage />} />
      </Routes>
    </>
  )
}
