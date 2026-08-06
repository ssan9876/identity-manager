import { apiBaseUrl } from '../auth/oidc-config'

export type AttributeDataType = 'string' | 'number' | 'boolean' | 'date' | 'enum'

export interface AttributeValidationRules {
  minLength?: number
  maxLength?: number
  pattern?: string
  min?: number
  max?: number
  options?: string[]
}

/**
 * Mirrors `AttributeDefinition` from apps/api/src/attributes/attribute-validator.ts.
 * Only the definitions that are BOTH active and `self_editable` ever appear
 * here — `GET /self` has already filtered the full catalog down to exactly
 * what this caller may edit (see SelfServiceController.selfEditableAttributeDefinitions
 * on the API side), so the form below is driven entirely by this list
 * rather than any hard-coded field name.
 */
export interface AttributeDefinition {
  key: string
  label: string
  dataType: AttributeDataType
  required: boolean
  validationRules: AttributeValidationRules
  appliesTo: 'user' | 'group'
  isActive: boolean
  syncToKeycloak: boolean
  selfEditable: boolean
}

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

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    public readonly issues: string[] | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function authorizedRequest<T>(path: string, accessToken: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
    },
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { message?: string; code?: string; issues?: string[] }
      | null
    throw new ApiError(
      res.status,
      body?.code,
      body?.issues,
      body?.message ?? `request to ${path} failed with status ${res.status}`,
    )
  }

  return res.json() as Promise<T>
}

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
