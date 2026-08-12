import { describe, expect, it } from 'vitest'
import { convertValue } from './attribute-conversion'

describe('convertValue', () => {
  it('round-trips string to number only when exact', () => {
    expect(convertValue('42', 'string', 'number')).toEqual({ ok: true, value: 42 })
    expect(convertValue('42.5', 'string', 'number')).toEqual({ ok: true, value: 42.5 })
    // Refused: these all coerce in JavaScript and would silently rewrite data.
    for (const bad of ['', ' ', '42abc', 'NaN', 'Infinity', '0x10', '1e999']) {
      expect(convertValue(bad, 'string', 'number').ok, bad).toBe(false)
    }
  })

  it('refuses numeric strings that lose precision past MAX_SAFE_INTEGER', () => {
    // This string parses to a different number: silent data corruption.
    // MAX_SAFE_INTEGER is 9007199254740991.
    const result = convertValue('9007199254740993', 'string', 'number')
    expect(result.ok, '9007199254740993 (MAX_SAFE_INTEGER + 2)').toBe(false)
    // Within safe range is still accepted.
    expect(convertValue('9007199254740991', 'string', 'number').ok, 'MAX_SAFE_INTEGER (9007199254740991)').toBe(true)
  })

  it('accepts only literal boolean spellings', () => {
    expect(convertValue('true', 'string', 'boolean')).toEqual({ ok: true, value: true })
    expect(convertValue('false', 'string', 'boolean')).toEqual({ ok: true, value: false })
    // Refused: truthiness is not a conversion rule.
    for (const bad of ['1', '0', 'yes', 'no', 'TRUE', '']) {
      expect(convertValue(bad, 'string', 'boolean').ok, bad).toBe(false)
    }
  })

  it('accepts only ISO-8601 for date', () => {
    expect(convertValue('2026-08-10', 'string', 'date').ok).toBe(true)
    for (const bad of ['10/08/2026', 'August 10 2026', '2026-13-01', '']) {
      expect(convertValue(bad, 'string', 'date').ok, bad).toBe(false)
    }
  })

  it('rejects invalid calendar dates even when Date.parse accepts them', () => {
    // Date.parse does rollover arithmetic instead of rejecting — Feb 30 rolls to Mar 2.
    // But the stored value would be the literal invalid text, unrecoverable downstream.
    expect(convertValue('2026-02-30', 'string', 'date').ok, '2026-02-30').toBe(false)
    expect(convertValue('2026-04-31', 'string', 'date').ok, '2026-04-31').toBe(false)
    // 2026 is not a leap year, but Feb 29 is still rejected.
    expect(convertValue('2026-02-29', 'string', 'date').ok, '2026-02-29').toBe(false)
    // 2024 IS a leap year, so Feb 29 must be accepted.
    expect(convertValue('2024-02-29', 'string', 'date').ok).toBe(true)
    // Century leap-year edges: 2000 is a leap year, 1900 is not.
    expect(convertValue('2000-02-29', 'string', 'date').ok).toBe(true)
    expect(convertValue('1900-02-29', 'string', 'date').ok).toBe(false)
  })

  it('accepts ISO-8601 datetimes with timezone offsets', () => {
    // Date-only: no offset, should accept.
    expect(convertValue('2026-08-10', 'string', 'date').ok).toBe(true)
    // Full datetime with Z (UTC): should accept.
    expect(convertValue('2026-08-10T12:00:00Z', 'string', 'date').ok).toBe(true)
    // Positive offset: 2026-08-10 local in +05:30 zone is 2026-08-09 UTC.
    // The literal input date is 2026-08-10, which is what we validate.
    expect(convertValue('2026-08-10T01:00:00+05:30', 'string', 'date').ok).toBe(true)
    // Negative offset: 2026-08-10 local in -05:30 zone is 2026-08-10 UTC (mostly).
    expect(convertValue('2026-08-10T23:00:00-05:30', 'string', 'date').ok).toBe(true)
    // Fractional seconds: valid ISO-8601.
    expect(convertValue('2026-08-10T12:34:56.789Z', 'string', 'date').ok).toBe(true)
  })

  it('accepts decimal numbers with trailing zeros and leading zeros', () => {
    // Trailing zeros: 100.00 parses to 100 exactly, not a precision loss.
    expect(convertValue('100.00', 'string', 'number')).toEqual({ ok: true, value: 100 })
    // Leading zeros: 0.1 is just 0.1, valid.
    expect(convertValue('0.1', 'string', 'number')).toEqual({ ok: true, value: 0.1 })
    // More trailing zeros: 0.0 parses to 0 exactly.
    expect(convertValue('0.0', 'string', 'number')).toEqual({ ok: true, value: 0 })
    expect(convertValue('3.14', 'string', 'number')).toEqual({ ok: true, value: 3.14 })
  })

  it('refuses decimal strings where precision is lost during parsing', () => {
    // The original text claims precision the double cannot hold; the parsed value is different.
    // These were silently accepted before because the check was a tautology.
    expect(convertValue('1.00000000000000001', 'string', 'number').ok, '1.00000000000000001').toBe(false)
    expect(convertValue('9007199254740993.0', 'string', 'number').ok, '9007199254740993.0').toBe(false)
    expect(convertValue('9007199254740993.5', 'string', 'number').ok, '9007199254740993.5').toBe(false)
    expect(convertValue('123456789012345678.9', 'string', 'number').ok, '123456789012345678.9').toBe(false)
    // But trailing-zero decimals still accept (formatting, not precision).
    expect(convertValue('0.30000000000000004', 'string', 'number')).toEqual({ ok: true, value: 0.30000000000000004 })
  })

  it('refuses text that names digits the double cannot distinguish', () => {
    // The exact value of the double nearest 0.1 begins 0.10000000000000000555111512312578270211...
    // This text is *closer* to that double than '0.1' is, yet it must still be refused:
    // it renders back as '0.1', so 33 written digits are gone. The rule is round-trip
    // identity — no written digit is lost — not "the double equals the text exactly",
    // which would have to refuse '0.1' as well, since no double equals one tenth.
    expect(convertValue('0.1000000000000000055511151231257827', 'string', 'number').ok).toBe(false)
    expect(convertValue('0.1', 'string', 'number')).toEqual({ ok: true, value: 0.1 })
    // Half-way cases round to a neighbour, so the text names a value the double is not.
    expect(convertValue('9007199254740991.5', 'string', 'number').ok, '9007199254740991.5').toBe(false)
    expect(convertValue('1.0000000000000001', 'string', 'number').ok, '1.0000000000000001').toBe(false)
  })

  it('accepts small magnitudes, where String(n) switches to exponential notation', () => {
    // Below 1e-6 JavaScript renders doubles as '1e-7', '1.2e-7', '1e-19'. A precision
    // check that compares digit positions instead of values invents a cliff here:
    // '0.000001' accepted, '0.0000001' refused, for no reason to do with precision.
    // Every one of these is exactly the double it parses to.
    expect(convertValue('0.000001', 'string', 'number')).toEqual({ ok: true, value: 0.000001 })
    expect(convertValue('0.0000001', 'string', 'number')).toEqual({ ok: true, value: 1e-7 })
    expect(convertValue('0.0000005', 'string', 'number')).toEqual({ ok: true, value: 5e-7 })
    expect(convertValue('0.00000012', 'string', 'number')).toEqual({ ok: true, value: 1.2e-7 })
    expect(convertValue('-0.0000001', 'string', 'number')).toEqual({ ok: true, value: -1e-7 })
    expect(convertValue('0.0000000000000000001', 'string', 'number')).toEqual({ ok: true, value: 1e-19 })
  })

  it('applies one rule to integers and decimals alike', () => {
    // 9007199254740992 is exactly representable, so it is accepted — and the trailing
    // '.0' spelling of it must not change the answer. A separate isSafeInteger policy
    // for the no-dot spelling made these two disagree about one number.
    expect(convertValue('9007199254740992', 'string', 'number')).toEqual({ ok: true, value: 9007199254740992 })
    expect(convertValue('9007199254740992.0', 'string', 'number')).toEqual({ ok: true, value: 9007199254740992 })
    // Formatting-only differences are accepted at every magnitude and sign.
    for (const [text, value] of [['007.5', 7.5], ['-0.0', -0], ['-100.00', -100], ['42.000', 42], ['1000', 1000]] as const) {
      expect(convertValue(text, 'string', 'number'), text).toEqual({ ok: true, value })
    }
    // Enough digits overflows to Infinity with no 'e' in the text to give it away.
    expect(convertValue('1'.padEnd(310, '0'), 'string', 'number').ok, 'overflow').toBe(false)
  })

  it('accepts an enum value only when it is in the allowed list', () => {
    expect(convertValue('red', 'string', 'enum', ['red', 'blue'])).toEqual({ ok: true, value: 'red' })
    expect(convertValue('green', 'string', 'enum', ['red', 'blue']).ok).toBe(false)
    // No options supplied is a refusal, never an accept-anything.
    expect(convertValue('red', 'string', 'enum').ok).toBe(false)
  })

  it('never throws, whatever it is handed', () => {
    for (const bad of [null, undefined, {}, [], Symbol('x'), 1n]) {
      expect(() => convertValue(bad, 'string', 'number')).not.toThrow()
      expect(convertValue(bad, 'string', 'number').ok).toBe(false)
    }
  })

  it('rejects NaN and Infinity in same-type number conversions', () => {
    // JSON.stringify turns both to null, accepted with no refusal an operator could see.
    expect(convertValue(NaN, 'number', 'number').ok, 'NaN').toBe(false)
    expect(convertValue(Infinity, 'number', 'number').ok, 'Infinity').toBe(false)
    expect(convertValue(-Infinity, 'number', 'number').ok, '-Infinity').toBe(false)
    // Finite numbers are still accepted.
    expect(convertValue(42, 'number', 'number').ok).toBe(true)
    expect(convertValue(0, 'number', 'number').ok).toBe(true)
  })

  it('accepts same-type conversions for strings and booleans', () => {
    expect(convertValue('hello', 'string', 'string')).toEqual({ ok: true, value: 'hello' })
    expect(convertValue(true, 'boolean', 'boolean')).toEqual({ ok: true, value: true })
    expect(convertValue(false, 'boolean', 'boolean')).toEqual({ ok: true, value: false })
  })

  it('gives a reason on every refusal, for the preview to show', () => {
    const r = convertValue('42abc', 'string', 'number')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0)
  })
})
