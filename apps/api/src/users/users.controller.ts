import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { JwtGuard } from '../auth/jwt.guard'
import { NotFoundError, ValidationError } from '../common/errors'
import { type Page, parsePageQuery } from '../common/pagination'
import { UsersRepository, type User, type UserStatus } from './users.repository'

const uuidSchema = z.string().uuid()
const statusSchema = z
  .enum(['pending', 'active', 'suspended', 'deactivated'])
  .optional()

function parseId(raw: string): string {
  const parsed = uuidSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ValidationError([`id: must be a UUID`])
  }
  return parsed.data
}

@Controller('users')
@UseGuards(JwtGuard)
export class UsersController {
  constructor(@Inject(UsersRepository) private readonly users: UsersRepository) {}

  @Get()
  async list(@Query() query: Record<string, unknown>): Promise<Page<User>> {
    const page = parsePageQuery(query)

    const status = statusSchema.safeParse(query.status)
    if (!status.success) {
      throw new ValidationError(['status: must be one of pending, active, suspended, deactivated'])
    }

    const orgUnitId =
      query.orgUnitId === undefined ? undefined : parseId(String(query.orgUnitId))

    const filter = { status: status.data as UserStatus | undefined, orgUnitId }

    const [items, total] = await Promise.all([
      this.users.list({ ...page, ...filter }),
      this.users.count(filter),
    ])

    return { items, total, limit: page.limit, offset: page.offset }
  }

  @Get(':id')
  async findOne(@Param('id') rawId: string): Promise<User> {
    const id = parseId(rawId)
    const user = await this.users.findById(id)
    if (user === null) {
      throw new NotFoundError('user', id)
    }
    return user
  }
}
