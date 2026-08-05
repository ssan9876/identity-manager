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
})
