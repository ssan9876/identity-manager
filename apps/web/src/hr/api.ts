import { authorizedRequest } from '../api/client'

/** Mirrors `hr_run_outcome` (apps/api/src/db/schema/hr-sources.ts) — no shared package between the apps, so update BY HAND when the enum grows, same caveat as connectors/api.ts's target list. */
export type HrRunOutcome =
  | 'fetch_failed'
  | 'preview_failed'
  | 'previewed'
  | 'aborted_failures'
  | 'aborted_blast_radius'
  | 'committed'
  | 'committed_partial'

/** Mirrors `HrSourceView` (apps/api/src/hr/hr-sources.controller.ts). `authSecretName` is the NAME of a CONNECTOR_* environment variable — a reference, never a credential value; no credential is ever stored or returned by the API (see that view's own doc comment). */
export interface HrSourceView {
  id: string
  organizationId: string
  name: string
  kind: 'csv_url'
  url: string
  authHeaderName: string | null
  authSecretName: string | null
  columnMapping: Record<string, string>
  enabled: boolean
  blastRadiusThreshold: number
  blastRadiusFloor: number
  lastRunStartedAt: string | null
  lastRunFinishedAt: string | null
  lastRunOutcome: HrRunOutcome | null
  lastRunCounts: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

/** Mirrors `HrSourceRunView`. */
export interface HrSourceRunView {
  at: string
  actorUserId: string | null
  batchId: string | null
  detail: Record<string, unknown> | null
}

/** Mirrors the relevant slice of `HrSyncReport` (apps/api/src/hr/hr-sync.service.ts) — a preview run's result. */
export interface HrSyncReport {
  sourceId: string
  sourceName: string
  outcome: HrRunOutcome
  preview: {
    toCreate: Array<{ row: number; employeeId: string; primaryEmail: string; username: string }>
    toUpdate: Array<{ row: number; employeeId: string; userId: string; primaryEmail: string; username: string }>
    failures: Array<{ row: number; employeeId: string | null; reasons: string[] }>
    summary: { toCreate: number; toUpdate: number; failed: number; total: number }
  } | null
  blastRadius: {
    tripped: boolean
    changedCount: number
    populationSize: number
    thresholdPercent: number
    floor: number
  } | null
  reasons: string[]
  batchId: string | null
}

export interface HrSourceAuth {
  headerName: string
  secretName: string
}

export interface CreateHrSourceInput {
  organizationId: string
  name: string
  kind: 'csv_url'
  url: string
  auth: HrSourceAuth | null
  columnMapping: Record<string, string>
}

export interface UpdateHrSourceInput {
  name?: string
  url?: string
  auth?: HrSourceAuth | null
  columnMapping?: Record<string, string>
  enabled?: boolean
  blastRadiusThreshold?: number
  blastRadiusFloor?: number
}

export function fetchHrSources(accessToken: string): Promise<HrSourceView[]> {
  return authorizedRequest<HrSourceView[]>('/hr-sources', accessToken)
}

export function fetchHrSource(accessToken: string, id: string): Promise<HrSourceView> {
  return authorizedRequest<HrSourceView>(`/hr-sources/${id}`, accessToken)
}

export function fetchHrSourceRuns(accessToken: string, id: string): Promise<HrSourceRunView[]> {
  return authorizedRequest<HrSourceRunView[]>(`/hr-sources/${id}/runs`, accessToken)
}

export function createHrSource(accessToken: string, input: CreateHrSourceInput): Promise<HrSourceView> {
  return authorizedRequest<HrSourceView>('/hr-sources', accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function updateHrSource(
  accessToken: string,
  id: string,
  patch: UpdateHrSourceInput,
): Promise<HrSourceView> {
  return authorizedRequest<HrSourceView>(`/hr-sources/${id}`, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/** "Run preview now" — never a commit; commits are the `hr:sync --commit` CLI's job. */
export function runHrSourcePreview(accessToken: string, id: string): Promise<HrSyncReport> {
  return authorizedRequest<HrSyncReport>(`/hr-sources/${id}/preview`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
}
