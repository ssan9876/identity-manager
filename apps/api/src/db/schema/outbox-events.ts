import {
  bigserial,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

// The AGGREGATE a row describes — what Postgres table the mutation actually
// touched, in Keycloak-relevant terms. 'membership' is deliberately its own
// aggregate, distinct from 'group': a `group_user_members`/`group_group_members`
// row is a pure edge with no id of its own (see GroupsController's doc
// comment on `requireGroup`), so a membership mutation is anchored on the
// PARENT group's id but is NOT the same stream as that group's own
// name/description/attributes — see outbox.writer.ts's doc comment on why
// role assignment mutations, by contrast, are emitted as a 'user' aggregate
// rather than getting a fifth value here.
export const outboxAggregateType = pgEnum('outbox_aggregate_type', [
  'user',
  'group',
  'membership',
  'org_unit',
])

// There is deliberately NO 'deleted' value — this system has no delete for
// any aggregate (users terminate at `deactivated`; groups, org units and
// memberships are only ever created/updated/removed-as-edges). Removal
// propagates as 'status_changed' carrying `deactivated` in the payload, not
// as a distinct event type — see UsersController's deactivate handler.
export const outboxEventType = pgEnum('outbox_event_type', [
  'created',
  'updated',
  'status_changed',
  'membership_changed',
])

// Milestone 10, Task 1: widened from a single value (`'keycloak'` only) to
// all four directory backends the connector spine will eventually push to.
// `external_identities.system` already anticipated `active_directory` and
// `google_workspace`; `entra_id` is new here (external_identities has no
// Entra row yet because nothing correlates against it until Milestone 12 —
// widening THAT enum too, ahead of a consumer, is left for Task 2 rather
// than done speculatively here).
//
// Widening this enum is only half the change — see `connectorTargets` below
// (which target the WRITER actually fans out to) and `OutboxRepository.
// claimNext`'s doc comment (outbox.repository.ts) for the other, load-bearing
// half: per-aggregate ordering had to become per-(aggregate, target) in the
// SAME change, or a stalled `active_directory`/`entra_id`/`google_workspace`
// delivery for a user would head-of-line block every later `keycloak` event
// for that SAME user — see this file's own `aggregateIdx` doc comment below.
//
// Milestone 10, Task 2: `'echo'` added — the in-repo target that proves the
// connector spine end-to-end (registry, per-target dispatch, secret
// resolution, `external_identities` correlation) before a single line of
// vendor protocol exists. It is a genuine `outbox_target`/`connector_targets`
// citizen, not a test-only bypass of this enum, because Milestone 14's
// console E2E configures and drives it through the SAME real spine (enable
// it in `connector_targets`, dry-run, apply, watch health go green) that AD/
// Entra/Google will use — see docs/archive/plans/2026-08-06-idp-
// milestones-10-14-directory-connectors.md, Milestone 14 Task 9. Like
// `entra_id` above, `external_identities.system` (external-identities.ts)
// is widened in the SAME migration to keep correlation writes possible for
// it. No `connector_targets` row is seeded for `'echo'` by any migration —
// same reasoning `connector-targets.ts`'s doc comment already gives for the
// other three non-keycloak targets (Postgres forbids using a value added by
// `ALTER TYPE ... ADD VALUE` within the same transaction that added it, and
// every pending migration runs in ONE transaction on a fresh database) —
// tests that need it enabled insert/delete their own row directly, exactly
// like outbox-emission.spec.ts's `active_directory` fan-out tests already do.
export const outboxTarget = pgEnum('outbox_target', [
  'keycloak',
  'active_directory',
  'entra_id',
  'google_workspace',
  'echo',
  // Sub-project 4 — the mail server (D:\mail-server), whose own receiving
  // half is already built and merged. Unlike every target above it, this one
  // addresses a principal by OUR user id rather than by an id of its own —
  // see `DesiredUser.userId`'s doc comment (connectors/connector.ts).
  'mail_server',
])

export const outboxStatus = pgEnum('outbox_status', [
  'pending',
  'processing',
  'done',
  'failed',
])

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),

    // No FK: the table this id lives in depends on `aggregateType`, exactly
    // like `audit_log.resource_id` is FK-less for the same reason (see
    // db/schema/audit-log.ts) — a single column cannot reference four
    // different tables at once.
    aggregateType: outboxAggregateType('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),

    eventType: outboxEventType('event_type').notNull(),

    // Diagnostic and ordering context only — the worker (Milestone 4, Task 3)
    // reconciles by reading the CURRENT row from Postgres and asserting full
    // desired state into Keycloak; it never replays this as a delta. See
    // outbox.writer.ts's doc comment.
    payload: jsonb('payload').notNull(),

    target: outboxTarget('target').notNull().default('keycloak'),
    status: outboxStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),

    // Defaults to now(): a freshly written event is immediately claimable by
    // the worker's `status = 'pending' AND next_attempt_at <= now()` query,
    // with no separate "activate" step.
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text('last_error'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // Supports the worker's claim query (Task 3): `WHERE status = 'pending'
    // AND next_attempt_at <= now() ORDER BY next_attempt_at ... FOR UPDATE
    // SKIP LOCKED`. Added now, not in Task 3, so that task needs no schema
    // migration of its own.
    claimIdx: index('outbox_events_status_next_attempt_idx').on(
      table.status,
      table.nextAttemptAt,
    ),
    // Supports strict per-(aggregate, TARGET) ordering (Task 3; widened to
    // include `target` in Milestone 10, Task 1 — THE load-bearing change of
    // that task, alongside `OutboxRepository.claimNext`'s SQL below it
    // serves). "never process an event for an aggregate+target that has an
    // older pending/processing event for that SAME target" is exactly
    // `WHERE aggregate_type = ? AND aggregate_id = ? AND target = ? ORDER BY
    // id LIMIT 1`, which this composite index serves directly — `id`
    // trailing still gives the worker the lowest-id-per-(aggregate,target)
    // scan for free, now with `target` as an equality column ahead of it
    // rather than folded into the ORDER BY.
    //
    // `target` was inserted BETWEEN `aggregateId` and `id`, not appended
    // after `id` — column order in a composite btree index is not
    // interchangeable: an index only serves an equality-then-range/order
    // query pattern when its equality columns (aggregateType, aggregateId,
    // target — all three are always `=` in claimNext's WHERE/NOT EXISTS) lead
    // and the ORDER BY/range column (id) trails. Reversing that (e.g.
    // `..., id, target`) would force a full scan of every id for the
    // aggregate before target could narrow anything — correct results, much
    // worse plan. This is Task 1's own stated trap: the predicate and this
    // index must change TOGETHER, in the SAME shape, or the fix is either
    // wrong or slow.
    //
    // FORMER trade-off, resolved 2026-08-08 (sync-diagnostics spec).
    // `SyncStateRepository`'s `latestUserEvents`/
    // `latestEventsForAggregateType`/`latestMembershipEvents` used to run
    // `DISTINCT ON (aggregate_id) ... ORDER BY aggregate_id, id DESC`, which
    // does not constrain `target` at all — so once `target` was inserted
    // between `aggregate_id` and `id`, Postgres could no longer walk this
    // index in a single pre-sorted pass for "max id per aggregate_id" and
    // fell back to an equality-prefix scan plus an explicit sort.
    //
    // That was accepted on the reasoning that the read model "stays
    // intentionally Keycloak-scoped (Milestone 10, Task 1 seeds no other
    // target as enabled)". Enabling `mail_server` ended that, and the same
    // assumption turned out to be the root of a real defect, not just a
    // performance note: a dead-lettered mail event outranked a healthy
    // Keycloak sync for the same user and the badge could never recover.
    // See SyncStateRepository's own doc comment.
    //
    // Those queries now group per (aggregate, target) —
    // `DISTINCT ON (aggregate_id, target) ... ORDER BY aggregate_id, target,
    // id DESC` — which is exactly this index's column order after the
    // `aggregate_type` equality prefix, so the sort is served by the index
    // again rather than materialized. The correctness fix and the plan
    // improvement were the same edit.
    aggregateIdx: index('outbox_events_aggregate_idx').on(
      table.aggregateType,
      table.aggregateId,
      table.target,
      table.id,
    ),
  }),
)
