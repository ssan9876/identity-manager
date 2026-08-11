import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { AttributeDefinitionsRepository } from '../src/attributes/attribute-definitions.repository'
import { ATTRIBUTE_PREFIX } from '../src/business-roles/role-evaluator'
import { ConflictError, NotFoundError, ValidationError } from '../src/common/errors'
import { attributeDefinitions } from '../src/db/schema/attribute-definitions'
import { businessRoleConditions, businessRoles } from '../src/db/schema/business-roles'
import { OrganizationsRepository } from '../src/organizations/organizations.repository'
import { withTestDatabase } from './support/pg'

/**
 * Milestone 8 (attribute-definitions write path), Task 5 — the two refusals.
 *
 * The `selfEditable` one is why this feature needs a repository gate at all
 * rather than a controller check: role-evaluator.ts supports an open-ended
 * `attributes.<key>` condition, so a custom attribute can decide business
 * role membership and therefore entitlements. Marking such an attribute
 * self-editable would let a user grant themselves access by editing their
 * own profile.
 *
 * `withTestDatabase()` starts ONE container per FILE with no truncation
 * between `it` blocks, so every fixture below takes a per-call unique key
 * and role name — a shared literal would let one test's role reference
 * another test's attribute and turn a refusal into an accident.
 */
describe('AttributeDefinitionsRepository', () => {
  const ctx = withTestDatabase()

  function repo(): AttributeDefinitionsRepository {
    return new AttributeDefinitionsRepository(ctx.db)
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
   * A business role whose PUBLISHED formula names `field`. Published rows —
   * `business_role_conditions` — are what role-evaluator.ts actually reads.
   */
  async function seedRoleWithCondition(
    field: string,
    options: { enabled?: boolean; name?: string } = {},
  ): Promise<string> {
    const name = options.name ?? `Role ${randomUUID()}`
    const [role] = await ctx.db
      .insert(businessRoles)
      .values({
        name,
        organizationId: await masterOrgId(),
        enabled: options.enabled ?? true,
      })
      .returning()
    await ctx.db
      .insert(businessRoleConditions)
      .values({ businessRoleId: role.id, field, operator: 'equals', value: 'yes' })
    return name
  }

  // -------------------------------------------------------------------------
  // The refusal that matters most
  // -------------------------------------------------------------------------

  describe('the selfEditable escalation refusal', () => {
    it('refuses selfEditable on an attribute a business-role formula references, naming the roles', async () => {
      const definition = await seedDefinition()
      const roleName = await seedRoleWithCondition(`${ATTRIBUTE_PREFIX}${definition.key}`)

      await expect(
        repo().updateSafeFields(ctx.db, definition.id, { selfEditable: true }),
      ).rejects.toThrow(/business role/i)

      const error = await repo()
        .updateSafeFields(ctx.db, definition.id, { selfEditable: true })
        .catch((e: unknown) => e)
      // The operator must learn WHICH roles, or they cannot act on the refusal.
      expect(String((error as Error).message)).toContain(roleName)
      expect(error).toBeInstanceOf(ConflictError)

      // And a refusal is a refusal: nothing was written.
      const [after] = await ctx.db
        .select()
        .from(attributeDefinitions)
        .where(eq(attributeDefinitions.id, definition.id))
      expect(after.selfEditable).toBe(false)
    })

    it('refuses even when the referencing role is DISABLED', async () => {
      // `enabled` is the kill switch on what a role GRANTS, not on what its
      // formula MEANS, and re-enabling is one un-gated click away. Same
      // posture db/schema/business-roles.ts already states for the SoD
      // checks: "a pair of conflicting formulas is a policy violation even
      // while one side's grants are switched off".
      const definition = await seedDefinition()
      const roleName = await seedRoleWithCondition(`${ATTRIBUTE_PREFIX}${definition.key}`, {
        enabled: false,
      })

      const error = await repo()
        .updateSafeFields(ctx.db, definition.id, { selfEditable: true })
        .catch((e: unknown) => e)
      expect(String((error as Error).message)).toContain(roleName)
    })

    it('names EVERY referencing role, not just the first', async () => {
      const definition = await seedDefinition()
      const first = await seedRoleWithCondition(`${ATTRIBUTE_PREFIX}${definition.key}`, {
        name: `Aardvark ${randomUUID()}`,
      })
      const second = await seedRoleWithCondition(`${ATTRIBUTE_PREFIX}${definition.key}`, {
        name: `Zebra ${randomUUID()}`,
      })

      const error = await repo()
        .updateSafeFields(ctx.db, definition.id, { selfEditable: true })
        .catch((e: unknown) => e)
      expect(String((error as Error).message)).toContain(first)
      expect(String((error as Error).message)).toContain(second)
    })

    it('refuses at CREATE too, for a key a formula already references', async () => {
      // A formula may name a key no definition exists for yet —
      // `extractField` simply reads `null`. Creating that definition
      // self-editable afterwards opens exactly the same escalation route as
      // flipping the flag on an existing one, so the gate has to stand on
      // both methods or the update-side gate is trivially walked around.
      const key = uniqueKey('unborn')
      const roleName = await seedRoleWithCondition(`${ATTRIBUTE_PREFIX}${key}`)

      const error = await repo()
        .create(ctx.db, {
          key,
          label: 'Clearance',
          dataType: 'string',
          appliesTo: 'user',
          selfEditable: true,
        })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ConflictError)
      expect(String((error as Error).message)).toContain(roleName)

      const rows = await ctx.db
        .select()
        .from(attributeDefinitions)
        .where(eq(attributeDefinitions.key, key))
      expect(rows).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // What the refusal must NOT also refuse. Over-refusal makes a legitimate
  // operation impossible; it is not a lesser failure than under-refusal.
  // -------------------------------------------------------------------------

  describe('what the selfEditable refusal must still allow', () => {
    it('allows selfEditable when no formula references the attribute', async () => {
      const definition = await seedDefinition()

      await expect(
        repo().updateSafeFields(ctx.db, definition.id, { selfEditable: true }),
      ).resolves.toMatchObject({ selfEditable: true })
    })

    it('allows selfEditable when formulas reference a DIFFERENT attribute', async () => {
      const definition = await seedDefinition()
      await seedRoleWithCondition(`${ATTRIBUTE_PREFIX}${uniqueKey('other')}`)

      await expect(
        repo().updateSafeFields(ctx.db, definition.id, { selfEditable: true }),
      ).resolves.toMatchObject({ selfEditable: true })
    })

    it('allows selfEditable when a formula names a LONGER key sharing this key as a prefix', async () => {
      // `attributes.cost_centre_band` is a different attribute from
      // `cost_centre`. A `LIKE 'attributes.cost_centre%'` match would refuse
      // this — the same prefix-versus-label bug `isAtOrBelow` exists to avoid.
      const definition = await seedDefinition({ key: uniqueKey('cost_centre') })
      await seedRoleWithCondition(`${ATTRIBUTE_PREFIX}${definition.key}_band`)

      await expect(
        repo().updateSafeFields(ctx.db, definition.id, { selfEditable: true }),
      ).resolves.toMatchObject({ selfEditable: true })
    })

    it('allows selfEditable on a GROUP attribute even when a user formula names the same key', async () => {
      // Conditions evaluate against an `EvaluableUser`, and `attributes.<key>`
      // reads `user.attributes` — a group-scoped definition is never an input
      // to any formula. `attribute_definitions_key_scope_unique` is
      // (key, applies_to), so the same key legitimately exists for both.
      const key = uniqueKey('shared')
      await seedDefinition({ key, appliesTo: 'user' })
      const groupDefinition = await seedDefinition({ key, appliesTo: 'group' })
      await seedRoleWithCondition(`${ATTRIBUTE_PREFIX}${key}`)

      await expect(
        repo().updateSafeFields(ctx.db, groupDefinition.id, { selfEditable: true }),
      ).resolves.toMatchObject({ selfEditable: true, appliesTo: 'group' })
    })

    it('allows turning selfEditable OFF on a referenced attribute', async () => {
      const definition = await seedDefinition({ selfEditable: true })
      await seedRoleWithCondition(`${ATTRIBUTE_PREFIX}${definition.key}`)

      await expect(
        repo().updateSafeFields(ctx.db, definition.id, { selfEditable: false }),
      ).resolves.toMatchObject({ selfEditable: false })
    })

    it('allows editing other fields on a referenced attribute', async () => {
      const definition = await seedDefinition()
      await seedRoleWithCondition(`${ATTRIBUTE_PREFIX}${definition.key}`)

      await expect(
        repo().updateSafeFields(ctx.db, definition.id, { label: 'Renamed', required: true }),
      ).resolves.toMatchObject({ label: 'Renamed', required: true })
    })

    it('ignores conditions on core fields entirely', async () => {
      const definition = await seedDefinition()
      await seedRoleWithCondition('jobTitle')

      await expect(
        repo().updateSafeFields(ctx.db, definition.id, { selfEditable: true }),
      ).resolves.toMatchObject({ selfEditable: true })
    })

    it('allows creating a referenced attribute that is NOT self-editable', async () => {
      const key = uniqueKey('referenced')
      await seedRoleWithCondition(`${ATTRIBUTE_PREFIX}${key}`)

      await expect(
        repo().create(ctx.db, { key, label: 'Referenced', dataType: 'string', appliesTo: 'user' }),
      ).resolves.toMatchObject({ key, selfEditable: false })
    })
  })

  // -------------------------------------------------------------------------
  // The key refusal
  // -------------------------------------------------------------------------

  describe('create', () => {
    it('refuses a reserved key on create', async () => {
      await expect(
        repo().create(ctx.db, {
          key: '__proto__',
          label: 'x',
          dataType: 'string',
          appliesTo: 'user',
        }),
      ).rejects.toThrow(/reserved/)
    })

    it.each(['constructor', 'prototype', 'has space', 'has-hyphen', '1st', ''])(
      'refuses the illegal key "%s" as a ValidationError, before touching the database',
      async (key) => {
        const error = await repo()
          .create(ctx.db, { key, label: 'x', dataType: 'string', appliesTo: 'user' })
          .catch((e: unknown) => e)
        expect(error).toBeInstanceOf(ValidationError)
        // Not a raw Postgres CHECK violation surfacing as a 500 — the
        // constraint is the backstop, not the message the caller reads.
        expect(String((error as Error).message)).not.toContain('attribute_definitions_key_format')
      },
    )

    it('creates a definition with every field it was given', async () => {
      const key = uniqueKey('full')
      await expect(
        repo().create(ctx.db, {
          key,
          label: 'Cost centre',
          dataType: 'string',
          appliesTo: 'user',
          required: true,
          sensitive: true,
          sortOrder: 7,
        }),
      ).resolves.toMatchObject({
        key,
        label: 'Cost centre',
        dataType: 'string',
        appliesTo: 'user',
        required: true,
        sensitive: true,
        isActive: true,
        selfEditable: false,
      })
    })

    it('reports a duplicate key for the same scope as a conflict, not a raw driver error', async () => {
      const key = uniqueKey('dup')
      await repo().create(ctx.db, { key, label: 'First', dataType: 'string', appliesTo: 'user' })

      await expect(
        repo().create(ctx.db, { key, label: 'Second', dataType: 'string', appliesTo: 'user' }),
      ).rejects.toBeInstanceOf(ConflictError)
    })

    it('allows the same key for the other entity type', async () => {
      const key = uniqueKey('scoped')
      await repo().create(ctx.db, { key, label: 'User side', dataType: 'string', appliesTo: 'user' })

      await expect(
        repo().create(ctx.db, { key, label: 'Group side', dataType: 'string', appliesTo: 'group' }),
      ).resolves.toMatchObject({ key, appliesTo: 'group' })
    })
  })

  describe('updateSafeFields', () => {
    it('reports an unknown id as not found', async () => {
      await expect(
        repo().updateSafeFields(ctx.db, randomUUID(), { label: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundError)
    })

    it('returns the definition unchanged for an empty patch', async () => {
      const definition = await seedDefinition({ label: 'Untouched' })

      await expect(repo().updateSafeFields(ctx.db, definition.id, {})).resolves.toMatchObject({
        id: definition.id,
        label: 'Untouched',
      })
    })

    it('runs inside a caller-supplied transaction', async () => {
      // Task 7 writes the audit row in the SAME transaction as the change.
      const definition = await seedDefinition()
      await expect(
        ctx.db.transaction(async (tx) =>
          repo().updateSafeFields(tx, definition.id, { label: 'In a transaction' }),
        ),
      ).resolves.toMatchObject({ label: 'In a transaction' })
    })
  })
})
