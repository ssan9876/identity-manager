import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { withTestDatabase } from './support/pg'

/**
 * Milestone 8 (attribute-definitions write path), Task 2 — the database
 * `CHECK` behind attributes/attribute-key.ts's application rule.
 *
 * Application validation can be bypassed by a hand-written `INSERT` — which
 * is precisely how every existing `attribute_definitions` row was created.
 * These tests go around the application entirely, straight through `db`
 * (the runtime role's own connection, same as production), to prove the
 * rule is now true of the DATA, not just of one controller.
 */
describe('attribute_definitions_key_format', () => {
  const ctx = withTestDatabase()

  it('rejects a reserved key at the database level, not just in the API', async () => {
    await expect(
      ctx.db.execute(sql`
        INSERT INTO attribute_definitions (key, label, data_type, applies_to)
        VALUES ('__proto__', 'Proto', 'string', 'user')
      `),
    ).rejects.toThrow(/attribute_definitions_key_format/)
  })

  it('rejects a key with a space', async () => {
    await expect(
      ctx.db.execute(sql`
        INSERT INTO attribute_definitions (key, label, data_type, applies_to)
        VALUES ('has space', 'Spaced', 'string', 'user')
      `),
    ).rejects.toThrow(/attribute_definitions_key_format/)
  })

  it('accepts a plain identifier', async () => {
    await expect(
      ctx.db.execute(sql`
        INSERT INTO attribute_definitions (key, label, data_type, applies_to)
        VALUES ('cost_centre', 'Cost centre', 'string', 'user')
      `),
    ).resolves.toBeDefined()
  })
})
