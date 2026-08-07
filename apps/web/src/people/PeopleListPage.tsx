import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useSearchParams } from 'react-router-dom'
import { ApiError } from '../api/client'
import { useOrgUnits } from '../org-units/OrgUnitsContext'
import type { Page } from '../org-units/api'
import { useSelfPermissions } from '../shell/permissions'
import { fetchPeople, type Person, type UserStatus } from './api'
import { StatusBadge, SyncBadge } from './badges'
import './PeopleListPage.css'

const LIMIT = 50
const SEARCH_DEBOUNCE_MS = 300

const STATUS_OPTIONS: { value: UserStatus | ''; label: string }[] = [
  { value: '', label: 'All except deactivated' },
  { value: 'pending', label: 'Pending' },
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'deactivated', label: 'Deactivated' },
]

const ROW_LINK_SELECTOR = '[data-row-link="true"]'

/** Moves focus between row links with ArrowUp/ArrowDown/Home/End — DESIGN.md: tables are "keyboard-navigable rows", not just sequentially Tab-able. */
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
      {Array.from({ length: 8 }).map((_, i) => (
        <tr key={i} aria-hidden="true">
          <td>
            <span className="skeleton" style={{ width: '9rem', height: '0.9rem' }} />
          </td>
          <td>
            <span className="skeleton" style={{ width: '6rem', height: '0.9rem' }} />
          </td>
          <td>
            <span className="skeleton" style={{ width: '10rem', height: '0.9rem' }} />
          </td>
          <td>
            <span className="skeleton" style={{ width: '4.5rem', height: '1.2rem' }} />
          </td>
          <td>
            <span className="skeleton" style={{ width: '5rem', height: '1.2rem' }} />
          </td>
        </tr>
      ))}
    </>
  )
}

/**
 * `GET /users` — Milestone 8, Task 2. Paginated, searchable (server-side,
 * so search genuinely survives hundreds of rows — PRODUCT.md's #1
 * requirement), filterable by status and org unit. Skeleton rows while
 * loading; an empty state that teaches rather than saying "no data".
 */
export default function PeopleListPage() {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const orgUnits = useOrgUnits()
  const permissions = useSelfPermissions()
  // Hidden, not merely disabled, for a caller `GET /self/permissions`
  // doesn't grant `user:create` to — PRODUCT.md: "The UI hides what you
  // cannot do; it never decides it." `POST /users` still enforces this
  // itself regardless of what this button's visibility implies.
  const canCreate = permissions.status === 'ready' && permissions.actions.has('user:create')

  const [searchParams, setSearchParams] = useSearchParams()
  const search = searchParams.get('q') ?? ''
  const status = (searchParams.get('status') ?? '') as UserStatus | ''
  const orgUnitId = searchParams.get('orgUnit') ?? ''
  const offset = Math.max(0, Number.parseInt(searchParams.get('offset') ?? '0', 10) || 0)

  const [searchInput, setSearchInput] = useState(search)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [page, setPage] = useState<Page<Person> | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)

  // The URL is the single source of truth for filters (bookmarkable,
  // survives back/forward and a top-bar search jump) — keep the local text
  // box in sync when it changes from outside a keystroke (e.g. browser back,
  // or arriving here from the top bar's own search).
  useEffect(() => {
    setSearchInput(search)
  }, [search])

  const updateParams = useCallback(
    (patch: Record<string, string>, options: { resetOffset?: boolean } = {}) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        for (const [key, value] of Object.entries(patch)) {
          if (value === '') next.delete(key)
          else next.set(key, value)
        }
        if (options.resetOffset) next.delete('offset')
        return next
      })
    },
    [setSearchParams],
  )

  function onSearchInputChange(value: string) {
    setSearchInput(value)
    if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      updateParams({ q: value }, { resetOffset: true })
    }, SEARCH_DEBOUNCE_MS)
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    }
  }, [])

  useEffect(() => {
    if (accessToken === undefined) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)

    void fetchPeople(accessToken, {
      limit: LIMIT,
      offset,
      search: search || undefined,
      status: status || undefined,
      orgUnitId: orgUnitId || undefined,
    })
      .then((res) => {
        if (cancelled) return
        setPage(res)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setLoadError(
          cause instanceof ApiError
            ? `Could not load the people list: ${cause.message}`
            : 'Could not load the people list. Check your connection and try again.',
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, search, status, orgUnitId, offset, retryToken])

  const orgUnitOptions = useMemo(() => {
    if (orgUnits.status !== 'ready') return []
    return [...orgUnits.list].sort((a, b) => a.path.localeCompare(b.path))
  }, [orgUnits])

  const filtersActive = search !== '' || status !== '' || orgUnitId !== ''

  function clearFilters() {
    setSearchInput('')
    setSearchParams(new URLSearchParams())
  }

  const total = page?.total ?? 0
  const rangeStart = total === 0 ? 0 : offset + 1
  const rangeEnd = Math.min(offset + LIMIT, total)

  return (
    <div className="people-list">
      <div className="people-list__header">
        <h1 className="text-title">People</h1>
        {canCreate && (
          <Link to="/people/new" className="btn btn--primary" data-testid="create-user-link">
            Create user
          </Link>
        )}
      </div>

      <div className="people-list__filters">
        <div className="field people-list__search-field">
          <label className="field__label" htmlFor="people-search">
            Search
          </label>
          <input
            id="people-search"
            type="search"
            className="input"
            placeholder="Search by name, username, or email…"
            data-testid="people-search-input"
            value={searchInput}
            onChange={(e) => onSearchInputChange(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="people-status">
            Status
          </label>
          <select
            id="people-status"
            className="select"
            value={status}
            onChange={(e) => updateParams({ status: e.target.value }, { resetOffset: true })}
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="people-org-unit">
            Org unit
          </label>
          <select
            id="people-org-unit"
            className="select"
            value={orgUnitId}
            disabled={orgUnits.status === 'loading'}
            onChange={(e) => updateParams({ orgUnit: e.target.value }, { resetOffset: true })}
          >
            <option value="">
              {orgUnits.status === 'loading' ? 'Loading org units…' : 'All org units'}
            </option>
            {orgUnitOptions.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.name} ({unit.path})
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="table-wrap">
        {loadError !== null ? (
          <div className="error-panel" role="alert">
            <p className="error-panel__message">{loadError}</p>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => setRetryToken((t) => t + 1)}
            >
              Try again
            </button>
          </div>
        ) : !loading && page !== null && page.items.length === 0 ? (
          <div className="empty-state">
            {filtersActive ? (
              <>
                <h3>No one matches these filters</h3>
                <p>Try a different search term, or clear the filters to see the full directory.</p>
                <button type="button" className="btn btn--secondary" onClick={clearFilters}>
                  Clear filters
                </button>
              </>
            ) : (
              <>
                <h3>No one&rsquo;s in the directory yet</h3>
                <p>
                  This is where the people at your organisation show up once they&rsquo;re created or
                  imported. Bulk import arrives in a later task
                  {canCreate ? ' — for now, create the first person directly.' : '.'}
                </p>
                {canCreate && (
                  <Link to="/people/new" className="btn btn--primary">
                    Create user
                  </Link>
                )}
              </>
            )}
          </div>
        ) : (
          <table className="table" data-testid="people-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Username</th>
                <th scope="col">Org unit</th>
                <th scope="col">Status</th>
                <th scope="col">Sync</th>
              </tr>
            </thead>
            <tbody onKeyDown={handleRowNavKeyDown}>
              {loading || page === null ? (
                <SkeletonRows />
              ) : (
                page.items.map((person) => {
                  const unit = orgUnits.status === 'ready' ? orgUnits.byId.get(person.orgUnitId) : undefined
                  return (
                    <tr key={person.id} data-testid="people-row">
                      <td>
                        <Link
                          to={`/people/${person.id}`}
                          className="row-link"
                          data-row-link="true"
                          data-testid="people-row-link"
                        >
                          {person.displayName}
                        </Link>
                      </td>
                      <td className="cell-muted">{person.username}</td>
                      <td className="mono cell-muted">{unit?.path ?? person.orgUnitId}</td>
                      <td>
                        <StatusBadge status={person.status} />
                      </td>
                      <td>
                        <SyncBadge state={person.syncState} />
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
              onClick={() => updateParams({ offset: String(Math.max(0, offset - LIMIT)) })}
            >
              Previous
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              disabled={loading || offset + LIMIT >= total}
              onClick={() => updateParams({ offset: String(offset + LIMIT) })}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
