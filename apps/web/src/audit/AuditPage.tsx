import { useRef, useState, type KeyboardEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useSelfPermissions } from '../shell/permissions'
import { AuditLogTable } from './AuditLogTable'
import { DeadLettersTab } from './DeadLettersTab'
import './AuditPage.css'

type TabKey = 'log' | 'dead-letters'
const TABS: { key: TabKey; label: string }[] = [
  { key: 'log', label: 'Log' },
  { key: 'dead-letters', label: 'Dead letters' },
]

/**
 * `/audit` — Milestone 8, Task 5. Two tabs, not two nav items: DESIGN.md's
 * left nav is a fixed list (People · Groups · Org units · Roles · Import ·
 * Audit) with no slot for a separate "Sync"/"Dead letters" destination, and
 * `GET /outbox/dead-letters` is gated behind the exact same `audit:read`
 * permission as the audit log itself (OutboxController's own doc comment:
 * "the same category of information audit_log already exists to expose") —
 * so the two belong on the SAME screen, the way Person/Group detail already
 * use tabs to host several read surfaces behind one permission-checked page,
 * rather than inventing a nav destination the design spec never lists.
 *
 * `?batchId=` seeds the Log tab's filter once on load — the Import page's
 * "View in audit log" link after a commit (task-5-brief.md: "surface the
 * batch_id").
 */
export default function AuditPage() {
  const permissions = useSelfPermissions()
  const [searchParams] = useSearchParams()
  const initialBatchId = searchParams.get('batchId') ?? undefined

  const [activeTab, setActiveTab] = useState<TabKey>('log')
  const tabRefs = useRef<Record<TabKey, HTMLButtonElement | null>>({ log: null, 'dead-letters': null })

  const canRead = permissions.status === 'ready' && permissions.actions.has('audit:read')

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
      <div className="audit-page" aria-hidden="true">
        <span className="skeleton" style={{ width: '8rem', height: '1.5rem' }} />
        <span className="skeleton" style={{ width: '100%', height: '10rem', marginTop: 'var(--space-5)' }} />
      </div>
    )
  }

  if (!canRead) {
    return (
      <div className="audit-page">
        <h1 className="text-title">Audit</h1>
        <p className="cell-muted" data-testid="audit-permission-note">
          You don&rsquo;t hold the audit:read permission, so the audit log isn&rsquo;t available to you. This is
          what the auditor role exists for — ask an administrator if you need it.
        </p>
      </div>
    )
  }

  return (
    <div className="audit-page">
      <h1 className="text-title">Audit</h1>
      <p className="audit-page__intro">
        Every create, update, deactivation and role change in the console, permanently recorded. Entries here can
        never be edited or deleted.
      </p>

      <div className="tabs" role="tablist" aria-label="Audit sections" onKeyDown={handleTabsKeyDown}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            ref={(el) => {
              tabRefs.current[tab.key] = el
            }}
            id={`audit-tab-${tab.key}`}
            role="tab"
            type="button"
            aria-selected={activeTab === tab.key}
            aria-controls={`audit-panel-${tab.key}`}
            tabIndex={activeTab === tab.key ? 0 : -1}
            className="tab"
            onClick={() => activateTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        id="audit-panel-log"
        role="tabpanel"
        aria-labelledby="audit-tab-log"
        hidden={activeTab !== 'log'}
        tabIndex={0}
        className="tabpanel"
      >
        <AuditLogTable initialBatchId={initialBatchId} />
      </div>
      <div
        id="audit-panel-dead-letters"
        role="tabpanel"
        aria-labelledby="audit-tab-dead-letters"
        hidden={activeTab !== 'dead-letters'}
        tabIndex={0}
        className="tabpanel"
      >
        <DeadLettersTab />
      </div>
    </div>
  )
}
