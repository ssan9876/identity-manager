import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useParams } from 'react-router-dom'
import { ApiError } from '../api/client'
import { formatDateTime } from '../format'
import { useOrgUnitPath } from '../org-units/OrgUnitsContext'
import { useSelfPermissions } from '../shell/permissions'
import { GroupScopeBadge } from './badges'
import { fetchGroup, type Group } from './api'
import { GroupMembersTab } from './GroupMembersTab'
import { GroupNestedGroupsTab } from './GroupNestedGroupsTab'
import './GroupDetailPage.css'

type TabKey = 'overview' | 'members' | 'nested'
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'members', label: 'Members' },
  { key: 'nested', label: 'Nested groups' },
]

function OverviewTab({ group, orgUnitPath }: { group: Group; orgUnitPath: string | null }) {
  const attributeEntries = Object.entries(group.attributes)

  return (
    <div>
      <dl className="detail-grid">
        {/* A scoped group's own scope badge already lives in the page
            header (visible regardless of tab, same as PersonDetailPage's
            Status/Sync badges) — this row adds a navigable LINK to the org
            unit itself instead of repeating that same badge a second time.
            Global has no org unit to link to; the dedicated note below
            covers it. */}
        {group.orgUnitId !== null && (
          <div>
            <dt>Org unit</dt>
            <dd>
              <Link to={`/org-units/${group.orgUnitId}`} className="mono">
                {orgUnitPath ?? group.orgUnitId}
              </Link>
            </dd>
          </div>
        )}
        <div>
          <dt>Description</dt>
          <dd>{group.description ?? '—'}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatDateTime(group.createdAt)}</dd>
        </div>
        <div>
          <dt>Last updated</dt>
          <dd>{formatDateTime(group.updatedAt)}</dd>
        </div>
        <div>
          <dt>System ID</dt>
          <dd className="mono">{group.id}</dd>
        </div>
      </dl>

      {group.orgUnitId === null && (
        <p className="group-detail__global-note" data-testid="group-global-note">
          <strong>Global</strong> — this group has no org unit. It is visible to, and manageable by, any
          admin holding group permissions anywhere, and nesting it carries no containment check the way a
          scoped group's does.
        </p>
      )}

      {attributeEntries.length > 0 && (
        <div className="group-detail__attributes">
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

/**
 * `/groups/:id` — Milestone 8, Task 4. "Same table and tab vocabulary as
 * People" (this task's own contract): WAI-ARIA tabs, arrow-key navigable,
 * automatic activation — the identical pattern PersonDetailPage established
 * in Task 2, applied to Overview/Members/Nested groups instead of
 * Profile/Groups/Roles/Activity.
 */
export default function GroupDetailPage() {
  const { id } = useParams<{ id: string }>()
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const permissions = useSelfPermissions()

  const [group, setGroup] = useState<Group | null>(null)
  const [loadError, setLoadError] = useState<{ status?: number; message: string } | null>(null)
  const [activeTab, setActiveTab] = useState<TabKey>('overview')
  const tabRefs = useRef<Record<TabKey, HTMLButtonElement | null>>({
    overview: null,
    members: null,
    nested: null,
  })

  const orgUnitPath = useOrgUnitPath(group?.orgUnitId ?? null)

  const canUpdate = permissions.status === 'ready' && permissions.actions.has('group:update')
  const canManageMembers = permissions.status === 'ready' && permissions.actions.has('group:manage_members')

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

  if (loadError !== null) {
    const message =
      loadError.status === 403
        ? "You don't have access to this group's record — it's outside what your role can see."
        : loadError.status === 404
          ? 'This group could not be found. It may have been removed or the link is wrong.'
          : `Could not load this group: ${loadError.message}`
    return (
      <div className="group-detail">
        <Link to="/groups" className="person-detail__back">
          &larr; Groups
        </Link>
        <div className="error-panel" role="alert">
          <p className="error-panel__message">{message}</p>
        </div>
      </div>
    )
  }

  if (group === null) {
    return (
      <div className="group-detail">
        <Link to="/groups" className="person-detail__back">
          &larr; Groups
        </Link>
        <div className="person-detail__header">
          <span className="skeleton" style={{ width: '14rem', height: '1.5rem' }} />
        </div>
        <div className="skeleton" style={{ width: '100%', height: '12rem', marginTop: 'var(--space-6)' }} />
      </div>
    )
  }

  return (
    <div className="group-detail">
      <Link to="/groups" className="person-detail__back">
        &larr; Groups
      </Link>

      <header className="person-detail__header">
        <div className="person-detail__title-row">
          <h1 className="text-subject" data-testid="group-detail-name">
            {group.name}
          </h1>
          <div className="person-detail__title-actions">
            {canUpdate && (
              <Link to={`/groups/${group.id}/edit`} className="btn btn--secondary" data-testid="edit-group-link">
                Edit
              </Link>
            )}
          </div>
        </div>
        <div className="person-detail__meta">
          <GroupScopeBadge group={group} orgUnitPath={orgUnitPath} />
          {group.description !== null && <span className="cell-muted">{group.description}</span>}
        </div>
      </header>

      <div className="tabs" role="tablist" aria-label="Group detail sections" onKeyDown={handleTabsKeyDown}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            ref={(el) => {
              tabRefs.current[tab.key] = el
            }}
            id={`group-tab-${tab.key}`}
            role="tab"
            type="button"
            aria-selected={activeTab === tab.key}
            aria-controls={`group-panel-${tab.key}`}
            tabIndex={activeTab === tab.key ? 0 : -1}
            className="tab"
            onClick={() => activateTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        id="group-panel-overview"
        role="tabpanel"
        aria-labelledby="group-tab-overview"
        hidden={activeTab !== 'overview'}
        tabIndex={0}
        className="tabpanel"
      >
        <OverviewTab group={group} orgUnitPath={orgUnitPath} />
      </div>
      <div
        id="group-panel-members"
        role="tabpanel"
        aria-labelledby="group-tab-members"
        hidden={activeTab !== 'members'}
        tabIndex={0}
        className="tabpanel"
      >
        <GroupMembersTab groupId={group.id} groupName={group.name} canManageMembers={canManageMembers} />
      </div>
      <div
        id="group-panel-nested"
        role="tabpanel"
        aria-labelledby="group-tab-nested"
        hidden={activeTab !== 'nested'}
        tabIndex={0}
        className="tabpanel"
      >
        <GroupNestedGroupsTab groupId={group.id} groupName={group.name} canManageMembers={canManageMembers} />
      </div>
    </div>
  )
}
