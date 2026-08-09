import { authorizedRequest } from '../api/client'
import type { ConnectorTarget } from '../connectors/api'

/**
 * `GET /users/:id/entitlements` — Milestone 17, Task 12. Mirrors
 * `UserEntitlements` in apps/api/src/users/users.controller.ts exactly.
 *
 * Its own file rather than another block in people/api.ts because the shape
 * belongs to the business-roles sub-project as much as to People, and the
 * three-valued rule below is the single most misreadable thing in either.
 */

/** Mirrors `JustifyingRole` (role-reconciler.ts). */
export interface JustifyingRole {
  roleId: string
  roleName: string
}

/** Mirrors the `grant_source` pgEnum. */
export type GrantSource = 'manual' | 'business_role'

/**
 * Mirrors `EntitlementRow`. `justifiedBy` is THREE-VALUED and the three
 * values mean three different things — the API's own doc comment is worth
 * repeating, because collapsing any two of them is a screen that lies:
 *
 *  - a non-empty list — these enabled roles hold this user right now;
 *  - `[]` — nothing currently justifies this row. On a `business_role` row
 *    that is a genuine finding (the next reconcile revokes it); on a
 *    `manual` row it is the normal, permanent state;
 *  - `null` — UNKNOWN. The engine refused, so nobody can say. `unevaluable`
 *    below is non-null in precisely this case.
 */
export interface EntitlementRow {
  grantSource: GrantSource
  grantedBy: string | null
  grantedAt: string
  justifiedBy: JustifyingRole[] | null
}

export interface GroupEntitlement extends EntitlementRow {
  groupId: string
  groupName: string
}

export interface TargetEntitlement extends EntitlementRow {
  target: ConnectorTarget
}

export interface UserEntitlements {
  groups: GroupEntitlement[]
  targets: TargetEntitlement[]
  /** Non-null when the role engine refused, naming the role that cannot be understood and why. The rows are STILL returned — this endpoint answers 200, never a 409, because it is the screen someone opens because something is wrong. */
  unevaluable: { roleId: string; roleName: string; reason: string } | null
}

export function fetchEntitlements(accessToken: string, userId: string): Promise<UserEntitlements> {
  return authorizedRequest<UserEntitlements>(`/users/${userId}/entitlements`, accessToken)
}
