import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link } from 'react-router-dom'
import { ApiError } from '../api/client'
import { formatDateTime } from '../format'
import { PersonPicker } from '../people/PersonPicker'
import { fetchPeopleByIds, type Person } from '../people/api'
import { useToast } from '../shell/ToastProvider'
import { addBusinessRoleException, removeBusinessRoleException, type RoleException } from './api'

export interface BusinessRoleExceptionsTabProps {
  roleId: string
  roleName: string
  exceptions: RoleException[]
  canManage: boolean
  /** Re-reads the role so the list reflects the write that just happened. */
  onChanged: () => void
}

/**
 * Per-person exceptions — the live adjustment made to a RUNNING role without
 * touching the formula that governs everyone else. Deliberately outside the
 * draft/simulate/publish gate, because that is the entire point of the
 * feature: `POST /:id/exceptions` re-evaluates exactly one person, inside its
 * own transaction, and has taken effect by the time it responds.
 *
 * THE REASON IS A COLUMN, not a footnote. `reason` is NOT NULL and required
 * on every write, so the only thing that made it unshowable was the read
 * shape narrowing it away — fixed in `BusinessRolesRepository.loadDefinition`
 * rather than apologised for here. A justification the system insists on
 * collecting and then cannot show is a field being collected for nobody, and
 * this table IS the recertification queue that reads it.
 */
export function BusinessRoleExceptionsTab({
  roleId,
  roleName,
  exceptions,
  canManage,
  onChanged,
}: BusinessRoleExceptionsTabProps) {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const { showToast } = useToast()

  const [people, setPeople] = useState<Map<string, Person>>(new Map())
  const [adding, setAdding] = useState(false)
  const [userId, setUserId] = useState('')
  const [mode, setMode] = useState<'include' | 'exclude'>('include')
  const [reason, setReason] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)

  // Both the subject and the person who wrote the exception, resolved in one
  // batch — "granted by 3f2a…" is not a fact anyone reviewing this can act on.
  const ids = Array.from(
    new Set([
      ...exceptions.map((e) => e.userId),
      ...exceptions.map((e) => e.grantedBy).filter((v): v is string => v !== null),
    ]),
  ).join(',')

  useEffect(() => {
    if (accessToken === undefined || ids.length === 0) return
    let cancelled = false
    void fetchPeopleByIds(accessToken, ids.split(','))
      .then((page) => {
        if (cancelled) return
        setPeople(new Map(page.items.map((person) => [person.id, person])))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [accessToken, ids])

  async function handleAdd(event: FormEvent) {
    event.preventDefault()
    if (accessToken === undefined) return
    if (userId === '') {
      setFormError('Choose the person this exception applies to.')
      return
    }
    if (reason.trim().length === 0) {
      setFormError(
        'Say why. An exception with no reason is exactly what a later recertification cannot act on — the API requires it.',
      )
      return
    }

    setSubmitting(true)
    setFormError(null)
    try {
      await addBusinessRoleException(accessToken, roleId, {
        userId,
        mode,
        reason: reason.trim(),
        // datetime-local has no timezone of its own; `toISOString` anchors it
        // to the viewer's own zone, which is what they meant by "until 5pm".
        expiresAt: expiresAt === '' ? null : new Date(expiresAt).toISOString(),
      })
      showToast(
        mode === 'include'
          ? `Included in ${roleName} — their entitlements were re-evaluated immediately.`
          : `Excluded from ${roleName} — anything this role was granting them has been revoked.`,
        mode === 'include' ? 'neutral' : 'warn',
      )
      setAdding(false)
      setUserId('')
      setReason('')
      setExpiresAt('')
      setMode('include')
      onChanged()
    } catch (cause) {
      setFormError(
        cause instanceof ApiError
          ? cause.message
          : 'Could not write the exception. Check your connection and try again.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRemove(exceptionUserId: string) {
    if (accessToken === undefined) return
    setRemovingId(exceptionUserId)
    try {
      await removeBusinessRoleException(accessToken, roleId, exceptionUserId)
      showToast(`Exception cleared — this person now follows ${roleName}'s formula again.`)
      onChanged()
    } catch (cause) {
      showToast(
        cause instanceof ApiError ? cause.message : 'Could not clear the exception.',
        'danger',
      )
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <div className="br-exceptions">
      <div className="br-exceptions__head">
        <div>
          <h3 className="br-detail__section-heading">Exceptions</h3>
          <p className="br-detail__section-hint">
            One person held in, or kept out, without changing the formula everyone else follows.
            These take effect immediately — they go through no draft, and the person is re-evaluated
            before the request returns. The reason is required, and it is shown here — this table is
            what a recertification campaign reads.
          </p>
        </div>
        {canManage && !adding && (
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => setAdding(true)}
            data-testid="add-exception"
          >
            Add exception
          </button>
        )}
      </div>

      {adding && canManage && (
        <form className="br-exceptions__form" onSubmit={(e) => void handleAdd(e)} data-testid="exception-form">
          <div className="br-exceptions__form-fields">
            <div className="field br-exceptions__person">
              <label className="field__label" htmlFor="exception-person">
                Person
              </label>
              <PersonPicker
                id="exception-person"
                value={userId}
                onChange={setUserId}
                disabled={submitting}
                placeholder="Search by name or username"
              />
            </div>
            <div className="field br-exceptions__mode">
              <label className="field__label" htmlFor="exception-mode">
                Mode
              </label>
              <select
                id="exception-mode"
                className="select"
                value={mode}
                disabled={submitting}
                onChange={(e) => setMode(e.target.value as 'include' | 'exclude')}
              >
                <option value="include">Include — grant even if the formula says no</option>
                <option value="exclude">Exclude — withhold even if the formula says yes</option>
              </select>
            </div>
            <div className="field br-exceptions__expiry">
              <label className="field__label" htmlFor="exception-expires">
                Expires <span className="br-detail__optional">optional</span>
              </label>
              <input
                id="exception-expires"
                type="datetime-local"
                className="input"
                value={expiresAt}
                disabled={submitting}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="exception-reason">
              Reason
            </label>
            <textarea
              id="exception-reason"
              className="input br-exceptions__reason"
              rows={2}
              maxLength={2000}
              value={reason}
              disabled={submitting}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          {formError !== null && (
            <p className="field__error" role="alert" data-testid="exception-error">
              {formError}
            </p>
          )}
          <div className="br-exceptions__form-actions">
            <button
              type="button"
              className="btn btn--secondary"
              disabled={submitting}
              onClick={() => {
                setAdding(false)
                setFormError(null)
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={submitting}
              data-loading={submitting ? 'true' : undefined}
              data-testid="exception-submit"
            >
              <span className="btn__label">Save exception</span>
              <span className="btn__spinner" aria-hidden="true" />
            </button>
          </div>
        </form>
      )}

      {exceptions.length === 0 ? (
        <p className="cell-muted" data-testid="no-exceptions">
          Nobody is held in or kept out by hand. Everyone follows the formula.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="table" data-testid="exceptions-table">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Mode</th>
                <th scope="col">Reason</th>
                <th scope="col">Set by</th>
                <th scope="col">Expires</th>
                {canManage && <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>}
              </tr>
            </thead>
            <tbody>
              {exceptions.map((exception) => {
                const person = people.get(exception.userId)
                return (
                  <tr key={exception.userId} data-testid="exception-row">
                    <td>
                      <Link to={`/people/${exception.userId}`} className="row-link">
                        {person?.displayName ?? exception.userId}
                      </Link>
                    </td>
                    <td>
                      {/* Both modes are exceptions to the norm, so both carry
                          a word AND a tint — but they are not the same class
                          of fact: an exclude withholds access somebody's
                          formula says they should have. */}
                      <span
                        className={`badge badge--${exception.mode === 'exclude' ? 'danger' : 'warn'}`}
                        data-exception-mode={exception.mode}
                      >
                        <span className="badge__dot" aria-hidden="true" />
                        {exception.mode === 'include' ? 'Held in' : 'Kept out'}
                      </span>
                    </td>
                    <td className="br-exceptions__reason-cell">{exception.reason}</td>
                    <td className="cell-muted">
                      {exception.grantedBy === null ? (
                        /* ON DELETE SET NULL — the account that wrote this is
                           gone. Said plainly; an empty cell would read as
                           "nobody", which is the one thing it cannot mean. */
                        'No longer on record'
                      ) : (
                        <>
                          {people.get(exception.grantedBy)?.displayName ?? exception.grantedBy}
                          <span className="br-exceptions__set-when">{formatDateTime(exception.createdAt)}</span>
                        </>
                      )}
                    </td>
                    <td className="cell-muted">
                      {exception.expiresAt === null ? 'Never' : formatDateTime(exception.expiresAt)}
                    </td>
                    {canManage && (
                      <td>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={removingId === exception.userId}
                          data-loading={removingId === exception.userId ? 'true' : undefined}
                          onClick={() => void handleRemove(exception.userId)}
                          data-testid="remove-exception"
                        >
                          <span className="btn__label">Clear</span>
                          <span className="btn__spinner" aria-hidden="true" />
                        </button>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
