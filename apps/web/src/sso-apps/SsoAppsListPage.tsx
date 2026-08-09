import { useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link } from 'react-router-dom'
import { ApiError } from '../api/client'
import { BRAND } from '../brand'
import { EnabledBadge } from '../connectors/badges'
import { useSelfPermissions } from '../shell/permissions'
import { fetchSsoApps, type SsoApp } from './api'
import './SsoApps.css'

export default function SsoAppsListPage() {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const perms = useSelfPermissions()
  const canManage = perms.status === 'ready' && perms.actions.has('sso_app:manage')

  const [apps, setApps] = useState<SsoApp[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (accessToken === undefined) return
    let cancelled = false

    fetchSsoApps(accessToken)
      .then((rows) => {
        if (!cancelled) setApps(rows)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Could not load applications')
      })

    return () => {
      cancelled = true
    }
  }, [accessToken])

  return (
    <section className="page">
      <header className="page__header">
        <div>
          <h1>Applications</h1>
          <p className="page__subtitle">
            Applications registered for single sign-on. {BRAND.name} masters these and
            asserts them into Keycloak.
          </p>
        </div>
        {canManage && (
          <Link className="btn btn--primary" to="/applications/new">
            Register application
          </Link>
        )}
      </header>

      {error && (
        <p className="banner banner--error" role="alert">
          {error}
        </p>
      )}

      {apps === null && !error && <p className="muted">Loading…</p>}

      {apps !== null && apps.length === 0 && (
        <p className="muted" data-testid="sso-apps-empty">
          No applications registered yet.
        </p>
      )}

      {apps !== null && apps.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Client ID</th>
              <th scope="col">Type</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {apps.map((app) => (
              <tr key={app.id}>
                <td>
                  <Link to={`/applications/${app.id}`} data-row-link="true">
                    {app.name}
                  </Link>
                </td>
                <td>
                  <code>{app.clientId}</code>
                </td>
                <td>{app.publicClient ? 'Public (PKCE)' : 'Confidential'}</td>
                <td>
                  <EnabledBadge enabled={app.enabled} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
