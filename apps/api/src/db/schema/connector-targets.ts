import { boolean, integer, jsonb, pgTable, timestamp } from 'drizzle-orm/pg-core'
import { outboxTarget } from './outbox-events'

/**
 * Milestone 10, Task 1 — the catalog `OutboxWriter.record` reads to decide
 * which target(s) a fresh mutation fans out to (see outbox.writer.ts's own
 * doc comment). One row per `outbox_target` enum value — `target` IS the
 * primary key, not a surrogate `id`, because there is exactly one
 * configuration per target in this system: "Multi-forest and multi-domain AD
 * topologies" are explicitly out of scope (see
 * docs/superpowers/specs/2026-08-06-directory-connectors-design.md, "Out of
 * scope") — single domain per configured target, so a natural key is both
 * sufficient and prevents a second, meaningless row for the same target ever
 * existing.
 *
 * The migration that creates this table seeds exactly ONE row: `('keycloak',
 * enabled: true)` — preserving today's only real behaviour (see
 * `OutboxWriter.record`). Deliberately NOT also seeding disabled rows for
 * `'active_directory'` / `'entra_id'` / `'google_workspace'` in that same
 * migration, even though that would make for a tidier "complete catalog from
 * day one": Postgres forbids using a value added by `ALTER TYPE ... ADD
 * VALUE` in the SAME transaction that added it (`unsafe use of new value of
 * enum type`), and drizzle's migrator (`PgDialect.migrate`) applies every
 * still-pending migration for one `runMigrations()` call inside ONE
 * transaction — so for a freshly created database (every Testcontainer;
 * every fresh deploy), a row inserted with `target = 'active_directory'`
 * in the SAME migration that widens `outbox_target` to include it would fail
 * outright, not just here but on every future combined fresh-migrate run.
 * `'keycloak'` has no such problem (it has existed since the enum's original
 * migration), which is exactly why only it is seeded here. The other three
 * targets simply have NO row until something — Task 2's registry, or a
 * later migration once the ALTER TYPE above is safely in its own committed
 * past — actually configures one; `WHERE enabled = true` (`OutboxWriter.
 * record`) treats "no row" and "a row with enabled = false" identically, so
 * this is not a behavioural gap, only a cosmetic one (no catalog row to
 * *show* as disabled until Task 2's registry exists to show it).
 *
 * NO SECRET EVER LANDS IN THIS TABLE. `config` is for what decision 4 (the
 * design doc) calls the admin-editable, non-secret half of a connector's
 * setup — host, base DN, tenant id, domain, mapping-adjacent settings. The
 * LDAP bind password, Graph client secret and Google service-account key are
 * referenced by NAME (a string that names an environment variable) and
 * resolved from the environment at point of use — Task 2's job, not this
 * table's. Reading a target through any future API must return configuration
 * with no secret field present — not redacted, ABSENT — because none is ever
 * stored here to redact.
 */
export const connectorTargets = pgTable('connector_targets', {
  target: outboxTarget('target').primaryKey(),

  enabled: boolean('enabled').notNull().default(false),

  // Non-secret only — see this table's own doc comment above. `$type` pins
  // the shape callers see through Drizzle without constraining what Task 2's
  // per-target config actually contains (host/baseDn for AD, tenantId for
  // Entra, domain for Google, etc. — a union nobody benefits from spelling
  // out at the schema layer).
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),

  // A run that would mutate more than this percentage (1-100) of the
  // target's in-scope principals halts and reports instead of proceeding —
  // decision/safety rail from the design doc ("Blast-radius guard"). Task 1
  // only stores the value; Task 4's reconciliation job is what actually
  // enforces it. NOT NULL with a conservative default rather than nullable-
  // meaning-unlimited: this project's default posture is default-deny/
  // fail-safe (mirrors `attribute_definitions.sync_to_keycloak`'s own
  // default-false-until-opted-in shape), and a safety rail that is silently
  // "off" until someone remembers to set it is exactly the gap decision 4's
  // sibling rail (blast-radius) exists to not have.
  blastRadiusThreshold: integer('blast_radius_threshold').notNull().default(20),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
