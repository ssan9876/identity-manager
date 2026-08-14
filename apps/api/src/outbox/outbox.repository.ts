import { Injectable } from '@nestjs/common'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../db/schema/index'
import { outboxEvents } from '../db/schema/outbox-events'

/**
 * A WHERE fragment matching events whose AGGREGATE belongs to
 * `organizationId` — the dead-letter view's organization dimension
 * (per-organization connector targets). The per-aggregate-type resolution
 * mirrors `resolveAggregateOrganizationId` (aggregate-organization.ts)
 * exactly, pushed into SQL so the filter composes with pagination instead
 * of resolving every dead letter application-side: `user`/`group`/
 * `org_unit` rows carry their own organization, a `membership` event is
 * anchored on the parent GROUP's id, and `sso_app`/`organization` events
 * are platform-level and belong to MASTER.
 */
function aggregateOrganizationFilter(organizationId: string) {
  return sql`(
    CASE ${outboxEvents.aggregateType}
      WHEN 'user' THEN (SELECT u.organization_id FROM users u WHERE u.id = ${outboxEvents.aggregateId})
      WHEN 'group' THEN (SELECT g.organization_id FROM groups g WHERE g.id = ${outboxEvents.aggregateId})
      WHEN 'membership' THEN (SELECT g.organization_id FROM groups g WHERE g.id = ${outboxEvents.aggregateId})
      WHEN 'org_unit' THEN (SELECT ou.organization_id FROM org_units ou WHERE ou.id = ${outboxEvents.aggregateId})
      ELSE (SELECT o.id FROM organizations o WHERE o.is_master)
    END
  ) = ${organizationId}::uuid`
}
import type { DbHandle, OutboxAggregateType, OutboxEventType, OutboxTarget } from './outbox.writer'

/**
 * One claimed row, narrowed to mostly what the worker needs to decide what
 * to reconcile. Deliberately omits `status`/`nextAttemptAt`/`createdAt` — the
 * worker never branches on those (see sync.worker.ts's file-level doc
 * comment: this is a diagnostics/ordering vehicle, not a delta to apply),
 * and `lastError` is write-only from here (the worker sets it, it never
 * reads a PRIOR value back to decide anything). `target` (Milestone 10,
 * Task 1) is the one exception carried anyway, ahead of the worker actually
 * branching on it — see this field's own doc comment below.
 */
export interface ClaimedOutboxEvent {
  id: number
  aggregateType: OutboxAggregateType
  aggregateId: string
  eventType: OutboxEventType
  payload: Record<string, unknown>
  attempts: number
  /**
   * Milestone 10, Task 1 — which backend this specific row is destined for.
   * Not yet consulted by `SyncWorker.applyEvent` (it still unconditionally
   * reconciles to Keycloak — see that method's own doc comment on why that
   * remains correct for now: `connector_targets` seeds only `'keycloak'` as
   * enabled, so no OTHER target can produce a claimable row until Task 2's
   * registry lets one be enabled). Carried here now, ahead of that need, so
   * Task 2 can dispatch on it without a second schema-adjacent change to
   * this claim path.
   */
  target: OutboxTarget
}

// A `type` alias, deliberately not an `interface`: `tx.execute<TRow>` requires
// `TRow extends Record<string, unknown>`, and TypeScript only treats an
// object type as implicitly satisfying an index-signature constraint when it
// is a type-literal alias (or inline literal) — a named `interface` never
// gets that leniency, even when structurally identical. Same shape GroupsRepository's
// own `execute<{ reachable: boolean }>` calls rely on, just named here for reuse.
type RawClaimRow = {
  id: string
  aggregate_type: OutboxAggregateType
  aggregate_id: string
  event_type: OutboxEventType
  payload: Record<string, unknown>
  attempts: number
  target: OutboxTarget
}

/**
 * The CONSUMER side of the outbox table — claiming and finalizing events.
 * `OutboxWriter` (Task 1) is the producer side (`record`, called from every
 * mutation's own transaction); this is its sibling for the sync worker
 * (Milestone 4, Task 3), same relationship as `AuditWriter`/`AuditRepository`
 * already have for `audit_log`.
 *
 * Every method takes an EXPLICIT `tx` — never an optional-default pooled
 * handle (contrast GroupsRepository/UsersRepository's write methods) —
 * because `claimNext`'s lock is only meaningful for the lifetime of a single
 * caller-controlled transaction; see its own doc comment for why the worker
 * must hold that transaction open across the Keycloak call it drives, not
 * just across this one query.
 */
/**
 * Make a connector's error message safe to STORE.
 *
 * Found by running it: a failing Active Directory sync produced a message
 * containing a NUL byte, `markForRetry` wrote it into `last_error`, and
 * Postgres refused the whole statement with `invalid byte sequence for
 * encoding "UTF8": 0x00`. That throw happened INSIDE the failure-recording
 * path, so it escaped `runOnce`'s per-event handling and aborted the entire
 * drain — every target's events, not just the one that failed. The worker
 * then retried the same poison event on the next tick and died the same way,
 * so the outbox stopped moving permanently while looking merely "pending".
 *
 * Worse, the original error was destroyed in the process: the connector's own
 * message is never logged before this write, so the failure that needs
 * diagnosing was replaced by an encoding complaint about recording it.
 *
 * Sanitised HERE rather than at each call site for the reason this codebase
 * already applies to its permission catalogs: a guard that every present and future
 * caller must remember is only as good as the one that forgets. `lastError`
 * is operator-facing text with no structure worth preserving, so control
 * characters are simply dropped, and the result is capped — a vendor library
 * can hand back a message carrying an entire LDIF payload, and `last_error`
 * is a diagnostic, not a log sink.
 */
const MAX_LAST_ERROR_LENGTH = 2000

export function sanitizeLastError(message: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  return stripped.length > MAX_LAST_ERROR_LENGTH
    ? `${stripped.slice(0, MAX_LAST_ERROR_LENGTH)}… (truncated)`
    : stripped
}

@Injectable()
export class OutboxRepository {
  /**
   * Claims the SINGLE next event this transaction is allowed to process, or
   * `null` if nothing is claimable right now. Three properties, all in one
   * statement so they compose atomically instead of racing each other:
   *
   *  1. **Concurrency-safe**: `FOR UPDATE SKIP LOCKED` on the outer query —
   *     a row already locked by another in-flight worker transaction is
   *     skipped, not waited on, so N workers draining the same backlog each
   *     get a DIFFERENT row rather than serializing behind one another
   *     (Task 3 contract: "multiple workers are safe").
   *  2. **Strict per-(aggregate, TARGET) ordering**: the `NOT EXISTS`
   *     subquery excludes any candidate that has an OLDER `pending`/
   *     `processing` row for the SAME `(aggregate_type, aggregate_id,
   *     target)` — served directly by the `outbox_events_aggregate_idx
   *     (aggregate_type, aggregate_id, target, id)` index (widened in
   *     Milestone 10, Task 1 for exactly this query — see that index's own
   *     doc comment in db/schema/outbox-events.ts). Deliberately does NOT
   *     filter the blocking row by `next_attempt_at`: an older event that is
   *     merely BACKING OFF (not yet due) must still block a newer, currently
   *     due one FOR THE SAME TARGET — otherwise a fast-failing retry queue
   *     would let events apply out of order every time an earlier one is
   *     mid-backoff. This is the exact scenario the "out-of-order
   *     protection" test constructs.
   *
   *     THE TRAP (Milestone 10, Task 1): before this task, the subquery had
   *     no `target` predicate at all — ordering was scoped to the aggregate
   *     ALONE, which was invisibly correct only because `'keycloak'` was the
   *     only target that ever existed. Once `OutboxWriter.record` can emit a
   *     row for `active_directory`/`entra_id`/`google_workspace` too, that
   *     same unscoped predicate becomes a HEAD-OF-LINE BLOCK: a stalled
   *     Active Directory delivery for a user — still `pending`, mid-backoff,
   *     not yet dead-lettered — would silently block every later Keycloak
   *     event for that SAME user, because the old subquery only checked
   *     `aggregate_type`/`aggregate_id`, never which target the blocking row
   *     was even for. The user would look synced, be stale, and nothing
   *     would report it — precisely the failure mode `SyncStateRepository`'s
   *     own read model exists to prevent (see its doc comment on the
   *     identical shape of gap, finding H3). Adding `e2.target = e1.target`
   *     below is THE fix; see outbox-multi-target.spec.ts and
   *     sync.worker.spec.ts's `describe('multi-target ordering (Milestone
   *     10, Task 1)', ...)` for the red-then-green proof — the same
   *     scenario returns `null` (blocked) without this line and the correct
   *     row with it.
   *  3. **Crash-safe claiming**: the row lock — not any column value this
   *     method writes — is what makes a crashed worker's claim releasable.
   *     This method marks the row `processing` (so a plain, non-locking read
   *     — e.g. a future read-model — can see it as in-flight), but that
   *     write lives INSIDE the same transaction the caller holds open for
   *     the whole claim-apply-finalize cycle. If the caller's transaction
   *     never commits (process crash, connection drop), Postgres rolls this
   *     UPDATE back too and releases the lock — the row reverts to exactly
   *     its pre-claim `pending` state, `attempts`/`nextAttemptAt` untouched,
   *     ready for the next worker to claim. See sync.worker.ts's
   *     `runOnce` for the transaction this method is always called inside.
   *
   *  `next_attempt_at <= now()` is evaluated in Postgres, not in the
   *  application, so this method's notion of "due" can never drift from
   *  whatever clock actually decides row visibility.
   */
  async claimNext(tx: DbHandle): Promise<ClaimedOutboxEvent | null> {
    const { rows } = await tx.execute<RawClaimRow>(sql`
      SELECT id, aggregate_type, aggregate_id, event_type, payload, attempts, target
        FROM outbox_events e1
       WHERE status = 'pending'
         AND next_attempt_at <= now()
         AND NOT EXISTS (
           SELECT 1 FROM outbox_events e2
            WHERE e2.aggregate_type = e1.aggregate_type
              AND e2.aggregate_id = e1.aggregate_id
              AND e2.target = e1.target
              AND e2.id < e1.id
              AND e2.status IN ('pending', 'processing')
         )
       ORDER BY id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
    `)

    const row = rows[0]
    if (row === undefined) {
      return null
    }

    await tx.execute(sql`UPDATE outbox_events SET status = 'processing' WHERE id = ${row.id}`)

    return {
      id: Number(row.id),
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload: row.payload,
      attempts: row.attempts,
      target: row.target,
    }
  }

  /** Terminal success. `attempts`/`lastError` are left exactly as they were. */
  async markDone(tx: DbHandle, id: number): Promise<void> {
    await tx.update(outboxEvents).set({ status: 'done' }).where(eq(outboxEvents.id, id))
  }

  /**
   * One dead letter by id, or null — the read a retry needs before it writes.
   *
   * Filtered on `status = 'failed'` in SQL rather than fetched-then-checked,
   * so "this event is not a dead letter" and "this event does not exist" reach
   * the caller as the same absence. A retry asked about a live event is a
   * request built on a stale screen, and both answers are the same 404.
   */
  async findFailedById(
    db: NodePgDatabase<typeof schema>,
    id: number,
  ): Promise<{
    id: number
    attempts: number
    lastError: string | null
    aggregateType: string
    aggregateId: string
  } | null> {
    const [row] = await db
      .select({
        id: outboxEvents.id,
        attempts: outboxEvents.attempts,
        lastError: outboxEvents.lastError,
        aggregateType: outboxEvents.aggregateType,
        aggregateId: outboxEvents.aggregateId,
      })
      .from(outboxEvents)
      .where(and(eq(outboxEvents.id, id), eq(outboxEvents.status, 'failed')))
      .limit(1)

    return row ?? null
  }

  /**
   * A retryable failure: stays `pending` (so the claim query above can pick
   * it up again once `nextAttemptAt` arrives) with `attempts`/`lastError`
   * updated to reflect THIS attempt. Never called with a `nextAttemptAt` in
   * the past by its only caller (sync.worker.ts computes it via
   * `computeBackoffDelayMs`), but this method itself does not enforce that —
   * it trusts the caller, exactly like `markFailed` below.
   */
  async markForRetry(
    tx: DbHandle,
    id: number,
    input: { attempts: number; nextAttemptAt: Date; lastError: string },
  ): Promise<void> {
    await tx
      .update(outboxEvents)
      .set({
        status: 'pending',
        attempts: input.attempts,
        nextAttemptAt: input.nextAttemptAt,
        lastError: sanitizeLastError(input.lastError),
      })
      .where(eq(outboxEvents.id, id))
  }

  /**
   * The attempt cap has been exceeded: a dead letter. `status: 'failed'` is
   * excluded from the claim query's blocking set (see `claimNext`'s doc
   * comment) — a permanently-failed event stays visible/queryable forever
   * (Task 3's foremost visibility requirement) but never again blocks later
   * events for the same aggregate.
   */
  async markFailed(tx: DbHandle, id: number, input: { attempts: number; lastError: string }): Promise<void> {
    await tx
      .update(outboxEvents)
      .set({ status: 'failed', attempts: input.attempts, lastError: sanitizeLastError(input.lastError) })
      .where(eq(outboxEvents.id, id))
  }

  /**
   * Every currently dead-lettered event, newest first — finding H3
   * (docs/archive/audits/audit-integrity.md): "there is no operator-facing
   * view of dead letters at all. No controller reads `outbox_events`; the
   * derived per-user `syncState` is the only surface, and it has [a] hole."
   * `SyncStateRepository` stays the per-USER read model; this is the
   * OPERATOR-facing complement — a permanently-failed event can be a
   * `group`/`membership` fan-out that never cleanly attributes to any
   * single user (see SyncWorker.markUserSyncFailed's doc comment on why
   * only a direct `user`-aggregate dead-letter regresses
   * `external_identities`), so this table is the only place SOME dead
   * letters are visible at all, not merely a convenience view of what
   * `syncState` already shows.
   *
   * Deliberately takes an explicit `db` (the pool, via the controller's own
   * injected `DB_CLIENT`), not a `tx` — a plain paginated read needs no
   * transactional/locking semantics, and `DbHandle` (every OTHER method on
   * this class) would reject the pooled handle by type; widening to
   * `NodePgDatabase<typeof schema>` here, explicitly rather than defaulted,
   * keeps every existing `tx`-only call site unchanged while still refusing
   * to silently assume a handle the caller didn't provide.
   */
  async listFailed(
    db: NodePgDatabase<typeof schema>,
    options: { limit: number; offset: number; target?: OutboxTarget; organizationId?: string },
  ): Promise<DeadLetterEvent[]> {
    const rows = await db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.status, 'failed'),
          options.target === undefined ? undefined : eq(outboxEvents.target, options.target),
          options.organizationId === undefined ? undefined : aggregateOrganizationFilter(options.organizationId),
        ),
      )
      .orderBy(desc(outboxEvents.id))
      .limit(options.limit)
      .offset(options.offset)

    return rows.map((row) => ({
      id: Number(row.id),
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      eventType: row.eventType,
      payload: row.payload as Record<string, unknown>,
      target: row.target,
      attempts: row.attempts,
      lastError: row.lastError,
      createdAt: row.createdAt,
      nextAttemptAt: row.nextAttemptAt,
    }))
  }

  /**
   * Matching count for `listFailed` — always agrees with it, same filter.
   * `target` (Milestone 14, Task 9) narrows both together, the same
   * optional-and-together-narrowing shape every other paginated list in this
   * codebase already uses (e.g. UsersRepository.list/count's own
   * scopePaths).
   */
  async countFailed(
    db: NodePgDatabase<typeof schema>,
    options: { target?: OutboxTarget; organizationId?: string } = {},
  ): Promise<number> {
    const [row] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.status, 'failed'),
          options.target === undefined ? undefined : eq(outboxEvents.target, options.target),
          options.organizationId === undefined ? undefined : aggregateOrganizationFilter(options.organizationId),
        ),
      )

    return row?.value ?? 0
  }
}

/**
 * One dead-lettered (`status = 'failed'`) event, as `listFailed` reports it
 * to an operator. `target` (Milestone 10, Task 1) is the dimension that
 * makes a dead letter actionable once more than one target exists — "which
 * connector failed" alongside "which principal" and "how many attempts" —
 * added here without touching any OTHER field or the surrounding
 * `Page<DeadLetterEvent>` envelope (`{ items, total, limit, offset }`,
 * common/pagination.ts's `Page`), so `GET /outbox/dead-letters`'s existing
 * response shape is unchanged for Milestone 8's console and its E2E test:
 * every existing consumer that does not know about `target` keeps working
 * exactly as before, it simply now also has one more field available to it.
 */
export interface DeadLetterEvent {
  id: number
  aggregateType: OutboxAggregateType
  aggregateId: string
  eventType: OutboxEventType
  payload: Record<string, unknown>
  target: OutboxTarget
  attempts: number
  lastError: string | null
  createdAt: Date
  nextAttemptAt: Date
}
