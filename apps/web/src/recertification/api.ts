import { authorizedRequest } from '../api/client'

/**
 * The console's mirror of `apps/api/src/recertification/*`. Every type is
 * written against the API's own shapes (`RecertCampaignsController`,
 * `RecertReviewsController`, `recert.repository.ts`), not guessed:
 * `GET /recert-campaigns` returns campaign rows each carrying the two
 * progress counts; `GET /recert-campaigns/:id` adds the item list with
 * names resolved; `GET /recert/my-reviews` is the caller's own pending
 * queue and needs no permission at all — reviewers are ordinary managers.
 */

/** Mirrors the `recert_reviewer_strategy` pgEnum — a closed vocabulary held as data, never code. */
export const REVIEWER_STRATEGIES = ['manager_of_subject', 'role_owner'] as const
export type ReviewerStrategy = (typeof REVIEWER_STRATEGIES)[number]

export const REVIEWER_STRATEGY_LABEL: Record<ReviewerStrategy, string> = {
  manager_of_subject: 'Manager of each person',
  role_owner: 'Campaign owner',
}

export type CampaignStatus = 'draft' | 'open' | 'closed'
export type RecertDecision = 'pending' | 'certified' | 'revoked_requested'
export type ItemKind = 'role_formula' | 'include_exception'

/** Mirrors `CampaignWithProgress`. */
export interface RecertCampaign {
  id: string
  name: string
  organizationId: string
  scopeRoleIds: string[] | null
  reviewerStrategy: ReviewerStrategy
  status: CampaignStatus
  dueDate: string | null
  createdBy: string
  openedAt: string | null
  closedAt: string | null
  createdAt: string
  updatedAt: string
  itemsTotal: number
  itemsDecided: number
}

interface PersonRef {
  id: string
  username: string
  displayName: string
}

/** Mirrors `CampaignItemView` — the snapshot row plus resolved names. */
export interface RecertItem {
  id: string
  campaignId: string
  businessRoleId: string
  businessRoleName: string
  itemKind: ItemKind
  subjectUserId: string | null
  subject: PersonRef | null
  /** `role_formula` only: how many people the formula held at snapshot time. */
  memberCount: number | null
  /** `include_exception` only: the exception's MANDATORY reason, surfaced verbatim to the reviewer. */
  exceptionReason: string | null
  exceptionExpiresAt: string | null
  reviewerUserId: string
  reviewer: PersonRef | null
  decision: RecertDecision
  decidedBy: string | null
  decidedAt: string | null
  comment: string | null
  createdAt: string
}

export interface RecertCampaignDetail extends RecertCampaign {
  items: RecertItem[]
}

/** Mirrors `MyReviewItem` — one row of the caller's own queue. */
export interface MyReviewItem extends Omit<RecertItem, 'reviewer' | 'businessRoleName' | 'subject'> {
  campaign: { id: string; name: string; dueDate: string | null }
  businessRoleName: string
  subject: PersonRef | null
}

/** Mirrors `DecisionEffect` — what the decision actually DID, so the toast can state a consequence rather than a success. */
export type DecisionEffect =
  | 'attested'
  | 'exception_expired'
  | 'exception_already_absent'
  | 'finding_recorded'

export function fetchCampaigns(accessToken: string): Promise<RecertCampaign[]> {
  return authorizedRequest<RecertCampaign[]>('/recert-campaigns', accessToken)
}

export function fetchCampaign(accessToken: string, id: string): Promise<RecertCampaignDetail> {
  return authorizedRequest<RecertCampaignDetail>(`/recert-campaigns/${id}`, accessToken)
}

/** Mirrors `createBodySchema` exactly — a new campaign is a DRAFT by construction; nobody sees an item until it is deliberately opened. */
export function createCampaign(
  accessToken: string,
  input: {
    name: string
    scopeRoleIds: string[] | null
    reviewerStrategy: ReviewerStrategy
    dueDate: string | null
  },
): Promise<RecertCampaign> {
  return authorizedRequest<RecertCampaign>('/recert-campaigns', accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

/** Snapshots the review set from current membership/exception state — one transaction, server-side. */
export function openCampaign(accessToken: string, id: string): Promise<RecertCampaignDetail> {
  return authorizedRequest<RecertCampaignDetail>(`/recert-campaigns/${id}/open`, accessToken, {
    method: 'POST',
  })
}

export function closeCampaign(accessToken: string, id: string): Promise<RecertCampaign> {
  return authorizedRequest<RecertCampaign>(`/recert-campaigns/${id}/close`, accessToken, {
    method: 'POST',
  })
}

export function fetchMyReviews(accessToken: string): Promise<MyReviewItem[]> {
  return authorizedRequest<MyReviewItem[]>('/recert/my-reviews', accessToken)
}

export function decideItem(
  accessToken: string,
  itemId: string,
  input: { decision: 'certified' | 'revoked_requested'; comment: string | null },
): Promise<{ item: RecertItem; effect: DecisionEffect }> {
  return authorizedRequest<{ item: RecertItem; effect: DecisionEffect }>(
    `/recert/items/${itemId}/decide`,
    accessToken,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  )
}

/** The toast copy per effect — the consequence, in words, in ONE place so the queue and the detail page cannot drift apart. */
export const EFFECT_MESSAGE: Record<DecisionEffect, string> = {
  attested: 'Certified. The attestation is recorded; nothing about the access changed.',
  exception_expired:
    'Revocation requested. The exception is expired and the engine has revoked what it granted — hand-added memberships are untouched.',
  exception_already_absent:
    'Recorded. The exception had already been removed or expired, so there was nothing left to revoke.',
  finding_recorded:
    'Finding recorded. The campaign revokes nothing that a formula grants — edit the role, simulate the change, and publish it to remove this access.',
}
