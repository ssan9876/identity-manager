import { authorizedRequest } from '../api/client'

/** Mirrors `JmlTrigger` in apps/api/src/jml/rule-engine.ts. */
export type JmlTrigger =
  | 'user_created'
  | 'user_attribute_changed'
  | 'start_date_reached'
  | 'end_date_reached'

export type JmlConditionOperator = 'equals' | 'not_equals' | 'in'
export type JmlActionType = 'set_attribute' | 'deactivate'

/** Mirrors `JmlRule` in apps/api/src/jml/jml-rules.repository.ts. */
export interface JmlRule {
  id: string
  name: string
  organizationId: string
  enabled: boolean
  trigger: JmlTrigger
  conditionField: string
  conditionOperator: JmlConditionOperator
  conditionValue: unknown
  action: JmlActionType
  actionParams: Record<string, unknown>
  simulatedAt: string | null
  createdAt: string
  updatedAt: string
}

/** Mirrors `SimulatedEffect` in apps/api/src/jml/rule-engine.ts. */
export interface SimulatedEffect {
  userId: string
  username: string
  wouldApply: boolean
  action: JmlActionType | null
  actionParams: Record<string, unknown> | null
  skipReason: string | null
}

/** Mirrors `JmlSimulationReport` in apps/api/src/jml/jml-rules.controller.ts. */
export interface JmlSimulationReport {
  ruleId: string
  scanned: number
  /** True when the directory is bigger than `scanned` — the counts are then a floor, not a total. */
  truncated: boolean
  wouldApplyCount: number
  effects: SimulatedEffect[]
}

export interface CreateJmlRuleInput {
  name: string
  trigger: JmlTrigger
  conditionField: string
  conditionOperator: JmlConditionOperator
  conditionValue: unknown
  action: JmlActionType
  actionParams?: Record<string, unknown>
}

/**
 * The condition fields the rule engine can actually resolve.
 *
 * A MIRROR OF A CLOSED SERVER VOCABULARY, on the same terms as
 * `ALL_ATTRIBUTE_FORMATS` in ../attributes/api.ts: the authority is
 * `CONDITION_FIELD_EXTRACTORS` in apps/api/src/jml/rule-engine.ts, and a
 * field missing from this list is not refused by the API — it resolves to
 * `found: false` and the rule silently never matches. So the cost of drift
 * here is a dropdown that omits a usable field, not a rule that breaks;
 * anything outside the list is still reachable through the attribute prefix
 * below.
 */
export const CONDITION_FIELDS: readonly string[] = ['status', 'orgUnitId', 'employeeId']

/** `attributes.<key>` reaches any custom attribute — see `resolveConditionField`. */
export const ATTRIBUTE_FIELD_PREFIX = 'attributes.'

export const ALL_TRIGGERS: readonly JmlTrigger[] = [
  'user_created',
  'user_attribute_changed',
  'start_date_reached',
  'end_date_reached',
]

export function fetchJmlRules(accessToken: string): Promise<JmlRule[]> {
  return authorizedRequest<JmlRule[]>('/jml-rules', accessToken)
}

export function createJmlRule(accessToken: string, input: CreateJmlRuleInput): Promise<JmlRule> {
  return authorizedRequest<JmlRule>('/jml-rules', accessToken, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

/**
 * Preview only — writes nothing, and deliberately does NOT unlock `enable`.
 * `acknowledgeSimulation` below is the separate, explicit act of saying a
 * human read this.
 */
export function simulateJmlRule(accessToken: string, id: string): Promise<JmlSimulationReport> {
  return authorizedRequest<JmlSimulationReport>(`/jml-rules/${id}/simulate`, accessToken, {
    method: 'POST',
  })
}

/**
 * `wouldApplyCount` is the number the reviewer was actually shown, sent back
 * so the audit row records what they were told — not what a later re-run
 * would say.
 */
export function acknowledgeJmlSimulation(
  accessToken: string,
  id: string,
  wouldApplyCount: number,
): Promise<JmlRule> {
  return authorizedRequest<JmlRule>(`/jml-rules/${id}/acknowledge-simulation`, accessToken, {
    method: 'POST',
    body: JSON.stringify({ wouldApplyCount }),
  })
}

export function setJmlRuleEnabled(
  accessToken: string,
  id: string,
  enabled: boolean,
): Promise<JmlRule> {
  return authorizedRequest<JmlRule>(`/jml-rules/${id}/${enabled ? 'enable' : 'disable'}`, accessToken, {
    method: 'POST',
  })
}
