import { useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useNavigate } from 'react-router-dom'
import { coerceAttributeValue } from '../attributes/AttributeField'
import { fetchAttributeDefinitions, type AttributeDefinition } from '../attributes/api'
import { isApiError, mapApiErrorToFields, type FieldErrorResult } from '../forms/api-field-errors'
import { useOrgUnits } from '../org-units/OrgUnitsContext'
import { useToast } from '../shell/ToastProvider'
import { createPerson, type CreatePersonInput } from './api'
import { CORE_FIELD_KEYS_BY_MODE, EMPTY_CORE_VALUES, PersonForm, type PersonFormSubmitPayload } from './PersonForm'
import './PersonFormPage.css'

function emptyToUndefined(raw: string): string | undefined {
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * `/people/new` — Milestone 8, Task 3. `POST /users` via `PersonForm` in
 * `create` mode. The custom-attributes section is driven by `GET
 * /attribute-definitions?appliesTo=user` (this task's one new endpoint) —
 * fetched here, once, and handed down; a failure to load it does NOT block
 * the page (core fields — the vast majority of what onboarding a starter
 * actually needs, per PRODUCT.md's scene — work regardless), it just means
 * the form has no custom fields to render until a reload succeeds.
 */
export default function CreateUserPage() {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const navigate = useNavigate()
  const { showToast } = useToast()
  const orgUnits = useOrgUnits()

  const [attributeDefs, setAttributeDefs] = useState<AttributeDefinition[] | null>(null)
  const [attributeDefsError, setAttributeDefsError] = useState<string | null>(null)

  useEffect(() => {
    if (accessToken === undefined) return
    let cancelled = false

    fetchAttributeDefinitions(accessToken, 'user')
      .then((defs) => {
        if (!cancelled) setAttributeDefs(defs)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setAttributeDefs([])
        setAttributeDefsError(cause instanceof Error ? cause.message : 'could not load custom fields')
      })

    return () => {
      cancelled = true
    }
  }, [accessToken])

  async function handleSubmit(payload: PersonFormSubmitPayload): Promise<FieldErrorResult | null> {
    if (accessToken === undefined) {
      return { fieldErrors: {}, formError: 'You are not signed in.' }
    }

    const definitions = attributeDefs ?? []
    const attributes: Record<string, unknown> = {}
    for (const definition of definitions) {
      const coerced = coerceAttributeValue(definition, payload.attributes[definition.key] ?? '')
      if (coerced !== undefined) attributes[definition.key] = coerced
    }

    const input: CreatePersonInput = {
      primaryEmail: payload.core.primaryEmail.trim(),
      username: payload.core.username.trim(),
      firstName: payload.core.firstName.trim(),
      lastName: payload.core.lastName.trim(),
      orgUnitId: payload.core.orgUnitId,
      employeeId: emptyToUndefined(payload.core.employeeId),
      jobTitle: emptyToUndefined(payload.core.jobTitle),
      managerId: emptyToUndefined(payload.core.managerId),
      location: emptyToUndefined(payload.core.location),
      startDate: emptyToUndefined(payload.core.startDate),
      endDate: emptyToUndefined(payload.core.endDate),
      attributes,
    }

    try {
      const created = await createPerson(accessToken, input)
      showToast(`Created ${created.displayName}.`)
      navigate(`/people/${created.id}`)
      return null
    } catch (cause) {
      if (isApiError(cause)) {
        const knownFields = new Set<string>([
          ...CORE_FIELD_KEYS_BY_MODE.create,
          ...definitions.map((d) => d.key),
        ])
        return mapApiErrorToFields(cause, knownFields)
      }
      return { fieldErrors: {}, formError: 'Could not create this user. Check your connection and try again.' }
    }
  }

  const orgUnitOptions = orgUnits.status === 'ready' ? [...orgUnits.list].sort((a, b) => a.path.localeCompare(b.path)) : []

  return (
    <div className="person-form-page">
      <Link to="/people" className="person-detail__back">
        &larr; People
      </Link>
      <h1 className="text-title">Create user</h1>

      {orgUnits.status === 'error' ? (
        <div className="error-panel" role="alert">
          <p className="error-panel__message">
            Could not load org units, so a new person cannot be placed anywhere yet: {orgUnits.message}
          </p>
          <p>Reload the page to try again.</p>
        </div>
      ) : (
        <>
          {attributeDefsError !== null && (
            <p className="field__hint person-form-page__notice" role="status">
              Custom attribute fields could not be loaded ({attributeDefsError}) — the user can still be
              created with its standard fields.
            </p>
          )}
          <PersonForm
            mode="create"
            initialCore={EMPTY_CORE_VALUES}
            initialAttributeValues={{}}
            attributeDefinitions={attributeDefs ?? []}
            orgUnitOptions={orgUnitOptions}
            orgUnitsLoading={orgUnits.status === 'loading'}
            submitLabel="Create user"
            onCancel={() => navigate('/people')}
            onSubmit={handleSubmit}
          />
        </>
      )}
    </div>
  )
}
