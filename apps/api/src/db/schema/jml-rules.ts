import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

// Milestone 7: joiner/mover/leaver automation. Every one of these three enums
// is a CLOSED set, enforced by Postgres at the column level — but that alone
// is not enough: `ALTER TYPE jml_trigger ADD VALUE '...'` is ordinary, valid
// SQL, so a FUTURE migration (or a rolling deploy where an older instance of
// this API reads a row a newer one wrote) can put a value into one of these
// columns that THIS code does not recognise. `src/jml/rule-engine.ts` and
// `src/jml/rule-applier.ts` treat every value read back from these three
// columns as untrusted input for exactly that reason — never indexing a
// dispatch map without first confirming the key is actually present (see
// `src/authz/actions.ts`'s ROLE_PERMISSIONS/ROLE_RANK doc comment, which this
// follows) — rather than trusting Drizzle's compile-time-only enum typing.
export const jmlTrigger = pgEnum('jml_trigger', [
  'user_created',
  'user_attribute_changed',
  'start_date_reached',
  'end_date_reached',
])

export const jmlConditionOperator = pgEnum('jml_condition_operator', [
  'equals',
  'not_equals',
  'in',
])

export const jmlAction = pgEnum('jml_action', [
  'add_to_group',
  'remove_from_group',
  'set_attribute',
  'deactivate',
])

export const jmlRules = pgTable(
  'jml_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),

    // Defaults FALSE, at the column level — Milestone 7, Task 6: a rule
    // cannot be enabled until it has been simulated at least once. The ONLY
    // path that ever flips this to true is
    // JmlRulesRepository.setEnabled, which enforces that gate against
    // `simulatedAt` below unconditionally, not by caller convention.
    enabled: boolean('enabled').notNull().default(false),

    trigger: jmlTrigger('trigger').notNull(),

    // Deliberately NOT its own Postgres enum, unlike trigger/conditionOperator/
    // action above. The set of fields a condition may name is still CLOSED in
    // practice — see rule-engine.ts's CONDITION_FIELD_EXTRACTORS, an
    // allowlisted lookup table consulted at match time — but it is closed by
    // application code, not by the database, because it names a field on
    // `users` (plus the open-ended `attributes.<key>` custom-attribute form),
    // not a fixed vocabulary the schema itself should own.
    conditionField: varchar('condition_field', { length: 128 }).notNull(),
    conditionOperator: jmlConditionOperator('condition_operator').notNull(),

    // Nullable: a rule may legitimately compare a field against the JSON
    // literal `null` (e.g. "jobTitle equals null" — no job title set). Rather
    // than lean on Drizzle's jsonb serialization of a JS `null` staying
    // distinguishable from SQL NULL on every driver version, this column
    // simply allows both and rule-engine.ts treats a SQL-NULL read-back
    // identically to a stored JSON `null` — both mean "compare against
    // nothing," which is what a caller who never set this would mean either
    // way. Matches `attribute_definitions.default_value`'s same nullable,
    // unannotated jsonb shape (db/schema/attribute-definitions.ts).
    conditionValue: jsonb('condition_value'),

    action: jmlAction('action').notNull(),
    // Same shape as `users.attributes` / `attribute_definitions.validation_rules`:
    // NOT NULL, defaulting to `{}` rather than allowing a bare SQL NULL a
    // reader would have to special-case.
    actionParams: jsonb('action_params')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    // NULL = never simulated. Set exactly once real simulation has been
    // recorded via JmlRulesRepository.markSimulated — see that method's doc
    // comment for why this column, not an in-memory flag, is what makes the
    // "cannot enable an unsimulated rule" gate durable across process
    // restarts and separate calls.
    simulatedAt: timestamp('simulated_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Supports both JmlRulesRepository.listEnabledByTrigger (the read the
    // rule engine and the lifecycle job run on every pass) and a plain
    // "show me every enabled rule" scan.
    enabledTriggerIdx: index('jml_rules_enabled_trigger_idx').on(table.enabled, table.trigger),
  }),
)
