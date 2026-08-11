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
        // Reachable: enough digits overflows to Infinity without any 'e' in the text.
        return { ok: false, reason: `"${text}" is too large to hold as a number` }
      }
      // THE RULE, stated once, for integers and decimals alike: accept the text only
      // when it is the double's own decimal identity, ignoring presentational zeros.
      //
      //     normalise(text) === normalise(String(n))
      //
      // What that means, and why it is not "the double equals the text exactly":
      // exact equality would refuse '0.1', because no double equals one tenth. The
      // property actually worth enforcing is that no digit the operator wrote is
      // lost. ECMA-262 defines Number::toString to emit the SHORTEST decimal that
      // reparses to that exact double, so String(n) is n's canonical identity. If
      // the text normalises to that identity, every digit written survives storage
      // and re-rendering. If it does not, the text either carried digits the double
      // cannot distinguish ('0.1000000000000000055511151231257827' renders back as
      // '0.1' — 33 digits gone) or named a different value outright
      // ('9007199254740993.0' renders back as '9007199254740992').
      //
      // Why it holds for EVERY input the regex admits, not just the shapes tested:
      // normalise() reduces a decimal string to (sign, significand, power of ten)
      // with no leading or trailing zeros in the significand — the unique normal
      // form of the exact rational the string denotes. Uniqueness makes the compare
      // an equality test on values rather than on formatting, so trailing zeros,
      // leading zeros, -0 and exponential notation all collapse before comparison.
      // Carrying the exponent as a number is what removes the magnitude cliff that
      // digit-position juggling kept reintroducing: String(n) switches to
      // exponential below 1e-6 and at/above 1e21, and normalise() reads both
      // notations into the same form, so '0.0000001' and its rendering '1e-7'
      // compare equal.
      const normalText = normaliseDecimal(text)
      const normalDouble = normaliseDecimal(String(n))
      if (normalText === null || normalDouble === null || normalText !== normalDouble) {
        return { ok: false, reason: `"${text}" is not exactly the number ${String(n)}` }
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

const DECIMAL_OR_EXPONENTIAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/

/**
 * Reduce a decimal string to the unique normal form of the exact rational it denotes:
 * `<sign><significand>e<exponent>`, where the significand has no leading and no trailing
 * zeros, and the value is `significand × 10^exponent`. Zero normalises to '0' regardless
 * of sign or spelling. Returns null for anything that is not a decimal numeral.
 *
 * Two strings normalise to the same form if and only if they denote the same exact
 * value, so an equality test on the output is an equality test on values — formatting
 * (trailing zeros, leading zeros, -0, plain vs exponential notation) is gone by then.
 *
 * Accepts both notations deliberately: the caller compares operator-written text, which
 * is always plain decimal, against `String(n)`, which JavaScript renders exponentially
 * below 1e-6 and at or above 1e21. Handling the exponent as a NUMBER rather than as a
 * count of written zeros is what makes this free of magnitude cliffs.
 *
 * - '100.00'    → '1e2'      - '0.0000001' → '1e-7'
 * - '007.5'     → '75e-1'    - '1e-7'      → '1e-7'   (same value, same form)
 * - '-0.0'      → '0'        - '1e+21'     → '1e21'
 */
function normaliseDecimal(s: string): string | null {
  const parts = DECIMAL_OR_EXPONENTIAL.exec(s)
  if (parts === null) return null
  const [, sign, intPart = '', fracPart = '', exponentPart] = parts
  // The regex tolerates a digitless string ('', '.', 'e5'); a numeral needs a digit.
  if (intPart === '' && fracPart === '') return null

  // Value is (intPart ++ fracPart) × 10^(exponent - fracPart.length): moving the point
  // right past the fraction digits is a multiplication that the exponent pays back.
  let digits = intPart + fracPart
  let exponent = (exponentPart === undefined ? 0 : Number(exponentPart)) - fracPart.length

  digits = digits.replace(/^0+/, '')
  if (digits === '') return '0'

  const withoutTrailingZeros = digits.replace(/0+$/, '')
  exponent += digits.length - withoutTrailingZeros.length

  return `${sign === '-' ? '-' : ''}${withoutTrailingZeros}e${exponent}`
}
