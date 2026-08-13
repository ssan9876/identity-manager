import { useCallback, useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useParams } from 'react-router-dom'
import { ApiError } from '../api/client'
import { keycloakIssuer } from '../auth/oidc-config'
import { EnabledBadge } from '../connectors/badges'
import { useSelfPermissions } from '../shell/permissions'
import { SecretModal } from './SecretModal'
import {
  fetchSsoApp,
  linesToList,
  mintClientSecret,
  setSsoAppEnabled,
  updateSsoApp,
  type SsoApp,
} from './api'
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

  /**
   * The edit form — `PATCH /sso-apps/:id` has existed since registration did,
   * and no screen called it, so an application's name, description, redirect
   * URIs or ACS URLs could only be corrected in the database. A typo'd
   * redirect URI is the difference between a working login and a broken one.
   *
   * `clientId`, `publicClient` and `protocol` are deliberately absent: the API
   * rejects each BY NAME rather than ignoring it, because changing any of them
   * in place is a different application, and an admin who thinks they renamed
   * a clientId must not be told it worked.
   */
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: '',
    description: '',
    redirectUris: '',
    webOrigins: '',
    acsUrls: '',
    groupsClaim: false,
    signAssertions: false,
  })

  function startEdit(current: SsoApp) {
    setForm({
      name: current.name,
      description: current.description ?? '',
      redirectUris: (current.redirectUris ?? []).join('\n'),
      webOrigins: (current.webOrigins ?? []).join('\n'),
      acsUrls: (current.samlAcsUrls ?? []).join('\n'),
      groupsClaim: current.groupsClaim === true,
      signAssertions: current.samlSignAssertions === true,
    })
    setEditError(null)
    setEditing(true)
  }

  async function handleSave() {
    if (accessToken === undefined || app === null) return
    setSaving(true)
    setEditError(null)
    try {
      // The PATCH shape is chosen by the ROW's protocol, not by the form: a
      // SAML field sent to an OIDC application is a 400 naming the field.
      const patch =
        app.protocol === 'saml'
          ? {
              name: form.name.trim(),
              description: form.description.trim(),
              acsUrls: linesToList(form.acsUrls),
              signAssertions: form.signAssertions,
              groupsClaim: form.groupsClaim,
            }
          : {
              name: form.name.trim(),
              description: form.description.trim(),
              redirectUris: linesToList(form.redirectUris),
              webOrigins: linesToList(form.webOrigins),
              groupsClaim: form.groupsClaim,
            }

      setApp(await updateSsoApp(accessToken, app.id, patch))
      setEditing(false)
    } catch (cause) {
      // Verbatim: the API's refusals here name the offending field — a
      // wildcard redirect URI, a reserved client id — and re-wording them
      // would be a second, drifting copy of a rule it owns.
      setEditError(cause instanceof ApiError ? cause.message : 'Could not save this application.')
    } finally {
      setSaving(false)
    }
  }

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
        <div className="sso-detail__header-actions">
          <EnabledBadge enabled={app.enabled} />
          {!editing && (
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => startEdit(app)}
              data-testid="edit-sso-app"
            >
              Edit
            </button>
          )}
        </div>
      </header>

      {editing && (
        <form
          className="sso-detail__edit"
          onSubmit={(e) => {
            e.preventDefault()
            void handleSave()
          }}
          data-testid="sso-app-edit-form"
        >
          <h2 className="text-title">Edit application</h2>
          <p className="cell-muted">
            The client ID and protocol cannot be changed — either would be a different
            application, and the API refuses both by name rather than ignoring them.
          </p>

          <div className="sso-detail__edit-grid">
            <div className="field">
              <label className="field__label" htmlFor="sso-edit-name">
                Name
              </label>
              <input
                id="sso-edit-name"
                className="input"
                value={form.name}
                maxLength={255}
                disabled={saving}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                data-testid="sso-edit-name"
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="sso-edit-description">
                Description
              </label>
              <input
                id="sso-edit-description"
                className="input"
                value={form.description}
                maxLength={2000}
                disabled={saving}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>

            {app.protocol === 'saml' ? (
              <div className="field sso-detail__edit-wide">
                <label className="field__label" htmlFor="sso-edit-acs">
                  ACS URLs
                </label>
                <textarea
                  id="sso-edit-acs"
                  className="input sso-detail__textarea"
                  rows={3}
                  value={form.acsUrls}
                  disabled={saving}
                  onChange={(e) => setForm({ ...form, acsUrls: e.target.value })}
                  data-testid="sso-edit-acs"
                />
                <p className="field__hint">One per line.</p>
              </div>
            ) : (
              <>
                <div className="field sso-detail__edit-wide">
                  <label className="field__label" htmlFor="sso-edit-redirects">
                    Redirect URIs
                  </label>
                  <textarea
                    id="sso-edit-redirects"
                    className="input sso-detail__textarea"
                    rows={3}
                    value={form.redirectUris}
                    disabled={saving}
                    onChange={(e) => setForm({ ...form, redirectUris: e.target.value })}
                    data-testid="sso-edit-redirects"
                  />
                  <p className="field__hint">
                    One per line. A wildcard is refused by the API, which is what stops an
                    authorization code being sent to someone else's host.
                  </p>
                </div>

                <div className="field sso-detail__edit-wide">
                  <label className="field__label" htmlFor="sso-edit-origins">
                    Web origins
                  </label>
                  <textarea
                    id="sso-edit-origins"
                    className="input sso-detail__textarea"
                    rows={2}
                    value={form.webOrigins}
                    disabled={saving}
                    onChange={(e) => setForm({ ...form, webOrigins: e.target.value })}
                  />
                </div>
              </>
            )}

            <label className="sso-detail__check">
              <input
                type="checkbox"
                checked={form.groupsClaim}
                disabled={saving}
                onChange={(e) => setForm({ ...form, groupsClaim: e.target.checked })}
              />
              <span>Include the user's groups in tokens issued to this application.</span>
            </label>

            {app.protocol === 'saml' && (
              <label className="sso-detail__check">
                <input
                  type="checkbox"
                  checked={form.signAssertions}
                  disabled={saving}
                  onChange={(e) => setForm({ ...form, signAssertions: e.target.checked })}
                />
                <span>Sign assertions individually, as well as the response document.</span>
              </label>
            )}
          </div>

          {editError !== null && (
            <p className="field__error" role="alert" data-testid="sso-edit-error">
              {editError}
            </p>
          )}

          <div className="sso-detail__edit-actions">
            <button
              type="button"
              className="btn btn--secondary"
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={saving}
              data-loading={saving ? 'true' : undefined}
              data-testid="sso-edit-save"
            >
              <span className="btn__label">Save</span>
              <span className="btn__spinner" aria-hidden="true" />
            </button>
          </div>
        </form>
      )}

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
