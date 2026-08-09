import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { JwtGuard } from '../auth/jwt.guard'
import { AuditWriter } from '../audit/audit.writer'
import { PermissionEngine } from '../authz/permission.engine'
import { PermissionGuard, type AuthorizedRequest } from '../authz/permission.guard'
import { RequirePermission } from '../authz/require-permission.decorator'
import { DB_CLIENT } from '../common/db.token'
import { NotFoundError } from '../common/errors'
import { parseBody } from '../common/http/parse-body'
import { parseId } from '../common/http/parse-id'
import { type Page, parsePageQuery } from '../common/pagination'
import { noNulChar } from '../common/http/safe-string'
import * as schema from '../db/schema/index'
import { OutboxWriter } from '../outbox/outbox.writer'
import { OrgUnitsRepository, type OrgUnit } from './org-units.repository'

// noNulChar — see docs/archive/audits/audit-injection.md's HIGH "JSON-escaped
// NUL" finding (confirmed live on POST /org-units) and safe-string.ts's own
// doc comment.
const createOrgUnitBodySchema = z
  .object({
    name: noNulChar(z.string().min(1).max(255)),
    // REQUIRED since organizations landed (multi-tenancy milestone, Task 7).
    // A root org unit is the thing an ORGANIZATION owns — exactly one, and
    // creating the organization is what creates it (Task 12). A root made
    // through this endpoint would have to invent an organization to belong
    // to, which in Phase 1 means silently landing in master: a second
    // tenant's admin could create a root inside the platform tenant's
    // directory and nothing in the schema would object, because the row
    // itself is perfectly valid. There is therefore no route that makes one.
    parentId: z.string().uuid(),
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
   * Every org unit this endpoint creates is a CHILD, and is scoped by its
   * PARENT exactly like every other write in this milestone:
   * `assertCanIn(actor, 'org_unit:create', parentId)` — does this actor's
   * grant cover the org unit the new one would live under?
   *
   * The ROOT branch is GONE (organizations multi-tenancy, Task 7). It used
   * to accept `parentId: undefined` and gate it on a global grant of
   * `org_unit:create`, which was the right rule while a root belonged to
   * nothing. It is the wrong rule now: a root belongs to an ORGANIZATION,
   * which owns exactly one, and the only thing that may create one is
   * creating the organization. `OrgUnitsRepository.createRoot` deliberately
   * SURVIVES — it is the method organization creation calls (Task 12) — but
   * it is no longer reachable from HTTP.
   *
   * The global-grant check went with it rather than being kept "just in
   * case": Zod now rejects a missing `parentId` before the handler runs, so
   * a surviving check would be dead code that reads like a live control.
   */
  @Post()
  @RequirePermission('org_unit:create')
  async create(@Body() body: unknown, @Req() request: AuthorizedRequest): Promise<OrgUnit> {
    const parsed = parseBody(createOrgUnitBodySchema, body)

    await this.engine.assertCanIn(request.actor, 'org_unit:create', parsed.parentId)

    return this.db.transaction(async (tx) => {
      const unit = await this.orgUnits.createChild(parsed.parentId, parsed.name, tx)

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
