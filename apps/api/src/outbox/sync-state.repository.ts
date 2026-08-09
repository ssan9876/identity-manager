import { Inject, Injectable } from '@nestjs/common'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import * as schema from '../db/schema/index'
import { connectorTargets } from '../db/schema/connector-targets'
import { externalIdentities } from '../db/schema/external-identities'
import { GroupsRepository } from '../groups/groups.repository'
import type { OutboxTarget } from './outbox.writer'

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
  target: OutboxTarget
  status: 'pending' | 'processing' | 'done' | 'failed'
}

/**
 * Same shape as `LatestAggregateEventRow`, plus `payload` — needed ONLY for
 * `membership`-aggregate rows (see `resolveForUsers`'s use of it below,
 * finding H3, docs/archive/audits/audit-integrity.md): a `group`-aggregate
 * event's affected set is always "whoever is CURRENTLY an effective member",
 * but a `membership`-aggregate event additionally carries `payload.userId`/
 * `payload.childGroupId`, recorded by the controller at WRITE time, before
 * a removal's edge is deleted — the only way to name a user who was REMOVED
 * and is therefore no longer discoverable by walking current membership.
 */
type LatestMembershipEventRow = LatestAggregateEventRow & {
  payload: Record<string, unknown>
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

/**
 * `external_identity_system` and `outbox_target` have identical members
 * (db/schema/external-identities.ts's own doc comment), so one key shape
 * serves both maps. `:` is an unambiguous separator because neither a uuid
 * nor any enum member can contain one — no escaping needed.
 */
function perTargetKey(userId: string, target: string): string {
  return `${userId}:${target}`
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
 * TARGET SCOPE (2026-08-08 sync-diagnostics spec). Both halves are scoped to
 * the targets currently `enabled` in `connector_targets`. This class was
 * formerly incoherent: the `external_identities` half filtered
 * `system = 'keycloak'` while the outbox half filtered no target whatsoever
 * — invisibly consistent while Keycloak was the only enabled target, and
 * silently wrong the moment `mail_server` was enabled, at which point a
 * dead-lettered mail event outranked a healthy Keycloak sync and the badge
 * could never go green again. Widening (not narrowing) is deliberate:
 * docs/product-brief.md's second requirement is that a user must never look
 * healthy while a real sync is broken. Within ONE target the two sources are
 * ORDERED — the latest event decides, and `external_identities` is consulted
 * only when that target has no event at all, so a connector that returned
 * NotApplicableError (a `done` event, no identity row) reads as settled
 * rather than permanently pending.
 *
 * Only the LATEST event per (aggregate, target) is consulted, not "has this
 * aggregate EVER had a failure" — `outbox_events` rows are never deleted, including
 * dead letters, so an aggregate that failed once and was later fixed by a
 * subsequent, successful event must read as healthy again, matching
 * `external_identities`' own self-healing behaviour (a later successful
 * `reconcileUser` call unconditionally resets `sync_state` back to
 * `'synced'`). `DISTINCT ON (aggregate_id) ... ORDER BY aggregate_id, id
 * DESC` picks that latest row directly in Postgres.
 *
 * FIXED GAP, formerly a documented KNOWN LIMIT (finding H3, docs/
 * superpowers/audit-integrity.md): the group/membership half used to walk
 * ONLY users' CURRENT effective group membership
 * (`GroupsRepository.listEffectiveUserMembers`) — so a user who was REMOVED
 * from a group in the same window that removal's own outbox event
 * dead-lettered was, by definition, no longer in that set, and the
 * dead-letter surfaced against nobody. That was the worst case this whole
 * class exists to prevent: the removal was never applied to Keycloak, yet
 * `GET /users` reported `syncState: 'synced'`. Fixed by additionally
 * consulting the troubled `membership` event's own `payload` — the
 * controller records `payload.userId` (direct add/remove) or
 * `payload.childGroupId` (nested add/remove) at WRITE time, before the edge
 * is deleted (see GroupsController's membership handlers), so a removed
 * user stays discoverable from the event itself even though the current
 * membership table no longer names them. `payload.childGroupId` still
 * resolves via CURRENT membership under the child (see
 * SyncWorker.reconcileMembership's own doc comment for why that direction
 * is safe: the child itself is never removed by an edge change, only the
 * parent link is), so only the DIRECT `payload.userId` case needed this
 * fix — but both are folded in identically below for one code path. A
 * `group`-aggregate event (the group's own fields, not a membership edge)
 * has no "removed user" concept and is unaffected — it keeps walking
 * current effective membership, which is what
 * `SyncWorker.reconcileGroup` itself fans out to.
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

    const targets = await this.enabledTargets()
    if (targets.length === 0) {
      // No target is enabled, so nothing can be asserted anywhere and no
      // claim of health would be honest. Matches the pre-existing fallback
      // for a user with no events and no identity row.
      for (const userId of ids) result.set(userId, 'pending')
      return result
    }

    const [identityRows, userEvents, groupEvents, membershipEvents] = await Promise.all([
      this.db
        .select({
          userId: externalIdentities.userId,
          system: externalIdentities.system,
          syncState: externalIdentities.syncState,
        })
        .from(externalIdentities)
        .where(and(inArray(externalIdentities.userId, ids), inArray(externalIdentities.system, targets))),
      this.latestUserEvents(ids, targets),
      this.latestEventsForAggregateType('group', targets),
      this.latestMembershipEvents(targets),
    ])

    const eventByUserTarget = new Map<string, LatestAggregateEventRow['status']>()
    for (const row of userEvents) {
      eventByUserTarget.set(perTargetKey(row.aggregate_id, row.target), row.status)
    }
    const identityByUserSystem = new Map<string, 'pending' | 'synced' | 'failed'>()
    for (const row of identityRows) {
      identityByUserSystem.set(perTargetKey(row.userId, row.system), row.syncState)
    }

    // THE ORDERED RULE (2026-08-08 sync-diagnostics spec, "The
    // not-applicable subtlety"). The latest event for a (user, target)
    // decides first; the external_identities row is consulted ONLY when that
    // target has no event at all. A connector that threw NotApplicableError
    // leaves a `done` event and NO identity row -- settled, contributing
    // nothing -- which a naive "missing row means pending" reading would
    // turn into a permanently yellow badge for every mail-exempt person.
    const troubledUsers = new Map<string, 'pending' | 'failed'>()
    for (const userId of ids) {
      for (const target of targets) {
        const key = perTargetKey(userId, target)
        const eventStatus = eventByUserTarget.get(key)
        if (eventStatus !== undefined) {
          const status = unsettledStatus(eventStatus)
          if (status !== null) raiseWorst(troubledUsers, userId, status)
          continue
        }
        const identity = identityByUserSystem.get(key)
        if (identity === 'failed') raiseWorst(troubledUsers, userId, 'failed')
        else if (identity !== 'synced') raiseWorst(troubledUsers, userId, 'pending')
      }
    }

    const affectedByGroup = new Map<string, 'pending' | 'failed'>()
    for (const row of groupEvents) {
      const status = unsettledStatus(row.status)
      if (status === null) continue
      const memberIds = await this.groups.listEffectiveUserMembers(row.aggregate_id)
      for (const memberId of memberIds) {
        raiseWorst(affectedByGroup, memberId, status)
      }
    }

    // Finding H3 (docs/archive/audits/audit-integrity.md): mirrors
    // SyncWorker.reconcileMembership's OWN affected-set computation exactly
    // -- `payload.userId` names a direct add/remove's single affected user
    // DIRECTLY (still discoverable even after a removal deletes the edge);
    // `payload.childGroupId` affects every user CURRENTLY effective under
    // that child. A troubled event can carry either, so both are checked
    // per row rather than assuming one.
    for (const row of membershipEvents) {
      const status = unsettledStatus(row.status)
      if (status === null) continue

      const payload = row.payload as { userId?: unknown; childGroupId?: unknown }
      if (typeof payload.userId === 'string') {
        raiseWorst(affectedByGroup, payload.userId, status)
      }
      if (typeof payload.childGroupId === 'string') {
        const memberIds = await this.groups.listEffectiveUserMembers(payload.childGroupId)
        for (const memberId of memberIds) {
          raiseWorst(affectedByGroup, memberId, status)
        }
      }
    }

    for (const userId of ids) {
      const worst = worseOf(troubledUsers.get(userId), affectedByGroup.get(userId))
      // No `?? identityByUser.get(userId)` tail any more: the per-target loop
      // above already folded every enabled target's identity row in, so
      // "nothing troubled" now genuinely means synced.
      result.set(userId, worst ?? 'synced')
    }
    return result
  }

  /** Targets an operator currently has switched on. The SAME `WHERE enabled = true` read `OutboxWriter.record` uses to decide fan-out, so this read model can never weigh a target the writer would not even emit for. */
  private async enabledTargets(): Promise<OutboxTarget[]> {
    const rows = await this.db
      .select({ target: connectorTargets.target })
      .from(connectorTargets)
      .where(eq(connectorTargets.enabled, true))
    return rows.map((row) => row.target)
  }

  /**
   * Latest `user`-aggregate event per requested id. `ids` is bound as ONE
   * array-typed parameter via `sql.param` + an explicit `::uuid[]` cast —
   * the same proven technique `PermissionEngine.canIn`/`GroupsRepository.
   * scopeFilter` already use for `ltree[]`, applied here to `uuid[]`: a bare
   * `${ids}` interpolation would splice as individually-bound scalars
   * (Drizzle's IN-list convenience shape), which cannot cast to an array
   * type for `= ANY(...)`.
   *
   * Latest event per (aggregate, TARGET) -- not per aggregate (2026-08-08
   * sync-diagnostics spec). That distinction IS the fix:
   * `DISTINCT ON (aggregate_id)` alone let a dead-lettered mail_server event
   * outrank a later successful keycloak one for the same user, because the
   * newer id won regardless of which backend it described.
   *
   * `target::text = ANY(...::text[])` rather than a native enum array cast:
   * `sql.param` binds a JS string[] as a text array, and Postgres will not
   * implicitly coerce text[] to outbox_target[]. Casting the COLUMN to text
   * keeps the comparison well-typed with no per-element cast; the
   * enabled-target list is at most six values, so the lost index usability
   * on `target` costs nothing here.
   */
  private async latestUserEvents(ids: string[], targets: OutboxTarget[]): Promise<LatestAggregateEventRow[]> {
    const { rows } = await this.db.execute<LatestAggregateEventRow>(sql`
      SELECT DISTINCT ON (aggregate_id, target) aggregate_id, target, status
        FROM outbox_events
       WHERE aggregate_type = 'user'
         AND aggregate_id = ANY(${sql.param(ids)}::uuid[])
         AND target::text = ANY(${sql.param(targets)}::text[])
       ORDER BY aggregate_id, target, id DESC
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
    aggregateType: 'group',
    targets: OutboxTarget[],
  ): Promise<LatestAggregateEventRow[]> {
    const { rows } = await this.db.execute<LatestAggregateEventRow>(sql`
      SELECT DISTINCT ON (aggregate_id, target) aggregate_id, target, status
        FROM outbox_events
       WHERE aggregate_type = ${aggregateType}
         AND target::text = ANY(${sql.param(targets)}::text[])
       ORDER BY aggregate_id, target, id DESC
    `)
    return rows
  }

  /**
   * Same query as `latestEventsForAggregateType('membership')` would be,
   * additionally selecting `payload` — a separate method (not a shared one
   * parameterized on aggregate type) because ONLY `membership` rows need it
   * (finding H3; see `resolveForUsers`'s use of the result, and
   * `LatestMembershipEventRow`'s own doc comment for why).
   */
  private async latestMembershipEvents(targets: OutboxTarget[]): Promise<LatestMembershipEventRow[]> {
    const { rows } = await this.db.execute<LatestMembershipEventRow>(sql`
      SELECT DISTINCT ON (aggregate_id, target) aggregate_id, target, status, payload
        FROM outbox_events
       WHERE aggregate_type = 'membership'
         AND target::text = ANY(${sql.param(targets)}::text[])
       ORDER BY aggregate_id, target, id DESC
    `)
    return rows
  }
}
