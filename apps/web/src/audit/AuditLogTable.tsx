import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link } from 'react-router-dom'
import { ApiError } from '../api/client'
import { formatDateTime } from '../format'
import type { Page } from '../org-units/api'
import {
  actionLabel,
  fetchAuditLog,
  KNOWN_AUDIT_ACTIONS,
  KNOWN_AUDIT_RESOURCE_TYPES,
  resourceLinkPath,
  resourceTypeLabel,
  type AuditEntry,
} from './api'
import { AuditDiff } from './AuditDiff'
import './AuditPage.css'

const LIMIT = 25
const SEARCH_DEBOUNCE_MS = 300
const ROW_TOGGLE_SELECTOR = '[data-row-link="true"]'

function handleRowNavKeyDown(event: KeyboardEvent<HTMLTableSectionElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const container = event.currentTarget
  const links = Array.from(container.querySelectorAll<HTMLElement>(ROW_TOGGLE_SELECTOR))
  if (links.length === 0) return

  const currentIndex = links.indexOf(document.activeElement as HTMLElement)
  let nextIndex = currentIndex

  if (event.key === 'ArrowDown') nextIndex = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, links.length - 1)
  else if (event.key === 'ArrowUp') nextIndex = currentIndex < 0 ? 0 : Math.max(currentIndex - 1, 0)
  else if (event.key === 'Home') nextIndex = 0
  else if (event.key === 'End') nextIndex = links.length - 1

  if (nextIndex !== currentIndex) {
    event.preventDefault()
    links[nextIndex]?.focus()
  }
}

function SkeletonRows({ columns }: { columns: number }) {
  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <tr key={i} aria-hidden="true">
          {Array.from({ length: columns }).map((__, c) => (
            <td key={c}>
              <span className="skeleton" style={{ width: c === 0 ? '9rem' : '7rem', height: '0.9rem' }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

function ActorCell({ entry }: { entry: AuditEntry }) {
  if (entry.actorUserId === null) {
    return <span className="cell-muted">System</span>
  }
  const name = entry.actorDisplayName ?? entry.actorUsername ?? entry.actorUserId
  return (
    <Link to={`/people/${entry.actorUserId}`} className="row-link">
      {name}
    </Link>
  )
}

function ResourceCell({ entry }: { entry: AuditEntry }) {
  if (entry.resourceId === null) {
    return <span>{resourceTypeLabel(entry.resourceType)}</span>
  }
  const path = resourceLinkPath(entry.resourceType, entry.resourceId)
  return (
    <div>
      <div>{resourceTypeLabel(entry.resourceType)}</div>
      {path !== null ? (
        <Link to={path} className="mono cell-muted audit-log__resource-id">
          {entry.resourceId}
        </Link>
      ) : (
        <span className="mono cell-muted audit-log__resource-id">{entry.resourceId}</span>
      )}
    </div>
  )
}

export interface AuditLogTableProps {
  /** Locks the Resource type filter to one value and hides the control — used by PersonDetailPage's Activity tab, which is always scoped to ONE person. */
  fixedResourceType?: string
  /** Locks the resource id and, when set alongside `fixedResourceType`, hides the Resource column entirely (every row is already known to be about this one record). */
  fixedResourceId?: string
  /** Seeds the batchId filter once, on mount — the Import page's "View in audit log" deep link (task-5-brief.md: "surface the batch_id"). Shown as a dismissible chip, never a permanent labelled control, since a raw id is not something an admin types into a filter bar. */
  initialBatchId?: string
  emptyMessage?: string
}

/**
 * The reusable audit log list — filters (actor/action/resource type/date
 * range, task-5-brief.md's own four dimensions), a sticky-header table,
 * skeleton loading, an empty state, pagination, and a per-row expandable
 * before/after diff (AuditDiff.tsx). Shared by the standalone `/audit` "Log"
 * tab (every filter live) and PersonDetailPage's Activity tab (resource
 * fixed to that one person, resource-type control hidden).
 *
 * Deliberately NOT URL-search-param-synced (contrast PeopleListPage): this
 * table can be embedded inside an already-tabbed page (Activity), where
 * hijacking the shared URL for its own filters would fight the tab
 * switcher's own state. The one exception is `initialBatchId`, read ONCE on
 * mount by the caller from `useSearchParams` — enough to make the Import
 * page's deep link work without full two-way binding.
 */
export function AuditLogTable({ fixedResourceType, fixedResourceId, initialBatchId, emptyMessage }: AuditLogTableProps) {
  const auth = useAuth()
  const accessToken = auth.user?.access_token

  const [actorInput, setActorInput] = useState('')
  const [actor, setActor] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [action, setAction] = useState('')
  const [resourceType, setResourceType] = useState(fixedResourceType ?? '')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [batchId, setBatchId] = useState<string | undefined>(initialBatchId)
  const [offset, setOffset] = useState(0)

  const [page, setPage] = useState<Page<AuditEntry> | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())

  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    }
  }, [])

  function onActorInputChange(value: string) {
    setActorInput(value)
    if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setActor(value)
      setOffset(0)
    }, SEARCH_DEBOUNCE_MS)
  }

  useEffect(() => {
    if (accessToken === undefined) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)

    void fetchAuditLog(accessToken, {
      limit: LIMIT,
      offset,
      actor: actor || undefined,
      action: action || undefined,
      resourceType: fixedResourceType ?? (resourceType || undefined),
      resourceId: fixedResourceId,
      batchId,
      from: from || undefined,
      to: to || undefined,
    })
      .then((res) => {
        if (cancelled) return
        setPage(res)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setLoadError(
          cause instanceof ApiError
            ? `Could not load the audit log: ${cause.message}`
            : 'Could not load the audit log. Check your connection and try again.',
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [accessToken, actor, action, resourceType, fixedResourceType, fixedResourceId, batchId, from, to, offset, retryToken])

  /**
   * `sourceElement` is the clicked toggle button itself — used ONLY to reset
   * `.table-wrap`'s own horizontal scroll back to 0 when a row OPENS, never
   * when it closes. Visual-pass finding: the toggle lives in the table's
   * TRAILING column, so at a narrow viewport a click auto-scrolls the
   * table fully right to bring it into view first — and the diff content
   * that then appears renders at the table's natural (unscrolled) left
   * edge, entirely off-screen, a click that visibly flips the button to
   * "Hide" while showing nothing. `position: sticky` on the diff panel
   * itself was tried and rejected (AuditPage.css's own doc comment on
   * `.audit-diff`: it interacts badly with a colSpan `<td>`'s intrinsic
   * sizing, computing a partially off-screen position for the wider
   * update-diff shape specifically). Resetting scroll at the moment of
   * opening is simpler and has no such edge case: the content the row is
   * ABOUT to reveal is guaranteed visible because nothing is scrolled away
   * from it in the first place.
   */
  const toggleExpanded = useCallback((id: number, sourceElement?: HTMLElement) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      const opening = !next.has(id)
      if (opening) next.add(id)
      else next.delete(id)

      if (opening) {
        const wrap = sourceElement?.closest<HTMLElement>('.table-wrap')
        if (wrap) wrap.scrollLeft = 0
      }

      return next
    })
  }, [])

  const filtersActive = actor !== '' || action !== '' || (fixedResourceType === undefined && resourceType !== '') || from !== '' || to !== '' || batchId !== undefined

  function clearFilters() {
    setActorInput('')
    setActor('')
    setAction('')
    if (fixedResourceType === undefined) setResourceType('')
    setFrom('')
    setTo('')
    setBatchId(undefined)
    setOffset(0)
  }

  const showResourceColumn = !(fixedResourceType !== undefined && fixedResourceId !== undefined)
  const columnCount = 3 + (showResourceColumn ? 1 : 0) + 1 // When, Actor, Action, [Resource], Batch — Details is its own trailing header but shares a column with Batch's row via a second control; kept simple by counting distinct <th>s below instead. See render.

  const total = page?.total ?? 0
  const rangeStart = total === 0 ? 0 : offset + 1
  const rangeEnd = Math.min(offset + LIMIT, total)

  return (
    <div className="audit-log">
      {batchId !== undefined && (
        <p className="audit-log__chip" data-testid="audit-batch-chip">
          Filtered to batch <span className="mono">{batchId}</span>.{' '}
          <button type="button" className="btn btn--ghost audit-log__chip-clear" onClick={() => setBatchId(undefined)}>
            Clear
          </button>
        </p>
      )}

      <div className="audit-log__filters">
        <div className="field audit-log__actor-field">
          <label className="field__label" htmlFor="audit-actor">
            Actor
          </label>
          <input
            id="audit-actor"
            type="search"
            className="input"
            placeholder="Search by name or username…"
            data-testid="audit-actor-input"
            value={actorInput}
            onChange={(e) => onActorInputChange(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="audit-action">
            Action
          </label>
          <select
            id="audit-action"
            className="select"
            data-testid="audit-action-select"
            value={action}
            onChange={(e) => {
              setAction(e.target.value)
              setOffset(0)
            }}
          >
            <option value="">All actions</option>
            {KNOWN_AUDIT_ACTIONS.map((key) => (
              <option key={key} value={key}>
                {actionLabel(key)}
              </option>
            ))}
          </select>
        </div>

        {fixedResourceType === undefined && (
          <div className="field">
            <label className="field__label" htmlFor="audit-resource-type">
              Resource
            </label>
            <select
              id="audit-resource-type"
              className="select"
              data-testid="audit-resource-type-select"
              value={resourceType}
              onChange={(e) => {
                setResourceType(e.target.value)
                setOffset(0)
              }}
            >
              <option value="">All resources</option>
              {KNOWN_AUDIT_RESOURCE_TYPES.map((key) => (
                <option key={key} value={key}>
                  {resourceTypeLabel(key)}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="field">
          <label className="field__label" htmlFor="audit-from">
            From
          </label>
          <input
            id="audit-from"
            type="date"
            className="input"
            data-testid="audit-from-input"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value)
              setOffset(0)
            }}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="audit-to">
            To
          </label>
          <input
            id="audit-to"
            type="date"
            className="input"
            data-testid="audit-to-input"
            value={to}
            onChange={(e) => {
              setTo(e.target.value)
              setOffset(0)
            }}
          />
        </div>
      </div>

      <div className="table-wrap">
        {loadError !== null ? (
          <div className="error-panel" role="alert">
            <p className="error-panel__message">{loadError}</p>
            <button type="button" className="btn btn--secondary" onClick={() => setRetryToken((t) => t + 1)}>
              Try again
            </button>
          </div>
        ) : !loading && page !== null && page.items.length === 0 ? (
          <div className="empty-state">
            {filtersActive ? (
              <>
                <h3>No entries match these filters</h3>
                <p>Try a different search term or date range, or clear the filters to see everything.</p>
                <button type="button" className="btn btn--secondary" onClick={clearFilters}>
                  Clear filters
                </button>
              </>
            ) : (
              <>
                <h3>{emptyMessage ?? 'No activity recorded yet'}</h3>
                <p>Every create, update and role change in the console writes an entry here, permanently.</p>
              </>
            )}
          </div>
        ) : (
          <table className="table" data-testid="audit-log-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                {showResourceColumn && <th scope="col">Resource</th>}
                <th scope="col">Batch</th>
                <th scope="col">
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody onKeyDown={handleRowNavKeyDown}>
              {loading || page === null ? (
                <SkeletonRows columns={columnCount} />
              ) : (
                page.items.map((entry) => {
                  const expanded = expandedIds.has(entry.id)
                  return (
                    <Fragment key={entry.id}>
                      <tr data-testid="audit-log-row">
                        <td className="cell-muted">{formatDateTime(entry.createdAt)}</td>
                        <td>
                          <ActorCell entry={entry} />
                        </td>
                        <td>
                          <div>{actionLabel(entry.action)}</div>
                          <div className="mono cell-muted audit-log__action-raw">{entry.action}</div>
                        </td>
                        {showResourceColumn && (
                          <td>
                            <ResourceCell entry={entry} />
                          </td>
                        )}
                        <td>
                          {entry.batchId !== null ? (
                            <Link to={`/audit?batchId=${entry.batchId}`} className="mono cell-muted">
                              {entry.batchId.slice(0, 8)}…
                            </Link>
                          ) : (
                            <span className="cell-muted">—</span>
                          )}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn btn--ghost"
                            data-row-link="true"
                            data-testid="audit-row-toggle"
                            aria-expanded={expanded}
                            onClick={(event) => toggleExpanded(entry.id, event.currentTarget)}
                          >
                            {expanded ? 'Hide' : 'Details'}
                          </button>
                        </td>
                      </tr>
                      {expanded && (
                        <tr data-testid="audit-row-detail">
                          <td colSpan={columnCount}>
                            <AuditDiff before={entry.before} after={entry.after} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })
              )}
            </tbody>
          </table>
        )}
      </div>

      {loadError === null && page !== null && page.items.length > 0 && (
        <div className="pagination">
          <span>
            Showing {rangeStart}–{rangeEnd} of {total}
          </span>
          <div className="pagination__controls">
            <button
              type="button"
              className="btn btn--secondary"
              disabled={loading || offset === 0}
              onClick={() => setOffset(Math.max(0, offset - LIMIT))}
            >
              Previous
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              disabled={loading || offset + LIMIT >= total}
              onClick={() => setOffset(offset + LIMIT)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
