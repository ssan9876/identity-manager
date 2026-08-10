import { describe, expect, it } from 'vitest'
import { ValidationError } from '../src/common/errors'
import {
  applyColumnMapping,
  evaluateHrRun,
  mapFeedCsv,
  parseColumnMapping,
  serializeCsv,
} from '../src/hr/hr-feed'
import { parseCsv } from '../src/imports/csv'

/**
 * PURE HR feed logic — no database, no network. The mapping transform and
 * the commit gate are the two pieces of hr/hr-feed.ts every sync run passes
 * through; everything else (fetch, pipeline, persistence) is integration-
 * tested in hr-sync.spec.ts against real collaborators.
 */
describe('parseColumnMapping', () => {
  it('accepts a flat string->string mapping and returns it', () => {
    const mapping = parseColumnMapping({ EMP_ID: 'employeeId', EMAIL: 'primaryEmail' })
    expect(mapping.EMP_ID).toBe('employeeId')
    expect(mapping.EMAIL).toBe('primaryEmail')
  })

  it('rejects non-object shapes', () => {
    for (const bad of [null, [], 'x', 42]) {
      expect(() => parseColumnMapping(bad)).toThrow(ValidationError)
    }
  })

  it('rejects non-string and empty values with named issues', () => {
    try {
      parseColumnMapping({ A: 7, B: '' })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError)
      const issues = (error as ValidationError).issues
      expect(issues.some((issue) => issue.includes('columnMapping.A'))).toBe(true)
      expect(issues.some((issue) => issue.includes('columnMapping.B'))).toBe(true)
    }
  })

  it('rejects two source columns mapped onto the same target', () => {
    expect(() => parseColumnMapping({ A: 'employeeId', B: 'employeeId' })).toThrow(
      /duplicate target column "employeeId"/,
    )
  })

  // The recurring defect class this project documents in csv.ts,
  // import-row.ts and parseConfigPatch: a key literally named __proto__
  // must be VALIDATED AND KEPT (a CSV header can be named anything), never
  // silently dropped by ZodRecord and never allowed to touch
  // Object.prototype.
  it('keeps a genuine own __proto__ source column instead of silently dropping it', () => {
    const raw = JSON.parse('{"__proto__": "employeeId"}') as Record<string, unknown>
    const mapping = parseColumnMapping(raw)
    expect(Object.keys(mapping)).toEqual(['__proto__'])
    expect(mapping['__proto__']).toBe('employeeId')
    // And nothing leaked onto Object.prototype.
    expect(({} as Record<string, unknown>).employeeId).toBeUndefined()
  })
})

describe('applyColumnMapping / serializeCsv / mapFeedCsv', () => {
  const mapping = {
    EMP_ID: 'employeeId',
    WORK_EMAIL: 'primaryEmail',
    LOGIN: 'username',
    GIVEN: 'firstName',
    FAMILY: 'lastName',
    DEPT_UUID: 'orgUnitId',
  }

  it('renames mapped columns and DROPS unmapped ones', () => {
    const parsed = parseCsv(
      'EMP_ID,WORK_EMAIL,LOGIN,GIVEN,FAMILY,DEPT_UUID,SALARY\nE1,a@x.com,a,Ann,Ash,uuid-1,99000',
    )
    const mapped = applyColumnMapping(parsed, mapping)
    expect(mapped.headers).toEqual([
      'employeeId',
      'primaryEmail',
      'username',
      'firstName',
      'lastName',
      'orgUnitId',
    ])
    expect(mapped.rows).toHaveLength(1)
    expect(mapped.rows[0].employeeId).toBe('E1')
    // SALARY crossed no boundary — not under any name.
    expect(Object.values(mapped.rows[0])).not.toContain('99000')
  })

  it('rejects a mapped source column missing from the feed header as a whole-file error', () => {
    const parsed = parseCsv('EMP_ID,LOGIN\nE1,a')
    expect(() => applyColumnMapping(parsed, mapping)).toThrow(/missing from the feed header/)
  })

  it('round-trips quoting through serializeCsv -> parseCsv (commas, quotes, newlines)', () => {
    const headers = ['employeeId', 'firstName']
    const rows = [
      { employeeId: 'E1', firstName: 'Ann "The Comma", Jr.' },
      { employeeId: 'E2', firstName: 'Multi\nLine' },
    ]
    const text = serializeCsv(headers, rows)
    const back = parseCsv(text)
    expect(back.headers).toEqual(headers)
    expect(back.rows[0].firstName).toBe('Ann "The Comma", Jr.')
    expect(back.rows[1].firstName).toBe('Multi\nLine')
  })

  it('mapFeedCsv produces text the import pipeline parses with the mapped headers', () => {
    const csv = mapFeedCsv('EMP_ID,LOGIN\n"E,1",ann', { EMP_ID: 'employeeId', LOGIN: 'username' })
    const back = parseCsv(csv)
    expect(back.headers).toEqual(['employeeId', 'username'])
    expect(back.rows[0].employeeId).toBe('E,1')
  })
})

describe('evaluateHrRun (the commit gate)', () => {
  function preview(toCreate: number, toUpdate: number, failed: number) {
    return { summary: { toCreate, toUpdate, failed, total: toCreate + toUpdate + failed } }
  }
  const config = { blastRadiusThreshold: 20, blastRadiusFloor: 5 }

  it('any failing row aborts by default', () => {
    const decision = evaluateHrRun(preview(3, 0, 1), 100, config)
    expect(decision.abort).toBe('aborted_failures')
    expect(decision.reasons[0]).toMatch(/1 of 4 row\(s\) failed/)
  })

  it('allowPartial lets a run with failing rows proceed', () => {
    const decision = evaluateHrRun(preview(3, 0, 1), 100, config, { allowPartial: true })
    expect(decision.abort).toBeNull()
  })

  it('trips only when BOTH the percentage and the floor are exceeded — the reconcile guard, reused not copied', () => {
    // 30% of 100 (over 20%) and over floor 5 -> tripped.
    expect(evaluateHrRun(preview(0, 30, 0), 100, config).abort).toBe('aborted_blast_radius')
    // 30% of 10 is 3 updates — over the percentage, UNDER the floor -> proceeds.
    expect(evaluateHrRun(preview(0, 3, 0), 10, config).abort).toBeNull()
    // 6 of 100 — over the floor, UNDER the percentage -> proceeds.
    expect(evaluateHrRun(preview(0, 6, 0), 100, config).abort).toBeNull()
  })

  it('force overrides a tripped blast-radius guard', () => {
    const decision = evaluateHrRun(preview(0, 30, 0), 100, config, { force: true })
    expect(decision.abort).toBeNull()
    expect(decision.blastRadius.tripped).toBe(true)
  })

  it('creates do not count toward the blast radius', () => {
    const decision = evaluateHrRun(preview(500, 0, 0), 10, config)
    expect(decision.abort).toBeNull()
    expect(decision.blastRadius.changedCount).toBe(0)
  })

  it('failing rows are checked BEFORE the blast radius, so the reported abort names the first rail hit', () => {
    const decision = evaluateHrRun(preview(0, 30, 2), 100, config)
    expect(decision.abort).toBe('aborted_failures')
  })
})
