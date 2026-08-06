import { Inject, Injectable } from '@nestjs/common'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import * as schema from '../db/schema/index'
import { externalIdentities } from '../db/schema/external-identities'
import { GroupsRepository } from '../groups/groups.repository'

/**
 * The read model's derived, user-facing sync health (Milestone 4, Task 4) —
 * deliberately a SEPARATE type from `external_identities.sync_state`
 * (`externalIdentitySyncState`, db/schema/external-identities.ts), even
 * though the three string values happen to coincide. That column is a
 * per-EXTERNAL-SYSTEM fact this user's row currently holds; `SyncState` is
 * the further-derived combination the milestone plan calls for ("derived
 * from `external_identities` AND any pending/failed outbox events") — see
 * `SyncStateRepository`'s own doc comment for why the two can disagree.
 */
export type SyncState = 'pending' | 'synced' | 'failed'

// A `type` alias, not an `interface` — same reasoning as
// OutboxRepository's own RawClaimRow: `db.execute<TRow>` requires TRow to
// structurally satisfy `Record<string, unknown>`, which only a type-literal
// alias gets from TypeScript, never a named `interface`.
type LatestAggregateEventRow = {
  aggregate_id: string
  status: 'pending' | 'processing' | 'done' | 'failed'
}

/** `'done'` is deliberately excluded — a healthy latest attempt contributes nothing here. */
function unsettledStatus(status: LatestAggregateEventRow['status']): 'pending' | 'failed' | null {
  if (status === 'failed') return 'failed'
  if (status === 'pending' || status === 'processing') return 'pending'
  return null
}

/** `'failed'` always wins over `'pending'` — never downgraded once raised. */
function raiseWorst(
  target: Map<string, 'pending' | 'failed'>,
  key: string,
  status: 'pending' | 'failed',
): void {
  if (target.get(key) === 'failed') return
  target.set(key, status)
}

function worseOf(
  a: 'pending' | 'failed' | undefined,
  b: 'pending' | 'failed' | undefined,
): 'pending' | 'failed' | undefined {
  if (a === 'failed' || b === 'failed') return 'failed'
  return a ?? b
}

/**
 * Derives the `syncState` that `GET /users` / `GET /users/:id` expose
 * (Milestone 4, Task 4) — deliberately NOT a thin passthrough of
 * `external_identities.sync_state`.
 *
 * THE gap this class exists to close (flagged in task-3-report.md and
 * required by task-4-brief.md): `external_identities` only regresses to
 * `'failed'` for a DIRECT `user`-aggregate dead-letter (see
 * SyncWorker.markUserSyncFailed's doc comment — decision 5). A
 * `membership`/`group`-aggregate event that dead-letters partway through a
 * multi-user fan-out (`reconcileGroup`/`reconcileMembership`) never touches
 * any single affected user's `external_identities` row, because a partial
 * failure does not cleanly identify which of several users are actually out
 * of sync. Deriving `syncState` from `external_identities` ALONE would
 * therefore show a user whose GROUP sync is genuinely broken as healthy —
 * exactly the "admin believes access was revoked/correct when it was not"
 * failure mode decision 5 calls the worst in a directory product. This
 * class additionally walks `outbox_events` for the `group`/`membership`
 * aggregate types and folds in whichever of THOSE currently-troubled
 * aggregates the user is an effective member of.
 *
 * Only the LATEST event per aggregate is consulted, not "has this aggregate
 * EVER had a failure" — `outbox_events` rows are never deleted, including
 * dead letters, so an aggregate that failed once and was later fixed by a
 * subsequent, successful event must read as healthy again, matching
 * `external_identities`' own self-healing behaviour (a later successful
 * `reconcileUser` call unconditionally resets `sync_state` back to
 * `'synced'`). `DISTINCT ON (aggregate_id) ... ORDER BY aggregate_id, id
 * DESC` picks that latest row directly in Postgres.
 *
 * KNOWN LIMIT (same class of gap as SyncWorker's `reconcileGroup` doc
 * comment on decision 3, and explicitly called out as lower-priority,
 * document-don't-expand in task-4-brief.md): the group/membership half
 * walks users' CURRENT effective group membership
 * (`GroupsRepository.listEffectiveUserMembers`). A user who was REMOVED
 * from a group in the same window that removal's own outbox event
 * dead-lettered is no longer an effective member of that group by the time
 * this query runs, so that dead-letter will not surface against THAT user
 * here — the `outbox_events` row itself remains visible/queryable directly
 * by aggregate regardless, just not folded into this specific user's
 * derived state. The on-demand reconciliation job (ReconciliationJob) is
 * the general backstop for drift this narrow edge could leave behind.
 */
@Injectable()
export class SyncStateRepository {
  constructor(
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
    @Inject(GroupsRepository) private readonly groups: GroupsRepository,
  ) {}

  /** Convenience single-user wrapper around `resolveForUsers` — see its doc comment. */
  async resolveForUser(userId: string): Promise<SyncState> {
    const resolved = await this.resolveForUsers([userId])
    return resolved.get(userId) ?? 'pending'
  }

  /**
   * Batched so a paginated `GET /users` page costs a small, roughly constant
   * number of queries rather than one recursive group-membership walk per
   * LISTED user: the group/membership half works BACKWARDS from whichever
   * groups currently have a troubled latest event (almost always a small
   * set — most groups are not mid-drift at any given moment) out to their
   * effective members, rather than forwards from every requested user to
   * their effective groups. Cost scales with how much of the SYSTEM is
   * currently unsynced, not with how many users are on this page.
   */
  async resolveForUsers(userIds: readonly string[]): Promise<Map<string, SyncState>> {
    const result = new Map<string, SyncState>()
    if (userIds.length === 0) {
      return result
    }
    const ids = [...new Set(userIds)]

    const [identityRows, userEvents, groupEvents, membershipEvents] = await Promise.all([
      this.db
        .select({ userId: externalIdentities.userId, syncState: externalIdentities.syncState })
        .from(externalIdentities)
        .where(
          and(inArray(externalIdentities.userId, ids), eq(externalIdentities.system, 'keycloak')),
        ),
      this.latestUserEvents(ids),
      this.latestEventsForAggregateType('group'),
      this.latestEventsForAggregateType('membership'),
    ])

    const troubledUsers = new Map<string, 'pending' | 'failed'>()
    for (const row of userEvents) {
      const status = unsettledStatus(row.status)
      if (status !== null) raiseWorst(troubledUsers, row.aggregate_id, status)
    }

    const affectedByGroup = new Map<string, 'pending' | 'failed'>()
    for (const row of [...groupEvents, ...membershipEvents]) {
      const status = unsettledStatus(row.status)
      if (status === null) continue
      const memberIds = await this.groups.listEffectiveUserMembers(row.aggregate_id)
      for (const memberId of memberIds) {
        raiseWorst(affectedByGroup, memberId, status)
      }
    }

    const identityByUser = new Map(identityRows.map((row) => [row.userId, row.syncState]))

    for (const userId of ids) {
      const worst = worseOf(troubledUsers.get(userId), affectedByGroup.get(userId))
      result.set(userId, worst ?? identityByUser.get(userId) ?? 'pending')
    }
    return result
  }

  /**
   * Latest `user`-aggregate event per requested id. `ids` is bound as ONE
   * array-typed parameter via `sql.param` + an explicit `::uuid[]` cast —
   * the same proven technique `PermissionEngine.canIn`/`GroupsRepository.
   * scopeFilter` already use for `ltree[]`, applied here to `uuid[]`: a bare
   * `${ids}` interpolation would splice as individually-bound scalars
   * (Drizzle's IN-list convenience shape), which cannot cast to an array
   * type for `= ANY(...)`.
   */
  private async latestUserEvents(ids: string[]): Promise<LatestAggregateEventRow[]> {
    const { rows } = await this.db.execute<LatestAggregateEventRow>(sql`
      SELECT DISTINCT ON (aggregate_id) aggregate_id, status
        FROM outbox_events
       WHERE aggregate_type = 'user'
         AND aggregate_id = ANY(${sql.param(ids)}::uuid[])
       ORDER BY aggregate_id, id DESC
    `)
    return rows
  }

  /**
   * Latest event per aggregate, for one aggregate type, across the WHOLE
   * table — not scoped to any particular user, since (unlike the user case
   * above) we do not know in advance which groups matter until we know
   * which ones are currently troubled. Served by the existing
   * `outbox_events_aggregate_idx (aggregate_type, aggregate_id, id)` index —
   * an equality prefix (`aggregate_type`) followed by the exact
   * `DISTINCT ON`/`ORDER BY` columns.
   */
  private async latestEventsForAggregateType(
    aggregateType: 'group' | 'membership',
  ): Promise<LatestAggregateEventRow[]> {
    const { rows } = await this.db.execute<LatestAggregateEventRow>(sql`
      SELECT DISTINCT ON (aggregate_id) aggregate_id, status
        FROM outbox_events
       WHERE aggregate_type = ${aggregateType}
       ORDER BY aggregate_id, id DESC
    `)
    return rows
  }
}
