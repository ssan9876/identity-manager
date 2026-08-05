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

    // Default-deny: an attribute leaves this system only when explicitly
    // opted in, and is user-editable only when explicitly opted in.
    syncToKeycloak: boolean('sync_to_keycloak').notNull().default(false),
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
