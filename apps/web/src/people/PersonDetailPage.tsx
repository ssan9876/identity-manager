import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useParams } from 'react-router-dom'
import { ApiError } from '../api/client'
import { useOrgUnits } from '../org-units/OrgUnitsContext'
import { ConfirmDialog } from '../shell/ConfirmDialog'
import { NotYetBuilt } from '../shell/NotYetBuilt'
import { useSelfPermissions } from '../shell/permissions'
import { useToast } from '../shell/ToastProvider'
import { formatDateOnly, formatDateTime } from '../format'
import { deactivatePerson, fetchGroupsForUser, fetchPerson, type Group, type Person } from './api'
import { StatusBadge, SYNC_WORD, SyncBadge } from './badges'
import './PersonDetailPage.css'

type TabKey = 'profile' | 'groups' | 'roles' | 'activity'
const TABS: { key: TabKey; label: string }[] = [
  { key: 'profile', label: 'Profile' },
  { key: 'groups', label: 'Groups' },
  { key: 'roles', label: 'Roles' },
  { key: 'activity', label: 'Activity' },
]

function ProfileTab({ person, orgUnitPath }: { person: Person; orgUnitPath: string | null }) {
  const attributeEntries = Object.entries(person.attributes)

  return (
    <div>
      <dl className="detail-grid">
        <div>
          <dt>Username</dt>
          <dd>{person.username}</dd>
        </div>
        <div>
          <dt>Primary email</dt>
          <dd>{person.primaryEmail}</dd>
        </div>
        <div>
          <dt>Job title</dt>
          <dd>{person.jobTitle ?? '—'}</dd>
        </div>
        <div>
          <dt>Org unit</dt>
          <dd className="mono">{orgUnitPath ?? person.orgUnitId}</dd>
        </div>
        <div>
          <dt>Employee ID</dt>
          <dd className="mono">{person.employeeId ?? '—'}</dd>
        </div>
        <div>
          <dt>Manager</dt>
          <dd className="mono">{person.managerId ?? '—'}</dd>
        </div>
        <div>
          <dt>Location</dt>
          <dd>{person.location ?? '—'}</dd>
        </div>
        <div>
          <dt>Start date</dt>
          <dd>{person.startDate ? formatDateOnly(person.startDate) : '—'}</dd>
        </div>
        <div>
          <dt>End date</dt>
          <dd>{person.endDate ? formatDateOnly(person.endDate) : '—'}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatDateTime(person.createdAt)}</dd>
        </div>
        <div>
          <dt>Last updated</dt>
          <dd>{formatDateTime(person.updatedAt)}</dd>
        </div>
        <div>
          <dt>System ID</dt>
          <dd className="mono">{person.id}</dd>
        </div>
      </dl>

      {attributeEntries.length > 0 && (
        <div className="person-detail__attributes">
          <h3 className="text-title">Custom attributes</h3>
          <dl className="detail-grid">
            {attributeEntries.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  )
}

function GroupsTab({
  groups,
  loading,
  error,
}: {
  groups: Group[] | null
  loading: boolean
  error: string | null
}) {
  if (error !== null) {
    return (
      <p role="alert" className="error-panel__message">
        Could not load this person&rsquo;s groups: {error}
      </p>
    )
  }
  if (loading || groups === null) {
    return (
      <ul className="person-groups-list" aria-hidden="true">
        {Array.from({ length: 3 }).map((_, i) => (
          <li key={i}>
            <span className="skeleton" style={{ width: '12rem', height: '1rem' }} />
          </li>
        ))}
      </ul>
    )
  }
  if (groups.length === 0) {
    return <p>Not a member of any group.</p>
  }
  return (
    <ul className="person-groups-list" data-testid="person-groups-list">
      {groups.map((group) => (
        <li key={group.id} data-testid={`person-group-${group.id}`}>
          <span className="person-groups-list__name">{group.name}</span>
          {group.orgUnitId === null ? (
            <span className="badge badge--neutral">Global</span>
          ) : null}
          {group.description !== null && (
            <span className="person-groups-list__description">{group.description}</span>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * People detail — Milestone 8, Task 2. Tabs: Profile, Groups, Roles,
 * Activity — WAI-ARIA tabs pattern, arrow-key navigable, automatic
 * activation. Read-only in this task (writes are Task 3). Roles and
 * Activity render NotYetBuilt: neither has a read endpoint yet (role
 * assignment and the audit log both arrive in later tasks of this
 * milestone), and an honest placeholder beats fabricating data.
 */
export default function PersonDetailPage() {
  const { id } = useParams<{ id: string }>()
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const orgUnits = useOrgUnits()
  const permissions = useSelfPermissions()
  const { showToast } = useToast()

  const [person, setPerson] = useState<Person | null>(null)
  const [loadError, setLoadError] = useState<{ status?: number; message: string } | null>(null)
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [groupsError, setGroupsError] = useState<string | null>(null)
  const [groupsLoading, setGroupsLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<TabKey>('profile')
  const [deactivateOpen, setDeactivateOpen] = useState(false)
  const tabRefs = useRef<Record<TabKey, HTMLButtonElement | null>>({
    profile: null,
    groups: null,
    roles: null,
    activity: null,
  })

  const canUpdate = permissions.status === 'ready' && permissions.actions.has('user:update')
  const canDeactivate = permissions.status === 'ready' && permissions.actions.has('user:deactivate')

  /**
   * Deactivation's confirmation dialog owns its OWN request lifecycle
   * (ConfirmDialog) — this only needs to perform the call and, on success,
   * update local state, close the dialog, and report a toast naming what
   * ACTUALLY happened (PRODUCT.md: "be certain the action took effect...
   * including that live sessions are dead, not merely that a row changed").
   *
   * `POST /users/:id/deactivate` attempts Keycloak-side session revocation
   * SYNCHRONOUSLY, inline, before it ever responds (see UsersController.
   * deactivate/revokeKeycloakAccess on the API side) — by the time this
   * promise resolves, that attempt has already happened, which is what
   * makes it honest to state as fact in the toast rather than as a hope.
   * `syncState` is resolved fresh, AFTER that attempt, and is what actually
   * varies (almost always 'pending' the instant after a deactivate — the
   * outbox event was just enqueued, no worker has drained it yet — but
   * reported using the SAME word (SYNC_WORD) the badge itself will show a
   * moment later, never a second, hand-written phrase that could drift).
   */
  async function handleConfirmDeactivate() {
    if (accessToken === undefined || person === null) return
    const updated = await deactivatePerson(accessToken, person.id)
    setPerson(updated)
    setDeactivateOpen(false)
    showToast(
      `Deactivated ${updated.displayName}. Sign-in is blocked and active sessions were revoked. ${SYNC_WORD[updated.syncState]}.`,
      updated.syncState === 'failed' ? 'danger' : updated.syncState === 'pending' ? 'warn' : 'neutral',
    )
  }

  useEffect(() => {
    if (accessToken === undefined || id === undefined) return
    let cancelled = false
    setLoadError(null)
    setGroupsError(null)
    setGroupsLoading(true)

    fetchPerson(accessToken, id)
      .then((res) => {
        if (!cancelled) setPerson(res)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setLoadError({
          status: cause instanceof ApiError ? cause.status : undefined,
          message:
            cause instanceof ApiError ? cause.message : 'check your connection and try again',
        })
      })

    fetchGroupsForUser(accessToken, id)
      .then((res) => {
        if (!cancelled) setGroups(res.items)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setGroupsError(
          cause instanceof ApiError ? cause.message : 'check your connection and try again',
        )
      })
      .finally(() => {
        if (!cancelled) setGroupsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [accessToken, id])

  function activateTab(key: TabKey) {
    setActiveTab(key)
    tabRefs.current[key]?.focus()
  }

  function handleTabsKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const currentIndex = TABS.findIndex((t) => t.key === activeTab)
    let nextIndex = currentIndex
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % TABS.length
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = TABS.length - 1
    else return
    event.preventDefault()
    activateTab(TABS[nextIndex].key)
  }

  const orgUnitPath =
    person !== null && orgUnits.status === 'ready' ? (orgUnits.byId.get(person.orgUnitId)?.path ?? null) : null

  if (loadError !== null) {
    const message =
      loadError.status === 403
        ? "You don't have access to this person's record — it's outside what your role can see."
        : loadError.status === 404
          ? 'This person could not be found. They may have been removed or the link is wrong.'
          : `Could not load this person: ${loadError.message}`
    return (
      <div className="person-detail">
        <Link to="/people" className="person-detail__back">
          &larr; People
        </Link>
        <div className="error-panel" role="alert">
          <p className="error-panel__message">{message}</p>
        </div>
      </div>
    )
  }

  if (person === null) {
    return (
      <div className="person-detail">
        <Link to="/people" className="person-detail__back">
          &larr; People
        </Link>
        <div className="person-detail__header">
          <span className="skeleton" style={{ width: '14rem', height: '1.5rem' }} />
        </div>
        <div className="skeleton" style={{ width: '100%', height: '12rem', marginTop: 'var(--space-6)' }} />
      </div>
    )
  }

  return (
    <div className="person-detail">
      <Link to="/people" className="person-detail__back">
        &larr; People
      </Link>

      <header className="person-detail__header">
        <div className="person-detail__title-row">
          <h1 className="text-subject" data-testid="person-detail-name">
            {person.displayName}
          </h1>
          <div className="person-detail__title-actions">
            {canUpdate && (
              <Link to={`/people/${person.id}/edit`} className="btn btn--secondary" data-testid="edit-person-link">
                Edit
              </Link>
            )}
            {canDeactivate && person.status !== 'deactivated' && (
              <button
                type="button"
                className="btn btn--danger"
                data-testid="deactivate-button"
                onClick={() => setDeactivateOpen(true)}
              >
                Deactivate
              </button>
            )}
          </div>
        </div>
        <div className="person-detail__meta">
          <StatusBadge status={person.status} />
          <SyncBadge state={person.syncState} />
          <span className="mono cell-muted">{orgUnitPath ?? person.orgUnitId}</span>
          {person.status === 'deactivated' && person.deactivatedAt !== null && (
            <span className="cell-muted" data-testid="deactivated-at">
              Deactivated {formatDateTime(person.deactivatedAt)}
            </span>
          )}
        </div>
      </header>

      <ConfirmDialog
        open={deactivateOpen}
        title={`Deactivate ${person.displayName}?`}
        confirmLabel="Deactivate"
        tone="danger"
        onConfirm={handleConfirmDeactivate}
        onDismiss={() => setDeactivateOpen(false)}
        testId="deactivate-dialog"
      >
        <p data-testid="deactivate-consequence">
          This immediately blocks <strong>{person.displayName}</strong>&rsquo;s sign-in and revokes their
          active sessions — they are signed out everywhere within moments.
        </p>
        <p>Deactivation is permanent. {person.displayName} cannot be reactivated from this console.</p>
      </ConfirmDialog>

      <div className="tabs" role="tablist" aria-label="Person detail sections" onKeyDown={handleTabsKeyDown}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            ref={(el) => {
              tabRefs.current[tab.key] = el
            }}
            id={`tab-${tab.key}`}
            role="tab"
            type="button"
            aria-selected={activeTab === tab.key}
            aria-controls={`panel-${tab.key}`}
            tabIndex={activeTab === tab.key ? 0 : -1}
            className="tab"
            onClick={() => activateTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        id="panel-profile"
        role="tabpanel"
        aria-labelledby="tab-profile"
        hidden={activeTab !== 'profile'}
        tabIndex={0}
        className="tabpanel"
      >
        <ProfileTab person={person} orgUnitPath={orgUnitPath} />
      </div>
      <div
        id="panel-groups"
        role="tabpanel"
        aria-labelledby="tab-groups"
        hidden={activeTab !== 'groups'}
        tabIndex={0}
        className="tabpanel"
      >
        <GroupsTab groups={groups} loading={groupsLoading} error={groupsError} />
      </div>
      <div
        id="panel-roles"
        role="tabpanel"
        aria-labelledby="tab-roles"
        hidden={activeTab !== 'roles'}
        tabIndex={0}
        className="tabpanel"
      >
        <NotYetBuilt
          title="Roles"
          note="Viewing and granting role assignments from here is coming in a later task. Ask a super admin to check assignments directly for now."
        />
      </div>
      <div
        id="panel-activity"
        role="tabpanel"
        aria-labelledby="tab-activity"
        hidden={activeTab !== 'activity'}
        tabIndex={0}
        className="tabpanel"
      >
        <NotYetBuilt
          title="Activity"
          note="This person's audit history isn't surfaced here yet — the audit log view is coming in a later task."
        />
      </div>
    </div>
  )
}
