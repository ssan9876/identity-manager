import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common'
import { JwtGuard } from '../auth/jwt.guard'
import { NotFoundError } from '../common/errors'
import { parseId } from '../common/http/parse-id'
import { type Page, parsePageQuery } from '../common/pagination'
import { OrgUnitsRepository, type OrgUnit } from './org-units.repository'

@Controller('org-units')
@UseGuards(JwtGuard)
export class OrgUnitsController {
  constructor(@Inject(OrgUnitsRepository) private readonly orgUnits: OrgUnitsRepository) {}

  @Get()
  async list(@Query() query: Record<string, unknown>): Promise<Page<OrgUnit>> {
    const page = parsePageQuery(query)
    const [items, total] = await Promise.all([
      this.orgUnits.list(page),
      this.orgUnits.count(),
    ])
    return { items, total, limit: page.limit, offset: page.offset }
  }

  @Get(':id')
  async findOne(@Param('id') rawId: string): Promise<OrgUnit> {
    const id = parseId(rawId)
    const unit = await this.orgUnits.findById(id)
    if (unit === null) {
      throw new NotFoundError('org unit', id)
    }
    return unit
  }

  @Get(':id/subtree')
  async subtree(@Param('id') rawId: string): Promise<OrgUnit[]> {
    const id = parseId(rawId)
    const unit = await this.orgUnits.findById(id)
    if (unit === null) {
      throw new NotFoundError('org unit', id)
    }
    return this.orgUnits.findSubtree(id)
  }
}
