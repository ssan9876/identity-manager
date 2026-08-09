import { authorizedRequest, buildQuery } from '../api/client'
import type { Page } from '../org-units/api'

/**
 * Mirrors `Group` from apps/api/src/groups/groups.repository.ts. Moved here
 * (Milestone 8, Task 4) from people/api.ts, its original home from Task 2 —
 * which only ever needed it to render a person's OWN group membership, a
 * borrowed use of a type that properly belongs to the Groups feature this
 * task builds. `people/api.ts` re-exports it unchanged (same move Task 3
 * made for `AttributeDefinition`, out of self-service/api.ts and into
 * attributes/api.ts), so PersonDetailPage.tsx's existing `import { type
 * Group } from './api'` keeps compiling with no call-site changes.
 */
export interface Group {
  id: string
  name: string
  description: string | null
  orgUnitId: string | null
  attributes: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

/** Mirrors `createGroupBodySchema` (apps/api/src/groups/groups.controller.ts) exactly. `orgUnitId` omitted -> GLOBAL (decision 1) — creating one requires a GLOBAL grant of `group:create`; the API explains that 403 on its own terms (GroupForm surfaces it verbatim, matching CreateOrgUnitForm's own precedent), so the picker itself is not pre-filtered by scope the way the role-assignment picker must be (task-4-brief.md's constraint is specific to that one). */
export interface CreateGroupInput {
  name: string
  description?: string
  orgUnitId?: string
  attributes?: Record<string, unknown>
}

/** Mirrors `updateGroupBodySchema` exactly — `orgUnitId` is deliberately absent (see GroupsRepository.UpdateGroupInput's own doc comment: a scope transfer is out of this milestone's PATCH surface, same reasoning as `PersonForm`/`UpdatePersonInput` excluding a user's own `orgUnitId`). */
export interface UpdateGroupInput {
  name?: string
  description?: string | null
  attributes?: Record<string, unknown>
}

export function fetchGroupsPage(
  accessToken: string,
  options: { limit: number; offset: number },
): Promise<Page<Group>> {
  return authorizedRequest<Page<Group>>(
    `/groups${buildQuery({ limit: options.limit, offset: options.offset })}`,
    accessToken,
  )
}

const ALL_GROUPS_PAGE_LIMIT = 100
// Same ceiling and reasoning as org-units/api.ts's fetchAllOrgUnits: a
// generous, not tight, bound purely so a pathological response can never
// spin this loop forever — reference-scale data for "a single
// organisation" (docs/product-brief.md), not a collection expected to grow unbounded.
const ALL_GROUPS_MAX_PAGES = 100

/**
 * Pages through every group the caller can see — mirrors
 * org-units/api.ts's `fetchAllOrgUnits` exactly, including why fetching
 * "all" is the right call for THIS purpose specifically (a lookup/picker
 * data source), even though GroupsListPage itself does its own live,
 * server-paginated fetch for the main table (see that page's own doc
 * comment) rather than reading from this cache: the two serve different
 * jobs, the same split OrgUnitsContext/People already draw.
 */
export async function fetchAllGroups(accessToken: string): Promise<Group[]> {
  const all: Group[] = []
  let offset = 0

  for (let page = 0; page < ALL_GROUPS_MAX_PAGES; page++) {
    const res = await fetchGroupsPage(accessToken, { limit: ALL_GROUPS_PAGE_LIMIT, offset })
    all.push(...res.items)
    offset += res.items.length
    if (res.items.length === 0 || offset >= res.total) break
  }

  return all
}

export function fetchGroup(accessToken: string, id: string): Promise<Group> {
  return authorizedRequest<Group>(`/groups/${id}`, accessToken)
}

export function createGroup(accessToken: string, input: CreateGroupInput): Promise<Group> {
  return authorizedRequest<Group>('/groups', accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function updateGroup(accessToken: string, id: string, patch: UpdateGroupInput): Promise<Group> {
  return authorizedRequest<Group>(`/groups/${id}`, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/** Mirrors `GroupsController.members`'s response shape exactly: DIRECT membership only, both halves — the user half is one of the two lists Task 4's "direct and effective... must be visually distinct" requirement needs; the group half is this group's direct child groups (the Nested groups tab). */
export interface GroupMembers {
  users: string[]
  groups: string[]
}

export function fetchGroupMembers(accessToken: string, id: string): Promise<GroupMembers> {
  return authorizedRequest<GroupMembers>(`/groups/${id}/members`, accessToken)
}

/** Every user id reachable from this group, direct or via nested descendant groups — the wider half of the direct/effective pair above. */
export function fetchEffectiveMembers(accessToken: string, id: string): Promise<string[]> {
  return authorizedRequest<string[]>(`/groups/${id}/effective-members`, accessToken)
}

export function addGroupMember(
  accessToken: string,
  groupId: string,
  userId: string,
): Promise<{ groupId: string; userId: string }> {
  return authorizedRequest(`/groups/${groupId}/members`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  })
}

export function removeGroupMember(
  accessToken: string,
  groupId: string,
  userId: string,
): Promise<{ groupId: string; userId: string }> {
  return authorizedRequest(`/groups/${groupId}/members/${userId}`, accessToken, { method: 'DELETE' })
}

/**
 * Nests `childId` under `parentGroupId`. A 409 CYCLE_DETECTED here is
 * expected, routine input the server must be allowed to reject — see
 * `explainGroupError` in this same module and task-4-brief.md: "do not
 * attempt to pre-empt it client-side and skip the call; let the server
 * decide and explain the answer." Every caller of this function lets the
 * rejection propagate to that explainer rather than swallowing or
 * pre-checking it.
 */
export function addChildGroup(
  accessToken: string,
  parentGroupId: string,
  childId: string,
): Promise<{ parentGroupId: string; childGroupId: string }> {
  return authorizedRequest(`/groups/${parentGroupId}/child-groups`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ childId }),
  })
}

export function removeChildGroup(
  accessToken: string,
  parentGroupId: string,
  childGroupId: string,
): Promise<{ parentGroupId: string; childGroupId: string }> {
  return authorizedRequest(`/groups/${parentGroupId}/child-groups/${childGroupId}`, accessToken, {
    method: 'DELETE',
  })
}

const GROUPS_FOR_USER_LIMIT = 100

/**
 * Effective group membership for an arbitrary user (`GET /groups?userId=`).
 * Moved here, unchanged, from people/api.ts (Task 2) for the same reason
 * `Group` itself was — people/api.ts re-exports it so PersonDetailPage.tsx's
 * existing import keeps working.
 */
export function fetchGroupsForUser(accessToken: string, userId: string): Promise<Page<Group>> {
  return authorizedRequest<Page<Group>>(
    `/groups${buildQuery({ userId, limit: GROUPS_FOR_USER_LIMIT, offset: 0 })}`,
    accessToken,
  )
}

/**
 * Turns a group-membership API failure into a sentence an admin can act on,
 * without exposing the raw error code — task-4-brief.md: "Surface it as a
 * plain explanation of *why* the nesting is impossible, not a raw error
 * code." `code === 'CYCLE_DETECTED'` is the one case this module has enough
 * context to explain BETTER than the server's own (correct, but terse)
 * message: the server names ids in a security-audited but human-unfriendly
 * form ("nesting group <uuid> under <uuid> would create a cycle"), and the
 * caller of this function already has both groups' real NAMES on screen —
 * `childName` is threaded through so this can say the same thing the server
 * decided, in the vocabulary the admin is already looking at. Every other
 * error (404 target vanished, a generic 403) falls back to the server's own
 * message, which is already specific enough on its own.
 */
export function explainGroupError(
  error: { code?: string; message: string },
  context: { childName: string; parentName: string },
): string {
  if (error.code === 'CYCLE_DETECTED') {
    return `${context.childName} already contains ${context.parentName}, directly or through another nested group — nesting it here would make ${context.parentName} contain itself. Choose a different group, or un-nest the existing path between them first.`
  }
  return error.message
}
