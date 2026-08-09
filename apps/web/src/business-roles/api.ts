import { authorizedRequest } from '../api/client'
import type { ConnectorTarget } from '../connectors/api'

/**
 * The console's mirror of `apps/api/src/business-roles/*` — Milestone 17,
 * Tasks 17-19. Every type here is written against the API's OWN shapes
 * (`BusinessRolesController`, `business-roles.repository.ts`, `draft.ts`,
 * `role-evaluator.ts`), not guessed from the plan: `GET /business-roles`
 * returns bare `business_roles` rows, `GET /business-roles/:id` returns that
 * row PLUS the published conditions/grants/exceptions loaded from the child
 * tables, and those two facts are what the list page and the detail page are
 * each shaped around.
 */

/** Exactly `CONDITION_FIELDS` from role-evaluator.ts, plus the open-ended `attributes.<key>` form that file's `extractField` also accepts. */
export const CONDITION_FIELDS = ['jobTitle', 'location', 'status', 'orgUnitId'] as const
export type ConditionField = (typeof CONDITION_FIELDS)[number]

export const ATTRIBUTE_PREFIX = 'attributes.'

/** Exactly `OPERATORS` from draft.ts / `OPERATOR_MATCHERS` from role-evaluator.ts. */
export const CONDITION_OPERATORS = ['equals', 'not_equals', 'in', 'in_org_subtree'] as const
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number]

export const OPERATOR_LABEL: Record<ConditionOperator, string> = {
  equals: 'is',
  not_equals: 'is not',
  in: 'is one of',
  in_org_subtree: 'is at or below',
}

export const FIELD_LABEL: Record<ConditionField, string> = {
  jobTitle: 'Job title',
  location: 'Location',
  status: 'Account status',
  orgUnitId: 'Org unit',
}

/** Mirrors `RoleCondition`. `value` is deliberately unconstrained JSON — the evaluator's matchers decide whether a value makes sense for an operator, and they refuse rather than guess. */
export interface RoleCondition {
  field: string
  operator: ConditionOperator
  value: unknown
}

/** Mirrors `RoleGrant`. Exactly one of `groupId`/`target` is non-null; `draft.ts` rejects any other combination with a 400 naming the index. */
export interface RoleGrant {
  kind: 'group_membership' | 'target_account'
  groupId: string | null
  target: ConnectorTarget | null
}

/** Mirrors what `loadDefinition` maps an exception row down to. NOTE: `reason` and `grantedBy` are stored and audited but are NOT part of this read shape — see BusinessRoleExceptionsTab for how that is surfaced honestly rather than invented. */
export interface RoleException {
  userId: string
  mode: 'include' | 'exclude'
  /** ISO-8601 instant, or null for "never expires". */
  expiresAt: string | null
}

export interface RoleDefinition {
  conditions: RoleCondition[]
  grants: RoleGrant[]
}

/** Mirrors `BusinessRoleRow` — the bare `business_roles` row, which is all `GET /business-roles` returns. */
export interface BusinessRole {
  id: string
  name: string
  description: string | null
  enabled: boolean
  organizationId: string
  /** The unpublished draft, or null when there are no pending changes. */
  draftDefinition: RoleDefinition | null
  /** When the CURRENT draft was last simulated. Cleared to null by every draft save (`BusinessRolesRepository.saveDraft`), which is what makes "simulated" always mean "simulated as it stands now". */
  simulatedAt: string | null
  simulatedDraftHash: string | null
  createdAt: string
  updatedAt: string
}

/** Mirrors `BusinessRolesRepository.findById` — the row plus its PUBLISHED definition. */
export interface BusinessRoleDetail extends BusinessRole {
  conditions: RoleCondition[]
  grants: RoleGrant[]
  exceptions: RoleException[]
}

/** Mirrors `SimulationEntry`. Carries a `username`, never a display name or org unit — the console resolves those itself (`fetchPeopleByIds`) for the sample it actually renders. */
export interface SimulationEntry {
  userId: string
  username: string
  groupIds: string[]
  targets: ConnectorTarget[]
}

/** Mirrors `SimulationReport`. `gainCount`/`lossCount` are the TRUE totals across the whole directory; `gains`/`losses` are capped samples, and `truncated` says so. */
export interface SimulationReport {
  scanned: number
  gainCount: number
  lossCount: number
  gains: SimulationEntry[]
  losses: SimulationEntry[]
  truncated: boolean
}

/** Mirrors `RoleReconciliationJob.reconcileRole`'s report as it appears on the enable/disable/publish responses. */
export interface ReconciliationSummary {
  changed: number
  [key: string]: unknown
}

/** Mirrors `setEnabled`'s response body. `principalsRevoked` is why the disable toast can state a consequence rather than a success. */
export interface EnabledChangeResult extends BusinessRoleDetail {
  reconciliation: ReconciliationSummary
  principalsRevoked: number
  principalsGranted: number
}

export function fetchBusinessRoles(accessToken: string): Promise<BusinessRole[]> {
  return authorizedRequest<BusinessRole[]>('/business-roles', accessToken)
}

export function fetchBusinessRole(accessToken: string, id: string): Promise<BusinessRoleDetail> {
  return authorizedRequest<BusinessRoleDetail>(`/business-roles/${id}`, accessToken)
}

/** Mirrors `createBodySchema` exactly — a new role is disabled and undrafted by construction, and this route exposes no way to say otherwise. */
export function createBusinessRole(
  accessToken: string,
  input: { name: string; description: string | null },
): Promise<BusinessRole> {
  return authorizedRequest<BusinessRole>('/business-roles', accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

/** Mirrors `patchBodySchema` exactly. It is `.strict()`: sending anything that could affect access is a 400 naming the field, never a silent no-op. */
export function updateBusinessRole(
  accessToken: string,
  id: string,
  patch: { name?: string; description?: string | null },
): Promise<BusinessRole> {
  return authorizedRequest<BusinessRole>(`/business-roles/${id}`, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/** A PUT, not a PATCH: a formula is meaningful only as a whole. Saving CLEARS any recorded simulation, server-side. */
export function saveBusinessRoleDraft(
  accessToken: string,
  id: string,
  definition: RoleDefinition,
): Promise<BusinessRoleDetail> {
  return authorizedRequest<BusinessRoleDetail>(`/business-roles/${id}/draft`, accessToken, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(definition),
  })
}

export function simulateBusinessRole(accessToken: string, id: string): Promise<SimulationReport> {
  return authorizedRequest<SimulationReport>(`/business-roles/${id}/simulate`, accessToken, {
    method: 'POST',
  })
}

export function publishBusinessRole(
  accessToken: string,
  id: string,
): Promise<BusinessRoleDetail & { reconciliation: ReconciliationSummary }> {
  return authorizedRequest<BusinessRoleDetail & { reconciliation: ReconciliationSummary }>(
    `/business-roles/${id}/publish`,
    accessToken,
    { method: 'POST' },
  )
}

export function setBusinessRoleEnabled(
  accessToken: string,
  id: string,
  enabled: boolean,
): Promise<EnabledChangeResult> {
  return authorizedRequest<EnabledChangeResult>(
    `/business-roles/${id}/${enabled ? 'enable' : 'disable'}`,
    accessToken,
    { method: 'POST' },
  )
}

/** Mirrors `exceptionBodySchema` exactly. `reason` is REQUIRED — an unexplained exception is what a later recertification campaign cannot act on. */
export function addBusinessRoleException(
  accessToken: string,
  id: string,
  input: { userId: string; mode: 'include' | 'exclude'; reason: string; expiresAt: string | null },
): Promise<unknown> {
  return authorizedRequest<unknown>(`/business-roles/${id}/exceptions`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function removeBusinessRoleException(
  accessToken: string,
  id: string,
  userId: string,
): Promise<unknown> {
  return authorizedRequest<unknown>(`/business-roles/${id}/exceptions/${userId}`, accessToken, {
    method: 'DELETE',
  })
}

/**
 * The three states the detail header and the list's own column both name, in
 * ONE place so they can never drift apart.
 *
 * Derived purely from the row, and it can be, because the API guarantees the
 * link: `saveDraft` nulls `simulated_at` in the same UPDATE that writes the
 * draft, so `draftDefinition !== null && simulatedAt !== null` means "this
 * exact draft has been simulated" and nothing weaker.
 */
export type DraftState = 'none' | 'pending-simulation' | 'ready-to-publish'

export function draftStateOf(role: Pick<BusinessRole, 'draftDefinition' | 'simulatedAt'>): DraftState {
  if (role.draftDefinition === null) return 'none'
  return role.simulatedAt === null ? 'pending-simulation' : 'ready-to-publish'
}

/** A grant, in the words an admin uses — group NAME where the console knows it, never a bare uuid. */
export function describeGrant(
  grant: RoleGrant,
  groupName: (id: string) => string | undefined,
  targetLabel: (target: ConnectorTarget) => string,
): string {
  if (grant.kind === 'group_membership' && grant.groupId !== null) {
    return groupName(grant.groupId) ?? grant.groupId
  }
  if (grant.kind === 'target_account' && grant.target !== null) {
    return `${targetLabel(grant.target)} account`
  }
  return 'Unrecognised grant'
}
