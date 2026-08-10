import { Inject, Injectable } from '@nestjs/common'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { connectorTargets } from '../db/schema/connector-targets'
import { users } from '../db/schema/users'
import { externalIdentities } from '../db/schema/external-identities'
import * as schema from '../db/schema/index'
import { GroupsRepository } from '../groups/groups.repository'
import type { OutboxEventType, OutboxTarget } from './outbox.writer'
import { perTargetState, type SyncState, SyncStateRepository } from './sync-state.repository'

/**
 * One target's latest attempt, as the console renders it. `lastError` is
 * populated HERE and redacted by the controller for callers without a global
 * `audit:read` grant — see `UsersController.syncDetail`. This repository
 * deliberately does no permission reasoning of its own: it reports what the
 * database holds, and the one place that knows about actors decides what
 * leaves the process.
 */
export interface UserSyncLatestEvent {
  id: number
  eventType: OutboxEventType
  status: 'pending' | 'processing' | 'done' | 'failed'
  attempts: number
  createdAt: Date
  nextAttemptAt: Date
  lastError: string | null
}

export interface UserSyncTargetDetail {
  target: OutboxTarget
  enabled: boolean
  /**
   * This ONE target's contribution under the ordered rule, before the
   * worst-of aggregation `SyncStateRepository` performs.
   *
   * Deliberately no fourth `'not_applicable'` value. Not-applicable is not a
   * fact the database holds — it is INFERRED from "a `done` event with no
   * `external_identities` row", which is what a connector that threw
   * `NotApplicableError` leaves behind (see SyncWorker.reconcileUser).
   * Inventing a value here would imply a durable state that nothing writes
   * or reads. Such a target reports `'synced'` — settled, nothing
   * outstanding — and its null `externalId` is what distinguishes it for
   * anyone who looks.
   */
  state: SyncState
  externalId: string | null
  lastSyncedAt: Date | null
  latestEvent: UserSyncLatestEvent | null
}

export interface BlockingGroup {
  groupId: string
  groupName: string
  target: OutboxTarget
  status: 'pending' | 'processing' | 'failed'
  attempts: number
}

export interface UserSyncDetail {
  /**
   * Identical to the badge's own value — computed by `SyncStateRepository`,
   * never recomputed here, so a panel can never contradict the badge it
   * exists to explain.
   */
  syncState: SyncState
  targets: UserSyncTargetDetail[]
  blockedByGroups: BlockingGroup[]
  /** `true` when the controller withheld raw connector error text because the caller lacks a GLOBAL `audit:read` grant. The console must SAY so rather than render an empty error cell, which would read as "no error". */
  errorDetailRedacted: boolean
}

// `type` aliases, not interfaces — `db.execute<TRow>` requires TRow to
// structurally satisfy `Record<string, unknown>`, which only a type-literal
// alias gets from TypeScript. Same reasoning as SyncStateRepository's own
// row types and OutboxRepository's RawClaimRow.
type TargetEventRow = {
  target: OutboxTarget
  id: string
  event_type: OutboxEventType
  status: 'pending' | 'processing' | 'done' | 'failed'
  attempts: number
  created_at: Date
  next_attempt_at: Date
  last_error: string | null
}

type BlockingGroupRow = {
  group_id: string
  group_name: string
  target: OutboxTarget
  status: 'pending' | 'processing' | 'failed'
  attempts: number
}

/**
 * The per-user, per-target breakdown behind `GET /users/:id/sync` — the
 * explanation for whatever `SyncStateRepository` derived (2026-08-08
 * sync-diagnostics spec).
 *
 * A separate class rather than more methods on `SyncStateRepository`:
 * deriving one enum value and listing raw rows for display are different
 * jobs with different shapes, and that file is already dense with the
 * reasoning behind the derivation itself.
 *
 * Exists because the ONLY window into sync health used to be
 * `GET /outbox/dead-letters` — global-`audit:read`-gated, `status = 'failed'`
 * only, and not per user. An event stuck `pending`/`processing` (mid-backoff,
 * or head-of-line blocked behind an older event for the same aggregate and
 * target) was visible nowhere at all, so a warn badge that never cleared had
 * no diagnosis short of a database session.
 */
@Injectable()
export class SyncDetailRepository {
  constructor(
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
    @Inject(SyncStateRepository) private readonly syncStates: SyncStateRepository,
    @Inject(GroupsRepository) private readonly groups: GroupsRepository,
  ) {}

  async describeForUser(userId: string): Promise<UserSyncDetail> {
    // Per-organization connector targets: the panel lists the targets THIS
    // user's own organization has enabled — the same organization-scoped
    // read `OutboxWriter.record` fans out by, so the panel never shows a
    // target the writer would not even emit for against this person.
    const [userRow] = await this.db
      .select({ organizationId: users.organizationId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    const targetRows =
      userRow === undefined
        ? []
        : await this.db
            .select({ target: connectorTargets.target })
            .from(connectorTargets)
            .where(
              and(eq(connectorTargets.enabled, true), eq(connectorTargets.organizationId, userRow.organizationId)),
            )
    const targets = targetRows.map((row) => row.target)

    const syncState = await this.syncStates.resolveForUser(userId)

    if (targets.length === 0) {
      return { syncState, targets: [], blockedByGroups: [], errorDetailRedacted: false }
    }

    const [events, identityRows, blocking] = await Promise.all([
      this.latestEventPerTarget(userId, targets),
      this.db
        .select({
          system: externalIdentities.system,
          externalId: externalIdentities.externalId,
          syncState: externalIdentities.syncState,
          lastSyncedAt: externalIdentities.lastSyncedAt,
        })
        .from(externalIdentities)
        .where(and(eq(externalIdentities.userId, userId), inArray(externalIdentities.system, targets))),
      this.blockingGroups(userId, targets),
    ])

    const eventByTarget = new Map(events.map((row) => [row.target, row]))
    const identityByTarget = new Map(identityRows.map((row) => [row.system, row]))

    const targetDetails: UserSyncTargetDetail[] = targets.map((target) => {
      const event = eventByTarget.get(target)
      const identity = identityByTarget.get(target)
      return {
        target,
        enabled: true,
        state: perTargetState(event?.status, identity?.syncState),
        externalId: identity?.externalId ?? null,
        lastSyncedAt: identity?.lastSyncedAt ?? null,
        latestEvent:
          event === undefined
            ? null
            : {
                id: Number(event.id),
                eventType: event.event_type,
                status: event.status,
                attempts: event.attempts,
                createdAt: event.created_at,
                nextAttemptAt: event.next_attempt_at,
                lastError: event.last_error,
              },
      }
    })

    return { syncState, targets: targetDetails, blockedByGroups: blocking, errorDetailRedacted: false }
  }

  /**
   * The latest `user`-aggregate event for this user, per target. Same
   * `DISTINCT ON (…, target)` shape `SyncStateRepository` uses, narrowed to
   * one user — see that class's `latestUserEvents` doc comment for why the
   * target dimension is load-bearing rather than cosmetic, and why the
   * comparison casts the COLUMN to text rather than the parameter array to
   * the enum type.
   */
  private async latestEventPerTarget(userId: string, targets: OutboxTarget[]): Promise<TargetEventRow[]> {
    const { rows } = await this.db.execute<TargetEventRow>(sql`
      SELECT DISTINCT ON (target)
             target, id, event_type, status, attempts, created_at, next_attempt_at, last_error
        FROM outbox_events
       WHERE aggregate_type = 'user'
         AND aggregate_id = ${userId}::uuid
         AND target::text = ANY(${sql.param(targets)}::text[])
       ORDER BY target, id DESC
    `)
    return rows
  }

  /**
   * Groups whose own latest event is unsettled AND which this user is
   * currently an effective member of. Mirrors `SyncStateRepository`'s group
   * half so the panel names exactly what the badge reacted to. Group
   * traversal is delegated to `GroupsRepository.listEffectiveGroupsForUser`
   * — the forward direction of the walk `SyncStateRepository` runs backwards
   * — rather than inlining a second recursive CTE here.
   *
   * Deliberately covers the `group` aggregate only, not `membership`: a
   * membership event's affected user is carried in its own payload rather
   * than being a property of the group, and naming "the group you were
   * REMOVED from" as a current blocker would read as though the user were
   * still in it. The badge still reflects those events (SyncStateRepository
   * is unchanged in that respect); this list simply does not claim a
   * membership the user no longer has.
   */
  private async blockingGroups(userId: string, targets: OutboxTarget[]): Promise<BlockingGroup[]> {
    const groupIds = await this.groups.listEffectiveGroupsForUser(userId)
    if (groupIds.length === 0) return []

    const { rows } = await this.db.execute<BlockingGroupRow>(sql`
      SELECT e.aggregate_id AS group_id, g.name AS group_name, e.target, e.status, e.attempts
        FROM (
          SELECT DISTINCT ON (aggregate_id, target) aggregate_id, target, status, attempts
            FROM outbox_events
           WHERE aggregate_type = 'group'
             AND aggregate_id = ANY(${sql.param(groupIds)}::uuid[])
             AND target::text = ANY(${sql.param(targets)}::text[])
           ORDER BY aggregate_id, target, id DESC
        ) e
        JOIN groups g ON g.id = e.aggregate_id
       WHERE e.status IN ('pending', 'processing', 'failed')
       ORDER BY g.name, e.target
    `)

    return rows.map((row) => ({
      groupId: row.group_id,
      groupName: row.group_name,
      target: row.target,
      status: row.status,
      attempts: row.attempts,
    }))
  }
}
