import { ApiError, authorizedRequest } from '../api/client'
import type { AttributeDataType, AttributeDefinition, AttributeValidationRules } from '../attributes/api'

// Re-exported so every existing import site (`import { ApiError } from
// './api'`, e.g. SelfServicePage.tsx) keeps working unchanged — this is a
// re-export of the SAME class from ../api/client, not a second, divergent
// definition, so `cause instanceof ApiError` still compares correctly no
// matter which module a caller imports it from.
export { ApiError }

// Re-exported, not redeclared: Milestone 8, Task 3 lifted these three types
// out to attributes/api.ts so the admin create/edit user form can build its
// own attribute fields from the SAME shape `GET /self` already returns
// here — see that module's own doc comment. `type` re-export (not a value)
// so this stays a zero-runtime-cost alias; every existing import site in
// this file and SelfServicePage.tsx keeps compiling unchanged.
export type { AttributeDataType, AttributeDefinition, AttributeValidationRules }

export type UserStatus = 'pending' | 'active' | 'suspended' | 'deactivated'

/** Mirrors SelfProfileResponse from apps/api/src/self-service/self-service.controller.ts. */
export interface SelfProfile {
  id: string
  status: UserStatus
  primaryEmail: string
  username: string
  firstName: string
  lastName: string
  displayName: string
  employeeId: string | null
  jobTitle: string | null
  orgUnitId: string
  managerId: string | null
  location: string | null
  startDate: string | null
  endDate: string | null
  attributes: Record<string, unknown>
  createdAt: string
  updatedAt: string
  deactivatedAt: string | null
  editable: {
    coreFields: string[]
    attributes: AttributeDefinition[]
  }
}

export interface SelfGroup {
  id: string
  name: string
  description: string | null
  orgUnitId: string | null
  attributes: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

/** Mirrors SelfGroupsResponse — `effective` is always a superset of `direct`. */
export interface SelfGroupsResponse {
  direct: SelfGroup[]
  effective: SelfGroup[]
}

/**
 * Deliberately an index signature, not a fixed `{ location?, attributes? }`
 * shape: the caller builds this dynamically from `profile.editable.coreFields`
 * (see SelfServicePage), so the TYPE must stay as open as the runtime
 * behaviour already is. The API is the actual source of truth for which
 * keys are accepted — it rejects (400, naming the field) anything outside
 * its own core-field whitelist plus self-editable attributes, regardless of
 * what this type would otherwise let the client attempt.
 */
export type SelfUpdatePatch = Record<string, unknown>

export function fetchSelfProfile(accessToken: string): Promise<SelfProfile> {
  return authorizedRequest<SelfProfile>('/self', accessToken)
}

export function fetchSelfGroups(accessToken: string): Promise<SelfGroupsResponse> {
  return authorizedRequest<SelfGroupsResponse>('/self/groups', accessToken)
}

export function updateSelfProfile(accessToken: string, patch: SelfUpdatePatch): Promise<SelfProfile> {
  return authorizedRequest<SelfProfile>('/self', accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

// ---------------------------------------------------------------------------
// Access-request catalogue (apps/api/src/access-requests) — all routes are
// authentication-only and self-scoped: the API resolves the requester from
// the verified JWT, so nothing here ever sends a user id.
// ---------------------------------------------------------------------------

export type AccessRequestState = 'pending' | 'approved' | 'denied' | 'cancelled'

/** Mirrors the catalogue entries `GET /access-requests/catalogue` returns. */
export interface CatalogueRole {
  id: string
  name: string
  description: string | null
}

/** Mirrors AccessRequestWithContext (access-requests.repository.ts). */
export interface AccessRequest {
  id: string
  organizationId: string
  requesterUserId: string
  subjectUserId: string
  businessRoleId: string
  justification: string
  state: AccessRequestState
  approverResolver: 'manager_of_subject' | 'role_holder:super_admin'
  decidedBy: string | null
  decidedAt: string | null
  decisionComment: string | null
  requestedExpiresAt: string | null
  createdAt: string
  updatedAt: string
  businessRoleName: string
  subjectUsername: string
  subjectDisplayName: string
}

export function fetchCatalogue(accessToken: string): Promise<{ roles: CatalogueRole[] }> {
  return authorizedRequest<{ roles: CatalogueRole[] }>('/access-requests/catalogue', accessToken)
}

export function fetchMyRequests(accessToken: string): Promise<{ requests: AccessRequest[] }> {
  return authorizedRequest<{ requests: AccessRequest[] }>('/access-requests/mine', accessToken)
}

export function fetchApprovalsInbox(accessToken: string): Promise<{ requests: AccessRequest[] }> {
  return authorizedRequest<{ requests: AccessRequest[] }>('/access-requests/inbox', accessToken)
}

export function createAccessRequest(
  accessToken: string,
  input: { businessRoleId: string; justification: string; requestedExpiresAt: string | null },
): Promise<AccessRequest> {
  return authorizedRequest<AccessRequest>('/access-requests', accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function cancelAccessRequest(accessToken: string, id: string): Promise<AccessRequest> {
  return authorizedRequest<AccessRequest>(`/access-requests/${id}/cancel`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
}

export function decideAccessRequest(
  accessToken: string,
  id: string,
  decision: 'approve' | 'deny',
  comment: string | null,
): Promise<AccessRequest> {
  return authorizedRequest<AccessRequest>(`/access-requests/${id}/${decision}`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment }),
  })
}
