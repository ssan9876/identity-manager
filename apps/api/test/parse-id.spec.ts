import { describe, expect, it } from 'vitest'
import { ValidationError } from '../src/common/errors'
import { parseId } from '../src/common/http/parse-id'

describe('parseId', () => {
  const valid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

  it('returns a valid uuid unchanged', () => {
    expect(parseId(valid)).toBe(valid)
  })

  it('rejects a non-uuid with ValidationError', () => {
    expect(() => parseId('not-a-uuid')).toThrow(ValidationError)
  })

  it('names the default field "id" in the issue', () => {
    try {
      parseId('nope')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as ValidationError).issues.join()).toContain('id')
    }
  })

  it('names a custom field when supplied', () => {
    try {
      parseId('nope', 'userId')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as ValidationError).issues.join()).toContain('userId')
    }
  })

  it('rejects non-string input rather than coercing it', () => {
    expect(() => parseId(42)).toThrow(ValidationError)
    expect(() => parseId(null)).toThrow(ValidationError)
    expect(() => parseId(undefined)).toThrow(ValidationError)
    expect(() => parseId(['a'])).toThrow(ValidationError)
  })
})
