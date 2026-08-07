import { useAuth } from 'react-oidc-context'
import { Route, Routes } from 'react-router-dom'
import PeopleListPage from './people/PeopleListPage'
import PersonDetailPage from './people/PersonDetailPage'
import SelfServicePage from './self-service/SelfServicePage'
import AppShell from './shell/AppShell'
import { NotYetBuilt } from './shell/NotYetBuilt'
import './SignInGate.css'

const NOT_YET_BUILT_ROUTES: { path: string; title: string; note: string }[] = [
  {
    path: '/groups',
    title: 'Groups',
    note: 'Group management arrives in a later task of this milestone.',
  },
  {
    path: '/org-units',
    title: 'Org units',
    note: 'The org-unit tree and detail pane arrive in a later task of this milestone.',
  },
  {
    path: '/roles',
    title: 'Roles',
    note: 'Granting and revoking role assignments arrives in a later task of this milestone.',
  },
  {
    path: '/import',
    title: 'Import',
    note: 'Bulk CSV import with a preview-before-commit safety rail arrives in a later task of this milestone.',
  },
  {
    path: '/audit',
    title: 'Audit',
    note: 'The searchable audit log arrives in a later task of this milestone.',
  },
]

/**
 * Top-level shell: the authentication gate (unchanged since Milestone 1 —
 * still just a "Sign in" button, Keycloak's own hosted login page does the
 * rest), then — once authenticated — the admin console (Milestone 8, Task
 * 2). PRODUCT.md bans "the SaaS dashboard opener": this product "opens onto
 * a list of people, because that is the job", so `/` and `/people` both
 * render PeopleListPage directly rather than routing through a separate
 * placeholder landing page first. `/self` (Milestone 6) now renders inside
 * the same AppShell as everything else, reachable from the top bar's "My
 * Profile" link on every screen.
 *
 * Every nav destination this milestone doesn't build yet (Groups, Org
 * units, Roles, Import, Audit) still has a real route — an honest "coming
 * in a later task" panel, never a dead link (task-2-brief.md) — gated by
 * the SAME permission the nav item itself is gated by (shell/nav-items.tsx);
 * a caller who reaches one of these routes directly (typed URL, bookmark)
 * without the underlying permission sees the identical panel regardless,
 * since there is no data behind any of them yet to protect either way.
 */
export default function App() {
  const auth = useAuth()

  if (auth.isLoading) {
    return (
      <main className="signin-gate">
        <p className="signin-gate--loading">Loading…</p>
      </main>
    )
  }

  if (!auth.isAuthenticated) {
    return (
      <main className="signin-gate">
        <div className="signin-gate__panel">
          <h1 className="text-title">Identity Manager</h1>
          <p className="signin-gate__hint">Sign in with your organisation account to continue.</p>
          <button type="button" className="btn btn--primary" onClick={() => void auth.signinRedirect()}>
            Sign in
          </button>
        </div>
      </main>
    )
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<PeopleListPage />} />
        <Route path="/people" element={<PeopleListPage />} />
        <Route path="/people/:id" element={<PersonDetailPage />} />
        <Route path="/self" element={<SelfServicePage />} />
        {NOT_YET_BUILT_ROUTES.map((route) => (
          <Route
            key={route.path}
            path={route.path}
            element={<NotYetBuilt title={route.title} note={route.note} />}
          />
        ))}
      </Route>
    </Routes>
  )
}
