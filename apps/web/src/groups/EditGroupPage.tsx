import { useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { coerceAttributeValue, initialAttributeStringValues } from '../attributes/AttributeField'
import { fetchAttributeDefinitions, type AttributeDefinition } from '../attributes/api'
import { ApiError } from '../api/client'
import { isApiError, mapApiErrorToFields, type FieldErrorResult } from '../forms/api-field-errors'
import { useOrgUnitPath } from '../org-units/OrgUnitsContext'
import { useToast } from '../shell/ToastProvider'
import { GroupScopeBadge } from './badges'
import { useUpdateGroupInCache } from './GroupsContext'
import { fetchGroup, updateGroup, type Group, type UpdateGroupInput } from './api'
import {
  EMPTY_GROUP_CORE_VALUES,
  GROUP_CORE_FIELD_KEYS_BY_MODE,
  GroupForm,
  type GroupFormSubmitPayload,
} from './GroupForm'
import './GroupFormPage.css'

function emptyToNull(raw: string): string | null {
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * `/groups/:id/edit` — Milestone 8, Task 4. `PATCH /groups/:id` via
 * `GroupForm` in `edit` mode — only name/description (and attributes), the
 * fields that route actually accepts. Scope is shown read-only above the
 * form for context, same reasoning EditUserPage shows Email/Username/Org
 * unit/Status read-only: an admin editing a description still wants to see
 * WHICH group, including whether it's global.
 */
export default function EditGroupPage() {
  const { id } = useParams<{ id: string }>()
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const navigate = useNavigate()
  const { showToast } = useToast()
  const updateGroupInCache = useUpdateGroupInCache()

  const [group, setGroup] = useState<Group | null>(null)
  const [loadError, setLoadError] = useState<{ status?: number; message: string } | null>(null)
  const [attributeDefs, setAttributeDefs] = useState<AttributeDefinition[] | null>(null)
  const [attributeDefsError, setAttributeDefsError] = useState<string | null>(null)

  const orgUnitPath = useOrgUnitPath(group?.orgUnitId)

  useEffect(() => {
    if (accessToken === undefined || id === undefined) return
    let cancelled = false
    setLoadError(null)

    fetchGroup(accessToken, id)
      .then((res) => {
        if (!cancelled) setGroup(res)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setLoadError({
          status: cause instanceof ApiError ? cause.status : undefined,
          message: cause instanceof ApiError ? cause.message : 'check your connection and try again',
        })
      })

    fetchAttributeDefinitions(accessToken, 'group')
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

  async function handleSubmit(payload: GroupFormSubmitPayload): Promise<FieldErrorResult | null> {
    if (accessToken === undefined || group === null) {
      return { fieldErrors: {}, formError: 'You are not signed in.' }
    }

    const definitions = attributeDefs ?? []
    const attributes: Record<string, unknown> = {}
    for (const definition of definitions) {
      const coerced = coerceAttributeValue(definition, payload.attributes[definition.key] ?? '')
      if (coerced !== undefined) attributes[definition.key] = coerced
    }

    const patch: UpdateGroupInput = {
      name: payload.core.name.trim(),
      description: emptyToNull(payload.core.description),
    }
    if (definitions.length > 0) {
      patch.attributes = attributes
    }

    try {
      const updated = await updateGroup(accessToken, group.id, patch)
      updateGroupInCache(updated)
      showToast(`Saved changes to ${updated.name}.`)
      navigate(`/groups/${updated.id}`)
      return null
    } catch (cause) {
      if (isApiError(cause)) {
        const knownFields = new Set<string>([
          ...GROUP_CORE_FIELD_KEYS_BY_MODE.edit,
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
        ? "You don't have access to this group's record — it's outside what your role can see."
        : loadError.status === 404
          ? 'This group could not be found. It may have been removed or the link is wrong.'
          : `Could not load this group: ${loadError.message}`
    return (
      <div className="group-form-page">
        <Link to="/groups" className="person-detail__back">
          &larr; Groups
        </Link>
        <div className="error-panel" role="alert">
          <p className="error-panel__message">{message}</p>
        </div>
      </div>
    )
  }

  // Waits for BOTH `group` and `attributeDefs` before mounting GroupForm —
  // same reasoning as EditUserPage's identical gate: GroupForm seeds its
  // attribute-values state ONCE, at mount time, from whatever
  // `attributeDefs` holds then.
  if (group === null || attributeDefs === null) {
    return (
      <div className="group-form-page">
        <Link to="/groups" className="person-detail__back">
          &larr; Groups
        </Link>
        <span className="skeleton" style={{ width: '14rem', height: '1.5rem', display: 'block', marginTop: 'var(--space-2)' }} />
        <div className="skeleton" style={{ width: '100%', height: '20rem', marginTop: 'var(--space-6)' }} />
      </div>
    )
  }

  const initialCore = {
    ...EMPTY_GROUP_CORE_VALUES,
    name: group.name,
    description: group.description ?? '',
  }

  return (
    <div className="group-form-page">
      <Link to={`/groups/${group.id}`} className="person-detail__back">
        &larr; {group.name}
      </Link>
      <h1 className="text-title">Edit {group.name}</h1>

      <dl className="detail-grid group-form-page__readonly">
        <div>
          <dt>Scope</dt>
          <dd>
            <GroupScopeBadge group={group} orgUnitPath={orgUnitPath} />
          </dd>
        </div>
      </dl>
      <p className="field__hint group-form-page__notice">Scope is not editable here.</p>

      {attributeDefsError !== null && (
        <p className="field__hint group-form-page__notice" role="status">
          Custom attribute fields could not be loaded ({attributeDefsError}) — other changes can still be
          saved.
        </p>
      )}

      <GroupForm
        mode="edit"
        initialCore={initialCore}
        initialAttributeValues={initialAttributeStringValues(attributeDefs, group.attributes)}
        attributeDefinitions={attributeDefs}
        orgUnitOptions={[]}
        orgUnitsLoading={false}
        submitLabel="Save changes"
        onCancel={() => navigate(`/groups/${group.id}`)}
        onSubmit={handleSubmit}
      />
    </div>
  )
}
