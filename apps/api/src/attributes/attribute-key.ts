import { type SQL, sql } from 'drizzle-orm'

/**
 * The closed vocabulary for `attribute_definitions.key`.
 *
 * WHY THIS EXISTS. `key` is `varchar(64)` with no CHECK, and it becomes two
 * things at once: a key in the `users.attributes` jsonb map, and the tail of a
 * business-role condition (`attributes.<key>` — see role-evaluator.ts). Until
 * this module there was no write path, so every defence against a hostile key
 * lived on the READ side: attribute-validator.ts builds its shape with
 * `Object.create(null)` and role-evaluator.ts reads through `Object.hasOwn`,
 * both specifically because a definition keyed `__proto__` would otherwise hit
 * Object.prototype's accessor instead of an own property.
 *
 * Those defences are correct and stay. But this project's own comments record
 * being bitten by prototype-chain semantics four times, and a write path is the
 * first chance to refuse the key at the source rather than requiring every
 * future reader to remember. Defence in depth, with the shallow end closed.
 *
 * The class is deliberately narrower than "what jsonb allows": ASCII letters,
 * digits and underscore, not starting with a digit. Dots are excluded even
 * though `extractField` parses them unambiguously (it slices after the first
 * `attributes.`), because a dotted key reads as a path and invites a future
 * reader to treat it as one.
 *
 * `ATTRIBUTE_KEY_SQL_PATTERN` is the ONE source for this rule — the regex
 * below is derived from it (`new RegExp(...)`), not a second hand-copied
 * literal, and `db/schema/attribute-definitions.ts` imports the same string
 * (plus `ATTRIBUTE_KEY_RESERVED`, below) to build the
 * `attribute_definitions_key_format` CHECK constraint. A previous version of
 * this module kept two separately-written literals "in sync" by throwing at
 * import time if they disagreed — but the throw could only fire from an edit
 * to a hand-typed duplicate; making the duplicate impossible removes the
 * failure mode instead of merely detecting it after the fact.
 */
export const ATTRIBUTE_KEY_SQL_PATTERN = '^[A-Za-z_][A-Za-z0-9_]*$'
const KEY_PATTERN = new RegExp(ATTRIBUTE_KEY_SQL_PATTERN)
const MAX_LENGTH = 64

/**
 * Names that are legal jsonb keys and legal identifiers but that reach
 * Object.prototype. Compared case-sensitively: these are the exact property
 * names, and a `__PROTO__` key is inert.
 *
 * Exported (and typed as a tuple, not a plain `string[]`) so
 * `db/schema/attribute-definitions.ts` can build the CHECK constraint's
 * `NOT IN (...)` list from this exact array rather than a second hand-typed
 * copy — same reasoning as `ATTRIBUTE_KEY_SQL_PATTERN` above.
 */
export const ATTRIBUTE_KEY_RESERVED = ['__proto__', 'constructor', 'prototype'] as const
const RESERVED = new Set<string>(ATTRIBUTE_KEY_RESERVED)

/** Problems with `key`, empty when acceptable. Never throws — callers aggregate. */
export function validateAttributeKey(key: unknown): string[] {
  if (typeof key !== 'string') {
    return ['key: must be a string']
  }
  const problems: string[] = []
  if (key.length === 0) {
    problems.push('key: must not be empty')
  }
  if (key.length > MAX_LENGTH) {
    problems.push(`key: must be at most ${MAX_LENGTH} characters`)
  }
  if (key.length > 0 && !KEY_PATTERN.test(key)) {
    problems.push(
      'key: must start with a letter or underscore and contain only letters, digits and underscores',
    )
  }
  if (RESERVED.has(key)) {
    problems.push(
      `key: "${key}" is reserved — it names a property on Object.prototype, and a definition ` +
        'keyed this way reaches an inherited accessor instead of an own property',
    )
  }
  return problems
}

/**
 * Advisory-lock namespace for "this attribute key", following the convention
 * `GROUP_GRAPH_LOCK_ID` (0x1d3a_0001), the per-user sync lock (0x1d3a_0002)
 * and `CONNECTOR_TARGET_LOCK_NAMESPACE` (0x1d3a_0003) already establish. A
 * distinct namespace means an attribute-key lock can never collide with a
 * `hashtext(...)` from one of those that happens to hash to the same 32 bits.
 *
 * WHY AN ADVISORY LOCK AND NOT `SELECT ... FOR UPDATE`, which is what guards
 * the rest of this invariant: FOR UPDATE can only lock a row that EXISTS, and
 * the race this closes is the one where it does not — `publishWithin` checks
 * that no definition for `attributes.<key>` is self-editable, finds NO ROW at
 * all, and `AttributeDefinitionsRepository.create` concurrently inserts that
 * very key with `selfEditable: true`. Neither side can lock the other's
 * absent row. The same argument `CONNECTOR_TARGET_LOCK_NAMESPACE` spells out
 * at length for first-writes to `connector_targets`, applied to a name in a
 * different table.
 *
 * Lives HERE, in the module that already owns the attribute key as a shared
 * name, because both sides of the invariant need the identical expression and
 * they live in different feature directories. This module imports nothing but
 * `drizzle-orm`, which is what lets `business-roles/business-roles.repository`
 * reach it without closing the cycle that importing
 * `attributes/attribute-definitions.repository` would (that module imports
 * `business-roles/role-evaluator`).
 */
export const ATTRIBUTE_KEY_LOCK_NAMESPACE = 0x1d3a_0004

/**
 * The statement both sides of the self-editable invariant run to serialise on
 * one attribute key. `pg_advisory_xact_lock`, not the session variant, so the
 * lock is released by the surrounding transaction's COMMIT/ROLLBACK and cannot
 * leak back into the pool.
 *
 * That is also its one precondition, and it is the caller's to meet: run this
 * inside a REAL transaction. On a pooled handle each statement is its own
 * implicit transaction, so the lock is taken and dropped before the next
 * statement runs and serialises nothing — the same rule
 * `ConnectorTargetsRepository.upsert` states when it takes a required `tx`.
 *
 * Returned as SQL rather than executed here so this module needs no database
 * handle type, and so there is exactly ONE spelling of the lock expression for
 * both callers to share — two hand-written copies could disagree about the
 * namespace or the hash and would then serialise nothing while looking right.
 */
export function attributeKeyLock(key: string): SQL {
  return sql`SELECT pg_advisory_xact_lock(${ATTRIBUTE_KEY_LOCK_NAMESPACE}, hashtext(${key}::text))`
}
