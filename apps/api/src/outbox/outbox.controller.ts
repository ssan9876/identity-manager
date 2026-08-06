import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { JwtGuard } from '../auth/jwt.guard'
import { PermissionGuard } from '../authz/permission.guard'
import { RequirePermission } from '../authz/require-permission.decorator'
import { DB_CLIENT } from '../common/db.token'
import { type Page, parsePageQuery } from '../common/pagination'
import * as schema from '../db/schema/index'
import { type DeadLetterEvent, OutboxRepository } from './outbox.repository'

/**
 * Operator-facing visibility into the outbox's dead letters — the second
 * half of finding H3 (docs/superpowers/audit-integrity.md): the read model
 * fix in `SyncStateRepository` closes the "looks synced, isn't" hole for a
 * REMOVAL specifically, but the audit's own fix direction separately calls
 * out that "there is no operator-facing view of dead letters at all" —
 * `SyncStateRepository` only ever reports a per-USER derived summary
 * (`pending`/`synced`/`failed`), never the raw `outbox_events` rows
 * themselves, and no controller anywhere reads that table. A `group`/
 * `membership` fan-out that dead-letters can, by design, fail to cleanly
 * attribute to any single user (see SyncWorker.markUserSyncFailed's doc
 * comment) — this endpoint is the backstop that makes such an event visible
 * regardless of whether it ever folds into anyone's `syncState`.
 *
 * Gated behind `audit:read`, not `user:read`/`group:read` — this is
 * operational/security visibility ("what happened, what is broken"), the
 * same category of information `audit_log` already exists to expose, and
 * `auditor` is the one role in today's static catalog (`ROLE_PERMISSIONS`,
 * authz/actions.ts) that already means exactly that. Read-only: this
 * controller has no mutation route. Retrying or resolving a dead letter is
 * ReconciliationJob's job (an on-demand script — see reconcile-cli.ts), not
 * something exposed over HTTP here.
 */
@Controller('outbox')
@UseGuards(JwtGuard, PermissionGuard)
export class OutboxController {
  constructor(
    @Inject(OutboxRepository) private readonly outbox: OutboxRepository,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  @Get('dead-letters')
  @RequirePermission('audit:read')
  async deadLetters(@Query() query: Record<string, unknown>): Promise<Page<DeadLetterEvent>> {
    const page = parsePageQuery(query)

    const [items, total] = await Promise.all([
      this.outbox.listFailed(this.db, page),
      this.outbox.countFailed(this.db),
    ])

    return { items, total, limit: page.limit, offset: page.offset }
  }
}
