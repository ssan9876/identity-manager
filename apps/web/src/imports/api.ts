import { authorizedRequest } from '../api/client'

/** Mirrors `ImportRowFailure` (apps/api/src/imports/imports.controller.ts). */
export interface ImportRowFailure {
  row: number
  employeeId: string | null
  reasons: string[]
}

/** Mirrors `ImportPreviewCreateRow`. */
export interface ImportPreviewCreateRow {
  row: number
  employeeId: string
  primaryEmail: string
  username: string
}

/** Mirrors `ImportPreviewUpdateRow`. */
export interface ImportPreviewUpdateRow {
  row: number
  employeeId: string
  userId: string
  primaryEmail: string
  username: string
}

/** Mirrors `ImportPreviewResponse` — the three groups the diff renders: will create, will update, will fail. */
export interface ImportPreviewResponse {
  toCreate: ImportPreviewCreateRow[]
  toUpdate: ImportPreviewUpdateRow[]
  failures: ImportRowFailure[]
  summary: { toCreate: number; toUpdate: number; failed: number; total: number }
}

/** Mirrors `ImportCommitResponse`. `unchanged` counts a matched row whose resolved update was field-for-field identical to what's already stored — reported separately from `updated`, never silently folded into it. */
export interface ImportCommitResponse {
  batchId: string
  created: number
  updated: number
  unchanged: number
  failed: number
  failures: ImportRowFailure[]
}

/**
 * `POST /imports/preview` — writes nothing about a user (see
 * ImportsController.preview's own doc comment: the ONE write it performs is
 * a single per-INVOCATION audit row, never a per-row one, and never a user
 * create/update). This is the safety rail task-5-brief.md calls out — the
 * UI's job is to make that guarantee legible, not just rely on it silently.
 */
export function previewImport(accessToken: string, csv: string): Promise<ImportPreviewResponse> {
  return authorizedRequest<ImportPreviewResponse>('/imports/preview', accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csv }),
  })
}

/**
 * `POST /imports/commit` — a SEPARATE, deliberate call from `previewImport`
 * above, never chained automatically after it (task-5-brief.md: "Committing
 * is a separate, deliberate action — never automatic after preview"). Same
 * CSV text the preview was run against — ImportPage re-sends it verbatim
 * rather than trying to replay the preview's own parsed result, so commit
 * re-validates against the current state of the world (another admin may
 * have changed something in the gap between preview and commit) exactly
 * like the API's own `resolveRow` is shared, unmodified, between both
 * routes.
 */
export function commitImport(accessToken: string, csv: string): Promise<ImportCommitResponse> {
  return authorizedRequest<ImportCommitResponse>('/imports/commit', accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csv }),
  })
}

/**
 * Mirrors `REQUIRED_IMPORT_HEADERS`/the optional known headers
 * (apps/api/src/imports/import-row.ts) — presentation copy only, telling an
 * admin what to put in the file BEFORE they upload one. The server remains
 * the sole authority on validity; this list exists so the format is legible
 * up front rather than discovered one rejected row at a time.
 */
export const REQUIRED_CSV_COLUMNS = [
  'employeeId',
  'primaryEmail',
  'username',
  'firstName',
  'lastName',
  'orgUnitId',
] as const
export const OPTIONAL_CSV_COLUMNS = ['jobTitle', 'managerId', 'location', 'startDate', 'endDate'] as const

/**
 * Mirrors env.ts's `IMPORT_MAX_ROWS` default (5,000) — task-5-brief.md: "The
 * API caps row count and body size; surface those limits before the user
 * hits them rather than as a 400 after a long upload." A COURTESY limit
 * only: the server (ImportsController.parseAndPrepare) re-enforces its own
 * REAL, possibly-reconfigured limit regardless of what this constant says,
 * and its own 400 message is shown verbatim if this estimate ever
 * undercounts (see `estimateDataRowCount` below).
 */
export const IMPORT_MAX_ROWS = 5_000

/** Mirrors env.ts's `BODY_LIMIT_BYTES` default (10 MiB) — the whole JSON request body, of which the `csv` field is by far the dominant byte count for any realistically-sized file. Same courtesy-limit caveat as IMPORT_MAX_ROWS above. */
export const MAX_CSV_FILE_BYTES = 10 * 1024 * 1024

/**
 * A fast, APPROXIMATE data-row count — counts non-blank lines and subtracts
 * one for the header. Deliberately not a real CSV parse (quoted
 * multi-line fields would make a naive line count wrong in either
 * direction): this only gates a pre-upload WARNING so an admin does not
 * wait through a long upload just to hit a 400 at the end. The server's own
 * `parseCsv` + row-count check is the real, authoritative validation
 * either way — see `previewImport`'s own doc comment.
 */
export function estimateDataRowCount(csvText: string): number {
  const nonBlankLines = csvText.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0)
  return Math.max(0, nonBlankLines.length - 1)
}
