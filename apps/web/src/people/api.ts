import { authorizedRequest, buildQuery } from '../api/client'
import type { Page } from '../org-units/api'

/** Re-exported from groups/api.ts, their natural home as of Milestone 8, Task 4 — see that module's own doc comment on `Group`/`fetchGroupsForUser` for why. */
export type { Group } from '../groups/api'
export { fetchGroupsForUser } from '../groups/api'

export type UserStatus = 'pending' | 'active' | 'suspended' | 'deactivated'
export type SyncState = 'pending' | 'synced' | 'failed'

/** Mirrors UserWithSyncState from apps/api/src/users/users.controller.ts. */
export interface Person {
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
  syncState: SyncState
}

export interface ListPeopleParams {
  limit: number
  offset: number
  search?: string
  status?: UserStatus
  orgUnitId?: string
}

/**
 * `signal` is optional and additive — every existing call site (PeopleListPage,
 * GroupMembersTab's AddMemberForm) keeps compiling unchanged. PersonPicker
 * (Milestone 9, Task 3) is the first caller that passes one, so a superseded
 * in-flight search can actually be cancelled at the network layer, not just
 * ignored once it resolves — see forms/Combobox.tsx's own doc comment for why
 * correctness does not depend on this (a sequence-number check does), but
 * cancelling real, discarded requests is still worth doing.
 */
export function fetchPeople(accessToken: string, params: ListPeopleParams, signal?: AbortSignal): Promise<Page<Person>> {
  return authorizedRequest<Page<Person>>(
    `/users${buildQuery({
      limit: params.limit,
      offset: params.offset,
      search: params.search,
      status: params.status,
      orgUnitId: params.orgUnitId,
    })}`,
    accessToken,
    signal ? { signal } : undefined,
  )
}

export function fetchPerson(accessToken: string, id: string): Promise<Person> {
  return authorizedRequest<Person>(`/users/${id}`, accessToken)
}

// The API caps a single `ids` request at 200 (users.controller.ts's
// MAX_IDS) — generous for "one to a handful" of admins at "a single
// organisation" (docs/product-brief.md), the same scale assumption
// org-units/api.ts's fetchAllOrgUnits already makes explicit. A single
// group's direct membership exceeding this is not handled specially here.
const PEOPLE_BY_IDS_LIMIT = 200

/**
 * Resolves a known set of user ids to full, displayable records in one
 * request, via `GET /users?ids=` (Milestone 8, Task 4's addition to this
 * existing route — see users.controller.ts's own doc comment on
 * `parseIdsQuery`). The Group detail page's Members tab is the reason this
 * exists: `GET /groups/:id/members` and `GET /groups/:id/effective-members`
 * both return bare `string[]` of ids, never full records.
 *
 * An empty `ids` array resolves locally to an empty page with NO request —
 * the server would answer identically (its own "explicit empty -> matches
 * nothing" contract, `UsersRepository.list`'s own doc comment), so there is
 * nothing to gain by making the round trip for an answer already known.
 */
export function fetchPeopleByIds(accessToken: string, ids: string[]): Promise<Page<Person>> {
  if (ids.length === 0) {
    return Promise.resolve({ items: [], total: 0, limit: PEOPLE_BY_IDS_LIMIT, offset: 0 })
  }
  return authorizedRequest<Page<Person>>(
    `/users${buildQuery({ ids: ids.join(','), limit: PEOPLE_BY_IDS_LIMIT, offset: 0 })}`,
    accessToken,
  )
}

/** Mirrors `createUserBodySchema` (apps/api/src/users/users.controller.ts) exactly — every field this form may send, and no others (that schema is `.strict()`). */
export interface CreatePersonInput {
  primaryEmail: string
  username: string
  firstName: string
  lastName: string
  orgUnitId: string
  employeeId?: string
  jobTitle?: string
  managerId?: string
  location?: string
  startDate?: string
  endDate?: string
  attributes?: Record<string, unknown>
}

export function createPerson(accessToken: string, input: CreatePersonInput): Promise<Person> {
  return authorizedRequest<Person>('/users', accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

/**
 * Mirrors `updateUserBodySchema` exactly — deliberately narrower than
 * `CreatePersonInput`: `primaryEmail`, `username`, `orgUnitId` and `status`
 * are not part of `PATCH /users/:id`'s accepted surface at all (see
 * `UsersRepository.update`'s own doc comment on the API side for why each is
 * excluded), so the edit form must not offer inputs for them — task-3-
 * brief.md: "do not offer inputs the server will reject." Every nullable
 * field accepts `null` explicitly, to clear it, matching the API's own
 * partial-update contract.
 */
export interface UpdatePersonInput {
  firstName?: string
  lastName?: string
  jobTitle?: string | null
  employeeId?: string | null
  managerId?: string | null
  location?: string | null
  startDate?: string | null
  endDate?: string | null
  attributes?: Record<string, unknown>
}

export function updatePerson(accessToken: string, id: string, patch: UpdatePersonInput): Promise<Person> {
  return authorizedRequest<Person>(`/users/${id}`, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/**
 * The only path to `deactivated`, which is terminal (mirrors
 * `UsersController.deactivate`'s own doc comment). Returns the updated
 * record WITH its freshly-resolved `syncState` — this is what lets the
 * caller's post-action toast report the real, current sync state rather
 * than assuming one.
 */
export function deactivatePerson(accessToken: string, id: string): Promise<Person> {
  return authorizedRequest<Person>(`/users/${id}/deactivate`, accessToken, { method: 'POST' })
}

/**
 * Moves a `pending` or `suspended` person to `active`, which is what makes
 * every connector assert their account as enabled. Returns the updated
 * record WITH its freshly-resolved `syncState`, same as `deactivatePerson`
 * above — but note the two are NOT symmetric: deactivation disables the
 * Keycloak account before it responds, activation only enqueues the change.
 * The caller's toast has to say so.
 */
export function activatePerson(accessToken: string, id: string): Promise<Person> {
  return authorizedRequest<Person>(`/users/${id}/activate`, accessToken, { method: 'POST' })
}

