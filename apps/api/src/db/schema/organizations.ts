import { sql } from 'drizzle-orm'
import {
  boolean, check, pgEnum, pgTable, timestamp, uniqueIndex, uuid, varchar,
} from 'drizzle-orm/pg-core'

export const organizationStatus = pgEnum('organization_status', ['active', 'suspended'])

/**
 * A tenant. Owns exactly one root org unit (except master — see the design's
 * decision 6) and exactly one Keycloak realm.
 *
 * There is deliberately NO `root_org_unit_id` column: it would form a FK
 * cycle with `org_units.organization_id`, and "non-null unless master"
 * cannot be a CHECK, because checks are immediate and the intermediate state
 * inside the creating transaction would violate it. The root is derived —
 * `parent_id IS NULL AND organization_id = $1`.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: varchar('slug', { length: 63 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    // Nullable ONLY for master, and only between the migration that creates
    // the row and the first startup that resolves KEYCLOAK_ISSUER into it.
    realm: varchar('realm', { length: 63 }),
    status: organizationStatus('status').notNull().default('active'),
    isMaster: boolean('is_master').notNull().default(false),
    realmProvisionedAt: timestamp('realm_provisioned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    slugUnique: uniqueIndex('organizations_slug_unique').on(sql`lower(${table.slug})`),
    // Exactly one master. A plain unique index on a boolean would forbid a
    // second NON-master row too, so this is partial.
    masterUnique: uniqueIndex('organizations_master_unique')
      .on(table.isMaster)
      .where(sql`${table.isMaster}`),
    realmPresent: check(
      'organizations_realm_present',
      sql`${table.realm} IS NOT NULL OR ${table.isMaster}`,
    ),
    slugFormat: check(
      'organizations_slug_format',
      sql`${table.slug} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'`,
    ),
  }),
)

/** The row type every later task refers to as `Organization`. */
export type Organization = typeof organizations.$inferSelect
