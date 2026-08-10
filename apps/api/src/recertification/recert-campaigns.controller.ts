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
import { inArray } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { AuditWriter } from '../audit/audit.writer'
import { JwtGuard } from '../auth/jwt.guard'
import { PermissionEngine } from '../authz/permission.engine'
import { PermissionGuard, type AuthorizedRequest } from '../authz/permission.guard'
import { RequirePermission } from '../authz/require-permission.decorator'
import {
  type BusinessRoleExceptionRow,
  BusinessRolesRepository,
} from '../business-roles/business-roles.repository'
import { type EvaluableRole, evaluateRoles } from '../business-roles/role-evaluator'
import { DB_CLIENT } from '../common/db.token'
import { ConflictError, ForbiddenError, NotFoundError } from '../common/errors'
import { parseBody } from '../common/http/parse-body'
import { parseId } from '../common/http/parse-id'
import { noNulChar } from '../common/http/safe-string'
import * as schema from '../db/schema/index'
import { recertItems } from '../db/schema/recert-items'
import { users } from '../db/schema/users'
import {
  type CampaignWithProgress,
  type RecertCampaignRow,
  type RecertItemRow,
  RecertRepository,
} from './recert.repository'

/**
 * Same page size, same "internal batch size, never a client-facing limit"
 * posture as BusinessRolesController's own simulation walk — the open-time
 * snapshot walks the whole directory a page at a time.
 */
const PAGE_SIZE = 200

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)')

/**
 * `reviewerStrategy` is z.enum over the SAME closed vocabulary the pgEnum
 * holds — data, never code: the value is stored and interpreted at open
 * time by `resolveReviewer`'s allowlisted dispatch, exactly as JML stores
 * its triggers. `scopeRoleIds` is either a non-empty uuid list or null
 * ("every enabled role at open time"); an EMPTY list is a 400, not a
 * campaign that silently reviews nothing.
 */
const createBodySchema = z
  .object({
    name: noNulChar(z.string().min(1).max(255)),
    scopeRoleIds: z.array(z.string().uuid()).min(1).nullable().default(null),
    reviewerStrategy: z.enum(['manager_of_subject', 'role_owner']),
    dueDate: isoDateSchema.nullable().default(null),
  })
  .strict()

function snapshotCampaign(campaign: RecertCampaignRow): Record<string, unknown> {
  return {
    id: campaign.id,
    name: campaign.name,
    scopeRoleIds: campaign.scopeRoleIds,
    reviewerStrategy: campaign.reviewerStrategy,
    status: campaign.status,
    dueDate: campaign.dueDate,
    openedAt: campaign.openedAt?.toISOString() ?? null,
    closedAt: campaign.closedAt?.toISOString() ?? null,
  }
}

/** An item as the campaign detail reports it — the row plus the names the console needs to render words, not uuids. */
export interface CampaignItemView extends RecertItemRow {
  businessRoleName: string
  subject: { id: string; username: string; displayName: string } | null
  reviewer: { id: string; username: string; displayName: string } | null
}

export interface CampaignDetail extends CampaignWithProgress {
  items: CampaignItemView[]
}

/**
 * The operator surface for access-recertification campaigns: create a
 * draft, OPEN it (which snapshots the review set), close it, and read
 * progress. The reviewer surface — "my pending items", "decide" — lives on
 * `RecertReviewsController`, deliberately apart: reviewers are ordinary
 * managers holding no role in the catalog, while everything mutating here
 * is `recert:manage`, GLOBAL GRANT ONLY, on exactly the terms
 * BusinessRolesController's own doc comment establishes (finding
 * AUTHZ-M-2): a campaign belongs to no org unit and its review set spans
 * the whole directory, so a scoped grant has nothing to narrow to.
 *
 * NO SCHEDULER. A campaign is opened by an operator (or a CLI wrapping
 * this same code path), never by an in-process cron thread — the repo's
 * standing rule, the same one that keeps jml:lifecycle and the reconcile
 * sweeps on-demand.
 *
 * TRANSACTION DISCIPLINE: each mutation, its item writes and its audit row
 * commit on ONE `tx`; every repository call inside takes that `tx`
 * explicitly (finding C1, test/pool-exhaustion.spec.ts). The open-time
 * directory walk runs on the SAME `tx` — unlike the simulation walk, which
 * is a read-only preview, the snapshot must be consistent with the
 * transition it commits with: a membership changing mid-open must not
 * produce a review set that never matched any single moment.
 */
@Controller('recert-campaigns')
@UseGuards(JwtGuard, PermissionGuard)
export class RecertCampaignsController {
  constructor(
    @Inject(RecertRepository) private readonly campaigns: RecertRepository,
    @Inject(BusinessRolesRepository) private readonly roles: BusinessRolesRepository,
    @Inject(PermissionEngine) private readonly engine: PermissionEngine,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /** Verbatim the idiom BusinessRolesController.requireGlobalManageGrant documents — see that comment for the full AUTHZ-M-2 story. */
  private async requireGlobalManageGrant(request: AuthorizedRequest): Promise<void> {
    const scopePaths = await this.engine.scopePathsFor(request.actor, 'recert:manage')
    if (scopePaths !== null) {
      throw new ForbiddenError(
        'managing a recertification campaign requires a global grant of recert:manage — ' +
          'a campaign belongs to no org unit and its review set spans the whole directory',
      )
    }
  }

  @Get()
  @RequirePermission('recert:read')
  async list(): Promise<CampaignWithProgress[]> {
    return this.campaigns.list()
  }

  /**
   * A new campaign is a DRAFT by construction — the status column defaults
   * `draft` and this route exposes no way to override it, so creating one
   * can never, by itself, put an item in front of any reviewer. That takes
   * the separately-audited open below.
   */
  @Post()
  @RequirePermission('recert:manage')
  async create(@Body() body: unknown, @Req() request: AuthorizedRequest): Promise<RecertCampaignRow> {
    await this.requireGlobalManageGrant(request)
    const parsed = parseBody(createBodySchema, body)

    return this.db.transaction(async (tx) => {
      const campaign = await this.campaigns.create(
        {
          name: parsed.name,
          scopeRoleIds: parsed.scopeRoleIds ?? null,
          reviewerStrategy: parsed.reviewerStrategy,
          dueDate: parsed.dueDate ?? null,
          createdBy: request.actor.userId,
        },
        tx,
      )

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'recert_campaign:create',
        resourceType: 'recert_campaign',
        resourceId: campaign.id,
        before: null,
        after: snapshotCampaign(campaign),
      })

      return campaign
    })
  }

  @Get(':id')
  @RequirePermission('recert:read')
  async findOne(@Param('id') rawId: string): Promise<CampaignDetail> {
    const id = parseId(rawId)
    const campaign = await this.campaigns.findById(id)
    if (campaign === null) throw new NotFoundError('recertification campaign', id)

    const items = await this.campaigns.listItems(id)
    const context = await this.campaigns.displayContext(
      this.db,
      [...new Set(items.map((item) => item.businessRoleId))],
      [
        ...new Set(
          items.flatMap((item) =>
            [item.subjectUserId, item.reviewerUserId].filter((value): value is string => value !== null),
          ),
        ),
      ],
    )

    const person = (userId: string | null) => {
      if (userId === null) return null
      const found = context.userNames.get(userId)
      return found === undefined ? null : { id: userId, ...found }
    }

    return {
      ...campaign,
      items: items.map((item) => ({
        ...item,
        businessRoleName: context.roleNames.get(item.businessRoleId) ?? item.businessRoleId,
        subject: person(item.subjectUserId),
        reviewer: person(item.reviewerUserId),
      })),
    }
  }

  /**
   * THE snapshot. Opening walks the current provenance-carrying state and
   * freezes it into `recert_items`, in the SAME transaction as the
   * draft→open transition, honouring the asymmetry the business-roles code
   * comments already promise a campaign will honour:
   *
   *  - FORMULA-derived membership is reviewed PER ROLE. The evaluator runs
   *    over every user in the organization with each role's exceptions
   *    STRIPPED, so `memberCount` is precisely "how many people the
   *    formula holds" — one decision covers the formula. Reviewing derived
   *    members one by one would be attesting a computation row by row; the
   *    formula grants, so the formula is what gets reviewed.
   *  - INCLUDE-exceptions are reviewed PER PERSON, straight from
   *    `business_role_exceptions` — each unexpired `include` becomes one
   *    item carrying its MANDATORY reason (NOT NULL exactly so this line
   *    of code could exist) for the reviewer to read. An expired exception
   *    is absent (the evaluator already treats it so — there is no
   *    standing access left to review), and an `exclude` grants nothing,
   *    so neither produces an item.
   *
   * ENABLED roles only: a disabled role's rows have left the reconciler's
   * desired set and are revoked on its next pass — there is no standing
   * access left to certify. A scoped id naming a disabled role simply
   * contributes no items; a scoped id naming NO role in this organization
   * is a 404 (a role in another tenant reports exactly like a nonexistent
   * one — no cross-tenant existence oracle).
   *
   * An UNEVALUABLE role refuses the whole open, exactly as it refuses a
   * simulation: a member count the engine had to guess at is not a number
   * a reviewer can attest to.
   */
  @Post(':id/open')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('recert:manage')
  async open(@Param('id') rawId: string, @Req() request: AuthorizedRequest): Promise<CampaignDetail> {
    await this.requireGlobalManageGrant(request)
    const id = parseId(rawId)
    const now = new Date()

    await this.db.transaction(async (tx) => {
      const campaign = await this.campaigns.lockForTransition(tx, id, 'open')

      // Scope resolution + validation.
      const enabledRoles = await this.roles.listEnabledForEvaluation(campaign.organizationId, tx)
      let scoped = enabledRoles
      if (campaign.scopeRoleIds !== null) {
        const existing = await this.campaigns.existingRoleIds(
          tx,
          campaign.organizationId,
          campaign.scopeRoleIds,
        )
        const missing = campaign.scopeRoleIds.find((roleId) => !existing.has(roleId))
        if (missing !== undefined) throw new NotFoundError('business role', missing)
        const scopeSet = new Set(campaign.scopeRoleIds)
        scoped = enabledRoles.filter((role) => scopeSet.has(role.id))
      }

      // Formula member counts — exceptions stripped, see the route comment.
      const formulaRoles: EvaluableRole[] = scoped.map((role) => ({
        id: role.id,
        name: role.name,
        conditions: role.conditions,
        grants: role.grants,
        exceptions: [],
      }))
      const memberCounts = new Map<string, number>(scoped.map((role) => [role.id, 0]))
      let offset = 0
      for (;;) {
        const page = await this.roles.listEvaluableUsers(
          tx,
          { limit: PAGE_SIZE, offset },
          campaign.organizationId,
        )
        if (page.length === 0) break
        for (const user of page) {
          const evaluation = evaluateRoles(user, formulaRoles, now)
          if (!evaluation.evaluable) {
            throw new ConflictError(
              `the campaign was not opened: role "${evaluation.roleName}" (${evaluation.roleId}) ` +
                `is unevaluable — ${evaluation.reason}. A member count the engine guessed at is not ` +
                'a number a reviewer can attest to.',
            )
          }
          for (const roleId of evaluation.matchedRoleIds) {
            memberCounts.set(roleId, (memberCounts.get(roleId) ?? 0) + 1)
          }
        }
        if (page.length < PAGE_SIZE) break
        offset += PAGE_SIZE
      }

      // The unexpired include-exceptions under review, per person.
      const includeExceptions = scoped.flatMap((role) =>
        role.exceptions
          .filter(
            // Live under the evaluator's own boundary (`isLive`,
            // role-evaluator.ts): an exception is live until its expiry
            // has PASSED, so `>= now` — a campaign must review exactly
            // the access the engine currently honours, no more, no less.
            (exception): exception is BusinessRoleExceptionRow =>
              exception.mode === 'include' &&
              (exception.expiresAt === null || exception.expiresAt.getTime() >= now.getTime()),
          )
          .map((exception) => ({ role, exception })),
      )

      const managers = await this.managersFor(
        tx,
        includeExceptions.map(({ exception }) => exception.userId),
      )

      const itemRows: (typeof recertItems.$inferInsert)[] = [
        ...scoped.map((role) => ({
          campaignId: campaign.id,
          organizationId: campaign.organizationId,
          businessRoleId: role.id,
          itemKind: 'role_formula' as const,
          memberCount: memberCounts.get(role.id) ?? 0,
          // A formula item has no subject, so `manager_of_subject` has
          // nothing to resolve against; under both strategies it goes to
          // the campaign's creator — the operator accountable for the
          // campaign (and, until business_roles grows an owner column,
          // for its roles; see recert-campaigns.ts's enum comment).
          reviewerUserId: campaign.createdBy,
        })),
        ...includeExceptions.map(({ role, exception }) => ({
          campaignId: campaign.id,
          organizationId: campaign.organizationId,
          businessRoleId: role.id,
          itemKind: 'include_exception' as const,
          subjectUserId: exception.userId,
          exceptionReason: exception.reason,
          exceptionExpiresAt: exception.expiresAt,
          reviewerUserId: this.resolveReviewer(
            campaign,
            exception.userId,
            managers.get(exception.userId) ?? null,
          ),
        })),
      ]

      await this.campaigns.insertItems(tx, itemRows)
      const opened = await this.campaigns.markOpened(tx, id, now)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'recert_campaign:open',
        resourceType: 'recert_campaign',
        resourceId: id,
        before: snapshotCampaign(campaign),
        after: {
          ...snapshotCampaign(opened),
          itemsTotal: itemRows.length,
          formulaItems: scoped.length,
          exceptionItems: includeExceptions.length,
        },
      })
    })

    return this.findOne(id)
  }

  /**
   * NOBODY REVIEWS THEIR OWN ACCESS — the snapshot half of the rule
   * (`RecertReviewsController.decide` enforces the other half at decision
   * time). The resolution chain per strategy, skipping any candidate who
   * IS the subject:
   *
   *  - `manager_of_subject`: the subject's manager, else the campaign's
   *    creator.
   *  - `role_owner`: the campaign's creator (business_roles carries no
   *    owner column — see recert-campaigns.ts's enum comment), else the
   *    subject's manager.
   *
   * If every candidate is the subject themselves (the creator certifying
   * their own include-exception, with no manager recorded), the open
   * REFUSES rather than quietly assigning a self-review — a 409 naming
   * what to fix.
   */
  private resolveReviewer(
    campaign: RecertCampaignRow,
    subjectUserId: string,
    managerId: string | null,
  ): string {
    const chain =
      campaign.reviewerStrategy === 'manager_of_subject'
        ? [managerId, campaign.createdBy]
        : [campaign.createdBy, managerId]
    const reviewer = chain.find((candidate) => candidate !== null && candidate !== subjectUserId)
    if (reviewer === undefined || reviewer === null) {
      throw new ConflictError(
        'the campaign was not opened: an include-exception subject has no resolvable reviewer ' +
          'other than themselves — nobody reviews their own access. Record a manager for the ' +
          'person, or open the campaign as a different operator.',
      )
    }
    return reviewer
  }

  private async managersFor(
    tx: NodePgDatabase<typeof schema>,
    userIds: string[],
  ): Promise<Map<string, string | null>> {
    if (userIds.length === 0) return new Map()
    const rows = await tx
      .select({ id: users.id, managerId: users.managerId })
      .from(users)
      .where(inArray(users.id, [...new Set(userIds)]))
    return new Map(rows.map((row) => [row.id, row.managerId]))
  }

  /**
   * open → closed, terminal. Undecided items stay `pending` forever — an
   * honest record that the review never happened — and leave every
   * reviewer's queue, because the queue filters on OPEN campaigns.
   */
  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('recert:manage')
  async close(
    @Param('id') rawId: string,
    @Req() request: AuthorizedRequest,
  ): Promise<CampaignWithProgress> {
    await this.requireGlobalManageGrant(request)
    const id = parseId(rawId)
    const now = new Date()

    await this.db.transaction(async (tx) => {
      const campaign = await this.campaigns.lockForTransition(tx, id, 'closed')
      const closed = await this.campaigns.markClosed(tx, id, now)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'recert_campaign:close',
        resourceType: 'recert_campaign',
        resourceId: id,
        before: snapshotCampaign(campaign),
        after: snapshotCampaign(closed),
      })
    })

    const closed = await this.campaigns.findById(id)
    if (closed === null) throw new NotFoundError('recertification campaign', id)
    return closed
  }
}
