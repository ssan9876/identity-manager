import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type {
  CreateAttributeDefinitionInput,
  SafeFieldPatch,
} from '../src/attributes/attribute-definitions.repository'
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

  /**
   * The same repository, with each write run inside its OWN transaction.
   *
   * `create` and `updateSafeFields` take a LIVE TRANSACTION (`DbHandle`), not
   * the pooled handle, since Milestone 8 Task 5b — see that type's doc comment
   * in the repository. Both of their guards span several statements held
   * together by TRANSACTION-SCOPED locks (`pg_advisory_xact_lock`,
   * `SELECT ... FOR UPDATE`), and on the pooled handle each statement is its
   * own implicit transaction, so the lock is released before the statement it
   * was taken to protect. Passing `ctx.db` is now a compile error rather than
   * a silently ineffective call — which is how this file's own
   * `create(ctx.db, { selfEditable: true })` was found.
   */
  function txRepo() {
    return {
      create: (input: CreateAttributeDefinitionInput) =>
        ctx.db.transaction((tx) => repo().create(tx, input)),
      updateSafeFields: (id: string, patch: SafeFieldPatch) =>
        ctx.db.transaction((tx) => repo().updateSafeFields(tx, id, patch)),
    }
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
        txRepo().updateSafeFields(definition.id, { selfEditable: true }),
      ).rejects.toThrow(/business role/i)

      const error = await txRepo()
        .updateSafeFields(definition.id, { selfEditable: true })
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

      const error = await txRepo()
        .updateSafeFields(definition.id, { selfEditable: true })
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

      const error = await txRepo()
        .updateSafeFields(definition.id, { selfEditable: true })
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

      const error = await txRepo()
        .create({
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
        txRepo().updateSafeFields(definition.id, { selfEditable: true }),
      ).resolves.toMatchObject({ selfEditable: true })
    })

    it('allows selfEditable when formulas reference a DIFFERENT attribute', async () => {
      const definition = await seedDefinition()
      await seedRoleWithCondition(`${ATTRIBUTE_PREFIX}${uniqueKey('other')}`)

      await expect(
        txRepo().updateSafeFields(definition.id, { selfEditable: true }),
      ).resolves.toMatchObject({ selfEditable: true })
    })

    it('allows selfEditable when a formula names a LONGER key sharing this key as a prefix', async () => {
      // `attributes.cost_centre_band` is a different attribute from
      // `cost_centre`. A `LIKE 'attributes.cost_centre%'` match would refuse
      // this — the same prefix-versus-label bug `isAtOrBelow` exists to avoid.
      const definition = await seedDefinition({ key: uniqueKey('cost_centre') })
      await seedRoleWithCondition(`${ATTRIBUTE_PREFIX}${definition.key}_band`)

      await expect(
        txRepo().updateSafeFields(definition.id, { selfEditable: true }),
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
        txRepo().updateSafeFields(groupDefinition.id, { selfEditable: true }),
      ).resolves.toMatchObject({ selfEditable: true, appliesTo: 'group' })
    })

    it('allows turning selfEditable OFF on a referenced attribute', async () => {
      const definition = await seedDefinition({ selfEditable: true })
      await seedRoleWithCondition(`${ATTRIBUTE_PREFIX}${definition.key}`)

      await expect(
        txRepo().updateSafeFields(definition.id, { selfEditable: false }),
      ).resolves.toMatchObject({ selfEditable: false })
    })

    it('allows editing other fields on a referenced attribute', async () => {
      const definition = await seedDefinition()
      await seedRoleWithCondition(`${ATTRIBUTE_PREFIX}${definition.key}`)

      await expect(
        txRepo().updateSafeFields(definition.id, { label: 'Renamed', required: true }),
      ).resolves.toMatchObject({ label: 'Renamed', required: true })
    })

    it('ignores conditions on core fields entirely', async () => {
      const definition = await seedDefinition()
      await seedRoleWithCondition('jobTitle')

      await expect(
        txRepo().updateSafeFields(definition.id, { selfEditable: true }),
      ).resolves.toMatchObject({ selfEditable: true })
    })

    it('allows creating a referenced attribute that is NOT self-editable', async () => {
      const key = uniqueKey('referenced')
      await seedRoleWithCondition(`${ATTRIBUTE_PREFIX}${key}`)

      await expect(
        txRepo().create({ key, label: 'Referenced', dataType: 'string', appliesTo: 'user' }),
      ).resolves.toMatchObject({ key, selfEditable: false })
    })
  })

  // -------------------------------------------------------------------------
  // The key refusal
  // -------------------------------------------------------------------------

  describe('create', () => {
    it('refuses a reserved key on create', async () => {
      await expect(
        txRepo().create({
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
        const error = await txRepo()
          .create({ key, label: 'x', dataType: 'string', appliesTo: 'user' })
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
        txRepo().create({
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
      await txRepo().create({ key, label: 'First', dataType: 'string', appliesTo: 'user' })

      await expect(
        txRepo().create({ key, label: 'Second', dataType: 'string', appliesTo: 'user' }),
      ).rejects.toBeInstanceOf(ConflictError)
    })

    it('allows the same key for the other entity type', async () => {
      const key = uniqueKey('scoped')
      await txRepo().create({ key, label: 'User side', dataType: 'string', appliesTo: 'user' })

      await expect(
        txRepo().create({ key, label: 'Group side', dataType: 'string', appliesTo: 'group' }),
      ).resolves.toMatchObject({ key, appliesTo: 'group' })
    })
  })

  describe('updateSafeFields', () => {
    it('reports an unknown id as not found', async () => {
      await expect(
        txRepo().updateSafeFields(randomUUID(), { label: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundError)
    })

    it('returns the definition unchanged for an empty patch', async () => {
      const definition = await seedDefinition({ label: 'Untouched' })

      await expect(txRepo().updateSafeFields(definition.id, {})).resolves.toMatchObject({
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

  // -------------------------------------------------------------------------
  // Task 6 — validationRules as a closed schema.
  //
  // `validationRules` is jsonb — an open blob — and that is exactly where
  // this project's ReDoS lived: `pattern` was a caller-supplied regular
  // expression compiled with `new RegExp` and run against user input
  // (attribute-formats.ts's file doc comment has the 96.7-second
  // measurement). There was no write path before Task 5, so nothing has ever
  // validated what goes into that column. These tests are what stop the next
  // hand-written value from reintroducing it.
  // -------------------------------------------------------------------------

  describe('validationRules', () => {
    it('rejects a pattern key by name, pointing at the format vocabulary that replaced it', async () => {
      const error = await txRepo()
        .create({
          key: uniqueKey('pattern'),
          label: 'l',
          dataType: 'string',
          appliesTo: 'user',
          validationRules: { pattern: '(a+)+$' } as never,
        })
        .catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ValidationError)
      expect(String((error as Error).message)).toMatch(/pattern/)
      // Not lumped in with generic unknown-key rejection — the message must
      // name the replacement vocabulary, not just say "unrecognized".
      expect(String((error as Error).message)).toMatch(/format/)
    })

    it('rejects a key outside the closed vocabulary as unrecognized', async () => {
      const error = await txRepo()
        .create({
          key: uniqueKey('unknown'),
          label: 'l',
          dataType: 'string',
          appliesTo: 'user',
          validationRules: { unknownKey: 1 } as never,
        })
        .catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ValidationError)
      expect(String((error as Error).message)).toMatch(/unknownKey|unrecognized/i)
    })

    it('bounds enum options to at most 200 entries', async () => {
      const error = await txRepo()
        .create({
          key: uniqueKey('toomanyopts'),
          label: 'l',
          dataType: 'enum',
          appliesTo: 'user',
          validationRules: { options: Array.from({ length: 201 }, (_, i) => String(i)) },
        })
        .catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ValidationError)
      expect(String((error as Error).message)).toMatch(/options/)
    })

    it('bounds each option to at most 200 characters', async () => {
      const error = await txRepo()
        .create({
          key: uniqueKey('longopt'),
          label: 'l',
          dataType: 'enum',
          appliesTo: 'user',
          validationRules: { options: ['x'.repeat(201)] },
        })
        .catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ValidationError)
      expect(String((error as Error).message)).toMatch(/options/)
    })

    it('accepts a format from the closed vocabulary', async () => {
      await expect(
        txRepo().create({
          key: uniqueKey('fmt'),
          label: 'l',
          dataType: 'string',
          appliesTo: 'user',
          validationRules: { format: 'email' },
        }),
      ).resolves.toBeDefined()
    })

    it('rejects a format not in the closed vocabulary', async () => {
      const error = await txRepo()
        .create({
          key: uniqueKey('badfmt'),
          label: 'l',
          dataType: 'string',
          appliesTo: 'user',
          validationRules: { format: 'ssn' } as never,
        })
        .catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ValidationError)
    })

    // ---------------------------------------------------------------------
    // What the closed schema must still allow. Over-refusal is not a lesser
    // failure than under-refusal — a definition with no validationRules at
    // all, an empty object, a legal format, and min without max must all
    // keep working.
    // ---------------------------------------------------------------------

    it('allows creating a definition with no validationRules at all', async () => {
      await expect(
        txRepo().create({
          key: uniqueKey('novr'),
          label: 'l',
          dataType: 'string',
          appliesTo: 'user',
        }),
      ).resolves.toBeDefined()
    })

    it('allows an empty validationRules object', async () => {
      await expect(
        txRepo().create({
          key: uniqueKey('emptyvr'),
          label: 'l',
          dataType: 'string',
          appliesTo: 'user',
          validationRules: {},
        }),
      ).resolves.toBeDefined()
    })

    it('allows min without max', async () => {
      await expect(
        txRepo().create({
          key: uniqueKey('minonly'),
          label: 'l',
          dataType: 'number',
          appliesTo: 'user',
          validationRules: { min: 3 },
        }),
      ).resolves.toBeDefined()
    })

    it('allows options within bounds', async () => {
      await expect(
        txRepo().create({
          key: uniqueKey('okopts'),
          label: 'l',
          dataType: 'enum',
          appliesTo: 'user',
          validationRules: { options: ['a', 'b', 'c'] },
        }),
      ).resolves.toMatchObject({ validationRules: { options: ['a', 'b', 'c'] } })
    })

    it('also gates updateSafeFields, not only create', async () => {
      const definition = await seedDefinition()

      const error = await txRepo()
        .updateSafeFields(definition.id, { validationRules: { pattern: '.*' } as never })
        .catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ValidationError)
      expect(String((error as Error).message)).toMatch(/pattern/)

      // A refusal is a refusal: nothing was written.
      const [after] = await ctx.db
        .select()
        .from(attributeDefinitions)
        .where(eq(attributeDefinitions.id, definition.id))
      expect(after.validationRules).toEqual({})
    })

    it('allows updateSafeFields to set a legal validationRules value', async () => {
      const definition = await seedDefinition()

      await expect(
        txRepo().updateSafeFields(definition.id, { validationRules: { format: 'uuid' } }),
      ).resolves.toMatchObject({ validationRules: { format: 'uuid' } })
    })
  })
})
