import { useAuth } from 'react-oidc-context'
import { Route, Routes } from 'react-router-dom'
import CreateUserPage from './people/CreateUserPage'
import EditUserPage from './people/EditUserPage'
import PeopleListPage from './people/PeopleListPage'
import PersonDetailPage from './people/PersonDetailPage'
import OrgUnitsPage from './org-units/OrgUnitsPage'
import SelfServicePage from './self-service/SelfServicePage'
import AppShell from './shell/AppShell'
import { NotYetBuilt } from './shell/NotYetBuilt'
import { ToastProvider } from './shell/ToastProvider'
import './SignInGate.css'

const NOT_YET_BUILT_ROUTES: { path: string; title: string; note: string }[] = [
  {
    path: '/groups',
    title: 'Groups',
    note: 'Group management arrives in a later task of this milestone.',
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
 * rest), then — once authenticated — the admin console. PRODUCT.md bans "the
 * SaaS dashboard opener": this product "opens onto a list of people, because
 * that is the job", so `/` and `/people` both render PeopleListPage directly
 * rather than routing through a separate placeholder landing page first.
 * `/self` (Milestone 6) now renders inside the same AppShell as everything
 * else, reachable from the top bar's "My Profile" link on every screen.
 *
 * `/people/new` is declared BEFORE `/people/:id` on purpose, even though
 * react-router v6+'s ranking algorithm scores a static segment above a
 * dynamic one regardless of source order (so `:id` would never actually
 * swallow the literal "new") — the explicit order documents that intent
 * for a human reader rather than relying on a reader already knowing the
 * router's ranking rules.
 *
 * Milestone 8, Task 3 adds writes: create/edit/deactivate for People, and
 * the Org units tree/create-child/detail (`OrgUnitsPage`) — so `/org-units`
 * moves out of NOT_YET_BUILT_ROUTES below and into a real route.
 *
 * Every nav destination still not built (Groups, Roles, Import, Audit)
 * keeps a real route — an honest "coming in a later task" panel, never a
 * dead link (task-2-brief.md) — gated by the SAME permission the nav item
 * itself is gated by (shell/nav-items.tsx); a caller who reaches one of
 * these routes directly (typed URL, bookmark) without the underlying
 * permission sees the identical panel regardless, since there is no data
 * behind any of them yet to protect either way.
 *
 * `ToastProvider` wraps `<Routes>`, not any single page — DESIGN.md's
 * "Toasts for the result of an action" must survive the navigation an
 * action often triggers (e.g. deactivating from the detail page keeps that
 * page; creating a user redirects to the new record's own detail page),
 * which it cannot do mounted any lower.
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
    <ToastProvider>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<PeopleListPage />} />
          <Route path="/people" element={<PeopleListPage />} />
          <Route path="/people/new" element={<CreateUserPage />} />
          <Route path="/people/:id" element={<PersonDetailPage />} />
          <Route path="/people/:id/edit" element={<EditUserPage />} />
          <Route path="/org-units" element={<OrgUnitsPage />} />
          <Route path="/org-units/:id" element={<OrgUnitsPage />} />
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
    </ToastProvider>
  )
}
