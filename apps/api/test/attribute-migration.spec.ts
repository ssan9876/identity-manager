import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  AttributeMigrationJob,
  MAX_UNCONVERTIBLE_SAMPLE,
} from '../src/attributes/attribute-migration.job'
import { AuditWriter } from '../src/audit/audit.writer'
import { ConflictError, NotFoundError, ValidationError } from '../src/common/errors'
import { attributeDefinitions } from '../src/db/schema/attribute-definitions'
import { auditLog } from '../src/db/schema/audit-log'
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
const ctx = withTestDatabase()

function job(): AttributeMigrationJob {
  return new AttributeMigrationJob(ctx.db, new AuditWriter())
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

describe('AttributeMigrationJob.preview', () => {
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

/**
 * Milestone 8, Task 9 — the migration job's COMMIT half.
 *
 * Preview is a report; commit is the irreversible part. Everything asserted
 * here is a property of a REFUSAL or of the record left behind: that an
 * authorisation cannot outlive the state it was computed from, that no
 * override reaches a value which cannot survive the conversion, that an
 * oversized migration needs an explicit override, and — the point of the
 * whole exercise — that the audit row it writes is enough to put every
 * overwritten value back.
 *
 * Every refusal test also asserts that NOTHING moved: the stored values, the
 * definition's own `dataType`, and the absence of an audit row. A refusal
 * that leaves half a migration behind is worse than no refusal, and only the
 * after-state can tell the two apart.
 */
describe('AttributeMigrationJob.commit', () => {
  /** A real user row — `audit_log.actor_user_id` is a FK, so an invented uuid cannot be an actor. */
  async function seedActor(): Promise<string> {
    const [actorUserId] = await seedUsers([{}])
    return actorUserId
  }

  /** Every audit row written against this definition, oldest first. */
  async function auditRowsFor(definitionId: string): Promise<(typeof auditLog.$inferSelect)[]> {
    return ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.resourceType, 'attribute_definition'),
          eq(auditLog.resourceId, definitionId),
        ),
      )
      .orderBy(asc(auditLog.id))
  }

  /** The value each of `userIds` currently stores under `key`, in the order given. */
  async function storedValues(userIds: readonly string[], key: string): Promise<unknown[]> {
    const rows = await ctx.db
      .select({ id: users.id, attributes: users.attributes })
      .from(users)
      .where(inArray(users.id, [...userIds]))
    const byId = new Map(rows.map((row) => [row.id, row.attributes[key]]))
    return userIds.map((userId) => byId.get(userId))
  }

  async function storedDataType(definitionId: string): Promise<string> {
    const [row] = await ctx.db
      .select()
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.id, definitionId))
    return row.dataType
  }

  it('refuses when the preview hash does not match the change being committed', async () => {
    const { id, key } = await seedDefinition({ dataType: 'string' })
    const holders = await seedHolders(key, ['1', '2'])
    const actorUserId = await seedActor()

    const preview = await job().preview(id, { dataType: 'number' })

    // (a) A preview authorises THE CHANGE IT WAS TAKEN FOR. The population is
    // untouched and the definition is untouched; only the target type differs,
    // and that alone must invalidate the authorisation.
    await expect(
      job().commit(id, { dataType: 'boolean' }, preview.previewHash, { actorUserId }),
    ).rejects.toBeInstanceOf(ConflictError)

    // (b) ...and it stops being valid the moment the population moves under
    // it. Same id set, one edited value — the very thing the commit would
    // overwrite, and the thing nobody has previewed.
    await ctx.db
      .update(users)
      .set({ attributes: { [key]: '3' } })
      .where(eq(users.id, holders[0]))

    await expect(
      job().commit(id, { dataType: 'number' }, preview.previewHash, { actorUserId }),
    ).rejects.toBeInstanceOf(ConflictError)

    // A refusal writes nothing at all — not the values, not the definition,
    // not an audit row.
    expect(await storedValues(holders, key)).toEqual(['3', '2'])
    expect(await storedDataType(id)).toBe('string')
    expect(await auditRowsFor(id)).toHaveLength(0)
  })

  it('refuses when any value is unconvertible, even with force', async () => {
    const { id, key } = await seedDefinition({ dataType: 'string' })
    const holders = await seedHolders(key, ['1', 'oops'])
    const actorUserId = await seedActor()

    const preview = await job().preview(id, { dataType: 'number' })
    expect(preview.unconvertible).toHaveLength(1)

    // `force` is the BLAST-RADIUS override and nothing else. "Too many rows"
    // is a judgement an operator may overrule; "this value cannot survive the
    // conversion" is not — overruling it would silently destroy the value.
    const refusal = job().commit(id, { dataType: 'number' }, preview.previewHash, {
      actorUserId,
      force: true,
    })
    await expect(refusal).rejects.toBeInstanceOf(ValidationError)
    await expect(refusal).rejects.toThrow(/oops/)

    expect(await storedValues(holders, key)).toEqual(['1', 'oops'])
    expect(await storedDataType(id)).toBe('string')
    expect(await auditRowsFor(id)).toHaveLength(0)
  })

  it('refuses when the blast radius is exceeded, and allows it with force', async () => {
    const { id, key } = await seedDefinition({ dataType: 'string' })
    // Ten holders, all convertible: 100% of the population, and ten is past
    // the floor of five, so the guard trips.
    const holders = await seedHolders(key, Array.from({ length: 10 }, (_, index) => String(index)))
    const actorUserId = await seedActor()

    const preview = await job().preview(id, { dataType: 'number' })
    expect(preview.blastRadius.tripped).toBe(true)

    await expect(
      job().commit(id, { dataType: 'number' }, preview.previewHash, { actorUserId }),
    ).rejects.toBeInstanceOf(ValidationError)

    expect(await storedValues(holders, key)).toEqual(holders.map((_, index) => String(index)))
    expect(await storedDataType(id)).toBe('string')
    expect(await auditRowsFor(id)).toHaveLength(0)

    // The same request, explicitly overridden — the hash is still valid
    // because the refusal changed nothing.
    const report = await job().commit(id, { dataType: 'number' }, preview.previewHash, {
      actorUserId,
      force: true,
    })

    expect(report.changedCount).toBe(10)
    expect(await storedValues(holders, key)).toEqual(holders.map((_, index) => index))
    expect(await storedDataType(id)).toBe('number')

    const rows = await auditRowsFor(id)
    expect(rows.map((row) => row.action)).toEqual(['attribute_definition:migrate'])
    // The override leaves a trace of itself. An overridden migration and an
    // ordinary one are not the same event and must not read alike.
    expect((rows[0].after as { forced?: unknown }).forced).toBe(true)
  })

  it('writes the before-values into the audit row, so the migration is reversible', async () => {
    const { id, key } = await seedDefinition({ dataType: 'string' })
    const holders = await seedHolders(key, ['1', '2', '3'])
    const actorUserId = await seedActor()

    const preview = await job().preview(id, { dataType: 'number' })
    // Three changed is under the floor of five, so this needs no override —
    // the reversibility of an ORDINARY migration is what is being tested.
    expect(preview.blastRadius.tripped).toBe(false)

    await job().commit(id, { dataType: 'number' }, preview.previewHash, { actorUserId })

    expect(await storedValues(holders, key)).toEqual([1, 2, 3])

    const rows = await auditRowsFor(id)
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('attribute_definition:migrate')
    expect(rows[0].actorUserId).toBe(actorUserId)

    const before = rows[0].before as {
      definition: { dataType: string }
      values: { userId: string; value: unknown }[]
    }
    expect(before.definition.dataType).toBe('string')
    // Compared as a SET of pairs: the walk emits holders in user-id order (a
    // keyset walk — see `walkHolders`), which is not the order they were
    // seeded in. What has to hold is the pairing of every changed holder with
    // the value it held, not the sequence.
    const byUserId = (a: { userId: string }, b: { userId: string }) =>
      a.userId.localeCompare(b.userId)
    expect([...before.values].sort(byUserId)).toEqual(
      holders.map((userId, index) => ({ userId, value: String(index + 1) })).sort(byUserId),
    )

    // THE POINT: the audit row alone is enough to put every overwritten value
    // back. Nothing else in this system holds the pre-migration values — the
    // UPDATE overwrote them in place — so if this reversal cannot be driven
    // from `before`, the migration is a one-way door.
    for (const entry of before.values) {
      await ctx.db
        .update(users)
        .set({ attributes: { [key]: entry.value } })
        .where(eq(users.id, entry.userId))
    }

    expect(await storedValues(holders, key)).toEqual(['1', '2', '3'])
  })

  /**
   * THE TENSION THIS SETTLES, and why the answer is no longer a flat refusal.
   *
   * A migration is reversible because its audit row carries the before-values
   * (see the test above) — and `sensitive` is precisely the flag saying this
   * attribute's values must NEVER be copied into `audit_log`, whose
   * UPDATE/DELETE/TRUNCATE are blocked by privilege AND trigger (SEC-M1).
   * Writing them would reintroduce that finding permanently; writing a
   * redacted row would overwrite the most sensitive values in the directory
   * with no way back at all.
   *
   * But that argument only holds when the values are NEEDED to reverse the
   * migration. `'1'` -> `1` -> `'1'` returns exactly what it started as, so
   * the undo is a computation, not a lookup, and there is nothing to record.
   * The refusal now applies to migrations that genuinely lose something, and
   * the flag no longer blocks the ones that do not.
   */
  it('migrates a sensitive definition when every value converts back, recording NO values', async () => {
    const { id, key } = await seedDefinition({ dataType: 'string', sensitive: true })
    const holders = await seedHolders(key, ['1', '2'])
    const actorUserId = await seedActor()

    const preview = await job().preview(id, { dataType: 'number' })
    await job().commit(id, { dataType: 'number' }, preview.previewHash, { actorUserId })

    expect(await storedValues(holders, key)).toEqual([1, 2])
    expect(await storedDataType(id)).toBe('number')

    const [row] = await auditRowsFor(id)
    const before = row.before as { values: { userId: string; value?: unknown }[] }
    const after = row.after as { values: { userId: string; value?: unknown }[]; reversibleByInverseConversion: boolean }

    // The holders are named — an undo has to know whom to touch — but not one
    // value appears on either side. An id is not the thing SEC-M1 is about.
    expect(before.values.map((v) => v.userId).sort()).toEqual([...holders].sort())
    expect(before.values.every((v) => !('value' in v))).toBe(true)
    expect(after.values.every((v) => !('value' in v))).toBe(true)
    expect(after.reversibleByInverseConversion).toBe(true)

    // And the row genuinely holds no trace of them, however it is serialised.
    expect(JSON.stringify(row)).not.toContain('"1"')
  })

  it('still refuses a sensitive definition when a value would not survive the round trip', async () => {
    const { id, key } = await seedDefinition({ dataType: 'string', sensitive: true })
    // '1.50' CONVERTS to 1.5 — the number rule ignores presentational zeros —
    // but converts BACK to '1.5', which is not what the user had. That lost
    // trailing zero is exactly the kind of thing the before-values exist to
    // restore, and exactly what may not be written here.
    const holders = await seedHolders(key, ['1.50', '2'])
    const actorUserId = await seedActor()

    const preview = await job().preview(id, { dataType: 'number' })

    const refusal = job().commit(id, { dataType: 'number' }, preview.previewHash, {
      actorUserId,
      force: true,
    })
    await expect(refusal).rejects.toBeInstanceOf(ValidationError)
    await expect(refusal).rejects.toThrow(/sensitive/)

    expect(await storedValues(holders, key)).toEqual(['1.50', '2'])
    expect(await storedDataType(id)).toBe('string')
    expect(await auditRowsFor(id)).toHaveLength(0)
  })

  it('refuses to move a definition to groups, which would orphan every value it just converted', async () => {
    const { id, key } = await seedDefinition({ dataType: 'string' })
    const holders = await seedHolders(key, ['1'])
    const actorUserId = await seedActor()

    const preview = await job().preview(id, { dataType: 'number', appliesTo: 'group' })

    // The converted values would stay in `users.attributes` while the
    // definition governing them started reading `groups.attributes` — the
    // same asymmetry `plan` already refuses from the other side.
    await expect(
      job().commit(id, { dataType: 'number', appliesTo: 'group' }, preview.previewHash, {
        actorUserId,
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    expect(await storedValues(holders, key)).toEqual(['1'])
    expect(await storedDataType(id)).toBe('string')
    expect(await auditRowsFor(id)).toHaveLength(0)
  })

  it('carries the definition’s own defaultValue across, and refuses one that cannot survive', async () => {
    const { id, key } = await seedDefinition({ dataType: 'string', defaultValue: '7' })
    await seedHolders(key, ['1'])
    const actorUserId = await seedActor()

    const preview = await job().preview(id, { dataType: 'number' })
    await job().commit(id, { dataType: 'number' }, preview.previewHash, { actorUserId })

    // A default is a VALUE of its own attribute, inherited by every user who
    // never sets one, so it goes through the same conversion. Left behind as
    // the string '7' under dataType number it would fail its own definition
    // on the first user who inherited it.
    const [row] = await ctx.db
      .select()
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.id, id))
    expect(row.defaultValue).toBe(7)

    const bad = await seedDefinition({ dataType: 'string', defaultValue: 'not-a-number' })
    await seedHolders(bad.key, ['1'])
    const badPreview = await job().preview(bad.id, { dataType: 'number' })

    const refusal = job().commit(bad.id, { dataType: 'number' }, badPreview.previewHash, {
      actorUserId,
      force: true,
    })
    await expect(refusal).rejects.toBeInstanceOf(ValidationError)
    await expect(refusal).rejects.toThrow(/defaultValue/)
    expect(await storedDataType(bad.id)).toBe('string')
  })

  it('refuses when the definition’s validationRules would not survive the new dataType', async () => {
    const { id, key } = await seedDefinition({
      dataType: 'string',
      validationRules: { minLength: 1 },
    })
    const holders = await seedHolders(key, ['1'])
    const actorUserId = await seedActor()

    const preview = await job().preview(id, { dataType: 'number' })

    // `assertValidationRulesMatchDataType`'s own doc comment names this job as
    // the one place `dataType` moves, and says it will need its own handling
    // of `validationRules` when it lands. This is that handling: refuse, and
    // point at the PATCH that fixes it, rather than leaving the definition
    // carrying a string-length rule it can never satisfy again.
    const refusal = job().commit(id, { dataType: 'number' }, preview.previewHash, {
      actorUserId,
      force: true,
    })
    await expect(refusal).rejects.toBeInstanceOf(ValidationError)
    await expect(refusal).rejects.toThrow(/validationRules/)

    expect(await storedValues(holders, key)).toEqual(['1'])
    expect(await storedDataType(id)).toBe('string')
    expect(await auditRowsFor(id)).toHaveLength(0)
  })
})
