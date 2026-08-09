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

  /**
   * Finding INJ-L-1 (docs/archive/audits/audit-injection.md, carried as an
   * Item-10 residual). `Cf`-category characters are invisible, and the bidi
   * overrides reorder the glyphs around them, so a name carrying one renders
   * identically to somebody else's — and `displayName` (derived from
   * firstName/lastName) is shown directory-wide. The import path is the BULK
   * way to plant them, so it carries the same constraint as POST /users.
   *
   * Built with `String.fromCharCode`, never as source literals: these
   * characters do not survive editors, diffs and copy/paste reliably, and a
   * test whose fixture silently lost its own payload would pass either way.
   * Per-field cases rather than one combined row, so a partial regression
   * (the constraint dropped from one field) cannot hide behind another
   * field's failure.
   */
  const CF_CASES: ReadonlyArray<readonly [string, string]> = [
    ['firstName', `ad${String.fromCharCode(0x202e)}nimda`],
    ['lastName', `Smi${String.fromCharCode(0x200b)}th`],
    ['username', `ad${String.fromCharCode(0x200d)}min`],
    ['primaryEmail', `a${String.fromCharCode(0x200e)}dmin@example.com`],
  ]

  for (const [field, value] of CF_CASES) {
    it(`rejects a Cf-category character in ${field}`, () => {
      const result = parseImportRowShape({ ...VALID_RAW, [field]: value }, false)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.issues.some((issue) => issue.includes(field))).toBe(true)
    })
  }

  it('accepts an accented name — the constraint is the Cf category, not non-ASCII', () => {
    const result = parseImportRowShape(
      { ...VALID_RAW, firstName: 'Zoë', lastName: 'Núñez' },
      false,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.row.firstName).toBe('Zoë')
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

  // docs/archive/audits/audit-injection.md HIGH finding, second half: even
  // after csv.ts stops dropping a "__proto__" header on the way INTO `raw`,
  // this function's own `rawAttributes[key] = trimmed` loop (previously
  // built on a plain {}) would silently drop it a SECOND time on the way
  // OUT into rawAttributes. Object.create(null) here closes that.
  it('collects a "__proto__" extra header into rawAttributes as a genuine own key, never silently dropping it', () => {
    // Simulates exactly what csv.ts's own post-fix row object looks like: a
    // null-prototype object with __proto__ assigned as a real own property
    // (bracket-assignment on an ordinary {} would silently no-op here,
    // which is precisely the bug this reproduces the FIX for).
    const raw: Record<string, string> = Object.create(null)
    Object.assign(raw, VALID_RAW)
    raw['__proto__'] = 'anything'
    expect(Object.prototype.hasOwnProperty.call(raw, '__proto__')).toBe(true)

    const result = parseImportRowShape(raw, true)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')

    const rawAttributes = result.row.rawAttributes
    expect(rawAttributes).toBeDefined()
    expect(Object.prototype.hasOwnProperty.call(rawAttributes, '__proto__')).toBe(true)
    expect(rawAttributes?.['__proto__']).toBe('anything')
  })
})
