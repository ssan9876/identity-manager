import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common'
import { JwtGuard } from '../auth/jwt.guard'
import { PermissionGuard } from '../authz/permission.guard'
import { RequirePermission } from '../authz/require-permission.decorator'
import { NotFoundError } from '../common/errors'
import { parseId } from '../common/http/parse-id'
import { type Page, parsePageQuery } from '../common/pagination'
import { GroupsRepository, type Group } from './groups.repository'

@Controller('groups')
@UseGuards(JwtGuard, PermissionGuard)
export class GroupsController {
  constructor(@Inject(GroupsRepository) private readonly groups: GroupsRepository) {}

  @Get()
  @RequirePermission('group:read')
  async list(@Query() query: Record<string, unknown>): Promise<Page<Group>> {
    const page = parsePageQuery(query)

    if (query.userId !== undefined) {
      // Filter to this user's EFFECTIVE membership (direct + inherited via
      // nesting), never the unfiltered list. A malformed userId is a 400,
      // and a well-formed one that matches no membership (nonexistent user,
      // or a real user in no groups) is an empty page — not the full list.
      const userId = parseId(String(query.userId))
      const effectiveGroupIds = await this.groups.listEffectiveGroupsForUser(userId)

      const [items, total] = await Promise.all([
        this.groups.listByIds(effectiveGroupIds, page),
        this.groups.countByIds(effectiveGroupIds),
      ])
      return { items, total, limit: page.limit, offset: page.offset }
    }

    const [items, total] = await Promise.all([
      this.groups.list(page),
      this.groups.count(),
    ])
    return { items, total, limit: page.limit, offset: page.offset }
  }

  @Get(':id')
  @RequirePermission('group:read')
  async findOne(@Param('id') rawId: string): Promise<Group> {
    return this.requireGroup(parseId(rawId))
  }

  @Get(':id/members')
  @RequirePermission('group:read')
  async members(
    @Param('id') rawId: string,
  ): Promise<{ users: string[]; groups: string[] }> {
    const id = parseId(rawId)
    await this.requireGroup(id)

    const [users, groups] = await Promise.all([
      this.groups.listDirectUserMembers(id),
      this.groups.listDirectChildGroups(id),
    ])

    return { users, groups }
  }

  @Get(':id/effective-members')
  @RequirePermission('group:read')
  async effectiveMembers(@Param('id') rawId: string): Promise<string[]> {
    const id = parseId(rawId)
    await this.requireGroup(id)
    return this.groups.listEffectiveUserMembers(id)
  }

  private async requireGroup(id: string): Promise<Group> {
    const group = await this.groups.findById(id)
    if (group === null) {
      throw new NotFoundError('group', id)
    }
    return group
  }
}
