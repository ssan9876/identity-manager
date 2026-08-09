import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { ApiError } from '../api/client'
import { Field } from '../forms/Field'
import { useOrgUnits } from '../org-units/OrgUnitsContext'
import {
  ALL_ROLE_KEYS,
  ROLE_LABEL,
  explainRoleAssignError,
  fetchRolesForUser,
  fetchSelfRoles,
  grantRole,
  grantableScopeFor,
  pathWithin,
  revokeRole,
  type RoleAssignment,
  type RoleKey,
  type SelfRoleAssignment,
} from '../roles/api'
import { ConfirmDialog } from '../shell/ConfirmDialog'
import { useToast } from '../shell/ToastProvider'

const GLOBAL_SCOPE_VALUE = '__global__'

function ScopeLabel({ scopeOrgUnitId }: { scopeOrgUnitId: string | null }) {
  const orgUnits = useOrgUnits()
  if (scopeOrgUnitId === null) {
    return (
      <span className="badge badge--neutral" data-testid="role-scope-global">
        Global
      </span>
    )
  }
  const path = orgUnits.status === 'ready' ? (orgUnits.byId.get(scopeOrgUnitId)?.path ?? null) : null
  return (
    <span className="mono cell-muted" data-testid="role-scope-scoped">
      {path ?? scopeOrgUnitId}
    </span>
  )
}

/**
 * Progressive-disclosure grant form — never a modal (docs/design-system.md). The scope
 * `<select>` is rebuilt from `grantableScopeFor(myAssignments, roleKey)`
 * every time `roleKey` changes, so it only ever offers Global (when a
 * qualifying holding of the caller's own is itself global) and org units
 * within the caller's own held subtree(s) — task-4-brief.md's "constrained
 * to scopes the caller can actually grant at... do not offer options the
 * API will reject." Two distinct sentinel values thread through
 * `scopeValue`: `''` means "nothing chosen yet" (the Grant button stays
 * disabled), `GLOBAL_SCOPE_VALUE` means Global explicitly — needed because
 * `''` cannot ALSO mean Global here, unlike GroupForm's Scope field, since
 * this field additionally needs a real "nothing chosen" state to guard
 * against submitting whatever `<select>` happens to default to.
 */
function GrantRoleForm({
  userId,
  userName,
  myAssignments,
  onGranted,
  onCancel,
}: {
  userId: string
  userName: string
  myAssignments: SelfRoleAssignment[]
  onGranted: (assignment: RoleAssignment) => void
  onCancel: () => void
}) {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const orgUnits = useOrgUnits()

  const [roleKey, setRoleKey] = useState<RoleKey>('read_only')
  const [scopeValue, setScopeValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const grantable = grantableScopeFor(myAssignments, roleKey)
  // `grantable.global` means EVERY org unit is a valid scope option, not
  // just "Global" itself — see PrivilegeGuards.assertCanAssignRole's own
  // early `return` the moment any holding is global, before it ever checks
  // path containment (grantableScopeFor's own doc comment). Only when NOT
  // global does the picker narrow to `orgUnitPaths`.
  const scopeOptions =
    orgUnits.status === 'ready'
      ? orgUnits.list
          .filter((unit) => grantable.global || pathWithin(unit.path, grantable.orgUnitPaths))
          .sort((a, b) => a.path.localeCompare(b.path))
      : []
  const canGrantThisRole = grantable.global || scopeOptions.length > 0

  function onRoleChange(next: RoleKey) {
    setRoleKey(next)
    setScopeValue('') // force a fresh, explicit scope choice for the newly-selected role
    setError(null)
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (accessToken === undefined || scopeValue === '') return

    const scopeOrgUnitId = scopeValue === GLOBAL_SCOPE_VALUE ? null : scopeValue
    setSubmitting(true)
    setError(null)
    try {
      const assignment = await grantRole(accessToken, userId, { roleKey, scopeOrgUnitId })
      onGranted(assignment)
    } catch (cause) {
      setSubmitting(false)
      setError(
        cause instanceof ApiError
          ? explainRoleAssignError(cause, { targetName: userName, roleLabel: ROLE_LABEL[roleKey] })
          : 'Could not grant this role. Check your connection and try again.',
      )
    }
  }

  return (
    <form className="role-grant-form" onSubmit={(e) => void handleSubmit(e)}>
      <Field id="role-grant-role" label="Role">
        <select
          id="role-grant-role"
          className="select"
          value={roleKey}
          onChange={(e) => onRoleChange(e.target.value as RoleKey)}
          data-testid="role-grant-role"
        >
          {ALL_ROLE_KEYS.map((key) => (
            <option key={key} value={key}>
              {ROLE_LABEL[key]}
            </option>
          ))}
        </select>
      </Field>

      <Field
        id="role-grant-scope"
        label="Scope"
        hint={
          canGrantThisRole
            ? undefined
            : `You don't hold ${ROLE_LABEL[roleKey]} yourself, so you can't grant it.`
        }
      >
        <select
          id="role-grant-scope"
          className="select"
          value={scopeValue}
          disabled={!canGrantThisRole}
          onChange={(e) => setScopeValue(e.target.value)}
          data-testid="role-grant-scope"
        >
          <option value="" disabled>
            Select a scope…
          </option>
          {grantable.global && <option value={GLOBAL_SCOPE_VALUE}>Global — every org unit</option>}
          {scopeOptions.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.name} ({unit.path})
            </option>
          ))}
        </select>
      </Field>

      {error !== null && (
        <p className="error-panel__message" role="alert" data-testid="role-grant-error">
          {error}
        </p>
      )}

      <div className="role-grant-form__actions">
        <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn--primary"
          disabled={submitting || scopeValue === ''}
          data-loading={submitting ? 'true' : undefined}
          data-testid="role-grant-submit"
        >
          <span className="btn__label">Grant</span>
          <span className="btn__spinner" aria-hidden="true" />
        </button>
      </div>
    </form>
  )
}

type RolesTabState =
  | { status: 'loading' }
  | { status: 'error'; httpStatus?: number; message: string }
  | { status: 'ready'; assignments: RoleAssignment[]; myAssignments: SelfRoleAssignment[] }

/**
 * The Person detail page's Roles tab — Milestone 8, Task 4, replacing Task
 * 2's `NotYetBuilt` placeholder ("Viewing and granting role assignments
 * from here is coming in a later task"). Gated on the `role:assign`
 * permission BEFORE fetching anything: only `super_admin` holds it in
 * today's static catalog (see RoleAssignmentsController's own file header),
 * so most callers who can reach a person's PROFILE (via `user:read`) will
 * not hold this — an explanatory message beats an unnecessary round trip
 * that would only 403 anyway, same "explain rather than hit an unexplained
 * 403" spirit as OrgUnitsPage's own scope-legibility banner.
 */
export function PersonRolesTab({ userId, userName }: { userId: string; userName: string }) {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const { showToast } = useToast()

  const [state, setState] = useState<RolesTabState>({ status: 'loading' })
  const [showGrant, setShowGrant] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<RoleAssignment | null>(null)

  const load = useCallback(() => {
    if (accessToken === undefined) return
    setState({ status: 'loading' })
    Promise.all([fetchRolesForUser(accessToken, userId), fetchSelfRoles(accessToken)])
      .then(([assignments, self]) => {
        setState({ status: 'ready', assignments, myAssignments: self.assignments })
      })
      .catch((cause: unknown) => {
        setState({
          status: 'error',
          httpStatus: cause instanceof ApiError ? cause.status : undefined,
          message: cause instanceof ApiError ? cause.message : 'check your connection and try again',
        })
      })
  }, [accessToken, userId])

  useEffect(load, [load])

  async function handleConfirmRevoke() {
    if (accessToken === undefined || revokeTarget === null) return
    try {
      await revokeRole(accessToken, userId, revokeTarget.id)
    } catch (cause) {
      // Re-thrown as a plain Error carrying the FRIENDLY explanation —
      // ConfirmDialog surfaces any Error's own message verbatim (see its
      // own doc comment on why that widened from `instanceof ApiError`).
      throw new Error(
        cause instanceof ApiError
          ? explainRoleAssignError(cause, { targetName: userName, roleLabel: ROLE_LABEL[revokeTarget.roleKey] })
          : 'Could not revoke this role. Check your connection and try again.',
      )
    }
    showToast(`Revoked ${ROLE_LABEL[revokeTarget.roleKey]} from ${userName}.`)
    setRevokeTarget(null)
    load()
  }

  if (state.status === 'loading') {
    return (
      <div aria-hidden="true">
        <span className="skeleton" style={{ width: '10rem', height: '1rem', display: 'block' }} />
        <span className="skeleton" style={{ width: '100%', height: '4rem', display: 'block', marginTop: 'var(--space-3)' }} />
      </div>
    )
  }

  if (state.status === 'error') {
    // A caller who lacks role:assign ENTIRELY never fetches at all (see the
    // permission gate PersonDetailPage applies before rendering this
    // component) — a 403 reaching here specifically means a caller who
    // DOES hold role:assign somewhere cannot reach THIS target (finding
    // H-1's assertCanIn — see explainRoleAssignError's own doc comment).
    const message =
      state.httpStatus === 403
        ? `You don't have permission to manage ${userName}'s role assignments — they're outside what your role:assign grant covers.`
        : `Could not load role assignments: ${state.message}`
    return (
      <p role="alert" className="error-panel__message">
        {message}
      </p>
    )
  }

  const { assignments, myAssignments } = state

  return (
    <div className="person-roles">
      {assignments.length === 0 ? (
        <p className="cell-muted">{userName} holds no role assignments.</p>
      ) : (
        <ul className="group-member-list" data-testid="role-assignment-list">
          {assignments.map((assignment) => (
            <li key={assignment.id} className="group-member-list__row" data-testid="role-assignment-row">
              <span className="person-roles__role-name">{ROLE_LABEL[assignment.roleKey]}</span>
              <ScopeLabel scopeOrgUnitId={assignment.scopeOrgUnitId} />
              <button
                type="button"
                className="btn btn--ghost group-member-list__remove"
                onClick={() => setRevokeTarget(assignment)}
                data-testid="role-revoke-button"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      {showGrant ? (
        <GrantRoleForm
          userId={userId}
          userName={userName}
          myAssignments={myAssignments}
          onGranted={(assignment) => {
            showToast(`Granted ${ROLE_LABEL[assignment.roleKey]} to ${userName}.`)
            setShowGrant(false)
            load()
          }}
          onCancel={() => setShowGrant(false)}
        />
      ) : (
        <button
          type="button"
          className="btn btn--secondary role-grant-toggle"
          onClick={() => setShowGrant(true)}
          data-testid="role-show-grant"
        >
          Grant a role
        </button>
      )}

      <ConfirmDialog
        open={revokeTarget !== null}
        title={revokeTarget !== null ? `Revoke ${ROLE_LABEL[revokeTarget.roleKey]} from ${userName}?` : ''}
        confirmLabel="Revoke"
        tone="danger"
        onConfirm={handleConfirmRevoke}
        onDismiss={() => setRevokeTarget(null)}
        testId="revoke-role-dialog"
      >
        {revokeTarget !== null && (
          <p>
            This immediately removes <strong>{userName}</strong>&rsquo;s {ROLE_LABEL[revokeTarget.roleKey]} access
            {revokeTarget.scopeOrgUnitId === null ? ' organisation-wide' : ' at that scope'}. They can be granted it
            again later if needed.
          </p>
        )}
      </ConfirmDialog>
    </div>
  )
}
