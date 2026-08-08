import { pgEnum, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core'
import { users } from './users'

// The directory backend an identity is correlated with. Only 'keycloak' has
// a consumer this milestone (Task 3's sync worker); 'active_directory' and
// 'google_workspace' are named now so the unique-per-(user, system) shape
// does not need a migration when a second backend arrives.
//
// Milestone 10, Task 2: widened to add `'entra_id'` (this enum's original
// comment above anticipated `active_directory`/`google_workspace` but not
// it — see outbox-events.ts's `outboxTarget` doc comment, which explicitly
// left widening THIS enum for entra_id to this task) and `'echo'` (the
// in-repo target — see the SAME doc comment for why it is a genuine,
// migrated-in enum member rather than a test-only value). Every value here
// now matches `outboxTarget` one-for-one, so `SyncWorker` can write a
// correlation row using `event.target` directly as `system`, with no mapping
// table between the two enums.
export const externalIdentitySystem = pgEnum('external_identity_system', [
  'keycloak',
  'active_directory',
  'entra_id',
  'google_workspace',
  'echo',
  'mail_server',
])

// Reflects whether THIS row's `external_id` is currently believed to match
// this system's desired state, independent of `outbox_events` — a row can
// regress from 'synced' to 'failed' on a later reconciliation attempt even
// though its `external_id`/`last_synced_at` still hold the last known-good
// values. Task 4's user-facing `syncState` is a further-derived combination
// of this column with any pending/failed outbox events for the user (see
// the milestone plan) — this column alone is the per-external-system fact,
// not that derived read-model value.
export const externalIdentitySyncState = pgEnum('external_identity_sync_state', [
  'pending',
  'synced',
  'failed',
])

/**
 * Sync correlation only — this milestone deliberately keeps principal
 * resolution on `users.username` (decision 1 in the milestone plan); this
 * table exists so the sync worker (Task 3) knows which Keycloak (etc.) row
 * corresponds to which local user, not to authenticate against. Nothing
 * writes this table until Task 3.
 */
export const externalIdentities = pgTable(
  'external_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    system: externalIdentitySystem('system').notNull(),
    externalId: varchar('external_id', { length: 255 }).notNull(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    syncState: externalIdentitySyncState('sync_state').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // A user has at most one row per backend. Not partial (unlike
    // role_assignments' two indexes) — every column here is always
    // non-null, so one plain unique index covers it, and — being a full,
    // non-partial index leading with user_id — it also serves a plain
    // "WHERE user_id = ?" lookup with no separate index needed (contrast
    // role_assignments, whose partial indexes cannot serve that and so keep
    // an extra plain one — see db/schema/role-assignments.ts).
    userSystemUnique: uniqueIndex('external_identities_user_system_unique').on(
      table.userId,
      table.system,
    ),
  }),
)
