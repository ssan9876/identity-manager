import { describe, expect, it } from 'vitest'
import {
  CONDITION_FIELDS,
  type EvaluableUser,
  matchesConditions,
} from '../src/business-roles/role-evaluator'
import { parseDefinition } from '../src/business-roles/draft'
import {
  DEFAULT_MINING_PARAMS,
  type GroupMiningResult,
  type ManualMembership,
  mineRoles,
} from '../src/business-roles/role-miner'

let userSeq = 0
function makeUser(overrides: Partial<EvaluableUser> = {}): EvaluableUser {
  userSeq += 1
  return {
    id: `user-${String(userSeq).padStart(4, '0')}`,
    status: 'active',
    jobTitle: 'Account Executive',
    location: 'London',
    orgUnitId: 'unit-sales',
    orgUnitPath: 'acme.sales',
    attributes: {},
    ...overrides,
  }
}

function membership(groupId: string, users: readonly EvaluableUser[]): ManualMembership[] {
  return users.map((user) => ({ groupId, userId: user.id }))
}

describe('mineRoles — precision and coverage', () => {
  it('a perfectly attribute-aligned group yields a precision 1 / coverage 1 candidate', () => {
    const engineers = [
      makeUser({ jobTitle: 'Engineer' }),
      makeUser({ jobTitle: 'Engineer' }),
      makeUser({ jobTitle: 'Engineer' }),
    ]
    const others = [makeUser({ jobTitle: 'Designer' }), makeUser({ jobTitle: 'Designer' })]

    const results = mineRoles([...engineers, ...others], membership('g-eng', engineers))

    expect(results).toHaveLength(1)
    const [group] = results
    expect(group.groupId).toBe('g-eng')
    expect(group.memberCount).toBe(3)

    const best = group.candidates[0]
    expect(best.precision).toBe(1)
    expect(best.coverage).toBe(1)
    expect(best.cohortSize).toBe(3)
    expect(best.matchedCount).toBe(3)
    expect(best.gainedUserIds).toEqual([])
    expect(best.lostUserIds).toEqual([])
    expect(best.conditions).toEqual([{ field: 'jobTitle', operator: 'equals', value: 'Engineer' }])
  })

  it('computes the exact ratios and residual lists when the cohort and the group only partly overlap', () => {
    // 4 Engineers in the directory; the group holds 3 of them plus 1 Designer.
    const inBoth = [
      makeUser({ jobTitle: 'Engineer' }),
      makeUser({ jobTitle: 'Engineer' }),
      makeUser({ jobTitle: 'Engineer' }),
    ]
    const engineerOutside = makeUser({ jobTitle: 'Engineer' })
    const designerInside = makeUser({ jobTitle: 'Designer' })

    const results = mineRoles(
      [...inBoth, engineerOutside, designerInside],
      membership('g', [...inBoth, designerInside]),
      { minPrecision: 0.5, minCoverage: 0.5, maxCandidatesPerGroup: 10 },
    )

    const candidate = results[0].candidates.find(
      (c) => c.conditions.length === 1 && c.conditions[0].field === 'jobTitle' && c.conditions[0].value === 'Engineer',
    )
    expect(candidate).toBeDefined()
    // cohort = 4 engineers, matched = 3 of the 4 group members
    expect(candidate!.cohortSize).toBe(4)
    expect(candidate!.matchedCount).toBe(3)
    expect(candidate!.precision).toBe(3 / 4)
    expect(candidate!.coverage).toBe(3 / 4)
    expect(candidate!.gainedUserIds).toEqual([engineerOutside.id])
    expect(candidate!.lostUserIds).toEqual([designerInside.id])
  })

  it('recommends an in_org_subtree formula for a group aligned with a whole subtree', () => {
    const emea = [
      makeUser({ orgUnitId: 'u-emea', orgUnitPath: 'acme.sales.emea', jobTitle: 'AE' }),
      makeUser({ orgUnitId: 'u-emea-uk', orgUnitPath: 'acme.sales.emea.uk', jobTitle: 'SDR' }),
      makeUser({ orgUnitId: 'u-emea-de', orgUnitPath: 'acme.sales.emea.de', jobTitle: 'Manager' }),
    ]
    // Label-safe: this person must NOT fall under acme.sales.emea.
    const lookalike = makeUser({ orgUnitId: 'u-emeax', orgUnitPath: 'acme.sales.emeax', jobTitle: 'AE' })

    const results = mineRoles([...emea, lookalike], membership('g-emea', emea))

    const best = results[0].candidates[0]
    expect(best.conditions).toEqual([
      { field: 'orgUnitId', operator: 'in_org_subtree', value: 'acme.sales.emea' },
    ])
    expect(best.precision).toBe(1)
    expect(best.coverage).toBe(1)
  })
})

describe('mineRoles — thresholds', () => {
  // 10 members, 9 matched by the formula, cohort exactly 10 → tune the edges.
  function edgePopulation() {
    const matchedMembers = Array.from({ length: 9 }, () => makeUser({ jobTitle: 'Analyst' }))
    const unmatchedMember = makeUser({ jobTitle: 'Intern' })
    const nonMemberAnalyst = makeUser({ jobTitle: 'Analyst' })
    const filler = Array.from({ length: 5 }, () => makeUser({ jobTitle: 'Filler' }))
    return {
      users: [...matchedMembers, unmatchedMember, nonMemberAnalyst, ...filler],
      members: [...matchedMembers, unmatchedMember],
    }
  }

  it('a candidate exactly AT both thresholds is included (>=, not >)', () => {
    const { users, members } = edgePopulation()
    // Analyst cohort = 10, matched = 9: precision 0.9, coverage 0.9.
    const results = mineRoles(users, membership('g', members), {
      minPrecision: 0.9,
      minCoverage: 0.9,
      maxCandidatesPerGroup: 10,
    })
    const analyst = results[0]?.candidates.find((c) => c.conditions[0]?.value === 'Analyst')
    expect(analyst).toBeDefined()
    expect(analyst!.precision).toBe(0.9)
    expect(analyst!.coverage).toBe(0.9)
  })

  it('a candidate just below a threshold is excluded', () => {
    const { users, members } = edgePopulation()
    const above = mineRoles(users, membership('g', members), {
      minPrecision: 0.9,
      minCoverage: 0.91,
      maxCandidatesPerGroup: 10,
    })
    expect(above.flatMap((g) => g.candidates).find((c) => c.conditions[0]?.value === 'Analyst')).toBeUndefined()

    const abovePrecision = mineRoles(users, membership('g', members), {
      minPrecision: 0.91,
      minCoverage: 0.9,
      maxCandidatesPerGroup: 10,
    })
    expect(
      abovePrecision.flatMap((g) => g.candidates).find((c) => c.conditions[0]?.value === 'Analyst'),
    ).toBeUndefined()
  })

  it('rejects out-of-range parameters loudly', () => {
    expect(() => mineRoles([], [], { minPrecision: 1.2, minCoverage: 0.8, maxCandidatesPerGroup: 3 })).toThrow(
      RangeError,
    )
    expect(() => mineRoles([], [], { minPrecision: 0.9, minCoverage: Number.NaN, maxCandidatesPerGroup: 3 })).toThrow(
      RangeError,
    )
    expect(() => mineRoles([], [], { minPrecision: 0.9, minCoverage: 0.8, maxCandidatesPerGroup: 0 })).toThrow(
      RangeError,
    )
  })
})

describe('mineRoles — population discipline', () => {
  it('ignores membership edges naming users outside the provided population', () => {
    const engineers = [makeUser({ jobTitle: 'Engineer' }), makeUser({ jobTitle: 'Engineer' })]
    const results = mineRoles(
      [...engineers, makeUser({ jobTitle: 'Designer' })],
      [...membership('g', engineers), { groupId: 'g', userId: 'user-not-in-population' }],
    )
    // The ghost member neither drags coverage down nor appears in any list.
    expect(results[0].memberCount).toBe(2)
    expect(results[0].candidates[0].coverage).toBe(1)
  })

  it('skips groups with no manual members in the population, and returns nothing for an empty directory', () => {
    expect(mineRoles([], [{ groupId: 'g', userId: 'nobody' }])).toEqual([])
    expect(mineRoles([], [])).toEqual([])
  })

  it('never emits a zero-condition formula (which would match nobody) or a candidate with an empty cohort', () => {
    const users = [makeUser({ jobTitle: 'Solo' })]
    const results = mineRoles(users, membership('g', users), {
      minPrecision: 0,
      minCoverage: 0,
      maxCandidatesPerGroup: 50,
    })
    for (const group of results) {
      for (const candidate of group.candidates) {
        expect(candidate.conditions.length).toBeGreaterThanOrEqual(1)
        expect(candidate.cohortSize).toBeGreaterThan(0)
      }
    }
  })
})

describe('mineRoles — determinism', () => {
  it('is byte-for-byte identical under reversed and interleaved input orderings', () => {
    const engineers = Array.from({ length: 6 }, (_, i) =>
      makeUser({ jobTitle: 'Engineer', location: i % 2 === 0 ? 'Berlin' : 'London' }),
    )
    const sellers = Array.from({ length: 5 }, () => makeUser({ jobTitle: 'AE', location: 'London' }))
    const users = [...engineers, ...sellers]
    const edges = [...membership('g-eng', engineers), ...membership('g-sales', sellers)]

    const forward = mineRoles(users, edges)
    const reversed = mineRoles([...users].reverse(), [...edges].reverse())
    const shuffledEdges = [...edges].sort((a, b) => (a.userId < b.userId ? 1 : -1))
    const third = mineRoles([...users].sort(() => 0), shuffledEdges)

    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward))
    expect(JSON.stringify(third)).toBe(JSON.stringify(forward))
  })
})

/**
 * The round-trip property: EVERY emitted formula must be evaluable by the
 * evaluator, over every user, and must reproduce exactly the cohort the
 * miner scored. Seeded generator, not `Math.random()` — the miner itself is
 * clock-free and randomness-free, and so is this test.
 */
describe('mineRoles — vocabulary round-trip property', () => {
  function lcg(seed: number): () => number {
    let state = seed >>> 0
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 0x100000000
    }
  }

  const TITLES = ['Engineer', 'Designer', 'AE', 'SDR', 'Manager', null]
  const LOCATIONS = ['London', 'Berlin', 'Austin', null]
  const STATUSES = ['active', 'pending', 'deactivated'] as const
  const ORG_PATHS = ['acme', 'acme.sales', 'acme.sales.emea', 'acme.eng', 'acme.eng.platform']

  it('every emitted candidate parses as a draft definition and reproduces its own cohort through the evaluator', () => {
    for (let round = 0; round < 40; round += 1) {
      const random = lcg(round + 1)
      const pick = <T>(pool: readonly T[]): T => pool[Math.floor(random() * pool.length)]

      const users: EvaluableUser[] = Array.from({ length: 30 }, (_, i) => {
        const orgUnitPath = pick(ORG_PATHS)
        return {
          id: `r${round}-u${String(i).padStart(2, '0')}`,
          status: pick(STATUSES),
          jobTitle: pick(TITLES),
          location: pick(LOCATIONS),
          orgUnitId: `unit-${orgUnitPath}`,
          orgUnitPath,
          attributes: {},
        }
      })

      const edges: ManualMembership[] = []
      for (const groupId of ['g-a', 'g-b', 'g-c']) {
        for (const user of users) {
          if (random() < 0.3) edges.push({ groupId, userId: user.id })
        }
      }

      const results: GroupMiningResult[] = mineRoles(users, edges, {
        minPrecision: 0.5,
        minCoverage: 0.5,
        maxCandidatesPerGroup: 5,
      })

      const membersByGroup = new Map<string, Set<string>>()
      for (const edge of edges) {
        if (!membersByGroup.has(edge.groupId)) membersByGroup.set(edge.groupId, new Set())
        membersByGroup.get(edge.groupId)!.add(edge.userId)
      }

      for (const group of results) {
        const members = membersByGroup.get(group.groupId)!
        for (const candidate of group.candidates) {
          // (1) The draft path accepts it verbatim — the exact payload the
          // adopt endpoint hands to saveDraft.
          expect(() =>
            parseDefinition({
              conditions: candidate.conditions,
              grants: [{ kind: 'group_membership', groupId: group.groupId, target: null }],
            }),
          ).not.toThrow()

          // (2) Only the evaluator's own field allow-list is ever named.
          for (const condition of candidate.conditions) {
            expect(CONDITION_FIELDS).toContain(condition.field)
          }

          // (3) The evaluator reproduces the miner's exact cohort — known
          // for every user, matched for exactly the claimed people.
          const cohort = new Set<string>()
          for (const user of users) {
            const match = matchesConditions(candidate.conditions, user)
            expect(match.known).toBe(true)
            if (match.known && match.matched) cohort.add(user.id)
          }
          expect(cohort.size).toBe(candidate.cohortSize)

          const expectedGained = [...cohort].filter((id) => !members.has(id)).sort()
          const expectedLost = [...members].filter((id) => !cohort.has(id)).sort()
          expect(candidate.gainedUserIds).toEqual(expectedGained)
          expect(candidate.lostUserIds).toEqual(expectedLost)

          const matched = [...cohort].filter((id) => members.has(id)).length
          expect(candidate.matchedCount).toBe(matched)
          expect(candidate.precision).toBe(matched / cohort.size)
          expect(candidate.coverage).toBe(matched / members.size)
        }
      }
    }
  })

  it('default parameters are the documented 0.9 / 0.8', () => {
    expect(DEFAULT_MINING_PARAMS.minPrecision).toBe(0.9)
    expect(DEFAULT_MINING_PARAMS.minCoverage).toBe(0.8)
  })
})
