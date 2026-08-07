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
