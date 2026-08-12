import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  AttributeMigrationJob,
  MAX_UNCONVERTIBLE_SAMPLE,
} from '../src/attributes/attribute-migration.job'
import { NotFoundError, ValidationError } from '../src/common/errors'
import { attributeDefinitions } from '../src/db/schema/attribute-definitions'
import { orgUnits } from '../src/db/schema/org-units'
import { users } from '../src/db/schema/users'
import { OrganizationsRepository } from '../src/organizations/organizations.repository'
import { withTestDatabase } from './support/pg'

/**
 * Milestone 8 (attribute-definitions write path), Task 8 — the migration
 * job's PREVIEW half.
 *
 * A `dataType` change rewrites values in `users.attributes` IN PLACE, so the
 * only thing standing between an admin and an irreversible directory-wide
 * overwrite is a report they can read first. Everything asserted here is a
 * property of that report: that it counts the right population, that it names
 * the values it cannot convert instead of coercing them, that it writes
 * NOTHING, and that its hash is specific enough that an authorisation to
 * commit cannot outlive the state it was computed from.
 *
 * `withTestDatabase()` starts ONE container per FILE and nothing truncates
 * between `it` blocks, so every fixture below takes a per-call unique
 * attribute key. The population walk selects holders of a KEY across the
 * whole `users` table (the definition table has no tenant column — see the
 * job's own doc comment), so a shared literal key would let one test's users
 * land in another test's population.
 */
describe('AttributeMigrationJob.preview', () => {
  const ctx = withTestDatabase()

  function job(): AttributeMigrationJob {
    return new AttributeMigrationJob(ctx.db)
  }

  /** Unique per call, and legal under attributes/attribute-key.ts (letters, digits, underscore). */
  function uniqueKey(prefix: string): string {
    return `${prefix}_${randomUUID().replace(/-/g, '_')}`.slice(0, 64)
  }

  async function masterOrgId(): Promise<string> {
    const master = await new OrganizationsRepository(ctx.db).findMaster()
    return master.id
  }

  async function seedDefinition(
    over: Partial<typeof attributeDefinitions.$inferInsert> = {},
  ): Promise<{ id: string; key: string }> {
    const key = typeof over.key === 'string' ? over.key : uniqueKey('attr')
    const [row] = await ctx.db
      .insert(attributeDefinitions)
      .values({ key, label: 'Seeded', dataType: 'string', appliesTo: 'user', ...over })
      .returning()
    return { id: row.id, key: row.key }
  }

  /**
   * One user per entry in `values`, each carrying that value under `key`.
   * `undefined` seeds a user with NO such attribute at all — the control
   * group that proves the population is holders, not the directory.
   */
  async function seedHolders(key: string, values: readonly unknown[]): Promise<string[]> {
    return seedUsers(values.map((value) => (value === undefined ? {} : { [key]: value })))
  }

  /** One user per attribute bag, carrying exactly that bag. */
  async function seedUsers(bags: readonly Record<string, unknown>[]): Promise<string[]> {
    const organizationId = await masterOrgId()
    const discriminator = randomUUID().replace(/-/g, '_').slice(0, 12)
    const [unit] = await ctx.db
      .insert(orgUnits)
      .values({
        name: `Attr Migration ${discriminator}`,
        path: `attr_migration_${discriminator}`,
        organizationId,
      })
      .returning()

    const rows = await ctx.db
      .insert(users)
      .values(
        bags.map((attributes, index) => ({
          status: 'active' as const,
          organizationId,
          primaryEmail: `attr-migration-${discriminator}-${index}@example.com`,
          username: `attr-migration-${discriminator}-${index}`,
          firstName: 'Attr',
          lastName: `Holder ${index}`,
          displayName: `Attr Holder ${index}`,
          orgUnitId: unit.id,
          attributes,
        })),
      )
      .returning()

    return rows.map((row) => row.id)
  }

  /** Every user row that exists right now, ordered, as plain JSON — a byte-for-byte before/after snapshot. */
  async function snapshotUsers(): Promise<string> {
    const rows = await ctx.db.select().from(users).orderBy(asc(users.id))
    return JSON.stringify(rows)
  }

  it('counts the convertible and the unconvertible halves of the population separately', async () => {
    const { id, key } = await seedDefinition({ dataType: 'string' })
    await seedHolders(key, ['1', '2', 'oops', ''])

    const report = await job().preview(id, { dataType: 'number' })

    expect(report.populationSize).toBe(4)
    expect(report.changedCount).toBe(2)
    expect(report.unconvertible).toHaveLength(2)
    expect(report.unconvertible.map((entry) => entry.value).sort()).toEqual(['', 'oops'])
    for (const entry of report.unconvertible) {
      expect(entry.reason).toMatch(/not a plain decimal number/)
      expect(entry.userId).toMatch(/^[0-9a-f-]{36}$/)
    }
  })

  it('counts holders of the attribute, not every user in the directory', async () => {
    const { id, key } = await seedDefinition({ dataType: 'string' })
    // Three holders and three users who have never held this attribute.
    await seedHolders(key, ['1', '2', '3', undefined, undefined, undefined])

    const report = await job().preview(id, { dataType: 'number' })

    // A migration touching all three holders of a rare attribute is TOTAL for
    // that attribute and must read as 100% — not as a rounding error against
    // the size of the directory.
    expect(report.populationSize).toBe(3)
    expect(report.changedCount).toBe(3)
    expect(report.blastRadius.populationSize).toBe(3)
  })

  it('writes nothing — the users table is byte-identical afterwards', async () => {
    const { id, key } = await seedDefinition({ dataType: 'string' })
    await seedHolders(key, ['1', 'oops', 'true'])

    const before = await snapshotUsers()
    await job().preview(id, { dataType: 'number' })
    const after = await snapshotUsers()

    expect(after).toBe(before)
  })

  it('bounds the unconvertible sample, while still counting the whole population', async () => {
    const { id, key } = await seedDefinition({ dataType: 'string' })
    const oversized = MAX_UNCONVERTIBLE_SAMPLE + 5
    await seedHolders(
      key,
      Array.from({ length: oversized }, (_, index) => `not-a-number-${index}`),
    )

    const report = await job().preview(id, { dataType: 'number' })

    expect(report.populationSize).toBe(oversized)
    expect(report.changedCount).toBe(0)
    // The list comes from the database and is otherwise unbounded — a sample,
    // never the whole thing.
    expect(report.unconvertible).toHaveLength(MAX_UNCONVERTIBLE_SAMPLE)
  })

  it('trips the blast radius only when both the percentage and the floor are exceeded', async () => {
    const { id, key } = await seedDefinition({ dataType: 'string' })
    // Ten holders, all convertible: 100% of the population, and ten is well
    // past the floor of five.
    await seedHolders(key, Array.from({ length: 10 }, (_, index) => String(index)))

    const total = await job().preview(id, { dataType: 'number' })
    expect(total.changedCount).toBe(10)
    expect(total.blastRadius.tripped).toBe(true)

    // The same definition with a population that is mostly unconvertible:
    // 4 changed is still 20%-plus of 20, but it is under the floor, so a
    // small real batch is not treated as an incident.
    const small = await seedDefinition({ dataType: 'string' })
    await seedHolders(small.key, [
      ...Array.from({ length: 4 }, (_, index) => String(index)),
      ...Array.from({ length: 16 }, () => 'oops'),
    ])

    const report = await job().preview(small.id, { dataType: 'number' })
    expect(report.changedCount).toBe(4)
    expect(report.blastRadius.tripped).toBe(false)
  })

  it('gives the same preview hash for the same population and change, twice', async () => {
    const { id, key } = await seedDefinition({ dataType: 'string' })
    await seedHolders(key, ['1', '2'])

    const first = await job().preview(id, { dataType: 'number' })
    const second = await job().preview(id, { dataType: 'number' })

    expect(second.previewHash).toBe(first.previewHash)
  })

  it('gives a different preview hash when the change differs', async () => {
    const { id, key } = await seedDefinition({ dataType: 'string' })
    await seedHolders(key, ['true', 'false'])

    const toBoolean = await job().preview(id, { dataType: 'boolean' })
    const toString = await job().preview(id, { dataType: 'string' })
    const toGroup = await job().preview(id, { dataType: 'boolean', appliesTo: 'group' })

    expect(new Set([toBoolean.previewHash, toString.previewHash, toGroup.previewHash]).size).toBe(3)
  })

  it('gives a different preview hash for a different definition with an identical population', async () => {
    const first = await seedDefinition({ dataType: 'string' })
    const second = await seedDefinition({ dataType: 'string' })
    // The SAME users hold both attributes, with the same values — so the two
    // walks see an identical id set and identical values, and only the
    // definition identity in the hash's header can tell the previews apart.
    // Seeding two separate populations would let differing user ids pass this
    // test with the definition id absent from the hash entirely.
    await seedUsers([
      { [first.key]: '1', [second.key]: '1' },
      { [first.key]: '2', [second.key]: '2' },
    ])

    const a = await job().preview(first.id, { dataType: 'number' })
    const b = await job().preview(second.id, { dataType: 'number' })

    expect(a.previewHash).not.toBe(b.previewHash)
  })

  it('gives a different preview hash once another user joins the population', async () => {
    const { id, key } = await seedDefinition({ dataType: 'string' })
    await seedHolders(key, ['1'])

    const before = await job().preview(id, { dataType: 'number' })
    await seedHolders(key, ['2'])
    const after = await job().preview(id, { dataType: 'number' })

    expect(after.previewHash).not.toBe(before.previewHash)
  })

  it('gives a different preview hash once a holder’s value is edited', async () => {
    const { id, key } = await seedDefinition({ dataType: 'string' })
    const [userId] = await seedHolders(key, ['1'])

    const before = await job().preview(id, { dataType: 'number' })

    // The population is the SAME set of user ids; only one value moved. A
    // preview taken before that edit must not be able to authorise a commit
    // after it — the value is what the migration actually rewrites.
    await ctx.db
      .update(users)
      .set({ attributes: { [key]: '2' } })
      .where(eq(users.id, userId))
    const after = await job().preview(id, { dataType: 'number' })

    expect(after.previewHash).not.toBe(before.previewHash)
  })

  it('refuses a change that changes nothing', async () => {
    const { id } = await seedDefinition({ dataType: 'string' })

    await expect(job().preview(id, {})).rejects.toBeInstanceOf(ValidationError)
  })

  it('refuses an unknown definition', async () => {
    await expect(job().preview(randomUUID(), { dataType: 'number' })).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })

  it('refuses a group-scoped definition rather than reporting an empty population', async () => {
    const { id } = await seedDefinition({ dataType: 'string', appliesTo: 'group' })

    // Fail CLOSED: this job walks `users.attributes` only, so a group-scoped
    // definition has no population here. Reporting "0 users affected" would
    // read as "safe to commit" for a migration that would rewrite every
    // group's value unseen.
    await expect(job().preview(id, { dataType: 'number' })).rejects.toBeInstanceOf(ValidationError)
  })
})
