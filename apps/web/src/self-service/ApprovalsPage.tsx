import { useCallback, useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { formatDateTime } from '../format'
import { useToast } from '../shell/ToastProvider'
import {
  ApiError,
  decideAccessRequest,
  fetchApprovalsInbox,
  type AccessRequest,
} from './api'
import './SelfServicePage.css'

/**
 * `/approvals` — the approver's side of the access-request catalogue:
 * pending requests whose RESOLVED approver is the caller (their direct
 * reports' requests; plus, for super_admin holders, requests from people
 * with no manager), with one-click approve/deny and an optional comment.
 *
 * Reachable by every authenticated user, like `/self` — an ordinary manager
 * holds no admin permission at all, so this page is NOT permission-gated
 * (there is nothing in GET /self/permissions that could gate it). An
 * employee who manages nobody simply sees an empty inbox; the API is the
 * authority on who may actually decide, and re-checks on every mutation.
 */
export default function ApprovalsPage() {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const { showToast } = useToast()

  const [requests, setRequests] = useState<AccessRequest[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [comments, setComments] = useState<Record<string, string>>({})
  const [decidingId, setDecidingId] = useState<string | null>(null)

  const reload = useCallback(() => {
    if (accessToken === undefined) return
    setLoadError(null)
    void fetchApprovalsInbox(accessToken)
      .then((inbox) => setRequests(inbox.requests))
      .catch((cause: unknown) => {
        setLoadError(cause instanceof Error ? cause.message : 'Could not load your approvals.')
      })
  }, [accessToken])

  useEffect(() => {
    reload()
  }, [reload])

  async function decide(request: AccessRequest, decision: 'approve' | 'deny'): Promise<void> {
    if (accessToken === undefined) return
    setDecidingId(request.id)
    const comment = (comments[request.id] ?? '').trim()
    try {
      await decideAccessRequest(accessToken, request.id, decision, comment === '' ? null : comment)
      showToast(
        decision === 'approve'
          ? `Approved — ${request.subjectDisplayName} now holds ${request.businessRoleName}`
          : `Denied ${request.subjectDisplayName}'s request for ${request.businessRoleName}`,
        decision === 'approve' ? 'neutral' : 'warn',
      )
      reload()
    } catch (cause) {
      showToast(
        cause instanceof ApiError ? cause.message : 'Could not record the decision.',
        'danger',
      )
    } finally {
      setDecidingId(null)
    }
  }

  if (loadError !== null) {
    return (
      <main className="self-service">
        <div className="error-panel" role="alert">
          <p className="error-panel__message">Could not load your approvals: {loadError}</p>
        </div>
      </main>
    )
  }

  return (
    <main className="self-service">
      <h1 className="text-subject">Approvals</h1>

      <section className="self-service__section" aria-labelledby="approvals-heading">
        <h2 id="approvals-heading" className="text-title">
          Waiting on you
        </h2>

        {requests === null ? (
          <span className="skeleton" style={{ width: '100%', height: '6rem', display: 'block' }} />
        ) : requests.length === 0 ? (
          <p data-testid="approvals-empty">
            Nothing is waiting on you. Requests from your direct reports appear here.
          </p>
        ) : (
          <ul className="catalogue__list" data-testid="approvals-list">
            {requests.map((request) => (
              <li key={request.id} className="catalogue__row" data-testid={`approval-${request.id}`}>
                <div className="catalogue__row-main">
                  <div className="catalogue__row-text">
                    <span className="catalogue__role-name">
                      {request.subjectDisplayName} → {request.businessRoleName}
                    </span>
                    <span className="catalogue__role-description">
                      Requested {formatDateTime(request.createdAt)}
                      {request.requestedExpiresAt !== null &&
                        ` · access until ${formatDateTime(request.requestedExpiresAt)}`}
                    </span>
                    <span className="catalogue__role-description">
                      &ldquo;{request.justification}&rdquo;
                    </span>
                  </div>
                </div>
                <div className="approvals__decision">
                  <input
                    className="input"
                    type="text"
                    placeholder="Comment (optional)"
                    aria-label={`Comment on ${request.subjectDisplayName}'s request`}
                    maxLength={2000}
                    value={comments[request.id] ?? ''}
                    onChange={(e) =>
                      setComments((prev) => ({ ...prev, [request.id]: e.target.value }))
                    }
                    data-testid={`approval-comment-${request.id}`}
                  />
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={decidingId === request.id}
                    onClick={() => void decide(request, 'approve')}
                    data-testid={`approval-approve-${request.id}`}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger"
                    disabled={decidingId === request.id}
                    onClick={() => void decide(request, 'deny')}
                    data-testid={`approval-deny-${request.id}`}
                  >
                    Deny
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
