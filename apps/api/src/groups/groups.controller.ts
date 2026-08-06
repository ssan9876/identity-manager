import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common'
import { JwtGuard } from '../auth/jwt.guard'
import { PermissionEngine, type Actor } from '../authz/permission.engine'
import { PermissionGuard, type AuthorizedRequest } from '../authz/permission.guard'
import { RequirePermission } from '../authz/require-permission.decorator'
import { NotFoundError } from '../common/errors'
import { parseId } from '../common/http/parse-id'
import { type Page, parsePageQuery } from '../common/pagination'
import { GroupsRepository, type Group } from './groups.repository'

@Controller('groups')
@UseGuards(JwtGuard, PermissionGuard)
export class GroupsController {
  constructor(
    @Inject(GroupsRepository) private readonly groups: GroupsRepository,
    @Inject(PermissionEngine) private readonly engine: PermissionEngine,
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
   * Loads the group, then narrows: a group with `orgUnitId = NULL` is
   * GLOBAL (decision 1) and visible to any actor holding `group:read`, so
   * the scope check is skipped entirely for it — there is no org unit to
   * check containment against, and treating a missing scope as "check
   * nothing, deny" would be inventing a restriction the design deliberately
   * does not have. Otherwise, `assertCanIn` decides: out-of-scope but
   * existing -> 403, never 404 (decision 2).
   */
  private async requireGroup(id: string, actor: Actor): Promise<Group> {
    const group = await this.groups.findById(id)
    if (group === null) {
      throw new NotFoundError('group', id)
    }
    if (group.orgUnitId !== null) {
      await this.engine.assertCanIn(actor, 'group:read', group.orgUnitId)
    }
    return group
  }
}
