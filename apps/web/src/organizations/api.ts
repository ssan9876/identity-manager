import { authorizedRequest, buildQuery } from '../api/client'
import type { Page } from '../org-units/api'

/**
 * Mirrors the `organizations` row (apps/api/src/db/schema/organizations.ts).
 * The API has no response DTOs — every route returns the Drizzle row
 * verbatim — so this type is the row, and `realmProvisionedAt` in particular
 * is a real, nullable column rather than something derived.
 */
export interface Organization {
  id: string
  slug: string
  name: string
  /** Null for master alone, and only until startup resolves it from KEYCLOAK_ISSUER. */
  realm: string | null
  status: 'active' | 'suspended'
  isMaster: boolean
  /** ISO timestamp, or null while the realm has not been created yet. */
  realmProvisionedAt: string | null
  createdAt: string
  updatedAt: string
}

/** Mirrors `createOrganizationBodySchema` exactly. `realm` is not sent: the API sets it to the slug. */
export interface CreateOrganizationInput {
  slug: string
  name: string
}

export function fetchOrganizationsPage(
  accessToken: string,
  options: { limit: number; offset: number },
): Promise<Page<Organization>> {
  return authorizedRequest<Page<Organization>>(
    `/organizations${buildQuery({ limit: options.limit, offset: options.offset })}`,
    accessToken,
  )
}

export function createOrganization(
  accessToken: string,
  input: CreateOrganizationInput,
): Promise<Organization> {
  return authorizedRequest<Organization>('/organizations', accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

/**
 * `status` is the ONLY patchable field, and the API's body schema is
 * `.strict()` — sending anything else, `slug` above all, is a 400 rather
 * than a silently ignored field. A slug becomes a Keycloak realm name that
 * every one of the tenant's people authenticates against, so there is no
 * rename anywhere in this product.
 */
export function setOrganizationStatus(
  accessToken: string,
  id: string,
  status: 'active' | 'suspended',
): Promise<Organization> {
  return authorizedRequest<Organization>(`/organizations/${id}`, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  })
}
