import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link } from 'react-router-dom'
import { ApiError } from '../api/client'
import { useToast } from '../shell/ToastProvider'
import {
  createRoleConflict,
  fetchRoleConflicts,
  fetchStandingSodViolations,
  setRoleConflictEnabled,
  type BusinessRole,
  type RoleConflict,
  type SodRoleSide,
  type StandingSodReport,
} from './api'
import './ConflictsSection.css'

const HELD_VIA: Record<SodRoleSide['via'], string> = {
  formula: 'by formula',
  include_exception: 'by include-exception',
}

function ConflictStatusBadge({ enabled }: { enabled: boolean }) {
  // Same vocabulary rule as every badge here: word + optional shape, never
  // colour alone, and the norm (enforced) stays uncoloured. Retired takes
  // --warn, not --danger: nothing was revoked, a control merely stopped
  // being applied.
  return enabled ? (
    <span className="badge badge--neutral" data-conflict-enabled="true">
      Enforced
    </span>
  ) : (
    <span className="badge badge--warn" data-conflict-enabled="false">
      <span className="badge__dot" aria-hidden="true" />
      Retired
    </span>
  )
}

interface ConflictsSectionProps {
  /** The role catalogue the page already loaded — the vocabulary for the two selects. */
  roles: BusinessRole[]
  canManage: boolean
}

/**
 * Segregation of duties — the Conflicts section of `/business-roles`.
 *
 * It lives on the CATALOGUE page rather than on any one role's detail page
 * because a conflict is a fact about a PAIR: it belongs to neither role more
 * than the other, and hanging it off one of the two would make the policy
 * invisible from the side it constrains just as hard.
 *
 * Two lists, deliberately in this order: the standing VIOLATIONS first —
 * they are the findings someone must act on — then the conflict definitions
 * that produce them. The violations block states plainly that it is a
 * report: nothing here revokes anything, because which of a person's two
 * holdings is the wrong one is a decision this product refuses to automate.
 * The PREVENTIVE half of the same policy shows up elsewhere, in the
 * SimulatePanel and the publish gate's 409.
 */
export function ConflictsSection({ roles, canManage }: ConflictsSectionProps) {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const { showToast } = useToast()

  const [conflicts, setConflicts] = useState<RoleConflict[] | null>(null)
  const [violations, setViolations] = useState<StandingSodReport | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [creating, setCreating] = useState(false)
  const [roleAId, setRoleAId] = useState('')
  const [roleBId, setRoleBId] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [busyConflictId, setBusyConflictId] = useState<string | null>(null)

  const reload = useCallback(() => {
    if (accessToken === undefined) return
    setLoadError(null)
    void Promise.all([fetchRoleConflicts(accessToken), fetchStandingSodViolations(accessToken)])
      .then(([conflictList, report]) => {
        setConflicts(conflictList)
        setViolations(report)
      })
      .catch((cause: unknown) => {
        setLoadError(
          cause instanceof ApiError
            ? `Could not load conflicts: ${cause.message}`
            : 'Could not load conflicts. Check your connection and try again.',
        )
      })
  }, [accessToken])

  useEffect(() => {
    reload()
  }, [reload])

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    if (accessToken === undefined) return
    const trimmedReason = reason.trim()
    if (roleAId === '' || roleBId === '') {
      setCreateError('Pick both roles — a conflict is a statement about a pair.')
      return
    }
    if (roleAId === roleBId) {
      setCreateError('A role cannot conflict with itself — pick two different roles.')
      return
    }
    if (trimmedReason.length === 0) {
      setCreateError('Say why these two roles must not meet in one person. A later audit acts on this sentence.')
      return
    }

    setSubmitting(true)
    setCreateError(null)
    try {
      await createRoleConflict(accessToken, { roleAId, roleBId, reason: trimmedReason })
      showToast(
        'Conflict defined. Nobody’s access changed — publishes that would create the pairing are now refused, and anyone already holding both appears under standing violations.',
      )
      setCreating(false)
      setRoleAId('')
      setRoleBId('')
      setReason('')
      reload()
    } catch (cause) {
      setCreateError(
        cause instanceof ApiError ? cause.message : 'Could not define the conflict. Check your connection and try again.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  async function handleSetEnabled(conflict: RoleConflict, enabled: boolean) {
    if (accessToken === undefined) return
    setBusyConflictId(conflict.id)
    try {
      await setRoleConflictEnabled(accessToken, conflict.id, enabled)
      showToast(
        enabled
          ? `Restored — “${conflict.roleAName}” × “${conflict.roleBName}” is enforced again.`
          : `Retired — “${conflict.roleAName}” × “${conflict.roleBName}” is no longer enforced. It stays in this list; nothing here is deleted.`,
      )
      reload()
    } catch (cause) {
      showToast(cause instanceof ApiError ? cause.message : 'Could not update the conflict.', 'danger')
    } finally {
      setBusyConflictId(null)
    }
  }

  return (
    <section className="conflicts" aria-labelledby="conflicts-heading" data-testid="conflicts-section">
      <div className="conflicts__head">
        <div>
          <h2 id="conflicts-heading" className="conflicts__heading">
            Segregation of duties
          </h2>
          <p className="conflicts__hint">
            Pairs of roles no one person may hold both of. A conflict blocks any publish that would
            create the pairing; people who already hold both are <em>reported</em> below — never
            automatically revoked, because which of the two holdings is wrong is a human decision.
          </p>
        </div>
        {canManage && !creating && (
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => setCreating(true)}
            data-testid="new-conflict"
          >
            New conflict
          </button>
        )}
      </div>

      {loadError !== null && (
        <div className="banner banner--error" role="alert">
          {loadError}
        </div>
      )}

      {creating && canManage && (
        <form className="conflicts__create" onSubmit={(e) => void handleCreate(e)} data-testid="conflict-create-form">
          <div className="conflicts__create-fields">
            <div className="field">
              <label className="field__label" htmlFor="conflict-role-a">
                First role
              </label>
              <select
                id="conflict-role-a"
                className="select"
                value={roleAId}
                disabled={submitting}
                onChange={(e) => setRoleAId(e.target.value)}
              >
                <option value="">Choose a role…</option>
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="conflict-role-b">
                Must never be held with
              </label>
              <select
                id="conflict-role-b"
                className="select"
                value={roleBId}
                disabled={submitting}
                onChange={(e) => setRoleBId(e.target.value)}
              >
                <option value="">Choose a role…</option>
                {roles
                  .filter((role) => role.id !== roleAId)
                  .map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="field conflicts__create-reason">
              <label className="field__label" htmlFor="conflict-reason">
                Why
              </label>
              <input
                id="conflict-reason"
                className="input"
                value={reason}
                maxLength={2000}
                disabled={submitting}
                placeholder="e.g. Whoever approves payments must not also reconcile them"
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          </div>
          {createError !== null && (
            <p className="field__error" role="alert" data-testid="conflict-create-error">
              {createError}
            </p>
          )}
          <div className="conflicts__create-actions">
            <button
              type="button"
              className="btn btn--secondary"
              disabled={submitting}
              onClick={() => {
                setCreating(false)
                setCreateError(null)
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={submitting}
              data-loading={submitting ? 'true' : undefined}
              data-testid="conflict-create-submit"
            >
              <span className="btn__label">Define conflict</span>
              <span className="btn__spinner" aria-hidden="true" />
            </button>
          </div>
        </form>
      )}

      {violations !== null && violations.violationCount > 0 && (
        <div className="banner banner--error conflicts__violations" role="alert" data-testid="sod-violations">
          <p className="conflicts__violations-headline">
            {violations.violationCount} standing{' '}
            {violations.violationCount === 1 ? 'violation' : 'violations'} — people who hold both
            sides of an enforced conflict right now. Reported only; nothing has been revoked.
          </p>
          <ul className="conflicts__violations-list">
            {violations.violations.map((violation, index) => (
              <li key={`${violation.conflictId}-${violation.userId}-${index}`} data-testid="sod-violation-entry">
                <Link to={`/people/${violation.userId}`} className="row-link">
                  {violation.username}
                </Link>{' '}
                holds <strong>{violation.roleA.roleName}</strong> {HELD_VIA[violation.roleA.via]} and{' '}
                <strong>{violation.roleB.roleName}</strong> {HELD_VIA[violation.roleB.via]} —{' '}
                <span className="conflicts__violations-reason">{violation.conflictReason}</span>
              </li>
            ))}
          </ul>
          {violations.truncated && (
            <p className="conflicts__violations-more">
              Showing {violations.violations.length} of {violations.violationCount}.
            </p>
          )}
          <p className="conflicts__violations-remedy">
            Resolve one by excluding the person from one role (with a reason), changing a formula and
            republishing through the gate, or retiring the conflict.
          </p>
        </div>
      )}
      {violations !== null && violations.unevaluable.length > 0 && (
        <div className="banner banner--warn" role="status">
          {violations.unevaluable.length === 1
            ? `Role “${violations.unevaluable[0].roleName}” could not be evaluated (${violations.unevaluable[0].reason}), so this report is honest but partial.`
            : `${violations.unevaluable.length} conflict roles could not be evaluated, so this report is honest but partial.`}
        </div>
      )}
      {violations !== null && violations.conflictsChecked > 0 && violations.violationCount === 0 && (
        <p className="conflicts__clear" data-testid="sod-violations-none">
          No standing violations — nobody currently holds both sides of an enforced conflict.
        </p>
      )}

      {conflicts !== null && conflicts.length === 0 ? (
        <p className="cell-muted conflicts__empty" data-testid="conflicts-empty">
          No conflicts defined. Define one and any publish that would put a person in both roles is
          refused at the gate{canManage ? '' : ' — ask a super admin to define one'}.
        </p>
      ) : conflicts !== null ? (
        <div className="table-wrap">
          <table className="table" data-testid="conflicts-table">
            <thead>
              <tr>
                <th scope="col">Roles that must not meet</th>
                <th scope="col">Why</th>
                <th scope="col">Status</th>
                {canManage && (
                  <th scope="col" className="conflicts__actions-col">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {conflicts.map((conflict) => (
                <tr key={conflict.id} data-testid="conflicts-row">
                  <td>
                    <span className="conflicts__pair">
                      <Link to={`/business-roles/${conflict.roleAId}`} className="row-link">
                        {conflict.roleAName}
                      </Link>
                      <span className="conflicts__pair-x" aria-hidden="true">
                        ×
                      </span>
                      <Link to={`/business-roles/${conflict.roleBId}`} className="row-link">
                        {conflict.roleBName}
                      </Link>
                    </span>
                  </td>
                  <td className="cell-muted">{conflict.reason}</td>
                  <td>
                    <ConflictStatusBadge enabled={conflict.enabled} />
                  </td>
                  {canManage && (
                    <td className="conflicts__actions-col">
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        disabled={busyConflictId === conflict.id}
                        onClick={() => void handleSetEnabled(conflict, !conflict.enabled)}
                        data-testid={conflict.enabled ? 'retire-conflict' : 'restore-conflict'}
                      >
                        {conflict.enabled ? 'Retire' : 'Restore'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}
