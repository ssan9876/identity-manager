import { z } from 'zod'
import { ValidationError } from '../common/errors'
import type { ValidationRules } from './attribute-validator'
import { ALL_ATTRIBUTE_FORMATS, describeAttributeFormats } from './attribute-formats'

/**
 * The write-side gate for `attribute_definitions.validation_rules`.
 *
 * `validationRules` is jsonb — an open blob — and that is exactly where this
 * project's ReDoS lived: `pattern` was a caller-supplied regular expression
 * compiled with `new RegExp` and run against user input (see
 * attribute-formats.ts's file doc comment for the 96.7-second measurement).
 * There was no write path before Milestone 8, so nothing has ever validated
 * what goes into that column. This module is what stops the next
 * hand-written value from reintroducing it.
 *
 * `.strict()`, so unknown keys are REJECTED, not stored for some future
 * reader to interpret. `format` is drawn from attribute-formats.ts's closed
 * vocabulary rather than re-listed here — that module is the single source
 * of truth (see its own doc comment on catalog drift). `pattern` is rejected
 * BY NAME, before the generic `.strict()` scan ever runs, with a message
 * pointing at the vocabulary that replaced it: a caller who used to set
 * `pattern` deserves to be told what to use instead, not lumped in with
 * "unrecognized key: pattern" the way any other stray key would be.
 */

const MAX_OPTIONS = 200
const MAX_OPTION_LENGTH = 200

const validationRulesSchema = z
  .object({
    format: z.enum(ALL_ATTRIBUTE_FORMATS),
    min: z.number(),
    max: z.number(),
    options: z
      .array(z.string().max(MAX_OPTION_LENGTH))
      .max(MAX_OPTIONS),
  })
  .partial()
  .strict()

/**
 * Parses a caller-supplied `validationRules` value into the closed shape the
 * write path accepts, or throws `ValidationError`.
 *
 * `undefined` in, `undefined` out — a caller that never mentioned
 * `validationRules` gets no opinion imposed on it, same as every other
 * optional field on `CreateAttributeDefinitionInput`/`SafeFieldPatch`; the
 * column's own `DEFAULT '{}'` covers the create path, and `updateSafeFields`
 * already treats an absent key as "leave untouched".
 */
export function parseValidationRules(rules: unknown): ValidationRules | undefined {
  if (rules === undefined) return undefined

  // Checked FIRST and BY NAME, ahead of the generic `.strict()` scan below,
  // precisely so this case gets its own message rather than the generic
  // "unrecognized key" one. `Object.hasOwn` (not `in` or `.pattern`
  // truthiness) so an inherited `pattern` — e.g. from a hostile
  // `{"__proto__": {"pattern": "..."}}` payload — can never suppress this
  // check, and so a genuine own `pattern: undefined` still trips it.
  if (
    rules !== null &&
    typeof rules === 'object' &&
    !Array.isArray(rules) &&
    Object.hasOwn(rules, 'pattern')
  ) {
    throw new ValidationError([
      'validationRules.pattern is no longer supported: a caller-supplied regular expression ' +
        'is executable content, and this exact shape was measured stalling the single Node ' +
        'process serving the whole API for 96.7 seconds on a 33-character input ' +
        '(docs/12-security.md). Use validationRules.format instead, one of: ' +
        `${describeAttributeFormats()}.`,
    ])
  }

  const result = validationRulesSchema.safeParse(rules)
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((issue) => {
        const path = issue.path.join('.')
        return path.length > 0
          ? `validationRules.${path}: ${issue.message}`
          : `validationRules: ${issue.message}`
      }),
    )
  }

  return result.data
}
