import { useEffect, useState, type KeyboardEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useSearchParams } from 'react-router-dom'
import { ApiError } from '../api/client'
import { useOrgUnits } from '../org-units/OrgUnitsContext'
import { useSelfPermissions } from '../shell/permissions'
import { GroupScopeBadge } from './badges'
import { fetchGroupsPage, type Group } from './api'
import type { Page } from '../org-units/api'
import './GroupsListPage.css'

const LIMIT = 50
const ROW_LINK_SELECTOR = '[data-row-link="true"]'

/** Same ArrowUp/ArrowDown/Home/End row-to-row navigation as PeopleListPage's table (DESIGN.md: tables are "keyboard-navigable rows") — "same table... vocabulary as People" (task-4-brief.md), applied here too. */
function handleRowNavKeyDown(event: KeyboardEvent<HTMLTableSectionElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const container = event.currentTarget
  const links = Array.from(container.querySelectorAll<HTMLElement>(ROW_LINK_SELECTOR))
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

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <tr key={i} aria-hidden="true">
          <td>
            <span className="skeleton" style={{ width: '10rem', height: '0.9rem' }} />
          </td>
          <td>
            <span className="skeleton" style={{ width: '14rem', height: '0.9rem' }} />
          </td>
          <td>
            <span className="skeleton" style={{ width: '6rem', height: '1.2rem' }} />
          </td>
        </tr>
      ))}
    </>
  )
}

/**
 * `/groups` — Milestone 8, Task 4. `GET /groups`: paginated, "same table...
 * vocabulary as People" (task-4-brief.md) — sticky header, row hover,
 * keyboard-navigable rows, skeleton rows while loading, an empty state that
 * teaches. Deliberately NO search/status/org-unit filter row, unlike
 * People's: `GroupsController.list` (apps/api/src/groups/groups.controller.
 * ts) offers no such query params to filter by — adding a client-side-only
 * "search" over a single fetched page would silently stop working the
 * moment the directory outgrows one page, exactly the anti-pattern
 * UsersController's own `search` addition (Milestone 8, Task 2) was built
 * to avoid; better an honestly-absent filter than a fake one.
 */
export default function GroupsListPage() {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const orgUnits = useOrgUnits()
  const permissions = useSelfPermissions()
  const canCreate = permissions.status === 'ready' && permissions.actions.has('group:create')

  const [searchParams, setSearchParams] = useSearchParams()
  const offset = Math.max(0, Number.parseInt(searchParams.get('offset') ?? '0', 10) || 0)

  const [page, setPage] = useState<Page<Group> | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)

  useEffect(() => {
    if (accessToken === undefined) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)

    void fetchGroupsPage(accessToken, { limit: LIMIT, offset })
      .then((res) => {
        if (cancelled) return
        setPage(res)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setLoadError(
          cause instanceof ApiError
            ? `Could not load the groups list: ${cause.message}`
            : 'Could not load the groups list. Check your connection and try again.',
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [accessToken, offset, retryToken])

  function setOffset(next: number) {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      if (next === 0) params.delete('offset')
      else params.set('offset', String(next))
      return params
    })
  }

  const total = page?.total ?? 0
  const rangeStart = total === 0 ? 0 : offset + 1
  const rangeEnd = Math.min(offset + LIMIT, total)

  return (
    <div className="groups-list">
      <div className="groups-list__header">
        <h1 className="text-title">Groups</h1>
        {canCreate && (
          <Link to="/groups/new" className="btn btn--primary" data-testid="create-group-link">
            Create group
          </Link>
        )}
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
            <h3>No groups yet</h3>
            <p>
              Groups organise people for access and communication — nest them to build a hierarchy, and
              assign roles at group scope once membership is set.
              {canCreate ? ' Create the first one to get started.' : ' Ask an administrator to create one.'}
            </p>
            {canCreate && (
              <Link to="/groups/new" className="btn btn--primary">
                Create group
              </Link>
            )}
          </div>
        ) : (
          <table className="table" data-testid="groups-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Description</th>
                <th scope="col">Scope</th>
              </tr>
            </thead>
            <tbody onKeyDown={handleRowNavKeyDown}>
              {loading || page === null ? (
                <SkeletonRows />
              ) : (
                page.items.map((group) => {
                  const orgUnitPath =
                    group.orgUnitId !== null && orgUnits.status === 'ready'
                      ? (orgUnits.byId.get(group.orgUnitId)?.path ?? null)
                      : null
                  return (
                    <tr key={group.id} data-testid="groups-row">
                      <td>
                        <Link
                          to={`/groups/${group.id}`}
                          className="row-link"
                          data-row-link="true"
                          data-testid="groups-row-link"
                        >
                          {group.name}
                        </Link>
                      </td>
                      <td className="cell-muted">{group.description ?? '—'}</td>
                      <td>
                        <GroupScopeBadge group={group} orgUnitPath={orgUnitPath} />
                      </td>
                    </tr>
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
