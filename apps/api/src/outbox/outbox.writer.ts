import { Injectable } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { ConnectorTarget } from '../connectors/connector'
import { connectorTargets } from '../db/schema/connector-targets'
import { groups } from '../db/schema/groups'
import { orgUnits } from '../db/schema/org-units'
import { organizations } from '../db/schema/organizations'
import { outboxEvents } from '../db/schema/outbox-events'
import { userTargetAccounts } from '../db/schema/user-target-accounts'
import { users } from '../db/schema/users'
import * as schema from '../db/schema/index'
import { targetsForAggregate } from './target-fanout'

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

// The array is the source and the union DERIVES from it — same discipline as
// `ALL_CONNECTOR_TARGETS` (connectors/connector.ts), and for the same reason:
// `targetsForAggregate` (target-fanout.ts) must be exhaustively testable
// against every aggregate that exists, which needs the values at RUNTIME.
// `test/connector-target-catalog.spec.ts` asserts this matches the
// `outbox_aggregate_type` pgEnum in both directions.
export const ALL_OUTBOX_AGGREGATE_TYPES = [
  'user',
  'group',
  'membership',
  'org_unit',
  'sso_app',
  // Organizations milestone, Task 10. Adding it here without also
  // classifying it in `targetsForAggregate` fails
  // test/target-fanout.spec.ts's catalog assertion by construction — which
  // is precisely why that assertion exists.
  'organization',
] as const

export type OutboxAggregateType = (typeof ALL_OUTBOX_AGGREGATE_TYPES)[number]

// No 'deleted' value — see db/schema/outbox-events.ts's doc comment on
// `outboxEventType`. Removal propagates as 'status_changed' carrying
// `deactivated` in the payload.
export type OutboxEventType = 'created' | 'updated' | 'status_changed' | 'membership_changed'

// Milestone 10, Task 1 — mirrors `outboxTarget` (db/schema/outbox-events.ts).
// Milestone 10, Task 2 — re-exported from `connectors/connector.ts`'s
// `ConnectorTarget` rather than re-hand-rolled here a second time: the
// outbox is a CALLER of the connector spine (SyncWorker dispatches
// per-target through `ConnectorRegistry`), so it depends on that module's
// canonical type instead of maintaining an independent, driftable copy —
// see `ConnectorTarget`'s own doc comment for why THAT module is the
// canonical home. Deliberately NOT part of `OutboxEvent` below: which
// target(s) a mutation reaches is decided by `OutboxWriter.record` itself
// (one row per row in `connector_targets` with `enabled = true`), never by
// the caller — see `record`'s own doc comment.
export type OutboxTarget = ConnectorTarget

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
   * every outbox row this writes and the mutation it describes commit or
   * roll back together — the entire reason this milestone needs no
   * distributed transaction between Postgres and each target. `DbHandle`
   * accepts only a live transaction handle — the pooled handle does not
   * satisfy the type, so the compiler rejects it — meaning a standalone
   * write must go through `db.transaction(async (tx) => writer.record(tx,
   * event))`. Same reasoning, same shape, as `AuditWriter.record` — every
   * write handler calls both from inside the SAME `tx`.
   *
   * MILESTONE 10, TASK 1 — fan-out. `record` no longer writes exactly one
   * row: it writes one row per currently-`enabled` row in `connector_targets`
   * that this particular aggregate is ENTITLED to reach (see "ENTITLEMENT"
   * below — Milestone 18, Task 13 — for the second half of that sentence;
   * before it, entitlement did not exist and every enabled target simply
   * received a row) (design doc decision 6: "One event row per (mutation ×
   * target). Fan-out happens at write time."), reading that table through
   * the SAME `tx` — see
   * this method's own connection-discipline note below. A target that is
   * not enabled — whether because its `connector_targets` row has `enabled
   * = false`, or because no row for it exists at all yet (both mean the
   * same thing to the query below) — gets NO row, full stop: not a row that
   * later fails, not a row skipped at claim time, nothing an operator would
   * ever see in `/outbox/dead-letters`. Since the Task 1 migration seeds
   * only `('keycloak', enabled: true)`, this is, for now, still exactly one
   * row per call — the existing Keycloak behaviour is unchanged in practice,
   * not just in intent (see outbox-emission.spec.ts's pre-existing,
   * unmodified assertions, which remain the regression net for that claim).
   *
   * `target`, `status`, `attempts`, `nextAttemptAt`, `lastError` are still
   * never caller-supplied — `event: OutboxEvent` has no `target` field at
   * all (see `OutboxTarget`'s own doc comment above: fan-out is decided
   * HERE, never by the caller): every new row starts life at `status:
   * 'pending'`, `attempts: 0`, `nextAttemptAt: now()` (the column defaults
   * in db/schema/outbox-events.ts), `target` set to whichever enabled row
   * produced it. Those fields belong to the worker (Task 3), which owns
   * every transition away from that starting state.
   *
   * SSO APPLICATIONS — fan-out is now AGGREGATE-AWARE. The enabled-target
   * list is filtered through `targetsForAggregate` (target-fanout.ts) before
   * any row is written: an `sso_app` event reaches only `keycloak_sso`, and
   * every other aggregate reaches every enabled target EXCEPT
   * `keycloak_sso`. Without that filter an application would be handed to
   * Active Directory, Entra and Google, none of which know what an
   * application is, and every one of those rows would fail, retry and
   * dead-letter. Note the early return now tests the FILTERED list: a
   * `keycloak_sso`-only event with that target disabled writes nothing at
   * all, which is the same "not enabled means no row, full stop" rule the
   * paragraph above describes.
   *
   * ENTITLEMENT (MILESTONE 18, TASK 13) — fan-out is now also
   * PROVISIONING-MODE-AWARE. Each enabled target carries a
   * `provisioning_mode` (`connector_targets.provisioning_mode`, Milestone
   * 15 Task 3):
   *
   *  - `all_users` — the DEFAULT, and what every pre-business-roles row
   *    was backfilled to. Such a target receives a row for every aggregate,
   *    exactly as it did before this task existed. That is the whole safety
   *    property of this change: the default reproduces the old behaviour
   *    bit for bit, so shipping business roles cannot silently stop
   *    provisioning anybody. test/outbox-emission.spec.ts is the regression
   *    net for that claim and passes here UNMODIFIED — if it ever needed
   *    editing to go green, the default would no longer be preserving the
   *    old behaviour, and THAT would be the bug.
   *  - `entitled_only` — the opt-in an operator moves one target onto once
   *    the business roles feeding it have been simulated. A `user`
   *    aggregate reaches such a target ONLY if it holds a
   *    `user_target_accounts` row for it (the account-existence grant kind
   *    a business role produces — see that table's own doc comment).
   *
   * ONLY a `user` aggregate has an account entitlement to consult. Groups,
   * memberships, org units and sso_apps have no rows in
   * `user_target_accounts` at all, so they fan out to every enabled target
   * exactly as before — an `entitled_only` target must not silently stop
   * receiving GROUP syncs just because groups can never be "entitled". The
   * entitlement read is skipped entirely when no enabled target is in
   * `entitled_only` mode, which is every deployment until an operator opts
   * one in: no extra query is paid for a feature nobody has turned on.
   *
   * Note what this does NOT do: it never revokes. A user who loses their
   * entitlement simply stops matching the filter here, which on its own
   * would leave a live, unmanaged account in the target forever. Emitting
   * the explicit `disable` for that case is `RoleReconciler.reconcileUser`'s
   * job (Milestone 18, Task 14), which writes that row DIRECTLY rather than
   * through this method — by then the `user_target_accounts` row it would
   * consult here has already been deleted in the same transaction, so this
   * method would correctly, and uselessly, decide there was nothing to send.
   *
   * CONNECTION DISCIPLINE: both the `connector_targets` read and the
   * `outbox_events` insert(s) below run against the SAME `tx` the caller
   * already holds open — never `this.db` or any second pooled connection.
   * This project has previously deadlocked its own connection pool by
   * opening a transaction and then calling something that checked out a
   * SECOND connection from the same pool while the first sat open (finding
   * C1, docs/archive/audits/audit-integrity.md; regression-guarded by
   * test/pool-exhaustion.spec.ts) — this method has no injected `DB_CLIENT`
   * at all (constructor takes nothing, exactly as before this task), so
   * there is no pool handle here it COULD reach for by mistake.
   */
  async record(tx: DbHandle, event: OutboxEvent): Promise<void> {
    const enabledTargets = await tx
      .select({ target: connectorTargets.target, provisioningMode: connectorTargets.provisioningMode })
      .from(connectorTargets)
      .where(eq(connectorTargets.enabled, true))
      .orderBy(connectorTargets.target)

    // Aggregate-shape filter FIRST (sso_app vs everything else), then the
    // entitlement filter below. Order matters only for cost: a
    // `keycloak_sso`-only event never pays for a `user_target_accounts`
    // read, because `sso_app` is not a `user` aggregate anyway.
    const aggregateTargets = targetsForAggregate(
      event.aggregateType,
      enabledTargets.map(({ target }) => target),
    )

    // ORGANIZATION-AWARE FAN-OUT (organizations milestone, Task 13). A
    // TENANT's mutations reach `keycloak` and nothing else — see
    // `belongsToMasterTenant` below for the whole reasoning. Applied AFTER
    // the aggregate-shape filter and BEFORE the entitlement filter purely
    // for cost: a tenant event that is already down to `keycloak` alone can
    // never be an `entitled_only` target, so it never pays for the
    // `user_target_accounts` read below.
    const tenantTargets = (await this.belongsToMasterTenant(tx, event))
      ? aggregateTargets
      : aggregateTargets.filter((target) => target === 'keycloak')

    // Only a `user` aggregate has an account entitlement to consult, and
    // only an `entitled_only` target consults one — see this method's own
    // "ENTITLEMENT" note above for both halves of that sentence. Everything
    // else short-circuits to zero extra queries.
    const entitledOnlyTargets = new Set(
      enabledTargets
        .filter((row) => row.provisioningMode === 'entitled_only')
        .map((row) => row.target),
    )

    const consultsEntitlement =
      event.aggregateType === 'user' && tenantTargets.some((target) => entitledOnlyTargets.has(target))

    let entitled: Set<ConnectorTarget> = new Set()
    if (consultsEntitlement) {
      // Same `tx` as everything else here — see CONNECTION DISCIPLINE
      // below. Deliberately unfiltered by target: a user holds at most one
      // row per target (`user_target_accounts_unique`), so this is a single
      // indexed read of a handful of rows, not a scan.
      const rows = await tx
        .select({ target: userTargetAccounts.target })
        .from(userTargetAccounts)
        .where(eq(userTargetAccounts.userId, event.aggregateId))
      entitled = new Set(rows.map((row) => row.target))
    }

    // `consultsEntitlement` gates the FILTER as well as the read: for a
    // non-`user` aggregate, `entitled` is empty because there was nothing to
    // look up, NOT because the aggregate is unentitled, so filtering on it
    // would drop every group/org-unit sync to an `entitled_only` target.
    const targets = consultsEntitlement
      ? tenantTargets.filter((target) => !entitledOnlyTargets.has(target) || entitled.has(target))
      : tenantTargets

    if (targets.length === 0) {
      return
    }

    await tx.insert(outboxEvents).values(
      targets.map((target) => ({
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: event.payload,
        target,
      })),
    )
  }

  /**
   * Whether this event's aggregate belongs to the MASTER organization — or
   * to no organization at all, which is the same thing for fan-out purposes.
   *
   * WHY A TENANT REACHES KEYCLOAK AND NOTHING ELSE. Per-organization
   * connector targets do not exist: `connector_targets` is keyed by TARGET
   * alone, so there is exactly one Active Directory configuration, one Entra
   * configuration, one Google configuration and one mail-server
   * configuration for the whole system, and every one of them belongs to
   * whoever runs the platform. Fanning a tenant out to those would push that
   * tenant's people into a directory configured for a DIFFERENT tenant —
   * creating real accounts, with real addresses, in someone else's estate.
   * Keycloak is the one target that is genuinely per-organization, because a
   * realm is (`organizations.realm`, and `KeycloakAdminClientFactory`
   * resolves a client per realm). Master keeps today's behaviour exactly,
   * bit for bit — which is what lets every pre-existing assertion in
   * test/outbox-emission.spec.ts stand unmodified as the regression net for
   * that claim.
   *
   * DERIVED HERE, from the aggregate's own row, rather than passed in by the
   * caller. This is a deliberate deviation from the milestone plan, which
   * had `OutboxEvent` gain an `organizationId` field threaded through all
   * two dozen `record` call sites. Deriving it is strictly safer for the
   * same reason `SyncWorker` reconciles by re-reading rather than replaying
   * `payload`: there is exactly ONE implementation of "which tenant is
   * this", it cannot be forgotten by a call site added later, and it cannot
   * disagree with the row that was actually written. A caller-supplied field
   * would have made cross-tenant fan-out — the precise failure this method
   * exists to prevent — a single mistyped argument away, at any of those
   * sites, forever.
   *
   * The mapping below is TOTAL over `ALL_OUTBOX_AGGREGATE_TYPES`, and the
   * compiler enforces that: the `switch` returns from every arm, so adding a
   * seventh aggregate type without classifying it here fails to compile
   * rather than silently defaulting to one answer or the other.
   *
   *  - `user`/`group`/`org_unit` carry `organization_id` themselves.
   *  - `membership` is a pure edge with no id of its own; its `aggregateId`
   *    is the PARENT GROUP's id (see GroupsController's own doc comment on
   *    that choice), so it resolves through `groups`.
   *  - `organization` IS its own tenant — the row named by `aggregateId` is
   *    the answer, no join needed.
   *  - `sso_app` has no `organization_id` column and deliberately never will
   *    in this milestone: an SSO application is registered in the master
   *    realm and is platform-level, so it takes master's fan-out. That is
   *    also moot in practice — `targetsForAggregate` has already narrowed it
   *    to `keycloak_sso` alone before this runs.
   *
   * A MISSING ROW answers `false` (tenant treatment, Keycloak only), not
   * `true`. It should be unreachable — `record` is always called inside the
   * transaction that just wrote the row it describes — so reaching it means
   * something is wrong, and the conservative answer to "which tenant's
   * directory should this account be created in?" when the answer is unknown
   * is "none of the shared ones". The event is still written, so nothing is
   * silently dropped and an operator can see it.
   *
   * Same `tx` as everything else here — see `record`'s own CONNECTION
   * DISCIPLINE note.
   */
  private async belongsToMasterTenant(tx: DbHandle, event: OutboxEvent): Promise<boolean> {
    switch (event.aggregateType) {
      case 'sso_app':
        return true
      case 'organization': {
        const [row] = await tx
          .select({ isMaster: organizations.isMaster })
          .from(organizations)
          .where(eq(organizations.id, event.aggregateId))
        return row?.isMaster ?? false
      }
      case 'user': {
        const [row] = await tx
          .select({ isMaster: organizations.isMaster })
          .from(users)
          .innerJoin(organizations, eq(organizations.id, users.organizationId))
          .where(eq(users.id, event.aggregateId))
        return row?.isMaster ?? false
      }
      case 'group':
      case 'membership': {
        const [row] = await tx
          .select({ isMaster: organizations.isMaster })
          .from(groups)
          .innerJoin(organizations, eq(organizations.id, groups.organizationId))
          .where(eq(groups.id, event.aggregateId))
        return row?.isMaster ?? false
      }
      case 'org_unit': {
        const [row] = await tx
          .select({ isMaster: organizations.isMaster })
          .from(orgUnits)
          .innerJoin(organizations, eq(organizations.id, orgUnits.organizationId))
          .where(eq(orgUnits.id, event.aggregateId))
        return row?.isMaster ?? false
      }
    }
  }
}
