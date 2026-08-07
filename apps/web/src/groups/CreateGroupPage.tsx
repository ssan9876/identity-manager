import { useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useNavigate } from 'react-router-dom'
import { coerceAttributeValue } from '../attributes/AttributeField'
import { fetchAttributeDefinitions, type AttributeDefinition } from '../attributes/api'
import { ApiError } from '../api/client'
import { isApiError, mapApiErrorToFields, type FieldErrorResult } from '../forms/api-field-errors'
import { useOrgUnits } from '../org-units/OrgUnitsContext'
import { useToast } from '../shell/ToastProvider'
import { useAddGroup } from './GroupsContext'
import { createGroup, type CreateGroupInput } from './api'
import {
  EMPTY_GROUP_CORE_VALUES,
  GROUP_CORE_FIELD_KEYS_BY_MODE,
  GroupForm,
  type GroupFormSubmitPayload,
} from './GroupForm'
import './GroupFormPage.css'

function emptyToUndefined(raw: string): string | undefined {
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * `/groups/new` — Milestone 8, Task 4. `POST /groups` via `GroupForm` in
 * `create` mode. The custom-attributes section is driven by `GET
 * /attribute-definitions?appliesTo=group` — the same generality Task 3
 * exposed but never exercised (see that task's report: "Task 4 may or may
 * not use it" — it does, here). A failure to load attribute definitions does
 * NOT block the page, same reasoning as CreateUserPage: the core fields
 * still work.
 */
export default function CreateGroupPage() {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const navigate = useNavigate()
  const { showToast } = useToast()
  const orgUnits = useOrgUnits()
  const addGroup = useAddGroup()

  const [attributeDefs, setAttributeDefs] = useState<AttributeDefinition[] | null>(null)
  const [attributeDefsError, setAttributeDefsError] = useState<string | null>(null)

  useEffect(() => {
    if (accessToken === undefined) return
    let cancelled = false

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
  }, [accessToken])

  async function handleSubmit(payload: GroupFormSubmitPayload): Promise<FieldErrorResult | null> {
    if (accessToken === undefined) {
      return { fieldErrors: {}, formError: 'You are not signed in.' }
    }

    const definitions = attributeDefs ?? []
    const attributes: Record<string, unknown> = {}
    for (const definition of definitions) {
      const coerced = coerceAttributeValue(definition, payload.attributes[definition.key] ?? '')
      if (coerced !== undefined) attributes[definition.key] = coerced
    }

    const input: CreateGroupInput = {
      name: payload.core.name.trim(),
      description: emptyToUndefined(payload.core.description),
      orgUnitId: payload.core.orgUnitId === '' ? undefined : payload.core.orgUnitId,
      attributes,
    }

    try {
      const created = await createGroup(accessToken, input)
      addGroup(created)
      showToast(`Created ${created.name}.`)
      navigate(`/groups/${created.id}`)
      return null
    } catch (cause) {
      // Mirrors OrgUnitsPage's own CreateOrgUnitForm precedent exactly (task-
      // 3-report.md): the GLOBAL-creation 403 is already specific on the
      // server's own terms ("creating a global group requires a global
      // grant of group:create" — GroupsController.create) and is shown
      // verbatim; the SCOPED-creation 403 comes from a generic
      // `assertCanIn` rejection ("not permitted: group:create") that names
      // no org unit, so it is given a client-side message that does.
      if (cause instanceof ApiError && cause.status === 403) {
        if (input.orgUnitId === undefined) {
          return { fieldErrors: {}, formError: cause.message }
        }
        const orgUnitName = orgUnits.status === 'ready' ? orgUnits.byId.get(input.orgUnitId)?.name : undefined
        return {
          fieldErrors: {},
          formError: `You don't have permission to create groups under ${orgUnitName ?? 'this org unit'} — it's outside what your group:create grant covers.`,
        }
      }
      if (isApiError(cause)) {
        const knownFields = new Set<string>([
          ...GROUP_CORE_FIELD_KEYS_BY_MODE.create,
          ...definitions.map((d) => d.key),
        ])
        return mapApiErrorToFields(cause, knownFields)
      }
      return { fieldErrors: {}, formError: 'Could not create this group. Check your connection and try again.' }
    }
  }

  const orgUnitOptions =
    orgUnits.status === 'ready' ? [...orgUnits.list].sort((a, b) => a.path.localeCompare(b.path)) : []

  return (
    <div className="group-form-page">
      <Link to="/groups" className="person-detail__back">
        &larr; Groups
      </Link>
      <h1 className="text-title">Create group</h1>

      {orgUnits.status === 'error' ? (
        <div className="error-panel" role="alert">
          <p className="error-panel__message">
            Could not load org units, so a new group's scope cannot be set yet: {orgUnits.message}
          </p>
          <p>Reload the page to try again.</p>
        </div>
      ) : (
        <>
          {attributeDefsError !== null && (
            <p className="field__hint group-form-page__notice" role="status">
              Custom attribute fields could not be loaded ({attributeDefsError}) — the group can still be
              created with its standard fields.
            </p>
          )}
          <GroupForm
            mode="create"
            initialCore={EMPTY_GROUP_CORE_VALUES}
            initialAttributeValues={{}}
            attributeDefinitions={attributeDefs ?? []}
            orgUnitOptions={orgUnitOptions}
            orgUnitsLoading={orgUnits.status === 'loading'}
            submitLabel="Create group"
            onCancel={() => navigate('/groups')}
            onSubmit={handleSubmit}
          />
        </>
      )}
    </div>
  )
}
