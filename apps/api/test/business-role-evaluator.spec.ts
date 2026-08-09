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

describe('in_org_subtree (Milestone 16, Task 5)', () => {
  function subtree(value: string): RoleCondition {
    return { field: 'orgUnitId', operator: 'in_org_subtree', value }
  }

  it('matches the named unit itself', () => {
    const user = makeUser({ orgUnitPath: 'acme.sales' })

    expect(matchesConditions([subtree('acme.sales')], user)).toEqual({ known: true, matched: true })
  })

  it('matches a descendant at any depth', () => {
    const user = makeUser({ orgUnitPath: 'acme.sales.emea.uk' })

    expect(matchesConditions([subtree('acme.sales')], user)).toEqual({ known: true, matched: true })
  })

  it('does not match a sibling', () => {
    const user = makeUser({ orgUnitPath: 'acme.marketing' })

    expect(matchesConditions([subtree('acme.sales')], user)).toEqual({ known: true, matched: false })
  })

  it('does not match on a shared label PREFIX — acme.sales is not an ancestor of acme.salesops', () => {
    // A naive startsWith() gets this wrong, and getting it wrong grants
    // Sales entitlements to a whole unrelated department.
    const user = makeUser({ orgUnitPath: 'acme.salesops.emea' })

    expect(matchesConditions([subtree('acme.sales')], user)).toEqual({ known: true, matched: false })
  })

  it('is unknown against a non-string value', () => {
    const user = makeUser({ orgUnitPath: 'acme.sales' })

    expect(matchesConditions([{ field: 'orgUnitId', operator: 'in_org_subtree', value: 42 }], user).known).toBe(
      false,
    )
  })

  it('is unknown on any field other than orgUnitId — the operator implies the path comparison', () => {
    const user = makeUser({ orgUnitPath: 'acme.sales' })

    expect(
      matchesConditions([{ field: 'jobTitle', operator: 'in_org_subtree', value: 'acme.sales' }], user).known,
    ).toBe(false)
  })
})

describe('custom attributes (Milestone 16, Task 5)', () => {
  it('reads attributes.<key> from the user attribute bag', () => {
    const user = makeUser({ attributes: { costCentre: 'CC-100' } })
    const conditions: RoleCondition[] = [{ field: 'attributes.costCentre', operator: 'equals', value: 'CC-100' }]

    expect(matchesConditions(conditions, user)).toEqual({ known: true, matched: true })
  })

  it('an absent attribute reads as null rather than being unknown', () => {
    // An attribute nobody has set yet is a legitimate, answerable state —
    // unlike a field name the code does not recognise at all.
    const user = makeUser({ attributes: {} })
    const conditions: RoleCondition[] = [{ field: 'attributes.costCentre', operator: 'equals', value: null }]

    expect(matchesConditions(conditions, user)).toEqual({ known: true, matched: true })
  })

  it('an attribute key colliding with an Object.prototype name reads as null, not an inherited value', () => {
    const user = makeUser({ attributes: {} })
    const conditions: RoleCondition[] = [
      { field: 'attributes.constructor', operator: 'equals', value: null },
    ]

    expect(matchesConditions(conditions, user)).toEqual({ known: true, matched: true })
  })

  it('a bare "attributes." with no key is unknown', () => {
    expect(matchesConditions([{ field: 'attributes.', operator: 'equals', value: null }], makeUser()).known).toBe(
      false,
    )
  })
})

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { type EvaluableRole, evaluateRoles } from '../src/business-roles/role-evaluator'

const NOW = new Date('2026-08-08T12:00:00.000Z')

let roleSeq = 0
function makeRole(overrides: Partial<EvaluableRole> = {}): EvaluableRole {
  roleSeq += 1
  return {
    id: `role-${roleSeq}`,
    name: `Role ${roleSeq}`,
    conditions: [{ field: 'jobTitle', operator: 'equals', value: 'Account Executive' }],
    grants: [{ kind: 'group_membership', groupId: `group-${roleSeq}`, target: null }],
    exceptions: [],
    ...overrides,
  }
}

describe('evaluateRoles (Milestone 16, Task 6)', () => {
  it('a matching role contributes its grants', () => {
    const role = makeRole({ grants: [{ kind: 'group_membership', groupId: 'g1', target: null }] })

    const result = evaluateRoles(makeUser({ jobTitle: 'Account Executive' }), [role], NOW)

    expect(result).toEqual({ evaluable: true, groupIds: ['g1'], targets: [], matchedRoleIds: [role.id] })
  })

  it('entitlements are the UNION of every role held, so one group granted twice appears once', () => {
    const a = makeRole({ grants: [{ kind: 'group_membership', groupId: 'shared', target: null }] })
    const b = makeRole({
      conditions: [{ field: 'location', operator: 'equals', value: 'London' }],
      grants: [{ kind: 'group_membership', groupId: 'shared', target: null }],
    })

    const result = evaluateRoles(makeUser({ jobTitle: 'Account Executive', location: 'London' }), [a, b], NOW)

    expect(result).toMatchObject({ evaluable: true, groupIds: ['shared'] })
    if (result.evaluable) expect(result.matchedRoleIds.sort()).toEqual([a.id, b.id].sort())
  })

  it('collects target-account grants separately from group grants', () => {
    const role = makeRole({
      grants: [
        { kind: 'group_membership', groupId: 'g1', target: null },
        { kind: 'target_account', groupId: null, target: 'keycloak' },
      ],
    })

    const result = evaluateRoles(makeUser(), [role], NOW)

    expect(result).toEqual({
      evaluable: true,
      groupIds: ['g1'],
      targets: ['keycloak'],
      matchedRoleIds: [role.id],
    })
  })

  it('a non-matching role contributes nothing', () => {
    const result = evaluateRoles(makeUser({ jobTitle: 'Manager' }), [makeRole()], NOW)

    expect(result).toEqual({ evaluable: true, groupIds: [], targets: [], matchedRoleIds: [] })
  })

  it('include grants membership regardless of the formula', () => {
    const user = makeUser({ jobTitle: 'Manager' })
    const role = makeRole({ exceptions: [{ userId: user.id, mode: 'include', expiresAt: null }] })

    const result = evaluateRoles(user, [role], NOW)

    expect(result).toMatchObject({ evaluable: true, matchedRoleIds: [role.id] })
  })

  it('exclude beats everything, including a formula that matches', () => {
    const user = makeUser({ jobTitle: 'Account Executive' })
    const role = makeRole({ exceptions: [{ userId: user.id, mode: 'exclude', expiresAt: null }] })

    const result = evaluateRoles(user, [role], NOW)

    expect(result).toEqual({ evaluable: true, groupIds: [], targets: [], matchedRoleIds: [] })
  })

  it('exclude beats include when both somehow exist for one person', () => {
    const user = makeUser({ jobTitle: 'Manager' })
    const role = makeRole({
      exceptions: [
        { userId: user.id, mode: 'include', expiresAt: null },
        { userId: user.id, mode: 'exclude', expiresAt: null },
      ],
    })

    expect(evaluateRoles(user, [role], NOW)).toMatchObject({ matchedRoleIds: [] })
  })

  it("an exception for somebody else does not affect this user", () => {
    const user = makeUser({ jobTitle: 'Account Executive' })
    const role = makeRole({ exceptions: [{ userId: 'someone-else', mode: 'exclude', expiresAt: null }] })

    expect(evaluateRoles(user, [role], NOW)).toMatchObject({ matchedRoleIds: [role.id] })
  })

  it('an EXPIRED exception is absent, not a denial — an expired exclude stops excluding', () => {
    const user = makeUser({ jobTitle: 'Account Executive' })
    const expired = new Date(NOW.getTime() - 1)
    const role = makeRole({ exceptions: [{ userId: user.id, mode: 'exclude', expiresAt: expired }] })

    expect(evaluateRoles(user, [role], NOW)).toMatchObject({ matchedRoleIds: [role.id] })
  })

  it('an expired include stops including', () => {
    const user = makeUser({ jobTitle: 'Manager' })
    const expired = new Date(NOW.getTime() - 1)
    const role = makeRole({ exceptions: [{ userId: user.id, mode: 'include', expiresAt: expired }] })

    expect(evaluateRoles(user, [role], NOW)).toMatchObject({ matchedRoleIds: [] })
  })

  it('an exception expiring exactly now is still live — expiry is exclusive at the boundary', () => {
    const user = makeUser({ jobTitle: 'Manager' })
    const role = makeRole({ exceptions: [{ userId: user.id, mode: 'include', expiresAt: NOW }] })

    expect(evaluateRoles(user, [role], NOW)).toMatchObject({ matchedRoleIds: [role.id] })
  })

  it('ONE unevaluable role makes the WHOLE evaluation unevaluable', () => {
    // Not "skip that role and carry on" — a partial desired set would be
    // acted on by the reconciler as if it were complete, revoking whatever
    // the broken role was justifying.
    const good = makeRole()
    const broken = makeRole({ conditions: [{ field: 'managerId', operator: 'equals', value: 'x' }] })

    const result = evaluateRoles(makeUser(), [good, broken], NOW)

    expect(result.evaluable).toBe(false)
    if (!result.evaluable) {
      expect(result.roleId).toBe(broken.id)
      expect(result.reason).toContain('managerId')
    }
  })

  it('no roles at all is evaluable and empty, not unevaluable', () => {
    expect(evaluateRoles(makeUser(), [], NOW)).toEqual({
      evaluable: true,
      groupIds: [],
      targets: [],
      matchedRoleIds: [],
    })
  })

  it('does not mutate the user or the roles it was given', () => {
    const user = makeUser()
    const role = makeRole()
    const userBefore = structuredClone(user)
    const roleBefore = structuredClone(role)

    evaluateRoles(user, [role], NOW)

    expect(user).toEqual(userBefore)
    expect(role).toEqual(roleBefore)
  })
})

function collectTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) return collectTsFiles(fullPath)
    return entry.name.endsWith('.ts') ? [fullPath] : []
  })
}

describe('business role formulas are DATA, never code', () => {
  it('src/business-roles contains no eval(), no `new Function(...)`, and no bare Function(...) construction', () => {
    const files = collectTsFiles(path.resolve(process.cwd(), 'src/business-roles'))
    // Sanity check on the scan itself: an empty list would pass vacuously.
    expect(files.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      if (/\beval\s*\(/.test(text) || /\bnew\s+Function\s*\(/.test(text) || /(?<!\w)Function\s*\(/.test(text)) {
        offenders.push(path.relative(process.cwd(), file))
      }
    }

    expect(offenders).toEqual([])
  })
})
