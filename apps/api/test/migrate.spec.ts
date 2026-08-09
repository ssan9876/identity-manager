import { describe, expect, it } from 'vitest'
import { withTestDatabase } from './support/pg'

describe('runMigrations', () => {
  const ctx = withTestDatabase()

  it('enables the ltree extension', async () => {
    const { rows } = await ctx.pool.query(
      `SELECT extname FROM pg_extension WHERE extname = 'ltree'`,
    )
    expect(rows).toHaveLength(1)
  })

  it('is idempotent when run twice', async () => {
    await expect(ctx.runMigrationsAgain()).resolves.toBeUndefined()
  })

  /**
   * Milestone 19, Task 16. `0027_jml_group_actions_removed.sql` is a GUARD,
   * not a schema change: Postgres cannot `DROP VALUE` from an enum, so
   * `jml_action` keeps `add_to_group`/`remove_from_group` forever and a stored
   * rule can still name one. Application code rejects those, which means a
   * surviving rule would simply stop firing — and a silently dead rule is a
   * permission somebody still believes is being maintained. The migration
   * therefore refuses to run while any such row exists.
   *
   * Written with `ownerPool` because the migration runs as the OWNER role.
   */
  describe('0027 refuses to strand a JML rule naming a removed action', () => {
    it('fails with a message naming the count, then succeeds once the row is gone', async () => {
      const orgUnit = await ctx.ownerPool.query<{ id: string }>(
        `INSERT INTO org_units (name, path, organization_id)
         VALUES ('Migration Guard Unit', 'migration_guard_unit',
                 (SELECT id FROM organizations WHERE is_master))
         RETURNING id`,
      )
      expect(orgUnit.rows).toHaveLength(1)

      await ctx.ownerPool.query(
        `INSERT INTO jml_rules (name, trigger, condition_field, condition_operator,
                                condition_value, action, action_params)
         VALUES ('stranded group rule', 'user_created', 'jobTitle', 'equals',
                 '"Engineer"'::jsonb, 'add_to_group', '{"groupId":"x"}'::jsonb)`,
      )

      // Drizzle applies only migrations whose journal `when` is greater than
      // the MAX `created_at` already recorded, so a plain re-run skips 0027
      // entirely — it is already applied, and the guard would never execute.
      // Rewinding the ledger to just before it reproduces the state that
      // actually matters: an existing database that has NOT yet taken this
      // migration and still holds a stranded rule. (This is also why the
      // guard cannot protect a database retroactively — it only ever runs
      // once, on the way past.)
      //
      // The rewind is to 0027's own journal `when`, NOT to "the newest row".
      // It used to be the latter, which silently stopped testing 0027 the
      // moment a later migration landed: it would rewind to the newest
      // migration instead and re-run that one. Because everything from 0027
      // onwards re-runs, every migration after it must be re-runnable —
      // 0028 and 0029 are written that way on purpose, and any new one must
      // be too.
      const JML_GUARD_MIGRATION_WHEN = 1786286024010
      await ctx.ownerPool.query(
        `DELETE FROM drizzle.__drizzle_migrations WHERE created_at >= $1`,
        [JML_GUARD_MIGRATION_WHEN],
      )

      await expect(ctx.runMigrationsAgain()).rejects.toThrow(/1 jml_rules row\(s\)/)

      await ctx.ownerPool.query(`DELETE FROM jml_rules WHERE name = 'stranded group rule'`)

      // Idempotent again once the stranded row is gone — the guard writes
      // nothing, so a clean table simply passes.
      await expect(ctx.runMigrationsAgain()).resolves.toBeUndefined()
    })
  })
})
