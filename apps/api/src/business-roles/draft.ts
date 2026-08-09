import { createHash } from 'node:crypto'
import { ALL_CONNECTOR_TARGETS, type ConnectorTarget } from '../connectors/connector'
import { ValidationError } from '../common/errors'
import { containsNulChar } from '../common/http/safe-string'
import type { ConditionOperator, RoleCondition, RoleGrant } from './role-evaluator'

export interface RoleDefinition {
  conditions: RoleCondition[]
  grants: RoleGrant[]
}

const OPERATORS: readonly ConditionOperator[] = ['equals', 'not_equals', 'in', 'in_org_subtree']
const MAX_CONDITIONS = 32
const MAX_GRANTS = 64

/**
 * A condition's `value` is free-form JSON on its way to a `jsonb` column, so
 * a NUL can hide at any depth under any key -- and a JSON-escaped NUL sails
 * through `JSON.parse` and every Zod string check, only failing at the `pg`
 * driver as a raw non-`DomainError` that Nest returns as an unmapped 500
 * (finding INJ-H-1/INJ-H-2, docs/archive/audits/audit-injection.md). The scan
 * lives HERE rather than in the controller because `parseDefinition` is the
 * one funnel BOTH the draft write and the publish copy-down pass through: a
 * draft accepted today is re-parsed on publish, so guarding only the HTTP
 * boundary would leave the copy-down able to fail the same way.
 *
 * Keys are walked with `Object.keys` over the value's OWN properties only,
 * and nothing here assigns into a fresh object, so a key literally named
 * `__proto__` is inspected as ordinary data rather than silently dropped the
 * way `z.record(...)` drops it (finding INJ-H-1) -- which is also why no part
 * of this file uses `z.record`.
 */
function assertNoNulChar(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (containsNulChar(value)) throw new ValidationError([`${path} must not contain a NUL character`])
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoNulChar(entry, `${path}[${index}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (containsNulChar(key)) throw new ValidationError([`${path} has a key containing a NUL character`])
      assertNoNulChar((value as Record<string, unknown>)[key], `${path}.${key}`)
    }
  }
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError([`${what} must be an object`])
  }
  return value as Record<string, unknown>
}

/**
 * Validates an admin-authored draft into the shape the evaluator and the
 * published child tables both accept. Everything downstream — the hash, the
 * simulation, the publish — depends on this having actually checked, so it
 * throws rather than coercing.
 *
 * The caps are not arbitrary: a draft is admin-supplied and gets hashed,
 * stored and evaluated per user on every write, so an unbounded list is a
 * cheap way to make every user write expensive.
 */
export function parseDefinition(input: unknown): RoleDefinition {
  const raw = asRecord(input, 'definition')

  const rawConditions = raw.conditions
  const rawGrants = raw.grants
  if (!Array.isArray(rawConditions)) throw new ValidationError(['definition.conditions must be an array'])
  if (!Array.isArray(rawGrants)) throw new ValidationError(['definition.grants must be an array'])
  if (rawConditions.length > MAX_CONDITIONS) throw new ValidationError([`at most ${MAX_CONDITIONS} conditions`])
  if (rawGrants.length > MAX_GRANTS) throw new ValidationError([`at most ${MAX_GRANTS} grants`])

  const conditions: RoleCondition[] = rawConditions.map((entry, index) => {
    const condition = asRecord(entry, `conditions[${index}]`)
    const field = condition.field
    const operator = condition.operator

    if (typeof field !== 'string' || field.length === 0 || field.length > 128) {
      throw new ValidationError([`conditions[${index}].field must be a non-empty string of at most 128 characters`])
    }
    if (typeof operator !== 'string' || !OPERATORS.includes(operator as ConditionOperator)) {
      throw new ValidationError([`conditions[${index}].operator must be one of ${OPERATORS.join(', ')}`])
    }

    if (containsNulChar(field)) {
      throw new ValidationError([`conditions[${index}].field must not contain a NUL character`])
    }

    // `value` is deliberately unconstrained here beyond being JSON —
    // the evaluator's matchers are what decide whether a given value makes
    // sense for a given operator, and they refuse rather than guess. The one
    // exception is the NUL scan: see `assertNoNulChar`.
    assertNoNulChar(condition.value ?? null, `conditions[${index}].value`)

    return { field, operator: operator as ConditionOperator, value: condition.value ?? null }
  })

  const grants: RoleGrant[] = rawGrants.map((entry, index) => {
    const grant = asRecord(entry, `grants[${index}]`)
    const kind = grant.kind
    const groupId = grant.groupId ?? null
    const target = grant.target ?? null

    if (kind === 'group_membership') {
      if (typeof groupId !== 'string' || target !== null) {
        throw new ValidationError([`grants[${index}] of kind group_membership needs a groupId and no target`])
      }
      return { kind, groupId, target: null }
    }

    if (kind === 'target_account') {
      if (typeof target !== 'string' || groupId !== null) {
        throw new ValidationError([`grants[${index}] of kind target_account needs a target and no groupId`])
      }
      if (!ALL_CONNECTOR_TARGETS.includes(target as ConnectorTarget)) {
        throw new ValidationError([`grants[${index}].target is not a known connector target`])
      }
      return { kind, groupId: null, target: target as ConnectorTarget }
    }

    throw new ValidationError([`grants[${index}].kind must be group_membership or target_account`])
  })

  return { conditions, grants }
}

/**
 * SHA-256 over a CANONICAL form — members sorted, object keys emitted in a
 * fixed order — so that reordering a list in the editor does not read as a
 * different draft and force a pointless re-simulation, while any real change
 * to what the role means does.
 */
export function hashDefinition(definition: RoleDefinition): string {
  const conditions = definition.conditions
    .map((c) => JSON.stringify([c.field, c.operator, c.value ?? null]))
    .sort()
  const grants = definition.grants.map((g) => JSON.stringify([g.kind, g.groupId, g.target])).sort()

  return createHash('sha256').update(JSON.stringify({ conditions, grants })).digest('hex')
}
