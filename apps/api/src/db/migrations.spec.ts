import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS_FOLDER } from './migrate'

interface JournalEntry {
  idx: number
  when: number
  tag: string
  [key: string]: unknown
}

interface Journal {
  entries: JournalEntry[]
  [key: string]: unknown
}

/**
 * Container-free (no Postgres needed — this only reads the journal and the
 * filesystem), guarding a failure mode `migrate.spec.ts` structurally
 * cannot: `drizzle-orm`'s `PgDialect.migrate()` (pg-core/dialect.js) reads
 * `lastDbMigration` ONCE before looping over `journal.entries` IN ARRAY
 * ORDER, and applies each entry only if
 * `lastDbMigration.created_at < entry.when`. A single replay of the whole
 * journal — which is all `migrate.spec.ts` ever does — stays green
 * regardless of whether `when` ascends, because there is no prior
 * `lastDbMigration` row to compare a middle entry against until the loop has
 * already applied everything before it.
 *
 * The failure only shows up on a database that already has SOME migrations
 * applied and is then upgraded to a NEWER journal whose latest `when` is
 * smaller than what's already recorded — exactly what happened while
 * writing this task: `db:generate` stamped the new entry's `when` with
 * wall-clock generation time, which was LESS than the previous entry's
 * (hand-picked, far-future) `when`, and the new migration would have been
 * silently skipped on any host that had already migrated through the one
 * before it. Caught by manual inspection that time; this test is what
 * catches it next time.
 */
describe('migrations journal', () => {
  const journalPath = path.join(MIGRATIONS_FOLDER, 'meta/_journal.json')
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Journal

  it('has at least one entry', () => {
    expect(journal.entries.length).toBeGreaterThan(0)
  })

  it('has strictly increasing `when` values, in journal order', () => {
    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1]!
      const curr = journal.entries[i]!
      expect(
        curr.when,
        `entries[${i}] ("${curr.tag}", when=${curr.when}) must be greater than ` +
          `entries[${i - 1}] ("${prev.tag}", when=${prev.when}) — otherwise ` +
          `drizzle-orm's PgDialect.migrate() silently skips it on any database ` +
          `that already applied entries[${i - 1}]`,
      ).toBeGreaterThan(prev.when)
    }
  })

  it('has a `.sql` file on disk for every journal entry, by tag', () => {
    for (const entry of journal.entries) {
      const sqlPath = path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`)
      expect(fs.existsSync(sqlPath), `${sqlPath} (journal entry idx=${entry.idx})`).toBe(true)
    }
  })
})
