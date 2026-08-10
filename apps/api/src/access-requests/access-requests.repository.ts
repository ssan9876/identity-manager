import { Inject, Injectable } from '@nestjs/common'
import { and, asc, desc, eq, getTableColumns, or } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { ConflictError, NotFoundError } from '../common/errors'
import { accessRequests } from '../db/schema/access-requests'
import { businessRoles } from '../db/schema/business-roles'
import * as schema from '../db/schema/index'
import { users } from '../db/schema/users'
import type { ApproverResolver } from './approver-resolver'

/** One `access_requests` row, exactly as stored. */
export type AccessRequestRow = typeof accessRequests.$inferSelect

/**
 * A row plus the names a list screen needs — the requested role's name and
 * the subject's identity — joined here rather than N+1-fetched by the
 * console. `subject*` rather than `requester*` because the SUBJECT is who
 * the access is for and whose manager decides; today the two are always the
 * same person (see the schema's own doc comment).
 */
export interface AccessRequestWithContext extends AccessRequestRow {
  businessRoleName: string
  subjectUsername: string
  subjectDisplayName: string
}

/** The three exits of the state machine. `pending` is deliberately not constructible here. */
export type TerminalAccessRequestState = 'approved' | 'denied' | 'cancelled'

const CONTEXT_COLUMNS = {
  businessRoleName: businessRoles.name,
  subjectUsername: users.username,
  subjectDisplayName: users.displayName,
} as const

/**
 * Storage for `access_requests` — the self-service request catalogue's
 * ledger (migration 0036).
 *
 * THE STATE MACHINE IS ENFORCED HERE, not in the controller: `transition`
 * below is the ONLY write that changes `state`, and it is guarded with
 * `WHERE state = 'pending'` so a terminal row (approved/denied/cancelled)
 * can never transition again — including under two concurrent deciders,
 * where exactly one UPDATE matches and the other surfaces as a 409. There
 * is no delete method, and there must never be one: requests are the
 * append-only record of who asked for what and who decided.
 *
 * Every method takes the caller's `db` handle (controller passes its open
 * `tx` for writes) — finding C1's connection discipline, same as every
 * other repository here.
 */
@Injectable()
export class AccessRequestsRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>) {}

  /**
   * The catalogue: roles an employee may ask for. `requestable` AND
   * `enabled`, in ONE organization — a disabled role's include exception
   * grants nothing, so listing it would collect justifications for a
   * request that cannot take effect; and the tenant filter is required for
   * the same reason it is on `listEnabledForEvaluation` (a forgotten filter
   * here leaks another tenant's role catalogue).
   */
  async listRequestable(
    organizationId: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<Array<{ id: string; name: string; description: string | null }>> {
    return db
      .select({ id: businessRoles.id, name: businessRoles.name, description: businessRoles.description })
      .from(businessRoles)
      .where(
        and(
          eq(businessRoles.organizationId, organizationId),
          eq(businessRoles.requestable, true),
          eq(businessRoles.enabled, true),
        ),
      )
      .orderBy(asc(businessRoles.name))
  }

  /**
   * A new, always-`pending` request. `state` is deliberately absent from
   * the input — there is no way to construct a pre-decided request, exactly
   * as `JmlRulesRepository.create` refuses a pre-enabled rule.
   */
  async create(
    db: NodePgDatabase<typeof schema>,
    input: {
      organizationId: string
      requesterUserId: string
      subjectUserId: string
      businessRoleId: string
      justification: string
      approverResolver: ApproverResolver
      requestedExpiresAt: Date | null
    },
  ): Promise<AccessRequestRow> {
    const [row] = await db.insert(accessRequests).values(input).returning()
    return row
  }

  async findById(
    id: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<AccessRequestRow | null> {
    const [row] = await db.select().from(accessRequests).where(eq(accessRequests.id, id))
    return row ?? null
  }

  /** The caller's own request history, newest first — the "My requests" list. */
  async listForRequester(
    requesterUserId: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<AccessRequestWithContext[]> {
    return db
      .select({ ...getTableColumns(accessRequests), ...CONTEXT_COLUMNS })
      .from(accessRequests)
      .innerJoin(businessRoles, eq(accessRequests.businessRoleId, businessRoles.id))
      .innerJoin(users, eq(accessRequests.subjectUserId, users.id))
      .where(eq(accessRequests.requesterUserId, requesterUserId))
      .orderBy(desc(accessRequests.createdAt))
  }

  /**
   * The approvals inbox: every PENDING request whose STORED resolver names
   * the caller —
   *
   *  - `manager_of_subject` rows where the subject's CURRENT `manager_id`
   *    is the caller (re-resolved fresh on every read: a re-org moves the
   *    inbox entry to the new manager, it never lingers with the old one);
   *  - `role_holder:super_admin` rows, when `holdsFallbackRole` says the
   *    caller holds that admin role (decided by the CALLER's controller
   *    from `actor.assignments`, never from request input).
   *
   * Oldest first — an inbox is a queue, and the request that has waited
   * longest is the one an approver should see first.
   */
  async listPendingForApprover(
    approverUserId: string,
    holdsFallbackRole: boolean,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<AccessRequestWithContext[]> {
    const managerArm = and(
      eq(accessRequests.approverResolver, 'manager_of_subject'),
      eq(users.managerId, approverUserId),
    )
    const arms = holdsFallbackRole
      ? or(managerArm, eq(accessRequests.approverResolver, 'role_holder:super_admin'))
      : managerArm

    return db
      .select({ ...getTableColumns(accessRequests), ...CONTEXT_COLUMNS })
      .from(accessRequests)
      .innerJoin(businessRoles, eq(accessRequests.businessRoleId, businessRoles.id))
      .innerJoin(users, eq(accessRequests.subjectUserId, users.id))
      .where(and(eq(accessRequests.state, 'pending'), arms))
      .orderBy(asc(accessRequests.createdAt))
  }

  /**
   * THE state machine. The single write that changes `state`, and it only
   * ever moves `pending` → terminal: the `state = 'pending'` predicate in
   * the WHERE clause is the enforcement, not a fast path — a request that
   * is already approved/denied/cancelled matches no row, and the caller
   * gets a 409 naming the actual state rather than a silent double-decide.
   * Atomic under concurrency by construction: two racing deciders each run
   * this UPDATE, exactly one matches, the other conflicts.
   *
   * Every terminal state records who moved it there and when — including
   * `cancelled` (the requester themselves), which is what keeps the
   * `access_requests_decision_shape` CHECK simple and every ended request
   * accountable.
   */
  async transition(
    db: NodePgDatabase<typeof schema>,
    id: string,
    to: TerminalAccessRequestState,
    decision: { decidedBy: string; decidedAt: Date; decisionComment: string | null },
  ): Promise<AccessRequestRow> {
    const [row] = await db
      .update(accessRequests)
      .set({ state: to, ...decision, updatedAt: decision.decidedAt })
      .where(and(eq(accessRequests.id, id), eq(accessRequests.state, 'pending')))
      .returning()

    if (row !== undefined) return row

    const existing = await this.findById(id, db)
    if (existing === null) throw new NotFoundError('access request', id)
    throw new ConflictError(
      `this access request is already ${existing.state} — a decided or cancelled request never changes again`,
    )
  }
}
