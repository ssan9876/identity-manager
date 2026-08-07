import { Inject, Injectable } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { ResolvedTargetMapping } from '../connectors/attribute-mapping'
import type { ConnectorTarget } from '../connectors/connector'
import { DB_CLIENT } from '../common/db.token'
import * as schema from '../db/schema/index'

/**
 * Reads for `attribute_target_mappings` (Milestone 10, Task 3). No write
 * methods: like `connector_targets` before it (Task 2 — see that table's own
 * doc comment), this milestone has no admin-facing endpoint for editing
 * mappings; Milestone 14's console adds one ("Attribute mapping editor").
 * Rows are admin-seeded directly against Postgres for now — mirrored exactly
 * by how this suite's own tests seed them (raw SQL / Drizzle inserts, same
 * pattern `connector_targets` rows already use in outbox-multi-target.spec.ts
 * etc.).
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
   * mid-transaction (finding C1, docs/superpowers/audit-integrity.md).
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
}
