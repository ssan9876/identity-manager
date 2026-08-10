import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { formatDateTime } from '../format'
import { Field } from '../forms/Field'
import { useToast } from '../shell/ToastProvider'
import {
  ApiError,
  cancelAccessRequest,
  createAccessRequest,
  fetchCatalogue,
  fetchMyRequests,
  type AccessRequest,
  type AccessRequestState,
  type CatalogueRole,
} from './api'

/**
 * One badge per request state, on the shared `.badge` vocabulary
 * (styles/components.css — colour marks the exception, the WORD carries the
 * meaning): `pending` is the open, waiting-on-someone state (warn), `denied`
 * is the refusal (danger), `approved` and `cancelled` are settled history
 * (brand/neutral).
 */
export function RequestStateBadge({ state }: { state: AccessRequestState }) {
  const variant =
    state === 'pending'
      ? 'warn'
      : state === 'denied'
        ? 'danger'
        : state === 'approved'
          ? 'brand'
          : 'neutral'
  const label = state.charAt(0).toUpperCase() + state.slice(1)
  return (
    <span className={`badge badge--${variant}`} data-state={state}>
      <span className="badge__dot" aria-hidden="true" />
      {label}
    </span>
  )
}

/**
 * The per-role request form: a MANDATORY justification (the API rejects an
 * empty one — it becomes the approval's exception reason verbatim) and an
 * optional access-until date, converted to an end-of-day UTC instant because
 * the API takes an ISO instant (the exception expiry is compared as an
 * instant, exclusive at the boundary).
 */
function RequestForm({
  role,
  onSubmitted,
  onCancel,
}: {
  role: CatalogueRole
  onSubmitted: () => void
  onCancel: () => void
}) {
  const auth = useAuth()
  const { showToast } = useToast()
  const [justification, setJustification] = useState('')
  const [expiresOn, setExpiresOn] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    const accessToken = auth.user?.access_token
    if (accessToken === undefined || justification.trim().length === 0) return

    setSubmitting(true)
    setError(null)
    try {
      await createAccessRequest(accessToken, {
        businessRoleId: role.id,
        justification: justification.trim(),
        requestedExpiresAt:
          expiresOn === '' ? null : new Date(`${expiresOn}T23:59:59.999Z`).toISOString(),
      })
      showToast(`Requested ${role.name} — awaiting approval`)
      onSubmitted()
    } catch (cause) {
      setSubmitting(false)
      setError(cause instanceof ApiError ? cause.message : 'Could not submit the request.')
    }
  }

  return (
    <form
      className="catalogue__request-form"
      onSubmit={(e) => void submit(e)}
      data-testid={`catalogue-request-form-${role.id}`}
    >
      <Field id={`catalogue-justification-${role.id}`} label="Justification (required)">
        <textarea
          id={`catalogue-justification-${role.id}`}
          className="input"
          rows={3}
          required
          maxLength={2000}
          value={justification}
          onChange={(e) => setJustification(e.target.value)}
          data-testid={`catalogue-justification-${role.id}`}
        />
      </Field>
      <Field id={`catalogue-expiry-${role.id}`} label="Access until (optional)">
        <input
          id={`catalogue-expiry-${role.id}`}
          className="input"
          type="date"
          value={expiresOn}
          onChange={(e) => setExpiresOn(e.target.value)}
        />
      </Field>
      {error !== null && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
      <div className="catalogue__request-actions">
        <button
          type="submit"
          className="btn btn--primary"
          disabled={submitting || justification.trim().length === 0}
          data-testid={`catalogue-submit-${role.id}`}
        >
          {submitting ? 'Requesting…' : 'Submit request'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/**
 * The self-service Catalogue: browse the roles published as requestable,
 * ask for one with a justification, and follow your own requests — the
 * console face of `/access-requests` (catalogue / mine / cancel). Approvals
 * live on their own page (`/approvals`); this section is strictly the
 * requester's side.
 */
export default function CatalogueSection() {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const { showToast } = useToast()

  const [roles, setRoles] = useState<CatalogueRole[] | null>(null)
  const [requests, setRequests] = useState<AccessRequest[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [openRoleId, setOpenRoleId] = useState<string | null>(null)
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  const reload = useCallback(() => {
    if (accessToken === undefined) return
    setLoadError(null)
    void Promise.all([fetchCatalogue(accessToken), fetchMyRequests(accessToken)])
      .then(([catalogue, mine]) => {
        setRoles(catalogue.roles)
        setRequests(mine.requests)
      })
      .catch((cause: unknown) => {
        setLoadError(cause instanceof Error ? cause.message : 'Could not load the catalogue.')
      })
  }, [accessToken])

  useEffect(() => {
    reload()
  }, [reload])

  async function cancelRequest(request: AccessRequest): Promise<void> {
    if (accessToken === undefined) return
    setCancellingId(request.id)
    try {
      await cancelAccessRequest(accessToken, request.id)
      showToast(`Cancelled your request for ${request.businessRoleName}`)
      reload()
    } catch (cause) {
      showToast(
        cause instanceof ApiError ? cause.message : 'Could not cancel the request.',
        'danger',
      )
    } finally {
      setCancellingId(null)
    }
  }

  if (loadError !== null) {
    return (
      <div className="error-panel" role="alert">
        <p className="error-panel__message">Could not load the catalogue: {loadError}</p>
      </div>
    )
  }

  const pendingRoleIds = new Set(
    (requests ?? []).filter((r) => r.state === 'pending').map((r) => r.businessRoleId),
  )

  return (
    <>
      {roles === null || requests === null ? (
        <span className="skeleton" style={{ width: '100%', height: '4rem', display: 'block' }} />
      ) : (
        <>
          {roles.length === 0 ? (
            <p>No roles are currently open for requests.</p>
          ) : (
            <ul className="catalogue__list" data-testid="catalogue-list">
              {roles.map((role) => (
                <li key={role.id} className="catalogue__row" data-testid={`catalogue-role-${role.id}`}>
                  <div className="catalogue__row-main">
                    <div className="catalogue__row-text">
                      <span className="catalogue__role-name">{role.name}</span>
                      {role.description !== null && role.description !== '' && (
                        <span className="catalogue__role-description">{role.description}</span>
                      )}
                    </div>
                    {pendingRoleIds.has(role.id) ? (
                      <span className="badge badge--warn">
                        <span className="badge__dot" aria-hidden="true" />
                        Requested
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setOpenRoleId(openRoleId === role.id ? null : role.id)}
                        data-testid={`catalogue-request-${role.id}`}
                      >
                        Request
                      </button>
                    )}
                  </div>
                  {openRoleId === role.id && !pendingRoleIds.has(role.id) && (
                    <RequestForm
                      role={role}
                      onSubmitted={() => {
                        setOpenRoleId(null)
                        reload()
                      }}
                      onCancel={() => setOpenRoleId(null)}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}

          <h3 className="catalogue__requests-heading">My requests</h3>
          {requests.length === 0 ? (
            <p>You have not requested anything yet.</p>
          ) : (
            <ul className="catalogue__list" data-testid="my-requests-list">
              {requests.map((request) => (
                <li key={request.id} className="catalogue__row" data-testid={`my-request-${request.id}`}>
                  <div className="catalogue__row-main">
                    <div className="catalogue__row-text">
                      <span className="catalogue__role-name">{request.businessRoleName}</span>
                      <span className="catalogue__role-description">
                        Requested {formatDateTime(request.createdAt)}
                        {request.requestedExpiresAt !== null &&
                          ` · access until ${formatDateTime(request.requestedExpiresAt)}`}
                      </span>
                      <span className="catalogue__role-description">{request.justification}</span>
                      {request.decisionComment !== null && request.decisionComment !== '' && (
                        <span className="catalogue__role-description">
                          Decision: {request.decisionComment}
                        </span>
                      )}
                    </div>
                    <div className="catalogue__row-side">
                      <RequestStateBadge state={request.state} />
                      {request.state === 'pending' && (
                        <button
                          type="button"
                          className="btn"
                          disabled={cancellingId === request.id}
                          onClick={() => void cancelRequest(request)}
                          data-testid={`my-request-cancel-${request.id}`}
                        >
                          {cancellingId === request.id ? 'Cancelling…' : 'Cancel'}
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  )
}
