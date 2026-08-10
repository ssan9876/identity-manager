import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError } from '../api/client'
import { formatDateTime } from '../format'
import { useSelfPermissions } from '../shell/permissions'
import { useToast } from '../shell/ToastProvider'
import { BusinessRoleStatusBadge, DraftStateBadge } from './badges'
import { createBusinessRole, fetchBusinessRoles, type BusinessRole } from './api'
import './BusinessRolesPage.css'

const ROW_LINK_SELECTOR = '[data-row-link="true"]'

/** The same ArrowUp/ArrowDown/Home/End row navigation People and Groups already ship — docs/design-system.md: tables are "keyboard-navigable rows". */
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

function BusinessRolesIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 5.5h5.5l1.5 2H17" />
      <rect x="3" y="5.5" width="14" height="10" rx="1.5" />
      <path d="M7 11h6M7 13.5h3.5" />
    </svg>
  )
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <tr key={i} aria-hidden="true">
          <td>
            <span className="skeleton" style={{ width: '11rem', height: '0.9rem' }} />
          </td>
          <td>
            <span className="skeleton" style={{ width: '16rem', height: '0.9rem' }} />
          </td>
          <td>
            <span className="skeleton" style={{ width: '5.5rem', height: '1.3rem' }} />
          </td>
          <td>
            <span className="skeleton" style={{ width: '10rem', height: '1.3rem' }} />
          </td>
          <td>
            <span className="skeleton" style={{ width: '8rem', height: '0.9rem' }} />
          </td>
        </tr>
      ))}
    </>
  )
}

/**
 * `/business-roles` — Milestone 17, Task 17. A TABLE, not a card grid
 * (docs/design-system.md: "Lists are tables, not card grids").
 *
 * WHAT THE COLUMNS ARE, AND WHY THEY ARE NOT THE PLAN'S ORIGINAL FIVE.
 * The plan sketched "conditions summary / grants summary" columns. `GET
 * /business-roles` is `db.select().from(businessRoles)` — the bare row. The
 * published conditions and grants live in child tables and are loaded ONLY
 * by `findById`, so those two columns could only be filled by an N+1 fetch
 * per row. That is the same trap `GroupsListPage` documents for its absent
 * search box: better an honestly-absent column than a fake or an expensive
 * one. What the row DOES carry is the thing this screen exists to make
 * scannable anyway — whether each role is granting, and whether there are
 * unpublished changes waiting on the gate.
 *
 * Creation is an INLINE disclosure above the table, not a modal and not a
 * separate route: docs/design-system.md bans "modal as first thought", and a name plus
 * an optional description is far too small to earn a page of its own. A new
 * role is disabled and undrafted by construction (`createBodySchema` exposes
 * nothing else), so this form cannot change anyone's access — it lands you
 * on the detail page, where the actual work starts.
 */
export default function BusinessRolesPage() {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const permissions = useSelfPermissions()
  const navigate = useNavigate()
  const { showToast } = useToast()

  const canRead = permissions.status === 'ready' && permissions.actions.has('business_role:read')
  const canManage = permissions.status === 'ready' && permissions.actions.has('business_role:manage')

  const [roles, setRoles] = useState<BusinessRole[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)

  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (accessToken === undefined) return
    if (permissions.status !== 'ready') return
    if (!canRead) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setLoadError(null)

    void fetchBusinessRoles(accessToken)
      .then((list) => {
        if (cancelled) return
        setRoles(list)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setLoadError(
          cause instanceof ApiError
            ? `Could not load business roles: ${cause.message}`
            : 'Could not load business roles. Check your connection and try again.',
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [accessToken, canRead, permissions.status, retryToken])

  useEffect(() => {
    if (creating) nameRef.current?.focus()
  }, [creating])

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    if (accessToken === undefined) return
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      setCreateError('Give the role a name — this is what admins will look for in this list.')
      nameRef.current?.focus()
      return
    }

    setSubmitting(true)
    setCreateError(null)
    try {
      const created = await createBusinessRole(accessToken, {
        name: trimmed,
        description: description.trim().length > 0 ? description.trim() : null,
      })
      showToast(`Created "${created.name}" — disabled, with no formula yet. Nobody's access has changed.`)
      navigate(`/business-roles/${created.id}`)
    } catch (cause) {
      setCreateError(
        cause instanceof ApiError
          ? cause.message
          : 'Could not create the role. Check your connection and try again.',
      )
      setSubmitting(false)
    }
  }

  if (permissions.status === 'ready' && !canRead) {
    return (
      <div className="business-roles">
        <div className="page-header">
          <div className="page-header__text">
            <h1 className="text-title">Business roles</h1>
          </div>
        </div>
        <p className="cell-muted" data-testid="business-roles-permission-note">
          You don&rsquo;t hold the business_role:read permission, so you can&rsquo;t see the role
          catalogue. Ask a super admin if you need this.
        </p>
      </div>
    )
  }

  const isEmpty = !loading && roles !== null && roles.length === 0

  return (
    <div className="business-roles">
      <div className="page-header">
        <div className="page-header__text">
          <h1 className="text-title">Business roles</h1>
          <p className="page-header__subtitle">
            Access that follows who someone is, rather than a ticket. A role says which people it
            describes and what they get — and every change to that formula is simulated across the
            directory before it can be published.
          </p>
        </div>
        <div className="business-roles__header-actions">
          {/* Mining requires the same global business_role:manage grant as
              adopting its output, so the entry point follows canManage. */}
          {canManage && (
            <Link to="/business-roles/mining" className="btn btn--secondary" data-testid="open-mining">
              Mining
            </Link>
          )}
          {canManage && !creating && (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setCreating(true)}
              data-testid="new-business-role"
            >
              New business role
            </button>
          )}
        </div>
      </div>

      {creating && canManage && (
        <form className="business-roles__create" onSubmit={(e) => void handleCreate(e)} data-testid="business-role-create-form">
          <h2 className="business-roles__create-heading">New business role</h2>
          <p className="business-roles__create-hint">
            It starts disabled with no formula, so creating it changes nobody&rsquo;s access. You
            draft the conditions and grants next.
          </p>
          <div className="business-roles__create-fields">
            <div className="field business-roles__create-name">
              <label className="field__label" htmlFor="business-role-name">
                Name
              </label>
              <input
                ref={nameRef}
                id="business-role-name"
                className="input"
                value={name}
                maxLength={255}
                disabled={submitting}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="field business-roles__create-description">
              <label className="field__label" htmlFor="business-role-description">
                Description <span className="business-roles__optional">optional</span>
              </label>
              <input
                id="business-role-description"
                className="input"
                value={description}
                maxLength={2000}
                disabled={submitting}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>
          {createError !== null && (
            <p className="field__error" role="alert" data-testid="business-role-create-error">
              {createError}
            </p>
          )}
          <div className="business-roles__create-actions">
            <button
              type="button"
              className="btn btn--secondary"
              disabled={submitting}
              onClick={() => {
                setCreating(false)
                setCreateError(null)
                setName('')
                setDescription('')
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={submitting}
              data-loading={submitting ? 'true' : undefined}
              data-testid="business-role-create-submit"
            >
              <span className="btn__label">Create</span>
              <span className="btn__spinner" aria-hidden="true" />
            </button>
          </div>
        </form>
      )}

      <div className="table-wrap">
        {loadError !== null ? (
          <div className="error-panel" role="alert">
            <p className="error-panel__message">{loadError}</p>
            <button type="button" className="btn btn--secondary" onClick={() => setRetryToken((t) => t + 1)}>
              Try again
            </button>
          </div>
        ) : isEmpty ? (
          <div className="empty-state">
            <span className="empty-state__mark" aria-hidden="true">
              <BusinessRolesIcon />
            </span>
            <h3>Nothing grants access by rule yet</h3>
            <p>
              A business role is a formula — &ldquo;everyone whose job title is Account Executive&rdquo; —
              paired with what those people get. Publish one and joiners pick it up on their first
              day; movers lose it the moment the formula stops describing them.
              {canManage
                ? ' Start with one narrow role you can simulate safely.'
                : ' Ask a super admin to create one.'}
            </p>
            {canManage && !creating && (
              <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
                New business role
              </button>
            )}
          </div>
        ) : (
          <table className="table" data-testid="business-roles-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Description</th>
                <th scope="col">Status</th>
                <th scope="col">Pending changes</th>
                <th scope="col">Last simulated</th>
              </tr>
            </thead>
            <tbody onKeyDown={handleRowNavKeyDown}>
              {loading || roles === null ? (
                <SkeletonRows />
              ) : (
                roles.map((role) => (
                  <tr key={role.id} data-testid="business-roles-row">
                    <td>
                      <Link
                        to={`/business-roles/${role.id}`}
                        className="row-link"
                        data-row-link="true"
                        data-testid="business-roles-row-link"
                      >
                        {role.name}
                      </Link>
                    </td>
                    <td className="cell-muted">{role.description ?? '—'}</td>
                    <td>
                      <BusinessRoleStatusBadge enabled={role.enabled} />
                    </td>
                    <td>
                      <DraftStateBadge role={role} />
                    </td>
                    <td className="cell-muted">
                      {role.simulatedAt === null ? 'Never' : formatDateTime(role.simulatedAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
