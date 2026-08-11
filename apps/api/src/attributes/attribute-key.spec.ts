import { describe, expect, it } from 'vitest'
import { ATTRIBUTE_KEY_SQL_PATTERN, validateAttributeKey } from './attribute-key'

describe('validateAttributeKey', () => {
  it('accepts a plain identifier', () => {
    expect(validateAttributeKey('costCentre')).toEqual([])
    expect(validateAttributeKey('cost_centre')).toEqual([])
    expect(validateAttributeKey('a1')).toEqual([])
  })

  // The whole reason this module exists. These are legal jsonb keys and legal
  // varchar(64) values, so nothing downstream would have refused them.
  it.each(['__proto__', 'constructor', 'prototype'])('refuses %s', (key) => {
    const problems = validateAttributeKey(key)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.join(' ')).toContain('reserved')
  })

  it('refuses a leading digit, so a key can never look like an index', () => {
    expect(validateAttributeKey('1st')).not.toEqual([])
  })

  it('refuses characters outside the closed class', () => {
    for (const key of ['has space', 'has.dot', 'has-dash', 'café', 'a$b', '']) {
      expect(validateAttributeKey(key), key).not.toEqual([])
    }
  })

  it('refuses anything longer than the column', () => {
    expect(validateAttributeKey('a'.repeat(65))).not.toEqual([])
    expect(validateAttributeKey('a'.repeat(64))).toEqual([])
  })

  it('refuses a non-string without throwing', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(() => validateAttributeKey(bad)).not.toThrow()
      expect(validateAttributeKey(bad)).not.toEqual([])
    }
  })

  // The regex and the SQL fragment are two spellings of one rule, linked
  // only by a comment — attribute-key.ts also throws at import time if they
  // diverge (belt), and this test pins the literal string so a change to
  // either one without the other fails an ordinary assertion here too
  // (suspenders), rather than relying on someone noticing the comment.
  it('keeps the SQL CHECK pattern identical to the regex the application enforces', () => {
    expect(ATTRIBUTE_KEY_SQL_PATTERN).toBe('^[A-Za-z_][A-Za-z0-9_]*$')
    for (const key of ['costCentre', 'cost_centre', 'a1', '__proto__']) {
      expect(new RegExp(ATTRIBUTE_KEY_SQL_PATTERN).test(key)).toBe(true)
    }
    for (const key of ['has space', 'has.dot', '1st', '']) {
      expect(new RegExp(ATTRIBUTE_KEY_SQL_PATTERN).test(key)).toBe(false)
    }
  })
})
