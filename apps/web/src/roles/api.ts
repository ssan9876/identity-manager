import { authorizedRequest } from '../api/client'

/** Mirrors `RoleKey`/`ALL_ROLE_KEYS` from apps/api/src/authz/actions.ts. */
export type RoleKey = 'super_admin' | 'user_admin' | 'help_desk' | 'auditor' | 'read_only'

export const ALL_ROLE_KEYS: readonly RoleKey[] = [
  'super_admin',
  'user_admin',
  'help_desk',
  'auditor',
  'read_only',
]

/** Mirrors `ROLE_RANK` (actions.ts) — for display and for `grantableScopeFor` below ONLY. The server (`PrivilegeGuards`) is the actual authority and re-decides for real on every write; nothing here is a security boundary. */
export const ROLE_RANK: Record<RoleKey, number> = {
  super_admin: 40,
  user_admin: 30,
  help_desk: 20,
  auditor: 10,
  read_only: 0,
}

export const ROLE_LABEL: Record<RoleKey, string> = {
  super_admin: 'Super admin',
  user_admin: 'User admin',
  help_desk: 'Help desk',
  auditor: 'Auditor',
  read_only: 'Read only',
}

/** Mirrors `ROLE_PERMISSIONS`'s actual grants (actions.ts), in the vocabulary an admin thinks in ("create people"), not the literal Action strings — for the `/roles` catalog page. */
export const ROLE_DESCRIPTION: Record<RoleKey, string> = {
  super_admin:
    'Every action in the system, including creating org units and granting or revoking roles — the only role that can do either.',
  user_admin:
    'Create, update and deactivate people; create and manage groups and their membership; read org units.',
  help_desk: 'Read and update people; read groups and org units. Cannot create, deactivate, or manage group membership.',
  auditor: 'Read-only across people, groups and org units, plus the audit log.',
  read_only: 'Read-only across people, groups and org units.',
}

/** Mirrors `RoleAssignment` (apps/api/src/authz/role-assignments.repository.ts). */
export interface RoleAssignment {
  id: string
  userId: string
  roleKey: RoleKey
  scopeOrgUnitId: string | null
  createdAt: string
}

/** `GET /users/:id/roles` — Milestone 8, Task 4's new read route. Gated by `role:assign`, same as grant/revoke (see RoleAssignmentsController's own doc comment): a 403 here means the caller cannot reach this target for role purposes at all. */
export function fetchRolesForUser(accessToken: string, userId: string): Promise<RoleAssignment[]> {
  return authorizedRequest<RoleAssignment[]>(`/users/${userId}/roles`, accessToken)
}

/** Mirrors `ActorAssignment` (apps/api/src/authz/permission.engine.ts), as returned by `GET /self/roles`. */
export interface SelfRoleAssignment {
  roleKey: RoleKey
  scopeOrgUnitId: string | null
  scopePath: string | null
}

export function fetchSelfRoles(accessToken: string): Promise<{ assignments: SelfRoleAssignment[] }> {
  return authorizedRequest<{ assignments: SelfRoleAssignment[] }>('/self/roles', accessToken)
}

/** Mirrors `assignRoleBodySchema` exactly (role-assignments.controller.ts) — `scopeOrgUnitId: null` means GLOBAL. */
export interface GrantRoleInput {
  roleKey: RoleKey
  scopeOrgUnitId: string | null
}

export function grantRole(
  accessToken: string,
  userId: string,
  input: GrantRoleInput,
): Promise<RoleAssignment> {
  return authorizedRequest<RoleAssignment>(`/users/${userId}/roles`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function revokeRole(accessToken: string, userId: string, assignmentId: string): Promise<unknown> {
  return authorizedRequest(`/users/${userId}/roles/${assignmentId}`, accessToken, { method: 'DELETE' })
}

/**
 * Which scopes the CALLER may grant `roleKey` at, derived from their own
 * assignments (`GET /self/roles`) — a client-side mirror of
 * `PrivilegeGuards.assertCanAssignRole`'s own "holds `roleKey` OR
 * `super_admin`; a GLOBAL holding covers every scope; a SCOPED holding
 * covers its own org unit and every descendant" logic (apps/api/src/authz/
 * privilege.guards.ts), so the grant form's scope picker never offers an
 * option the API will reject (task-4-brief.md: "The scope picker must be
 * constrained to scopes the caller can actually grant at"). This is a
 * PRE-FILTER for picker OPTIONS only, computed for UX — the server
 * re-runs the real check on every submit regardless.
 */
export interface GrantableScope {
  /**
   * True if ANY qualifying holding is global. This means "Global" itself
   * AND every real org unit are all valid scope choices — NOT just "every
   * org unit within `orgUnitPaths`": `assertCanAssignRole` (server side)
   * returns success the MOMENT it finds one global qualifying holding,
   * before it ever reaches its own path-containment check, so a global
   * holder may grant at literally any scope. A caller building a scope
   * picker from this must branch on `global` FIRST — offering only
   * `orgUnitPaths`-filtered units when `global` is true would incorrectly
   * withhold options the API would actually accept.
   */
  global: boolean
  /** The ltree paths this actor's qualifying holdings cover — consulted ONLY when `global` is false: a candidate org unit is offered if its OWN path equals, or descends from (ltree `<@`), one of these. Both empty means "cannot grant this role at all". */
  orgUnitPaths: string[]
}

export function grantableScopeFor(myAssignments: SelfRoleAssignment[], roleKey: RoleKey): GrantableScope {
  const holdings = myAssignments.filter(
    (assignment) => assignment.roleKey === roleKey || assignment.roleKey === 'super_admin',
  )
  const global = holdings.some((assignment) => assignment.scopeOrgUnitId === null)
  const orgUnitPaths = holdings
    .map((assignment) => assignment.scopePath)
    .filter((path): path is string => path !== null)
  return { global, orgUnitPaths }
}

/** True if `candidatePath` equals, or descends from (dot-separated label containment — the same thing Postgres's `path <@ ANY (...)` decides), any path in `withinPaths`. */
export function pathWithin(candidatePath: string, withinPaths: readonly string[]): boolean {
  return withinPaths.some((base) => candidatePath === base || candidatePath.startsWith(`${base}.`))
}

/**
 * Turns a rejected grant/revoke into a sentence an admin understands —
 * task-4-brief.md: "explain which of the three checks failed in terms an
 * admin understands, without disclosing anything about principals or scopes
 * they cannot see." The three checks (docs/08-authorization.md's own
 * numbering, which this task's brief matches):
 *   1. Does the actor hold `role:assign` anywhere, AND can they reach THIS
 *      target specifically? `PermissionGuard`'s entry gate and finding
 *      H-1's `assertCanIn` check both throw the BYTE-IDENTICAL message
 *      `"not permitted: role:assign"` (see RoleAssignmentsController's own
 *      doc comment) — bucketed together below since, from the caller's side,
 *      both answer the same question: "can I touch this person's role
 *      assignments at all."
 *   2. `assertCanAssignRole` — may THIS actor grant THIS role at THIS scope.
 *   3. `assertCanModifyPrincipal` — does the target outrank the actor.
 * Every branch below names only what the caller ALREADY sees on screen —
 * `context.targetName` (the person whose page they are on) and
 * `context.roleLabel` (the role THEY selected) — never a scope or principal
 * the caller cannot already see, matching the brief's own constraint. A
 * duplicate-grant 409 is handled first/most-specifically, since its own
 * message text ("already holds X globally") would otherwise false-match the
 * "globally" substring the check-2 branches key on.
 */
export function explainRoleAssignError(
  error: { message: string },
  context: { targetName: string; roleLabel: string },
): string {
  const message = error.message.toLowerCase()

  if (message.includes('already holds')) {
    const isGlobal = message.endsWith('globally')
    return `${context.targetName} already holds ${context.roleLabel}${isGlobal ? ' globally' : ' at that scope'}.`
  }
  if (message.includes('not permitted to grant') && message.includes('globally')) {
    return `You can only grant ${context.roleLabel} within your own scope, not organisation-wide.`
  }
  if (message.includes('not permitted to grant') && message.includes('at that scope')) {
    return `You can only grant ${context.roleLabel} within the org units your own role covers.`
  }
  if (message.includes('not permitted to grant')) {
    return `You don't hold ${context.roleLabel} yourself, so you can't grant it.`
  }
  if (message.includes('more privileged')) {
    return `${context.targetName} holds a role that outranks yours — you can't modify their role assignments.`
  }
  if (message.includes('not permitted: role:assign')) {
    return `You don't have permission to manage ${context.targetName}'s role assignments — they're outside what your role:assign grant covers.`
  }
  return error.message
}
