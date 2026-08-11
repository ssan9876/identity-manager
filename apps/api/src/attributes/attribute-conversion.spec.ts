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
