import { useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Route, Routes } from 'react-router-dom'
import AttributeDefinitionsPage from './attributes/AttributeDefinitionsPage'
import AuditPage from './audit/AuditPage'
import BusinessRoleDetailPage from './business-roles/BusinessRoleDetailPage'
import BusinessRolesPage from './business-roles/BusinessRolesPage'
import MiningPage from './business-roles/MiningPage'
import ConnectorsListPage from './connectors/ConnectorsListPage'
import DataFlowsPage from './connectors/DataFlowsPage'
import CreateSsoAppPage from './sso-apps/CreateSsoAppPage'
import SsoAppDetailPage from './sso-apps/SsoAppDetailPage'
import SsoAppsListPage from './sso-apps/SsoAppsListPage'
import TargetDetailPage from './connectors/TargetDetailPage'
import CreateGroupPage from './groups/CreateGroupPage'
import EditGroupPage from './groups/EditGroupPage'
import GroupDetailPage from './groups/GroupDetailPage'
import GroupsListPage from './groups/GroupsListPage'
import HrSourcesPage from './hr/HrSourcesPage'
import ImportPage from './imports/ImportPage'
import CreateUserPage from './people/CreateUserPage'
import EditUserPage from './people/EditUserPage'
import PeopleListPage from './people/PeopleListPage'
import PersonDetailPage from './people/PersonDetailPage'
import OrgUnitsPage from './org-units/OrgUnitsPage'
import OrganizationsPage from './organizations/OrganizationsPage'
import RecertCampaignDetailPage from './recertification/RecertCampaignDetailPage'
import RecertificationPage from './recertification/RecertificationPage'
import RolesCatalogPage from './roles/RolesCatalogPage'
import ApprovalsPage from './self-service/ApprovalsPage'
import SelfServicePage from './self-service/SelfServicePage'
import AppShell from './shell/AppShell'
import { BRAND, BrandLockup, BrandMark } from './brand'
import { keycloakIssuer } from './auth/oidc-config'
import { ToastProvider } from './shell/ToastProvider'
import './SignInGate.css'

/**
 * Top-level shell: the authentication gate (unchanged since Milestone 1 —
 * still just a "Sign in" button, Keycloak's own hosted login page does the
 * rest), then — once authenticated — the admin console. docs/product-brief.md bans "the
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
 * Milestone 8, Task 4 adds Groups (list/detail/create/edit, membership,
 * nesting) and Roles (a catalog page plus per-person grant/revoke on
 * PersonDetailPage's own Roles tab — see PersonRolesTab.tsx) — so `/groups*`
 * and `/roles` move out of NOT_YET_BUILT_ROUTES too, the same way
 * `/org-units` did in Task 3. `/groups/new` is declared before `/groups/:id`
 * for the identical documentation-only reason `/people/new` precedes
 * `/people/:id` above.
 *
 * Milestone 8, Task 5 adds Import (CSV preview/commit) and Audit (the
 * searchable log, plus a Dead letters tab) — the last two NOT_YET_BUILT
 * placeholders (task-2-brief.md's "an honest 'coming in a later task' panel,
 * never a dead link") become real routes here, closing out the milestone.
 * Each page still gates its OWN content behind the matching permission
 * (`user:create` for Import, `audit:read` for Audit) with an explanatory
 * message when absent — the same pattern OrgUnitsPage/PersonRolesTab already
 * established — so a caller who reaches either route directly (typed URL,
 * bookmark) without the grant sees why, never a bare 403 or a silent empty
 * screen.
 *
 * `ToastProvider` wraps `<Routes>`, not any single page — docs/design-system.md's
 * "Toasts for the result of an action" must survive the navigation an
 * action often triggers (e.g. deactivating from the detail page keeps that
 * page; creating a user redirects to the new record's own detail page),
 * which it cannot do mounted any lower.
 *
 * Milestone 14, Task 9 adds the connector admin console: `/connectors`
 * (target list + the attribute mapping editor, tabbed like Audit's own Log/
 * Dead letters pair) and `/connectors/:target` (per-target configuration,
 * dead letters, and dry-run/apply). Gated on `connector:read`/
 * `connector:manage`, the same "hide what the caller cannot do; the API
 * still decides" posture every other route here already follows.
 */
export default function App() {
  const auth = useAuth()
  const [signInError, setSignInError] = useState<string | null>(null)

  /**
   * The original handler was `() => void auth.signinRedirect()`. `void`
   * discards the promise, so a failed sign-in produced NOTHING: no console
   * error, no UI, no navigation. The button just sat there — the least
   * diagnosable failure a login screen can have, and it cost a full
   * debugging session against real hardware to find.
   *
   * The failure is nearly always about REACHING the issuer rather than about
   * the user. oidc-client-ts fetches `.well-known/openid-configuration` from
   * the authority before it can build the authorize URL, so an untrusted
   * certificate, a down IdP, and a wrong issuer all surface here — and the
   * browser reports all three as an opaque "Failed to fetch".
   *
   * `auth.error` is what actually carries that failure, and awaiting this
   * call is NOT enough on its own: react-oidc-context catches internally and
   * dispatches to its own error state, so `signinRedirect()` settles without
   * throwing and a `try`/`catch` here never runs. Verified in a browser by
   * forcing the metadata fetch to reject — the catch below did not fire, no
   * unhandledrejection was raised, and the screen stayed blank. The catch is
   * kept only for a synchronous throw before the library's own boundary;
   * `auth.error` is the path that actually reports the common case.
   */
  async function startSignIn(): Promise<void> {
    setSignInError(null)
    try {
      await auth.signinRedirect()
    } catch (error) {
      setSignInError(error instanceof Error ? error.message : String(error))
    }
  }

  const signInFailure = signInError ?? auth.error?.message ?? null

  if (auth.isLoading) {
    return (
      <main className="signin-gate signin-gate--centred">
        <div className="signin-gate__loading">
          <BrandLockup />
          <p className="signin-gate__loading-text" role="status">
            Checking your session…
          </p>
        </div>
      </main>
    )
  }

  if (!auth.isAuthenticated) {
    return (
      /*
       * The one Committed surface in an otherwise Restrained product: a
       * drenched brand panel beside the actual sign-in card. This screen
       * is the only moment the console is a BRAND rather than a tool —
       * nobody is mid-task here, they are arriving — so it is also the
       * only place --brand-panel and the display type steps are allowed.
       * Under 900px the two columns stack and the panel becomes a compact
       * header band; it is never hidden, because it carries the <h1>.
       */
      <main className="signin-gate">
        <section className="signin-gate__brand">
          <h1 className="signin-gate__wordmark">
            <BrandLockup size="lg" />
          </h1>
          <p className="signin-gate__tagline">{BRAND.tagline}</p>
          <ul className="signin-gate__points">
            <li>One record per person, from the first day to the last.</li>
            <li>Roles and group membership that follow the org, not a ticket.</li>
            <li>Every change written down, and pushed to the systems that matter.</li>
          </ul>
          {/* Purely ornamental: the mark, oversized and set at low opacity,
              bleeding off the corner. aria-hidden by default (BrandMark),
              pointer-events off, and it never overlaps live text. */}
          <BrandMark className="signin-gate__watermark" />
        </section>

        <section className="signin-gate__panel">
          <div className="signin-gate__card">
            <h2 className="signin-gate__heading">Sign in</h2>
            <p className="signin-gate__hint">
              Use your organisation account. {BRAND.name} does not hold your password —
              your identity provider does.
            </p>
            <button
              type="button"
              className="btn btn--primary signin-gate__submit"
              onClick={() => void startSignIn()}
            >
              Sign in
            </button>
            {signInFailure !== null && (
              <div className="signin-gate__error" role="alert">
                <p>
                  Could not reach the sign-in service at <code>{keycloakIssuer}</code>.
                </p>
                <p>
                  If it uses a self-signed certificate, open that address in this browser
                  once and accept the certificate, then try again.
                </p>
                <p className="signin-gate__error-detail">{signInFailure}</p>
              </div>
            )}
          </div>
        </section>
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
          <Route path="/groups" element={<GroupsListPage />} />
          <Route path="/groups/new" element={<CreateGroupPage />} />
          <Route path="/groups/:id" element={<GroupDetailPage />} />
          <Route path="/groups/:id/edit" element={<EditGroupPage />} />
          <Route path="/roles" element={<RolesCatalogPage />} />
          <Route path="/business-roles" element={<BusinessRolesPage />} />
          {/* Static before dynamic, though the router ranks them anyway: /mining is a page, not a role id. */}
          <Route path="/business-roles/mining" element={<MiningPage />} />
          <Route path="/business-roles/:id" element={<BusinessRoleDetailPage />} />
          <Route path="/recertification" element={<RecertificationPage />} />
          <Route path="/recertification/:id" element={<RecertCampaignDetailPage />} />
          <Route path="/attributes" element={<AttributeDefinitionsPage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/applications" element={<SsoAppsListPage />} />
          <Route path="/applications/new" element={<CreateSsoAppPage />} />
          <Route path="/applications/:id" element={<SsoAppDetailPage />} />
          <Route path="/organizations" element={<OrganizationsPage />} />
          <Route path="/connectors" element={<ConnectorsListPage />} />
          <Route path="/connectors/:target" element={<TargetDetailPage />} />
          <Route path="/data-flows" element={<DataFlowsPage />} />
          <Route path="/hr-sources" element={<HrSourcesPage />} />
          <Route path="/self" element={<SelfServicePage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
        </Route>
      </Routes>
    </ToastProvider>
  )
}
