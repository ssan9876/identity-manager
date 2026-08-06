import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { JwtGuard } from '../auth/jwt.guard'
import { AuditWriter } from '../audit/audit.writer'
import { PermissionEngine } from '../authz/permission.engine'
import { PermissionGuard, type AuthorizedRequest } from '../authz/permission.guard'
import { RequirePermission } from '../authz/require-permission.decorator'
import { DB_CLIENT } from '../common/db.token'
import { ForbiddenError, NotFoundError } from '../common/errors'
import { parseBody } from '../common/http/parse-body'
import { parseId } from '../common/http/parse-id'
import { type Page, parsePageQuery } from '../common/pagination'
import { noNulChar } from '../common/http/safe-string'
import * as schema from '../db/schema/index'
import { OutboxWriter } from '../outbox/outbox.writer'
import { OrgUnitsRepository, type OrgUnit } from './org-units.repository'

// noNulChar — see docs/superpowers/audit-injection.md's HIGH "JSON-escaped
// NUL" finding (confirmed live on POST /org-units) and safe-string.ts's own
// doc comment.
const createOrgUnitBodySchema = z
  .object({
    name: noNulChar(z.string().min(1).max(255)),
    parentId: z.string().uuid().optional(),
  })
  .strict()

/**
 * Builds an audit `before`/`after` payload from explicitly named fields —
 * never `{ ...unit }`. Same reasoning as UsersController's snapshotUser: a
 * spread would silently carry forward any column added to `org_units` later
 * into an append-only log a leak can never be removed from.
 */
function snapshotOrgUnit(unit: OrgUnit): Record<string, unknown> {
  return {
    name: unit.name,
    parentId: unit.parentId,
    path: unit.path,
  }
}

@Controller('org-units')
@UseGuards(JwtGuard, PermissionGuard)
export class OrgUnitsController {
  constructor(
    @Inject(OrgUnitsRepository) private readonly orgUnits: OrgUnitsRepository,
    @Inject(PermissionEngine) private readonly engine: PermissionEngine,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(OutboxWriter) private readonly outboxWriter: OutboxWriter,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  @Get()
  @RequirePermission('org_unit:read')
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: AuthorizedRequest,
  ): Promise<Page<OrgUnit>> {
    const page = parsePageQuery(query)
    // null = unrestricted, [] = entitled nowhere — passed through as-is; see
    // UsersController.list and PermissionEngine.scopePathsFor's doc comment.
    const scopePaths = await this.engine.scopePathsFor(request.actor, 'org_unit:read')
    const [items, total] = await Promise.all([
      this.orgUnits.list({ ...page, scopePaths }),
      this.orgUnits.count({ scopePaths }),
    ])
    return { items, total, limit: page.limit, offset: page.offset }
  }

  @Get(':id')
  @RequirePermission('org_unit:read')
  async findOne(@Param('id') rawId: string, @Req() request: AuthorizedRequest): Promise<OrgUnit> {
    const id = parseId(rawId)
    const unit = await this.orgUnits.findById(id)
    if (unit === null) {
      throw new NotFoundError('org unit', id)
    }
    // An org unit IS its own scope target — there is no separate orgUnitId
    // field to check against. Out-of-scope but existing -> 403 (decision 2).
    await this.engine.assertCanIn(request.actor, 'org_unit:read', unit.id)
    return unit
  }

  @Get(':id/subtree')
  @RequirePermission('org_unit:read')
  async subtree(@Param('id') rawId: string, @Req() request: AuthorizedRequest): Promise<OrgUnit[]> {
    const id = parseId(rawId)
    const unit = await this.orgUnits.findById(id)
    if (unit === null) {
      throw new NotFoundError('org unit', id)
    }
    // Checking the requested ROOT is sufficient for the whole subtree: ltree
    // containment is transitive, so every descendant this returns is
    // necessarily also within the actor's scope once the root itself is.
    await this.engine.assertCanIn(request.actor, 'org_unit:read', unit.id)
    return this.orgUnits.findSubtree(id)
  }

  /**
   * A CHILD (`parentId` present) is scoped by the PARENT exactly like every
   * other write in this milestone: `assertCanIn(actor, 'org_unit:create',
   * parentId)` — does this actor's grant cover the org unit the new one
   * would live under?
   *
   * A ROOT (`parentId` omitted) has no parent to scope against, so that
   * pairing does not apply. Per the brief, creating one instead requires a
   * GLOBAL grant of `org_unit:create`. `scopePathsFor` returning exactly
   * `null` IS that check: `null` means every assignment granting this actor
   * `org_unit:create` is unrestricted (see PermissionEngine.scopePathsFor's
   * doc comment); anything else — including `[]` — means every assignment
   * the actor holds for this action is scoped to something, and nothing
   * scoped can authorize a resource that has no containing scope at all.
   * This is intentionally NOT the same rule as GroupsController.create's
   * global-group case: an org-unit root has no "anyone holding the action
   * anywhere may manage it" counterpart (decision 1) to be consistent with,
   * so there is nothing inconsistent about gating it more tightly.
   */
  @Post()
  @RequirePermission('org_unit:create')
  async create(@Body() body: unknown, @Req() request: AuthorizedRequest): Promise<OrgUnit> {
    const parsed = parseBody(createOrgUnitBodySchema, body)

    if (parsed.parentId === undefined) {
      const scopePaths = await this.engine.scopePathsFor(request.actor, 'org_unit:create')
      if (scopePaths !== null) {
        throw new ForbiddenError(
          'creating a root org unit requires a global grant of org_unit:create',
        )
      }
    } else {
      await this.engine.assertCanIn(request.actor, 'org_unit:create', parsed.parentId)
    }

    return this.db.transaction(async (tx) => {
      const unit =
        parsed.parentId === undefined
          ? await this.orgUnits.createRoot(parsed.name, tx)
          : await this.orgUnits.createChild(parsed.parentId, parsed.name, tx)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'org_unit:create',
        resourceType: 'org_unit',
        resourceId: unit.id,
        before: null,
        after: snapshotOrgUnit(unit),
      })

      await this.outboxWriter.record(tx, {
        aggregateType: 'org_unit',
        aggregateId: unit.id,
        eventType: 'created',
        payload: { ...snapshotOrgUnit(unit), action: 'org_unit:create' },
      })

      return unit
    })
  }
}
