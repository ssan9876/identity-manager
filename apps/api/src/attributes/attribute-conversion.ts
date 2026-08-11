export type AttributeDataType = 'string' | 'number' | 'boolean' | 'date' | 'enum'

export type ConversionResult =
  | { ok: true; value: string | number | boolean }
  | { ok: false; reason: string }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/

/**
 * Convert one stored value for a dataType change.
 *
 * STRICT ON PURPOSE. Every rule here refuses something JavaScript would happily
 * coerce — `Number('')` is 0, `Boolean('no')` is true, `new Date('10/08/2026')`
 * is a different day depending on locale. A migration that coerces is a
 * migration that rewrites data nobody looked at; a migration that refuses
 * produces a list an operator can read. The list is the product.
 */
export function convertValue(
  value: unknown,
  from: AttributeDataType,
  to: AttributeDataType,
  options?: readonly string[],
): ConversionResult {
  if (from === to) {
    if (typeof value === 'string') {
      return { ok: true, value }
    }
    if (typeof value === 'number') {
      // Reject NaN and Infinity: they serialize to null in JSON, accepted with no refusal.
      if (!Number.isFinite(value)) {
        return { ok: false, reason: `value is ${describe(value)}, which is not finite` }
      }
      return { ok: true, value }
    }
    if (typeof value === 'boolean') {
      return { ok: true, value }
    }
    return { ok: false, reason: `value is ${describe(value)}, which is not a storable scalar` }
  }

  const text = asText(value)
  if (text === null) {
    return { ok: false, reason: `value is ${describe(value)}, which cannot be read as text` }
  }

  switch (to) {
    case 'number': {
      // Deliberately not Number(): it accepts '', '0x10', 'Infinity'.
      if (!/^-?\d+(\.\d+)?$/.test(text)) {
        return { ok: false, reason: `"${text}" is not a plain decimal number` }
      }
      const n = Number(text)
      if (!Number.isFinite(n)) {
        return { ok: false, reason: `"${text}" is not finite` }
      }
      // For integers, refuse if outside safe range; for floats, numeric round-trip check.
      const isInteger = !/\./.test(text)
      if (isInteger && !Number.isSafeInteger(n)) {
        return { ok: false, reason: `"${text}" is outside JavaScript's safe integer range` }
      }
      if (!isInteger) {
        // For decimals, check numeric round-trip: re-parse the stringified value.
        // This catches precision loss without rejecting equivalent formatting like '100.00'.
        const reparsed = Number(String(n))
        if (reparsed !== n) {
          return { ok: false, reason: `"${text}" loses precision when converted to a number` }
        }
      }
      return { ok: true, value: n }
    }
    case 'boolean': {
      if (text === 'true') return { ok: true, value: true }
      if (text === 'false') return { ok: true, value: false }
      return { ok: false, reason: `"${text}" is not literally "true" or "false"` }
    }
    case 'date': {
      if (!ISO_DATE.test(text) || Number.isNaN(Date.parse(text))) {
        return { ok: false, reason: `"${text}" is not an ISO-8601 date` }
      }
      // Date.parse does rollover: Feb 30 → Mar 2. Validate that the literal
      // date component (YYYY-MM-DD) in the input is a valid calendar date.
      // Ignore timezone and time; validate only the input's own y/m/d.
      const inputMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
      if (inputMatch) {
        const [, inputYear, inputMonth, inputDay] = inputMatch
        // Create a date string with the literal components at UTC midnight,
        // then check if the parsed result matches those same components.
        // A rollover (Feb 30 → Mar 2) will produce different values.
        const dateOnly = `${inputYear}-${inputMonth}-${inputDay}T00:00:00Z`
        const parsed = new Date(dateOnly)
        const parsedYear = String(parsed.getUTCFullYear()).padStart(4, '0')
        const parsedMonth = String(parsed.getUTCMonth() + 1).padStart(2, '0')
        const parsedDay = String(parsed.getUTCDate()).padStart(2, '0')
        if (parsedYear !== inputYear || parsedMonth !== inputMonth || parsedDay !== inputDay) {
          return { ok: false, reason: `"${text}" is not a valid calendar date (month/day rollover)` }
        }
      }
      return { ok: true, value: text }
    }
    case 'enum': {
      if (!options || options.length === 0) {
        return { ok: false, reason: 'the target definition declares no allowed values' }
      }
      if (!options.includes(text)) {
        return { ok: false, reason: `"${text}" is not one of: ${options.join(', ')}` }
      }
      return { ok: true, value: text }
    }
    case 'string':
      return { ok: true, value: text }
  }
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value === 'boolean') return String(value)
  return null
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value
}
