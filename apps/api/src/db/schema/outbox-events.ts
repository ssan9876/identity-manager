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

// Single value today, on purpose: this milestone only ever pushes to
// Keycloak. `external_identities.system` already anticipates more directory
// backends (`active_directory`, `google_workspace`); this enum stays
// single-valued until an outbox consumer for one of those actually exists,
// rather than speculatively widening a sync-target vocabulary nothing reads.
export const outboxTarget = pgEnum('outbox_target', ['keycloak'])

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
    // Supports strict per-aggregate ordering (Task 3): "never process an
    // event for an aggregate that has an older pending/processing event" is
    // exactly `WHERE aggregate_type = ? AND aggregate_id = ? ORDER BY id
    // LIMIT 1`, which this composite index serves directly — `id` trailing
    // gives the worker the lowest-id-per-aggregate scan for free.
    aggregateIdx: index('outbox_events_aggregate_idx').on(
      table.aggregateType,
      table.aggregateId,
      table.id,
    ),
  }),
)
