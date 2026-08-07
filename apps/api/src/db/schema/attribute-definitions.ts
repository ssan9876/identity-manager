import {
  boolean,
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
  }),
)
