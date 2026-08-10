import { useCallback, useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useParams } from 'react-router-dom'
import { ApiError } from '../api/client'
import { useSelfPermissions } from '../shell/permissions'
import { useToast } from '../shell/ToastProvider'
import {
  closeCampaign,
  decideItem,
  EFFECT_MESSAGE,
  fetchCampaign,
  openCampaign,
  REVIEWER_STRATEGY_LABEL,
  type RecertCampaignDetail,
  type RecertItem,
} from './api'
import { CampaignStatusBadge, DecisionBadge, describeReviewItem } from './badges'
import './Recertification.css'

/**
 * `/recertification/:id` — one campaign: status, progress, and the full
 * snapshotted item set, formula rows first (one decision covers each
 * rule) and exception rows after (one person each, reason visible —
 * `business_role_exceptions.reason` is NOT NULL exactly so this column
 * could exist).
 *
 * Open and Close carry their consequence in their own copy, PRODUCT.md's
 * "make consequence visible" rule: opening assigns real review work to
 * real people from a frozen snapshot; closing is TERMINAL and freezes
 * every undecided item as an honest "never reviewed". An admin holding
 * `recert:manage` can also decide items here — the API enforces that
 * nobody, admin or not, decides an item about their own access.
 */
export default function RecertCampaignDetailPage() {
  const { id } = useParams<{ id: string }>()
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const permissions = useSelfPermissions()
  const { showToast } = useToast()

  const canManage = permissions.status === 'ready' && permissions.actions.has('recert:manage')

  const [campaign, setCampaign] = useState<RecertCampaignDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'open' | 'close' | null>(null)
  const [decidingId, setDecidingId] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)

  const load = useCallback(() => {
    if (accessToken === undefined || id === undefined) return
    let cancelled = false
    setLoadError(null)
    void fetchCampaign(accessToken, id)
      .then((detail) => {
        if (!cancelled) setCampaign(detail)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setLoadError(
          cause instanceof ApiError
            ? `Could not load the campaign: ${cause.message}`
            : 'Could not load the campaign. Check your connection and try again.',
        )
      })
    return () => {
      cancelled = true
    }
  }, [accessToken, id])

  useEffect(() => load(), [load, retryToken])

  async function handleOpen() {
    if (accessToken === undefined || id === undefined) return
    setBusy('open')
    try {
      const opened = await openCampaign(accessToken, id)
      setCampaign(opened)
      showToast(
        `Opened. ${opened.itemsTotal} item${opened.itemsTotal === 1 ? '' : 's'} snapshotted and assigned to reviewers.`,
      )
    } catch (cause) {
      showToast(
        cause instanceof ApiError
          ? `The campaign was not opened: ${cause.message}`
          : 'The campaign was not opened. Check your connection and try again.',
      )
    } finally {
      setBusy(null)
    }
  }

  async function handleClose() {
    if (accessToken === undefined || id === undefined) return
    setBusy('close')
    try {
      await closeCampaign(accessToken, id)
      showToast('Closed. Undecided items stay recorded as never reviewed; a closed campaign cannot reopen.')
      setRetryToken((t) => t + 1)
    } catch (cause) {
      showToast(
        cause instanceof ApiError
          ? `The campaign was not closed: ${cause.message}`
          : 'The campaign was not closed. Check your connection and try again.',
      )
    } finally {
      setBusy(null)
    }
  }

  async function handleDecide(item: RecertItem, decision: 'certified' | 'revoked_requested') {
    if (accessToken === undefined) return
    setDecidingId(item.id)
    try {
      const result = await decideItem(accessToken, item.id, { decision, comment: null })
      showToast(EFFECT_MESSAGE[result.effect])
      setRetryToken((t) => t + 1)
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

  if (loadError !== null) {
    return (
      <div className="recert">
        <div className="error-panel" role="alert">
          <p className="error-panel__message">{loadError}</p>
          <button type="button" className="btn btn--secondary" onClick={() => setRetryToken((t) => t + 1)}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (campaign === null) {
    return (
      <div className="recert" aria-busy="true">
        <div className="page-header">
          <div className="page-header__text">
            <span className="skeleton" style={{ width: '18rem', height: '1.6rem' }} />
          </div>
        </div>
        <span className="skeleton" style={{ width: '100%', height: '8rem', display: 'block' }} />
      </div>
    )
  }

  return (
    <div className="recert">
      <p className="recert__breadcrumb">
        <Link className="row-link" to="/recertification">
          Recertification
        </Link>
      </p>
      <div className="page-header">
        <div className="page-header__text">
          <h1 className="text-title">{campaign.name}</h1>
          <p className="page-header__subtitle">
            Reviewed by: {REVIEWER_STRATEGY_LABEL[campaign.reviewerStrategy]}
            {campaign.dueDate !== null && ` · due ${campaign.dueDate}`}
          </p>
          <div className="recert__header-badges">
            <CampaignStatusBadge status={campaign.status} />
            {campaign.status !== 'draft' && (
              <span className="recert__progress" data-testid="campaign-progress">
                {campaign.itemsDecided} of {campaign.itemsTotal} decided
              </span>
            )}
          </div>
        </div>
        {canManage && campaign.status === 'draft' && (
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy !== null}
            data-loading={busy === 'open' ? 'true' : undefined}
            onClick={() => void handleOpen()}
            data-testid="open-campaign"
          >
            <span className="btn__label">Open — snapshot &amp; assign reviews</span>
            <span className="btn__spinner" aria-hidden="true" />
          </button>
        )}
        {canManage && campaign.status === 'open' && (
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy !== null}
            data-loading={busy === 'close' ? 'true' : undefined}
            onClick={() => void handleClose()}
            data-testid="close-campaign"
          >
            <span className="btn__label">Close — permanent</span>
            <span className="btn__spinner" aria-hidden="true" />
          </button>
        )}
      </div>

      {campaign.status === 'draft' ? (
        <div className="empty-state">
          <h3>Not opened yet</h3>
          <p>
            This campaign has no review set. Opening it snapshots the current state — each enabled
            role&rsquo;s formula as one item, and every include-exception as one item per person,
            with its recorded reason — and assigns each item to its reviewer. Until then, nobody is
            asked to do anything.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table" data-testid="campaign-items-table">
            <thead>
              <tr>
                <th scope="col">Under review</th>
                <th scope="col">Why it was granted</th>
                <th scope="col">Reviewer</th>
                <th scope="col">Decision</th>
                <th scope="col">Comment</th>
                {canManage && campaign.status === 'open' && <th scope="col">Decide</th>}
              </tr>
            </thead>
            <tbody>
              {campaign.items.map((item) => (
                <tr key={item.id}>
                  <td>{describeReviewItem(item)}</td>
                  <td className="recert__reason">
                    {item.itemKind === 'include_exception' ? (
                      item.exceptionReason
                    ) : (
                      <span className="cell-muted">Formula-derived — revoking is a role edit, not a campaign action</span>
                    )}
                  </td>
                  <td>{item.reviewer?.displayName ?? item.reviewer?.username ?? item.reviewerUserId}</td>
                  <td>
                    <DecisionBadge decision={item.decision} />
                  </td>
                  <td>{item.comment ?? <span className="cell-muted">—</span>}</td>
                  {canManage && campaign.status === 'open' && (
                    <td className="recert__row-actions">
                      {item.decision === 'pending' ? (
                        <>
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
                              {item.itemKind === 'include_exception' ? 'Revoke' : 'Flag'}
                            </span>
                            <span className="btn__spinner" aria-hidden="true" />
                          </button>
                        </>
                      ) : (
                        <span className="cell-muted">Decided</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
