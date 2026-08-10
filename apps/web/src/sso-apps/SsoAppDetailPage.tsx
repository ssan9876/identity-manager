import { useCallback, useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useParams } from 'react-router-dom'
import { ApiError } from '../api/client'
import { keycloakIssuer } from '../auth/oidc-config'
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
            <code>{app.clientId}</code> ·{' '}
            {app.protocol === 'saml'
              ? 'SAML 2.0'
              : app.publicClient
                ? 'Public client (PKCE)'
                : 'Confidential client'}
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

        {app.protocol === 'saml' ? (
          <>
            <dt>ACS URLs</dt>
            <dd>
              <ul className="plain-list">
                {(app.samlAcsUrls ?? []).map((uri) => (
                  <li key={uri}>
                    <code>{uri}</code>
                  </li>
                ))}
              </ul>
            </dd>

            <dt>NameID format</dt>
            <dd>{app.samlNameIdFormat ?? 'email'}</dd>

            <dt>Assertion signing</dt>
            <dd>
              {app.samlSignAssertions
                ? 'Assertions signed individually (response document always signed)'
                : 'Response document signed'}
            </dd>

            <dt>SP signing certificate</dt>
            <dd>
              {app.samlSpCertificate !== null
                ? 'Provided — signed AuthnRequests are required'
                : 'None — requests are accepted unsigned'}
            </dd>
          </>
        ) : (
          <>
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
          </>
        )}

        <dt>{app.protocol === 'saml' ? 'Group membership attribute' : 'Group membership claim'}</dt>
        <dd>{app.groupsClaim ? 'Included as "groups"' : 'Not included'}</dd>
      </dl>

      {app.protocol === 'saml' && (
        /* Everything the SP's administrator needs to configure their side.
           All three values derive from the realm issuer the console already
           authenticates against (VITE_KEYCLOAK_ISSUER): a Keycloak realm's
           SAML IdP entity id IS its issuer URL, and the SSO endpoint and
           metadata descriptor hang off it. The descriptor XML carries the
           IdP signing certificate — linked rather than re-served, so there
           is exactly one source for it. */
        <section aria-labelledby="idp-metadata-heading">
          <h2 id="idp-metadata-heading">Identity provider details</h2>
          <p className="muted">
            Give these to the application&apos;s administrator to configure their side of the
            connection.
          </p>
          <dl className="detail-grid detail-grid--labelled">
            <dt>IdP entity ID</dt>
            <dd>
              <code>{keycloakIssuer}</code>
            </dd>

            <dt>SSO endpoint URL</dt>
            <dd>
              <code>{`${keycloakIssuer}/protocol/saml`}</code>
            </dd>

            <dt>IdP metadata &amp; signing certificate</dt>
            <dd>
              <a href={`${keycloakIssuer}/protocol/saml/descriptor`} download>
                Download the IdP metadata descriptor (XML)
              </a>
            </dd>
          </dl>
        </section>
      )}

      {canManage && (
        <div className="page__actions">
          <button type="button" className="btn" onClick={toggleEnabled} disabled={busy}>
            {app.enabled ? 'Disable' : 'Enable'}
          </button>

          {/* Absent for a public client (PKCE replaces the secret) and for
              SAML (SPs authenticate assertions by signature — there is no
              secret): the API would 409 either way, and hiding the button is
              clearer than offering one whose only outcome is an error. */}
          {!app.publicClient && app.protocol !== 'saml' && (
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
