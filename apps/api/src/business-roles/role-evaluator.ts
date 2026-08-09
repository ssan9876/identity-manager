import type { ConnectorTarget } from '../connectors/connector'
import type { UserStatus } from '../users/users.repository'

/**
 * THE core safety property of this module, inherited verbatim from
 * `jml/rule-engine.ts`: conditions are DATA, never code. There is no
 * expression language here — no `eval`, no `new Function`, no template
 * interpolation of a condition's own fields into anything executable.
 * Matching is a CLOSED comparison (one of exactly four operators) over a
 * CLOSED set of nameable fields. An identity provider that runs
 * admin-supplied script against its own directory is a privilege-escalation
 * vector by construction — see test/business-role-evaluator.spec.ts's static
 * source scan, which asserts this directory contains none of the above.
 */

export type ConditionOperator = 'equals' | 'not_equals' | 'in' | 'in_org_subtree'

export interface RoleCondition {
  field: string
  operator: ConditionOperator
  value: unknown
}

export interface EvaluableUser {
  id: string
  status: UserStatus
  jobTitle: string | null
  location: string | null
  orgUnitId: string
  /** The ltree path of the user's org unit, e.g. `acme.sales.emea`. */
  orgUnitPath: string
  attributes: Record<string, unknown>
}

/**
 * Deliberately three-valued rather than a boolean.
 *
 * `{ known: false }` is NOT "did not match". A condition this code cannot
 * understand — an operator or field written by a migration newer than the
 * running binary — must not fail open (skip it, and grant access nobody
 * intended) and must not fail closed (treat the role as non-matching, and
 * silently STRIP access). It refuses to answer, and the reconciler then
 * refuses to act at all for that user: nothing granted, nothing revoked,
 * error surfaced. A user who looks healthy while something dead-lettered is
 * the worst outcome this product can produce, and an engine that quietly
 * removes access is that same failure wearing a different hat.
 */
export type ConditionMatch = { known: true; matched: boolean } | { known: false; reason: string }

/**
 * Why every "is this one of the known ones" check below reads
 * `Object.hasOwn(MAP, value)` against an `Object.create(null)` catalog rather
 * than a plain `{}` literal or a bare `MAP[value] !== undefined`: `field` and
 * `operator` are admin-authored DATA read back from Postgres, not values this
 * code minted. A plain object literal inherits `Object.prototype`, so a row
 * carrying `field: 'constructor'` or `operator: 'toString'` would resolve to a
 * real, truthy, non-nullish inherited value instead of `undefined` — defeating
 * a `?? fallback` and dispatching to something that was never one of the four
 * real operators. This is the same hazard `ROLE_PERMISSIONS`/`ROLE_RANK`
 * (`authz/actions.ts`) and `KNOWN_TRIGGERS`/`KNOWN_ACTIONS`
 * (`jml/rule-engine.ts`) were hardened against, for the same reason.
 */
function nullPrototypeMap<T>(entries: readonly (readonly [string, T])[]): Record<string, T> {
  const map = Object.create(null) as Record<string, T>
  for (const [key, value] of entries) {
    map[key] = value
  }
  return map
}

type FieldExtractor = (user: EvaluableUser) => unknown

/**
 * The allowlist. EXACTLY these, plus the open-ended `attributes.<key>` form
 * handled in `extractField` — and it must stay identical to the trigger list
 * in `RoleReconciler` (Milestone 17, Task 9). A field that can be named in a
 * formula but does not trigger re-evaluation when it changes is a mover whose
 * access silently fails to follow them, which is the exact failure this
 * sub-project exists to remove.
 *
 * Three fields are excluded on purpose. `managerId` immediately raises whether
 * "reports to X" means direct reports or the whole subtree, and the org-unit
 * hierarchy already answers the question people reach for it to ask.
 * `startDate` and `endDate` are inputs to JML state transitions, not standing
 * truths: a date that has passed should already have moved `status`, and
 * keying a formula off the raw date as well would put two disagreeing clocks
 * in the system.
 */
const CONDITION_FIELD_EXTRACTORS: Record<string, FieldExtractor> = nullPrototypeMap<FieldExtractor>([
  ['jobTitle', (user) => user.jobTitle],
  ['location', (user) => user.location],
  ['status', (user) => user.status],
  ['orgUnitId', (user) => user.orgUnitId],
])

/**
 * The user COLUMN behind the open-ended `attributes.<key>` condition form.
 * Named once, here, because two separate things are derived from it: the
 * `attributes.` prefix `extractField` matches on, and — through
 * `REEVALUATION_FIELDS` in role-reconciler.ts — the PATCH field whose change
 * must re-evaluate a user's roles (Milestone 17, Task 9). A literal
 * `'attributes.'` in one file and a literal `'attributes'` in the other could
 * drift apart silently; one constant cannot.
 */
export const ATTRIBUTES_FIELD = 'attributes'

const ATTRIBUTE_PREFIX = `${ATTRIBUTES_FIELD}.`

/**
 * Every scalar field nameable in a role condition, DERIVED from the extractor
 * table above rather than restated as a second literal list.
 *
 * Milestone 17, Task 9 depends on it being derived. `REEVALUATION_FIELDS`
 * (role-reconciler.ts) is built from this array, so the set of fields whose
 * change re-evaluates a user on write is structurally the same set a formula
 * can name. Adding an extractor above therefore cannot leave behind a field
 * that a role can key on but that never triggers re-evaluation — the mover
 * whose access silently fails to follow them, which is the exact failure this
 * sub-project exists to remove.
 *
 * `Object.keys` on a null-prototype map returns exactly the own keys inserted
 * above; frozen so no caller can mutate the evaluator's own notion of what is
 * nameable.
 */
export const CONDITION_FIELDS: readonly string[] = Object.freeze(Object.keys(CONDITION_FIELD_EXTRACTORS))

type FieldLookup = { known: true; value: unknown } | { known: false }

function extractField(field: string, user: EvaluableUser): FieldLookup {
  if (Object.hasOwn(CONDITION_FIELD_EXTRACTORS, field)) {
    return { known: true, value: CONDITION_FIELD_EXTRACTORS[field](user) }
  }

  if (field.startsWith(ATTRIBUTE_PREFIX)) {
    const key = field.slice(ATTRIBUTE_PREFIX.length)
    // Same null-prototype reasoning as above, applied to a value the admin
    // controls twice over (the key AND the stored attributes object).
    if (key.length === 0) return { known: false }
    return { known: true, value: Object.hasOwn(user.attributes, key) ? user.attributes[key] : null }
  }

  return { known: false }
}

/**
 * Scalar equality over jsonb-shaped values. `Object.is` rather than `===` so
 * `NaN` compares equal to itself; non-scalars never compare equal, because a
 * formula comparing against an object or array is not a comparison anyone
 * meant to write.
 */
function scalarEquals(left: unknown, right: unknown): boolean {
  if (left !== null && typeof left === 'object') return false
  if (right !== null && typeof right === 'object') return false
  return Object.is(left, right)
}

type Matcher = (fieldValue: unknown, conditionValue: unknown, user: EvaluableUser) => ConditionMatch

const KNOWN: (matched: boolean) => ConditionMatch = (matched) => ({ known: true, matched })

/**
 * ltree ancestry, done on labels rather than characters.
 *
 * A plain `path.startsWith(ancestor)` is WRONG and dangerously so:
 * `'acme.salesops.emea'.startsWith('acme.sales')` is true, which would hand
 * every Sales entitlement to an unrelated department. Ancestry requires the
 * next character after the prefix to be a label separator.
 */
function isAtOrBelow(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}.`)
}

const OPERATOR_MATCHERS: Record<string, Matcher> = nullPrototypeMap<Matcher>([
  ['equals', (fieldValue, conditionValue) => KNOWN(scalarEquals(fieldValue, conditionValue))],
  ['not_equals', (fieldValue, conditionValue) => KNOWN(!scalarEquals(fieldValue, conditionValue))],
  [
    'in',
    (fieldValue, conditionValue) => {
      if (!Array.isArray(conditionValue)) {
        return { known: false, reason: `operator "in" requires an array value` }
      }
      return KNOWN(conditionValue.some((candidate) => scalarEquals(fieldValue, candidate)))
    },
  ],
  [
    'in_org_subtree',
    (fieldValue, conditionValue, user) => {
      // The operator implies the comparison: it is only meaningful against
      // the org hierarchy, so naming any other field is a formula that does
      // not mean what its author thought it did. Refuse rather than guess.
      if (fieldValue !== user.orgUnitId) {
        return { known: false, reason: 'operator "in_org_subtree" applies only to orgUnitId' }
      }
      if (typeof conditionValue !== 'string' || conditionValue.length === 0) {
        return { known: false, reason: 'operator "in_org_subtree" requires a non-empty ltree path' }
      }
      return KNOWN(isAtOrBelow(user.orgUnitPath, conditionValue))
    },
  ],
])

/**
 * Every condition must match. A list with ZERO conditions matches NOBODY —
 * stated as its own early return rather than left to the fold below, which
 * would return the vacuous `true` and hand an unfinished role's entitlements
 * to the entire directory.
 *
 * The loop deliberately does NOT short-circuit on the first `matched: false`.
 * A list containing anything unevaluable is unevaluable regardless of the
 * order its conditions happen to be stored in — short-circuiting would let a
 * false hide an unknown, and the reconciler would then silently strip access.
 */
export function matchesConditions(
  conditions: readonly RoleCondition[],
  user: EvaluableUser,
): ConditionMatch {
  if (conditions.length === 0) {
    return { known: true, matched: false }
  }

  let matchedAll = true

  for (const condition of conditions) {
    if (!Object.hasOwn(OPERATOR_MATCHERS, condition.operator)) {
      return { known: false, reason: `unknown operator "${condition.operator}"` }
    }

    const lookup = extractField(condition.field, user)
    if (!lookup.known) {
      return { known: false, reason: `unknown field "${condition.field}"` }
    }

    const result = OPERATOR_MATCHERS[condition.operator](lookup.value, condition.value, user)
    if (!result.known) return result
    if (!result.matched) matchedAll = false
  }

  return KNOWN(matchedAll)
}

export interface RoleGrant {
  kind: 'group_membership' | 'target_account'
  groupId: string | null
  target: ConnectorTarget | null
}

export interface RoleException {
  userId: string
  mode: 'include' | 'exclude'
  expiresAt: Date | null
}

export interface EvaluableRole {
  id: string
  name: string
  conditions: RoleCondition[]
  grants: RoleGrant[]
  exceptions: RoleException[]
}

export type Evaluation =
  | { evaluable: true; groupIds: string[]; targets: ConnectorTarget[]; matchedRoleIds: string[] }
  | { evaluable: false; roleId: string; roleName: string; reason: string }

/**
 * An exception is live until its expiry has PASSED. `expiresAt === now` is
 * still live — expiry is exclusive at the boundary, so an exception written
 * "until 5pm" covers 5pm exactly.
 */
function isLive(exception: RoleException, now: Date): boolean {
  return exception.expiresAt === null || exception.expiresAt.getTime() >= now.getTime()
}

/**
 * Precedence, in order: `exclude` beats everything, then `include` grants
 * regardless of the formula, then the formula decides. An EXPIRED exception is
 * treated as ABSENT, never as a denial — an expired `exclude` stops excluding
 * and an expired `include` stops including.
 */
function holdsRole(role: EvaluableRole, user: EvaluableUser, now: Date): ConditionMatch {
  let included = false

  for (const exception of role.exceptions) {
    if (exception.userId !== user.id || !isLive(exception, now)) continue
    if (exception.mode === 'exclude') return { known: true, matched: false }
    included = true
  }

  if (included) return { known: true, matched: true }

  return matchesConditions(role.conditions, user)
}

/**
 * A person's entitlements are the UNION of every role they hold.
 *
 * ONE unevaluable role makes the WHOLE evaluation unevaluable, rather than
 * being skipped. A partial desired set is worse than no answer: the reconciler
 * would act on it as though it were complete and revoke whatever the broken
 * role was justifying. Refusing wholesale is what keeps "nothing granted,
 * nothing revoked, error surfaced" true.
 */
export function evaluateRoles(
  user: EvaluableUser,
  roles: readonly EvaluableRole[],
  now: Date,
): Evaluation {
  const groupIds = new Set<string>()
  const targets = new Set<ConnectorTarget>()
  const matchedRoleIds: string[] = []

  for (const role of roles) {
    const held = holdsRole(role, user, now)
    if (!held.known) {
      return { evaluable: false, roleId: role.id, roleName: role.name, reason: held.reason }
    }
    if (!held.matched) continue

    matchedRoleIds.push(role.id)
    for (const grant of role.grants) {
      if (grant.kind === 'group_membership' && grant.groupId !== null) groupIds.add(grant.groupId)
      if (grant.kind === 'target_account' && grant.target !== null) targets.add(grant.target)
    }
  }

  return {
    evaluable: true,
    groupIds: [...groupIds],
    targets: [...targets],
    matchedRoleIds,
  }
}
