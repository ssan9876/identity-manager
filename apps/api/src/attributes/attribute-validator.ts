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
 * enumerable properties before Zod ever sees it.
 *
 * Zod reads each shape key off the payload via `data[key]`. For key names
 * that Object.prototype also carries — __proto__ (an accessor) as well as
 * constructor, toString, hasOwnProperty, valueOf, isPrototypeOf, etc.
 * (plain inherited data properties) — that read returns the *inherited*
 * value on an ordinary payload that never set an own property with that
 * name, rather than `undefined`. A schema field for such a key is then
 * never recognised as absent, so `.optional()` never applies and an
 * unrelated payload that simply never mentioned the key fails validation.
 * A null-prototype copy has no inherited properties to leak through:
 * Object.assign only copies the source's *own* enumerable properties, so a
 * key genuinely set on the input is preserved with its value, and a key
 * that was never own-set on the input is absent from the copy too — which
 * reads back as `undefined`, exactly what `.optional()` needs.
 *
 * Non-object inputs (arrays, primitives, null) pass through unchanged so
 * their existing top-level type-mismatch errors keep surfacing normally.
 */
function sanitizePayload(value: unknown): unknown {
  const input = value ?? {}
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? Object.assign(Object.create(null), input)
    : input
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
