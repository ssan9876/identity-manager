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

  // `__proto__` is the one the module's own doc comments dwell on, but the
  // reserved LIST has three names — a NOT IN with only the first one wired
  // up correctly would still pass that single case.
  it.each(['constructor', 'prototype'])('rejects the reserved key %s too', async (key) => {
    await expect(
      ctx.db.execute(sql`
        INSERT INTO attribute_definitions (key, label, data_type, applies_to)
        VALUES (${key}, 'Reserved', 'string', 'user')
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

  // The exact character that broke three sibling specs' fixtures when this
  // constraint landed (attribute-definitions.controller.spec.ts,
  // jml-rule-applier.spec.ts, self-service.spec.ts all used hyphenated test
  // keys, legal before this task and illegal after) — worth pinning
  // directly, not just inferring from "has space" rejecting.
  it('rejects a key with a hyphen', async () => {
    await expect(
      ctx.db.execute(sql`
        INSERT INTO attribute_definitions (key, label, data_type, applies_to)
        VALUES ('has-hyphen', 'Hyphenated', 'string', 'user')
      `),
    ).rejects.toThrow(/attribute_definitions_key_format/)
  })

  it('rejects a key starting with a digit', async () => {
    await expect(
      ctx.db.execute(sql`
        INSERT INTO attribute_definitions (key, label, data_type, applies_to)
        VALUES ('1st', 'Leading digit', 'string', 'user')
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

  // A CHECK constrains every write path, not just INSERT — and Task 7's
  // PATCH endpoint will lean on exactly this for renaming a definition's
  // key. Proven here against a row this same suite already knows is legal
  // (the "accepts a plain identifier" row above would work too, but seeding
  // a fresh row keeps this test independent of suite ordering).
  it('rejects an UPDATE that renames a key into an illegal shape, not just an INSERT', async () => {
    await ctx.db.execute(sql`
      INSERT INTO attribute_definitions (key, label, data_type, applies_to)
      VALUES ('renameable', 'Renameable', 'string', 'user')
    `)
    await expect(
      ctx.db.execute(sql`
        UPDATE attribute_definitions SET key = 'has space' WHERE key = 'renameable'
      `),
    ).rejects.toThrow(/attribute_definitions_key_format/)
  })
})
