import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ApiError } from '../api/client'
import { formatDateTime } from '../format'
import { Field } from '../forms/Field'
import { useSelfPermissions } from '../shell/permissions'
import { useToast } from '../shell/ToastProvider'
import { createOrgUnit, fetchOrgUnit, type OrgUnit } from './api'
import { useAddOrgUnit, useOrgUnits } from './OrgUnitsContext'
import './OrgUnitsPage.css'

const TREE_LINK_SELECTOR = '[data-tree-link="true"]'

/** Immediate parent up to the furthest visible ancestor — stops at a `parentId` this actor cannot see (not in `byId`) or `null` (a true root). Used to auto-expand the path down to whatever node the URL currently selects, so following a link (or a bookmark) never lands on a node hidden inside a collapsed branch. */
function ancestorIdsOf(id: string, byId: Map<string, OrgUnit>): string[] {
  const ancestors: string[] = []
  let current = byId.get(id)
  while (current?.parentId !== null && current?.parentId !== undefined) {
    const parent = byId.get(current.parentId)
    if (parent === undefined) break
    ancestors.push(parent.id)
    current = parent
  }
  return ancestors
}

/** Same ArrowUp/ArrowDown/Home/End row-to-row navigation as PeopleListPage's table (docs/design-system.md: keyboard-navigable, beyond plain Tab order) — applied to tree links instead of table rows. */
function handleTreeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const container = event.currentTarget
  const links = Array.from(container.querySelectorAll<HTMLElement>(TREE_LINK_SELECTOR))
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

/**
 * Name-only create form for a CHILD org unit.
 *
 * It used to serve a ROOT too, with `parentId` omitted. Since Task 7 of the
 * organizations milestone a root comes only from creating an ORGANIZATION,
 * which owns exactly one — the API has no route that makes one, so this
 * form no longer offers it and `parentId` is required. Progressive
 * disclosure, never a modal (docs/design-system.md bans "modal as first
 * thought" — a create form is exactly the kind of action that should stay
 * inline).
 */
function CreateOrgUnitForm({
  parentId,
  parentName,
  onCreated,
  onCancel,
}: {
  parentId: string
  parentName: string
  onCreated: (unit: OrgUnit) => void
  onCancel: () => void
}) {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (accessToken === undefined) return
    if (name.trim() === '') {
      setError('Name is required.')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const unit = await createOrgUnit(accessToken, { name: name.trim(), parentId })
      onCreated(unit)
    } catch (cause) {
      setSubmitting(false)
      if (cause instanceof ApiError && cause.status === 403) {
        // task-3-brief.md's scope-legibility requirement, applied to the
        // create action itself: name the boundary rather than a bare 403.
        // Only ONE 403 shape reaches here now that the root case is gone —
        // a scoped actor reaching outside their `org_unit:create` grant.
        setError(
          `You don't have permission to add units under ${parentName} — it's outside what your org_unit:create grant covers.`,
        )
      } else {
        setError(cause instanceof ApiError ? cause.message : 'Could not create this org unit.')
      }
    }
  }

  return (
    <form className="org-unit-create-form" onSubmit={(e) => void handleSubmit(e)}>
      <Field id="org-unit-create-name" label="Name" required error={error}>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus -- opened by a deliberate click on "Add root/child org unit"; the whole point of that click is to start typing a name immediately. */}
        <input
          id="org-unit-create-name"
          className="input"
          type="text"
          value={name}
          autoFocus
          data-testid="org-unit-create-name"
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
        />
      </Field>
      <div className="org-unit-create-form__actions">
        <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn--primary"
          disabled={submitting}
          data-loading={submitting ? 'true' : undefined}
          data-testid="org-unit-create-submit"
        >
          <span className="btn__label">Create</span>
          <span className="btn__spinner" aria-hidden="true" />
        </button>
      </div>
    </form>
  )
}

function OrgUnitTreeNode({
  unit,
  depth,
  childrenByParentId,
  expanded,
  onToggle,
  selectedId,
}: {
  unit: OrgUnit
  depth: number
  childrenByParentId: Map<string, OrgUnit[]>
  expanded: Set<string>
  onToggle: (id: string) => void
  selectedId: string | undefined
}) {
  const children = childrenByParentId.get(unit.id) ?? []
  const hasChildren = children.length > 0
  const isExpanded = expanded.has(unit.id)
  const isSelected = unit.id === selectedId

  return (
    <li>
      <div className="org-tree__row" style={{ paddingLeft: `${depth * 1.1}rem` }}>
        {hasChildren ? (
          <button
            type="button"
            className="org-tree__toggle"
            onClick={() => onToggle(unit.id)}
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${unit.name}`}
          >
            <span aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
          </button>
        ) : (
          <span className="org-tree__toggle org-tree__toggle--spacer" aria-hidden="true" />
        )}
        <Link
          to={`/org-units/${unit.id}`}
          className={`org-tree__link${isSelected ? ' org-tree__link--selected' : ''}`}
          aria-current={isSelected ? 'page' : undefined}
          data-tree-link="true"
          data-testid="org-tree-link"
        >
          {unit.name}
        </Link>
      </div>
      {hasChildren && isExpanded && (
        <ul className="org-tree__children">
          {children.map((child) => (
            <OrgUnitTreeNode
              key={child.id}
              unit={child}
              depth={depth + 1}
              childrenByParentId={childrenByParentId}
              expanded={expanded}
              onToggle={onToggle}
              selectedId={selectedId}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

function OrgUnitDetailPane({
  unit,
  parent,
  parentOutOfScope,
  children,
  canCreateChild,
  onOrgUnitCreated,
}: {
  unit: OrgUnit
  parent: OrgUnit | undefined
  parentOutOfScope: boolean
  children: OrgUnit[]
  canCreateChild: boolean
  onOrgUnitCreated: (unit: OrgUnit) => void
}) {
  const [showCreateChild, setShowCreateChild] = useState(false)

  return (
    <div className="org-unit-detail">
      <h2 className="text-subject" data-testid="org-unit-detail-name">
        {unit.name}
      </h2>
      <dl className="detail-grid">
        <div>
          <dt>Path</dt>
          <dd className="mono" data-testid="org-unit-detail-path">
            {unit.path}
          </dd>
        </div>
        <div>
          <dt>Parent</dt>
          <dd>
            {unit.parentId === null ? (
              <span className="cell-muted">— (root)</span>
            ) : parent !== undefined ? (
              <Link to={`/org-units/${parent.id}`}>{parent.name}</Link>
            ) : parentOutOfScope ? (
              <span className="cell-muted">Outside your assigned scope</span>
            ) : (
              <span className="cell-muted">—</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatDateTime(unit.createdAt)}</dd>
        </div>
      </dl>

      <Link to={`/people?orgUnit=${unit.id}`} className="btn btn--secondary org-unit-detail__people-link">
        View people in this org unit
      </Link>

      <section className="org-unit-detail__children">
        <h3 className="text-title">Child org units</h3>
        {children.length === 0 ? (
          <p className="cell-muted">No child org units yet.</p>
        ) : (
          <ul className="org-unit-detail__children-list" data-testid="org-unit-children-list">
            {children.map((child) => (
              <li key={child.id}>
                <Link to={`/org-units/${child.id}`}>{child.name}</Link>
                <span className="mono cell-muted">{child.path}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canCreateChild &&
        (showCreateChild ? (
          <CreateOrgUnitForm
            parentId={unit.id}
            parentName={unit.name}
            onCreated={(created) => {
              onOrgUnitCreated(created)
              setShowCreateChild(false)
            }}
            onCancel={() => setShowCreateChild(false)}
          />
        ) : (
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => setShowCreateChild(true)}
            data-testid="add-child-org-unit"
          >
            Add child org unit
          </button>
        ))}
    </div>
  )
}

/**
 * `/org-units` and `/org-units/:id` — Milestone 8, Task 3. Tree view, create
 * (root and child), and a detail pane, all in one screen: selection lives in
 * the URL (`:id`), so a bookmark or a shared link reopens the same node.
 *
 * `GET /org-units` already scopes its results to the caller (Milestone 3b) —
 * `OrgUnitsProvider` fetches that once per session (org-units/
 * OrgUnitsContext.tsx) — so "a scoped operator sees only their subtree"
 * (task-3-brief.md) is already true of the DATA this screen renders. What
 * this screen adds is making that boundary LEGIBLE rather than silently
 * smaller than expected (docs/product-brief.md: "without hitting an unexplained 403"):
 * `isScopeLimited` below detects when the visible forest's own roots are
 * not true roots (their real parent exists but is outside what this actor
 * can see) and says so, and a direct link to an out-of-scope id explains
 * the 403 rather than showing it bare.
 */
export default function OrgUnitsPage() {
  const { id: selectedId } = useParams<{ id: string }>()
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const navigate = useNavigate()
  const { showToast } = useToast()
  const orgUnits = useOrgUnits()
  const addOrgUnit = useAddOrgUnit()
  const permissions = useSelfPermissions()

  const canCreateOrgUnit = permissions.status === 'ready' && permissions.actions.has('org_unit:create')

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [directFetch, setDirectFetch] = useState<
    { id: string; status: 'loading' } | { id: string; status: 'error'; httpStatus?: number; message: string } | null
  >(null)

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const { childrenByParentId, visibleRoots } = useMemo(() => {
    const byParent = new Map<string, OrgUnit[]>()
    const roots: OrgUnit[] = []
    if (orgUnits.status === 'ready') {
      for (const unit of orgUnits.list) {
        const parentVisible = unit.parentId !== null && orgUnits.byId.has(unit.parentId)
        if (parentVisible) {
          const list = byParent.get(unit.parentId as string) ?? []
          list.push(unit)
          byParent.set(unit.parentId as string, list)
        } else {
          roots.push(unit)
        }
      }
      const byName = (a: OrgUnit, b: OrgUnit) => a.name.localeCompare(b.name)
      roots.sort(byName)
      for (const list of byParent.values()) list.sort(byName)
    }
    return { childrenByParentId: byParent, visibleRoots: roots }
  }, [orgUnits])

  // A visible root that still HAS a parentId means that parent exists but is
  // outside this actor's scope — the tree looks smaller than the real
  // organisation, on purpose, and this is what makes that fact legible
  // rather than silently mysterious (task-3-brief.md).
  const isScopeLimited = visibleRoots.some((unit) => unit.parentId !== null)

  // Auto-expand the ancestors of whatever node the URL selects, so following
  // a link (or reopening a bookmark) into a deep branch never lands on a
  // node hidden inside a collapsed one.
  useEffect(() => {
    if (orgUnits.status !== 'ready' || selectedId === undefined) return
    const ancestors = ancestorIdsOf(selectedId, orgUnits.byId)
    if (ancestors.length === 0) return
    setExpanded((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const ancestorId of ancestors) {
        if (!next.has(ancestorId)) {
          next.add(ancestorId)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [selectedId, orgUnits])

  // The URL names a unit this session's cached (already-scoped) list does
  // NOT contain — either it is genuinely out of scope (403) or it does not
  // exist (404). Ask the API directly rather than guessing from absence
  // alone, so the boundary this actor hits is explained accurately instead
  // of both cases looking like an identical, silent nothing.
  useEffect(() => {
    if (selectedId === undefined || orgUnits.status !== 'ready' || orgUnits.byId.has(selectedId)) {
      setDirectFetch(null)
      return
    }
    if (accessToken === undefined) return

    let cancelled = false
    setDirectFetch({ id: selectedId, status: 'loading' })

    fetchOrgUnit(accessToken, selectedId)
      .then((unit) => {
        if (cancelled) return
        addOrgUnit(unit)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setDirectFetch({
          id: selectedId,
          status: 'error',
          httpStatus: cause instanceof ApiError ? cause.status : undefined,
          message: cause instanceof ApiError ? cause.message : 'check your connection and try again',
        })
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, orgUnits.status, accessToken])

  function handleOrgUnitCreated(unit: OrgUnit) {
    addOrgUnit(unit)
    if (unit.parentId !== null) setExpanded((prev) => new Set(prev).add(unit.parentId as string))
    showToast(`Created ${unit.name}.`)
    navigate(`/org-units/${unit.id}`)
  }

  const selectedUnit = selectedId !== undefined && orgUnits.status === 'ready' ? orgUnits.byId.get(selectedId) : undefined
  const selectedParent =
    selectedUnit?.parentId !== null && selectedUnit?.parentId !== undefined && orgUnits.status === 'ready'
      ? orgUnits.byId.get(selectedUnit.parentId)
      : undefined
  const selectedParentOutOfScope =
    selectedUnit !== undefined && selectedUnit.parentId !== null && selectedParent === undefined
  const selectedChildren = selectedId !== undefined ? (childrenByParentId.get(selectedId) ?? []) : []

  return (
    <div className="org-units-page">
      <div className="page-header org-units-page__header">
        <div className="page-header__text">
          <h1 className="text-title">Org units</h1>
          <p className="page-header__subtitle">
            The shape of the organisation. Every person sits in exactly one unit, and a
            unit&rsquo;s path is what scopes who an administrator can see.
          </p>
        </div>
      </div>

      {isScopeLimited && (
        <p className="org-units-page__scope-note" role="note" data-testid="org-units-scope-note">
          This view is scoped to your assigned org unit{visibleRoots.length > 1 ? 's' : ''} and everything
          beneath {visibleRoots.length > 1 ? 'them' : 'it'} — an ancestor exists above{' '}
          {visibleRoots.length > 1 ? 'them' : 'it'} but is outside what your role can see. Ask an
          administrator if you need broader access.
        </p>
      )}

      <div className="org-units-page__layout">
        <div className="org-units-page__tree-panel">
          <div className="org-units-page__tree-header">
            {/*
              "Add root org unit" used to live here. Removed with Task 7 of
              the organizations milestone: a root belongs to an
              organization, which owns exactly one and creates it as part of
              creating the organization, so this button could only ever
              produce a 400. A child is still added from the unit's own
              detail panel, where there is a parent to add it under.
            */}
            <h2 className="text-title">Tree</h2>
          </div>

          {orgUnits.status === 'loading' ? (
            <ul className="org-tree" aria-hidden="true">
              {Array.from({ length: 5 }).map((_, i) => (
                <li key={i} className="org-tree__row">
                  <span className="skeleton" style={{ width: `${9 - i}rem`, height: '1rem' }} />
                </li>
              ))}
            </ul>
          ) : orgUnits.status === 'error' ? (
            <div className="error-panel" role="alert">
              <p className="error-panel__message">Could not load org units: {orgUnits.message}</p>
              <p>Reload the page to try again.</p>
            </div>
          ) : visibleRoots.length === 0 ? (
            <div className="empty-state">
              <h3>No org units yet</h3>
              <p>
                Org units form the tree people and groups are placed in. The top of that tree
                belongs to an organization and is created with it; everything below is added
                from its parent.{' '}
                {canCreateOrgUnit ? '' : 'Ask an administrator if you need access to one.'}
              </p>
            </div>
          ) : (
            <div className="org-tree-scroll" onKeyDown={handleTreeKeyDown}>
              <ul className="org-tree" data-testid="org-tree">
                {visibleRoots.map((unit) => (
                  <OrgUnitTreeNode
                    key={unit.id}
                    unit={unit}
                    depth={0}
                    childrenByParentId={childrenByParentId}
                    expanded={expanded}
                    onToggle={toggleExpanded}
                    selectedId={selectedId}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="org-units-page__detail-panel">
          {selectedId === undefined ? (
            <p className="cell-muted" data-testid="org-unit-detail-empty">
              Select an org unit from the tree to see its details.
            </p>
          ) : selectedUnit !== undefined ? (
            <OrgUnitDetailPane
              key={selectedUnit.id}
              unit={selectedUnit}
              parent={selectedParent}
              parentOutOfScope={selectedParentOutOfScope}
              children={selectedChildren}
              canCreateChild={canCreateOrgUnit}
              onOrgUnitCreated={handleOrgUnitCreated}
            />
          ) : directFetch?.status === 'loading' ? (
            <div className="skeleton" style={{ width: '100%', height: '10rem' }} />
          ) : directFetch?.status === 'error' ? (
            <div className="error-panel" role="alert">
              <p className="error-panel__message">
                {directFetch.httpStatus === 403
                  ? "You don't have access to this org unit — it's outside what your role can see."
                  : directFetch.httpStatus === 404
                    ? 'This org unit could not be found. It may have been removed or the link is wrong.'
                    : `Could not load this org unit: ${directFetch.message}`}
              </p>
            </div>
          ) : (
            <div className="skeleton" style={{ width: '100%', height: '10rem' }} />
          )}
        </div>
      </div>
    </div>
  )
}
