import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_FOLDER } from '../src/db/migrate'

interface JournalEntry {
  tag: string
  [key: string]: unknown
}

interface Journal {
  entries: JournalEntry[]
  [key: string]: unknown
}

/**
 * Milestone 10, Task 3 — "the migrated set must be EXACTLY the previously-
 * syncing set — no more, no fewer." This is proven here against the REAL,
 * literal migration file (0014_known_photon.sql), not a re-implementation of
 * its SQL logic: `readMigrationFiles` (drizzle-orm/migrator.js) hashes each
 * migration file's own byte content and records applied hashes in
 * `drizzle.__drizzle_migrations`, keyed by hash — so pointing `migrate()` at
 * a TEMP folder containing byte-identical copies of every migration EXCEPT
 * this task's own (the journal's last entry), then later pointing it at the
 * REAL, full folder, causes drizzle to recognise every prior migration's
 * hash as already applied and run ONLY the new one — exactly like a
 * production database upgrading from "every migration through 0013" to
 * "0014 lands." This lets the test seed realistic PRE-migration data (a mix
 * of `sync_to_keycloak` true/false, active/inactive, user/group-scoped) and
 * then exercise the actual migration file against it, rather than asserting
 * intent about SQL this test never runs.
 *
 * A dedicated container (not `withTestDatabase()`): every OTHER test file's
 * database is already fully migrated (including this task's own migration)
 * before any test body runs — there is no way to seed pre-migration data
 * against it, since `sync_to_keycloak` no longer exists there by the time a
 * test gets a connection.
 */
describe('attribute_target_mappings migration exactness (Milestone 10, Task 3)', () => {
  let container: StartedPostgreSqlContainer
  let pool: Pool

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start()
    pool = new Pool({ connectionString: container.getConnectionUri() })
    // org_units.path is an ltree column, created by an early migration —
    // required for ANY migration run to succeed, exactly like
    // db/migrate.ts's own runMigrations does before calling `migrate()`.
    await pool.query('CREATE EXTENSION IF NOT EXISTS ltree')
  }, 120_000)

  afterAll(async () => {
    await pool?.end()
    await container?.stop()
  })

  it(
    'produces exactly one (definition, keycloak, key, true) row per previously-syncing definition — no more, no fewer — and drops the boolean column',
    async () => {
      const journalPath = path.join(MIGRATIONS_FOLDER, 'meta/_journal.json')
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Journal
      expect(journal.entries.length).toBeGreaterThan(0)
      // This task's own migration is whichever one is LAST in the journal
      // right now — read dynamically rather than hardcoding a filename, so
      // this test does not silently stop testing the right migration if a
      // later task appends another one after it.
      const priorEntries = journal.entries.slice(0, -1)

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idm-migration-exactness-'))
      try {
        fs.mkdirSync(path.join(tmpDir, 'meta'))
        fs.writeFileSync(
          path.join(tmpDir, 'meta/_journal.json'),
          JSON.stringify({ ...journal, entries: priorEntries }),
        )
        for (const entry of priorEntries) {
          fs.copyFileSync(
            path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
            path.join(tmpDir, `${entry.tag}.sql`),
          )
        }

        // ---- 1. Migrate up to (but not including) this task's own
        // migration — a database frozen at the pre-Task-3 schema.
        await migrate(drizzle(pool), { migrationsFolder: tmpDir })

        // Sanity: confirms the cut genuinely landed BEFORE this task's own
        // migration, not after (a wrong cut point would make the rest of
        // this test pass vacuously).
        const { rows: beforeCols } = await pool.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name = 'attribute_definitions' AND column_name = 'sync_to_keycloak'`,
        )
        expect(beforeCols).toHaveLength(1)
        const { rows: beforeTable } = await pool.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables WHERE table_name = 'attribute_target_mappings'`,
        )
        expect(beforeTable).toHaveLength(0)

        // ---- 2. Seed REALISTIC pre-migration data: true/false crossed
        // with active/inactive and user/group-scoped — the boolean itself
        // never filtered on isActive/appliesTo, so neither should the
        // migration that replaces it.
        const { rows: seeded } = await pool.query<{ id: string; key: string }>(
          `INSERT INTO attribute_definitions (key, label, data_type, applies_to, sync_to_keycloak, is_active)
           VALUES
             ('synced_active_user', 'Synced Active User', 'string', 'user', true, true),
             ('synced_inactive_user', 'Synced Inactive User', 'string', 'user', true, false),
             ('synced_group', 'Synced Group', 'string', 'group', true, true),
             ('not_synced_user', 'Not Synced User', 'string', 'user', false, true),
             ('not_synced_group', 'Not Synced Group', 'string', 'group', false, false)
           RETURNING id, key`,
        )
        expect(seeded).toHaveLength(5)
        const previouslySyncingKeys = [
          'synced_active_user',
          'synced_group',
          'synced_inactive_user',
        ] // sorted, matches the ORDER BY below

        // ---- 3. Apply the REAL, full migrations folder. Because every
        // PRIOR migration's file content (and therefore hash) is byte-
        // identical to what was just applied from the temp folder, drizzle
        // recognises them as already-applied and runs ONLY this task's own
        // migration — the literal file this project ships.
        await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER })

        // ---- 4. The boolean column is genuinely gone.
        const { rows: afterCols } = await pool.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name = 'attribute_definitions' AND column_name = 'sync_to_keycloak'`,
        )
        expect(afterCols).toHaveLength(0)

        // ---- 5. THE exactness assertion. EXACTLY the previously-syncing
        // set, no more, no fewer — every migrated row's remote_name equals
        // its own definition's key (byte-for-byte-unchanged Keycloak wire
        // shape), target is 'keycloak', and enabled is true.
        const { rows: mapped } = await pool.query<{
          key: string
          target: string
          remote_name: string
          enabled: boolean
        }>(
          `SELECT ad.key, atm.target, atm.remote_name, atm.enabled
           FROM attribute_target_mappings atm
           JOIN attribute_definitions ad ON ad.id = atm.attribute_definition_id
           WHERE ad.id = ANY($1::uuid[])
           ORDER BY ad.key`,
          [seeded.map((row) => row.id)],
        )

        expect(mapped.map((row) => row.key)).toEqual(previouslySyncingKeys)
        for (const row of mapped) {
          expect(row.target).toBe('keycloak')
          expect(row.remote_name).toBe(row.key)
          expect(row.enabled).toBe(true)
        }

        // Not merely "the JOIN above didn't return them" — genuinely zero
        // attribute_target_mappings rows reference either `false` definition
        // at all, under any target.
        const notSyncedIds = seeded
          .filter((row) => row.key.startsWith('not_synced'))
          .map((row) => row.id)
        const { rows: shouldBeEmpty } = await pool.query(
          `SELECT 1 FROM attribute_target_mappings WHERE attribute_definition_id = ANY($1::uuid[])`,
          [notSyncedIds],
        )
        expect(shouldBeEmpty).toHaveLength(0)

        // And the total row count for THIS test's own fixtures is exactly
        // 3 — not just "contains at least the right ones" (which would
        // pass even if the migration also produced spurious extra rows for
        // the SAME definitions, e.g. one per target it should not have
        // touched).
        const { rows: totalForFixtures } = await pool.query(
          `SELECT count(*)::int AS n FROM attribute_target_mappings WHERE attribute_definition_id = ANY($1::uuid[])`,
          [seeded.map((row) => row.id)],
        )
        expect(totalForFixtures[0]?.n).toBe(3)
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    },
    120_000,
  )
})
