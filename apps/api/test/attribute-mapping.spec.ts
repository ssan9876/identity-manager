import { describe, expect, it } from 'vitest'
import {
  buildTargetAttributes,
  computeCoreFieldValues,
  type ResolvedTargetMapping,
} from '../src/connectors/attribute-mapping'

// ---------------------------------------------------------------------------
// Pure unit tests: both functions are free functions with no I/O — no
// Postgres, no container, milliseconds per case. These are the ALGORITHM
// proof; they do NOT by themselves prove the filter is wired into the real
// send path (see sync.worker.spec.ts's "default-deny per target" block for
// that — "a unit test on the filter would pass even if the filter were
// never wired into the send path" is exactly the failure class this file
// alone cannot rule out, which is why that other proof exists too).
// ---------------------------------------------------------------------------
describe('buildTargetAttributes (Milestone 10, Task 3 — per-target default-deny)', () => {
  it('emits a custom attribute under its REMOTE name, not its local key, when a mapping row exists', () => {
    const mappings: ResolvedTargetMapping[] = [
      { source: 'custom', localKey: 'department', remoteName: 'dept' },
    ]
    expect(buildTargetAttributes(mappings, { department: 'Engineering' }, {})).toEqual({
      dept: ['Engineering'],
    })
  })

  it('drops a custom attribute with NO mapping row at all (default-deny, not default-allow)', () => {
    const mappings: ResolvedTargetMapping[] = [
      { source: 'custom', localKey: 'department', remoteName: 'department' },
    ]
    expect(
      buildTargetAttributes(mappings, { department: 'Engineering', costCenter: 'CC-42' }, {}),
    ).toEqual({ department: ['Engineering'] })
  })

  it('returns an empty object when there are no mappings at all, regardless of what values are available', () => {
    expect(
      buildTargetAttributes([], { department: 'Engineering' }, { title: 'Staff Engineer' }),
    ).toEqual({})
  })

  it('emits a core field under its remote name when mapped, sourced from coreFieldValues not customAttributeValues', () => {
    const mappings: ResolvedTargetMapping[] = [
      { source: 'core', localKey: 'title', remoteName: 'jobTitle' },
    ]
    // Deliberately ALSO present under the same local key in the CUSTOM bag —
    // proves the two sources never cross-contaminate: a 'core' mapping must
    // read coreFieldValues.title, never customAttributeValues.title.
    expect(
      buildTargetAttributes(mappings, { title: 'wrong source' }, { title: 'Staff Engineer' }),
    ).toEqual({ jobTitle: ['Staff Engineer'] })
  })

  it('a custom attribute and a core field can coincidentally share the same LOCAL key without colliding', () => {
    // Mirrors this project's own long-standing test fixture (sync.worker.
    // spec.ts): an admin's custom attribute happens to be named "department",
    // independent of the CORE "department" (org-path-derived) field.
    const mappings: ResolvedTargetMapping[] = [
      { source: 'custom', localKey: 'department', remoteName: 'customDept' },
      { source: 'core', localKey: 'department', remoteName: 'coreDept' },
    ]
    expect(
      buildTargetAttributes(
        mappings,
        { department: 'Custom Value' },
        { department: 'Core Org Unit Name' },
      ),
    ).toEqual({ customDept: ['Custom Value'], coreDept: ['Core Org Unit Name'] })
  })

  it('drops null and undefined values instead of stringifying them, for both sources', () => {
    const mappings: ResolvedTargetMapping[] = [
      { source: 'custom', localKey: 'a', remoteName: 'a' },
      { source: 'core', localKey: 'b', remoteName: 'b' },
    ]
    expect(buildTargetAttributes(mappings, { a: null }, { b: undefined })).toEqual({})
  })

  it('stringifies a non-string scalar into a single-element array', () => {
    const mappings: ResolvedTargetMapping[] = [
      { source: 'custom', localKey: 'headcount', remoteName: 'headcount' },
    ]
    expect(buildTargetAttributes(mappings, { headcount: 42 }, {})).toEqual({ headcount: ['42'] })
  })

  it('stringifies each element of an array value', () => {
    const mappings: ResolvedTargetMapping[] = [{ source: 'custom', localKey: 'tags', remoteName: 'tags' }]
    expect(buildTargetAttributes(mappings, { tags: ['a', 1, false] }, {})).toEqual({
      tags: ['a', '1', 'false'],
    })
  })

  it('a mapping row with no corresponding value present is simply absent from the output, not an empty-string entry', () => {
    const mappings: ResolvedTargetMapping[] = [
      { source: 'custom', localKey: 'neverSet', remoteName: 'neverSet' },
    ]
    expect(buildTargetAttributes(mappings, {}, {})).toEqual({})
  })
})

describe('computeCoreFieldValues (Milestone 10, Task 3)', () => {
  it('maps given_name/surname/title directly off the user, and department off the org unit name', () => {
    const user = { firstName: 'Ada', lastName: 'Lovelace', jobTitle: 'Analyst' }
    const orgUnit = { name: 'Engineering' }
    expect(computeCoreFieldValues(user, orgUnit)).toEqual({
      given_name: 'Ada',
      surname: 'Lovelace',
      title: 'Analyst',
      department: 'Engineering',
    })
  })

  it('a null jobTitle and a null org unit both surface as null, never a crash or a stringified "null"', () => {
    const user = { firstName: 'Ada', lastName: 'Lovelace', jobTitle: null }
    expect(computeCoreFieldValues(user, null)).toEqual({
      given_name: 'Ada',
      surname: 'Lovelace',
      title: null,
      department: null,
    })
  })
})
