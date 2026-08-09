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
import { rawAttributesSchema, validateAttributes } from '../attributes/attribute-validator'
import { JwtGuard } from '../auth/jwt.guard'
import { AuditWriter } from '../audit/audit.writer'
import type { Action } from '../authz/actions'
import { PermissionEngine, type Actor } from '../authz/permission.engine'
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
import { UsersRepository } from '../users/users.repository'
import { GroupsRepository, type Group } from './groups.repository'

// noNulChar wraps every free-text field — see docs/archive/audits/audit-
// injection.md's HIGH "JSON-escaped NUL" finding and safe-string.ts's own
// doc comment.
const createGroupBodySchema = z
  .object({
    name: noNulChar(z.string().min(1).max(255)),
    description: noNulChar(z.string().min(1).max(1024)).optional(),
    orgUnitId: z.string().uuid().optional(),
    attributes: rawAttributesSchema,
  })
  .strict()

// Every field optional (a PATCH touches only what it names); `description`
// additionally accepts `null` explicitly, to clear it — same convention as
// UsersController's updateUserBodySchema. `orgUnitId` is deliberately
// absent — see GroupsRepository's UpdateGroupInput doc comment for why a
// scope transfer is out of this milestone's PATCH surface.
const updateGroupBodySchema = z
  .object({
    name: noNulChar(z.string().min(1).max(255)).optional(),
    description: noNulChar(z.string().min(1).max(1024)).nullable().optional(),
    attributes: rawAttributesSchema,
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
    @Inject(UsersRepository) private readonly users: UsersRepository,
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

      // L-2 (docs/archive/audits/audit-authz.md): the user named by ?userId=
      // must itself be reachable under user:read before their membership is
      // disclosed — otherwise this filter is an oracle: a Sales admin could
      // confirm an Engineering user's existence AND membership just by
      // querying it, even though GET /users/<that id> itself 403s them
      // directly. Only the resulting GROUPS were ever narrowed before this
      // fix; the USER named by the filter was not.
      //
      // A nonexistent id is deliberately NOT distinguished here — this
      // branch's existing contract (see the comment above) already folds
      // "nonexistent user" and "real user in no groups" into the same empty
      // page, and this fix does not add a new 404/403 oracle on top of that:
      // only an id that resolves to a real, OUT-OF-SCOPE user is rejected.
      const target = await this.users.findById(userId)
      if (target !== null) {
        await this.engine.assertCanIn(request.actor, 'user:read', target.orgUnitId)
      }

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
   * A group created with no `orgUnitId` is GLOBAL (decision 1). Superseded
   * by finding M-2 (docs/archive/audits/audit-authz.md): this method used to
   * skip `assertCanIn` entirely for that case, on the reasoning that decision
   * 1 already lets any actor holding `group:update`/`group:manage_members`
   * anywhere freely manage an EXISTING global group, so letting any actor
   * holding `group:create` anywhere be the one who first creates one was
   * "not a new escalation." That reasoning did not account for
   * `SyncWorker.reconcileUser` pushing local group membership into REAL
   * Keycloak groups — a downstream authorization primitive — which makes
   * "any scope, anywhere" a materially different, and too broad, a grant for
   * something with cross-org reach. `group:create` on a global group now
   * requires the SAME thing `requireGroup` below now requires to manage an
   * EXISTING one, and the same thing `OrgUnitsController.create` already
   * requires for a root org unit: a GLOBAL grant
   * (`scopePathsFor(actor, action) === null`), not merely a grant of the
   * action at SOME scope.
   */
  @Post()
  @RequirePermission('group:create')
  async create(@Body() body: unknown, @Req() request: AuthorizedRequest): Promise<Group> {
    const parsed = parseBody(createGroupBodySchema, body)

    if (parsed.orgUnitId !== undefined) {
      await this.engine.assertCanIn(request.actor, 'group:create', parsed.orgUnitId)
    } else {
      const scopePaths = await this.engine.scopePathsFor(request.actor, 'group:create')
      if (scopePaths !== null) {
        throw new ForbiddenError('creating a global group requires a global grant of group:create')
      }
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
   * mutation and writes the audit row, narrows via `requireGroup` (a scoped
   * group requires reaching its org unit; a global group requires a GLOBAL
   * grant of `group:update` as of finding M-2 — see `requireGroup`'s own doc
   * comment), then updates. A rejection throws before any write, so there is
   * nothing to roll back and no audit row is ever written. Same shape as
   * UsersController.update.
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
   * the URL (`:id`) — never against the child group or the user being
   * removed. This mirrors GET :id/members's own read shape: membership is a
   * fact about the GROUP's roster, not about the member, so "does this actor
   * reach this group" is most of the scope question. `resourceType`/
   * `resourceId` on every audit row below are likewise always the parent
   * group's, not the member's — the same anchor `group:create`/
   * `group:update` use — so a query for "every audited change to group X"
   * naturally includes its membership history.
   *
   * `addMember`, below, is the one exception to "the member is never
   * scope-checked" (finding M-2, docs/archive/audits/audit-authz.md): ADDING a
   * member is what actually confers access (`SyncWorker` pushes membership
   * into real Keycloak groups — a downstream authorization primitive), so
   * the user being added must be reachable under `group:manage_members`
   * exactly like the group itself is, or a Sales-scoped admin could place
   * any directory user into a Sales-synced Keycloak group.
   * `removeMember` deliberately keeps the OLD, group-only shape: revoking
   * membership never grants anything, so there is nothing for a member-side
   * check to protect against there.
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

      const member = await this.users.findById(parsed.userId, tx)
      if (member === null) {
        throw new NotFoundError('user', parsed.userId)
      }
      await this.engine.assertCanIn(request.actor, 'group:manage_members', member.orgUnitId, tx)

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
   *
   * Finding M-1 (docs/archive/audits/audit-authz.md): `requireGroup` above
   * narrows only against the PARENT (`id`) — this is the one membership
   * mutation where that is not the whole scope question, because nesting
   * pulls an entire out-of-scope GROUP (and everything reachable under it)
   * into a container the actor already controls, which then changes what
   * `GET /:id/effective-members` discloses. The child-side check below
   * closes that: a CHILD with a real org unit must independently be
   * reachable under `group:manage_members`, exactly as if the actor were
   * acting on it directly. A GLOBAL child (`orgUnitId === null`) is
   * deliberately exempt — decision 1 already makes a global group visible to
   * (and, post finding M-2, manageable only by a global holder in its own
   * right) every actor holding the relevant action, so nesting one under an
   * in-scope parent adds no NEW containment to check.
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

      const child = await this.groups.findById(parsed.childId, tx)
      if (child === null) {
        throw new NotFoundError('group', parsed.childId)
      }
      if (child.orgUnitId !== null) {
        await this.engine.assertCanIn(request.actor, 'group:manage_members', child.orgUnitId, tx)
      }

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
   * a group with a real `orgUnitId` is scoped — `assertCanIn` decides,
   * out-of-scope but existing -> 403 (decision 2), never 404. A group with
   * `orgUnitId = NULL` is GLOBAL (decision 1), handled by the branch below.
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
   * (docs/archive/audits/audit-integrity.md): loading the group ON `tx` but
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
      return group
    }

    // GLOBAL group (orgUnitId === null). Finding M-2 (docs/archive/audits/
    // audit-authz.md): decision 1's ORIGINAL rule — visible to and writable
    // by any actor holding `action` at ANY scope — is left exactly as-is for
    // READS (`group:read`; the default above): any scope holder may still
    // see any global group, unchanged. It does NOT hold for a WRITE action
    // (`group:update`/`group:manage_members`, passed explicitly by every
    // write handler below) any more: `SyncWorker.reconcileUser` pushes local
    // group membership into REAL Keycloak groups — a downstream
    // authorization primitive with cross-org reach — so managing a group
    // with no containing org unit now requires the SAME thing
    // `OrgUnitsController.create` already requires for a root org unit: a
    // GLOBAL grant of `action` (`scopePathsFor(actor, action) === null`),
    // not merely a grant of `action` at SOME scope. `scopePathsFor` takes no
    // `db`/`tx` (it never queries — see its own doc comment), so there is
    // nothing to redirect onto `db` here.
    if (action !== 'group:read') {
      const scopePaths = await this.engine.scopePathsFor(actor, action)
      if (scopePaths !== null) {
        throw new ForbiddenError(`managing a global group requires a global grant of ${action}`)
      }
    }

    return group
  }
}
