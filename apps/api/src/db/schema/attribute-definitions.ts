import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

export const attributeDataType = pgEnum('attribute_data_type', [
  'string',
  'number',
  'boolean',
  'date',
  'enum',
])

export const attributeAppliesTo = pgEnum('attribute_applies_to', ['user', 'group'])

export const attributeDefinitions = pgTable(
  'attribute_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: varchar('key', { length: 64 }).notNull(),
    label: varchar('label', { length: 255 }).notNull(),
    dataType: attributeDataType('data_type').notNull(),
    required: boolean('required').notNull().default(false),
    defaultValue: jsonb('default_value'),
    validationRules: jsonb('validation_rules')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    appliesTo: attributeAppliesTo('applies_to').notNull().default('user'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),

    // Default-deny: an attribute is user-editable only when explicitly
    // opted in. Propagation out of this system (formerly this table's own
    // `sync_to_keycloak` boolean) is now `attribute_target_mappings`
    // (Milestone 10, Task 3, db/schema/attribute-target-mappings.ts) — a
    // per-TARGET table where absence of a row, not a column default, is what
    // makes default-deny structural. See that table's own doc comment for
    // the migration that moved every `sync_to_keycloak = true` row there
    // before this column was dropped.
    selfEditable: boolean('self_editable').notNull().default(false),

    /**
     * Withhold this attribute's VALUE from audit-log snapshots.
     *
     * Finding SEC-M1 (docs/archive/audits/carried-findings-verification.md):
     * `snapshotUser` copied the whole attribute bag verbatim into `before`
     * and `after` on every user:create/update/self_update/jml/import row,
     * with no per-attribute read control anywhere — and `audit_log`'s
     * UPDATE/DELETE/TRUNCATE are blocked by both privilege and trigger, so
     * there is no retrofit once a value has been written. The only workable
     * point of control is not writing it in the first place.
     *
     * Default `false`, matching this table's other opt-in booleans: marking
     * an attribute sensitive is a deliberate act, and defaulting to `true`
     * would silently blind the audit log for every existing definition.
     *
     * Deliberately landed while `attribute_definitions` is still READ-ONLY
     * (attribute-definitions.controller.ts exposes only `@Get()`), which is
     * what the audit's fix direction asked for: the control has to exist
     * before a write path can create sensitive attributes, not after.
     *
     * This governs the AUDIT LOG only. Outbox payloads still carry real
     * values — connectors cannot provision a mailbox quota they are not
     * given — so this is not a general secrecy flag. See
     * `snapshotUserForAudit` in users/users.controller.ts.
     */
    sensitive: boolean('sensitive').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    keyScopeUnique: uniqueIndex('attribute_definitions_key_scope_unique').on(
      table.key,
      table.appliesTo,
    ),

    // Behind the application rule in attributes/attribute-key.ts, not instead
    // of it. Every attribute_definitions row on a deployed host today was
    // created by a hand-written INSERT — that is the problem this feature
    // exists to remove — so a rule enforced only in a controller would be a
    // rule the existing data has never been held to.
    keyFormat: check(
      'attribute_definitions_key_format',
      sql`${table.key} ~ '^[A-Za-z_][A-Za-z0-9_]*$' AND ${table.key} NOT IN ('__proto__', 'constructor', 'prototype')`,
    ),
  }),
)
