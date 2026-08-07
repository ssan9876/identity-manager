import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link } from 'react-router-dom'
import { ApiError } from '../api/client'
import { Field } from '../forms/Field'
import { useToast } from '../shell/ToastProvider'
import { addChildGroup, explainGroupError, fetchGroupMembers, removeChildGroup } from './api'
import { useGroups } from './GroupsContext'
import { GroupScopeBadge } from './badges'
import { useOrgUnits } from '../org-units/OrgUnitsContext'

type NestedState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; childIds: string[] }

/**
 * The Nested groups tab — direct child groups only (`GET /:id/members`'s
 * `.groups`), the level `POST/DELETE /:id/child-groups` actually edits.
 * Resolves ids to full `Group` records from `GroupsContext`'s already-
 * fetched full cache, never a second network round trip: every role that
 * reaches this screen at all already holds `group:read` (this file's own
 * page requires it), and every role holding `group:read` sees every group
 * in today's static catalog (GroupsContext's own doc comment).
 *
 * A cycle attempt is routine, expected input the SERVER must decide — never
 * pre-empted client-side (task-4-brief.md: "do not attempt to pre-empt it
 * client-side and skip the call; let the server decide and explain the
 * answer" — the advisory-locked guard behind it was proven load-bearing:
 * "29 of 30 concurrent races formed a real cycle without it"). The add-
 * child picker below excludes only this group ITSELF and groups ALREADY a
 * direct child (a pure UX nicety — re-adding an existing edge is harmless,
 * `GroupsRepository.addChildGroup` no-ops it via `onConflictDoNothing`, but
 * offering it as an option teaches nothing) — it does NOT exclude any group
 * that would form a cycle; every nesting attempt, cycle-shaped or not, goes
 * to the real API and is explained via `explainGroupError` on the result.
 */
export function GroupNestedGroupsTab({
  groupId,
  groupName,
  canManageMembers,
}: {
  groupId: string
  groupName: string
  canManageMembers: boolean
}) {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const { showToast } = useToast()
  const groupsState = useGroups()
  const orgUnits = useOrgUnits()

  const [state, setState] = useState<NestedState>({ status: 'loading' })
  const [showAdd, setShowAdd] = useState(false)
  const [selection, setSelection] = useState('')
  const [addSubmitting, setAddSubmitting] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)

  const load = useCallback(() => {
    if (accessToken === undefined) return
    setState({ status: 'loading' })
    fetchGroupMembers(accessToken, groupId)
      .then((res) => setState({ status: 'ready', childIds: res.groups }))
      .catch((cause: unknown) => {
        setState({
          status: 'error',
          message: cause instanceof ApiError ? cause.message : 'check your connection and try again',
        })
      })
  }, [accessToken, groupId])

  useEffect(load, [load])

  async function handleAdd(event: FormEvent) {
    event.preventDefault()
    if (accessToken === undefined || selection === '') return
    const childName = groupsState.status === 'ready' ? (groupsState.byId.get(selection)?.name ?? 'This group') : 'This group'

    setAddSubmitting(true)
    setAddError(null)
    try {
      await addChildGroup(accessToken, groupId, selection)
      showToast(`Nested ${childName} under ${groupName}.`)
      setShowAdd(false)
      setSelection('')
      load()
    } catch (cause) {
      setAddSubmitting(false)
      if (cause instanceof ApiError) {
        setAddError(explainGroupError(cause, { childName, parentName: groupName }))
      } else {
        setAddError('Could not nest this group. Check your connection and try again.')
      }
    }
  }

  async function handleRemove(childId: string, childName: string) {
    if (accessToken === undefined) return
    setRemovingId(childId)
    try {
      await removeChildGroup(accessToken, groupId, childId)
      showToast(`Un-nested ${childName} from ${groupName}.`)
      load()
    } catch (cause) {
      showToast(
        cause instanceof ApiError ? cause.message : 'Could not un-nest this group — check your connection and try again.',
        'danger',
      )
    } finally {
      setRemovingId(null)
    }
  }

  if (state.status === 'error') {
    return (
      <div className="error-panel" role="alert">
        <p className="error-panel__message">Could not load nested groups: {state.message}</p>
      </div>
    )
  }

  if (state.status === 'loading' || groupsState.status === 'loading') {
    return (
      <div aria-hidden="true">
        <span className="skeleton" style={{ width: '100%', height: '4rem', display: 'block' }} />
      </div>
    )
  }

  const candidateGroups =
    groupsState.status === 'ready'
      ? groupsState.list
          .filter((g) => g.id !== groupId && !state.childIds.includes(g.id))
          .sort((a, b) => a.name.localeCompare(b.name))
      : []

  return (
    <div className="group-nested">
      {/* data-testid on this always-rendered section, not the conditional
          <ul> — same reasoning as GroupMembersTab's MemberList: a caller
          must be able to find (and assert empty on) "the child list"
          without the container vanishing when there is nothing nested. */}
      <section className="group-members__section" data-testid="group-child-list">
        <h3 className="text-title">Child groups ({state.childIds.length})</h3>
        {state.childIds.length === 0 ? (
          <p className="cell-muted">No groups are nested under {groupName} yet.</p>
        ) : (
          <ul className="group-member-list">
            {state.childIds.map((childId) => {
              const child = groupsState.status === 'ready' ? groupsState.byId.get(childId) : undefined
              const childOrgUnitPath =
                child?.orgUnitId !== null && child?.orgUnitId !== undefined && orgUnits.status === 'ready'
                  ? (orgUnits.byId.get(child.orgUnitId)?.path ?? null)
                  : null
              return (
                <li key={childId} className="group-member-list__row" data-testid="group-child-row">
                  {child !== undefined ? (
                    <>
                      <Link to={`/groups/${child.id}`} className="group-member-list__name">
                        {child.name}
                      </Link>
                      <GroupScopeBadge group={child} orgUnitPath={childOrgUnitPath} />
                    </>
                  ) : (
                    <span className="cell-muted">
                      Group outside what your role can see <span className="mono">({childId})</span>
                    </span>
                  )}
                  {canManageMembers && child !== undefined && (
                    <button
                      type="button"
                      className="btn btn--ghost group-member-list__remove"
                      onClick={() => handleRemove(childId, child.name)}
                      disabled={removingId === childId}
                      data-loading={removingId === childId ? 'true' : undefined}
                      data-testid="group-child-unnest"
                    >
                      <span className="btn__label">Un-nest</span>
                      <span className="btn__spinner" aria-hidden="true" />
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {canManageMembers &&
        (showAdd ? (
          <form className="group-nested__add" onSubmit={(e) => void handleAdd(e)}>
            <Field id="group-add-child-select" label="Nest a group under this one">
              <select
                id="group-add-child-select"
                className="select"
                value={selection}
                onChange={(e) => setSelection(e.target.value)}
                data-testid="group-add-child-select"
              >
                <option value="">Select a group…</option>
                {candidateGroups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                    {g.orgUnitId === null ? ' (Global)' : ''}
                  </option>
                ))}
              </select>
            </Field>

            {addError !== null && (
              <p className="error-panel__message" role="alert" data-testid="group-add-child-error">
                {addError}
              </p>
            )}

            <div className="group-nested__add-actions">
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => {
                  setShowAdd(false)
                  setAddError(null)
                  setSelection('')
                }}
                disabled={addSubmitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn--primary"
                disabled={addSubmitting || selection === ''}
                data-loading={addSubmitting ? 'true' : undefined}
                data-testid="group-add-child-submit"
              >
                <span className="btn__label">Nest</span>
                <span className="btn__spinner" aria-hidden="true" />
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => setShowAdd(true)}
            data-testid="group-show-add-child"
          >
            Nest a child group
          </button>
        ))}
    </div>
  )
}
