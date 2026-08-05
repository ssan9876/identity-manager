import { describe, expect, it } from 'vitest'
import { ValidationError } from '../src/common/errors'
import { parsePageQuery } from '../src/common/pagination'

describe('parsePageQuery', () => {
  it('applies defaults when nothing is supplied', () => {
    expect(parsePageQuery({})).toEqual({ limit: 50, offset: 0 })
  })

  it('accepts numeric strings from the query string', () => {
    expect(parsePageQuery({ limit: '10', offset: '20' })).toEqual({
      limit: 10,
      offset: 20,
    })
  })

  it('caps limit at 100 rather than rejecting it', () => {
    expect(parsePageQuery({ limit: '5000' }).limit).toBe(100)
  })

  it('rejects a negative offset', () => {
    expect(() => parsePageQuery({ offset: '-1' })).toThrow(ValidationError)
  })

  // Carried finding from Task 5's review: offset had no upper bound, so a
  // preposterous value like this passed validation and would have reached
  // Postgres as a raw bigint error (a 500) instead of a clean 400.
  it('rejects an offset above a sane upper bound', () => {
    expect(() => parsePageQuery({ offset: '1e21' })).toThrow(ValidationError)
  })

  it('rejects a zero or negative limit', () => {
    expect(() => parsePageQuery({ limit: '0' })).toThrow(ValidationError)
  })

  it('rejects a non-numeric limit', () => {
    expect(() => parsePageQuery({ limit: 'lots' })).toThrow(ValidationError)
  })

  it('rejects a fractional limit', () => {
    expect(() => parsePageQuery({ limit: '2.5' })).toThrow(ValidationError)
  })

  it('names the offending field in the issues list', () => {
    try {
      parsePageQuery({ limit: 'lots' })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as ValidationError).issues.join()).toContain('limit')
    }
  })
})
