import { useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { coerceAttributeValue, initialAttributeStringValues } from '../attributes/AttributeField'
import { fetchAttributeDefinitions, type AttributeDefinition } from '../attributes/api'
import { ApiError } from '../api/client'
import { isApiError, mapApiErrorToFields, type FieldErrorResult } from '../forms/api-field-errors'
import { useOrgUnitPath } from '../org-units/OrgUnitsContext'
import { useToast } from '../shell/ToastProvider'
import { fetchPerson, updatePerson, type Person, type UpdatePersonInput } from './api'
import { StatusBadge, SyncBadge } from './badges'
import { CORE_FIELD_KEYS_BY_MODE, EMPTY_CORE_VALUES, PersonForm, type PersonFormSubmitPayload } from './PersonForm'
import './PersonFormPage.css'

function emptyToNull(raw: string): string | null {
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * `/people/:id/edit` — Milestone 8, Task 3. `PATCH /users/:id` via
 * `PersonForm` in `edit` mode — only the fields the API actually accepts on
 * that route (task-3-brief.md: "do not offer inputs the server will
 * reject"). Email, username, org unit and status are shown read-only above
 * the form for context (an admin editing a job title still wants to see
 * WHO they're editing) but are never rendered as inputs — `UsersRepository.
 * update`'s own doc comment is the authority on why each is excluded from
 * this milestone's PATCH surface (a rename/transfer/status-change is a
 * materially different, differently-scoped operation).
 */
export default function EditUserPage() {
  const { id } = useParams<{ id: string }>()
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const navigate = useNavigate()
  const { showToast } = useToast()

  const [person, setPerson] = useState<Person | null>(null)
  const [loadError, setLoadError] = useState<{ status?: number; message: string } | null>(null)
  const [attributeDefs, setAttributeDefs] = useState<AttributeDefinition[] | null>(null)
  const [attributeDefsError, setAttributeDefsError] = useState<string | null>(null)

  const orgUnitPath = useOrgUnitPath(person?.orgUnitId)

  useEffect(() => {
    if (accessToken === undefined || id === undefined) return
    let cancelled = false
    setLoadError(null)

    fetchPerson(accessToken, id)
      .then((res) => {
        if (!cancelled) setPerson(res)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setLoadError({
          status: cause instanceof ApiError ? cause.status : undefined,
          message: cause instanceof ApiError ? cause.message : 'check your connection and try again',
        })
      })

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
  }, [accessToken, id])

  async function handleSubmit(payload: PersonFormSubmitPayload): Promise<FieldErrorResult | null> {
    if (accessToken === undefined || person === null) {
      return { fieldErrors: {}, formError: 'You are not signed in.' }
    }

    const definitions = attributeDefs ?? []
    const attributes: Record<string, unknown> = {}
    for (const definition of definitions) {
      const coerced = coerceAttributeValue(definition, payload.attributes[definition.key] ?? '')
      if (coerced !== undefined) attributes[definition.key] = coerced
    }

    const patch: UpdatePersonInput = {
      firstName: payload.core.firstName.trim(),
      lastName: payload.core.lastName.trim(),
      jobTitle: emptyToNull(payload.core.jobTitle),
      employeeId: emptyToNull(payload.core.employeeId),
      managerId: emptyToNull(payload.core.managerId),
      location: emptyToNull(payload.core.location),
      startDate: emptyToNull(payload.core.startDate),
      endDate: emptyToNull(payload.core.endDate),
    }
    if (definitions.length > 0) {
      patch.attributes = attributes
    }

    try {
      const updated = await updatePerson(accessToken, person.id, patch)
      showToast(`Saved changes to ${updated.displayName}.`)
      navigate(`/people/${updated.id}`)
      return null
    } catch (cause) {
      if (isApiError(cause)) {
        const knownFields = new Set<string>([
          ...CORE_FIELD_KEYS_BY_MODE.edit,
          ...definitions.map((d) => d.key),
        ])
        return mapApiErrorToFields(cause, knownFields)
      }
      return { fieldErrors: {}, formError: 'Could not save changes. Check your connection and try again.' }
    }
  }

  if (loadError !== null) {
    const message =
      loadError.status === 403
        ? "You don't have access to this person's record — it's outside what your role can see."
        : loadError.status === 404
          ? 'This person could not be found. They may have been removed or the link is wrong.'
          : `Could not load this person: ${loadError.message}`
    return (
      <div className="person-form-page">
        <Link to="/people" className="person-detail__back">
          &larr; People
        </Link>
        <div className="error-panel" role="alert">
          <p className="error-panel__message">{message}</p>
        </div>
      </div>
    )
  }

  // Waits for BOTH `person` and `attributeDefs` before mounting PersonForm,
  // not just `person` — PersonForm seeds its attribute-values state ONCE,
  // from `initialAttributeStringValues(attributeDefs ?? [], person.
  // attributes)`, at mount time. If attribute definitions were still loading
  // (silently defaulting to `[]`) when PersonForm first mounted and then
  // arrived a moment later, PersonForm's already-initialized state would
  // never retroactively pick up the person's REAL existing values for those
  // fields — they would render as blank instead of what is actually stored,
  // a currently-empty-looking field that is not actually empty. Both fetches
  // are independent (separate effects, no ordering guarantee), so gating on
  // both is what makes the eventual first render correct regardless of
  // which one resolves first.
  if (person === null || attributeDefs === null) {
    return (
      <div className="person-form-page">
        <Link to="/people" className="person-detail__back">
          &larr; People
        </Link>
        <span className="skeleton" style={{ width: '14rem', height: '1.5rem', display: 'block', marginTop: 'var(--space-2)' }} />
        <div className="skeleton" style={{ width: '100%', height: '20rem', marginTop: 'var(--space-6)' }} />
      </div>
    )
  }

  const initialCore = {
    ...EMPTY_CORE_VALUES,
    firstName: person.firstName,
    lastName: person.lastName,
    jobTitle: person.jobTitle ?? '',
    employeeId: person.employeeId ?? '',
    managerId: person.managerId ?? '',
    location: person.location ?? '',
    startDate: person.startDate ?? '',
    endDate: person.endDate ?? '',
  }

  return (
    <div className="person-form-page">
      <Link to={`/people/${person.id}`} className="person-detail__back">
        &larr; {person.displayName}
      </Link>
      <h1 className="text-title">Edit {person.displayName}</h1>

      <dl className="detail-grid person-form-page__readonly">
        <div>
          <dt>Email</dt>
          <dd>{person.primaryEmail}</dd>
        </div>
        <div>
          <dt>Username</dt>
          <dd>{person.username}</dd>
        </div>
        <div>
          <dt>Org unit</dt>
          <dd className="mono">{orgUnitPath ?? person.orgUnitId}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            <StatusBadge status={person.status} /> <SyncBadge state={person.syncState} />
          </dd>
        </div>
      </dl>
      <p className="field__hint person-form-page__notice">
        Email, username, org unit and status are not editable here.
      </p>

      {attributeDefsError !== null && (
        <p className="field__hint person-form-page__notice" role="status">
          Custom attribute fields could not be loaded ({attributeDefsError}) — other changes can still be
          saved.
        </p>
      )}

      <PersonForm
        mode="edit"
        personId={person.id}
        initialCore={initialCore}
        initialAttributeValues={initialAttributeStringValues(attributeDefs, person.attributes)}
        attributeDefinitions={attributeDefs}
        orgUnitOptions={[]}
        orgUnitsLoading={false}
        submitLabel="Save changes"
        onCancel={() => navigate(`/people/${person.id}`)}
        onSubmit={handleSubmit}
      />
    </div>
  )
}
