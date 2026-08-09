import { describe, expect, it } from 'vitest'
import { type EvaluableUser, type RoleCondition, matchesConditions } from '../src/business-roles/role-evaluator'

let userSeq = 0
function makeUser(overrides: Partial<EvaluableUser> = {}): EvaluableUser {
  userSeq += 1
  return {
    id: `user-${userSeq}`,
    status: 'active',
    jobTitle: 'Account Executive',
    location: 'London',
    orgUnitId: `unit-${userSeq}`,
    orgUnitPath: 'acme.sales.emea',
    attributes: {},
    ...overrides,
  }
}

function condition(overrides: Partial<RoleCondition> = {}): RoleCondition {
  return { field: 'jobTitle', operator: 'equals', value: 'Account Executive', ...overrides }
}

describe('matchesConditions (Milestone 16, Task 4)', () => {
  it('a role with ZERO conditions matches NOBODY', () => {
    // The single most dangerous default in this design. A naive
    // "every condition must match" fold over an empty list returns true,
    // which would grant an unfinished role's entitlements to the entire
    // directory the moment it was enabled.
    const result = matchesConditions([], makeUser())

    expect(result).toEqual({ known: true, matched: false })
  })

  it('equals matches and not_equals inverts it', () => {
    const user = makeUser({ jobTitle: 'Account Executive' })

    expect(matchesConditions([condition()], user)).toEqual({ known: true, matched: true })
    expect(matchesConditions([condition({ operator: 'not_equals' })], user)).toEqual({
      known: true,
      matched: false,
    })
  })

  it('equals compares against the JSON literal null', () => {
    const user = makeUser({ jobTitle: null })

    expect(matchesConditions([condition({ value: null })], user)).toEqual({ known: true, matched: true })
  })

  it('in gives OR within a single field', () => {
    const conditions = [condition({ operator: 'in', value: ['Account Executive', 'SDR'] })]

    expect(matchesConditions(conditions, makeUser({ jobTitle: 'SDR' }))).toEqual({ known: true, matched: true })
    expect(matchesConditions(conditions, makeUser({ jobTitle: 'Manager' }))).toEqual({
      known: true,
      matched: false,
    })
  })

  it('in against a non-array value is unknown, not silently false', () => {
    const result = matchesConditions([condition({ operator: 'in', value: 'Account Executive' })], makeUser())

    expect(result.known).toBe(false)
  })

  it('every condition must match — the list is an AND', () => {
    const conditions = [condition(), condition({ field: 'location', value: 'Berlin' })]

    expect(matchesConditions(conditions, makeUser({ location: 'London' }))).toEqual({
      known: true,
      matched: false,
    })
    expect(matchesConditions(conditions, makeUser({ location: 'Berlin' }))).toEqual({
      known: true,
      matched: true,
    })
  })

  it('status is evaluable, so a deactivated person falls out of every role', () => {
    const conditions = [condition({ field: 'status', value: 'active' })]

    expect(matchesConditions(conditions, makeUser({ status: 'deactivated' }))).toEqual({
      known: true,
      matched: false,
    })
  })

  it('an unknown FIELD is unknown — it neither grants nor strips', () => {
    const result = matchesConditions([condition({ field: 'managerId' })], makeUser())

    expect(result.known).toBe(false)
    if (!result.known) expect(result.reason).toContain('managerId')
  })

  it('an unknown OPERATOR is unknown', () => {
    const result = matchesConditions(
      [condition({ operator: 'matches_regex' as RoleCondition['operator'] })],
      makeUser(),
    )

    expect(result.known).toBe(false)
  })

  it('a field colliding with an Object.prototype name is unknown, not an inherited value', () => {
    for (const field of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(matchesConditions([condition({ field })], makeUser()).known).toBe(false)
    }
  })

  it('an operator colliding with an Object.prototype name is unknown', () => {
    for (const operator of ['constructor', 'toString', '__proto__']) {
      const result = matchesConditions(
        [condition({ operator: operator as RoleCondition['operator'] })],
        makeUser(),
      )
      expect(result.known).toBe(false)
    }
  })

  it('one unknown condition makes the whole list unknown, even when another already failed', () => {
    // Order must not decide the answer: a list that contains anything
    // unevaluable is unevaluable, full stop. Short-circuiting on the first
    // FALSE would let a "matched: false" hide a condition the code cannot
    // understand, and the reconciler would then silently strip access.
    const conditions = [condition({ value: 'Nobody' }), condition({ field: 'managerId' })]

    expect(matchesConditions(conditions, makeUser()).known).toBe(false)
  })
})
