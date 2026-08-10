import { Inject, Injectable, Optional } from '@nestjs/common'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { InvalidTransitionError, NotFoundError } from '../common/errors'
import { businessRoles } from '../db/schema/business-roles'
import * as schema from '../db/schema/index'
import { recertCampaigns } from '../db/schema/recert-campaigns'
import { recertItems } from '../db/schema/recert-items'
import { users } from '../db/schema/users'
import { OrganizationsRepository } from '../organizations/organizations.repository'

/** One `recert_campaigns` row, exactly as stored. */
export type RecertCampaignRow = typeof recertCampaigns.$inferSelect
/** One `recert_items` row, exactly as stored. */
export type RecertItemRow = typeof recertItems.$inferSelect

export type ReviewerStrategy = RecertCampaignRow['reviewerStrategy']
export type CampaignStatus = RecertCampaignRow['status']
export type RecertDecision = RecertItemRow['decision']

/**
 * `itemsTotal`/`itemsDecided` on every campaign read — the progress fields
 * the console's list and detail both render ("14 of 20 decided"). Computed
 * from `recert_items` on every read rather than stored on the campaign,
 * for the reason `justifiedBy` is never stored (users.controller.ts): a
 * counter column would need updating in lockstep with every decision and
 * could silently drift; a COUNT over an indexed column cannot lie.
 */
export interface CampaignProgress {
  itemsTotal: number
  itemsDecided: number
}

export type CampaignWithProgress = RecertCampaignRow & CampaignProgress

/**
 * The ONLY legal status moves. `closed` maps to an empty list — terminal
 * states are final, the same allow-list (not deny-list) posture as
 * `UsersRepository`'s status transitions: a status value added to the enum
 * later is unreachable by default rather than reachable by default.
 */
const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = Object.assign(
  Object.create(null) as Record<CampaignStatus, readonly CampaignStatus[]>,
  {
    draft: ['open'],
    open: ['closed'],
    closed: [],
  } satisfies Record<CampaignStatus, readonly CampaignStatus[]>,
)

/**
 * Row access for recertification campaigns and their snapshotted items.
 *
 * Every write takes the CALLER's transaction handle explicitly (the same
 * contract as `BusinessRolesRepository`'s own doc comment spells out):
 * `RecertCampaignsController` and `RecertReviewsController` always hold a
 * transaction open when mutating, so the mutation and its audit row commit
 * together, and nothing here ever checks out a SECOND pooled connection
 * while that transaction sits open (finding C1, guarded by
 * test/pool-exhaustion.spec.ts).
 */
@Injectable()
export class RecertRepository {
  constructor(
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
    // OPTIONAL, defaulting to a raw instance bound to the same `db` — the
    // pattern BusinessRolesRepository/GroupsRepository already use for this
    // exact dependency.
    @Optional()
    @Inject(OrganizationsRepository)
    private readonly organizations: OrganizationsRepository = new OrganizationsRepository(db),
  ) {}

  /**
   * A new campaign is a DRAFT by construction — `status` defaults `draft`
   * at the column level and this method exposes no way to override it, so
   * creating a campaign can never, by itself, put an item in front of any
   * reviewer; that takes a deliberate, separately-audited open.
   *
   * Falls back to master for `organizationId` exactly as
   * `BusinessRolesRepository.create` does, and for the same reason: no API
   * surface can name a target organization yet.
   */
  async create(
    input: {
      name: string
      scopeRoleIds: string[] | null
      reviewerStrategy: ReviewerStrategy
      dueDate: string | null
      createdBy: string
    },
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<RecertCampaignRow> {
    const master = await this.organizations.findMaster(db)
    const [row] = await db
      .insert(recertCampaigns)
      .values({ ...input, organizationId: master.id })
      .returning()
    return row
  }

  /** Every campaign, newest first, each carrying its progress counts. */
  async list(db: NodePgDatabase<typeof schema> = this.db): Promise<CampaignWithProgress[]> {
    const campaigns = await db.select().from(recertCampaigns).orderBy(desc(recertCampaigns.createdAt))
    const progress = await this.progressByCampaign(
      campaigns.map((c) => c.id),
      db,
    )
    return campaigns.map((campaign) => ({
      ...campaign,
      ...(progress.get(campaign.id) ?? { itemsTotal: 0, itemsDecided: 0 }),
    }))
  }

  async findById(
    id: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<CampaignWithProgress | null> {
    const [campaign] = await db.select().from(recertCampaigns).where(eq(recertCampaigns.id, id))
    if (!campaign) return null
    const progress = await this.progressByCampaign([campaign.id], db)
    return { ...campaign, ...(progress.get(campaign.id) ?? { itemsTotal: 0, itemsDecided: 0 }) }
  }

  /**
   * One aggregate over the indexed `(campaign_id, decision)` pair rather
   * than a count query per campaign. `FILTER` keeps it a single pass.
   */
  private async progressByCampaign(
    campaignIds: string[],
    db: NodePgDatabase<typeof schema>,
  ): Promise<Map<string, CampaignProgress>> {
    if (campaignIds.length === 0) return new Map()
    const rows = await db
      .select({
        campaignId: recertItems.campaignId,
        itemsTotal: sql<number>`count(*)::int`,
        itemsDecided: sql<number>`(count(*) filter (where ${recertItems.decision} <> 'pending'))::int`,
      })
      .from(recertItems)
      .where(inArray(recertItems.campaignId, campaignIds))
      .groupBy(recertItems.campaignId)
    return new Map(
      rows.map((row) => [row.campaignId, { itemsTotal: row.itemsTotal, itemsDecided: row.itemsDecided }]),
    )
  }

  /**
   * Locks the campaign row and applies one allow-listed status transition.
   * `FOR UPDATE` so two concurrent opens cannot both observe `draft` and
   * each write a full snapshot — the second blocks, re-reads `open`, and
   * refuses. An illegal move is an INVALID_TRANSITION 409 naming both ends.
   */
  async lockForTransition(
    db: NodePgDatabase<typeof schema>,
    id: string,
    to: CampaignStatus,
  ): Promise<RecertCampaignRow> {
    const [campaign] = await db
      .select()
      .from(recertCampaigns)
      .where(eq(recertCampaigns.id, id))
      .for('update')
    if (!campaign) throw new NotFoundError('recertification campaign', id)

    const allowed = CAMPAIGN_TRANSITIONS[campaign.status] ?? []
    if (!allowed.includes(to)) {
      throw new InvalidTransitionError(
        `a ${campaign.status} campaign cannot become ${to} — the only legal moves are draft → open → closed, and closed is final`,
      )
    }
    return campaign
  }

  async markOpened(
    db: NodePgDatabase<typeof schema>,
    id: string,
    now: Date,
  ): Promise<RecertCampaignRow> {
    const [row] = await db
      .update(recertCampaigns)
      .set({ status: 'open', openedAt: now, updatedAt: now })
      .where(eq(recertCampaigns.id, id))
      .returning()
    return row
  }

  async markClosed(
    db: NodePgDatabase<typeof schema>,
    id: string,
    now: Date,
  ): Promise<RecertCampaignRow> {
    const [row] = await db
      .update(recertCampaigns)
      .set({ status: 'closed', closedAt: now, updatedAt: now })
      .where(eq(recertCampaigns.id, id))
      .returning()
    return row
  }

  /**
   * Which of `roleIds` actually exist in this organization — the open-time
   * scope validation. Returns the found ids so the caller can name the
   * first missing one in a 404; a role in ANOTHER organization is
   * deliberately reported exactly like a nonexistent one (the same
   * no-existence-oracle posture as SEC-L2).
   */
  async existingRoleIds(
    db: NodePgDatabase<typeof schema>,
    organizationId: string,
    roleIds: string[],
  ): Promise<Set<string>> {
    if (roleIds.length === 0) return new Set()
    const rows = await db
      .select({ id: businessRoles.id })
      .from(businessRoles)
      .where(and(eq(businessRoles.organizationId, organizationId), inArray(businessRoles.id, roleIds)))
    return new Set(rows.map((row) => row.id))
  }

  async insertItems(
    db: NodePgDatabase<typeof schema>,
    rows: (typeof recertItems.$inferInsert)[],
  ): Promise<void> {
    if (rows.length === 0) return
    await db.insert(recertItems).values(rows)
  }

  /** A campaign's full item set, stable order: formulas first, then exceptions, each by creation. */
  async listItems(
    campaignId: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<RecertItemRow[]> {
    return db
      .select()
      .from(recertItems)
      .where(eq(recertItems.campaignId, campaignId))
      .orderBy(asc(recertItems.itemKind), asc(recertItems.createdAt), asc(recertItems.id))
  }

  async findItemById(
    id: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<RecertItemRow | null> {
    const [row] = await db.select().from(recertItems).where(eq(recertItems.id, id))
    return row ?? null
  }

  /**
   * The reviewer's queue: this person's PENDING items on OPEN campaigns —
   * a decided item leaves the queue, and a closed campaign takes its
   * undecided items with it (they stay `pending` forever as an honest
   * record that the review never happened, but there is nothing left to
   * act on).
   */
  async listPendingForReviewer(
    reviewerUserId: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<(RecertItemRow & { campaign: RecertCampaignRow })[]> {
    const rows = await db
      .select({ item: recertItems, campaign: recertCampaigns })
      .from(recertItems)
      .innerJoin(recertCampaigns, eq(recertItems.campaignId, recertCampaigns.id))
      .where(
        and(
          eq(recertItems.reviewerUserId, reviewerUserId),
          eq(recertItems.decision, 'pending'),
          eq(recertCampaigns.status, 'open'),
        ),
      )
      .orderBy(asc(recertCampaigns.dueDate), asc(recertItems.createdAt), asc(recertItems.id))
    return rows.map((row) => ({ ...row.item, campaign: row.campaign }))
  }

  /**
   * Writes the decision triplet. Guarded on `decision = 'pending'` in the
   * WHERE as well as by the caller's own check — the same
   * repeat-the-predicate-in-SQL posture as `RoleReconciler`'s deletes: a
   * concurrent decision landing between the caller's read and this write
   * must lose, not overwrite.
   */
  async decideItem(
    db: NodePgDatabase<typeof schema>,
    id: string,
    input: { decision: Exclude<RecertDecision, 'pending'>; decidedBy: string; comment: string | null },
    now: Date,
  ): Promise<RecertItemRow | null> {
    const [row] = await db
      .update(recertItems)
      .set({ decision: input.decision, decidedBy: input.decidedBy, decidedAt: now, comment: input.comment })
      .where(and(eq(recertItems.id, id), eq(recertItems.decision, 'pending')))
      .returning()
    return row ?? null
  }

  /**
   * Display names for the ids a campaign's items reference — role names,
   * subject/reviewer usernames — so the console renders words, not uuids.
   */
  async displayContext(
    db: NodePgDatabase<typeof schema>,
    roleIds: string[],
    userIds: string[],
  ): Promise<{
    roleNames: Map<string, string>
    userNames: Map<string, { username: string; displayName: string }>
  }> {
    const [roleRows, userRows] = [
      roleIds.length === 0
        ? []
        : await db
            .select({ id: businessRoles.id, name: businessRoles.name })
            .from(businessRoles)
            .where(inArray(businessRoles.id, roleIds)),
      userIds.length === 0
        ? []
        : await db
            .select({ id: users.id, username: users.username, displayName: users.displayName })
            .from(users)
            .where(inArray(users.id, userIds)),
    ]
    return {
      roleNames: new Map((await roleRows).map((row) => [row.id, row.name])),
      userNames: new Map(
        (await userRows).map((row) => [row.id, { username: row.username, displayName: row.displayName }]),
      ),
    }
  }
}
