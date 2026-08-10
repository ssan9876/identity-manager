import { useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link } from 'react-router-dom'
import { ApiError } from '../api/client'
import { ALL_CONNECTOR_TARGETS, CONNECTOR_TARGET_LABEL, type ConnectorTarget } from '../connectors/api'
import { formatDateTime } from '../format'
import { useGroups } from '../groups/GroupsContext'
import type { Page } from '../org-units/api'
import { fetchPeopleByIds, type Person } from '../people/api'
import { DEFAULT_MAX_ATTEMPTS, fetchDeadLetters, type DeadLetterEvent } from './outbox-api'
import './AuditPage.css'

const LIMIT = 25

function SkeletonRows({ columns }: { columns: number }) {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <tr key={i} aria-hidden="true">
          {Array.from({ length: columns }).map((__, c) => (
            <td key={c}>
              <span className="skeleton" style={{ width: c === 0 ? '8rem' : '10rem', height: '0.9rem' }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

function eventTypeLabel(eventType: string): string {
  const spaced = eventType.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * "Which aggregate" — task-5-brief.md's own phrase. Resolved from the
 * event's own PAYLOAD wherever possible (a `user`/`group` aggregate's
 * payload is always the full snapshot the write path recorded — see
 * UsersController.snapshotUser / GroupsController's snapshotGroup — so no
 * extra request is needed) or from the already-loaded `useGroups()` cache
 * for a `membership` event, whose `aggregateId` is always the group the
 * membership change belongs to (GroupsController's own outboxWriter.record
 * call sites: `aggregateId: id` is the group/parent group id in all four
 * membership routes).
 */
function AggregateCell({ event }: { event: DeadLetterEvent }) {
  const groups = useGroups()

  if (event.aggregateType === 'user') {
    const name = payloadString(event.payload, 'displayName') ?? payloadString(event.payload, 'username')
    return (
      <div>
        <div>Person</div>
        <Link to={`/people/${event.aggregateId}`} className="mono cell-muted audit-log__resource-id">
          {name ?? event.aggregateId}
        </Link>
      </div>
    )
  }

  const groupName =
    payloadString(event.payload, 'name') ??
    (groups.status === 'ready' ? groups.byId.get(event.aggregateId)?.name : undefined)

  return (
    <div>
      <div>{event.aggregateType === 'group' ? 'Group' : 'Group membership'}</div>
      <Link to={`/groups/${event.aggregateId}`} className="mono cell-muted audit-log__resource-id">
        {groupName ?? event.aggregateId}
      </Link>
    </div>
  )
}

/** "Which user" specifically — only ever meaningful for a `membership` event, whose payload carries `userId` (a direct member add/remove) or `childGroupId` (a nested-group add/remove, no single user). A `user`/`group` aggregate's own identity is already the Aggregate cell; this is deliberately blank there rather than repeating it. */
function AffectedCell({ event, people }: { event: DeadLetterEvent; people: Map<string, Person> }) {
  const groups = useGroups()

  if (event.aggregateType !== 'membership') {
    return <span className="cell-muted">—</span>
  }

  const userId = payloadString(event.payload, 'userId')
  if (userId !== undefined) {
    const person = people.get(userId)
    return (
      <Link to={`/people/${userId}`} className="row-link">
        {person?.displayName ?? userId}
      </Link>
    )
  }

  const childGroupId = payloadString(event.payload, 'childGroupId')
  if (childGroupId !== undefined) {
    const child = groups.status === 'ready' ? groups.byId.get(childGroupId) : undefined
    return (
      <Link to={`/groups/${childGroupId}`} className="row-link">
        {child?.name ?? childGroupId} <span className="cell-muted">(child group)</span>
      </Link>
    )
  }

  return <span className="cell-muted">—</span>
}

/**
 * The "Dead letters" tab of `/audit` — task-5-brief.md: "surface
 * dead-lettered outbox events... Give the dead-letter view enough detail to
 * act on: which aggregate, which user, the last error, how many attempts."
 * `GET /outbox/dead-letters` is read-only (see outbox-api.ts's own doc
 * comment) — this view never offers to retry or resolve one; that is the
 * out-of-band `pnpm reconcile` job's responsibility, named explicitly below
 * so an operator knows where to actually act, rather than looking for a
 * button that does not exist and should not.
 *
 * Milestone 14, Task 9 — "per-target dead letters, extending Milestone 8's
 * view": the SAME component now also carries a Target column and a target
 * filter, and doubles as the connector console's own per-target dead-letters
 * panel via `fixedTarget` — set from `/connectors/:target`'s own Dead
 * letters tab, where the target is already implied by the page and both the
 * filter control and the (otherwise entirely repetitive) Target column would
 * be pure noise. `/audit`'s own usage (`fixedTarget` omitted) is unchanged
 * in every other respect — same intro text, same pagination, same empty/
 * error states.
 */
export function DeadLettersTab({
  fixedTarget,
  organizationId,
}: { fixedTarget?: ConnectorTarget; organizationId?: string } = {}) {
  const auth = useAuth()
  const accessToken = auth.user?.access_token

  const [offset, setOffset] = useState(0)
  const [targetFilter, setTargetFilter] = useState<ConnectorTarget | ''>('')
  const [page, setPage] = useState<Page<DeadLetterEvent> | null>(null)
  const [people, setPeople] = useState<Map<string, Person>>(new Map())
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)

  const effectiveTarget = fixedTarget ?? (targetFilter === '' ? undefined : targetFilter)
  const showTargetColumn = fixedTarget === undefined
  const columnCount = showTargetColumn ? 6 : 5

  useEffect(() => {
    if (accessToken === undefined) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)

    fetchDeadLetters(accessToken, { limit: LIMIT, offset, target: effectiveTarget, organizationId })
      .then(async (res) => {
        if (cancelled) return
        setPage(res)

        const userIds = Array.from(
          new Set(
            res.items
              .filter((event) => event.aggregateType === 'membership')
              .map((event) => payloadString(event.payload, 'userId'))
              .filter((id): id is string => id !== undefined),
          ),
        )
        if (userIds.length > 0) {
          const peoplePage = await fetchPeopleByIds(accessToken, userIds)
          if (!cancelled) setPeople(new Map(peoplePage.items.map((p) => [p.id, p])))
        } else {
          setPeople(new Map())
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setLoadError(
          cause instanceof ApiError
            ? `Could not load dead letters: ${cause.message}`
            : 'Could not load dead letters. Check your connection and try again.',
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [accessToken, offset, retryToken, effectiveTarget, organizationId])

  const total = page?.total ?? 0
  const rangeStart = total === 0 ? 0 : offset + 1
  const rangeEnd = Math.min(offset + LIMIT, total)

  return (
    <div className="audit-log">
      <p className="audit-log__intro">
        Events that failed to sync{fixedTarget !== undefined ? ` to ${CONNECTOR_TARGET_LABEL[fixedTarget]}` : ''}{' '}
        after {DEFAULT_MAX_ATTEMPTS} attempts. These will <strong>not</strong> retry automatically — resolve the
        underlying issue, then run the reconciliation job (
        <span className="mono">{fixedTarget !== undefined ? 'pnpm target-reconcile' : 'pnpm reconcile'}</span>) to
        repair them.
      </p>

      {!showTargetColumn ? null : (
        <div className="field dead-letters__filter">
          <label className="field__label" htmlFor="dead-letters-target-filter">
            Target
          </label>
          <select
            id="dead-letters-target-filter"
            className="select"
            value={targetFilter}
            onChange={(e) => {
              setTargetFilter(e.target.value as ConnectorTarget | '')
              setOffset(0)
            }}
            data-testid="dead-letters-target-filter"
          >
            <option value="">All targets</option>
            {ALL_CONNECTOR_TARGETS.map((t) => (
              <option key={t} value={t}>
                {CONNECTOR_TARGET_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
      )}

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
            <h3>No dead letters</h3>
            <p>
              {effectiveTarget !== undefined
                ? `Every sync event to ${CONNECTOR_TARGET_LABEL[effectiveTarget]} has landed — nothing is stuck or permanently failed right now.`
                : 'Every sync event has landed — nothing is stuck or permanently failed right now.'}
            </p>
          </div>
        ) : (
          <table className="table" data-testid="dead-letters-table">
            <thead>
              <tr>
                <th scope="col">Aggregate</th>
                {showTargetColumn && <th scope="col">Target</th>}
                <th scope="col">Affected</th>
                <th scope="col">Last error</th>
                <th scope="col">Attempts</th>
                <th scope="col">First failed</th>
              </tr>
            </thead>
            <tbody>
              {loading || page === null ? (
                <SkeletonRows columns={columnCount} />
              ) : (
                page.items.map((event) => (
                  <tr key={event.id} data-testid="dead-letter-row">
                    <td>
                      <AggregateCell event={event} />
                    </td>
                    {showTargetColumn && (
                      <td data-testid="dead-letter-target">{CONNECTOR_TARGET_LABEL[event.target]}</td>
                    )}
                    <td>
                      <AffectedCell event={event} people={people} />
                    </td>
                    <td className="audit-log__error-cell" data-testid="dead-letter-error">
                      {event.lastError ?? '—'}
                      <div className="cell-muted audit-log__event-type">{eventTypeLabel(event.eventType)}</div>
                    </td>
                    <td data-testid="dead-letter-attempts">
                      {event.attempts} of {DEFAULT_MAX_ATTEMPTS}
                    </td>
                    <td className="cell-muted">{formatDateTime(event.createdAt)}</td>
                  </tr>
                ))
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
