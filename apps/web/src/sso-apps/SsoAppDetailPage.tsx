import { useCallback, useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useParams } from 'react-router-dom'
import { ApiError } from '../api/client'
import { EnabledBadge } from '../connectors/badges'
import { useSelfPermissions } from '../shell/permissions'
import { SecretModal } from './SecretModal'
import { fetchSsoApp, mintClientSecret, setSsoAppEnabled, type SsoApp } from './api'
import './SsoApps.css'

export default function SsoAppDetailPage() {
  const { id } = useParams<{ id: string }>()
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const perms = useSelfPermissions()
  const canManage = perms.status === 'ready' && perms.actions.has('sso_app:manage')

  const [app, setApp] = useState<SsoApp | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (accessToken === undefined || id === undefined) return
    try {
      setApp(await fetchSsoApp(accessToken, id))
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'Could not load the application')
    }
  }, [accessToken, id])

  useEffect(() => {
    void load()
  }, [load])

  async function toggleEnabled() {
    if (accessToken === undefined || app === null || busy) return
    setBusy(true)
    setError(null)
    try {
      setApp(await setSsoAppEnabled(accessToken, app.id, !app.enabled))
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'Could not change the status')
    } finally {
      setBusy(false)
    }
  }

  async function mint() {
    if (accessToken === undefined || app === null || busy) return
    setBusy(true)
    setError(null)
    try {
      const { secret: minted } = await mintClientSecret(accessToken, app.id)
      setSecret(minted)
    } catch (err: unknown) {
      // The 409s are the informative ones: "has not synced to Keycloak yet"
      // and "is a public client". Rendered verbatim.
      setError(err instanceof ApiError ? err.message : 'Could not generate a client secret')
    } finally {
      setBusy(false)
    }
  }

  if (error !== null && app === null) {
    return (
      <section className="page">
        <p className="banner banner--error" role="alert">
          {error}
        </p>
        <Link to="/applications">Back to applications</Link>
      </section>
    )
  }

  if (app === null) {
    return (
      <section className="page">
        <p className="muted">Loading…</p>
      </section>
    )
  }

  return (
    <section className="page">
      <header className="page__header">
        <div>
          <h1>{app.name}</h1>
          <p className="page__subtitle">
            <code>{app.clientId}</code> · {app.publicClient ? 'Public client (PKCE)' : 'Confidential client'}
          </p>
        </div>
        <EnabledBadge enabled={app.enabled} />
      </header>

      {error && (
        <p className="banner banner--error" role="alert">
          {error}
        </p>
      )}

      <dl className="detail-grid detail-grid--labelled">
        <dt>Description</dt>
        <dd>{app.description || <span className="muted">None</span>}</dd>

        <dt>Redirect URIs</dt>
        <dd>
          <ul className="plain-list">
            {app.redirectUris.map((uri) => (
              <li key={uri}>
                <code>{uri}</code>
              </li>
            ))}
          </ul>
        </dd>

        <dt>Web origins</dt>
        <dd>
          {app.webOrigins.length === 0 ? (
            <span className="muted">None</span>
          ) : (
            <ul className="plain-list">
              {app.webOrigins.map((origin) => (
                <li key={origin}>
                  <code>{origin}</code>
                </li>
              ))}
            </ul>
          )}
        </dd>

        <dt>Group membership claim</dt>
        <dd>{app.groupsClaim ? 'Included as "groups"' : 'Not included'}</dd>
      </dl>

      {canManage && (
        <div className="page__actions">
          <button type="button" className="btn" onClick={toggleEnabled} disabled={busy}>
            {app.enabled ? 'Disable' : 'Enable'}
          </button>

          {/* Absent for a public client: PKCE replaces the secret entirely,
              and the API would 409. Hiding it is clearer than offering a
              button whose only outcome is an error. */}
          {!app.publicClient && (
            <button type="button" className="btn" onClick={mint} disabled={busy}>
              Generate client secret
            </button>
          )}
        </div>
      )}

      {secret !== null && (
        <SecretModal clientId={app.clientId} secret={secret} onClose={() => setSecret(null)} />
      )}
    </section>
  )
}
