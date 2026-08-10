import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { businessRoles } from './business-roles'
import { recertCampaigns } from './recert-campaigns'
import { users } from './users'

/**
 * The asymmetry this enum encodes IS the design intent the business-roles
 * code comments already wrote down (business-roles.repository.ts,
 * users.controller.ts):
 *
 *  - `role_formula` — a formula-derived membership set is reviewed PER
 *    ROLE: one decision covers the formula, and the item lists how many
 *    people it held at snapshot time. Reviewing each derived member
 *    individually would be attesting a computation one row at a time —
 *    the formula is the thing that grants, so the formula is the thing
 *    reviewed.
 *  - `include_exception` — an include-exception is reviewed PER PERSON,
 *    because it IS one person: a named individual granted access outside
 *    the formula, with the MANDATORY reason (`business_role_exceptions.
 *    reason`, NOT NULL precisely so a campaign can act on it) surfaced to
 *    the reviewer verbatim.
 */
export const recertItemKind = pgEnum('recert_item_kind', ['role_formula', 'include_exception'])

/**
 * `pending` → `certified` | `revoked_requested`, both decided states final
 * (enforced in `RecertReviewsController.decide` — a decided item is a 409).
 *
 * `revoked_requested`, deliberately not `revoked`: on an include-exception
 * the campaign EXPIRES the exception and the reconciler — the one writer
 * that only ever revokes what it granted — performs the actual revocation;
 * on a formula item the campaign performs NO revocation at all, it records
 * the finding and points the operator at editing the role, because an
 * engine that quietly strips access is this codebase's explicitly rejected
 * failure mode (role-evaluator's refuse-to-act note, restated).
 */
export const recertDecision = pgEnum('recert_decision', ['pending', 'certified', 'revoked_requested'])

/**
 * One unit of review inside a campaign — a SNAPSHOT row written at open
 * time from the then-current provenance-carrying state, in the same
 * transaction as the campaign's own draft→open transition. The snapshot is
 * the point: reviewers work a fixed set, and an exception granted after
 * the campaign opened belongs to the NEXT campaign, not to a set that
 * shifts under the people reviewing it.
 *
 * There is no delete and no route that edits anything but the decision
 * triplet (`decision`, `decided_by`/`decided_at`, `comment`) — an item is
 * evidence of what was reviewed, on the same terms as the audit log.
 */
export const recertItems = pgTable(
  'recert_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id').notNull(),

    /**
     * Copied from the campaign and pinned to it by the composite FK below —
     * and then REUSED to pin subject and reviewer (MATCH SIMPLE lets the
     * NULL subject of a `role_formula` item pass, exactly as a NULL
     * manager does on `users_manager_organization_fk`). This is the 0029
     * edge-table pattern: both endpoints of a review are individually
     * valid rows and only the PAIR can be wrong, so the pair is what the
     * database checks.
     */
    organizationId: uuid('organization_id').notNull(),

    /**
     * ON DELETE RESTRICT: business roles have no delete route, and if one
     * ever grows, deleting a role out from under an open review must fail
     * loudly rather than silently voiding the items that reviewed it —
     * the same reasoning as `business_role_grants.group_id`.
     */
    businessRoleId: uuid('business_role_id')
      .notNull()
      .references(() => businessRoles.id, { onDelete: 'restrict' }),

    itemKind: recertItemKind('item_kind').notNull(),

    /** NULL exactly when `item_kind = 'role_formula'` — the CHECK below makes the shape a schema fact, not a convention. */
    subjectUserId: uuid('subject_user_id'),

    /** `role_formula` only: how many people the formula held at snapshot time — the number the one covering decision covers. */
    memberCount: integer('member_count'),

    /**
     * `include_exception` only: the exception's MANDATORY reason, copied at
     * snapshot time so the reviewer sees the justification that was true
     * when the campaign opened — even if the exception is edited or removed
     * while the campaign runs. This column is why
     * `business_role_exceptions.reason` is NOT NULL: an unexplained
     * exception is precisely what a campaign cannot act on.
     */
    exceptionReason: text('exception_reason'),
    exceptionExpiresAt: timestamp('exception_expires_at', { withTimezone: true }),

    reviewerUserId: uuid('reviewer_user_id').notNull(),

    decision: recertDecision('decision').notNull().default('pending'),
    /** Who actually decided — the resolved reviewer, or an admin acting for them. SET NULL is moot (users are never deleted) but matches `granted_by`'s posture. */
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    comment: text('comment'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // The campaign FK carries organization_id, so an item can never claim a
    // tenant its campaign is not in. RESTRICT because campaigns have no
    // delete — and must never gain one that silently destroys review
    // evidence.
    campaignOrganizationFk: foreignKey({
      name: 'recert_items_campaign_organization_fk',
      columns: [table.campaignId, table.organizationId],
      foreignColumns: [recertCampaigns.id, recertCampaigns.organizationId],
    }).onDelete('restrict'),
    // Subject and reviewer are pinned to the CAMPAIGN's organization. MATCH
    // SIMPLE passes the NULL subject of a formula item outright — a row
    // that points at nothing cannot be cross-tenant.
    subjectOrganizationFk: foreignKey({
      name: 'recert_items_subject_organization_fk',
      columns: [table.subjectUserId, table.organizationId],
      foreignColumns: [users.id, users.organizationId],
    }).onDelete('restrict'),
    reviewerOrganizationFk: foreignKey({
      name: 'recert_items_reviewer_organization_fk',
      columns: [table.reviewerUserId, table.organizationId],
      foreignColumns: [users.id, users.organizationId],
    }).onDelete('restrict'),
    // Exactly the shape its kind names — the same belt-and-braces posture
    // as business_role_grants_kind_matches_reference. A formula item has a
    // count and no person; an exception item has a person and a reason.
    kindMatchesShape: check(
      'recert_items_kind_matches_shape',
      sql`(${table.itemKind} = 'role_formula'      AND ${table.subjectUserId} IS NULL     AND ${table.memberCount} IS NOT NULL AND ${table.exceptionReason} IS NULL)
       OR (${table.itemKind} = 'include_exception' AND ${table.subjectUserId} IS NOT NULL AND ${table.exceptionReason} IS NOT NULL AND ${table.memberCount} IS NULL)`,
    ),
    // One formula item per (campaign, role); one exception item per
    // (campaign, role, person). Two PARTIAL unique indexes rather than one,
    // because NULLs are never equal in a unique index (13-development.md's
    // own rule) — a single index over the triple would permit duplicate
    // formula items without limit.
    uniqueFormulaItem: uniqueIndex('recert_items_unique_formula')
      .on(table.campaignId, table.businessRoleId)
      .where(sql`${table.itemKind} = 'role_formula'`),
    uniqueExceptionItem: uniqueIndex('recert_items_unique_exception')
      .on(table.campaignId, table.businessRoleId, table.subjectUserId)
      .where(sql`${table.itemKind} = 'include_exception'`),
    // The two hot reads: a campaign's progress (count by decision) and a
    // reviewer's pending queue. Equality columns lead, per the composite-
    // index rule in 13-development.md.
    campaignDecisionIdx: index('recert_items_campaign_decision_idx').on(
      table.campaignId,
      table.decision,
    ),
    reviewerDecisionIdx: index('recert_items_reviewer_decision_idx').on(
      table.reviewerUserId,
      table.decision,
    ),
  }),
)
