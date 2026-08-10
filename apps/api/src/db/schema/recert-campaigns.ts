import {
  date,
  index,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { organizations } from './organizations'
import { users } from './users'

/**
 * WHO reviews each item — a CLOSED vocabulary held as DATA, never code,
 * exactly as `jml_trigger`/`jml_action` are: the campaign row names a
 * strategy, and `RecertCampaignsController.resolveReviewer` (application
 * code, an allowlisted dispatch) interprets it at OPEN time. Widening the
 * vocabulary is a migration plus a code change that must land together —
 * a value this code does not recognise refuses at open rather than
 * silently assigning nobody, the same untrusted-enum posture
 * `jml-rules.ts`'s own doc comment describes.
 *
 *  - `manager_of_subject` — each per-person item goes to that person's
 *    `users.manager_id`, falling back to the campaign's creator when no
 *    manager is recorded (or when the manager IS the subject).
 *  - `role_owner` — `business_roles` carries no owner column today, so this
 *    resolves to the campaign's creator: the operator who opened the
 *    campaign stands accountable for the roles it reviews. The vocabulary
 *    being data is precisely what lets a real owner column change that
 *    resolution later without touching this schema.
 */
export const recertReviewerStrategy = pgEnum('recert_reviewer_strategy', [
  'manager_of_subject',
  'role_owner',
])

/**
 * draft → open → closed, enforced by an allow-list in
 * `RecertRepository.transition` exactly as `users.status` transitions are.
 * `closed` is TERMINAL: a campaign is a record of a review that happened,
 * so it can never reopen — reopening would let new decisions be appended
 * to an attestation that auditors may already have relied on. There is no
 * delete anywhere, for the same reason.
 */
export const recertCampaignStatus = pgEnum('recert_campaign_status', ['draft', 'open', 'closed'])

/**
 * An access-recertification campaign over business-role entitlements — the
 * governance layer the business-roles design named as its own dependent
 * ("periodic recertification ... needs entitlements to operate on").
 *
 * A campaign is OPENED BY AN OPERATOR (or a CLI), never by an in-process
 * scheduler — the same on-demand posture as `jml:lifecycle` and the
 * reconcile CLIs. Opening SNAPSHOTS the review set (`recert_items`) from
 * the provenance-carrying membership/exception state in one transaction;
 * the campaign row itself carries only the frame: what to review
 * (`scope_role_ids`), who reviews it (`reviewer_strategy`), and by when.
 */
export const recertCampaigns = pgTable(
  'recert_campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),

    /**
     * Same composite-FK pattern as every other tenant-carrying table
     * (0025/0029): the campaign's organization pins every `recert_items`
     * row — subject AND reviewer — to the same tenant, because a review
     * item joining one tenant's campaign to another tenant's person would
     * leak names and access across the boundary. ON DELETE RESTRICT like
     * org_units/users/groups/business_roles: an organization can never be
     * deleted out from under its own attestation record.
     */
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

    /**
     * Which business roles the campaign reviews. `NULL` means EVERY enabled
     * role in the organization at open time. A jsonb uuid list rather than a
     * child table, deliberately: the scope is an INPUT read exactly once, at
     * open, when it is validated against `business_roles` and frozen into
     * the snapshot — after that moment the items themselves are the record,
     * and a normalized scope table would be a second copy of what the items
     * already say.
     */
    scopeRoleIds: jsonb('scope_role_ids').$type<string[]>(),

    reviewerStrategy: recertReviewerStrategy('reviewer_strategy').notNull(),

    /** Defaults `draft` at the column level — a new campaign reviews nothing until deliberately opened. */
    status: recertCampaignStatus('status').notNull().default('draft'),

    /** A calendar date, like `users.start_date`/`end_date` — "due by the 30th" is a date on a review calendar, not an instant. */
    dueDate: date('due_date'),

    /**
     * ON DELETE RESTRICT, matching `audit_log.actor_user_id`: users are
     * never deleted in this system, and a campaign whose accountable
     * creator could silently become NULL would be an attestation with
     * nobody's name on it.
     */
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    openedAt: timestamp('opened_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // The referenceable target for recert_items' composite campaign FK —
    // strictly redundant as uniqueness (id alone implies it); it exists
    // only to be referenceable, exactly like users_id_organization_key
    // (0029's own note).
    idOrganizationKey: uniqueIndex('recert_campaigns_id_organization_key').on(
      table.id,
      table.organizationId,
    ),
    // The console's list read: campaigns in one organization, newest work
    // first. organization_id leads for the same reason it leads on
    // business_roles_enabled_idx — the first discriminator once a second
    // tenant exists.
    orgStatusIdx: index('recert_campaigns_org_status_idx').on(table.organizationId, table.status),
  }),
)
