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

  // LOW finding: `z.coerce.number()` alone accepts a single-element ARRAY,
  // not just a scalar — `?limit[]=5` parses (via Express's `qs`) to
  // `{ limit: ['5'] }`, and `Number(['5'])` is `5` (Array.prototype.toString
  // joins a one-element array with no separator before the numeric
  // coercion ever sees it). A two-element array already correctly 400s
  // (`Number(['5','6'])` is `NaN`), which is what made this easy to miss.
  it('rejects an array value for limit, even a single-element one, rather than silently coercing it', () => {
    expect(() => parsePageQuery({ limit: ['5'] })).toThrow(ValidationError)
    expect(() => parsePageQuery({ limit: ['5', '6'] })).toThrow(ValidationError)
  })

  it('rejects an array value for offset, even a single-element one', () => {
    expect(() => parsePageQuery({ offset: ['5'] })).toThrow(ValidationError)
  })

  it('still accepts a bare numeric value passed directly (not just a query-string numeral)', () => {
    expect(parsePageQuery({ limit: 10, offset: 5 })).toEqual({ limit: 10, offset: 5 })
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
