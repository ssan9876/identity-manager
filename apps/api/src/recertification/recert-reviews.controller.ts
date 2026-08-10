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
import { and, eq } from 'drizzle-orm'
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
import { businessRoleExceptions } from '../db/schema/business-roles'
import * as schema from '../db/schema/index'
import { type RecertItemRow, RecertRepository } from './recert.repository'

/**
 * `pending` is not offered: a decision route that could write "pending"
 * would be an un-decide, and decided states are final. `comment` is
 * optional on `certified` and on a formula finding, but the schema cannot
 * express "required when revoking an exception" cleanly, so that stays a
 * reviewer's judgement — the item's `exception_reason` already carries the
 * justification under review.
 */
const decideBodySchema = z
  .object({
    decision: z.enum(['certified', 'revoked_requested']),
    comment: noNulChar(z.string().min(1).max(2000)).nullable().default(null),
  })
  .strict()

function snapshotItem(item: RecertItemRow): Record<string, unknown> {
  return {
    id: item.id,
    campaignId: item.campaignId,
    businessRoleId: item.businessRoleId,
    itemKind: item.itemKind,
    subjectUserId: item.subjectUserId,
    memberCount: item.memberCount,
    exceptionReason: item.exceptionReason,
    reviewerUserId: item.reviewerUserId,
    decision: item.decision,
    decidedBy: item.decidedBy,
    decidedAt: item.decidedAt?.toISOString() ?? null,
    comment: item.comment,
  }
}

/** One row of the reviewer's queue, with every id resolved to words. */
export interface MyReviewItem extends RecertItemRow {
  campaign: { id: string; name: string; dueDate: string | null }
  businessRoleName: string
  subject: { id: string; username: string; displayName: string } | null
}

/**
 * What a decision DID, stated in the response so the console's toast can
 * state a consequence rather than a success:
 *  - `attested` — certified; an audit row records the attestation and
 *    nothing else moved.
 *  - `exception_expired` — the include-exception was expired via the
 *    business-roles repository and the reconciler revoked what it had
 *    granted, in this same transaction.
 *  - `exception_already_absent` — the exception was removed or expired
 *    after the snapshot was taken; the finding is recorded and there was
 *    nothing left to expire.
 *  - `finding_recorded` — a formula-derived grant was flagged. The
 *    campaign performs NO revocation: edit the role's draft, simulate,
 *    and publish — the path where the change is previewed before anyone
 *    loses access.
 */
export type DecisionEffect =
  | 'attested'
  | 'exception_expired'
  | 'exception_already_absent'
  | 'finding_recorded'

/**
 * The REVIEWER surface: my pending items, and the decision on one item.
 *
 * AUTHENTICATION-ONLY, like `SelfServiceController` and for its exact
 * reason (registered beside it in guard-coverage.spec.ts's
 * AUTHENTICATION_ONLY): a campaign's resolved reviewers are ordinary
 * managers who legitimately hold NO role in the catalog, and gating this
 * controller behind `PermissionGuard`/`@RequirePermission` would lock
 * every one of them out of the queue that was just assigned to them.
 * Authorization is IDENTITY-based instead, per item, in `decide`:
 *
 *  1. the caller is resolved exclusively from the verified JWT principal
 *     (`PermissionEngine.resolveActor` — active local user required,
 *     fresh on every request, never cached);
 *  2. NOBODY REVIEWS THEIR OWN ACCESS — checked FIRST, before the
 *     reviewer/admin test, so a super_admin who is the subject of an
 *     include-exception item is refused like anyone else;
 *  3. the caller must BE the item's resolved reviewer, or hold a GLOBAL
 *     `recert:manage` grant (the same `scopePathsFor(...) === null` idiom
 *     as every global-infrastructure route).
 *
 * `GET /recert/my-reviews` needs no per-item check at all: it is filtered
 * to `reviewer_user_id = caller` in SQL, so like `GET /self` there is no
 * id anywhere for a caller to tamper with.
 */
@Controller('recert')
@UseGuards(JwtGuard)
export class RecertReviewsController {
  constructor(
    @Inject(RecertRepository) private readonly campaigns: RecertRepository,
    @Inject(BusinessRolesRepository) private readonly roles: BusinessRolesRepository,
    @Inject(RoleReconciler) private readonly reconciler: RoleReconciler,
    @Inject(PermissionEngine) private readonly engine: PermissionEngine,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  private async resolveCaller(request: AuthenticatedRequest): Promise<Actor> {
    return this.engine.resolveActor(request.principal)
  }

  /** My pending items on open campaigns — the queue certify/revoke works from. */
  @Get('my-reviews')
  async myReviews(@Req() request: AuthenticatedRequest): Promise<MyReviewItem[]> {
    const actor = await this.resolveCaller(request)
    const rows = await this.campaigns.listPendingForReviewer(actor.userId)

    const context = await this.campaigns.displayContext(
      this.db,
      [...new Set(rows.map((row) => row.businessRoleId))],
      [...new Set(rows.flatMap((row) => (row.subjectUserId === null ? [] : [row.subjectUserId])))],
    )

    return rows.map((row) => {
      const { campaign, ...item } = row
      const subject = item.subjectUserId === null ? undefined : context.userNames.get(item.subjectUserId)
      return {
        ...item,
        campaign: { id: campaign.id, name: campaign.name, dueDate: campaign.dueDate },
        businessRoleName: context.roleNames.get(item.businessRoleId) ?? item.businessRoleId,
        subject:
          item.subjectUserId === null || subject === undefined
            ? null
            : { id: item.subjectUserId, ...subject },
      }
    })
  }

  /**
   * One decision, final, in ONE transaction with every one of its effects
   * and audit rows.
   *
   * `certified` records the attestation and touches NOTHING else — no
   * membership, no exception, no outbox event beyond the audit row.
   *
   * `revoked_requested` on an INCLUDE-EXCEPTION item expires that
   * exception through the existing business-roles repository path
   * (`upsertException` with `expiresAt = now`) and re-runs
   * `RoleReconciler.reconcileUser` for the subject inside this same
   * transaction — so the reconciler, the one writer that only ever
   * revokes what it granted, performs the actual revocation. Group
   * membership is NEVER written directly here, and a hand-added `manual`
   * membership survives untouched, exactly as it survives every other
   * pass. A reconciler refusal (an unevaluable role) rolls the WHOLE
   * decision back — a 409, not a decision recorded against an effect that
   * did not happen.
   *
   * `revoked_requested` on a ROLE_FORMULA item performs NO revocation at
   * all. It records the finding and the response points the operator at
   * the role's own draft → simulate → publish path — because an engine
   * that quietly strips access off the back of one click is this
   * codebase's explicitly rejected failure mode (the evaluator's
   * refuse-to-act note; the disable-is-a-revocation console warning). The
   * formula is the thing that grants, so the formula is the thing an
   * operator must change, with the simulation's diff in front of them.
   */
  @Post('items/:id/decide')
  @HttpCode(HttpStatus.OK)
  async decide(
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ item: RecertItemRow; effect: DecisionEffect }> {
    const actor = await this.resolveCaller(request)
    const id = parseId(rawId)
    const parsed = parseBody(decideBodySchema, body)
    const now = new Date()

    return this.db.transaction(async (tx) => {
      const item = await this.campaigns.findItemById(id, tx)
      if (item === null) throw new NotFoundError('recertification item', id)

      // Order matters, and it is the same reveal-least order the role
      // grant routes document: the self-review rule is absolute (an admin
      // who IS the subject is refused before their adminhood is even
      // consulted), then reviewer-or-admin, then the state checks.
      if (item.subjectUserId !== null && item.subjectUserId === actor.userId) {
        throw new ForbiddenError(
          'nobody reviews their own access — this item is about you, so it must be decided ' +
            'by its assigned reviewer or another administrator',
        )
      }
      if (item.reviewerUserId !== actor.userId) {
        const scopePaths = await this.engine.scopePathsFor(actor, 'recert:manage')
        if (scopePaths !== null) {
          throw new ForbiddenError(
            'only this item’s resolved reviewer, or a holder of a global recert:manage ' +
              'grant, may decide it',
          )
        }
      }

      const campaign = await this.campaigns.findById(item.campaignId, tx)
      if (campaign === null) throw new NotFoundError('recertification campaign', item.campaignId)
      if (campaign.status !== 'open') {
        throw new ConflictError(`this campaign is ${campaign.status} — only an open campaign accepts decisions`)
      }

      const decided = await this.campaigns.decideItem(
        tx,
        id,
        { decision: parsed.decision, decidedBy: actor.userId, comment: parsed.comment ?? null },
        now,
      )
      // The UPDATE is guarded on decision = 'pending', so a lost race —
      // or a plain re-submit — reports as "already decided", never as a
      // silent overwrite of somebody else's decision.
      if (decided === null) {
        throw new ConflictError('this item has already been decided — decisions are final')
      }

      await this.auditWriter.record(tx, {
        actorUserId: actor.userId,
        action: 'recert_item:decide',
        resourceType: 'recert_item',
        resourceId: id,
        before: snapshotItem(item),
        after: snapshotItem(decided),
      })

      if (parsed.decision === 'certified' || item.itemKind === 'role_formula') {
        return {
          item: decided,
          effect: parsed.decision === 'certified' ? ('attested' as const) : ('finding_recorded' as const),
        }
      }

      // revoked_requested on an include_exception: expire the exception.
      const effect = await this.expireException(tx, decided, actor.userId, now)
      return { item: decided, effect }
    })
  }

  /**
   * The revocation path, and everything about it goes through code that
   * already exists: the CURRENT exception row is read (not the snapshot —
   * it may have been edited since the campaign opened), expired via
   * `BusinessRolesRepository.upsertException` preserving its mode, reason
   * and original granter, audited with the SAME action and snapshot shape
   * `BusinessRolesController.addException` writes, and the subject is
   * re-reconciled on this same `tx` so the revocation commits with the
   * decision or not at all.
   */
  private async expireException(
    tx: Parameters<Parameters<NodePgDatabase<typeof schema>['transaction']>[0]>[0],
    item: RecertItemRow,
    actorUserId: string,
    now: Date,
  ): Promise<DecisionEffect> {
    if (item.subjectUserId === null) {
      // Unreachable: the CHECK constraint makes include_exception imply a
      // subject. Guarded anyway so a future schema change fails loudly.
      throw new ConflictError('an include-exception item has no subject to revoke')
    }

    const [current] = await tx
      .select()
      .from(businessRoleExceptions)
      .where(
        and(
          eq(businessRoleExceptions.businessRoleId, item.businessRoleId),
          eq(businessRoleExceptions.userId, item.subjectUserId),
        ),
      )

    // Removed or already expired since the snapshot: the access this item
    // reviewed is already gone (or going on the next pass). The decision
    // stands as a finding; there is nothing left to expire. `< now` (not
    // `<= now`) mirrors the evaluator's own boundary — an exception is
    // live until its expiry has PASSED (`isLive`, role-evaluator.ts).
    if (current === undefined || (current.expiresAt !== null && current.expiresAt.getTime() < now.getTime())) {
      return 'exception_already_absent'
    }

    const { row, previous } = await this.roles.upsertException(tx, {
      businessRoleId: item.businessRoleId,
      userId: item.subjectUserId,
      mode: current.mode,
      reason: current.reason,
      // One millisecond BEFORE `now`, not `now` itself: the evaluator's
      // `isLive` keeps an exception live while `expiresAt >= now`, and the
      // reconcile below runs with this very same `now` — an expiry AT the
      // boundary would still be live for it, and the revocation this
      // decision exists to trigger would silently not happen until some
      // later pass.
      expiresAt: new Date(now.getTime() - 1),
      grantedBy: current.grantedBy,
    })

    await this.auditWriter.record(tx, {
      actorUserId,
      action: 'business_role:exception_set',
      resourceType: 'business_role',
      resourceId: item.businessRoleId,
      before:
        previous === null
          ? null
          : {
              userId: previous.userId,
              mode: previous.mode,
              reason: previous.reason,
              expiresAt: previous.expiresAt?.toISOString() ?? null,
            },
      after: {
        userId: row.userId,
        mode: row.mode,
        reason: row.reason,
        expiresAt: row.expiresAt?.toISOString() ?? null,
      },
    })

    const outcome = await this.reconciler.reconcileUser(tx, item.subjectUserId, actorUserId, now)
    if (outcome.status === 'refused') {
      throw new ConflictError(
        `the revocation was not applied: role "${outcome.roleName}" (${outcome.roleId}) is ` +
          `unevaluable — ${outcome.reason}. The decision was rolled back with it; nothing was recorded.`,
      )
    }

    return 'exception_expired'
  }
}
