import { useEffect, useRef, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { useOrgUnits } from '../org-units/OrgUnitsContext'
import { Combobox } from '../forms/Combobox'
import { fetchPeople, fetchPeopleByIds, type Person } from './api'

const SEARCH_RESULT_LIMIT = 8

export interface PersonPickerProps {
  id: string
  /** A person id, or `''` for "none set" — same string-based convention `PersonCoreFormValues.managerId` already uses, so the surrounding form's state shape does not have to change. */
  value: string
  onChange: (personId: string) => void
  /** Excluded from search results — PersonForm passes the person being edited's own id, so nobody can pick themself as their own manager. A client-side UX nicety only, not a security boundary; nothing stops a determined caller from POSTing it directly. */
  excludeId?: string
  disabled?: boolean
  placeholder?: string
  clearLabel?: string
  'aria-invalid'?: boolean
  'aria-describedby'?: string
  onBlur?: () => void
}

/**
 * The person-specific instantiation of the generic `Combobox` — Milestone 9,
 * Task 3. Searches `GET /users?search=` (already scoped to the caller via
 * `PermissionEngine.scopePathsFor` inside `UsersController.list`, unconditionally,
 * whether or not `search` is present — see this task's own report for the
 * scope-safety confirmation) and displays each result the way a human
 * identifies a person — name first, username and org-unit path secondary —
 * never a bare id.
 *
 * On mount with a non-empty `value` (edit mode, an already-set manager),
 * resolves it to a real `Person` via `GET /users?ids=` (the same batched
 * id-resolution route GroupMembersTab already uses) SOLELY to render its
 * NAME — getting this wrong (rendering the raw id until/unless the admin
 * touches the field) is the most likely way to half-fix the defect this task
 * exists to close. `skipResolveRef` below is what stops that resolution from
 * re-firing the moment the admin picks someone new through the combobox
 * itself: a fresh selection already carries the full `Person`, so re-fetching
 * it a moment later would be both wasteful and race-prone.
 *
 * If resolution comes back with NO match, the manager is a real person this
 * actor's own scope does not reach — not a broken reference (users are never
 * deleted, only deactivated, and id-resolution does not exclude deactivated
 * rows). Rendered as a plain, honest fallback naming that boundary — the
 * exact wording and shape `GroupMembersTab`'s own "Member outside what your
 * role can see" row already established for the identical situation — with a
 * "Replace" action so the field never becomes permanently stuck: an admin who
 * cannot see who the current manager is can still deliberately choose someone
 * new, they just cannot silently or accidentally clear an invisible one (the
 * field is not editable until they explicitly ask to replace it).
 */
export function PersonPicker({
  id,
  value,
  onChange,
  excludeId,
  disabled,
  placeholder,
  clearLabel,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
  onBlur,
}: PersonPickerProps) {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const orgUnits = useOrgUnits()

  const [resolved, setResolved] = useState<Person | null>(null)
  const [resolveState, setResolveState] = useState<'idle' | 'loading' | 'unresolvable'>(
    value === '' ? 'idle' : 'loading',
  )
  const skipResolveRef = useRef(false)

  useEffect(() => {
    if (value === '') {
      setResolved(null)
      setResolveState('idle')
      return
    }
    if (skipResolveRef.current) {
      skipResolveRef.current = false
      return
    }
    if (accessToken === undefined) return

    let cancelled = false
    setResolveState('loading')

    fetchPeopleByIds(accessToken, [value])
      .then((page) => {
        if (cancelled) return
        const match = page.items.find((p) => p.id === value) ?? null
        setResolved(match)
        setResolveState(match === null ? 'unresolvable' : 'idle')
      })
      .catch(() => {
        if (cancelled) return
        setResolved(null)
        setResolveState('unresolvable')
      })

    return () => {
      cancelled = true
    }
  }, [accessToken, value])

  function handleComboboxChange(person: Person | null) {
    skipResolveRef.current = true
    setResolved(person)
    setResolveState('idle')
    onChange(person === null ? '' : person.id)
  }

  async function search(term: string, signal: AbortSignal): Promise<Person[]> {
    if (accessToken === undefined) return []
    const page = await fetchPeople(accessToken, { search: term, limit: SEARCH_RESULT_LIMIT, offset: 0 }, signal)
    return excludeId === undefined ? page.items : page.items.filter((p) => p.id !== excludeId)
  }

  function renderOption(person: Person) {
    const path = orgUnits.status === 'ready' ? orgUnits.byId.get(person.orgUnitId)?.path : undefined
    return (
      <div>
        <div className="combobox__option-name">{person.displayName}</div>
        <div className="combobox__option-meta">
          {person.username}
          {path !== undefined ? ` · ${path}` : ''}
        </div>
      </div>
    )
  }

  if (resolveState === 'loading') {
    return (
      <span
        className="skeleton"
        style={{ height: '2.25rem', display: 'block' }}
        aria-hidden="true"
        data-testid="person-picker-loading"
      />
    )
  }

  if (resolveState === 'unresolvable') {
    return (
      <div className="person-picker__unresolvable" data-testid="person-picker-unresolvable">
        <span className="cell-muted">
          Outside what your role can see <span className="mono">({value})</span>
        </span>
        <button type="button" className="btn btn--ghost" onClick={() => handleComboboxChange(null)}>
          Replace
        </button>
      </div>
    )
  }

  return (
    <Combobox<Person>
      id={id}
      value={resolved}
      onChange={handleComboboxChange}
      search={search}
      getOptionId={(p) => p.id}
      getOptionLabel={(p) => p.displayName}
      renderOption={renderOption}
      placeholder={placeholder ?? 'Search by name, username, or email…'}
      noResultsText="No matches."
      clearLabel={clearLabel ?? 'Clear manager'}
      disabled={disabled}
      aria-invalid={ariaInvalid}
      aria-describedby={ariaDescribedBy}
      onBlur={onBlur}
    />
  )
}
