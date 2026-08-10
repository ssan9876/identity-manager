import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { ALL_CONNECTOR_TARGETS } from '../src/connectors/connector'
import { startMigrationHarness } from './support/migration-harness'

/**
 * The UPGRADE path for 0041 (`rest_json` + `hr_sources.config`) and 0042 (the
 * six SCIM slots on both target enums).
 *
 * Every other spec in this suite migrates a FRESH container to latest in one
 * shot, which proves the migrations compose from nothing. It does NOT prove
 * they apply to a database that already exists at an earlier boundary — and
 * that is the failure mode this repository has actually been bitten by:
 * drizzle's migrator applies a migration only when
 * `lastDbMigration.created_at < folderMillis`, so a journal entry whose
 * `when` is not strictly greater than its predecessor's is SILENTLY SKIPPED,
 * with no error, leaving the database missing an enum value the application
 * code already believes exists (TODO.md, "A migration that would have been
 * silently skipped"). Both new migrations were generated with a `when` in the
 * past and had to be corrected; this is the test that fails if that
 * correction is ever lost.
 */
describe('connector breadth migrations (0041, 0042)', () => {
  it('apply to a database already at 0040, rather than being silently skipped', async () => {
    const { db, migrateTo } = await startMigrationHarness()

    // The boundary immediately before this work.
    await migrateTo('0040')

    const beforeKinds = await db.execute<{ enumlabel: string }>(sql`
      SELECT enumlabel FROM pg_enum
       WHERE enumtypid = 'hr_source_kind'::regtype
       ORDER BY enumsortorder
    `)
    expect(beforeKinds.rows.map((row) => row.enumlabel)).toEqual(['csv_url'])

    await migrateTo('latest')

    // ---- 0041: the second feed kind, and the column it configures.
    const afterKinds = await db.execute<{ enumlabel: string }>(sql`
      SELECT enumlabel FROM pg_enum
       WHERE enumtypid = 'hr_source_kind'::regtype
       ORDER BY enumsortorder
    `)
    expect(afterKinds.rows.map((row) => row.enumlabel)).toEqual(['csv_url', 'rest_json'])

    const configColumn = await db.execute<{ data_type: string; is_nullable: string; column_default: string }>(sql`
      SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_name = 'hr_sources' AND column_name = 'config'
    `)
    expect(configColumn.rows).toHaveLength(1)
    expect(configColumn.rows[0]).toMatchObject({ data_type: 'jsonb', is_nullable: 'NO' })

    // ---- 0042: the SCIM slots, on BOTH enums, which must stay one-for-one
    // (SyncWorker writes `event.target` straight into
    // `external_identities.system` with no mapping table).
    const targets = await db.execute<{ enumlabel: string }>(sql`
      SELECT enumlabel FROM pg_enum WHERE enumtypid = 'outbox_target'::regtype ORDER BY enumsortorder
    `)
    const systems = await db.execute<{ enumlabel: string }>(sql`
      SELECT enumlabel FROM pg_enum WHERE enumtypid = 'external_identity_system'::regtype ORDER BY enumsortorder
    `)

    const targetLabels = targets.rows.map((row) => row.enumlabel)
    const systemLabels = systems.rows.map((row) => row.enumlabel)

    for (const slot of ['scim_slack', 'scim_zoom', 'scim_atlassian', 'scim_box', 'scim_snowflake', 'scim_generic']) {
      expect(targetLabels).toContain(slot)
      expect(systemLabels).toContain(slot)
    }
    expect(targetLabels).toEqual(systemLabels)

    // And the migrated database agrees with the compile-time catalog, in both
    // directions — the same equivalence connector-target-catalog.spec.ts
    // asserts against the schema definition, here against real Postgres.
    expect([...targetLabels].sort()).toEqual([...ALL_CONNECTOR_TARGETS].sort())
  })

  /** A row written with a new enum value must be readable back — proof the ALTER TYPE genuinely committed rather than merely parsing. */
  it('accepts a rest_json source and a scim target row after the upgrade', async () => {
    const { db, migrateTo } = await startMigrationHarness()
    await migrateTo('latest')

    const [{ id: organizationId }] = (
      await db.execute<{ id: string }>(sql`SELECT id FROM organizations WHERE is_master`)
    ).rows

    await db.execute(sql`
      INSERT INTO hr_sources (organization_id, name, kind, url, config)
      VALUES (${organizationId}, 'JSON feed', 'rest_json', 'https://hr.example.com/api',
              ${JSON.stringify({ recordsPath: 'data.items', pagination: { mode: 'none' } })}::jsonb)
    `)
    const source = await db.execute<{ kind: string; config: Record<string, unknown> }>(
      sql`SELECT kind, config FROM hr_sources WHERE name = 'JSON feed'`,
    )
    expect(source.rows[0].kind).toBe('rest_json')
    expect(source.rows[0].config).toMatchObject({ recordsPath: 'data.items' })

    await db.execute(sql`
      INSERT INTO connector_targets (organization_id, target, enabled)
      VALUES (${organizationId}, 'scim_slack', true)
    `)
    const target = await db.execute<{ target: string }>(
      sql`SELECT target FROM connector_targets WHERE target = 'scim_slack'`,
    )
    expect(target.rows[0].target).toBe('scim_slack')
  })
})
