import type { User } from '../users/users.repository'
import type { JmlRule } from './jml-rules.repository'

/**
 * THE core safety property of this whole module: rules are DATA, never code.
 * There is no expression language anywhere below — no `eval`, no `new
 * Function`, no template interpolation of a rule's own fields into anything
 * executable. Condition matching is a CLOSED comparison (one of exactly
 * three operators) over a CLOSED set of nameable fields (see
 * CONDITION_FIELD_EXTRACTORS), and actions are a CLOSED enum (see
 * rule-applier.ts's dispatch map). An identity provider that runs
 * user-supplied script against its own user directory is a
 * privilege-escalation vector by construction — see
 * test/jml-rule-engine.spec.ts's static source scan, which asserts this file
 * (and the rest of src/jml) contains none of the above.
 */

export type JmlTrigger =
  | 'user_created'
  | 'user_attribute_changed'
  | 'start_date_reached'
  | 'end_date_reached'

export type JmlConditionOperator = 'equals' | 'not_equals' | 'in'

/**
 * Milestone 19, Task 16. `add_to_group`/`remove_from_group` are GONE: business
 * roles own desired group membership now (the reconciler runs on every user
 * write — Task 9 — and sweeps every user — Task 10), so a JML rule granting a
 * membership would be a second, competing writer that the reconciler would
 * simply revoke on its next pass.
 *
 * The `jml_action` POSTGRES ENUM keeps both labels, because Postgres cannot
 * `DROP VALUE`. So a stored row can still carry one, and the closed-set check
 * below is the only thing that rejects it — which is precisely the hazard
 * `closedSet`'s `Object.create(null)` catalog exists for. Migration
 * 0027_jml_group_actions_removed.sql refuses to run while any such row
 * survives, so this cannot strand a rule silently.
 */
export type JmlActionType = 'set_attribute' | 'deactivate'

/**
 * Why every "is this value one of the known ones" check below reads
 * `Object.hasOwn(MAP, value)` against a `Object.create(null)`-based catalog,
 * rather than a plain `{}` literal or a bare `MAP[value] !== undefined`
 * check: `trigger`/`conditionOperator`/`action` are admin/system-authored
 * DATA read back from Postgres columns, not values this code minted itself.
 * A plain object literal inherits `Object.prototype`, so a row carrying (for
 * instance) `action: 'constructor'` or `action: 'toString'` would make
 * `MAP[value]` resolve to a real, truthy, non-nullish inherited value instead
 * of `undefined` — defeating a `?? fallback` and getting "dispatched" to
 * something that was never one of the four real actions. This is the exact
 * hazard `ROLE_PERMISSIONS`/`ROLE_RANK` in `src/authz/actions.ts` were hardened
 * against (see that file's doc comment) — a Postgres enum column can hold any
 * label a migration ever added, past or future, so the same defence applies
 * here for the same reason. `Object.create(null)` removes the hazard at its
 * source: every lookup on a colliding key is genuinely `undefined`.
 */
function closedSet<T extends string>(values: readonly T[]): Record<T, true> {
  const set = Object.create(null) as Record<T, true>
  for (const value of values) {
    set[value] = true
  }
  return set
}

const KNOWN_TRIGGERS = closedSet<JmlTrigger>([
  'user_created',
  'user_attribute_changed',
  'start_date_reached',
  'end_date_reached',
])

/**
 * Exported so a test can assert the set has actually narrowed. Reading it back
 * from `KNOWN_ACTIONS` rather than re-listing the names means the assertion
 * cannot drift from the catalog it is checking.
 */
export const KNOWN_ACTION_NAMES: readonly JmlActionType[] = ['set_attribute', 'deactivate']

const KNOWN_ACTIONS = closedSet<JmlActionType>(KNOWN_ACTION_NAMES)

type FieldExtractor = (user: User) => unknown

/**
 * The CLOSED set of top-level `users` fields a rule's `conditionField` may
 * name, plus the `attributes.<key>` form handled separately below (see
 * `resolveConditionField`). Never a raw `user[conditionField]` bracket access
 * on `user` itself — `conditionField` is a DB-sourced string (admin-authored
 * data, not code, but still untrusted input from this code's point of view),
 * and `user` is an ordinary object inheriting `Object.prototype`, so a row
 * shaped like `conditionField: "constructor"` would otherwise resolve to a
 * real, inherited, non-nullish value instead of "field not found" — the
 * identical hazard `closedSet` above (and `ROLE_PERMISSIONS`) exists to
 * avoid, just arriving via a different column. Built the same way, for the
 * same reason: `Object.create(null)` + `Object.hasOwn` before ever indexing.
 */
const CONDITION_FIELD_EXTRACTORS: Record<string, FieldExtractor> = Object.assign(
  Object.create(null) as Record<string, FieldExtractor>,
  {
    status: (user: User) => user.status,
    orgUnitId: (user: User) => user.orgUnitId,
    employeeId: (user: User) => user.employeeId,
    jobTitle: (user: User) => user.jobTitle,
    managerId: (user: User) => user.managerId,
    location: (user: User) => user.location,
    startDate: (user: User) => user.startDate,
    endDate: (user: User) => user.endDate,
    primaryEmail: (user: User) => user.primaryEmail,
    username: (user: User) => user.username,
    firstName: (user: User) => user.firstName,
    lastName: (user: User) => user.lastName,
  } satisfies Record<string, FieldExtractor>,
)

const ATTRIBUTE_FIELD_PREFIX = 'attributes.'

type FieldResolution = { found: true; value: unknown } | { found: false }

/**
 * Resolves `conditionField` against `user`, in exactly one of two closed
 * forms — never an arbitrary property path:
 *  1. One of CONDITION_FIELD_EXTRACTORS's fixed keys (a top-level column).
 *  2. `attributes.<key>`, read via `Object.hasOwn(user.attributes, key)` —
 *     never `user.attributes[key]` unguarded — so a key colliding with an
 *     inherited `Object.prototype` property (e.g. `attributes.constructor`)
 *     can never resolve to anything either. A well-formed `attributes.<key>`
 *     name whose key is simply absent on THIS user is a real "no value," not
 *     a fail-closed rejection — it resolves to `{ found: true, value:
 *     undefined }`, which `equals`/`not_equals`/`in` can compare normally.
 *
 * Anything else — a field name matching neither form — resolves to
 * `{ found: false }`, and every caller below treats that as "skip this rule,
 * fail closed," never as a crash and never as a silent `undefined`-equals-
 * `undefined` false match.
 */
function resolveConditionField(user: User, conditionField: string): FieldResolution {
  if (Object.hasOwn(CONDITION_FIELD_EXTRACTORS, conditionField)) {
    return { found: true, value: CONDITION_FIELD_EXTRACTORS[conditionField]!(user) }
  }

  if (conditionField.startsWith(ATTRIBUTE_FIELD_PREFIX)) {
    const key = conditionField.slice(ATTRIBUTE_FIELD_PREFIX.length)
    if (key.length === 0) {
      return { found: false }
    }
    const value = Object.hasOwn(user.attributes, key) ? user.attributes[key] : undefined
    return { found: true, value }
  }

  return { found: false }
}

type OperatorEvaluator = (actual: unknown, expected: unknown) => boolean

/** Strict, uncoerced equality — deliberately not `==`, not a deep-equal library. A closed comparison stays simple by construction. */
function scalarEquals(a: unknown, b: unknown): boolean {
  return a === b
}

const OPERATOR_EVALUATORS: Record<JmlConditionOperator, OperatorEvaluator> = Object.assign(
  Object.create(null) as Record<JmlConditionOperator, OperatorEvaluator>,
  {
    equals: (actual, expected) => scalarEquals(actual, expected),
    not_equals: (actual, expected) => !scalarEquals(actual, expected),
    in: (actual, expected) =>
      Array.isArray(expected) && expected.some((candidate) => scalarEquals(actual, candidate)),
  } satisfies Record<JmlConditionOperator, OperatorEvaluator>,
)

export type JmlSkipReason =
  | 'disabled'
  | 'unknown_trigger'
  | 'trigger_mismatch'
  | 'unknown_condition_field'
  | 'unknown_condition_operator'
  | 'condition_not_met'
  | 'unknown_action'

export interface RuleEvaluation {
  matched: boolean
  action: JmlActionType | null
  actionParams: Record<string, unknown> | null
  skipReason: JmlSkipReason | null
}

function logSkippedRule(rule: JmlRule, reason: JmlSkipReason): void {
  console.warn(`[jml] rule ${rule.id} ("${rule.name}") skipped — ${reason}`)
}

/**
 * Evaluates ONE rule's condition + action against ONE user, independent of
 * `rule.enabled` and independent of trigger matching — both of those are the
 * CALLER's responsibility (see `matchRules` below, which checks both; `simulate`
 * deliberately does not, since previewing an as-yet-disabled rule is the
 * entire point of simulation). This is the single place condition matching
 * and the "is this action even one we know how to apply" fail-closed check
 * both happen, so `matchRules` and `simulate` can never disagree about what
 * "matches" means.
 */
export function evaluateRule(rule: JmlRule, user: User): RuleEvaluation {
  const noMatch = (skipReason: JmlSkipReason): RuleEvaluation => ({
    matched: false,
    action: null,
    actionParams: null,
    skipReason,
  })

  if (!Object.hasOwn(OPERATOR_EVALUATORS, rule.conditionOperator)) {
    logSkippedRule(rule, 'unknown_condition_operator')
    return noMatch('unknown_condition_operator')
  }

  const field = resolveConditionField(user, rule.conditionField)
  if (!field.found) {
    logSkippedRule(rule, 'unknown_condition_field')
    return noMatch('unknown_condition_field')
  }

  const evaluator = OPERATOR_EVALUATORS[rule.conditionOperator as JmlConditionOperator]
  if (!evaluator(field.value, rule.conditionValue)) {
    return noMatch('condition_not_met')
  }

  if (!Object.hasOwn(KNOWN_ACTIONS, rule.action)) {
    logSkippedRule(rule, 'unknown_action')
    return noMatch('unknown_action')
  }

  return {
    matched: true,
    action: rule.action as JmlActionType,
    actionParams: rule.actionParams,
    skipReason: null,
  }
}

export interface MatchedRuleAction {
  ruleId: string
  ruleName: string
  action: JmlActionType
  actionParams: Record<string, unknown>
}

/**
 * Given a user and a trigger, returns the matching (enabled) rules' actions
 * — Milestone 7, Task 5's core contract. Three independent fail-closed gates,
 * all enforced HERE so no caller can accidentally skip one:
 *   1. `rule.enabled` — a disabled rule never fires, full stop.
 *   2. `rule.trigger` — an unrecognised trigger value is skipped and logged
 *      (never crashes); a recognised-but-different trigger is silently
 *      skipped (the ordinary "not this rule's turn" case).
 *   3. `evaluateRule`'s own operator/field/action checks (see its doc
 *      comment) — an unknown operator, field, or action is skipped and
 *      logged, never applied and never crashed on.
 */
export function matchRules(
  rules: readonly JmlRule[],
  user: User,
  trigger: JmlTrigger,
): MatchedRuleAction[] {
  const matches: MatchedRuleAction[] = []

  for (const rule of rules) {
    if (!rule.enabled) {
      continue
    }
    if (!Object.hasOwn(KNOWN_TRIGGERS, rule.trigger)) {
      logSkippedRule(rule, 'unknown_trigger')
      continue
    }
    if (rule.trigger !== trigger) {
      continue
    }

    const evaluation = evaluateRule(rule, user)
    if (evaluation.matched) {
      matches.push({
        ruleId: rule.id,
        ruleName: rule.name,
        action: evaluation.action!,
        actionParams: evaluation.actionParams!,
      })
    }
  }

  return matches
}

export interface SimulatedEffect {
  userId: string
  username: string
  wouldApply: boolean
  action: JmlActionType | null
  actionParams: Record<string, unknown> | null
  skipReason: JmlSkipReason | null
}

/**
 * `simulate(rule, users)` — Milestone 7, Task 6. Returns EXACTLY what would
 * happen for each of `users` if `rule` fired, WRITING NOTHING: this function
 * touches no database handle, no repository, nothing outside its own two
 * arguments — there is no `this.db` anywhere in this module to accidentally
 * reach for. That is what makes "assert user, audit and outbox counts
 * unchanged after a simulate" trivially true regardless of how many users are
 * passed in or how many times it is called.
 *
 * Deliberately evaluates the condition/action WITHOUT checking `rule.enabled`
 * — unlike `matchRules` above. Simulating an as-yet-DISABLED rule (which
 * every rule is, until JmlRulesRepository.setEnabled is called — see its doc
 * comment) is the entire point: a caller previews "if this rule were live,
 * what would happen," which must not collapse to "nothing, it's off" just
 * because it is, in fact, currently off. `matchRules`, by contrast, is LIVE
 * evaluation against real, currently-enabled rules, where `enabled` must
 * gate everything.
 */
export function simulate(rule: JmlRule, users: readonly User[]): SimulatedEffect[] {
  return users.map((user) => {
    const evaluation = evaluateRule(rule, user)
    return {
      userId: user.id,
      username: user.username,
      wouldApply: evaluation.matched,
      action: evaluation.action,
      actionParams: evaluation.actionParams,
      skipReason: evaluation.skipReason,
    }
  })
}
