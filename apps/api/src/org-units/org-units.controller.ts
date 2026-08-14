import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'
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
/**
 * Rename only. `parentId` is deliberately absent: re-parenting a unit is a
 * different operation with a different authorization question — it needs a
 * scope check against the DESTINATION parent as well as the current one,
 * exactly as moving a PERSON between units does (see
 * UsersController.transfer). `.strict()` refuses it by name rather than
 * ignoring it, so a caller who believes they moved a subtree is told they
 * did not.
 */
const renameOrgUnitBodySchema = z
  .object({ name: noNulChar(z.string().min(1).max(255)) })
  .strict()

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

  /**
   * Rename an org unit.
   *
   * Authorized against the unit ITSELF, not its parent — unlike `create`,
   * which asks about the parent because that is where the new unit will
   * live. A rename changes something that already exists inside this unit's
   * own scope.
   *
   * `org_unit:update` is super_admin's alone, and deliberately not granted to
   * the user_admin who may already create units. A rename is not cosmetic:
   * `path` is derived from the name, so it rewrites this unit's path AND
   * every descendant's, and scoped grants resolve BY PATH. Renaming a unit
   * moves the reach of every administrator scoped anywhere inside it. The
   * grant rows key on `scope_org_unit_id` and so follow the unit correctly,
   * which is why this is safe — but it is the reason the permission is not
   * the ordinary directory-editing one.
   *
   * The audit row carries both paths, not just both names. The name is what a
   * human changed; the path is what actually decides authorization, and an
   * audit log that recorded only the former would not explain a scope change
   * that happened at the same instant.
   */
  @Patch(':id')
  @RequirePermission('org_unit:update')
  async rename(
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ): Promise<OrgUnit> {
    const id = parseId(rawId)
    const parsed = parseBody(renameOrgUnitBodySchema, body)

    return this.db.transaction(async (tx) => {
      const current = await this.orgUnits.findById(id, tx)
      if (current === null) {
        throw new NotFoundError('org unit', id)
      }

      await this.engine.assertCanIn(request.actor, 'org_unit:update', id, tx)

      const renamed = await this.orgUnits.rename(id, parsed.name, tx)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'org_unit:rename',
        resourceType: 'org_unit',
        resourceId: id,
        before: snapshotOrgUnit(current),
        after: snapshotOrgUnit(renamed),
      })

      await this.outboxWriter.record(tx, {
        aggregateType: 'org_unit',
        aggregateId: id,
        eventType: 'updated',
        // `previousPath` rides on the event because it cannot be recovered
        // from anywhere else: the row now holds only where the unit ended
        // up. A target whose tree is real rather than materialised needs the
        // old location to MOVE the existing container — without it the only
        // available action is creating a second one beside the first and
        // leaving the original standing.
        payload: {
          ...snapshotOrgUnit(renamed),
          previousPath: current.path,
          action: 'org_unit:rename',
        },
      })

      return renamed
    })
  }

  /**
   * Delete an org unit that nothing depends on.
   *
   * The repository counts every blocker and refuses by name — children,
   * people, groups, and scoped role assignments. That last one is the
   * important one and is why this cannot simply be handed to the foreign
   * keys: three of the four references are ON DELETE RESTRICT and would stop
   * themselves, but `role_assignments.scope_org_unit_id` CASCADES. A delete
   * that reached the database would silently revoke every scoped grant
   * pointing here, with no audit row and no way to find out afterwards
   * except by noticing an administrator has quietly stopped being able to
   * work.
   *
   * A root unit is never deletable: an organization owns exactly one, and
   * removing it leaves a tenant with nowhere to file anybody.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('org_unit:delete')
  async remove(@Param('id') rawId: string, @Req() request: AuthorizedRequest): Promise<void> {
    const id = parseId(rawId)

    await this.db.transaction(async (tx) => {
      const current = await this.orgUnits.findById(id, tx)
      if (current === null) {
        throw new NotFoundError('org unit', id)
      }

      await this.engine.assertCanIn(request.actor, 'org_unit:delete', id, tx)

      // The audit row is written BEFORE the delete, inside the same
      // transaction: `audit_log.resource_id` is not a foreign key, so the row
      // survives the unit it describes — which is the entire point of
      // recording a deletion — but the `before` image has to be captured
      // while there is still something to capture.
      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'org_unit:delete',
        resourceType: 'org_unit',
        resourceId: id,
        before: snapshotOrgUnit(current),
        after: null,
      })

      // NO outbox event, deliberately, and `OutboxEventType` has no
      // 'deleted' member to write one with. Adding one would mean an enum
      // migration for an event with nothing to carry: this route only
      // succeeds when the unit has no people, no groups, no children and no
      // scoped grants, so nothing about it was ever projected into a
      // connected directory and there is nothing downstream to retract. The
      // audit row above is the whole record, which is what a deletion of an
      // empty container should leave behind.
      await this.orgUnits.deleteIfUnused(id, tx)
    })
  }
}
