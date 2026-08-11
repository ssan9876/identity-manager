import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useSearchParams } from 'react-router-dom'
import { ApiError } from '../api/client'
import { formatDateTime } from '../format'
import { useSelfPermissions } from '../shell/permissions'
import { AttributeMappingsEditor } from './AttributeMappingsEditor'
import { CONNECTOR_TARGET_LABEL, fetchConnectorTargets, type ConnectorTargetSummary } from './api'
import { EnabledBadge, HealthBadge } from './badges'
import { OrganizationScopeSelector } from './OrganizationScopeSelector'
import './Connectors.css'

type TabKey = 'targets' | 'mappings'
const TABS: { key: TabKey; label: string }[] = [
  { key: 'targets', label: 'Targets' },
  { key: 'mappings', label: 'Attribute mappings' },
]

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <tr key={i} aria-hidden="true">
          {Array.from({ length: 5 }).map((__, c) => (
            <td key={c}>
              <span className="skeleton" style={{ width: c === 0 ? '10rem' : '8rem', height: '0.9rem' }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

function TargetsTab({
  canListOrganizations,
  organizationId,
  onOrganizationChange,
}: {
  canListOrganizations: boolean
  organizationId: string | undefined
  onOrganizationChange: (organizationId: string | undefined) => void
}) {
  const auth = useAuth()
  const accessToken = auth.user?.access_token

  const [targets, setTargets] = useState<ConnectorTargetSummary[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)

  useEffect(() => {
    if (accessToken === undefined) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)

    fetchConnectorTargets(accessToken, organizationId)
      .then((res) => {
        if (!cancelled) setTargets(res)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setLoadError(
          cause instanceof ApiError
            ? `Could not load connector targets: ${cause.message}`
            : 'Could not load connector targets. Check your connection and try again.',
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [accessToken, retryToken, organizationId])

  const orgScope = (
    <OrganizationScopeSelector
      canListOrganizations={canListOrganizations}
      selectedOrganizationId={organizationId}
      onChange={onOrganizationChange}
    />
  )

  if (loadError !== null) {
    return (
      <>
        {orgScope}
        <div className="error-panel" role="alert">
          <p className="error-panel__message">{loadError}</p>
          <button type="button" className="btn btn--secondary" onClick={() => setRetryToken((t) => t + 1)}>
            Try again
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      {orgScope}
      <div className="table-wrap">
      <table className="table" data-testid="connector-targets-table">
        <thead>
          <tr>
            <th scope="col">Target</th>
            <th scope="col">Status</th>
            <th scope="col">Health</th>
            <th scope="col">Last successful sync</th>
            <th scope="col">Blast radius</th>
          </tr>
        </thead>
        <tbody>
          {loading || targets === null ? (
            <SkeletonRows />
          ) : (
            targets.map((target) => (
              <tr key={target.target} data-testid="connector-target-row">
                <td>
                  <Link
                    to={`/connectors/${target.target}${organizationId !== undefined ? `?organizationId=${organizationId}` : ''}`}
                    className="row-link"
                    data-testid={`connector-target-link-${target.target}`}
                  >
                    {CONNECTOR_TARGET_LABEL[target.target]}
                  </Link>
                </td>
                <td>
                  <EnabledBadge enabled={target.enabled} />
                </td>
                <td>
                  <HealthBadge status={target.healthStatus} />
                </td>
                <td className="cell-muted" data-testid="connector-target-last-sync">
                  {target.lastSuccessfulSyncAt !== null ? formatDateTime(target.lastSuccessfulSyncAt) : '—'}
                </td>
                <td className="cell-muted">
                  {target.blastRadiusThreshold}% / floor {target.blastRadiusFloor}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
    </>
  )
}

/**
 * `/connectors` — Milestone 14, Task 9, the connector admin console's own
 * landing page. Two tabs, not two nav items — the same reasoning AuditPage
 * already established for Log/Dead letters (docs/design-system.md's left nav is a fixed
 * list with no slot for a second "Connectors" destination, and both tabs
 * here are gated behind the SAME `connector:read` permission): "Targets"
 * (enable/disable, health, last successful sync — links out to each
 * target's own detail page for configuration, dead letters and dry run) and
 * "Attribute mappings" (the editor over `attribute_target_mappings`, which
 * is target-agnostic by nature — one grid, not five separate per-target
 * screens).
 */
export default function ConnectorsListPage() {
  const permissions = useSelfPermissions()
  const [activeTab, setActiveTab] = useState<TabKey>('targets')
  const tabRefs = useRef<Record<TabKey, HTMLButtonElement | null>>({ targets: null, mappings: null })
  // Per-organization connector targets: carried in the URL (`?organizationId=`),
  // the same contract TargetDetailPage.tsx uses, so a link INTO this page
  // (OrganizationsPage's Targets column, in particular) lands already scoped
  // to the right tenant instead of silently falling back to master.
  // `undefined`/absent means master, the same contract every
  // connector-targets API call uses.
  const [searchParams, setSearchParams] = useSearchParams()
  const rawOrganizationId = searchParams.get('organizationId')
  const organizationId = rawOrganizationId === null ? undefined : rawOrganizationId

  function setOrganizationId(next: string | undefined): void {
    const params = new URLSearchParams(searchParams)
    if (next === undefined) {
      params.delete('organizationId')
    } else {
      params.set('organizationId', next)
    }
    setSearchParams(params, { replace: true })
  }

  const canRead = permissions.status === 'ready' && permissions.actions.has('connector:read')
  const canManage = permissions.status === 'ready' && permissions.actions.has('connector:manage')
  const canListOrganizations = permissions.status === 'ready' && permissions.actions.has('organization:read')

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

  if (permissions.status === 'loading') {
    return (
      <div className="connectors-page" aria-hidden="true">
        <span className="skeleton" style={{ width: '10rem', height: '1.5rem' }} />
        <span className="skeleton" style={{ width: '100%', height: '10rem', marginTop: 'var(--space-5)' }} />
      </div>
    )
  }

  if (!canRead) {
    return (
      <div className="connectors-page">
        <h1 className="text-title">Connectors</h1>
        <p className="cell-muted" data-testid="connectors-permission-note">
          You don&rsquo;t hold the connector:read permission, so the connector console isn&rsquo;t available to
          you. Ask a super admin if you need this.
        </p>
      </div>
    )
  }

  return (
    <div className="connectors-page">
      <h1 className="text-title">Connectors</h1>
      <p className="connectors-page__intro">
        Every directory this system pushes mastered identity outward into: enable or disable a target, edit its
        non-secret configuration, watch its health, and run a reconcile before anything applies.
      </p>

      <div className="tabs" role="tablist" aria-label="Connector sections" onKeyDown={handleTabsKeyDown}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            ref={(el) => {
              tabRefs.current[tab.key] = el
            }}
            id={`connectors-tab-${tab.key}`}
            role="tab"
            type="button"
            aria-selected={activeTab === tab.key}
            aria-controls={`connectors-panel-${tab.key}`}
            tabIndex={activeTab === tab.key ? 0 : -1}
            className="tab"
            onClick={() => activateTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        id="connectors-panel-targets"
        role="tabpanel"
        aria-labelledby="connectors-tab-targets"
        hidden={activeTab !== 'targets'}
        tabIndex={0}
        className="tabpanel"
      >
        <TargetsTab
          canListOrganizations={canListOrganizations}
          organizationId={organizationId}
          onOrganizationChange={setOrganizationId}
        />
      </div>
      <div
        id="connectors-panel-mappings"
        role="tabpanel"
        aria-labelledby="connectors-tab-mappings"
        hidden={activeTab !== 'mappings'}
        tabIndex={0}
        className="tabpanel"
      >
        <AttributeMappingsEditor canManage={canManage} />
      </div>
    </div>
  )
}
