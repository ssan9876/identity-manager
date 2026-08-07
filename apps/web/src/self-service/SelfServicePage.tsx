import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { coerceAttributeValue, AttributeFieldRow } from '../attributes/AttributeField'
import { accountConsoleUrl } from '../auth/account-console'
import { Field } from '../forms/Field'
import {
  ApiError,
  fetchSelfGroups,
  fetchSelfProfile,
  updateSelfProfile,
  type SelfGroup,
  type SelfGroupsResponse,
  type SelfProfile,
  type SelfUpdatePatch,
} from './api'
import './SelfServicePage.css'

type FieldValues = Record<string, string>

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

/**
 * Renders one membership list, marking each group DIRECT or INHERITED.
 * `directIds` and the wider `groups` list (always `effective`, a superset —
 * see SelfGroupsResponse's doc comment on the API side) together give the
 * two states task-4-brief.md requires be "visually distinct": a distinct
 * `data-membership`/label per state. Reuses `.group-member-list` (styles/
 * components.css) — the exact "a named thing plus a status indicator" row
 * shape GroupMembersTab's own membership rows already use — rather than the
 * page's own bespoke, unstyled list Milestone 9 Task 2's dark-mode audit
 * found here (task-2-report.md: no `.detail-grid`, `.field`/`.input`,
 * `.btn`, or `badge--*` anywhere in this page's JSX at all — its
 * `badge-direct`/`badge-inherited` classes did not even match any selector
 * in components.css, which only defines double-dash `badge--*`). Direct and
 * inherited both render `badge--neutral` (this task's own choice): neither
 * is an "exception" in DESIGN.md's colour-marks-the-exception sense the way
 * pending/suspended/danger are — the WORD is what distinguishes them, which
 * DESIGN.md's own badge contract requires regardless of colour.
 */
function GroupList({ groups, directIds }: { groups: SelfGroup[]; directIds: Set<string> }) {
  if (groups.length === 0) {
    return <p>You are not a member of any group.</p>
  }
  return (
    <ul className="group-member-list" data-testid="self-groups-list">
      {groups.map((group) => {
        const isDirect = directIds.has(group.id)
        return (
          <li key={group.id} className="group-member-list__row" data-testid={`self-group-${group.id}`}>
            <span>{group.name}</span>
            <span
              data-testid={`self-group-badge-${group.id}`}
              data-membership={isDirect ? 'direct' : 'inherited'}
              className="badge badge--neutral"
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
 *
 * Milestone 9, Task 3: brought onto the shared component vocabulary
 * (styles/components.css) — `.text-subject`/`.text-title` headings,
 * `.detail-grid` for the profile `<dl>`, the shared `Field`/`AttributeFieldRow`
 * components (identical to what PersonForm already uses) for the edit form,
 * `.btn`/`.btn--primary` for its submit button, and `.group-member-list` for
 * the groups list — this is the one screen every employee sees, and it was
 * the one screen still rendering as plain unstyled HTML in both themes (see
 * task-2-report.md's own "found and not changed" note; task-3-report.md
 * carries the full before/after). Every `id`/`data-testid`/visible text/
 * accessible name below is UNCHANGED from before this pass — only markup
 * structure and `className`s moved — so e2e/self-service.spec.ts required no
 * changes of its own.
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
      <main className="self-service">
        <div className="error-panel" role="alert">
          <p className="error-panel__message">Could not load your profile: {loadError}</p>
        </div>
      </main>
    )
  }

  if (profile === null || groups === null) {
    return (
      <main className="self-service" aria-busy="true">
        <span className="skeleton" style={{ width: '10rem', height: '1.5rem', display: 'block' }} />
        <span className="skeleton" style={{ width: '100%', height: '10rem', display: 'block', marginTop: 'var(--space-6)' }} />
      </main>
    )
  }

  const hasEditableFields = profile.editable.coreFields.length > 0 || profile.editable.attributes.length > 0

  return (
    <main className="self-service">
      <h1 className="text-subject">My Profile</h1>

      <section className="self-service__section" aria-labelledby="self-profile-heading">
        <h2 id="self-profile-heading" className="text-title">
          Profile
        </h2>
        <dl className="detail-grid">
          <div>
            <dt>Username</dt>
            <dd data-testid="self-username">{profile.username}</dd>
          </div>
          <div>
            <dt>Name</dt>
            <dd data-testid="self-display-name">{profile.displayName}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{profile.primaryEmail}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd data-testid="self-status">{profile.status}</dd>
          </div>
          <div>
            <dt>Job title</dt>
            <dd>{profile.jobTitle ?? '—'}</dd>
          </div>
          <div>
            <dt>Location</dt>
            <dd data-testid="self-location-current">{profile.location ?? '—'}</dd>
          </div>
        </dl>
      </section>

      <section className="self-service__section" aria-labelledby="self-credentials-heading">
        <h2 id="self-credentials-heading" className="text-title">
          Credentials
        </h2>
        <p>
          Password and multi-factor authentication are managed by Keycloak, never here — this
          only links out to Keycloak&rsquo;s own Account Console.
        </p>
        <a
          href={accountConsoleUrl()}
          target="_blank"
          rel="noreferrer"
          className="btn btn--secondary"
          data-testid="self-account-console-link"
        >
          Manage password &amp; MFA
        </a>
      </section>

      <section className="self-service__section" aria-labelledby="self-groups-heading">
        <h2 id="self-groups-heading" className="text-title">
          Groups
        </h2>
        <GroupList groups={groups.effective} directIds={directIds} />
      </section>

      <section className="self-service__section" aria-labelledby="self-edit-heading">
        <h2 id="self-edit-heading" className="text-title">
          Edit profile
        </h2>
        {!hasEditableFields && <p>No editable fields are configured.</p>}

        <form className="self-service__edit-form" onSubmit={(e) => void handleSubmit(e)}>
          {profile.editable.coreFields.map((field) => (
            <Field key={field} id={`self-edit-${field}`} label={labelFor(field)}>
              <input
                id={`self-edit-${field}`}
                className="input"
                data-testid={`self-edit-${field}`}
                type="text"
                value={coreValues[field] ?? ''}
                onChange={(e) => setCoreValues((prev) => ({ ...prev, [field]: e.target.value }))}
              />
            </Field>
          ))}

          {profile.editable.attributes.map((definition) => (
            <AttributeFieldRow
              key={definition.key}
              idPrefix="self-edit-attr"
              definition={definition}
              value={attributeValues[definition.key] ?? ''}
              onChange={(value) => setAttributeValues((prev) => ({ ...prev, [definition.key]: value }))}
            />
          ))}

          {hasEditableFields && (
            <div className="self-service__actions">
              <button
                type="submit"
                className="btn btn--primary"
                disabled={saveState === 'saving'}
                data-loading={saveState === 'saving' ? 'true' : undefined}
              >
                <span className="btn__label">Save changes</span>
                <span className="btn__spinner" aria-hidden="true" />
              </button>
            </div>
          )}

          {saveState === 'saved' && (
            <p className="field__hint" role="status" data-testid="self-save-success">
              Saved.
            </p>
          )}
          {saveError !== null && (
            <p className="error-panel__message" role="alert">
              {saveError}
            </p>
          )}
        </form>
      </section>
    </main>
  )
}
