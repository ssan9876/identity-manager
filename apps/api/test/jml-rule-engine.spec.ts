import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { User } from '../src/users/users.repository'
import type { JmlRule } from '../src/jml/jml-rules.repository'
import { evaluateRule, KNOWN_ACTION_NAMES, matchRules, simulate } from '../src/jml/rule-engine'

let ruleSeq = 0
function makeRule(overrides: Partial<JmlRule> = {}): JmlRule {
  ruleSeq += 1
  return {
    id: `rule-${ruleSeq}`,
    name: `Rule ${ruleSeq}`,
    // Task 5 of the organizations milestone put a tenant on every rule.
    // `matchRules` never reads it — tenant scoping happens one level up, in
    // JmlRulesRepository.listEnabledByTrigger — so any stable value serves
    // this pure-function suite.
    organizationId: 'org-fixture',
    enabled: true,
    trigger: 'user_attribute_changed',
    conditionField: 'jobTitle',
    conditionOperator: 'equals',
    conditionValue: 'Engineer',
    action: 'set_attribute',
    actionParams: { key: 'costCenter', value: 'CC-42' },
    simulatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

let userSeq = 0
function makeUser(overrides: Partial<User> = {}): User {
  userSeq += 1
  return {
    id: `user-${userSeq}`,
    status: 'active',
    primaryEmail: `user${userSeq}@example.com`,
    username: `user${userSeq}`,
    firstName: 'First',
    lastName: 'Last',
    displayName: 'First Last',
    employeeId: null,
    jobTitle: 'Engineer',
    orgUnitId: 'org-1',
    managerId: null,
    location: null,
    startDate: null,
    endDate: null,
    attributes: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    deactivatedAt: null,
    ...overrides,
  }
}

describe('rule-engine (Milestone 19, Task 16): the group actions are gone', () => {
  it('JML no longer grants group membership — business roles own desired state', () => {
    expect([...KNOWN_ACTION_NAMES].sort()).toEqual(['deactivate', 'set_attribute'])
  })

  /**
   * Postgres cannot `DROP VALUE` from an enum, so `jml_action` still carries
   * both removed labels and a stored row really can come back holding one.
   * The closed-set check is the ONLY thing rejecting it — hence the cast,
   * which reproduces that row shape rather than pretending it is impossible.
   *
   * It must be REJECTED with a reason naming the action, not silently treated
   * as "no match": a rule that stops firing without saying so is a permission
   * somebody still believes is being maintained. Migration
   * 0027_jml_group_actions_removed.sql refuses to run while such a row exists,
   * so this is the second of two guards, not the only one.
   */
  for (const action of ['add_to_group', 'remove_from_group'] as const) {
    it(`a stored rule naming "${action}" is rejected, not silently skipped`, () => {
      const rule = makeRule({ action: action as unknown as JmlRule['action'] })

      const result = evaluateRule(rule, makeUser({ jobTitle: 'Engineer' }))

      expect(result.matched).toBe(false)
      expect(result.skipReason).toBe('unknown_action')
    })
  }
})

describe('rule-engine (Milestone 7, Task 5): evaluateRule', () => {
  it('a matching rule yields its action', () => {
    const rule = makeRule({ conditionField: 'jobTitle', conditionOperator: 'equals', conditionValue: 'Engineer' })
    const user = makeUser({ jobTitle: 'Engineer' })

    const result = evaluateRule(rule, user)

    expect(result.matched).toBe(true)
    expect(result.action).toBe('set_attribute')
    expect(result.actionParams).toEqual(rule.actionParams)
    expect(result.skipReason).toBeNull()
  })

  it('a non-matching rule does not yield an action', () => {
    const rule = makeRule({ conditionField: 'jobTitle', conditionOperator: 'equals', conditionValue: 'Engineer' })
    const user = makeUser({ jobTitle: 'Manager' })

    const result = evaluateRule(rule, user)

    expect(result.matched).toBe(false)
    expect(result.action).toBeNull()
    expect(result.skipReason).toBe('condition_not_met')
  })

  it('not_equals matches when the field differs', () => {
    const rule = makeRule({ conditionField: 'jobTitle', conditionOperator: 'not_equals', conditionValue: 'Engineer' })
    expect(evaluateRule(rule, makeUser({ jobTitle: 'Manager' })).matched).toBe(true)
    expect(evaluateRule(rule, makeUser({ jobTitle: 'Engineer' })).matched).toBe(false)
  })

  it('in matches when the field is one of the listed values', () => {
    const rule = makeRule({
      conditionField: 'jobTitle',
      conditionOperator: 'in',
      conditionValue: ['Engineer', 'Manager'],
    })
    expect(evaluateRule(rule, makeUser({ jobTitle: 'Manager' })).matched).toBe(true)
    expect(evaluateRule(rule, makeUser({ jobTitle: 'Sales' })).matched).toBe(false)
  })

  it('in against a non-array conditionValue never matches (never throws)', () => {
    const rule = makeRule({ conditionField: 'jobTitle', conditionOperator: 'in', conditionValue: 'Engineer' })
    expect(evaluateRule(rule, makeUser({ jobTitle: 'Engineer' })).matched).toBe(false)
  })

  it('reads a custom attribute via the attributes.<key> form', () => {
    const rule = makeRule({ conditionField: 'attributes.department', conditionOperator: 'equals', conditionValue: 'R&D' })
    expect(evaluateRule(rule, makeUser({ attributes: { department: 'R&D' } })).matched).toBe(true)
    expect(evaluateRule(rule, makeUser({ attributes: { department: 'Sales' } })).matched).toBe(false)
  })

  it('an absent custom attribute resolves to undefined, not "unknown field"', () => {
    const rule = makeRule({ conditionField: 'attributes.department', conditionOperator: 'equals', conditionValue: 'R&D' })
    const result = evaluateRule(rule, makeUser({ attributes: {} }))
    expect(result.matched).toBe(false)
    expect(result.skipReason).toBe('condition_not_met')
  })

  it('an unrecognised conditionField fails closed (skipped, not crashed)', () => {
    const rule = makeRule({ conditionField: 'notARealColumn', conditionOperator: 'equals', conditionValue: 'x' })
    const result = evaluateRule(rule, makeUser())
    expect(result.matched).toBe(false)
    expect(result.skipReason).toBe('unknown_condition_field')
  })

  // Prototype-pollution guard: a conditionField shaped like an inherited
  // Object.prototype property name must never resolve to that inherited
  // value — see rule-engine.ts's CONDITION_FIELD_EXTRACTORS doc comment.
  it('a conditionField colliding with an inherited Object.prototype property fails closed rather than resolving to it', () => {
    const rule = makeRule({ conditionField: 'constructor', conditionOperator: 'equals', conditionValue: 'x' })
    const result = evaluateRule(rule, makeUser())
    expect(result.matched).toBe(false)
    expect(result.skipReason).toBe('unknown_condition_field')
  })

  it('an attributes.<key> collision with an inherited property fails closed too', () => {
    const rule = makeRule({ conditionField: 'attributes.constructor', conditionOperator: 'equals', conditionValue: 'x' })
    const result = evaluateRule(rule, makeUser({ attributes: {} }))
    expect(result.matched).toBe(false)
    // The FIELD is recognised (well-formed attributes.<key> shape); it is
    // simply absent on this user, so the failure mode is "condition not
    // met," never a crash and never the inherited Object function.
    expect(result.skipReason).toBe('condition_not_met')
  })

  it('an unrecognised conditionOperator fails closed (skipped, not crashed)', () => {
    const rule = makeRule({ conditionOperator: 'matches_regex' as JmlRule['conditionOperator'] })
    const result = evaluateRule(rule, makeUser())
    expect(result.matched).toBe(false)
    expect(result.skipReason).toBe('unknown_condition_operator')
  })

  it('an unknown action enum is skipped rather than crashing or applying something else', () => {
    const rule = makeRule({
      conditionField: 'jobTitle',
      conditionOperator: 'equals',
      conditionValue: 'Engineer',
      action: 'run_shell_command' as JmlRule['action'],
    })
    const result = evaluateRule(rule, makeUser({ jobTitle: 'Engineer' }))
    expect(result.matched).toBe(false)
    expect(result.action).toBeNull()
    expect(result.skipReason).toBe('unknown_action')
  })
})

describe('rule-engine: matchRules (given a user and a trigger, return the matching rules\' actions)', () => {
  it('returns the action for a matching, enabled rule on the requested trigger', () => {
    const rule = makeRule({
      trigger: 'user_attribute_changed',
      conditionField: 'jobTitle',
      conditionOperator: 'equals',
      conditionValue: 'Engineer',
      action: 'set_attribute',
    })
    const user = makeUser({ jobTitle: 'Engineer' })

    const matches = matchRules([rule], user, 'user_attribute_changed')

    expect(matches).toHaveLength(1)
    expect(matches[0]).toEqual({
      ruleId: rule.id,
      ruleName: rule.name,
      action: 'set_attribute',
      actionParams: rule.actionParams,
    })
  })

  it('a disabled rule never fires, even when its condition matches and the trigger is correct', () => {
    const rule = makeRule({ enabled: false, trigger: 'user_attribute_changed' })
    const user = makeUser({ jobTitle: 'Engineer' })

    expect(matchRules([rule], user, 'user_attribute_changed')).toEqual([])
  })

  it('a rule for a different trigger never fires for this call', () => {
    const rule = makeRule({ trigger: 'start_date_reached' })
    const user = makeUser({ jobTitle: 'Engineer' })

    expect(matchRules([rule], user, 'user_attribute_changed')).toEqual([])
  })

  it('a rule with an unrecognised trigger value fails closed rather than matching anything', () => {
    const rule = makeRule({ trigger: 'onboarding_wizard_step_3' as JmlRule['trigger'] })
    const user = makeUser({ jobTitle: 'Engineer' })

    expect(matchRules([rule], user, 'user_attribute_changed')).toEqual([])
  })

  it('an unknown action enum is skipped, never included in the returned matches', () => {
    const rule = makeRule({ action: 'run_shell_command' as JmlRule['action'] })
    const user = makeUser({ jobTitle: 'Engineer' })

    expect(matchRules([rule], user, 'user_attribute_changed')).toEqual([])
  })

  it('evaluates a mixed list of rules independently — only the genuinely matching ones are returned', () => {
    const matching = makeRule({ conditionValue: 'Engineer' })
    const nonMatching = makeRule({ conditionValue: 'Manager' })
    const disabled = makeRule({ enabled: false })
    const user = makeUser({ jobTitle: 'Engineer' })

    const matches = matchRules([matching, nonMatching, disabled], user, 'user_attribute_changed')

    expect(matches.map((m) => m.ruleId)).toEqual([matching.id])
  })
})

describe('rule-engine: simulate (Milestone 7, Task 6) — writes nothing, previews regardless of enabled', () => {
  it('previews what a rule WOULD do against each user, without touching `enabled` at all', () => {
    const rule = makeRule({
      enabled: false, // never simulated/enabled yet — simulate must still preview it
      conditionField: 'jobTitle',
      conditionOperator: 'equals',
      conditionValue: 'Engineer',
      action: 'set_attribute',
    })
    const matching = makeUser({ jobTitle: 'Engineer' })
    const nonMatching = makeUser({ jobTitle: 'Manager' })

    const effects = simulate(rule, [matching, nonMatching])

    expect(effects).toEqual([
      {
        userId: matching.id,
        username: matching.username,
        wouldApply: true,
        action: 'set_attribute',
        actionParams: rule.actionParams,
        skipReason: null,
      },
      {
        userId: nonMatching.id,
        username: nonMatching.username,
        wouldApply: false,
        action: null,
        actionParams: null,
        skipReason: 'condition_not_met',
      },
    ])
  })

  it('is a pure, synchronous function — it never returns a Promise', () => {
    const rule = makeRule()
    const result = simulate(rule, [makeUser()])
    expect(result).not.toBeInstanceOf(Promise)
  })

  it('reports an unknown action as a skip in the preview too, never a crash', () => {
    const rule = makeRule({ action: 'run_shell_command' as JmlRule['action'] })
    const user = makeUser({ jobTitle: 'Engineer' })

    const [effect] = simulate(rule, [user])

    expect(effect!.wouldApply).toBe(false)
    expect(effect!.skipReason).toBe('unknown_action')
  })
})

// =========================================================================
// Milestone 7, Task 5 / Definition of Done: "JML rules contain no expression
// language, no eval, no dynamic Function." Static source scan, not just a
// design intent — see this describe block's own assertions.
// =========================================================================
const JML_SRC_DIR = path.resolve(process.cwd(), 'src/jml')

function collectTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) return collectTsFiles(fullPath)
    return entry.name.endsWith('.ts') ? [fullPath] : []
  })
}

describe('JML rules are DATA, never code', () => {
  it('src/jml contains no eval(), no `new Function(...)`, and no bare Function(...) construction', () => {
    const files = collectTsFiles(JML_SRC_DIR)
    // Sanity check on the scan itself: if this list is ever empty the test
    // below would vacuously pass without checking anything.
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
