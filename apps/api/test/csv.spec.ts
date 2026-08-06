import { describe, expect, it } from 'vitest'
import { ValidationError } from '../src/common/errors'
import { parseCsv } from '../src/imports/csv'

describe('parseCsv', () => {
  it('parses a well-formed CSV into headers and header-keyed rows', () => {
    const result = parseCsv('employeeId,primaryEmail\nE1,e1@example.com\nE2,e2@example.com')
    expect(result.headers).toEqual(['employeeId', 'primaryEmail'])
    expect(result.rows).toEqual([
      { employeeId: 'E1', primaryEmail: 'e1@example.com' },
      { employeeId: 'E2', primaryEmail: 'e2@example.com' },
    ])
  })

  it('strips a leading UTF-8 BOM from the first header', () => {
    const result = parseCsv('﻿employeeId,primaryEmail\nE1,e1@example.com')
    expect(result.headers[0]).toBe('employeeId')
  })

  it('treats CRLF line endings the same as LF', () => {
    const result = parseCsv(
      'employeeId,primaryEmail\r\nE1,e1@example.com\r\nE2,e2@example.com\r\n',
    )
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0].employeeId).toBe('E1')
    expect(result.rows[1].employeeId).toBe('E2')
  })

  it('a header-only file (zero data rows) parses cleanly as an empty batch, not an error', () => {
    const result = parseCsv('employeeId,primaryEmail')
    expect(result.headers).toEqual(['employeeId', 'primaryEmail'])
    expect(result.rows).toEqual([])
  })

  it('rejects a totally empty file with ValidationError, not a crash', () => {
    expect(() => parseCsv('')).toThrow(ValidationError)
  })

  it('rejects a whitespace-only file with ValidationError', () => {
    expect(() => parseCsv('   \n   ')).toThrow(ValidationError)
  })

  it('rejects an unterminated quote as ValidationError, never an unmapped throw', () => {
    expect(() => parseCsv('employeeId,primaryEmail\n"E1,e1@example.com')).toThrow(
      ValidationError,
    )
  })

  it('rejects a row with fewer columns than the header as ValidationError', () => {
    expect(() =>
      parseCsv('employeeId,primaryEmail,username\nE1,e1@example.com'),
    ).toThrow(ValidationError)
  })

  it('rejects a row with more columns than the header as ValidationError', () => {
    expect(() =>
      parseCsv('employeeId,primaryEmail\nE1,e1@example.com,extra'),
    ).toThrow(ValidationError)
  })

  it('keeps a quoted field with an embedded newline as one field, not two rows', () => {
    const result = parseCsv('employeeId,notes\nE1,"line one\nline two"')
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].notes).toBe('line one\nline two')
  })

  it('skips genuinely blank lines rather than treating them as a malformed row', () => {
    const result = parseCsv('employeeId,primaryEmail\nE1,e1@example.com\n\nE2,e2@example.com\n')
    expect(result.rows).toHaveLength(2)
  })
})
