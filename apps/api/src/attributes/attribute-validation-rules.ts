import { z } from 'zod'
import { ValidationError } from '../common/errors'
import type { AttributeDataType, ValidationRules } from './attribute-validator'
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
 *
 * `minLength`/`maxLength` were added in a fix round after the first version
 * of this module shipped without them — a genuine gap in the original brief,
 * not a deliberate narrowing: `attribute-validator.ts`'s `buildFieldSchema`
 * has always read them for `dataType: 'string'` (pinned by
 * `test/attribute-validator.spec.ts`), so omitting them from the closed
 * write schema would have made a string length constraint impossible to
 * WRITE through the only supported path while the read side still fully
 * understood one written by hand. Closing a write path narrower than the
 * read path it feeds is exactly the class of bug this whole feature exists
 * to remove.
 */

const MAX_OPTIONS = 200
const MAX_OPTION_LENGTH = 200

const validationRulesSchema = z
  .object({
    format: z.enum(ALL_ATTRIBUTE_FORMATS),
    min: z.number(),
    max: z.number(),
    minLength: z.number(),
    maxLength: z.number(),
    options: z
      .array(z.string().max(MAX_OPTION_LENGTH))
      .max(MAX_OPTIONS),
  })
  .partial()
  .strict()
  .superRefine((value, ctx) => {
    // An inverted range (min > max, or minLength > maxLength) is a
    // definition that can never validate ANY value — every write against it
    // would fail, and the admin would only discover that empirically, one
    // rejected value at a time. Rejected at write time instead, the same
    // "fail closed and say so immediately" posture the rest of this module
    // already takes with `pattern` and an unrecognised `format`.
    //
    // Equality (min === max, minLength === maxLength) is DELIBERATELY
    // allowed: that pins the field to exactly one value/length, which is
    // unusual but not degenerate — nothing about it makes the definition
    // unsatisfiable. Only a strict `>` is a definition that can never be
    // satisfied.
    if (value.min !== undefined && value.max !== undefined && value.min > value.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['max'],
        message: 'max must be greater than or equal to min',
      })
    }
    if (
      value.minLength !== undefined &&
      value.maxLength !== undefined &&
      value.minLength > value.maxLength
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxLength'],
        message: 'maxLength must be greater than or equal to minLength',
      })
    }
  })

/**
 * Parses a caller-supplied `validationRules` value into the closed shape the
 * write path accepts, or throws `ValidationError`.
 *
 * `undefined` in, `undefined` out — a caller that never mentioned
 * `validationRules` gets no opinion imposed on it, same as every other
 * optional field on `CreateAttributeDefinitionInput`/`SafeFieldPatch`; the
 * column's own `DEFAULT '{}'` covers the create path, and `updateSafeFields`
 * already treats an absent key as "leave untouched".
 *
 * Deliberately does NOT know `dataType` — see
 * `assertValidationRulesMatchDataType` below for the cross-field check that
 * does, and for why it has to be a separate call.
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

/**
 * Refuses a `validationRules` shape that carries a rule irrelevant to its
 * definition's `dataType` — checked from what `buildFieldSchema` actually
 * does, not from what merely seems tidy:
 *
 * `attribute-validator.ts`'s `buildFieldSchema` is a `switch` on `dataType`.
 * The `'string'` branch is the ONLY branch that ever reads
 * `rules.minLength`/`rules.maxLength`; the `'number'` branch is the ONLY
 * branch that ever reads `rules.min`/`rules.max`. Every other branch
 * (`boolean`, `date`, `enum`) ignores both pairs completely — not an error,
 * just silently inert. Storing `minLength` on a `number` attribute is
 * therefore not a smaller version of a real constraint, it is a value with
 * NO effect at all, which an admin reading the definition back would
 * reasonably assume does something.
 *
 * Safe to check here, at CREATE/UPDATE time, because `dataType` is
 * immutable through both of this repository's write methods: `create`
 * receives it once and `SafeFieldPatch` excludes it BY CONSTRUCTION (see
 * that interface's own doc comment) — there is no path through
 * `create`/`updateSafeFields` where the `dataType` this check compares
 * against can change out from under a `validationRules` value that was
 * valid when written. The one place `dataType` DOES change — the preview/
 * commit migration job, Milestone 8 Tasks 8-10 — is explicitly a SEPARATE
 * write path from these two methods (again, that interface's doc comment),
 * so it is not this function's job to anticipate it, and it will need its
 * own handling of `validationRules` when it lands, not a carve-out here.
 *
 * Deliberately NOT extended to `options`/`enum` in this pass: that would be
 * the same kind of check for a third pair, but nothing asked for it and
 * doing it well means auditing every dataType branch's tolerance for
 * `options` the same way this function's own doc comment just did for the
 * two pairs above. Left as a candidate follow-up, not silently forgotten.
 */
export function assertValidationRulesMatchDataType(
  rules: ValidationRules | undefined,
  dataType: AttributeDataType,
): void {
  if (!rules) return

  if ((rules.minLength !== undefined || rules.maxLength !== undefined) && dataType !== 'string') {
    throw new ValidationError([
      `validationRules.minLength/maxLength apply only to dataType "string"; this attribute is ` +
        `"${dataType}", where a string length rule has no effect`,
    ])
  }

  if ((rules.min !== undefined || rules.max !== undefined) && dataType !== 'number') {
    throw new ValidationError([
      `validationRules.min/max apply only to dataType "number"; this attribute is "${dataType}", ` +
        'where a numeric range rule has no effect',
    ])
  }
}
