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
