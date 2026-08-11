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

  it('gives a reason on every refusal, for the preview to show', () => {
    const r = convertValue('42abc', 'string', 'number')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0)
  })
})
