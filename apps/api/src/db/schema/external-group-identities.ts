import { pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core'
import { externalIdentitySyncState, externalIdentitySystem } from './external-identities'
import { groups } from './groups'

/**
 * Milestone 11, Task 6 — the GROUP-side mirror of `external_identities`
 * (which is user-only: its `user_id` column is `NOT NULL` and references
 * `users` alone — see that table's own doc comment). A separate table,
 * deliberately, rather than widening `external_identities` into a
 * polymorphic (nullable-user-id-or-group-id) shape: `external_identities` is
 * heavily load-bearing for every existing target (`SyncWorker.
 * markUserSyncFailed`/`findExistingExternalId`, the whole outbox dead-letter
 * regression path, its own unique index), and every one of those assumes
 * `user_id` is always present. A second, small, single-purpose table with
 * the IDENTICAL shape costs nothing extra to reason about and touches none
 * of that surface.
 *
 * Reuses `external_identity_system`/`external_identity_sync_state` — the
 * SAME two enums `external_identities` already defines — rather than minting
 * new ones: a group's correlation is the same kind of fact (which remote
 * system, which immutable id, is it currently believed to match desired
 * state) as a user's, just keyed by group instead of user.
 *
 * Populated by `SyncWorker.reconcileAdStyleGroup` (sync.worker.ts) the same
 * way `external_identities` is populated by `SyncWorker.reconcileUser`: one
 * row per (group, target), upserted after every successful
 * `DirectoryGroupConnector.applyGroup` call. `external_id` is AD's own
 * `objectGUID` (dashed-string form — see `ad-guid.ts`) for `target =
 * 'active_directory'`, the SAME immutable-id convention Task 5 established
 * for users — never a DN, never a name; both move.
 *
 * THIS IS WHAT MAKES NATIVE AD NESTING POSSIBLE: a group-to-group `member`
 * edge can only be written once the CHILD group has its own AD DN to point
 * at, which requires knowing whether the child has ever successfully synced
 * — this table is the ONLY place that fact lives. See
 * `ActiveDirectoryConnector`'s own "nesting decision" doc comment for the
 * full native-nesting-vs-flatten rule this correlation makes possible.
 */
export const externalGroupIdentities = pgTable(
  'external_group_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
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
    // A group has at most one row per backend — same "full, non-partial,
    // leading-column-first" shape as `external_identities`'
    // `userSystemUnique` (see that index's own doc comment for why this
    // also serves a plain "WHERE group_id = ?" lookup with no separate
    // index needed).
    groupSystemUnique: uniqueIndex('external_group_identities_group_system_unique').on(
      table.groupId,
      table.system,
    ),
  }),
)
