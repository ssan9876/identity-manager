import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { AuditWriter } from '../audit/audit.writer'
import { type AuthenticatedRequest, JwtGuard } from '../auth/jwt.guard'
import { type Actor, PermissionEngine } from '../authz/permission.engine'
import { BusinessRolesRepository } from '../business-roles/business-roles.repository'
import { RoleReconciler } from '../business-roles/role-reconciler'
import { DB_CLIENT } from '../common/db.token'
import { ConflictError, ForbiddenError, NotFoundError } from '../common/errors'
import { parseBody } from '../common/http/parse-body'
import { parseId } from '../common/http/parse-id'
import { noNulChar } from '../common/http/safe-string'
import * as schema from '../db/schema/index'
import { type User, UsersRepository } from '../users/users.repository'
import {
  type AccessRequestRow,
  type AccessRequestWithContext,
  AccessRequestsRepository,
} from './access-requests.repository'
import { FALLBACK_APPROVER_ROLE, resolverForSubject } from './approver-resolver'

/**
 * `justification` is REQUIRED and non-empty for the same reason
 * `business_role_exceptions.reason` is NOT NULL: on approval this text (with
 * the request id) BECOMES that exception's mandatory reason, and an
 * unexplained grant is what a later recertification campaign cannot act on.
 * `noNulChar` on every free-text field, per finding INJ-H-2.
 *
 * `.strict()` is load-bearing exactly as on `selfUpdateBodySchema`: there is
 * deliberately NO `requesterUserId`/`subjectUserId` field here — the caller
 * IS the requester and the subject, resolved from the verified JWT principal
 * and from nowhere else — and `.strict()` turns an attempt to smuggle one in
 * into a 400 naming the field, never a silently-ignored extra property.
 *
 * `requestedExpiresAt` is an ISO-8601 instant, not a date, matching
 * `exceptionBodySchema` (business-roles.controller.ts) — it becomes that
 * exception's `expires_at` verbatim on approval.
 */
const createRequestBodySchema = z
  .object({
    businessRoleId: z.string().uuid(),
    justification: noNulChar(z.string().min(1).max(2000)),
    requestedExpiresAt: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict()

/** Approve/deny both take the same optional free-text comment. */
const decisionBodySchema = z
  .object({
    comment: noNulChar(z.string().min(1).max(2000)).nullable().default(null),
  })
  .strict()

function snapshotRequest(row: AccessRequestRow): Record<string, unknown> {
  return {
    id: row.id,
    requesterUserId: row.requesterUserId,
    subjectUserId: row.subjectUserId,
    businessRoleId: row.businessRoleId,
    justification: row.justification,
    state: row.state,
    approverResolver: row.approverResolver,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionComment: row.decisionComment,
    requestedExpiresAt: row.requestedExpiresAt?.toISOString() ?? null,
  }
}

/**
 * The self-service access-request catalogue: browse requestable roles, ask
 * for one with a justification, cancel your own pending ask — and, for the
 * resolved approver, an inbox with one-click approve/deny.
 *
 * AUTHENTICATION-ONLY, like `SelfServiceController` and for the same
 * reason (registered in guard-coverage.spec.ts's `AUTHENTICATION_ONLY`): an
 * ordinary employee holds no admin role and no permission grant, yet
 * requesting access and deciding a direct report's request are exactly
 * their jobs. Authorization is therefore per-route, in the handler, from
 * facts the server itself resolves:
 *
 *  - the REQUESTER is always the authenticated caller — no route accepts a
 *    requester/subject id anywhere (body schemas are `.strict()`; the only
 *    `:id` path parameter names a REQUEST, never a person);
 *  - CANCEL requires being that request's own requester, and only while
 *    pending;
 *  - DECIDE requires being the request's resolved approver (the stored
 *    resolver, re-resolved fresh — see `assertMayDecide`) OR holding a
 *    GLOBAL `business_role:manage` grant, the exact authority that may
 *    already write the include exception an approval produces
 *    (BusinessRolesController.requireGlobalManageGrant, finding AUTHZ-M-2);
 *  - NOBODY decides their own request — checked before either of the above,
 *    so not even a global admin can approve what they themselves asked for.
 *
 * APPROVAL'S EFFECT is a business-role INCLUDE EXCEPTION written through
 * `BusinessRolesRepository.upsertException` — the one existing exception
 * path — with the request id + justification as the exception's mandatory
 * reason and the requested expiry as its expiry, then the subject
 * re-reconciled inside the SAME transaction (`RoleReconciler.reconcileUser`,
 * exactly as `BusinessRolesController.addException` does). It deliberately
 * does NOT write a group membership: the grant carries provenance ("why
 * does this person have this?" answers with the request), it expires with
 * the exception, and a future recertification campaign can act on it.
 * There is no second imperative grant path.
 *
 * Every mutation writes its audit row in the same transaction. There is no
 * delete route — requests end in a terminal state, they are never removed.
 * Offboarding/deactivation paths have NO dependency on any of this: nothing
 * here is called from user status changes, JML, or the reconciler's sweeps.
 */
@Controller('access-requests')
@UseGuards(JwtGuard)
export class AccessRequestsController {
  constructor(
    @Inject(AccessRequestsRepository) private readonly requests: AccessRequestsRepository,
    @Inject(BusinessRolesRepository) private readonly roles: BusinessRolesRepository,
    @Inject(RoleReconciler) private readonly reconciler: RoleReconciler,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(PermissionEngine) private readonly engine: PermissionEngine,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /** The caller, resolved exclusively from the verified JWT principal — `SelfServiceController.resolveCaller`'s contract, verbatim. */
  private async resolveCaller(request: AuthenticatedRequest): Promise<Actor> {
    return this.engine.resolveActor(request.principal)
  }

  private async requireCallerUser(
    actor: Actor,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<User> {
    const user = await this.users.findById(actor.userId, db)
    if (user === null) {
      // Defensive only — resolveActor just found this row and users are
      // never deleted (same posture as SelfServiceController.me).
      throw new NotFoundError('user', actor.userId)
    }
    return user
  }

  /** Does the caller hold the fallback approver role (`role_holder:super_admin`)? Read off the assignments `resolveActor` already fetched. */
  private holdsFallbackRole(actor: Actor): boolean {
    return actor.assignments.some((assignment) => assignment.roleKey === FALLBACK_APPROVER_ROLE)
  }

  /**
   * The admin path for deciding: a GLOBAL `business_role:manage` grant —
   * deliberately the SAME bar `BusinessRolesController.requireGlobalManageGrant`
   * sets (finding AUTHZ-M-2), because approving a request writes exactly the
   * include exception that authority already controls. An org-unit-scoped
   * manage grant does not qualify, for the reasons that finding states.
   */
  private async holdsGlobalManageGrant(actor: Actor): Promise<boolean> {
    return (await this.engine.scopePathsFor(actor, 'business_role:manage')) === null
  }

  /**
   * The decide gate, in the order the rules demand:
   *
   *  1. NOBODY decides their own request — checked FIRST, unconditionally,
   *     so it cannot be bypassed by any authority below (an admin's own
   *     request still awaits someone else). Both requester and subject are
   *     checked; today they are always equal, but if on-behalf-of ever sets
   *     them apart, neither party should self-approve.
   *  2. The STORED resolver, re-resolved FRESH: `manager_of_subject` asks
   *     "is the caller the subject's manager RIGHT NOW?" (a re-org between
   *     request and decision moves the decision to the new manager);
   *     `role_holder:super_admin` asks whether the caller holds that role.
   *  3. Failing both, a GLOBAL `business_role:manage` grant.
   */
  private async assertMayDecide(
    actor: Actor,
    request: AccessRequestRow,
    tx: NodePgDatabase<typeof schema>,
  ): Promise<void> {
    if (actor.userId === request.requesterUserId || actor.userId === request.subjectUserId) {
      throw new ForbiddenError('you cannot decide your own access request')
    }

    if (request.approverResolver === 'manager_of_subject') {
      const subject = await this.users.findById(request.subjectUserId, tx)
      if (subject !== null && subject.managerId === actor.userId) return
    } else if (this.holdsFallbackRole(actor)) {
      return
    }

    if (await this.holdsGlobalManageGrant(actor)) return

    throw new ForbiddenError(
      'deciding an access request requires being its resolved approver or holding a global grant of business_role:manage',
    )
  }

  /**
   * The catalogue: requestable AND enabled roles in the CALLER's own
   * organization. Browsable by any active employee — a catalogue nobody can
   * see is a catalogue nobody can request from.
   */
  @Get('catalogue')
  async catalogue(@Req() request: AuthenticatedRequest) {
    const actor = await this.resolveCaller(request)
    const caller = await this.requireCallerUser(actor)
    const roles = await this.requests.listRequestable(caller.organizationId)
    return { roles }
  }

  /** The caller's own request history — never anyone else's (no id anywhere on this route). */
  @Get('mine')
  async mine(@Req() request: AuthenticatedRequest): Promise<{ requests: AccessRequestWithContext[] }> {
    const actor = await this.resolveCaller(request)
    return { requests: await this.requests.listForRequester(actor.userId) }
  }

  /**
   * The approvals inbox: pending requests whose resolved approver is the
   * caller. An employee who manages nobody and holds no admin role gets
   * `{ requests: [] }` — a normal 200, holding nothing is a valid state.
   */
  @Get('inbox')
  async inbox(@Req() request: AuthenticatedRequest): Promise<{ requests: AccessRequestWithContext[] }> {
    const actor = await this.resolveCaller(request)
    return {
      requests: await this.requests.listPendingForApprover(
        actor.userId,
        this.holdsFallbackRole(actor),
      ),
    }
  }

  /**
   * Ask for a role. The requester AND the subject are the authenticated
   * caller — always, with no way to name anyone else (see the class doc
   * comment). The approver resolver is chosen HERE, from the closed
   * vocabulary, by the subject's data (has a manager or not) — recorded on
   * the row as provenance, then re-resolved fresh at decision time.
   *
   * A role that is not in the caller's catalogue — other tenant's, not
   * requestable, or disabled — is a 404 indistinguishable from a role that
   * does not exist: anything else would let any employee probe which
   * unpublished roles exist (the SEC-L2 existence-oracle posture).
   */
  @Post()
  async create(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const actor = await this.resolveCaller(request)
    const parsed = parseBody(createRequestBodySchema, body)

    return this.db.transaction(async (tx) => {
      const caller = await this.requireCallerUser(actor, tx)

      const role = await this.roles.findById(parsed.businessRoleId, tx)
      if (
        role === null ||
        role.organizationId !== caller.organizationId ||
        !role.requestable ||
        !role.enabled
      ) {
        throw new NotFoundError('requestable business role', parsed.businessRoleId)
      }

      const row = await this.requests.create(tx, {
        organizationId: caller.organizationId,
        requesterUserId: actor.userId,
        subjectUserId: actor.userId,
        businessRoleId: role.id,
        justification: parsed.justification,
        approverResolver: resolverForSubject(caller),
        requestedExpiresAt:
          typeof parsed.requestedExpiresAt === 'string' ? new Date(parsed.requestedExpiresAt) : null,
      })

      await this.auditWriter.record(tx, {
        actorUserId: actor.userId,
        action: 'access_request:create',
        resourceType: 'access_request',
        resourceId: row.id,
        before: null,
        after: snapshotRequest(row),
      })

      return row
    })
  }

  /**
   * Cancel your OWN pending request. Someone else's request — even a real
   * id — is a 404, not a 403: confirming that a guessed id exists is the
   * same existence oracle SEC-L2 closed elsewhere, and the requester is the
   * only party this route serves.
   */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(@Param('id') rawId: string, @Req() request: AuthenticatedRequest) {
    const actor = await this.resolveCaller(request)
    const id = parseId(rawId)
    const now = new Date()

    return this.db.transaction(async (tx) => {
      const existing = await this.requests.findById(id, tx)
      if (existing === null || existing.requesterUserId !== actor.userId) {
        throw new NotFoundError('access request', id)
      }

      const row = await this.requests.transition(tx, id, 'cancelled', {
        decidedBy: actor.userId,
        decidedAt: now,
        decisionComment: null,
      })

      await this.auditWriter.record(tx, {
        actorUserId: actor.userId,
        action: 'access_request:cancel',
        resourceType: 'access_request',
        resourceId: id,
        before: snapshotRequest(existing),
        after: snapshotRequest(row),
      })

      return row
    })
  }

  /**
   * Approve: state → approved AND the include exception written through the
   * ONE existing exception path, then the subject re-reconciled — all in
   * this same transaction, so a grant that cannot apply (an unevaluable
   * role — `reconcileUser` refuses) rolls the approval back too and
   * surfaces as a 409, never a 200 for an approval that silently did
   * nothing. See the class doc comment for why the effect is an exception
   * and not a group membership.
   *
   * The exception's reason is the request id plus the requester's own
   * justification — the provenance that makes "why does this person have
   * this?" answerable and a recertification campaign actionable. Its expiry
   * is the request's requested expiry, so time-boxed asks produce
   * time-boxed access with no separate revocation to remember.
   */
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  async approve(
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const actor = await this.resolveCaller(request)
    const id = parseId(rawId)
    const parsed = parseBody(decisionBodySchema, body ?? {})
    const now = new Date()

    return this.db.transaction(async (tx) => {
      const existing = await this.requests.findById(id, tx)
      if (existing === null) throw new NotFoundError('access request', id)

      await this.assertMayDecide(actor, existing, tx)

      const row = await this.requests.transition(tx, id, 'approved', {
        decidedBy: actor.userId,
        decidedAt: now,
        decisionComment: parsed.comment ?? null,
      })

      const { row: exception } = await this.roles.upsertException(tx, {
        businessRoleId: existing.businessRoleId,
        userId: existing.subjectUserId,
        mode: 'include',
        reason: `access request ${existing.id}: ${existing.justification}`,
        expiresAt: existing.requestedExpiresAt,
        grantedBy: actor.userId,
      })

      await this.auditWriter.record(tx, {
        actorUserId: actor.userId,
        action: 'access_request:approve',
        resourceType: 'access_request',
        resourceId: id,
        before: snapshotRequest(existing),
        after: {
          ...snapshotRequest(row),
          exception: {
            businessRoleId: exception.businessRoleId,
            userId: exception.userId,
            mode: exception.mode,
            reason: exception.reason,
            expiresAt: exception.expiresAt?.toISOString() ?? null,
          },
        },
      })

      const outcome = await this.reconciler.reconcileUser(
        tx,
        existing.subjectUserId,
        actor.userId,
        now,
      )
      if (outcome.status === 'refused') {
        throw new ConflictError(
          `the approval was not applied: role "${outcome.roleName}" (${outcome.roleId}) is unevaluable — ${outcome.reason}`,
        )
      }

      return { ...row, reconciliation: outcome }
    })
  }

  /** Deny: state → denied, with the optional comment. No exception, no reconciliation — nothing was granted. */
  @Post(':id/deny')
  @HttpCode(HttpStatus.OK)
  async deny(
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const actor = await this.resolveCaller(request)
    const id = parseId(rawId)
    const parsed = parseBody(decisionBodySchema, body ?? {})
    const now = new Date()

    return this.db.transaction(async (tx) => {
      const existing = await this.requests.findById(id, tx)
      if (existing === null) throw new NotFoundError('access request', id)

      await this.assertMayDecide(actor, existing, tx)

      const row = await this.requests.transition(tx, id, 'denied', {
        decidedBy: actor.userId,
        decidedAt: now,
        decisionComment: parsed.comment ?? null,
      })

      await this.auditWriter.record(tx, {
        actorUserId: actor.userId,
        action: 'access_request:deny',
        resourceType: 'access_request',
        resourceId: id,
        before: snapshotRequest(existing),
        after: snapshotRequest(row),
      })

      return row
    })
  }
}
