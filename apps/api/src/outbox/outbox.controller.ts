import { Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { ALL_CONNECTOR_TARGETS } from '../connectors/connector'
import { JwtGuard } from '../auth/jwt.guard'
import { PermissionEngine } from '../authz/permission.engine'
import { PermissionGuard, type AuthorizedRequest } from '../authz/permission.guard'
import { RequirePermission } from '../authz/require-permission.decorator'
import { AuditWriter } from '../audit/audit.writer'
import { DB_CLIENT } from '../common/db.token'
import { ForbiddenError, NotFoundError, ValidationError } from '../common/errors'
import { parseId } from '../common/http/parse-id'
import { type Page, parsePageQuery } from '../common/pagination'
import * as schema from '../db/schema/index'
import type { OutboxTarget } from './outbox.writer'
import { type DeadLetterEvent, OutboxRepository } from './outbox.repository'

// From the canonical catalog — a stale copy here rejects a real target as an
// unknown filter in the dead-letter view, which is the operator's backstop.
const targetQuerySchema = z.enum(ALL_CONNECTOR_TARGETS)

/** `?target=` on `GET /outbox/dead-letters` (Milestone 14, Task 9 — "per-target dead letters, extending Milestone 8's view"). `undefined` (the param omitted) means every target, unchanged from before this task; any other string is a clean 400, never a silently-empty result set that could be mistaken for "no dead letters". */
function parseOptionalTarget(raw: unknown): OutboxTarget | undefined {
  if (raw === undefined) return undefined
  const parsed = targetQuerySchema.safeParse(raw)
  if (!parsed.success) {
    // DERIVED, not spelled out. A hand-written list here was stale the moment
    // SCIM landed: it named five targets while the schema above accepted
    // thirteen, so an operator filtering dead letters by a real target was
    // told it did not exist — the exact failure the comment on
    // targetQuerySchema warns about, in the message belonging to it.
    throw new ValidationError([`target: must be one of ${ALL_CONNECTOR_TARGETS.join(', ')}`])
  }
  return parsed.data
}

/**
 * Operator-facing visibility into the outbox's dead letters — the second
 * half of finding H3 (docs/archive/audits/audit-integrity.md): the read model
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
    @Inject(PermissionEngine) private readonly engine: PermissionEngine,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
  ) {}

  /**
   * Same global-grant requirement, and the same reasoning, as
   * `AuditController.list` — see that method's own doc comment. These two
   * routes are siblings in the one "operational/security visibility" bucket
   * the `auditor` role exists to cover, and both were reachable by an
   * org-unit-scoped holder of `audit:read`.
   *
   * A dead letter is an OUTBOX event, keyed by `(aggregateType, aggregateId,
   * target)` with no org unit of its own, so there is nothing to narrow to
   * here either. It additionally carries `lastError` — raw error text from
   * the target — which is exactly the kind of operational detail that should
   * not widen with a narrow grant.
   */
  private async requireGlobalAuditGrant(request: AuthorizedRequest): Promise<void> {
    const scopePaths = await this.engine.scopePathsFor(request.actor, 'audit:read')
    if (scopePaths !== null) {
      throw new ForbiddenError(
        'reading dead letters requires a global grant of audit:read — ' +
          'outbox events span every org unit and carry raw target error text',
      )
    }
  }

  @Get('dead-letters')
  @RequirePermission('audit:read')
  async deadLetters(
    @Query() query: Record<string, unknown>,
    @Req() request: AuthorizedRequest,
  ): Promise<Page<DeadLetterEvent>> {
    await this.requireGlobalAuditGrant(request)
    const page = parsePageQuery(query)
    const target = parseOptionalTarget(query.target)
    // `?organizationId=` — the dead-letter view's organization dimension
    // (per-organization connector targets): only events whose AGGREGATE
    // belongs to that organization. Omitted means every organization,
    // unchanged from before this dimension existed — this endpoint already
    // requires a GLOBAL audit:read grant, so there is no scope to narrow
    // by default.
    const organizationId = query.organizationId === undefined ? undefined : parseId(query.organizationId, 'organizationId')

    const [items, total] = await Promise.all([
      this.outbox.listFailed(this.db, { ...page, target, organizationId }),
      this.outbox.countFailed(this.db, { target, organizationId }),
    ])

    return { items, total, limit: page.limit, offset: page.offset }
  }

  /**
   * Put one dead letter back in the queue.
   *
   * Until now reconciliation was the only retry path, which works for a
   * `user` aggregate and not at all for the others: a dead-lettered
   * `group`, `membership` or `sso_app` event is never re-derived by a walk
   * over users, so it stayed failed forever and the only remedy was an
   * UPDATE against `outbox_events` by hand.
   *
   * `connector:manage`, not `audit:read`. Reading dead letters is an
   * investigation; retrying one causes a real write to a real directory, and
   * the permission has to match the consequence rather than the screen the
   * button happens to sit on. Globally held, for the reason every other
   * outbox-wide grant is: these events span every org unit.
   *
   * `attempts` is RESET to zero rather than continued. The backoff schedule
   * exists to stop a failing event hammering a target; an operator who has
   * fixed the cause and asked for a retry has supplied the judgement that
   * schedule was standing in for, and leaving the count where it was would
   * dead-letter the event again on its first hiccup. `lastError` is kept: it
   * is the record of why this needed a human, and nothing else preserves it.
   *
   * Idempotent by state, not by ceremony: an event that is not `failed` is a
   * 404 rather than a silent success, because "retry this dead letter" about
   * a live one is a request based on a stale screen.
   */
  @Post('dead-letters/:id/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('connector:manage')
  async retryDeadLetter(
    @Param('id') rawId: string,
    @Req() request: AuthorizedRequest,
  ): Promise<{ id: number; status: 'pending' }> {
    await this.requireGlobalManageGrant(request)

    const id = Number(rawId)
    if (!Number.isInteger(id) || id <= 0) {
      throw new ValidationError(['id: must be a positive integer outbox event id'])
    }

    return this.db.transaction(async (tx) => {
      const event = await this.outbox.findFailedById(tx, id)
      if (event === null) throw new NotFoundError('dead-lettered outbox event', String(id))

      await this.outbox.markForRetry(tx, id, {
        attempts: 0,
        nextAttemptAt: new Date(),
        lastError: event.lastError ?? 'retried by an operator',
      })

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'outbox:retry',
        // The AGGREGATE, not the event. `audit_log.resource_id` is a uuid and
        // an outbox id is a bigint, so the event id could not go there even if
        // it were the better key — and it is not: someone asking "why did this
        // user re-sync" looks the user up, not an event number they never saw.
        // The event id rides in the payload, where the type is free.
        resourceType: event.aggregateType,
        resourceId: event.aggregateId,
        before: {
          outboxEventId: id,
          status: 'failed',
          attempts: event.attempts,
          lastError: event.lastError,
        },
        after: { outboxEventId: id, status: 'pending', attempts: 0 },
      })

      return { id, status: 'pending' as const }
    })
  }

  /** The same global-grant rule the read above applies, for the write. */
  private async requireGlobalManageGrant(request: AuthorizedRequest): Promise<void> {
    const scopePaths = await this.engine.scopePathsFor(request.actor, 'connector:manage')
    if (scopePaths !== null) {
      throw new ForbiddenError(
        'retrying a dead letter requires a global grant of connector:manage — an outbox event ' +
          'spans every org unit and its retry writes to a directory outside any one subtree',
      )
    }
  }
}
