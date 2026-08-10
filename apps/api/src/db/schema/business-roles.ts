import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
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
import { organizations } from './organizations'
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

    /**
     * Milestone: organizations multi-tenancy, Task 5. A role is a formula
     * plus a set of entitlements, evaluated against every user the engine
     * can see — so without a tenant it is, the moment a second organization
     * exists, one admin's formula granting inside another admin's
     * directory. Backfilled to master for every pre-existing row (0030).
     *
     * ON DELETE RESTRICT, like org_units/users/groups: CASCADE would remove
     * the formulas while leaving every entitlement they had already granted
     * in place, with nothing left to explain or revoke them.
     *
     * This column is what `listEnabledForEvaluation` filters on, and it is a
     * REQUIRED parameter there rather than an optional one precisely because
     * a forgotten filter on this path is a cross-tenant grant.
     */
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

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

    /**
     * How many segregation-of-duties violations the recorded simulation of
     * this exact draft found — the second half of the publish gate (0034).
     * Written by `recordSimulation` alongside `simulated_draft_hash` and
     * cleared wherever the hash is cleared, so the pair always describes ONE
     * simulation of ONE draft. `publishWithin` refuses when this is > 0, and
     * refuses when it is NULL while a hash is present: NULL means the
     * simulation predates SoD checking (a pre-0034 row), and publishing on
     * the strength of a simulation that never looked for violations would
     * quietly re-open the exact hole the gate closes. Enforced in the
     * REPOSITORY, like the hash itself, so no caller can publish around it.
     */
    simulatedSodViolations: integer('simulated_sod_violations'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Per ORGANIZATION since Task 5, exactly as 0028 did for
    // users.username and groups.name: a global unique name means whichever
    // tenant onboards "Engineering Standard Access" first permanently
    // denies it to every other, and the 409 that denies it is an existence
    // oracle across the tenant boundary. The index NAME is unchanged —
    // BusinessRolesRepository.translateWriteError matches that exact string
    // to turn a 23505 into a ConflictError.
    nameIdx: uniqueIndex('business_roles_name_idx').on(table.organizationId, table.name),
    // The reconciler's hot read: every enabled role IN ONE ORGANIZATION, on
    // every evaluation. organization_id leads because it is the first
    // discriminator once more than one tenant exists.
    enabledIdx: index('business_roles_enabled_idx').on(table.organizationId, table.enabled),
    // Strictly redundant as uniqueness (id alone already implies it); it
    // exists only to be REFERENCEABLE — a composite FK can only reference a
    // unique key over exactly the referenced pair (0029's own note, verbatim,
    // for org_units/users/groups). `role_conflicts` pins both of its role
    // references to its own organization_id through this.
    idOrganizationKey: uniqueIndex('business_roles_id_organization_key').on(
      table.id,
      table.organizationId,
    ),
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

/**
 * Segregation of duties over business roles: an UNORDERED pair of roles no
 * one person may hold both of, with the reason that makes the pairing
 * reviewable later.
 *
 * UNORDERED is enforced structurally, not by convention. The CHECK pins
 * `role_a_id < role_b_id` (canonical ordering — which also forbids a role
 * conflicting with itself), and the unique index over the canonical pair
 * then makes (A,B) and (B,A) the SAME row: the repository sorts the pair
 * before every write, and a row that slipped past it un-sorted is a
 * constraint violation, not a second, invisible copy of the same policy that
 * half the queries would miss.
 *
 * NO DELETE, like everything else here: a conflict is retired by flipping
 * `enabled` off, so the policy's history — who defined it, why, and when it
 * stopped applying — survives the decision to stop enforcing it. Only
 * ENABLED conflicts are consulted, by the publish gate and by the standing
 * checker alike.
 *
 * The composite FKs (0034, same pattern as 0029) carry `organization_id` on
 * both sides: a conflict can only ever join two roles of ITS OWN
 * organization, so one tenant's SoD policy cannot name — and thereby probe
 * for, or veto publishes of — another tenant's roles. ON DELETE RESTRICT on
 * the single-column role FKs for the usual reason: nothing deletes a
 * business role today, and if something ever does, a policy silently losing
 * one of its two sides must be a loud failure.
 */
export const roleConflicts = pgTable(
  'role_conflicts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** The LESSER uuid of the pair — see the canonical-ordering CHECK. */
    roleAId: uuid('role_a_id')
      .notNull()
      .references(() => businessRoles.id, { onDelete: 'restrict' }),
    /** The GREATER uuid of the pair. */
    roleBId: uuid('role_b_id')
      .notNull()
      .references(() => businessRoles.id, { onDelete: 'restrict' }),
    /** Mandatory, like an exception's reason: an unexplained control is what a later audit cannot act on. */
    reason: text('reason').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pairUnique: uniqueIndex('role_conflicts_pair_unique').on(table.roleAId, table.roleBId),
    // The publish gate's and standing checker's read: enabled conflicts, one
    // organization at a time.
    organizationIdx: index('role_conflicts_organization_idx').on(table.organizationId, table.enabled),
    canonicalPair: check('role_conflicts_canonical_pair', sql`${table.roleAId} < ${table.roleBId}`),
    roleAOrganizationFk: foreignKey({
      name: 'rc_role_a_organization_fk',
      columns: [table.roleAId, table.organizationId],
      foreignColumns: [businessRoles.id, businessRoles.organizationId],
    }),
    roleBOrganizationFk: foreignKey({
      name: 'rc_role_b_organization_fk',
      columns: [table.roleBId, table.organizationId],
      foreignColumns: [businessRoles.id, businessRoles.organizationId],
    }),
  }),
)
