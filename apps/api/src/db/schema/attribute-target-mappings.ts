import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { attributeDefinitions } from './attribute-definitions'
import { outboxTarget } from './outbox-events'

// The fixed, closed set of PROFILE fields every target might represent under
// its own name — "given name, surname, title, and department from the org
// path" (Milestone 10, Task 3 contract). Deliberately using AD/LDAP-familiar
// terms (`given_name`/`surname` rather than this codebase's own
// `firstName`/`lastName` column names) because these four are chosen to
// mirror the canonical AD/LDAP attributes (`givenName`, `sn`, `title`,
// `department`) Milestone 11's adapter will eventually target — the whole
// point of a REMOTE-NAME mapping is that the LOCAL identifier need not match
// any one target's own vocabulary.
//
// This is a SEPARATE catalog from `attribute_definitions` (admin-configured
// custom attributes, keyed by an arbitrary `varchar(64) key` chosen at
// definition time): an admin's custom attribute could coincidentally also be
// named "department" (see sync.worker.spec.ts's own long-standing fixture,
// predating this task) without colliding with THIS "department", because a
// mapping row references exactly one of `attribute_definition_id` OR
// `core_field`, never a bare string key shared across both catalogs — see
// `attributeTargetMappings`'s own doc comment below.
//
// Hand-rolled here as a pgEnum (not derived from a TS union elsewhere) —
// same convention `connectors/connector.ts`'s `ConnectorTarget` doc comment
// describes for `outboxTarget`: the schema layer is the source of truth for
// the closed set; `connectors/attribute-mapping.ts`'s `CoreProfileField`
// mirrors these four values by hand, the same relationship `ConnectorTarget`
// already has with `outboxTarget`.
export const attributeCoreField = pgEnum('attribute_core_field', [
  'given_name',
  'surname',
  'title',
  'department',
])

/**
 * Milestone 10, Task 3 — replaces `attribute_definitions.sync_to_keycloak`.
 * One row means "this local field propagates to this target, under this
 * remote name." **Absence of a row means no propagation** — default-deny is
 * now structural (nothing to read, nothing to send) rather than a boolean
 * defaulting to `false`: see this project's binding constraint 2 ("Attribute
 * propagation is default-deny") and docs/superpowers/specs/2026-08-06-
 * directory-connectors-design.md's "Attribute propagation, generalised".
 * `enabled = false` on an EXISTING row means exactly the same thing as no
 * row at all — both are excluded identically by every read in
 * `attributes/attribute-target-mappings.repository.ts` — so disabling a
 * mapping (leaving the row for its remote-name/history value) and deleting
 * it are behaviourally indistinguishable to a target, by construction, not
 * by convention.
 *
 * Exactly ONE of `attribute_definition_id` (a custom, admin-configured
 * attribute) or `core_field` (a fixed, built-in profile field — given name,
 * surname, title, department) is set per row, enforced by
 * `exactlyOneSource` below — never both, never neither. This is a single,
 * unified table (not two) because Milestone 14's console
 * ("Attribute mapping editor over attribute_target_mappings") presents both
 * kinds of field through the SAME editor, and because both are governed by
 * the identical default-deny read path
 * (`AttributeTargetMappingsRepository.listForTarget`) — one mechanism to
 * prove correct, not two that could silently diverge.
 *
 * `attribute_definition_id` cascades on delete: there is no delete for
 * `attribute_definitions` rows today (no write path exists at all — see
 * attribute-validator.ts's ReDoS doc comment), but a mapping row is
 * meaningless once its definition is gone, so this is the correct FK
 * behaviour regardless of whether it is reachable yet.
 *
 * Migration 0014 (see db/migrations/0014_*.sql) migrates every
 * pre-existing `attribute_definitions.sync_to_keycloak = true` row to
 * exactly `(that definition, 'keycloak', <its own key>, true)`, in the SAME
 * migration that drops the boolean column — see that file's own comment for
 * why remote_name = key is what keeps Keycloak's outbound payload
 * byte-for-byte unchanged. No `core_field` row is seeded for ANY target by
 * that migration: `given_name`/`surname` reach Keycloak exactly as they
 * always did, through `DesiredUser.firstName`/`lastName`'s own independent,
 * unconditional path (see connectors/connector.ts's `DesiredUser` doc
 * comment) — core-field mapping is new, additive propagation surface, not a
 * re-plumbing of what already worked.
 */
export const attributeTargetMappings = pgTable(
  'attribute_target_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    attributeDefinitionId: uuid('attribute_definition_id').references(
      () => attributeDefinitions.id,
      { onDelete: 'cascade' },
    ),
    coreField: attributeCoreField('core_field'),

    target: outboxTarget('target').notNull(),
    remoteName: varchar('remote_name', { length: 255 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Two PARTIAL unique indexes, not one plain one spanning both nullable
    // columns — same reasoning role-assignments.ts's `scopedUnique`/
    // `globalUnique` pair documents: Postgres never treats two NULLs as
    // equal, so a single index over (attribute_definition_id, core_field,
    // target) would let the SAME attribute or core field be mapped to the
    // SAME target an unlimited number of times, defeating "at most one
    // mapping row per (field, target)".
    attributeTargetUnique: uniqueIndex('attribute_target_mappings_attribute_target_unique')
      .on(table.attributeDefinitionId, table.target)
      .where(sql`${table.attributeDefinitionId} IS NOT NULL`),
    coreFieldTargetUnique: uniqueIndex('attribute_target_mappings_core_field_target_unique')
      .on(table.coreField, table.target)
      .where(sql`${table.coreField} IS NOT NULL`),

    // Belt-and-braces, mirroring `group_group_members_no_self_edge`'s own
    // precedent (db/schema/group-members.ts) for a CHECK this codebase could
    // just as easily leave to application discipline alone: no write path
    // for this table exists yet in THIS milestone (mirrors
    // `connector_targets`'s own "admin-configured directly, console lands in
    // Milestone 14" shape), but the moment one does, a malformed row
    // (neither source set, or both) would be silently meaningless — `(a IS
    // NULL) <> (b IS NULL)` is boolean XOR: true iff EXACTLY one side is
    // NULL.
    exactlyOneSource: check(
      'attribute_target_mappings_exactly_one_source',
      sql`(${table.attributeDefinitionId} IS NULL) <> (${table.coreField} IS NULL)`,
    ),
  }),
)
