import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { JwtGuard } from '../auth/jwt.guard'
import { NotFoundError, ValidationError } from '../common/errors'
import { type Page, parsePageQuery } from '../common/pagination'
import { GroupsRepository, type Group } from './groups.repository'

const uuidSchema = z.string().uuid()

function parseId(raw: string): string {
  const parsed = uuidSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ValidationError(['id: must be a UUID'])
  }
  return parsed.data
}

@Controller('groups')
@UseGuards(JwtGuard)
export class GroupsController {
  constructor(@Inject(GroupsRepository) private readonly groups: GroupsRepository) {}

  @Get()
  async list(@Query() query: Record<string, unknown>): Promise<Page<Group>> {
    const page = parsePageQuery(query)
    const [items, total] = await Promise.all([
      this.groups.list(page),
      this.groups.count(),
    ])
    return { items, total, limit: page.limit, offset: page.offset }
  }

  @Get(':id')
  async findOne(@Param('id') rawId: string): Promise<Group> {
    return this.requireGroup(parseId(rawId))
  }

  @Get(':id/members')
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
