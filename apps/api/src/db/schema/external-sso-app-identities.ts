import { pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core'
import { externalIdentitySyncState, externalIdentitySystem } from './external-identities'
import { ssoApps } from './sso-apps'

/**
 * Correlates an `sso_apps` row with the client Keycloak created for it.
 * Mirrors `external_group_identities` exactly — same columns, same
 * unique-per-(subject, system) shape, same reuse of the two enums.
 *
 * `externalId` is the immutable UUID Keycloak assigns a client, NEVER
 * `clientId`. A Keycloak admin can rename `clientId` directly; correlating on
 * it would turn that rename into an orphaned client plus a second, empty one
 * on the next sync — the failure mode docs/09 calls "not a cosmetic bug".
 * Correlating on the UUID makes the same rename self-correcting instead.
 *
 * The `system` column reuses `external_identity_system` rather than getting a
 * one-value enum of its own, so it stays assignable directly from
 * `event.target` with no mapping table — the same property that lets
 * SyncWorker write `external_identities.system` straight from the event.
 */
export const externalSsoAppIdentities = pgTable(
  'external_sso_app_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: uuid('app_id')
      .notNull()
      .references(() => ssoApps.id, { onDelete: 'cascade' }),
    system: externalIdentitySystem('system').notNull(),
    externalId: varchar('external_id', { length: 255 }).notNull(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    syncState: externalIdentitySyncState('sync_state').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    appSystemUnique: uniqueIndex('external_sso_app_identities_app_system_unique').on(
      table.appId,
      table.system,
    ),
  }),
)
