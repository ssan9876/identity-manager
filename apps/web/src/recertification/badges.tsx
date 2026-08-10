import type { CampaignStatus, MyReviewItem, RecertDecision, RecertItem } from './api'

/**
 * Status vocabulary for campaigns and decisions — docs/design-system.md:
 * "word + optional shape, never colour alone", and colour marks the
 * EXCEPTION, not the norm.
 */

const CAMPAIGN_WORD: Record<CampaignStatus, string> = {
  draft: 'Draft',
  open: 'Open',
  closed: 'Closed',
}

/**
 * `open` is the one state where work is outstanding and the primary action
 * (reviewing) is available — it takes --brand for the same reason a
 * ready-to-publish draft does on the business-roles screen. `draft` and
 * `closed` are quiet neutrals: a draft asks nothing of anyone, and closed
 * is the completed, terminal norm.
 */
export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  const variant = status === 'open' ? 'brand' : 'neutral'
  return (
    <span className={`badge badge--${variant}`} data-campaign-status={status}>
      {status === 'open' && <span className="badge__dot" aria-hidden="true" />}
      {CAMPAIGN_WORD[status]}
    </span>
  )
}

const DECISION_WORD: Record<RecertDecision, string> = {
  pending: 'Pending',
  certified: 'Certified',
  revoked_requested: 'Revocation requested',
}

/**
 * `pending` is the outstanding work — --warn, the "in flight, needs a
 * decision" colour. `certified` is the expected outcome of a review and
 * stays uncoloured. `revoked_requested` is the finding — the exception the
 * whole campaign exists to surface — and takes --danger, the same class of
 * fact as a revoked exception on the role screen.
 */
export function DecisionBadge({ decision }: { decision: RecertDecision }) {
  const variant =
    decision === 'pending' ? 'warn' : decision === 'revoked_requested' ? 'danger' : 'neutral'
  return (
    <span className={`badge badge--${variant}`} data-decision={decision}>
      {decision !== 'certified' && <span className="badge__dot" aria-hidden="true" />}
      {DECISION_WORD[decision]}
    </span>
  )
}

/**
 * One sentence naming what is under review, in the words a reviewer uses —
 * shared by the queue and the campaign detail so the two screens can never
 * describe the same item differently.
 */
export function describeReviewItem(
  item: Pick<RecertItem, 'itemKind' | 'businessRoleName' | 'memberCount'> & {
    subject: MyReviewItem['subject']
  },
): string {
  if (item.itemKind === 'role_formula') {
    const count = item.memberCount ?? 0
    return `Role “${item.businessRoleName}” — formula holding ${count} ${count === 1 ? 'person' : 'people'}`
  }
  const who = item.subject?.displayName ?? item.subject?.username ?? 'someone'
  return `${who} — included in “${item.businessRoleName}” by exception`
}
