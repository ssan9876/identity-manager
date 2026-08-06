import { Injectable } from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { outboxEvents } from '../db/schema/outbox-events'
import * as schema from '../db/schema/index'

/**
 * The live transaction handle passed to a `db.transaction(async (tx) => ...)`
 * callback — deliberately narrower than "the pooled handle or a transaction
 * handle". Drizzle's `PgTransaction` extends the pooled `NodePgDatabase`
 * shape with members the pool does not have (e.g. `rollback`), so passing
 * the pooled handle where a `DbHandle` is expected is a compile error, not
 * just a documented footgun. Deliberately a SEPARATE type from
 * `AuditWriter`'s own `DbHandle` (not imported from there) even though the
 * two are structurally identical — `outbox` and `audit` are sibling
 * modules, neither depending on the other, and each narrows the same way
 * for the same reason. See `OutboxWriter.record`.
 */
export type DbHandle = Parameters<
  Parameters<NodePgDatabase<typeof schema>['transaction']>[0]
>[0]

export type OutboxAggregateType = 'user' | 'group' | 'membership' | 'org_unit'

// No 'deleted' value — see db/schema/outbox-events.ts's doc comment on
// `outboxEventType`. Removal propagates as 'status_changed' carrying
// `deactivated` in the payload.
export type OutboxEventType = 'created' | 'updated' | 'status_changed' | 'membership_changed'

/**
 * `payload` is diagnostic and ordering context ONLY. The sync worker
 * (Milestone 4, Task 3) reconciles by reading the CURRENT row for
 * `aggregateId` straight from Postgres and asserting full desired state
 * into Keycloak — it never replays `payload` as a delta. Callers should
 * still populate it with a meaningful snapshot (every call site in this
 * milestone reuses the same `snapshotX` helper already built for the
 * adjacent `AuditWriter.record` call), because a dead-lettered event's
 * `payload` is the operator's only clue of what was attempted without
 * re-deriving it from `audit_log` by hand.
 */
export interface OutboxEvent {
  aggregateType: OutboxAggregateType
  aggregateId: string
  eventType: OutboxEventType
  payload: Record<string, unknown>
}

@Injectable()
export class OutboxWriter {
  /**
   * Takes the caller's transaction handle rather than opening its own, so
   * the outbox row and the mutation it describes commit or roll back
   * together — the entire reason this milestone needs no distributed
   * transaction between Postgres and Keycloak. `DbHandle` accepts only a
   * live transaction handle — the pooled handle does not satisfy the type,
   * so the compiler rejects it — meaning a standalone write must go through
   * `db.transaction(async (tx) => writer.record(tx, event))`. Same
   * reasoning, same shape, as `AuditWriter.record` — every write handler in
   * this milestone calls both from inside the SAME `tx`.
   *
   * `target`, `status`, `attempts`, `nextAttemptAt`, `lastError` are never
   * caller-supplied: every new event starts life as `target: 'keycloak'`,
   * `status: 'pending'`, `attempts: 0`, `nextAttemptAt: now()` (the column
   * defaults in db/schema/outbox-events.ts) — those fields belong to the
   * worker (Task 3), which owns every transition away from that starting
   * state. This method inserts one row and does nothing else.
   */
  async record(tx: DbHandle, event: OutboxEvent): Promise<void> {
    await tx.insert(outboxEvents).values({
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.payload,
    })
  }
}
