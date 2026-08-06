import {
  Body,
  Controller,
  Delete,
  Get,
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
import { validateAttributes } from '../attributes/attribute-validator'
import { JwtGuard } from '../auth/jwt.guard'
import { AuditWriter } from '../audit/audit.writer'
import type { Action } from '../authz/actions'
import { PermissionEngine, type Actor } from '../authz/permission.engine'
import { PermissionGuard, type AuthorizedRequest } from '../authz/permission.guard'
import { RequirePermission } from '../authz/require-permission.decorator'
import { DB_CLIENT } from '../common/db.token'
import { NotFoundError } from '../common/errors'
import { parseBody } from '../common/http/parse-body'
import { parseId } from '../common/http/parse-id'
import { type Page, parsePageQuery } from '../common/pagination'
import * as schema from '../db/schema/index'
import { OutboxWriter } from '../outbox/outbox.writer'
import { GroupsRepository, type Group } from './groups.repository'

const createGroupBodySchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().min(1).max(1024).optional(),
    orgUnitId: z.string().uuid().optional(),
    attributes: z.record(z.unknown()).optional(),
  })
  .strict()

// Every field optional (a PATCH touches only what it names); `description`
// additionally accepts `null` explicitly, to clear it — same convention as
// UsersController's updateUserBodySchema. `orgUnitId` is deliberately
// absent — see GroupsRepository's UpdateGroupInput doc comment for why a
// scope transfer is out of this milestone's PATCH surface.
const updateGroupBodySchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().min(1).max(1024).nullable().optional(),
    attributes: z.record(z.unknown()).optional(),
  })
  .strict()

const addMemberBodySchema = z.object({ userId: z.string().uuid() }).strict()

// `childId`, not `childGroupId`: matches the DELETE route's `:childId` path
// param name, so the "other group" is spelled the same way whether it
// arrives in a body or a URL.
const addChildGroupBodySchema = z.object({ childId: z.string().uuid() }).strict()

/**
 * Builds an audit `before`/`after` payload from explicitly named fields —
 * never `{ ...group }`. Same reasoning as UsersController's snapshotUser:
 * a spread would silently carry forward any column added to `groups` later
 * into an append-only log a leak can never be removed from.
 */
function snapshotGroup(group: Group): Record<string, unknown> {
  return {
    name: group.name,
    description: group.description,
    orgUnitId: group.orgUnitId,
    attributes: group.attributes,
  }
}

@Controller('groups')
@UseGuards(JwtGuard, PermissionGuard)
export class GroupsController {
  constructor(
    @Inject(GroupsRepository) private readonly groups: GroupsRepository,
    @Inject(PermissionEngine) private readonly engine: PermissionEngine,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(OutboxWriter) private readonly outboxWriter: OutboxWriter,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  @Get()
  @RequirePermission('group:read')
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: AuthorizedRequest,
  ): Promise<Page<Group>> {
    const page = parsePageQuery(query)
    // null = unrestricted, [] = entitled nowhere — passed through as-is.
    // GroupsRepository additionally always includes global groups
    // (orgUnitId = NULL) regardless of this value — decision 1.
    const scopePaths = await this.engine.scopePathsFor(request.actor, 'group:read')

    if (query.userId !== undefined) {
      // Filter to this user's EFFECTIVE membership (direct + inherited via
      // nesting), never the unfiltered list. A malformed userId is a 400,
      // and a well-formed one that matches no membership (nonexistent user,
      // or a real user in no groups) is an empty page — not the full list.
      const userId = parseId(String(query.userId))
      const effectiveGroupIds = await this.groups.listEffectiveGroupsForUser(userId)

      const [items, total] = await Promise.all([
        this.groups.listByIds(effectiveGroupIds, { ...page, scopePaths }),
        this.groups.countByIds(effectiveGroupIds, scopePaths),
      ])
      return { items, total, limit: page.limit, offset: page.offset }
    }

    const [items, total] = await Promise.all([
      this.groups.list({ ...page, scopePaths }),
      this.groups.count({ scopePaths }),
    ])
    return { items, total, limit: page.limit, offset: page.offset }
  }

  @Get(':id')
  @RequirePermission('group:read')
  async findOne(@Param('id') rawId: string, @Req() request: AuthorizedRequest): Promise<Group> {
    return this.requireGroup(parseId(rawId), request.actor)
  }

  @Get(':id/members')
  @RequirePermission('group:read')
  async members(
    @Param('id') rawId: string,
    @Req() request: AuthorizedRequest,
  ): Promise<{ users: string[]; groups: string[] }> {
    const id = parseId(rawId)
    await this.requireGroup(id, request.actor)

    const [users, groups] = await Promise.all([
      this.groups.listDirectUserMembers(id),
      this.groups.listDirectChildGroups(id),
    ])

    return { users, groups }
  }

  @Get(':id/effective-members')
  @RequirePermission('group:read')
  async effectiveMembers(@Param('id') rawId: string, @Req() request: AuthorizedRequest): Promise<string[]> {
    const id = parseId(rawId)
    await this.requireGroup(id, request.actor)
    return this.groups.listEffectiveUserMembers(id)
  }

  /**
   * A group created with no `orgUnitId` is GLOBAL (decision 1) — there is no
   * org unit to check `assertCanIn` against, so the check is skipped
   * entirely, exactly like `requireGroup` already skips it for an EXISTING
   * global group below. This is deliberate, not an oversight: decision 1
   * already lets any actor holding `group:update`/`group:manage_members`
   * anywhere freely manage an existing global group, so letting any actor
   * holding `group:create` anywhere be the one who FIRST creates it is
   * consistent with that, not a new escalation — a scoped actor gains
   * nothing here they couldn't already reach by asking any other holder to
   * create an empty global group once. This is intentionally DIFFERENT from
   * OrgUnitsController.create's root case: an org-unit root has no
   * equivalent "anyone holding the action may manage it" rule to be
   * consistent WITH.
   */
  @Post()
  @RequirePermission('group:create')
  async create(@Body() body: unknown, @Req() request: AuthorizedRequest): Promise<Group> {
    const parsed = parseBody(createGroupBodySchema, body)

    if (parsed.orgUnitId !== undefined) {
      await this.engine.assertCanIn(request.actor, 'group:create', parsed.orgUnitId)
    }

    const definitions = await this.groups.listActiveAttributeDefinitions()
    const attributes = validateAttributes(definitions, parsed.attributes, 'group')

    return this.db.transaction(async (tx) => {
      const group = await this.groups.create(
        {
          name: parsed.name,
          description: parsed.description,
          orgUnitId: parsed.orgUnitId,
          attributes,
        },
        tx,
      )

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'group:create',
        resourceType: 'group',
        resourceId: group.id,
        before: null,
        after: snapshotGroup(group),
      })

      await this.outboxWriter.record(tx, {
        aggregateType: 'group',
        aggregateId: group.id,
        eventType: 'created',
        payload: { ...snapshotGroup(group), action: 'group:create' },
      })

      return group
    })
  }

  /**
   * Loads the CURRENT row inside the same transaction that performs the
   * mutation and writes the audit row, narrows via `requireGroup` (skipped
   * for a global group — decision 1), then updates. A rejection throws
   * before any write, so there is nothing to roll back and no audit row is
   * ever written. Same shape as UsersController.update.
   */
  @Patch(':id')
  @RequirePermission('group:update')
  async update(
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ): Promise<Group> {
    const id = parseId(rawId)
    const parsed = parseBody(updateGroupBodySchema, body)

    // Only fetched/validated when the request actually names `attributes` —
    // PATCH semantics must never overwrite a group's existing attributes
    // with `{}` just because a request omitted the key entirely.
    let attributes: Record<string, unknown> | undefined
    if (parsed.attributes !== undefined) {
      const definitions = await this.groups.listActiveAttributeDefinitions()
      attributes = validateAttributes(definitions, parsed.attributes, 'group')
    }

    return this.db.transaction(async (tx) => {
      const current = await this.requireGroup(id, request.actor, 'group:update', tx)

      const updated = await this.groups.update(
        id,
        { name: parsed.name, description: parsed.description, attributes },
        tx,
      )

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'group:update',
        resourceType: 'group',
        resourceId: id,
        before: snapshotGroup(current),
        after: snapshotGroup(updated),
      })

      await this.outboxWriter.record(tx, {
        aggregateType: 'group',
        aggregateId: id,
        eventType: 'updated',
        payload: { ...snapshotGroup(updated), action: 'group:update' },
      })

      return updated
    })
  }

  /**
   * The four membership-mutation handlers below (add/remove user member,
   * add/remove child group) all narrow against the PARENT group named in
   * the URL (`:id`) — never against the user or child group being
   * attached/detached. This mirrors GET :id/members's own read shape (a
   * user's own org unit is never checked either): membership is a fact
   * about the GROUP's roster, not about the member, so "does this actor
   * reach this group" is the entire scope question. `resourceType`/
   * `resourceId` on every audit row below are likewise always the parent
   * group's, not the member's — the same anchor `group:create`/
   * `group:update` use — so a query for "every audited change to group X"
   * naturally includes its membership history.
   */
  @Post(':id/members')
  @RequirePermission('group:manage_members')
  async addMember(
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ): Promise<{ groupId: string; userId: string }> {
    const id = parseId(rawId)
    const parsed = parseBody(addMemberBodySchema, body)

    return this.db.transaction(async (tx) => {
      await this.requireGroup(id, request.actor, 'group:manage_members', tx)

      await this.groups.addUser(id, parsed.userId, tx)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'group:add_member',
        resourceType: 'group',
        resourceId: id,
        before: null,
        after: { groupId: id, userId: parsed.userId },
      })

      // aggregateType 'membership', not 'group': a group_user_members row is
      // a pure edge with no id of its own (see the doc comment above this
      // handler), so this is a DIFFERENT event stream from this same
      // group's own name/description/attributes — anchored on the PARENT
      // group's id exactly like the audit row above, per the same reasoning.
      await this.outboxWriter.record(tx, {
        aggregateType: 'membership',
        aggregateId: id,
        eventType: 'membership_changed',
        payload: { groupId: id, userId: parsed.userId, action: 'group:add_member' },
      })

      return { groupId: id, userId: parsed.userId }
    })
  }

  @Delete(':id/members/:userId')
  @RequirePermission('group:manage_members')
  async removeMember(
    @Param('id') rawId: string,
    @Param('userId') rawUserId: string,
    @Req() request: AuthorizedRequest,
  ): Promise<{ groupId: string; userId: string }> {
    const id = parseId(rawId)
    const userId = parseId(rawUserId, 'userId')

    return this.db.transaction(async (tx) => {
      await this.requireGroup(id, request.actor, 'group:manage_members', tx)

      await this.groups.removeUser(id, userId, tx)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'group:remove_member',
        resourceType: 'group',
        resourceId: id,
        before: { groupId: id, userId },
        after: null,
      })

      await this.outboxWriter.record(tx, {
        aggregateType: 'membership',
        aggregateId: id,
        eventType: 'membership_changed',
        payload: { groupId: id, userId, action: 'group:remove_member' },
      })

      return { groupId: id, userId }
    })
  }

  /**
   * `GroupsRepository.addChildGroup` still owns the advisory-locked cycle
   * guard entirely — this handler neither bypasses nor reimplements it, only
   * threads `tx` through so the lock, the cycle check and the edge insert
   * all run inside the SAME transaction as the audit write below (see that
   * method's own doc comment for how it nests as a savepoint rather than
   * opening a second, independent transaction). A `CycleError` thrown from
   * it propagates straight out of this callback, rolling back the whole
   * transaction — no edge is inserted and no audit row is written, and
   * `DomainExceptionFilter` maps `CYCLE_DETECTED` to 409.
   */
  @Post(':id/child-groups')
  @RequirePermission('group:manage_members')
  async addChildGroup(
    @Param('id') rawId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ): Promise<{ parentGroupId: string; childGroupId: string }> {
    const id = parseId(rawId)
    const parsed = parseBody(addChildGroupBodySchema, body)

    return this.db.transaction(async (tx) => {
      await this.requireGroup(id, request.actor, 'group:manage_members', tx)

      await this.groups.addChildGroup(id, parsed.childId, tx)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'group:add_child_group',
        resourceType: 'group',
        resourceId: id,
        before: null,
        after: { parentGroupId: id, childGroupId: parsed.childId },
      })

      await this.outboxWriter.record(tx, {
        aggregateType: 'membership',
        aggregateId: id,
        eventType: 'membership_changed',
        payload: {
          parentGroupId: id,
          childGroupId: parsed.childId,
          action: 'group:add_child_group',
        },
      })

      return { parentGroupId: id, childGroupId: parsed.childId }
    })
  }

  @Delete(':id/child-groups/:childId')
  @RequirePermission('group:manage_members')
  async removeChildGroup(
    @Param('id') rawId: string,
    @Param('childId') rawChildId: string,
    @Req() request: AuthorizedRequest,
  ): Promise<{ parentGroupId: string; childGroupId: string }> {
    const id = parseId(rawId)
    const childId = parseId(rawChildId, 'childId')

    return this.db.transaction(async (tx) => {
      await this.requireGroup(id, request.actor, 'group:manage_members', tx)

      await this.groups.removeChildGroup(id, childId, tx)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'group:remove_child_group',
        resourceType: 'group',
        resourceId: id,
        before: { parentGroupId: id, childGroupId: childId },
        after: null,
      })

      await this.outboxWriter.record(tx, {
        aggregateType: 'membership',
        aggregateId: id,
        eventType: 'membership_changed',
        payload: { parentGroupId: id, childGroupId: childId, action: 'group:remove_child_group' },
      })

      return { parentGroupId: id, childGroupId: childId }
    })
  }

  /**
   * Loads the group, 404ing if it doesn't exist, then narrows for `action`:
   * a group with `orgUnitId = NULL` is GLOBAL (decision 1) — visible to and
   * writable by any actor holding `action` at any scope, so the check is
   * skipped entirely; there is no subtree to contain. Otherwise
   * `assertCanIn` decides: out-of-scope but existing -> 403 (decision 2),
   * never 404.
   *
   * Shared by every read handler above (which call this with just an id,
   * defaulting to `group:read` against the pooled connection) AND every
   * write handler below (which pass their own action plus the open `tx`, so
   * the lookup participates in the same transaction as the mutation and the
   * audit write) — one place decides "does this actor reach this group," so
   * the two paths can never silently diverge on what "global" or
   * "out of scope" means.
   *
   * `db` is forwarded into `assertCanIn` below, not just into
   * `this.groups.findById` — this is finding C1
   * (docs/superpowers/audit-integrity.md): loading the group ON `tx` but
   * then checking scope against the POOL is exactly the bug the audit
   * reproduced through this method ("`requireGroup(..., tx)` loads the row
   * on `tx` but then calls `engine.assertCanIn` on the pool"), and it is
   * what let a single stuck connection multiply into two per in-flight
   * write across every one of this controller's five write handlers below.
   * See test/pool-exhaustion.spec.ts.
   */
  private async requireGroup(
    id: string,
    actor: Actor,
    action: Action = 'group:read',
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<Group> {
    const group = await this.groups.findById(id, db)
    if (group === null) {
      throw new NotFoundError('group', id)
    }
    if (group.orgUnitId !== null) {
      await this.engine.assertCanIn(actor, action, group.orgUnitId, db)
    }
    return group
  }
}
