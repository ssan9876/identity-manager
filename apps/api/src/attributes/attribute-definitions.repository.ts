import { Inject, Injectable } from '@nestjs/common'
import { and, asc, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { ATTRIBUTE_PREFIX } from '../business-roles/role-evaluator'
import { DB_CLIENT } from '../common/db.token'
import { ConflictError, NotFoundError, ValidationError } from '../common/errors'
import { attributeDefinitions } from '../db/schema/attribute-definitions'
import { businessRoleConditions, businessRoles } from '../db/schema/business-roles'
import * as schema from '../db/schema/index'
import { validateAttributeKey } from './attribute-key'
import type { AttributeDataType, AttributeDefinition, ValidationRules } from './attribute-validator'

/** One `attribute_definitions` row, exactly as stored. */
type AttributeDefinitionRow = typeof attributeDefinitions.$inferSelect

/**
 * Any handle that can run a statement — the pooled client or a transaction
 * the caller already opened. Deliberately NOT `outbox.writer`'s `DbHandle`
 * (transaction-only): nothing here writes an outbox or audit row, so there is
 * no atomicity contract to enforce through the type. Task 7's controller
 * still passes its own `tx` so the change and its audit row commit together,
 * and the refusals below run on whatever handle they are given, inside that
 * same transaction.
 */
type DbLike = NodePgDatabase<typeof schema>

export interface CreateAttributeDefinitionInput {
  key: string
  label: string
  dataType: AttributeDataType
  appliesTo: 'user' | 'group'
  required?: boolean
  defaultValue?: unknown
  validationRules?: ValidationRules
  sortOrder?: number
  isActive?: boolean
  selfEditable?: boolean
  sensitive?: boolean
}

/**
 * The fields an ordinary edit may change.
 *
 * `dataType` and `appliesTo` are absent BY CONSTRUCTION, not by a runtime
 * check that a caller could forget: changing either rewrites every stored
 * value in `users.attributes`, which is the preview/commit migration job
 * (Tasks 8-10), not a PATCH. `key` is absent for the same reason and it is
 * the less obvious one — a key is what every `users.attributes` blob is
 * actually keyed BY, so renaming the definition orphans every value already
 * written under the old name (the plan says exactly this where it refuses to
 * let migration 0043 auto-rename a violating row).
 */
export interface SafeFieldPatch {
  label?: string
  required?: boolean
  defaultValue?: unknown
  validationRules?: ValidationRules
  sortOrder?: number
  isActive?: boolean
  selfEditable?: boolean
  sensitive?: boolean
}

const UNIQUE_VIOLATION = '23505'
const KEY_SCOPE_UNIQUE_CONSTRAINT = 'attribute_definitions_key_scope_unique'

/**
 * `(key, applies_to)` is unique. Matched on the CONSTRAINT NAME rather than
 * `code === '23505'` alone, the discipline every other repository here
 * follows: a future second unique index on this table would otherwise be
 * misreported as a duplicate key.
 *
 * The message does not echo the submitted key back — finding SEC-L2: a 409
 * repeating the caller's own input turns a write endpoint into an existence
 * oracle, and the caller learns nothing they did not already type.
 */
function translateWriteError(error: unknown): never {
  const pgError = error as { code?: string; constraint?: string }
  if (pgError?.code === UNIQUE_VIOLATION && pgError.constraint === KEY_SCOPE_UNIQUE_CONSTRAINT) {
    throw new ConflictError(
      'an attribute definition with that key already exists for that entity type',
    )
  }
  throw error
}

/**
 * How many referencing role names the refusal spells out before summarising.
 * Bounded because the names come from the DATABASE and the list is otherwise
 * unbounded; five is enough for an operator to start acting, and the count
 * tells them how much is left.
 */
const MAX_NAMED_ROLES = 5

function toDefinition(row: AttributeDefinitionRow): AttributeDefinition {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    dataType: row.dataType,
    required: row.required,
    validationRules: (row.validationRules ?? {}) as ValidationRules,
    appliesTo: row.appliesTo,
    isActive: row.isActive,
    selfEditable: row.selfEditable,
    sensitive: row.sensitive,
  }
}

@Injectable()
export class AttributeDefinitionsRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>) {}

  /**
   * Active attribute definitions for one entity type, ordered by `sortOrder`
   * (then `key` as a tiebreaker, since `sortOrder` alone is not unique) —
   * the schema's own `sort_order` column exists precisely so a client can
   * render fields in a sensible, admin-configured order, but nothing before
   * this method has ever read it: `UsersRepository.
   * listActiveAttributeDefinitions` (unchanged, still unordered) is used
   * only to build a VALIDATION schema, where order is irrelevant. This is a
   * separate, read-only path for a client to build a FORM from (Milestone
   * 8, Task 3's `GET /attribute-definitions`), where order is exactly the
   * point.
   *
   * Filter shape (isActive + appliesTo) intentionally mirrors
   * `UsersRepository.listActiveAttributeDefinitions` — this does not
   * replace that method (which stays exactly as it is, still user-only, for
   * POST/PATCH /users' own validation) but is not a new concept either, just
   * the same filter generalised to the `appliesTo` this table already
   * models for both entity types.
   */
  async listActive(appliesTo: 'user' | 'group'): Promise<AttributeDefinition[]> {
    const rows = await this.db
      .select()
      .from(attributeDefinitions)
      .where(
        and(eq(attributeDefinitions.isActive, true), eq(attributeDefinitions.appliesTo, appliesTo)),
      )
      .orderBy(asc(attributeDefinitions.sortOrder), asc(attributeDefinitions.key))

    return rows.map(toDefinition)
  }

  /**
   * Create one definition.
   *
   * The key is validated HERE, in the repository, and not only in Task 7's
   * DTO: `attribute_definitions_key_format` is the database's backstop but
   * it surfaces as a raw 23514 with no usable message, so the caller gets
   * `validateAttributeKey`'s own problems instead. Defence in depth in the
   * literal sense — three layers, none of them the only one.
   */
  async create(tx: DbLike, input: CreateAttributeDefinitionInput): Promise<AttributeDefinition> {
    const problems = validateAttributeKey(input.key)
    if (problems.length > 0) throw new ValidationError(problems)

    if (input.selfEditable === true) {
      await this.assertNoFormulaDependsOn(tx, input.key, input.appliesTo)
    }

    const [row] = await tx
      .insert(attributeDefinitions)
      .values({
        key: input.key,
        label: input.label,
        dataType: input.dataType,
        appliesTo: input.appliesTo,
        required: input.required,
        defaultValue: input.defaultValue,
        validationRules: input.validationRules as Record<string, unknown> | undefined,
        sortOrder: input.sortOrder,
        isActive: input.isActive,
        selfEditable: input.selfEditable,
        sensitive: input.sensitive,
      })
      .returning()
      .catch(translateWriteError)

    return toDefinition(row)
  }

  /**
   * Change the fields that do not require rewriting stored values.
   *
   * The row is read `FOR UPDATE` first for two reasons: the refusal below
   * needs this definition's own `key` and `appliesTo` (a PATCH only carries
   * an id), and taking the row lock means two concurrent patches of the same
   * definition serialise rather than interleaving a read of one with a write
   * of the other.
   */
  async updateSafeFields(
    tx: DbLike,
    id: string,
    patch: SafeFieldPatch,
  ): Promise<AttributeDefinition> {
    const [existing] = await tx
      .select()
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.id, id))
      .for('update')
    if (!existing) throw new NotFoundError('attribute definition', id)

    if (patch.selfEditable === true) {
      await this.assertNoFormulaDependsOn(tx, existing.key, existing.appliesTo)
    }

    // Only the keys actually present — an absent field must stay untouched,
    // and spreading `patch` wholesale would write `undefined` over columns
    // the caller never mentioned. An EMPTY patch is a no-op rather than an
    // error: drizzle's `.set({})` is a syntax error at the SQL level, and a
    // caller that sent nothing has asked for nothing.
    const changes: Partial<typeof attributeDefinitions.$inferInsert> = {}
    if (patch.label !== undefined) changes.label = patch.label
    if (patch.required !== undefined) changes.required = patch.required
    if (patch.defaultValue !== undefined) changes.defaultValue = patch.defaultValue
    if (patch.validationRules !== undefined) {
      changes.validationRules = patch.validationRules as Record<string, unknown>
    }
    if (patch.sortOrder !== undefined) changes.sortOrder = patch.sortOrder
    if (patch.isActive !== undefined) changes.isActive = patch.isActive
    if (patch.selfEditable !== undefined) changes.selfEditable = patch.selfEditable
    if (patch.sensitive !== undefined) changes.sensitive = patch.sensitive

    if (Object.keys(changes).length === 0) return toDefinition(existing)

    const [row] = await tx
      .update(attributeDefinitions)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(attributeDefinitions.id, id))
      .returning()
      .catch(translateWriteError)

    return toDefinition(row)
  }

  /**
   * REFUSED, not warned. role-evaluator.ts supports an open-ended
   * `attributes.<key>` condition, so a custom attribute can decide who holds a
   * business role — and therefore who holds its entitlements. Marking such an
   * attribute self-editable would let a user grant themselves access by
   * editing their own profile. That escalation route does not exist today and
   * this write path must not create it. Same posture as the SoD gate on
   * publish: the system refuses rather than recording a warning nobody reads.
   *
   * In the REPOSITORY, beside the write it guards, so a caller cannot reach
   * around it by calling the repository directly — exactly why
   * `publishWithin` holds the SoD count check rather than the controller.
   *
   * Three deliberate boundaries, each of which would otherwise be a bug:
   *
   * - The match is EXACT (`field = 'attributes.' || key`), never a prefix
   *   `LIKE`. `attributes.cost_centre_band` is a different attribute from
   *   `cost_centre`, and refusing on it would make a legitimate edit
   *   impossible — the same prefix-versus-label trap `isAtOrBelow` avoids.
   *
   * - `enabled` is NOT filtered on. It is the kill switch on what a role
   *   GRANTS, not on what its formula MEANS, and re-enabling is one un-gated
   *   click away — the reasoning db/schema/business-roles.ts already gives
   *   for SoD constraining the HOLDING rather than the grant.
   *
   * - Only `appliesTo: 'user'` definitions can be caught. A condition reads
   *   `EvaluableUser.attributes`, so a GROUP-scoped definition is never an
   *   input to any formula, and `(key, applies_to)` uniqueness means the
   *   same key legitimately names both. Refusing the group row because a
   *   user formula names the user row would be pure over-refusal.
   *
   * Not filtered by organization on purpose: `attribute_definitions` has no
   * tenant column, so one global definition feeds every tenant's formulas —
   * a refusal that looked only at the actor's own organization would miss
   * the role that actually escalates.
   */
  private async assertNoFormulaDependsOn(
    tx: DbLike,
    key: string,
    appliesTo: 'user' | 'group',
  ): Promise<void> {
    if (appliesTo !== 'user') return

    const rows = await tx
      .select({ name: businessRoles.name })
      .from(businessRoleConditions)
      .innerJoin(businessRoles, eq(businessRoles.id, businessRoleConditions.businessRoleId))
      .where(eq(businessRoleConditions.field, `${ATTRIBUTE_PREFIX}${key}`))
      .orderBy(asc(businessRoles.name))

    // A role may name the same attribute in more than one condition.
    const names = [...new Set(rows.map((row) => row.name))]
    if (names.length === 0) return

    const named = names.slice(0, MAX_NAMED_ROLES).join(', ')
    const remainder = names.length - Math.min(names.length, MAX_NAMED_ROLES)
    const list = remainder > 0 ? `${named} (and ${remainder} more)` : named

    throw new ConflictError(
      `marking "${key}" self-editable is refused: ` +
        `${names.length === 1 ? 'business role' : 'business roles'} ${list} ` +
        `decide membership from ${ATTRIBUTE_PREFIX}${key}, so a user could grant themselves ` +
        'those roles’ entitlements by editing their own profile — ' +
        'change the formula, or leave this attribute admin-only',
    )
  }
}
