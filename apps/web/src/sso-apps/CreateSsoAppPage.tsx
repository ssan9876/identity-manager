import { useState, type FormEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError } from '../api/client'
import { Field, fieldDescribedBy } from '../forms/Field'
import { mapApiErrorToFields } from '../forms/api-field-errors'
import { createSsoApp, linesToList } from './api'
import './SsoApps.css'

const KNOWN_FIELDS = new Set(['clientId', 'name', 'description', 'redirectUris', 'webOrigins'])

export default function CreateSsoAppPage() {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const navigate = useNavigate()

  const [clientId, setClientId] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [publicClient, setPublicClient] = useState(false)
  const [redirectUris, setRedirectUris] = useState('')
  const [webOrigins, setWebOrigins] = useState('')
  const [groupsClaim, setGroupsClaim] = useState(true)

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (accessToken === undefined || submitting) return

    setSubmitting(true)
    setFieldErrors({})
    setFormError(null)

    try {
      const created = await createSsoApp(accessToken, {
        clientId: clientId.trim(),
        name: name.trim(),
        description: description.trim(),
        publicClient,
        redirectUris: linesToList(redirectUris),
        webOrigins: linesToList(webOrigins),
        groupsClaim,
      })
      navigate(`/applications/${created.id}`)
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        // The API's reasons name the offending VALUE ("https://* contains a
        // wildcard in the host"), so they are rendered verbatim rather than
        // reworded — a reworded message would drop the value the admin needs
        // to find among several pasted lines.
        const mapped = mapApiErrorToFields(err, KNOWN_FIELDS)
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
            Registers an OIDC client in Keycloak. SAML applications are not supported.
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

        <Field
          id="groupsClaim"
          label="Include group membership"
          hint="Adds a groups claim to the token, carrying bare group names."
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
