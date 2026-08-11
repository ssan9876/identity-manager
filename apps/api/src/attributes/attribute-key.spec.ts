import { describe, expect, it } from 'vitest'
import { validateAttributeKey } from './attribute-key'

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
})
