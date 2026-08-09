import { authorizedRequest, buildQuery } from '../api/client'
import type { Page } from '../org-units/api'

/** Mirrors `AuditRow` (apps/api/src/audit/audit.repository.ts) — `actorUsername`/`actorDisplayName` are resolved server-side via a join, never a second client-side lookup (see that file's own doc comment on why: `audit:read` must identify an actor regardless of the caller's own `user:read` scope). */
export interface AuditEntry {
  id: number
  actorUserId: string | null
  actorUsername: string | null
  actorDisplayName: string | null
  action: string
  resourceType: string
  resourceId: string | null
  before: unknown
  after: unknown
  batchId: string | null
  createdAt: string
}

export interface AuditListParams {
  limit: number
  offset: number
  actor?: string
  action?: string
  resourceType?: string
  resourceId?: string
  batchId?: string
  /** YYYY-MM-DD, inclusive. */
  from?: string
  /** YYYY-MM-DD, inclusive. */
  to?: string
}

/** `GET /audit` — Milestone 8, Task 5's one new endpoint (AuditController). Gated on `audit:read`, same as `fetchDeadLetters` (outbox-api.ts). */
export function fetchAuditLog(accessToken: string, params: AuditListParams): Promise<Page<AuditEntry>> {
  return authorizedRequest<Page<AuditEntry>>(
    `/audit${buildQuery({
      limit: params.limit,
      offset: params.offset,
      actor: params.actor,
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      batchId: params.batchId,
      from: params.from,
      to: params.to,
    })}`,
    accessToken,
  )
}

/**
 * Every action string this codebase's `AuditWriter.record` call sites
 * actually use (grepped across apps/api/src), labelled in the vocabulary an
 * admin thinks in rather than the literal `resource:verb` string — mirrors
 * roles/api.ts's `ROLE_LABEL`/`ROLE_DESCRIPTION` precedent for the same
 * reason. Presentation only: `actionLabel` below falls back to the raw
 * string for anything not listed here, so a future action added on the API
 * side degrades to "technical but correct" rather than breaking.
 */
const ACTION_LABEL: Record<string, string> = {
  'user:create': 'Person created',
  'user:update': 'Person updated',
  'user:activate': 'Person activated',
  'user:deactivate': 'Person deactivated',
  'user:self_update': 'Self-service profile update',
  'group:create': 'Group created',
  'group:update': 'Group updated',
  'group:add_member': 'Member added to group',
  'group:remove_member': 'Member removed from group',
  'group:add_child_group': 'Group nested under another',
  'group:remove_child_group': 'Group un-nested',
  'org_unit:create': 'Org unit created',
  'role:assign': 'Role granted',
  'role:revoke': 'Role revoked',
  'import:preview': 'Import previewed',
  'jml:add_to_group': 'Joiner/mover: added to group',
  'jml:remove_from_group': 'Joiner/mover: removed from group',
  'jml:set_attribute': 'Joiner/mover: attribute set',
  'jml:deactivate': 'Leaver: deactivated',
  'jml:lifecycle_activate': 'Lifecycle: start-date activation',
  'jml:lifecycle_deactivate': 'Lifecycle: end-date deactivation',
  'reconciliation:repair': 'Reconciliation repair',
}

export const KNOWN_AUDIT_ACTIONS = Object.keys(ACTION_LABEL).sort()

export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action
}

const RESOURCE_TYPE_LABEL: Record<string, string> = {
  user: 'Person',
  group: 'Group',
  org_unit: 'Org unit',
  role_assignment: 'Role assignment',
  import: 'Import',
}

export const KNOWN_AUDIT_RESOURCE_TYPES = Object.keys(RESOURCE_TYPE_LABEL).sort()

export function resourceTypeLabel(resourceType: string): string {
  return RESOURCE_TYPE_LABEL[resourceType] ?? resourceType
}

/** Where a resource of this type has its own detail page, the route to link its id to — otherwise `null` (no link, just the mono id). */
export function resourceLinkPath(resourceType: string, resourceId: string): string | null {
  if (resourceType === 'user') return `/people/${resourceId}`
  if (resourceType === 'group') return `/groups/${resourceId}`
  if (resourceType === 'org_unit') return `/org-units/${resourceId}`
  return null
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Turns a camelCase snapshot field name into a readable label — "primaryEmail" -> "Primary email". Generic (works for every resource type's snapshot shape uniformly) rather than a per-resource-type field dictionary — task-5-brief.md's bar is "readably... rather than as raw JSON blobs," not a bespoke renderer per entity. */
export function humanizeFieldKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  const lower = spaced.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

/** A single field's readable value — never a bare `[object Object]`, never an unlabelled JSON dump of the WHOLE row (only a single nested field, if any, ever falls back to compact JSON). */
export function formatDiffValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return JSON.stringify(value)
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export interface DiffEntry {
  key: string
  before: unknown
  after: unknown
  changed: boolean
}

/**
 * Builds one row per field named by EITHER `before` or `after` — the shared
 * shape `AuditDiff` (AuditDiff.tsx) renders for every resource type
 * uniformly, since every `before`/`after` this codebase writes is either
 * `null` or a flat snapshot object (never an array, never deeply nested
 * beyond one `attributes`-shaped field — see UsersController.snapshotUser
 * and its siblings). Returns `[]` when neither side is a plain object (an
 * import:preview row's `after: { rowCount }` still qualifies; only a
 * genuinely absent/scalar before AND after produces no rows).
 */
export function buildDiffEntries(before: unknown, after: unknown): DiffEntry[] {
  const beforeObj = isPlainRecord(before) ? before : null
  const afterObj = isPlainRecord(after) ? after : null
  if (beforeObj === null && afterObj === null) return []

  const keys = new Set<string>([...(beforeObj ? Object.keys(beforeObj) : []), ...(afterObj ? Object.keys(afterObj) : [])])

  return [...keys].sort().map((key) => {
    const b = beforeObj ? beforeObj[key] : undefined
    const a = afterObj ? afterObj[key] : undefined
    return { key, before: b, after: a, changed: !valuesEqual(b, a) }
  })
}
