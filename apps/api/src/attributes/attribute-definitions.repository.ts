import { Inject, Injectable } from '@nestjs/common'
import { and, asc, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { ATTRIBUTE_PREFIX } from '../business-roles/role-evaluator'
import { DB_CLIENT } from '../common/db.token'
import { ConflictError, NotFoundError, ValidationError } from '../common/errors'
import { attributeDefinitions } from '../db/schema/attribute-definitions'
import { businessRoleConditions, businessRoles } from '../db/schema/business-roles'
import * as schema from '../db/schema/index'
import type { DbHandle } from '../outbox/outbox.writer'
import { attributeKeyLock, validateAttributeKey } from './attribute-key'
import { assertValidationRulesMatchDataType, parseValidationRules } from './attribute-validation-rules'
import type { AttributeDataType, AttributeDefinition, ValidationRules } from './attribute-validator'

/** One `attribute_definitions` row, exactly as stored. */
type AttributeDefinitionRow = typeof attributeDefinitions.$inferSelect

/**
 * The write methods below take `outbox.writer`'s `DbHandle` — a LIVE
 * TRANSACTION, not "the pooled client or a transaction". An earlier version
 * of this file aliased `NodePgDatabase` here instead and argued the narrowing
 * was unnecessary because "nothing here writes an outbox or audit row, so
 * there is no atomicity contract to enforce through the type". Milestone 8,
 * Task 5b invalidated that: there is now a contract to enforce, and it is
 * SERIALISATION rather than atomicity.
 *
 * Both refusals in this file span more than one statement, and on the pooled
 * handle each statement is its own implicit transaction, so both of them come
 * apart:
 *
 * - `create` takes `attributeKeyLock` and then reads
 *   `business_role_conditions`. `pg_advisory_xact_lock` is released at the end
 *   of the transaction that took it, so on the pool the lock is gone before
 *   the read runs and serialises nothing —
 *   `BusinessRolesRepository.publishWithin` can publish a formula naming this
 *   key in the gap. Reproduced against a real Postgres, both ways round: the
 *   pooled handle lands the escalation, the transaction refuses it.
 *
 * - `updateSafeFields` takes `SELECT ... FOR UPDATE` on the row and then
 *   UPDATEs it. On the pool the row lock is released before the UPDATE is
 *   sent, which makes that method's own doc comment ("taking the row lock
 *   means two concurrent patches of the same definition serialise rather than
 *   interleaving") false. That one predates Task 5b.
 *
 * A comment cannot hold this — one was already ignored. `DbHandle` resolves to
 * drizzle's `PgTransaction`, which has members the pooled handle does not
 * (e.g. `rollback`), so passing the pool is a COMPILE ERROR. On its first
 * compile the change caught a real miscall in
 * `test/attribute-definitions.repository.spec.ts`, which had been passing the
 * pooled handle to `create({selfEditable: true})` — the exact call the lock is
 * supposed to protect.
 *
 * Same narrowing the sibling `attribute-target-mappings.repository.ts` already
 * applies to its own `create`/`update`, and imported from `outbox.writer`
 * rather than redeclared, since that module already owns this type.
 */

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
   * The definition as it stands right now, LOCKED — for a caller that is
   * about to change it and has to record what it looked like first
   * (Milestone 8, Task 7's `PATCH`, which owes the audit log a `before`).
   *
   * `DbHandle`, and `FOR UPDATE`, for the same reason `updateSafeFields`
   * takes both. The audit row for a PATCH must carry the state the UPDATE
   * was actually applied to. An UNLOCKED read here would be a second,
   * independent snapshot: under READ COMMITTED a concurrent patch of the
   * same definition can commit between this read and the `FOR UPDATE` read
   * inside `updateSafeFields`, and the audit row would then describe a
   * `before` that was never the immediate predecessor of its own `after` —
   * in an append-only table, permanently. Taking the lock HERE means the
   * concurrent patch blocks instead, and `updateSafeFields`' own re-read
   * (same transaction, lock already held) cannot see anything different.
   *
   * `listActive` is deliberately NOT narrowed the same way: it is a
   * single-statement read with no invariant spanning statements, so the
   * pooled handle is correct there. The narrowing is per-METHOD, not
   * per-class.
   */
  async findByIdForUpdate(tx: DbHandle, id: string): Promise<AttributeDefinition | null> {
    const [row] = await tx
      .select()
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.id, id))
      .for('update')

    return row === undefined ? null : toDefinition(row)
  }

  /**
   * Create one definition.
   *
   * `tx` MUST BE A LIVE TRANSACTION, and that is a correctness requirement,
   * not a style preference. When `selfEditable` is true this method takes an
   * advisory lock and then runs its refusal as a separate statement; the lock
   * is transaction-scoped, so on a pooled handle it would be released before
   * the refusal it exists to protect ever ran, and
   * `BusinessRolesRepository.publishWithin` could publish a formula naming
   * this key in the gap. The type enforces it (`DbHandle` — see its comment
   * above); this sentence is here so a caller reading the signature learns why
   * before the compiler tells them.
   *
   * The key is validated HERE, in the repository, and not only in Task 7's
   * DTO: `attribute_definitions_key_format` is the database's backstop but
   * it surfaces as a raw 23514 with no usable message, so the caller gets
   * `validateAttributeKey`'s own problems instead. Defence in depth in the
   * literal sense — three layers, none of them the only one.
   */
  async create(tx: DbHandle, input: CreateAttributeDefinitionInput): Promise<AttributeDefinition> {
    const problems = validateAttributeKey(input.key)
    if (problems.length > 0) throw new ValidationError(problems)

    // Closed schema, checked before any database work — see
    // attribute-validation-rules.ts for why: validationRules is jsonb, and
    // `pattern` is where the ReDoS lived. `dataType` is already known here
    // (this method's own parameter, not read back from a row), so the
    // cross-field dataType check runs in the same fail-fast spot.
    const validationRules = parseValidationRules(input.validationRules)
    assertValidationRulesMatchDataType(validationRules, input.dataType)

    if (input.selfEditable === true) {
      // Milestone 8, Task 5b. `assertNoFormulaDependsOn` below reads
      // `business_role_conditions`; `BusinessRolesRepository.publishWithin`
      // WRITES that table and reads this one. On the UPDATE path the two
      // interlock through this definition's row (`updateSafeFields` takes
      // `FOR UPDATE` on it, publish takes `FOR UPDATE` on the rows its draft
      // names). On the CREATE path there is no row yet for either side to
      // lock, so under READ COMMITTED both checks pass on disjoint locks and
      // the escalation lands — verified against a real Postgres. The advisory
      // lock is the only thing that can cover an absent row.
      //
      // Everything after this line and before COMMIT is the critical section,
      // which is why `tx` is a transaction (see this method's doc comment).
      await tx.execute(attributeKeyLock(input.key))
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
        validationRules: validationRules as Record<string, unknown> | undefined,
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
    tx: DbHandle,
    id: string,
    patch: SafeFieldPatch,
  ): Promise<AttributeDefinition> {
    // Closed schema, checked before any database work — same gate `create`
    // applies, so a caller cannot bypass Task 6 by going through PATCH
    // instead of POST. See attribute-validation-rules.ts. Only the
    // STRUCTURAL half runs here (shape, bounds, min/max ordering):
    // `SafeFieldPatch` excludes `dataType` by construction, so the
    // cross-field "does this rule apply to this attribute's dataType" check
    // cannot run until `existing.dataType` is read below — still before the
    // UPDATE statement, so a refusal still leaves nothing written.
    const validationRules = parseValidationRules(patch.validationRules)

    const [existing] = await tx
      .select()
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.id, id))
      .for('update')
    if (!existing) throw new NotFoundError('attribute definition', id)

    assertValidationRulesMatchDataType(validationRules, existing.dataType)

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
      changes.validationRules = validationRules as Record<string, unknown>
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
    tx: DbHandle,
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
