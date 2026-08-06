import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { JwtGuard } from '../auth/jwt.guard'
import { PermissionEngine } from '../authz/permission.engine'
import { PermissionGuard, type AuthorizedRequest } from '../authz/permission.guard'
import { RequirePermission } from '../authz/require-permission.decorator'
import { NotFoundError, ValidationError } from '../common/errors'
import { parseId } from '../common/http/parse-id'
import { type Page, parsePageQuery } from '../common/pagination'
import { UsersRepository, type User, type UserStatus } from './users.repository'

const statusSchema = z
  .enum(['pending', 'active', 'suspended', 'deactivated'])
  .optional()

@Controller('users')
@UseGuards(JwtGuard, PermissionGuard)
export class UsersController {
  constructor(
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(PermissionEngine) private readonly engine: PermissionEngine,
  ) {}

  @Get()
  @RequirePermission('user:read')
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: AuthorizedRequest,
  ): Promise<Page<User>> {
    const page = parsePageQuery(query)

    const status = statusSchema.safeParse(query.status)
    if (!status.success) {
      throw new ValidationError(['status: must be one of pending, active, suspended, deactivated'])
    }

    const orgUnitId =
      query.orgUnitId === undefined
        ? undefined
        : parseId(String(query.orgUnitId), 'orgUnitId')

    // null = unrestricted (no filter); [] = entitled nowhere (filter that
    // matches nothing). Passed straight through to the repository, which
    // applies the same null-vs-[] distinction — never collapsed here first.
    const scopePaths = await this.engine.scopePathsFor(request.actor, 'user:read')

    const filter = { status: status.data as UserStatus | undefined, orgUnitId, scopePaths }

    const [items, total] = await Promise.all([
      this.users.list({ ...page, ...filter }),
      this.users.count(filter),
    ])

    return { items, total, limit: page.limit, offset: page.offset }
  }

  @Get(':id')
  @RequirePermission('user:read')
  async findOne(@Param('id') rawId: string, @Req() request: AuthorizedRequest): Promise<User> {
    const id = parseId(rawId)
    const user = await this.users.findById(id)
    if (user === null) {
      throw new NotFoundError('user', id)
    }
    // Out-of-scope existing resource -> 403, not 404 (decision 2): the
    // directory's existence is not secret, its contents are.
    await this.engine.assertCanIn(request.actor, 'user:read', user.orgUnitId)
    return user
  }
}
