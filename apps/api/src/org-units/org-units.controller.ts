import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common'
import { JwtGuard } from '../auth/jwt.guard'
import { PermissionEngine } from '../authz/permission.engine'
import { PermissionGuard, type AuthorizedRequest } from '../authz/permission.guard'
import { RequirePermission } from '../authz/require-permission.decorator'
import { NotFoundError } from '../common/errors'
import { parseId } from '../common/http/parse-id'
import { type Page, parsePageQuery } from '../common/pagination'
import { OrgUnitsRepository, type OrgUnit } from './org-units.repository'

@Controller('org-units')
@UseGuards(JwtGuard, PermissionGuard)
export class OrgUnitsController {
  constructor(
    @Inject(OrgUnitsRepository) private readonly orgUnits: OrgUnitsRepository,
    @Inject(PermissionEngine) private readonly engine: PermissionEngine,
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
}
