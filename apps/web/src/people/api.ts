import { authorizedRequest, buildQuery } from '../api/client'
import type { Page } from '../org-units/api'

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

export interface Group {
  id: string
  name: string
  description: string | null
  orgUnitId: string | null
  attributes: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface ListPeopleParams {
  limit: number
  offset: number
  search?: string
  status?: UserStatus
  orgUnitId?: string
}

export function fetchPeople(accessToken: string, params: ListPeopleParams): Promise<Page<Person>> {
  return authorizedRequest<Page<Person>>(
    `/users${buildQuery({
      limit: params.limit,
      offset: params.offset,
      search: params.search,
      status: params.status,
      orgUnitId: params.orgUnitId,
    })}`,
    accessToken,
  )
}

export function fetchPerson(accessToken: string, id: string): Promise<Person> {
  return authorizedRequest<Person>(`/users/${id}`, accessToken)
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

const GROUPS_FOR_USER_LIMIT = 100

/**
 * Effective group membership for an arbitrary user (via GET /groups?userId=,
 * the existing admin equivalent of the self-service GroupsController route)
 * — this is EFFECTIVE membership only, never direct-vs-inherited: unlike
 * `GET /self/groups`, there is no admin endpoint that separates the two for
 * an arbitrary target user (that distinction is Milestone 8 Task 4's own
 * "membership" work, not this task's). PersonDetailPage's Groups tab is
 * honest about that — it lists membership, it does not claim a
 * direct/inherited split it cannot back up.
 */
export function fetchGroupsForUser(accessToken: string, userId: string): Promise<Page<Group>> {
  return authorizedRequest<Page<Group>>(
    `/groups${buildQuery({ userId, limit: GROUPS_FOR_USER_LIMIT, offset: 0 })}`,
    accessToken,
  )
}
