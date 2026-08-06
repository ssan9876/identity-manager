import { describe, expect, it } from 'vitest'
import {
  extraHeaders,
  missingRequiredHeaders,
  parseImportRowShape,
  REQUIRED_IMPORT_HEADERS,
} from '../src/imports/import-row'

const VALID_RAW = {
  employeeId: 'E1',
  primaryEmail: 'e1@example.com',
  username: 'e1',
  firstName: 'Ellen',
  lastName: 'One',
  orgUnitId: '11111111-1111-1111-1111-111111111111',
  jobTitle: '',
  managerId: '',
  location: '',
  startDate: '',
  endDate: '',
}

describe('missingRequiredHeaders', () => {
  it('is empty when every required column is present', () => {
    expect(missingRequiredHeaders([...REQUIRED_IMPORT_HEADERS, 'jobTitle'])).toEqual([])
  })

  it('names each missing required column', () => {
    expect(missingRequiredHeaders(['employeeId', 'primaryEmail'])).toEqual(
      REQUIRED_IMPORT_HEADERS.filter((h) => h !== 'employeeId' && h !== 'primaryEmail'),
    )
  })
})

describe('extraHeaders', () => {
  it('is empty when the file only has known columns', () => {
    expect(extraHeaders([...REQUIRED_IMPORT_HEADERS, 'jobTitle', 'managerId'])).toEqual([])
  })

  it('names every column outside the fixed/known set, in file order', () => {
    expect(extraHeaders([...REQUIRED_IMPORT_HEADERS, 'costCenter', 'shirtSize'])).toEqual([
      'costCenter',
      'shirtSize',
    ])
  })
})

describe('parseImportRowShape', () => {
  it('accepts a fully valid row and normalizes empty optional cells to null', () => {
    const result = parseImportRowShape(VALID_RAW, false)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.row.employeeId).toBe('E1')
    expect(result.row.primaryEmail).toBe('e1@example.com')
    expect(result.row.jobTitle).toBeNull()
    expect(result.row.managerId).toBeNull()
    expect(result.row.startDate).toBeNull()
    expect(result.row.rawAttributes).toBeUndefined()
  })

  it('keeps a provided optional value rather than nulling it', () => {
    const result = parseImportRowShape({ ...VALID_RAW, jobTitle: 'Engineer' }, false)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.row.jobTitle).toBe('Engineer')
  })

  it('reports each missing required field by name, not just the first', () => {
    const result = parseImportRowShape(
      { ...VALID_RAW, employeeId: '', username: '' },
      false,
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.issues.some((i) => i.includes('employeeId'))).toBe(true)
    expect(result.issues.some((i) => i.includes('username'))).toBe(true)
  })

  it('rejects a malformed email', () => {
    const result = parseImportRowShape({ ...VALID_RAW, primaryEmail: 'not-an-email' }, false)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.issues.some((i) => i.includes('primaryEmail'))).toBe(true)
  })

  it('rejects a non-UUID orgUnitId', () => {
    const result = parseImportRowShape({ ...VALID_RAW, orgUnitId: 'not-a-uuid' }, false)
    expect(result.ok).toBe(false)
  })

  it('rejects a malformed startDate', () => {
    const result = parseImportRowShape({ ...VALID_RAW, startDate: '2026/01/01' }, false)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.issues.some((i) => i.includes('startDate'))).toBe(true)
  })

  it('rejects a non-UUID managerId when present', () => {
    const result = parseImportRowShape({ ...VALID_RAW, managerId: 'not-a-uuid' }, false)
    expect(result.ok).toBe(false)
  })

  it('leaves rawAttributes undefined when the file has no extra headers, even if extra keys are present on the raw object', () => {
    const result = parseImportRowShape({ ...VALID_RAW, costCenter: 'CC-1' }, false)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.row.rawAttributes).toBeUndefined()
  })

  it('collects extra-header values into rawAttributes when the file has extra headers', () => {
    const result = parseImportRowShape({ ...VALID_RAW, costCenter: 'CC-1', notes: '' }, true)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.row.rawAttributes).toEqual({ costCenter: 'CC-1' })
  })
})
