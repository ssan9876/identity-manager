import { Injectable } from '@nestjs/common'
import { eq, sql } from 'drizzle-orm'
import { outboxEvents } from '../db/schema/outbox-events'
import type { DbHandle, OutboxAggregateType, OutboxEventType } from './outbox.writer'

/**
 * One claimed row, narrowed to exactly what the worker needs to decide what
 * to reconcile. Deliberately omits `status`/`target`/`nextAttemptAt`/
 * `createdAt` — the worker never branches on those (see sync.worker.ts's
 * file-level doc comment: this is a diagnostics/ordering vehicle, not a
 * delta to apply), and `lastError` is write-only from here (the worker sets
 * it, it never reads a PRIOR value back to decide anything).
 */
export interface ClaimedOutboxEvent {
  id: number
  aggregateType: OutboxAggregateType
  aggregateId: string
  eventType: OutboxEventType
  payload: Record<string, unknown>
  attempts: number
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
   *  2. **Strict per-aggregate ordering**: the `NOT EXISTS` subquery excludes
   *     any candidate that has an OLDER `pending`/`processing` row for the
   *     SAME `(aggregate_type, aggregate_id)` — served directly by the
   *     `outbox_events_aggregate_idx (aggregate_type, aggregate_id, id)`
   *     index Task 1 added for exactly this query. Deliberately does NOT
   *     filter the blocking row by `next_attempt_at`: an older event that is
   *     merely BACKING OFF (not yet due) must still block a newer, currently
   *     due one — otherwise a fast-failing retry queue would let events
   *     apply out of order every time an earlier one is mid-backoff. This is
   *     the exact scenario the "out-of-order protection" test constructs.
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
      SELECT id, aggregate_type, aggregate_id, event_type, payload, attempts
        FROM outbox_events e1
       WHERE status = 'pending'
         AND next_attempt_at <= now()
         AND NOT EXISTS (
           SELECT 1 FROM outbox_events e2
            WHERE e2.aggregate_type = e1.aggregate_type
              AND e2.aggregate_id = e1.aggregate_id
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
    }
  }

  /** Terminal success. `attempts`/`lastError` are left exactly as they were. */
  async markDone(tx: DbHandle, id: number): Promise<void> {
    await tx.update(outboxEvents).set({ status: 'done' }).where(eq(outboxEvents.id, id))
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
        lastError: input.lastError,
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
      .set({ status: 'failed', attempts: input.attempts, lastError: input.lastError })
      .where(eq(outboxEvents.id, id))
  }
}
