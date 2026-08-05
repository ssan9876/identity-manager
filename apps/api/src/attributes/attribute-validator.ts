import { z } from 'zod'

export type AttributeDataType = 'string' | 'number' | 'boolean' | 'date' | 'enum'

export interface ValidationRules {
  minLength?: number
  maxLength?: number
  pattern?: string
  min?: number
  max?: number
  options?: string[]
}

export interface AttributeDefinition {
  key: string
  label: string
  dataType: AttributeDataType
  required: boolean
  validationRules: ValidationRules
  appliesTo: 'user' | 'group'
  isActive: boolean
  syncToKeycloak: boolean
  selfEditable: boolean
}

export class AttributeValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`attribute validation failed: ${issues.join('; ')}`)
    this.name = 'AttributeValidationError'
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * True only for strings that are both ISO-shaped (YYYY-MM-DD) and a real
 * calendar date. Shape alone (matched by ISO_DATE) accepts nonexistent
 * dates like 2026-02-30 or 2026-13-40; round-tripping through Date.UTC and
 * checking the parts survived unchanged catches those, because JS silently
 * rolls overflowing month/day values into the following month/year instead
 * of rejecting them.
 */
function isIsoCalendarDate(value: string): boolean {
  const match = ISO_DATE.exec(value)
  if (!match) return false

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function fieldSchema(definition: AttributeDefinition): z.ZodTypeAny {
  const rules = definition.validationRules

  switch (definition.dataType) {
    case 'string': {
      let schema = z.string()
      if (rules.minLength !== undefined) schema = schema.min(rules.minLength)
      if (rules.maxLength !== undefined) schema = schema.max(rules.maxLength)
      // SECURITY (deferred, not fixed here): `rules.pattern` is DB-sourced
      // and unvalidated. A catastrophic-backtracking pattern (e.g.
      // `^(a+)+$`) compiled and executed here can hang the Node event loop
      // — measured 96.7s on a 33-character input. Currently unreachable
      // (no write path exists for `attribute_definitions`), so left as-is.
      // This MUST be addressed — a pattern-safety check or an execution
      // timeout — by whichever change first exposes a write path for
      // `attribute_definitions`.
      if (rules.pattern !== undefined) schema = schema.regex(new RegExp(rules.pattern))
      return schema
    }
    case 'number': {
      let schema = z.number()
      if (rules.min !== undefined) schema = schema.min(rules.min)
      if (rules.max !== undefined) schema = schema.max(rules.max)
      return schema
    }
    case 'boolean':
      return z.boolean()
    case 'date':
      return z
        .string()
        .refine(isIsoCalendarDate, 'must be a valid ISO calendar date (YYYY-MM-DD)')
    case 'enum': {
      const options = rules.options ?? []
      if (options.length === 0) {
        // A misconfigured definition fails closed (validation for its whole
        // scope stops rather than silently skipping the broken field), but
        // must still surface as AttributeValidationError: callers catch
        // that type to turn a validation failure into a 400, and a bare
        // Error here would escape as an unhandled 500 instead.
        throw new AttributeValidationError([
          `enum attribute "${definition.key}" has no options configured`,
        ])
      }
      return z.enum(options as [string, ...string[]])
    }
  }
}

/**
 * Builds a strict Zod object from the active definitions for one entity type.
 * Unknown keys are rejected: un-modelled data must never enter a record.
 */
export function buildAttributeSchema(
  definitions: AttributeDefinition[],
  appliesTo: 'user' | 'group' = 'user',
): z.ZodType<Record<string, unknown>> {
  // Object.create(null) rather than {}: a definition keyed "__proto__"
  // assigned via shape[definition.key] = field would otherwise hit
  // Object.prototype's __proto__ accessor setter instead of creating an
  // own property, silently vanishing from the shape (zero keys, and the
  // field's `required` flag along with it) rather than throwing. A
  // null-prototype object has no such accessor, so the assignment always
  // creates a genuine own property regardless of the key's name.
  const shape: Record<string, z.ZodTypeAny> = Object.create(null)

  for (const definition of definitions) {
    if (!definition.isActive || definition.appliesTo !== appliesTo) {
      continue
    }

    const field = fieldSchema(definition)
    shape[definition.key] = definition.required ? field : field.optional()
  }

  return z.object(shape).strict() as z.ZodType<Record<string, unknown>>
}

/**
 * Copies the input into a null-prototype object holding only its own
 * properties — by property *descriptor*, not by reading each value — before
 * Zod ever sees it.
 *
 * Zod reads each shape key off the payload via `data[key]`. For key names
 * that Object.prototype also carries — __proto__ (an accessor) as well as
 * constructor, toString, hasOwnProperty, valueOf, isPrototypeOf, etc.
 * (plain inherited data properties) — that read returns the *inherited*
 * value on an ordinary payload that never set an own property with that
 * name, rather than `undefined`. A schema field for such a key is then
 * never recognised as absent, so `.optional()` never applies and an
 * unrelated payload that simply never mentioned the key fails validation.
 * A null-prototype copy has no inherited properties to leak through, which
 * fixes that.
 *
 * Copying by descriptor (Object.getOwnPropertyDescriptors +
 * Object.defineProperties) rather than by value (Object.assign) matters for
 * two further reasons:
 *  - Object.assign reads (invokes) every own *enumerable* property's getter
 *    while copying, before Zod's own `.strict()` unknown-key scan — which
 *    uses `for...in` and never invokes getters — ever runs. A throwing
 *    getter on a key that isn't even part of the schema would abort the
 *    copy with a raw, uncaught Error instead of the clean "unrecognized
 *    key" AttributeValidationError Zod would otherwise produce.
 *    getOwnPropertyDescriptors captures a getter as a function reference,
 *    not its invoked result, so defineProperties installs it without
 *    calling it; it only runs later if Zod actually reads that key (i.e.
 *    only for a key that's part of the declared shape).
 *  - Object.assign's source enumeration skips *non-enumerable* own
 *    properties entirely, silently dropping them from the copy — causing a
 *    required declared attribute stored non-enumerably to be rejected as
 *    missing, and an optional one to vanish from the result with no error
 *    at all. getOwnPropertyDescriptors returns every own property
 *    regardless of enumerability, and defineProperties preserves each
 *    property's enumerable flag on the copy, so a declared field's value is
 *    read correctly either way, while `.strict()`'s unknown-key scan (which
 *    does depend on enumerability, being for...in-based) is unaffected.
 *
 * defineProperties always creates *own* properties via [[DefineOwnProperty]]
 * and never triggers an inherited setter, so a genuine own "__proto__" is
 * still preserved (the round-1 shape fix keeps working).
 *
 * Non-object inputs (arrays, primitives, null) pass through unchanged so
 * their existing top-level type-mismatch errors keep surfacing normally.
 */
function sanitizePayload(value: unknown): unknown {
  const input = value ?? {}
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input
  }
  const payload = Object.create(null)
  Object.defineProperties(payload, Object.getOwnPropertyDescriptors(input))
  return payload
}

export function validateAttributes(
  definitions: AttributeDefinition[],
  value: unknown,
  appliesTo: 'user' | 'group' = 'user',
): Record<string, unknown> {
  const result = buildAttributeSchema(definitions, appliesTo).safeParse(sanitizePayload(value))

  if (!result.success) {
    throw new AttributeValidationError(
      result.error.issues.map((issue) => {
        const key = issue.path.join('.')
        return key.length > 0 ? `${key}: ${issue.message}` : issue.message
      }),
    )
  }

  return result.data
}
