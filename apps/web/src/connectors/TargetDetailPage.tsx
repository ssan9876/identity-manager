import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useParams } from 'react-router-dom'
import { ApiError } from '../api/client'
import { DeadLettersTab } from '../audit/DeadLettersTab'
import { formatDateTime } from '../format'
// Reuses PersonDetailPage's own header/back-link classes — the SAME
// established cross-feature convention GroupDetailPage.tsx already uses
// (`.person-detail__back`/`__header`/`__title-row`/`__meta`), so a target's
// detail page reads as the same family of screen as a person's or a
// group's, not a bespoke one-off.
import '../people/PersonDetailPage.css'
import { useSelfPermissions } from '../shell/permissions'
import { ALL_CONNECTOR_TARGETS, CONNECTOR_TARGET_LABEL, fetchConnectorTarget, type ConnectorTarget, type ConnectorTargetSummary } from './api'
import { EnabledBadge, HealthBadge } from './badges'
import { ConfigurationTab } from './ConfigurationTab'
import './Connectors.css'
import { DryRunTab } from './DryRunTab'

type TabKey = 'configuration' | 'dead-letters' | 'dry-run'
const TABS: { key: TabKey; label: string }[] = [
  { key: 'configuration', label: 'Configuration' },
  { key: 'dead-letters', label: 'Dead letters' },
  { key: 'dry-run', label: 'Dry run' },
]

function isConnectorTarget(value: string | undefined): value is ConnectorTarget {
  return value !== undefined && (ALL_CONNECTOR_TARGETS as readonly string[]).includes(value)
}

/**
 * `/connectors/:target` — Milestone 14, Task 9. Header carries the state
 * that must be readable "at a glance" regardless of which tab is open
 * (enabled/health/last successful sync — same "visible regardless of tab"
 * placement PersonDetailPage's own Status/Sync badges use); tabs host the
 * three things this task's BUILD section asks for beyond that glance:
 * Configuration (enable/disable, non-secret config, blast radius),
 * Dead letters (this target's own slice of Milestone 8's view — DeadLettersTab
 * itself, `fixedTarget`-scoped), and Dry run (plan, then apply).
 */
export default function TargetDetailPage() {
  const { target: rawTarget } = useParams<{ target: string }>()
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const permissions = useSelfPermissions()

  const [summary, setSummary] = useState<ConnectorTargetSummary | null>(null)
  const [loadError, setLoadError] = useState<{ status?: number; message: string } | null>(null)
  const [activeTab, setActiveTab] = useState<TabKey>('configuration')
  const [refreshToken, setRefreshToken] = useState(0)
  const tabRefs = useRef<Record<TabKey, HTMLButtonElement | null>>({
    configuration: null,
    'dead-letters': null,
    'dry-run': null,
  })

  const canManage = permissions.status === 'ready' && permissions.actions.has('connector:manage')
  const target = isConnectorTarget(rawTarget) ? rawTarget : null

  useEffect(() => {
    if (accessToken === undefined || target === null) return
    let cancelled = false
    setLoadError(null)

    fetchConnectorTarget(accessToken, target)
      .then((res) => {
        if (!cancelled) setSummary(res)
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
  }, [accessToken, target, refreshToken])

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

  if (target === null) {
    return (
      <div className="target-detail">
        <Link to="/connectors" className="person-detail__back">
          &larr; Connectors
        </Link>
        <div className="error-panel" role="alert">
          <p className="error-panel__message">This isn&rsquo;t a known connector target.</p>
        </div>
      </div>
    )
  }

  if (loadError !== null) {
    const message =
      loadError.status === 403
        ? "You don't have access to this target's configuration — it's outside what your role can see."
        : `Could not load this target: ${loadError.message}`
    return (
      <div className="target-detail">
        <Link to="/connectors" className="person-detail__back">
          &larr; Connectors
        </Link>
        <div className="error-panel" role="alert">
          <p className="error-panel__message">{message}</p>
        </div>
      </div>
    )
  }

  if (summary === null) {
    return (
      <div className="target-detail">
        <Link to="/connectors" className="person-detail__back">
          &larr; Connectors
        </Link>
        <div className="person-detail__header">
          <span className="skeleton" style={{ width: '14rem', height: '1.5rem' }} />
        </div>
        <div className="skeleton" style={{ width: '100%', height: '12rem', marginTop: 'var(--space-6)' }} />
      </div>
    )
  }

  return (
    <div className="target-detail">
      <Link to="/connectors" className="person-detail__back">
        &larr; Connectors
      </Link>

      <header className="person-detail__header">
        <div className="person-detail__title-row">
          <h1 className="text-subject" data-testid="target-detail-name">
            {CONNECTOR_TARGET_LABEL[target]}
          </h1>
        </div>
        <div className="person-detail__meta">
          <EnabledBadge enabled={summary.enabled} />
          <HealthBadge status={summary.healthStatus} />
          <span className="cell-muted" data-testid="target-detail-last-sync">
            Last successful sync:{' '}
            {summary.lastSuccessfulSyncAt !== null ? formatDateTime(summary.lastSuccessfulSyncAt) : 'never'}
          </span>
        </div>
        {summary.healthDetail !== null && (
          <p className="cell-muted target-detail__health-detail" data-testid="target-detail-health-detail">
            {summary.healthDetail}
          </p>
        )}
      </header>

      <div className="tabs" role="tablist" aria-label="Target detail sections" onKeyDown={handleTabsKeyDown}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            ref={(el) => {
              tabRefs.current[tab.key] = el
            }}
            id={`target-tab-${tab.key}`}
            role="tab"
            type="button"
            aria-selected={activeTab === tab.key}
            aria-controls={`target-panel-${tab.key}`}
            tabIndex={activeTab === tab.key ? 0 : -1}
            className="tab"
            onClick={() => activateTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        id="target-panel-configuration"
        role="tabpanel"
        aria-labelledby="target-tab-configuration"
        hidden={activeTab !== 'configuration'}
        tabIndex={0}
        className="tabpanel"
      >
        <ConfigurationTab target={target} summary={summary} canManage={canManage} onSaved={(next) => setSummary(next)} />
      </div>
      <div
        id="target-panel-dead-letters"
        role="tabpanel"
        aria-labelledby="target-tab-dead-letters"
        hidden={activeTab !== 'dead-letters'}
        tabIndex={0}
        className="tabpanel"
      >
        <DeadLettersTab fixedTarget={target} />
      </div>
      <div
        id="target-panel-dry-run"
        role="tabpanel"
        aria-labelledby="target-tab-dry-run"
        hidden={activeTab !== 'dry-run'}
        tabIndex={0}
        className="tabpanel"
      >
        <DryRunTab target={target} canManage={canManage} onApplied={() => setRefreshToken((t) => t + 1)} />
      </div>
    </div>
  )
}
