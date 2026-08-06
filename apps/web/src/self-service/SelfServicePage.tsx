import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { accountConsoleUrl } from '../auth/account-console'
import {
  ApiError,
  fetchSelfGroups,
  fetchSelfProfile,
  updateSelfProfile,
  type AttributeDefinition,
  type SelfGroup,
  type SelfGroupsResponse,
  type SelfProfile,
  type SelfUpdatePatch,
} from './api'

type FieldValues = Record<string, string>

/** Every editable value is edited as a string in this form; coerced to the right JS type only at submit time — see `coerceAttributeValue`. */
function coerceAttributeValue(definition: AttributeDefinition, raw: string): unknown {
  switch (definition.dataType) {
    case 'number':
      return raw === '' ? undefined : Number(raw)
    case 'boolean':
      return raw === 'true'
    default:
      return raw
  }
}

function initialAttributeValues(profile: SelfProfile): FieldValues {
  const values: FieldValues = {}
  for (const definition of profile.editable.attributes) {
    const current = profile.attributes[definition.key]
    values[definition.key] = current === undefined || current === null ? '' : String(current)
  }
  return values
}

/**
 * `editable.coreFields` names columns that exist directly on `profile`
 * (today, only `location`) — read generically by key rather than a
 * hard-coded `profile.location`, so this form stays driven by the server's
 * whitelist (task-4-brief.md) even if that whitelist ever grows.
 */
function initialCoreValues(profile: SelfProfile): FieldValues {
  const values: FieldValues = {}
  const record = profile as unknown as Record<string, unknown>
  for (const field of profile.editable.coreFields) {
    const current = record[field]
    values[field] = current === undefined || current === null ? '' : String(current)
  }
  return values
}

function labelFor(fieldName: string): string {
  return fieldName.charAt(0).toUpperCase() + fieldName.slice(1)
}

function AttributeInput({
  id,
  definition,
  value,
  onChange,
}: {
  id: string
  definition: AttributeDefinition
  value: string
  onChange: (value: string) => void
}) {
  if (definition.dataType === 'boolean') {
    return (
      <input
        id={id}
        type="checkbox"
        checked={value === 'true'}
        onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
      />
    )
  }
  if (definition.dataType === 'date') {
    return <input id={id} type="date" value={value} onChange={(e) => onChange(e.target.value)} />
  }
  if (definition.dataType === 'number') {
    return <input id={id} type="number" value={value} onChange={(e) => onChange(e.target.value)} />
  }
  if (definition.dataType === 'enum') {
    const options = definition.validationRules.options ?? []
    return (
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    )
  }
  return <input id={id} type="text" value={value} onChange={(e) => onChange(e.target.value)} />
}

/**
 * Renders one membership list, marking each group DIRECT or INHERITED.
 * `directIds` and the wider `groups` list (always `effective`, a superset —
 * see SelfGroupsResponse's doc comment on the API side) together give the
 * two states task-4-brief.md requires be "visually distinct": a distinct
 * badge class/text per state, not just a shared undifferentiated list.
 */
function GroupList({ groups, directIds }: { groups: SelfGroup[]; directIds: Set<string> }) {
  if (groups.length === 0) {
    return <p>You are not a member of any group.</p>
  }
  return (
    <ul data-testid="self-groups-list">
      {groups.map((group) => {
        const isDirect = directIds.has(group.id)
        return (
          <li key={group.id} data-testid={`self-group-${group.id}`}>
            {group.name}{' '}
            <span
              data-testid={`self-group-badge-${group.id}`}
              data-membership={isDirect ? 'direct' : 'inherited'}
              className={isDirect ? 'badge badge-direct' : 'badge badge-inherited'}
            >
              {isDirect ? 'Direct' : 'Inherited'}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * `/self` — Milestone 6, Task 4. Shows the caller's own profile (read-only),
 * their groups (read-only, direct vs. inherited visually distinguished —
 * see GroupList above), a credential-management deep link to Keycloak's
 * Account Console (never a reimplementation — see account-console.ts), and
 * an edit form covering ONLY the fields `GET /self` advertises as editable
 * (`editable.coreFields` + `editable.attributes`) — never a hard-coded field
 * list. The API is the sole source of truth for what may be edited: this
 * component builds its form from whatever `editable` says, and relies on
 * the server to reject (400, naming the field) anything outside it.
 */
export default function SelfServicePage() {
  const auth = useAuth()
  const accessToken = auth.user?.access_token

  const [profile, setProfile] = useState<SelfProfile | null>(null)
  const [groups, setGroups] = useState<SelfGroupsResponse | null>(null)
  const [coreValues, setCoreValues] = useState<FieldValues>({})
  const [attributeValues, setAttributeValues] = useState<FieldValues>({})
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')

  useEffect(() => {
    if (accessToken === undefined) return
    let cancelled = false
    setLoadError(null)

    void Promise.all([fetchSelfProfile(accessToken), fetchSelfGroups(accessToken)])
      .then(([profileRes, groupsRes]) => {
        if (cancelled) return
        setProfile(profileRes)
        setGroups(groupsRes)
        setCoreValues(initialCoreValues(profileRes))
        setAttributeValues(initialAttributeValues(profileRes))
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setLoadError(cause instanceof Error ? cause.message : 'Could not load your profile.')
      })

    return () => {
      cancelled = true
    }
  }, [accessToken])

  const directIds = useMemo(() => new Set((groups?.direct ?? []).map((g) => g.id)), [groups])

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (accessToken === undefined || profile === null) return

    setSaveState('saving')
    setSaveError(null)

    const patch: SelfUpdatePatch = {}
    for (const field of profile.editable.coreFields) {
      const raw = coreValues[field] ?? ''
      patch[field] = raw === '' ? null : raw
    }

    if (profile.editable.attributes.length > 0) {
      const attributes: Record<string, unknown> = {}
      for (const definition of profile.editable.attributes) {
        const raw = attributeValues[definition.key] ?? ''
        const coerced = coerceAttributeValue(definition, raw)
        if (coerced !== undefined) attributes[definition.key] = coerced
      }
      patch.attributes = attributes
    }

    try {
      const updated = await updateSelfProfile(accessToken, patch)
      setProfile(updated)
      setCoreValues(initialCoreValues(updated))
      setAttributeValues(initialAttributeValues(updated))
      setSaveState('saved')
    } catch (cause) {
      setSaveState('idle')
      setSaveError(cause instanceof ApiError ? cause.message : 'Could not save changes.')
    }
  }

  if (loadError !== null) {
    return (
      <main>
        <p role="alert">Could not load your profile: {loadError}</p>
      </main>
    )
  }

  if (profile === null || groups === null) {
    return (
      <main>
        <p>Loading your profile…</p>
      </main>
    )
  }

  const hasEditableFields = profile.editable.coreFields.length > 0 || profile.editable.attributes.length > 0

  return (
    <main>
      <h1>My Profile</h1>

      <section aria-labelledby="self-profile-heading">
        <h2 id="self-profile-heading">Profile</h2>
        <dl>
          <dt>Username</dt>
          <dd data-testid="self-username">{profile.username}</dd>
          <dt>Name</dt>
          <dd data-testid="self-display-name">{profile.displayName}</dd>
          <dt>Email</dt>
          <dd>{profile.primaryEmail}</dd>
          <dt>Status</dt>
          <dd data-testid="self-status">{profile.status}</dd>
          <dt>Job title</dt>
          <dd>{profile.jobTitle ?? '—'}</dd>
          <dt>Location</dt>
          <dd data-testid="self-location-current">{profile.location ?? '—'}</dd>
        </dl>
      </section>

      <section aria-labelledby="self-credentials-heading">
        <h2 id="self-credentials-heading">Credentials</h2>
        <p>
          Password and multi-factor authentication are managed by Keycloak, never here — this
          only links out to Keycloak&rsquo;s own Account Console.
        </p>
        <a href={accountConsoleUrl()} target="_blank" rel="noreferrer" data-testid="self-account-console-link">
          Manage password &amp; MFA
        </a>
      </section>

      <section aria-labelledby="self-groups-heading">
        <h2 id="self-groups-heading">Groups</h2>
        <GroupList groups={groups.effective} directIds={directIds} />
      </section>

      <section aria-labelledby="self-edit-heading">
        <h2 id="self-edit-heading">Edit profile</h2>
        {!hasEditableFields && <p>No editable fields are configured.</p>}

        <form onSubmit={(e) => void handleSubmit(e)}>
          {profile.editable.coreFields.map((field) => (
            <div key={field}>
              <label htmlFor={`self-edit-${field}`}>{labelFor(field)}</label>
              <input
                id={`self-edit-${field}`}
                data-testid={`self-edit-${field}`}
                type="text"
                value={coreValues[field] ?? ''}
                onChange={(e) => setCoreValues((prev) => ({ ...prev, [field]: e.target.value }))}
              />
            </div>
          ))}

          {profile.editable.attributes.map((definition) => (
            <div key={definition.key}>
              <label htmlFor={`self-edit-attr-${definition.key}`}>{definition.label}</label>
              <AttributeInput
                id={`self-edit-attr-${definition.key}`}
                definition={definition}
                value={attributeValues[definition.key] ?? ''}
                onChange={(value) =>
                  setAttributeValues((prev) => ({ ...prev, [definition.key]: value }))
                }
              />
            </div>
          ))}

          {hasEditableFields && (
            <button type="submit" disabled={saveState === 'saving'}>
              Save changes
            </button>
          )}

          {saveState === 'saved' && <p data-testid="self-save-success">Saved.</p>}
          {saveError !== null && <p role="alert">{saveError}</p>}
        </form>
      </section>
    </main>
  )
}
