import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { onTestFinished } from 'vitest'
import { MIGRATIONS_FOLDER } from '../../src/db/migrate'
import { swallowShutdownErrors } from './pg'

const REQUIRED_EXTENSIONS = ['ltree'] as const

interface JournalEntry {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}

interface Journal {
  version: string
  dialect: string
  entries: JournalEntry[]
}

export interface MigrationHarness {
  /**
   * A plain connection to the throwaway database — the container's own
   * bootstrap role, equivalent to `withTestDatabase()`'s `ownerDb`. Used to
   * seed rows directly and to inspect schema state at a given migration
   * boundary, never to exercise application code under the restricted
   * RUNTIME role (that is `withTestDatabase()`'s job, not this one).
   */
  db: NodePgDatabase
  /**
   * Applies every migration up to and including the one whose filename
   * starts with `tag` (e.g. `'0021'`), or every migration currently on disk
   * when `tag` is `'latest'`. Repeatable: drizzle's migrator tracks what it
   * has already applied (`drizzle.__drizzle_migrations`), so calling this
   * again with a LATER tag applies only the newly-included migrations.
   *
   * Exists for tests that need to observe a SPECIFIC migration boundary —
   * e.g. organizations.migration.spec.ts, which seeds data against the
   * pre-organizations schema and then migrates forward to watch the
   * backfill adopt it — which `withTestDatabase()` cannot do, since it
   * always applies every migration up front in one shot.
   */
  migrateTo: (tag: string) => Promise<void>
}

function readJournal(): Journal {
  const journalPath = path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json')
  return JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Journal
}

/**
 * A migrations folder drizzle's own `migrate()` can read — `meta/_journal.json`
 * plus the `.sql` files it names — but containing only the entries up to and
 * including `tag`, so migrations after the boundary this test wants to
 * observe are never applied. drizzle-kit's `readMigrationFiles` reads the
 * WHOLE journal off disk with no "stop here" option, so filtering has to
 * happen at the filesystem level, not by config.
 */
function buildFilteredMigrationsFolder(tag: string): string {
  const journal = readJournal()
  const cutoff = journal.entries.findIndex((entry) => entry.tag.startsWith(`${tag}_`))
  if (cutoff === -1) {
    throw new Error(`no migration tagged "${tag}" found in ${MIGRATIONS_FOLDER}/meta/_journal.json`)
  }

  const entries = journal.entries.slice(0, cutoff + 1)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idm-migration-harness-'))
  fs.mkdirSync(path.join(tempDir, 'meta'))
  fs.writeFileSync(path.join(tempDir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }))
  for (const entry of entries) {
    fs.copyFileSync(
      path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
      path.join(tempDir, `${entry.tag}.sql`),
    )
  }
  return tempDir
}

/**
 * Starts a throwaway Postgres container and returns a harness that can
 * migrate it forward one boundary at a time. Unlike `withTestDatabase()`
 * (`test/support/pg.ts`), this is called directly from inside a test body,
 * not `beforeAll` — the whole point is the caller controls exactly when
 * each migration boundary is crossed relative to its own seed data.
 */
export async function startMigrationHarness(): Promise<MigrationHarness> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine').start()

  const pool = new Pool({ connectionString: container.getConnectionUri() })
  swallowShutdownErrors(pool)
  const db = drizzle(pool)

  onTestFinished(async () => {
    await pool.end()
    await container.stop()
  })

  for (const extension of REQUIRED_EXTENSIONS) {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS ${extension}`)
  }

  const migrateTo = async (tag: string): Promise<void> => {
    if (tag === 'latest') {
      await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER })
      return
    }

    const tempDir = buildFilteredMigrationsFolder(tag)
    try {
      await migrate(drizzle(pool), { migrationsFolder: tempDir })
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  }

  return { db, migrateTo }
}
