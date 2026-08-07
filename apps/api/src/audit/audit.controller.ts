import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { JwtGuard } from '../auth/jwt.guard'
import { PermissionGuard } from '../authz/permission.guard'
import { RequirePermission } from '../authz/require-permission.decorator'
import { ValidationError } from '../common/errors'
import { noNulChar } from '../common/http/safe-string'
import { parseId } from '../common/http/parse-id'
import { type Page, parsePageQuery } from '../common/pagination'
import { type AuditRow, AuditRepository } from './audit.repository'

// Matches `action`/`resource_type`'s own column width (audit-log.ts:
// varchar(64)) — an over-length value can never match a real row, so
// rejecting it early is a courtesy 400 rather than a silent "no results".
const boundedTextSchema = noNulChar(z.string().min(1).max(64)).optional()
const actorSchema = noNulChar(z.string().min(1).max(255)).optional()

// Date-only (YYYY-MM-DD), same shape and same scope decision as every other
// plain-date field in this codebase (users.controller.ts's own isoDateSchema
// comment: full calendar validity is Postgres's job, not this regex's).
// `from`/`to` are UI-friendly day boundaries, not raw timestamps — a caller
// picks a day, not a millisecond.
const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)')
  .optional()

/**
 * `GET /audit` — Milestone 8, Task 5. The one new endpoint this task's
 * screen genuinely needs (mirrors the milestone's own stated constraint:
 * "adds no new endpoints except where a screen genuinely needs one," Task 2's
 * precedent being `GET /self/permissions`): `AuditRepository` has existed
 * since Milestone 5 (audit.writer.ts's sibling), but no controller anywhere
 * ever read it over HTTP — the `auditor` role existed with nothing to read.
 *
 * Gated on `audit:read`, exactly like `GET /outbox/dead-letters`
 * (OutboxController) — the two are siblings in the same "operational/
 * security visibility" bucket that role exists to cover.
 */
@Controller('audit')
@UseGuards(JwtGuard, PermissionGuard)
export class AuditController {
  constructor(@Inject(AuditRepository) private readonly audit: AuditRepository) {}

  @Get()
  @RequirePermission('audit:read')
  async list(@Query() query: Record<string, unknown>): Promise<Page<AuditRow>> {
    const page = parsePageQuery(query)

    const actorParsed = actorSchema.safeParse(query.actor)
    if (!actorParsed.success) {
      throw new ValidationError(['actor: must be a string of at most 255 characters'])
    }
    const actorTerm = actorParsed.data?.trim()
    const actor = actorTerm !== undefined && actorTerm.length > 0 ? actorTerm : undefined

    const actionParsed = boundedTextSchema.safeParse(query.action)
    if (!actionParsed.success) {
      throw new ValidationError(['action: must be a string of at most 64 characters'])
    }

    const resourceTypeParsed = boundedTextSchema.safeParse(query.resourceType)
    if (!resourceTypeParsed.success) {
      throw new ValidationError(['resourceType: must be a string of at most 64 characters'])
    }

    const resourceId =
      query.resourceId === undefined ? undefined : parseId(String(query.resourceId), 'resourceId')
    const batchId = query.batchId === undefined ? undefined : parseId(String(query.batchId), 'batchId')

    const fromParsed = dateOnlySchema.safeParse(query.from)
    if (!fromParsed.success) {
      throw new ValidationError(['from: must be an ISO date (YYYY-MM-DD)'])
    }
    const toParsed = dateOnlySchema.safeParse(query.to)
    if (!toParsed.success) {
      throw new ValidationError(['to: must be an ISO date (YYYY-MM-DD)'])
    }
    // Day BOUNDARIES, in UTC — a caller picking "from 2026-08-01 to
    // 2026-08-04" expects every row created anywhere within 2026-08-04 to be
    // included, not just up to midnight at its start.
    const from = fromParsed.data !== undefined ? new Date(`${fromParsed.data}T00:00:00.000Z`) : undefined
    const to = toParsed.data !== undefined ? new Date(`${toParsed.data}T23:59:59.999Z`) : undefined

    const filters = {
      actor,
      action: actionParsed.data,
      resourceType: resourceTypeParsed.data,
      resourceId,
      batchId,
      from,
      to,
    }

    const [items, total] = await Promise.all([
      this.audit.list({ ...page, ...filters }),
      this.audit.count(filters),
    ])

    return { items, total, limit: page.limit, offset: page.offset }
  }
}
