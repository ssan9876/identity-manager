import { Inject, Injectable } from '@nestjs/common'
import { eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { CoreProfileField, ResolvedTargetMapping } from '../connectors/attribute-mapping'
import type { ConnectorTarget } from '../connectors/connector'
import { DB_CLIENT } from '../common/db.token'
import { ConflictError, NotFoundError } from '../common/errors'
import { attributeDefinitions } from '../db/schema/attribute-definitions'
import { attributeTargetMappings } from '../db/schema/attribute-target-mappings'
import * as schema from '../db/schema/index'
import type { DbHandle } from '../outbox/outbox.writer'

/**
 * Reads AND writes for `attribute_target_mappings`. Read methods
 * (`listForTarget`/`listAllRemoteNamesForTarget`) are Milestone 10, Task 3 —
 * the sync-time, default-deny-enforcing half. Write methods
 * (`listAllRows`/`findById`/`create`/`update`/`remove`) are Milestone 14,
 * Task 9 — "Attribute mapping editor over `attribute_target_mappings`" —
 * added here, on the SAME repository, rather than a second one: one class
 * owning the whole table keeps the default-deny read path
 * (`listForTarget`'s `WHERE enabled = true`) and the admin write path that
 * creates/toggles the rows it reads unmistakably in view of each other,
 * exactly the property Task 3's own report flagged as this milestone's
 * carried gap ("Concerns" #1: "Rows are admin-seeded directly against
 * Postgres until then").
 */
@Injectable()
export class AttributeTargetMappingsRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>) {}

  /**
   * Every ENABLED mapping row for `target`, normalised to
   * `ResolvedTargetMapping` (connectors/attribute-mapping.ts) — the input
   * `buildTargetAttributes` iterates over. This is where "absence of a row
   * means no propagation" actually happens structurally: a local field with
   * no row, or whose only row has `enabled = false`, is filtered out by the
   * `WHERE ... enabled = true` clause on EACH branch below and therefore
   * never appears anywhere in the returned array — there is no later "and
   * also check enabled" step for a caller to forget.
   *
   * ONE round trip (`UNION ALL` of two branches, via a raw `sql` tag rather
   * than Drizzle's typed query builder — the two branches select
   * differently-sourced columns under a shared shape, which the builder
   * expresses far less directly than plain SQL here), not two: this method
   * sits on `SyncWorker.reconcileUser`'s hot path, itself already inside a
   * `pg_advisory_xact_lock`-guarded critical section (see that method's own
   * doc comment) that a concurrent worker for the SAME user blocks behind —
   * every extra round trip here is extra time a blocked sibling worker
   * waits, measured to matter for test/sync.worker.spec.ts's own
   * timing-sensitive "cross-aggregate races" (finding H2) regression tests
   * under full-suite load. The CUSTOM branch still needs a JOIN to
   * `attribute_definitions` (to resolve the definition's own `key` — the
   * string `user.attributes` is actually keyed by — and to enforce
   * `is_active = true`, mirroring exactly what
   * `UsersRepository.listActiveAttributeDefinitions` already filtered for
   * the boolean this replaces); the CORE branch has no such join.
   *
   * `db` is an OPTIONAL trailing handle, defaulting to the injected pooled
   * connection — same connection-discipline contract every other
   * repository's read/write methods in this codebase follow (e.g.
   * UsersRepository.findById). `SyncWorker.reconcileUser` always passes its
   * own open transaction, never letting this take a second pool connection
   * mid-transaction (finding C1, docs/archive/audits/audit-integrity.md).
   */
  async listForTarget(
    target: ConnectorTarget,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<ResolvedTargetMapping[]> {
    const { rows } = await db.execute<{
      source: 'custom' | 'core'
      local_key: string
      remote_name: string
    }>(sql`
      SELECT ad.key AS local_key, atm.remote_name, 'custom' AS source
        FROM attribute_target_mappings atm
        JOIN attribute_definitions ad ON ad.id = atm.attribute_definition_id
       WHERE atm.target = ${target} AND atm.enabled = true AND ad.is_active = true
      UNION ALL
      SELECT atm.core_field::text AS local_key, atm.remote_name, 'core' AS source
        FROM attribute_target_mappings atm
       WHERE atm.target = ${target} AND atm.enabled = true AND atm.core_field IS NOT NULL
    `)

    return rows.map((row) => ({
      source: row.source,
      localKey: row.local_key,
      remoteName: row.remote_name,
    }))
  }

  /**
   * Milestone 11, Task 5 — EVERY remote name ever configured for `target`,
   * custom and core alike, regardless of `enabled` (deliberately NOT
   * filtered like `listForTarget` above). Exists for a narrower purpose than
   * that method: `DesiredUser.managedAttributeRemoteNames` needs to know
   * which remote attribute NAMES this target is configured to manage AT
   * ALL, so a mapping that just transitioned from enabled to disabled can
   * still be found and its now-stale value ACTIVELY CLEARED —
   * `listForTarget`'s `WHERE enabled = true` would exclude exactly the row
   * this needs (the one that WAS written, and now must be un-written). Read
   * for every target in `TARGETS_NEEDING_MANAGED_ATTRIBUTE_NAMES`
   * (outbox/sync.worker.ts) — nine targets: `active_directory`, `entra_id`,
   * `google_workspace`, and all six `scim_*` slots — because each of those
   * applies a PARTIAL update (LDAP `modify`, Graph `PATCH`, the Admin SDK's
   * `update`, RFC 7644 §3.5.2 `PATCH`) that leaves an omitted key untouched
   * rather than clearing it — unlike Keycloak, whose whole-object update
   * already self-clears an omitted key (see `DesiredUser.
   * managedAttributeRemoteNames`'s own doc comment).
   */
  async listAllRemoteNamesForTarget(
    target: ConnectorTarget,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<string[]> {
    const { rows } = await db.execute<{ remote_name: string }>(
      sql`SELECT remote_name FROM attribute_target_mappings WHERE target = ${target}`,
    )
    return rows.map((row) => row.remote_name)
  }

  /**
   * EVERY row, every target, ENABLED or not — the admin-console read this
   * milestone adds, deliberately unfiltered (unlike `listForTarget`, whose
   * `WHERE enabled = true` is exactly right for a SYNC decision but exactly
   * wrong for an EDITOR, which must show a disabled row too, distinctly from
   * no row at all — see `AttributeTargetMappingsController`'s own doc
   * comment on why that distinction is the whole point of this screen).
   * Same custom/core UNION ALL shape as `listForTarget`, plus the custom
   * branch's own `label` (an admin-facing name `listForTarget` never needed,
   * since sync time only cares about the definition's `key`) — and, unlike
   * `listForTarget`, NOT joined against `ad.is_active`: an editor should
   * still show (and let an admin delete) a mapping row whose definition has
   * since gone inactive, rather than making it invisible AND unremovable.
   */
  async listAllRows(db: NodePgDatabase<typeof schema> = this.db): Promise<AttributeTargetMappingRow[]> {
    const { rows } = await db.execute<{
      id: string
      source: 'custom' | 'core'
      attribute_definition_id: string | null
      core_field: CoreProfileField | null
      local_key: string
      label: string | null
      target: ConnectorTarget
      remote_name: string
      enabled: boolean
    }>(sql`
      SELECT atm.id, 'custom' AS source, atm.attribute_definition_id, NULL::attribute_core_field AS core_field,
             ad.key AS local_key, ad.label AS label, atm.target, atm.remote_name, atm.enabled
        FROM attribute_target_mappings atm
        JOIN attribute_definitions ad ON ad.id = atm.attribute_definition_id
       WHERE atm.attribute_definition_id IS NOT NULL
      UNION ALL
      SELECT atm.id, 'core' AS source, NULL::uuid AS attribute_definition_id, atm.core_field,
             atm.core_field::text AS local_key, NULL::text AS label, atm.target, atm.remote_name, atm.enabled
        FROM attribute_target_mappings atm
       WHERE atm.core_field IS NOT NULL
      ORDER BY local_key, target
    `)

    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      attributeDefinitionId: row.attribute_definition_id,
      coreField: row.core_field,
      localKey: row.local_key,
      label: row.label,
      target: row.target,
      remoteName: row.remote_name,
      enabled: row.enabled,
    }))
  }

  async findById(id: string, db: NodePgDatabase<typeof schema> = this.db): Promise<MappingRecord | null> {
    const [row] = await db.select().from(attributeTargetMappings).where(eq(attributeTargetMappings.id, id)).limit(1)
    return row ?? null
  }

  /**
   * Creates ONE mapping row — the structural act of opt-in that
   * `attribute_target_mappings`'s own default-deny model exists to require
   * (db/schema/attribute-target-mappings.ts's own doc comment: "absence of a
   * row means no propagation"). Exactly one of `attributeDefinitionId`/
   * `coreField` must be set — enforced twice: the controller's own Zod
   * schema (`exactlyOneOfSchema`) rejects a malformed request before this is
   * ever called, and the table's own `exactlyOneSource` CHECK constraint is
   * the structural backstop if it somehow were not. A second row for the
   * SAME (field, target) — enabled or not — is rejected as a clean 409 via
   * `translateWriteError`, never a raw constraint-violation 500.
   */
  async create(
    tx: DbHandle,
    input: {
      attributeDefinitionId: string | null
      coreField: CoreProfileField | null
      target: ConnectorTarget
      remoteName: string
      enabled: boolean
    },
  ): Promise<MappingRecord> {
    try {
      const [row] = await tx
        .insert(attributeTargetMappings)
        .values({
          attributeDefinitionId: input.attributeDefinitionId,
          coreField: input.coreField,
          target: input.target,
          remoteName: input.remoteName,
          enabled: input.enabled,
        })
        .returning()
      return row!
    } catch (cause) {
      this.translateWriteError(cause)
    }
  }

  /** Toggles `enabled` and/or renames `remoteName` — never the (field, target) identity itself, which is immutable by design: changing WHICH field or WHICH target a row governs is a different mapping, not an edit of this one (create a new row and remove the old instead). */
  async update(
    tx: DbHandle,
    id: string,
    patch: { remoteName?: string; enabled?: boolean },
  ): Promise<MappingRecord> {
    try {
      const [row] = await tx
        .update(attributeTargetMappings)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(attributeTargetMappings.id, id))
        .returning()
      if (row === undefined) {
        throw new NotFoundError('attribute target mapping', id)
      }
      return row
    } catch (cause) {
      if (cause instanceof NotFoundError) throw cause
      this.translateWriteError(cause)
    }
  }

  /**
   * Deletes the row outright. For `listForTarget`'s sync decision this is
   * behaviourally IDENTICAL to disabling it — its `WHERE enabled = true`
   * excludes "no row" and "row, enabled = false" the same way, so either one
   * stops propagation. It is NOT identical for a target in
   * `TARGETS_NEEDING_MANAGED_ATTRIBUTE_NAMES` (outbox/sync.worker.ts):
   * `listAllRemoteNamesForTarget` still returns a disabled row's remote
   * name, so its now-stale value gets actively cleared in the target;
   * deleting the row removes it from that list too, so the stale value is
   * stranded there with nothing left to clear it. Disabling is therefore
   * the safer default; deleting is for an admin who wants the editor to
   * stay tidy, not a behaviourally-equivalent alternative to it, and it is
   * never the ONLY way to stop a field propagating (disabling it is
   * reversible with one click, per the console's own UI).
   */
  async remove(tx: DbHandle, id: string): Promise<MappingRecord | null> {
    const [row] = await tx.delete(attributeTargetMappings).where(eq(attributeTargetMappings.id, id)).returning()
    return row ?? null
  }

  private static readonly ATTRIBUTE_TARGET_UNIQUE_CONSTRAINT = 'attribute_target_mappings_attribute_target_unique'
  private static readonly CORE_FIELD_TARGET_UNIQUE_CONSTRAINT = 'attribute_target_mappings_core_field_target_unique'

  /**
   * Maps a Postgres write-constraint violation to a clean `ConflictError` —
   * matched by exact constraint NAME, never bare error code alone (the same
   * "a bare code would misattribute any FUTURE constraint on this table"
   * reasoning `UsersRepository.translateWriteError`/`GroupsRepository`'s own
   * identical helpers already document). Anything else re-throws the
   * original cause unchanged, so a genuine bug still surfaces as the 500 it
   * actually is.
   */
  private translateWriteError(cause: unknown): never {
    const pgError = cause as { code?: string; constraint?: string }
    if (pgError.code === '23505' && pgError.constraint === AttributeTargetMappingsRepository.ATTRIBUTE_TARGET_UNIQUE_CONSTRAINT) {
      throw new ConflictError('this attribute already has a mapping for this target — edit or remove the existing one instead of creating a second')
    }
    if (pgError.code === '23505' && pgError.constraint === AttributeTargetMappingsRepository.CORE_FIELD_TARGET_UNIQUE_CONSTRAINT) {
      throw new ConflictError('this core field already has a mapping for this target — edit or remove the existing one instead of creating a second')
    }
    throw cause
  }

  /**
   * How many people enabling this mapping would newly export, and whether the
   * attribute is one the audit log is forbidden to record.
   *
   * SECURITY FINDING 5. Enabling a mapping is the write that turns
   * default-deny into propagation, and until this existed it cost one boolean
   * and said nothing. Read together with finding 4 it is sharper than it
   * sounds: `sensitive` withholds an attribute's values from audit snapshots
   * but was deliberately NOT applied to outbox payloads, because connectors
   * provision from those — so an attribute whose values the audit log may not
   * record could be pushed into Active Directory by a toggle, and afterwards
   * the log could not show what was sent.
   *
   * SCOPED TO ORGANIZATIONS THAT ACTUALLY HAVE THE TARGET ENABLED.
   * `connector_targets` is keyed `(organization_id, target)` and
   * `OutboxWriter.record` treats "no row" and "a row with enabled = false"
   * identically, so a tenant without an enabled row exports nothing however
   * many of its users hold a value. Counting the whole directory would
   * over-state this wherever one tenant of twenty is configured, and an
   * alarming number that is also wrong is one people learn to click past.
   *
   * Deliberately NOT filtered by user status: a deactivated account keeps its
   * stored value and exports it on reactivation, so excluding it would
   * under-state what enabling this mapping ultimately sends.
   *
   * Takes an OPTIONAL trailing handle, defaulting to the pooled connection —
   * the same connection-discipline contract every other method here follows.
   * The controller passes its own `tx`, because a count re-derived inside the
   * writing transaction is the difference between a guard and a decoration.
   */
  async countExportImpact(
    query: ExportImpactQuery,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<ExportImpact> {
    const scoped = sql`
      FROM users u
      JOIN connector_targets ct
        ON ct.organization_id = u.organization_id
       AND ct.target = ${query.target}
       AND ct.enabled = true
    `

    if (query.attributeDefinitionId != null) {
      const [definition] = await db
        .select({ key: attributeDefinitions.key, sensitive: attributeDefinitions.sensitive })
        .from(attributeDefinitions)
        .where(eq(attributeDefinitions.id, query.attributeDefinitionId))
      if (!definition) {
        throw new NotFoundError('attribute definition', query.attributeDefinitionId)
      }

      // `?` asks whether the key is present at all; the `jsonb_typeof` guard
      // then excludes a key explicitly set to JSON null, which carries no
      // value to export. Presence alone would count someone whose value was
      // cleared.
      const rows = await db.execute(sql`
        SELECT COUNT(*)::int AS count ${scoped}
        WHERE u.attributes ? ${definition.key}
          AND jsonb_typeof(u.attributes -> ${definition.key}) <> 'null'
      `)
      return { holderCount: Number(rows.rows[0]?.count ?? 0), sensitive: definition.sensitive }
    }

    // A core field has no `attribute_definitions` row, so nothing can mark it
    // sensitive. `first_name`, `last_name` and `org_unit_id` are NOT NULL, so
    // every in-scope user holds those three; only `job_title` is nullable.
    const predicate = query.coreField === 'title' ? sql`WHERE u.job_title IS NOT NULL` : sql``
    const rows = await db.execute(sql`SELECT COUNT(*)::int AS count ${scoped} ${predicate}`)
    return { holderCount: Number(rows.rows[0]?.count ?? 0), sensitive: false }
  }

}

/** The console's own read shape for `listAllRows` — every row, admin-facing. */
export interface AttributeTargetMappingRow {
  id: string
  source: 'custom' | 'core'
  attributeDefinitionId: string | null
  coreField: CoreProfileField | null
  /** `attribute_definitions.key` (source: 'custom') or the core field's own enum value (source: 'core') — same meaning `ResolvedTargetMapping.localKey` already has. */
  localKey: string
  /** The custom attribute's admin-facing label (source: 'custom' only) — `null` for a core field, whose four labels the console hardcodes (`given_name`/`surname`/`title`/`department` have no separate `attribute_definitions` row to hold one). */
  label: string | null
  target: ConnectorTarget
  remoteName: string
  enabled: boolean
}

/** Drizzle's own inferred row shape for `attributeTargetMappings` — what `create`/`update`/`findById` return directly, one level lower than the joined, display-ready `AttributeTargetMappingRow` above. */
export type MappingRecord = typeof attributeTargetMappings.$inferSelect

/** Which (field, target) pair an export-impact count is being asked about — `attributeDefinitionId` XOR `coreField`, the same discriminant every row in this table carries. */
export interface ExportImpactQuery {
  target: ConnectorTarget
  attributeDefinitionId?: string | null
  coreField?: CoreProfileField | null
}

/** What enabling that pair would cost: how many people's values leave, and whether the audit log is allowed to record them. */
export interface ExportImpact {
  holderCount: number
  sensitive: boolean
}
