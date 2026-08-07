import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { OutboxRepository } from '../src/outbox/outbox.repository'
import { withTestDatabase } from './support/pg'

/**
 * MILESTONE 10, TASK 1 — the multi-target outbox's own load-bearing
 * property, proven directly and in isolation from the (Keycloak-only,
 * container-heavy) SyncWorker suite: `OutboxRepository.claimNext`'s
 * per-aggregate ordering predicate must be scoped to `(aggregate_type,
 * aggregate_id, TARGET)`, not aggregate alone — see db/schema/
 * outbox-events.ts's `outboxTarget`/`aggregateIdx` doc comments and this
 * repository's own `claimNext` doc comment for the full "why". This file is
 * the "prove it" — see sync.worker.spec.ts's `describe('multi-target
 * ordering (Milestone 10, Task 1)', ...)` for the SAME property proven a
 * second time end-to-end, through the real claim-apply-finalize cycle.
 *
 * THE TRAP, restated as a test: scoped globally (pre-fix), a stalled Active
 * Directory event for a user silently blocks every later Keycloak event for
 * that SAME user — the user looks synced, is actually stale, and nothing
 * reports it. That is precisely the failure mode the sync read model exists
 * to prevent (see SyncStateRepository's own doc comment on the identical
 * shape of gap, finding H3). Every "head-of-line" test below constructs
 * exactly that shape: an OLDER (lower id), same-aggregate row for a
 * DIFFERENT target, left `pending` with a FUTURE `next_attempt_at` —
 * mid-backoff, not yet dead-lettered, which is the realistic window (a
 * TERMINAL `failed` row was already excluded from blocking even before this
 * task — see claimNext's own doc comment on why `status IN ('pending',
 * 'processing')` never included `'failed'`). Deliberately does NOT filter
 * the blocking candidate by `next_attempt_at` either, matching claimNext's
 * own documented behaviour: an event merely backing off must still count as
 * "older and unresolved", never quietly treated as absent.
 */
describe('OutboxRepository — per-(aggregate, target) ordering (Milestone 10, Task 1)', () => {
  const ctx = withTestDatabase()
  const repo = () => new OutboxRepository()

  interface OutboxRow {
    id: string
    status: string
    target: string
    attempts: number
  }

  /**
   * Raw insert with full control over target/status/next_attempt_at — this
   * file's whole point is constructing states the normal write path never
   * produces on its own (a stalled, blocking row for one target sitting
   * alongside a healthy, due-now row for another). No FK from
   * `outbox_events.aggregate_id` to any table (see outbox-events.ts's own
   * doc comment — the aggregate table depends on `aggregateType`), so a bare
   * `randomUUID()` aggregate id needs no real `users` row behind it.
   */
  async function insertEvent(input: {
    aggregateType: string
    aggregateId: string
    target: string
    status?: 'pending' | 'processing' | 'done' | 'failed'
    dueInMs?: number
  }): Promise<number> {
    const dueAt = new Date(Date.now() + (input.dueInMs ?? 0))
    const { rows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, target, status, next_attempt_at)
       VALUES ($1, $2, 'updated', '{}'::jsonb, $3, $4, $5)
       RETURNING id`,
      [input.aggregateType, input.aggregateId, input.target, input.status ?? 'pending', dueAt],
    )
    return Number(rows[0]!.id)
  }

  async function outboxRow(id: number): Promise<OutboxRow> {
    const { rows } = await ctx.pool.query<OutboxRow>(
      'SELECT id, status, target, attempts FROM outbox_events WHERE id = $1',
      [id],
    )
    const row = rows[0]
    if (!row) throw new Error(`no outbox row ${id}`)
    return row
  }

  /** One `claimNext` call, in its own committed transaction — mirrors exactly how `SyncWorker.runOnce` calls it (see that method's own doc comment on why the claim must commit inside the SAME transaction the caller controls). */
  async function claimOnce() {
    return ctx.db.transaction(async (tx) => repo().claimNext(tx))
  }

  describe('the head-of-line fix', () => {
    it('a stalled target does not block a DIFFERENT target for the same aggregate', async () => {
      const userId = randomUUID()

      // Older (lower id), STALLED: still pending, backing off (not due for
      // another minute) — simulates an active_directory delivery mid-retry.
      const staleAdEvent = await insertEvent({
        aggregateType: 'user',
        aggregateId: userId,
        target: 'active_directory',
        dueInMs: 60_000,
      })

      // Newer (higher id), due right now, a DIFFERENT target for the SAME
      // aggregate — the event that must still ship.
      const dueKeycloakEvent = await insertEvent({
        aggregateType: 'user',
        aggregateId: userId,
        target: 'keycloak',
      })

      const claimed = await claimOnce()

      // THE assertion: the keycloak event ships even though an older,
      // still-pending active_directory event for the SAME user exists.
      expect(claimed).not.toBeNull()
      expect(claimed?.id).toBe(dueKeycloakEvent)
      expect(claimed?.target).toBe('keycloak')

      // The stalled AD event is untouched by this claim — still pending,
      // still backing off, exactly where it was. Its own eventual delivery
      // (or dead-lettering) is a separate, independent concern from this
      // test — the point is only that it never blocked the OTHER target.
      const adRow = await outboxRow(staleAdEvent)
      expect(adRow.status).toBe('pending')
      expect(adRow.attempts).toBe(0)
    })

    it('regression: still blocks a newer event for the SAME target behind an older pending one', async () => {
      const userId = randomUUID()

      const olderKeycloak = await insertEvent({
        aggregateType: 'user',
        aggregateId: userId,
        target: 'keycloak',
        dueInMs: 60_000,
      })
      const newerKeycloak = await insertEvent({
        aggregateType: 'user',
        aggregateId: userId,
        target: 'keycloak',
      })

      const claimed = await claimOnce()

      // Nothing is claimable: the only DUE row (newerKeycloak) is blocked by
      // the older, SAME-target, still-pending row — proving the fix scopes
      // ordering to (aggregate, target) rather than deleting ordering
      // altogether. Referenced only to keep both ids "used" for lint/review
      // clarity; the assertion itself is that claimNext yields nothing.
      expect(claimed).toBeNull()
      expect(olderKeycloak).not.toBe(newerKeycloak)
    })

    it('two different targets for the same aggregate, both due, both make progress independently', async () => {
      const userId = randomUUID()

      const adEvent = await insertEvent({ aggregateType: 'user', aggregateId: userId, target: 'active_directory' })
      const kcEvent = await insertEvent({ aggregateType: 'user', aggregateId: userId, target: 'keycloak' })

      const claimedIds = new Set<number>()
      for (let i = 0; i < 2; i++) {
        const claimed = await ctx.db.transaction(async (tx) => {
          const c = await repo().claimNext(tx)
          if (c !== null) {
            await repo().markDone(tx, c.id)
          }
          return c
        })
        if (claimed !== null) {
          claimedIds.add(claimed.id)
        }
      }

      // Both targets drained — neither waited on the other.
      expect(claimedIds).toEqual(new Set([adEvent, kcEvent]))
      expect((await outboxRow(adEvent)).status).toBe('done')
      expect((await outboxRow(kcEvent)).status).toBe('done')
    })

    it("a stalled aggregate's own other-target event still ships, AND an unrelated aggregate is unaffected", async () => {
      const stalledUser = randomUUID()
      const healthyUser = randomUUID()

      await insertEvent({ aggregateType: 'user', aggregateId: stalledUser, target: 'active_directory', dueInMs: 60_000 })
      const stalledUserKeycloak = await insertEvent({
        aggregateType: 'user',
        aggregateId: stalledUser,
        target: 'keycloak',
      })
      const healthyUserEvent = await insertEvent({
        aggregateType: 'user',
        aggregateId: healthyUser,
        target: 'keycloak',
      })

      const claimedIds = new Set<number>()
      for (let i = 0; i < 2; i++) {
        const claimed = await ctx.db.transaction(async (tx) => {
          const c = await repo().claimNext(tx)
          if (c !== null) {
            await repo().markDone(tx, c.id)
          }
          return c
        })
        if (claimed !== null) {
          claimedIds.add(claimed.id)
        }
      }

      expect(claimedIds).toEqual(new Set([stalledUserKeycloak, healthyUserEvent]))
    })
  })

  describe('outbox_events_aggregate_idx must cover target too', () => {
    it('the index definition orders columns (aggregate_type, aggregate_id, target, id)', async () => {
      const { rows } = await ctx.pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'outbox_events_aggregate_idx'`,
      )
      expect(rows).toHaveLength(1)
      // Column ORDER matters — see claimNext's doc comment: target must sit
      // between aggregate_id and id so the NOT EXISTS subquery's
      // equality-heavy WHERE (aggregate_type, aggregate_id, target all
      // equality; id a range/ORDER BY) can be served by a plain index scan
      // instead of a slower plan that still happens to return correct rows.
      expect(rows[0]?.indexdef).toMatch(/\(aggregate_type, aggregate_id, target, id\)/)
    })
  })

  describe('connector_targets seed data', () => {
    it('keycloak is seeded enabled, preserving existing single-target behaviour', async () => {
      const { rows } = await ctx.pool.query<{ target: string; enabled: boolean }>(
        `SELECT target, enabled FROM connector_targets WHERE target = 'keycloak'`,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.enabled).toBe(true)
    })

    it('the other three targets have no row yet — absence, not a disabled row, until something configures one', async () => {
      const { rows } = await ctx.pool.query(`SELECT target FROM connector_targets WHERE target != 'keycloak'`)
      expect(rows).toHaveLength(0)
    })
  })
})
