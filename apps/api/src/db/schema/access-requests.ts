import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { businessRoles } from './business-roles'
import { organizations } from './organizations'
import { users } from './users'

/**
 * The request state machine, closed in the schema itself:
 * pending → approved | denied | cancelled, and every non-pending state is
 * TERMINAL — a decided or cancelled request never transitions again.
 * The transition rule is enforced by AccessRequestsRepository (every state
 * write carries `WHERE state = 'pending'`), not merely documented here.
 */
export const accessRequestState = pgEnum('access_request_state', [
  'pending',
  'approved',
  'denied',
  'cancelled',
])

/**
 * The CLOSED approver-resolution vocabulary — exactly the JML posture
 * (docs: "rules are data, never code"): a request records WHICH resolver
 * named its approver, and the resolvers themselves are a fixed enum plus a
 * switch in application code (access-requests/approver-resolver.ts). There
 * is deliberately no expression language, no admin-authored script, no
 * per-role resolver configuration table: an IdP that runs admin-authored
 * code against its own directory is a privilege-escalation vector by
 * construction, and the static-scan posture jml-rule-engine.spec.ts
 * establishes applies here too (test/access-requests.controller.spec.ts).
 *
 *  - `manager_of_subject`: the subject's `users.manager_id`, re-resolved
 *    FRESH at decision time (a re-org between request and decision moves
 *    the decision to the new manager, never the stale one).
 *  - `role_holder:super_admin`: the fallback when the subject has no
 *    manager — any holder of the `super_admin` admin role may decide.
 */
export const accessRequestApproverResolver = pgEnum('access_request_approver_resolver', [
  'manager_of_subject',
  'role_holder:super_admin',
])

/**
 * A self-service access request: "person X asks for business role Y, with a
 * justification, and the resolved approver decides".
 *
 * Deliberate shape decisions:
 *
 *  - `requester_user_id` AND `subject_user_id`, even though today they are
 *    always EQUAL (the controller sets both from the verified JWT principal
 *    and exposes no way to name anyone else): on-behalf-of requests later
 *    become a data change — a route that sets the two differently — not a
 *    schema migration.
 *  - `justification` is NOT NULL and CHECK-non-empty for the same reason
 *    `business_role_exceptions.reason` is: an unexplained grant is what a
 *    recertification campaign cannot act on, and an approved request is
 *    precisely the provenance of such an exception.
 *  - There is NO delete route and no delete here — requests are an
 *    append-only record of who asked for what and who decided; terminal
 *    states are how a request ends, removal is not.
 *  - `organization_id` with composite FKs (the 0029 pattern): the subject
 *    and the requested role are both pinned to the request's own
 *    organization, so a cross-tenant request — one tenant's employee asking
 *    for another tenant's role — is unrepresentable at the database, not
 *    merely unreachable through today's controller.
 *  - `decided_by` is `set null` on user delete like
 *    `business_role_exceptions.granted_by` (no user delete exists anyway);
 *    the audit log carries the durable copy of the decision.
 */
export const accessRequests = pgTable(
  'access_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

    requesterUserId: uuid('requester_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    subjectUserId: uuid('subject_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    businessRoleId: uuid('business_role_id')
      .notNull()
      .references(() => businessRoles.id, { onDelete: 'restrict' }),

    justification: text('justification').notNull(),

    state: accessRequestState('state').notNull().default('pending'),
    approverResolver: accessRequestApproverResolver('approver_resolver').notNull(),

    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionComment: text('decision_comment'),

    /** Optional requested expiry — becomes the include exception's `expires_at` on approval. */
    requestedExpiresAt: timestamp('requested_expires_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // "My requests" — the requester's own history, newest first.
    requesterIdx: index('access_requests_requester_idx').on(table.requesterUserId),
    // The approvals inbox: pending requests are found through the SUBJECT
    // (whose manager the manager_of_subject resolver names), so state leads
    // only in the org-wide read; the subject read carries state second.
    subjectStateIdx: index('access_requests_subject_state_idx').on(table.subjectUserId, table.state),
    orgStateIdx: index('access_requests_org_state_idx').on(table.organizationId, table.state),
    roleIdx: index('access_requests_role_idx').on(table.businessRoleId),

    // Belt and braces alongside the Zod `.min(1)`: the database itself
    // refuses an empty justification, matching the NOT NULL posture of
    // `business_role_exceptions.reason`.
    justificationNonEmpty: check(
      'access_requests_justification_non_empty',
      sql`length(btrim(${table.justification})) > 0`,
    ),

    // A decided request carries its decision; a pending one carries none.
    decisionShape: check(
      'access_requests_decision_shape',
      sql`(${table.state} = 'pending' AND ${table.decidedBy} IS NULL AND ${table.decidedAt} IS NULL AND ${table.decisionComment} IS NULL)
       OR (${table.state} <> 'pending' AND ${table.decidedAt} IS NOT NULL)`,
    ),

    // The 0029 composite-FK pattern: subject and role pinned to the
    // request's own organization (references the redundant-but-referenceable
    // `users_id_organization_key` / `business_roles_id_organization_key`
    // unique indexes). RESTRICT like the single-column FKs beside them.
    subjectOrganizationFk: foreignKey({
      name: 'access_requests_subject_organization_fk',
      columns: [table.subjectUserId, table.organizationId],
      foreignColumns: [users.id, users.organizationId],
    }).onDelete('restrict'),
    roleOrganizationFk: foreignKey({
      name: 'access_requests_role_organization_fk',
      columns: [table.businessRoleId, table.organizationId],
      foreignColumns: [businessRoles.id, businessRoles.organizationId],
    }).onDelete('restrict'),
  }),
)
