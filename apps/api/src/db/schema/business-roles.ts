import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { groups } from './groups'
import { outboxTarget } from './outbox-events'
import { users } from './users'

export const businessRoleConditionOperator = pgEnum('business_role_condition_operator', [
  'equals',
  'not_equals',
  'in',
  'in_org_subtree',
])

export const businessRoleGrantKind = pgEnum('business_role_grant_kind', [
  'group_membership',
  'target_account',
])

export const businessRoleExceptionMode = pgEnum('business_role_exception_mode', ['include', 'exclude'])

/**
 * A business role: a membership formula plus a set of entitlements.
 *
 * TWO SEPARATE GATES live on this table and they do different jobs.
 *
 * `enabled` is the KILL SWITCH. The reconciler's desired set is the union
 * over ENABLED roles, so disabling a role removes its rows from that set and
 * they are revoked on the next pass. Disable is a revocation, not a pause —
 * the console must say so before it happens.
 *
 * `draft_definition` + `simulated_draft_hash` are the CHANGE GATE. Edits to
 * conditions and grants land in the draft and affect nobody; publishing
 * refuses unless a simulation ran against that exact draft. An earlier
 * version of this design instead froze conditions while enabled, forcing a
 * disable-edit-re-enable cycle — which, because disable revokes, would have
 * revoked and re-granted every entitlement on every edit, churning every
 * downstream target and locking people out of real systems mid-edit.
 */
export const businessRoles = pgTable(
  'business_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),

    enabled: boolean('enabled').notNull().default(false),

    /**
     * Pending edits. Shape is validated by the application on write and again
     * on publish (see business-roles.repository.ts) — jsonb because a draft is
     * scratch, deliberately NOT the typed child tables below, which are what
     * the engine actually reads.
     */
    draftDefinition: jsonb('draft_definition').$type<Record<string, unknown>>(),

    simulatedAt: timestamp('simulated_at', { withTimezone: true }),
    /** SHA-256 of the canonicalised draft that simulation ran against. */
    simulatedDraftHash: varchar('simulated_draft_hash', { length: 64 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nameIdx: uniqueIndex('business_roles_name_idx').on(table.name),
    // The reconciler's hot read: every enabled role, on every evaluation.
    enabledIdx: index('business_roles_enabled_idx').on(table.enabled),
  }),
)

/**
 * The flat AND-list, and the PUBLISHED definition — these rows are what the
 * evaluator reads. Edits do not land here; they land in
 * `business_roles.draft_definition` and are copied down transactionally on
 * publish.
 *
 * `field` is deliberately NOT a Postgres enum, for exactly the reason
 * `jml_rules.condition_field` is not: it names a column on `users` plus the
 * open-ended `attributes.<key>` form, so the vocabulary is closed by an
 * application-code allowlist (CONDITION_FIELD_EXTRACTORS), not by the schema.
 */
export const businessRoleConditions = pgTable(
  'business_role_conditions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessRoleId: uuid('business_role_id')
      .notNull()
      .references(() => businessRoles.id, { onDelete: 'cascade' }),
    field: varchar('field', { length: 128 }).notNull(),
    operator: businessRoleConditionOperator('operator').notNull(),
    /** Nullable so a condition can compare against the JSON literal `null`, matching `jml_rules.condition_value`. */
    value: jsonb('value'),
  },
  (table) => ({
    roleIdx: index('business_role_conditions_role_idx').on(table.businessRoleId),
  }),
)

/**
 * What a role grants. Part of the published definition, on the same terms as
 * the conditions above.
 *
 * `onDelete: restrict` on `group_id` is deliberate: deleting a group that a
 * role grants must fail loudly rather than silently stripping access from
 * everyone who holds that role.
 */
export const businessRoleGrants = pgTable(
  'business_role_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessRoleId: uuid('business_role_id')
      .notNull()
      .references(() => businessRoles.id, { onDelete: 'cascade' }),
    kind: businessRoleGrantKind('kind').notNull(),
    groupId: uuid('group_id').references(() => groups.id, { onDelete: 'restrict' }),
    target: outboxTarget('target'),
  },
  (table) => ({
    roleIdx: index('business_role_grants_role_idx').on(table.businessRoleId),
    uniqueGroup: uniqueIndex('business_role_grants_unique_group').on(table.businessRoleId, table.groupId),
    uniqueTarget: uniqueIndex('business_role_grants_unique_target').on(table.businessRoleId, table.target),
    // Exactly one reference, and it must be the one this kind names. Belt and
    // braces alongside the repository's own validation, in the same posture
    // as `attribute_target_mappings_exactly_one_source`.
    kindMatchesReference: check(
      'business_role_grants_kind_matches_reference',
      sql`(${table.kind} = 'group_membership' AND ${table.groupId} IS NOT NULL AND ${table.target} IS NULL)
       OR (${table.kind} = 'target_account'   AND ${table.target}  IS NOT NULL AND ${table.groupId} IS NULL)`,
    ),
  }),
)

/**
 * The audited overrides. `reason` is NOT NULL because an unexplained
 * exception is precisely what a later recertification campaign cannot act on.
 */
export const businessRoleExceptions = pgTable(
  'business_role_exceptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessRoleId: uuid('business_role_id')
      .notNull()
      .references(() => businessRoles.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mode: businessRoleExceptionMode('mode').notNull(),
    reason: text('reason').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniquePerUser: uniqueIndex('business_role_exceptions_unique').on(table.businessRoleId, table.userId),
    userIdx: index('business_role_exceptions_user_idx').on(table.userId),
  }),
)
