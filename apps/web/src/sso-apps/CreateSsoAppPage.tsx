import { useState, type FormEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError } from '../api/client'
import { Field, fieldDescribedBy } from '../forms/Field'
import { mapApiErrorToFields } from '../forms/api-field-errors'
import { createSsoApp, linesToList, type SamlNameIdFormat } from './api'
import './SsoApps.css'

const OIDC_FIELDS = new Set(['clientId', 'name', 'description', 'redirectUris', 'webOrigins'])
const SAML_FIELDS = new Set(['entityId', 'name', 'description', 'acsUrls', 'spCertificate'])

export default function CreateSsoAppPage() {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const navigate = useNavigate()

  // The protocol is chosen HERE and never again: the API omits it from PATCH
  // (immutable after create, same rule as clientId), so the form must not
  // suggest otherwise. Switching protocols is a new application.
  const [protocol, setProtocol] = useState<'openid-connect' | 'saml'>('openid-connect')

  const [clientId, setClientId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [publicClient, setPublicClient] = useState(false)
  const [redirectUris, setRedirectUris] = useState('')
  const [webOrigins, setWebOrigins] = useState('')
  const [groupsClaim, setGroupsClaim] = useState(true)

  const [entityId, setEntityId] = useState('')
  const [acsUrls, setAcsUrls] = useState('')
  const [spCertificate, setSpCertificate] = useState('')
  const [signAssertions, setSignAssertions] = useState(false)
  const [nameIdFormat, setNameIdFormat] = useState<SamlNameIdFormat>('email')

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const saml = protocol === 'saml'

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (accessToken === undefined || submitting) return

    setSubmitting(true)
    setFieldErrors({})
    setFormError(null)

    try {
      const created = await createSsoApp(
        accessToken,
        saml
          ? {
              protocol: 'saml',
              entityId: entityId.trim(),
              name: name.trim(),
              description: description.trim(),
              acsUrls: linesToList(acsUrls),
              ...(spCertificate.trim().length > 0 ? { spCertificate: spCertificate.trim() } : {}),
              signAssertions,
              nameIdFormat,
              groupsClaim,
            }
          : {
              clientId: clientId.trim(),
              name: name.trim(),
              description: description.trim(),
              publicClient,
              redirectUris: linesToList(redirectUris),
              webOrigins: linesToList(webOrigins),
              groupsClaim,
            },
      )
      navigate(`/applications/${created.id}`)
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        // The API's reasons name the offending VALUE ("https://* contains a
        // wildcard in the host"), so they are rendered verbatim rather than
        // reworded — a reworded message would drop the value the admin needs
        // to find among several pasted lines.
        const mapped = mapApiErrorToFields(err, saml ? SAML_FIELDS : OIDC_FIELDS)
        setFieldErrors(mapped.fieldErrors)
        setFormError(mapped.formError ?? (err.issues?.join(' ') ?? null))
      } else {
        setFormError('Could not register the application')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="page">
      <header className="page__header">
        <div>
          <h1>Register application</h1>
          <p className="page__subtitle">
            Registers an OIDC or SAML 2.0 client in Keycloak.
          </p>
        </div>
        <Link className="btn" to="/applications">
          Cancel
        </Link>
      </header>

      {formError && (
        <p className="banner banner--error" role="alert">
          {formError}
        </p>
      )}

      <form className="form" onSubmit={onSubmit} noValidate>
        <Field
          id="protocol"
          label="Protocol"
          hint="Cannot be changed later — switching protocol is a new application."
        >
          <select
            id="protocol"
            className="select"
            value={protocol}
            onChange={(e) => setProtocol(e.target.value === 'saml' ? 'saml' : 'openid-connect')}
            aria-describedby={fieldDescribedBy('protocol', undefined, 'hint')}
          >
            <option value="openid-connect">OpenID Connect</option>
            <option value="saml">SAML 2.0</option>
          </select>
        </Field>

        {saml ? (
          <Field
            id="entityId"
            label="Entity ID"
            required
            error={fieldErrors.entityId}
            hint="The SP's entity ID from its metadata — an https URL or urn:. Cannot be changed later."
          >
            <input
              id="entityId"
              className="input"
              value={entityId}
              onChange={(e) => setEntityId(e.target.value)}
              aria-invalid={fieldErrors.entityId !== undefined}
              aria-describedby={fieldDescribedBy('entityId', fieldErrors.entityId, 'hint')}
            />
          </Field>
        ) : (
          <Field
            id="clientId"
            label="Client ID"
            required
            error={fieldErrors.clientId}
            hint="Cannot be changed later — the application hard-codes this in its own configuration."
          >
            <input
              id="clientId"
              className="input"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              aria-invalid={fieldErrors.clientId !== undefined}
              aria-describedby={fieldDescribedBy('clientId', fieldErrors.clientId, 'hint')}
            />
          </Field>
        )}

        <Field id="name" label="Name" required error={fieldErrors.name}>
          <input
            id="name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={fieldErrors.name !== undefined}
          />
        </Field>

        <Field id="description" label="Description" error={fieldErrors.description}>
          <input
            id="description"
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        {saml ? (
          <>
            <Field
              id="acsUrls"
              label="ACS URLs"
              required
              error={fieldErrors.acsUrls}
              hint="One per line, https only (http is allowed for localhost). No wildcards — SAML matches exactly. The first is the primary POST endpoint."
            >
              <textarea
                id="acsUrls"
                className="input"
                rows={4}
                value={acsUrls}
                onChange={(e) => setAcsUrls(e.target.value)}
                aria-invalid={fieldErrors.acsUrls !== undefined}
                aria-describedby={fieldDescribedBy('acsUrls', fieldErrors.acsUrls, 'hint')}
              />
            </Field>

            <Field
              id="nameIdFormat"
              label="NameID format"
              hint="What identifies the user to the application."
            >
              <select
                id="nameIdFormat"
                className="select"
                value={nameIdFormat}
                onChange={(e) => setNameIdFormat(e.target.value as SamlNameIdFormat)}
              >
                <option value="email">Email</option>
                <option value="persistent">Persistent</option>
                <option value="username">Username</option>
              </select>
            </Field>

            <Field
              id="signAssertions"
              label="Sign assertions"
              hint="Signs each assertion individually. The response document is always signed."
            >
              <input
                id="signAssertions"
                type="checkbox"
                checked={signAssertions}
                onChange={(e) => setSignAssertions(e.target.checked)}
              />
            </Field>

            <Field
              id="spCertificate"
              label="SP signing certificate (optional)"
              error={fieldErrors.spCertificate}
              hint="PEM certificate from the SP. Supplying one requires the SP to sign its requests; never paste a private key."
            >
              <textarea
                id="spCertificate"
                className="input"
                rows={5}
                value={spCertificate}
                onChange={(e) => setSpCertificate(e.target.value)}
                aria-invalid={fieldErrors.spCertificate !== undefined}
                aria-describedby={fieldDescribedBy('spCertificate', fieldErrors.spCertificate, 'hint')}
              />
            </Field>
          </>
        ) : (
          <>
            <Field
              id="redirectUris"
              label="Redirect URIs"
              required
              error={fieldErrors.redirectUris}
              hint="One per line. A wildcard is allowed only in the path — https://app.example.com/* is fine, https://* is rejected."
            >
              <textarea
                id="redirectUris"
                className="input"
                rows={4}
                value={redirectUris}
                onChange={(e) => setRedirectUris(e.target.value)}
                aria-invalid={fieldErrors.redirectUris !== undefined}
              />
            </Field>

            <Field
              id="webOrigins"
              label="Web origins"
              error={fieldErrors.webOrigins}
              hint="One per line, scheme and host only. Use + to mirror the redirect URIs."
            >
              <textarea
                id="webOrigins"
                className="input"
                rows={3}
                value={webOrigins}
                onChange={(e) => setWebOrigins(e.target.value)}
                aria-invalid={fieldErrors.webOrigins !== undefined}
              />
            </Field>

            <Field
              id="publicClient"
              label="Public client"
              hint="For applications that cannot keep a secret (single-page and mobile apps). PKCE is always enforced and is not optional."
            >
              <input
                id="publicClient"
                type="checkbox"
                checked={publicClient}
                onChange={(e) => setPublicClient(e.target.checked)}
              />
            </Field>
          </>
        )}

        <Field
          id="groupsClaim"
          label="Include group membership"
          hint={
            saml
              ? 'Adds a "groups" attribute statement to the assertion, carrying bare group names.'
              : 'Adds a groups claim to the token, carrying bare group names.'
          }
        >
          <input
            id="groupsClaim"
            type="checkbox"
            checked={groupsClaim}
            onChange={(e) => setGroupsClaim(e.target.checked)}
          />
        </Field>

        <div className="form__actions">
          <button type="submit" className="btn btn--primary" disabled={submitting}>
            {submitting ? 'Registering…' : 'Register'}
          </button>
        </div>
      </form>
    </section>
  )
}
