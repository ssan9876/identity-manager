import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError } from '../api/client'
import { useSelfPermissions } from '../shell/permissions'
import { useToast } from '../shell/ToastProvider'
import {
  createCampaign,
  EFFECT_MESSAGE,
  fetchCampaigns,
  fetchMyReviews,
  decideItem,
  REVIEWER_STRATEGIES,
  REVIEWER_STRATEGY_LABEL,
  type MyReviewItem,
  type RecertCampaign,
  type ReviewerStrategy,
} from './api'
import { CampaignStatusBadge, describeReviewItem } from './badges'
import './Recertification.css'

/**
 * `/recertification` — access recertification over business-role
 * entitlements.
 *
 * TWO AUDIENCES ON ONE PAGE, deliberately, and in this order:
 *
 *  1. **My reviews** — the queue of items campaigns have resolved to THIS
 *    caller. It comes first and is not permission-gated, because a
 *    reviewer is usually an ordinary manager holding no role in the
 *    catalog at all: for them this queue IS the page, and the API's
 *    reviewer surface (`GET /recert/my-reviews`) works on identity alone.
 *  2. **Campaigns** — the operator's list, gated on `recert:read`, with
 *    creation (a draft; nobody sees anything until an explicit open)
 *    gated on `recert:manage`. The API re-decides both, as always.
 *
 * The queue shows each include-exception's MANDATORY reason verbatim —
 * `business_role_exceptions.reason` is NOT NULL precisely so a reviewer
 * has something to certify or refuse — and each revoke button states its
 * real consequence: an exception is expired and the engine revokes what
 * it granted; a formula finding revokes NOTHING (the role editor is where
 * formula access changes, behind its simulate-then-publish gate).
 */
export default function RecertificationPage() {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const permissions = useSelfPermissions()
  const navigate = useNavigate()
  const { showToast } = useToast()

  const canReadCampaigns = permissions.status === 'ready' && permissions.actions.has('recert:read')
  const canManage = permissions.status === 'ready' && permissions.actions.has('recert:manage')

  // ----- My reviews -----
  const [reviews, setReviews] = useState<MyReviewItem[] | null>(null)
  const [reviewsError, setReviewsError] = useState<string | null>(null)
  const [decidingId, setDecidingId] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)

  const loadReviews = useCallback(() => {
    if (accessToken === undefined) return
    let cancelled = false
    setReviewsError(null)
    void fetchMyReviews(accessToken)
      .then((items) => {
        if (!cancelled) setReviews(items)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setReviewsError(
          cause instanceof ApiError
            ? `Could not load your reviews: ${cause.message}`
            : 'Could not load your reviews. Check your connection and try again.',
        )
      })
    return () => {
      cancelled = true
    }
  }, [accessToken])

  useEffect(() => loadReviews(), [loadReviews, retryToken])

  async function handleDecide(item: MyReviewItem, decision: 'certified' | 'revoked_requested') {
    if (accessToken === undefined) return
    setDecidingId(item.id)
    try {
      const result = await decideItem(accessToken, item.id, { decision, comment: null })
      showToast(EFFECT_MESSAGE[result.effect])
      setReviews((current) => current?.filter((row) => row.id !== item.id) ?? null)
    } catch (cause) {
      showToast(
        cause instanceof ApiError
          ? `The decision was not recorded: ${cause.message}`
          : 'The decision was not recorded. Check your connection and try again.',
      )
    } finally {
      setDecidingId(null)
    }
  }

  // ----- Campaigns -----
  const [campaigns, setCampaigns] = useState<RecertCampaign[] | null>(null)
  const [campaignsError, setCampaignsError] = useState<string | null>(null)

  useEffect(() => {
    if (accessToken === undefined || !canReadCampaigns) return
    let cancelled = false
    setCampaignsError(null)
    void fetchCampaigns(accessToken)
      .then((list) => {
        if (!cancelled) setCampaigns(list)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setCampaignsError(
          cause instanceof ApiError
            ? `Could not load campaigns: ${cause.message}`
            : 'Could not load campaigns. Check your connection and try again.',
        )
      })
    return () => {
      cancelled = true
    }
  }, [accessToken, canReadCampaigns, retryToken])

  // ----- Create (inline disclosure, not a modal — same reasoning as BusinessRolesPage) -----
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [strategy, setStrategy] = useState<ReviewerStrategy>('manager_of_subject')
  const [dueDate, setDueDate] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (creating) nameRef.current?.focus()
  }, [creating])

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    if (accessToken === undefined) return
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      setCreateError('Give the campaign a name — "Q3 access review", say.')
      nameRef.current?.focus()
      return
    }
    setSubmitting(true)
    setCreateError(null)
    try {
      const created = await createCampaign(accessToken, {
        name: trimmed,
        scopeRoleIds: null,
        reviewerStrategy: strategy,
        dueDate: dueDate.length > 0 ? dueDate : null,
      })
      showToast(`Created "${created.name}" as a draft. Nobody is asked to review anything until you open it.`)
      navigate(`/recertification/${created.id}`)
    } catch (cause) {
      setCreateError(
        cause instanceof ApiError
          ? cause.message
          : 'Could not create the campaign. Check your connection and try again.',
      )
      setSubmitting(false)
    }
  }

  const reviewsEmpty = reviews !== null && reviews.length === 0

  return (
    <div className="recert">
      <div className="page-header">
        <div className="page-header__text">
          <h1 className="text-title">Recertification</h1>
          <p className="page-header__subtitle">
            Periodic review of what business roles grant. Formula-derived access is reviewed per
            role — one decision covers the rule — while each include-exception is reviewed per
            person, with the reason it was granted in front of the reviewer.
          </p>
        </div>
        {canManage && !creating && (
          <button type="button" className="btn btn--primary" onClick={() => setCreating(true)} data-testid="new-campaign">
            New campaign
          </button>
        )}
      </div>

      {creating && canManage && (
        <form className="recert__create" onSubmit={(e) => void handleCreate(e)} data-testid="campaign-create-form">
          <h2 className="recert__create-heading">New campaign</h2>
          <p className="recert__create-hint">
            It starts as a draft covering every enabled business role. Opening it takes the
            snapshot and puts items in front of reviewers — that is a separate, deliberate step.
          </p>
          <div className="recert__create-fields">
            <div className="field recert__create-name">
              <label className="field__label" htmlFor="campaign-name">
                Name
              </label>
              <input
                ref={nameRef}
                id="campaign-name"
                className="input"
                value={name}
                maxLength={255}
                disabled={submitting}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="campaign-strategy">
                Reviewed by
              </label>
              <select
                id="campaign-strategy"
                className="input"
                value={strategy}
                disabled={submitting}
                onChange={(e) => setStrategy(e.target.value as ReviewerStrategy)}
              >
                {REVIEWER_STRATEGIES.map((value) => (
                  <option key={value} value={value}>
                    {REVIEWER_STRATEGY_LABEL[value]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="campaign-due">
                Due date <span className="recert__optional">optional</span>
              </label>
              <input
                id="campaign-due"
                className="input"
                type="date"
                value={dueDate}
                disabled={submitting}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>
          {createError !== null && (
            <p className="field__error" role="alert">
              {createError}
            </p>
          )}
          <div className="recert__create-actions">
            <button
              type="button"
              className="btn btn--secondary"
              disabled={submitting}
              onClick={() => {
                setCreating(false)
                setCreateError(null)
                setName('')
                setDueDate('')
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={submitting}
              data-loading={submitting ? 'true' : undefined}
            >
              <span className="btn__label">Create draft</span>
              <span className="btn__spinner" aria-hidden="true" />
            </button>
          </div>
        </form>
      )}

      <section className="recert__section" aria-labelledby="my-reviews-heading">
        <h2 id="my-reviews-heading" className="recert__section-heading">
          My reviews
        </h2>
        <div className="table-wrap">
          {reviewsError !== null ? (
            <div className="error-panel" role="alert">
              <p className="error-panel__message">{reviewsError}</p>
              <button type="button" className="btn btn--secondary" onClick={() => setRetryToken((t) => t + 1)}>
                Try again
              </button>
            </div>
          ) : reviews === null ? (
            <table className="table" aria-hidden="true">
              <tbody>
                {Array.from({ length: 3 }).map((_, i) => (
                  <tr key={i}>
                    <td>
                      <span className="skeleton" style={{ width: '14rem', height: '0.9rem' }} />
                    </td>
                    <td>
                      <span className="skeleton" style={{ width: '20rem', height: '0.9rem' }} />
                    </td>
                    <td>
                      <span className="skeleton" style={{ width: '9rem', height: '1.3rem' }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : reviewsEmpty ? (
            <div className="empty-state">
              <h3>Nothing waiting on you</h3>
              <p>
                When a campaign resolves you as a reviewer — usually because you manage someone
                who was granted access by exception — the items appear here with the reason the
                access was granted, and your decision is recorded in the audit log.
              </p>
            </div>
          ) : (
            <table className="table" data-testid="my-reviews-table">
              <thead>
                <tr>
                  <th scope="col">Campaign</th>
                  <th scope="col">Access under review</th>
                  <th scope="col">Why it was granted</th>
                  <th scope="col">Due</th>
                  <th scope="col">Decision</th>
                </tr>
              </thead>
              <tbody>
                {reviews.map((item) => (
                  <tr key={item.id}>
                    <td>{item.campaign.name}</td>
                    <td>{describeReviewItem(item)}</td>
                    <td className="recert__reason">
                      {item.itemKind === 'include_exception' ? (
                        item.exceptionReason
                      ) : (
                        <span className="cell-muted">Formula-derived — one decision covers the rule</span>
                      )}
                    </td>
                    <td>{item.campaign.dueDate ?? <span className="cell-muted">—</span>}</td>
                    <td className="recert__row-actions">
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        disabled={decidingId !== null}
                        data-loading={decidingId === item.id ? 'true' : undefined}
                        onClick={() => void handleDecide(item, 'certified')}
                      >
                        <span className="btn__label">Certify</span>
                        <span className="btn__spinner" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="btn btn--danger btn--sm"
                        disabled={decidingId !== null}
                        data-loading={decidingId === item.id ? 'true' : undefined}
                        onClick={() => void handleDecide(item, 'revoked_requested')}
                      >
                        <span className="btn__label">
                          {item.itemKind === 'include_exception' ? 'Revoke' : 'Flag for revocation'}
                        </span>
                        <span className="btn__spinner" aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {canReadCampaigns && (
        <section className="recert__section" aria-labelledby="campaigns-heading">
          <h2 id="campaigns-heading" className="recert__section-heading">
            Campaigns
          </h2>
          <div className="table-wrap">
            {campaignsError !== null ? (
              <div className="error-panel" role="alert">
                <p className="error-panel__message">{campaignsError}</p>
                <button type="button" className="btn btn--secondary" onClick={() => setRetryToken((t) => t + 1)}>
                  Try again
                </button>
              </div>
            ) : campaigns !== null && campaigns.length === 0 ? (
              <div className="empty-state">
                <h3>No campaigns yet</h3>
                <p>
                  A campaign freezes a review set — every enabled role&rsquo;s formula, and every
                  include-exception with its reason — and asks the right people to certify or
                  revoke each piece.
                  {canManage ? ' Create one as a draft, then open it when you are ready.' : ''}
                </p>
              </div>
            ) : (
              <table className="table" data-testid="campaigns-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Status</th>
                    <th scope="col">Progress</th>
                    <th scope="col">Reviewed by</th>
                    <th scope="col">Due</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns === null
                    ? Array.from({ length: 3 }).map((_, i) => (
                        <tr key={i} aria-hidden="true">
                          <td colSpan={5}>
                            <span className="skeleton" style={{ width: '100%', height: '0.9rem' }} />
                          </td>
                        </tr>
                      ))
                    : campaigns.map((campaign) => (
                        <tr key={campaign.id}>
                          <td>
                            <Link className="row-link" to={`/recertification/${campaign.id}`} data-row-link="true">
                              {campaign.name}
                            </Link>
                          </td>
                          <td>
                            <CampaignStatusBadge status={campaign.status} />
                          </td>
                          <td>
                            {campaign.status === 'draft' ? (
                              <span className="cell-muted">Not opened</span>
                            ) : (
                              `${campaign.itemsDecided} of ${campaign.itemsTotal} decided`
                            )}
                          </td>
                          <td>{REVIEWER_STRATEGY_LABEL[campaign.reviewerStrategy]}</td>
                          <td>{campaign.dueDate ?? <span className="cell-muted">—</span>}</td>
                        </tr>
                      ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
