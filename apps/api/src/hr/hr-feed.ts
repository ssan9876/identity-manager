import { z } from 'zod'
import { ValidationError } from '../common/errors'
import { noNulChar } from '../common/http/safe-string'
import { parseCsv, type ParsedCsv } from '../imports/csv'
import type { ImportPreviewResponse } from '../imports/imports.controller'
import {
  evaluateBlastRadius,
  type BlastRadiusEvaluation,
} from '../outbox/target-reconciliation.job'
import {
  DEFAULT_HR_MAX_PAGES,
  HR_MAX_PAGES_CEILING,
  readPath,
  type HrJsonPagination,
} from './hr-fetch'

/**
 * PURE feed-transform and guard logic for HR inbound sync — no database, no
 * network, no clock. `HrSyncService` is the only production caller;
 * test/hr-feed.spec.ts exercises everything here directly.
 */

const MAPPING_KEY_MAX = 128

const mappingValueSchema = noNulChar(z.string().min(1).max(MAPPING_KEY_MAX))

/**
 * Validates a stored/submitted column mapping: flat string -> string, keyed
 * by SOURCE column name, valued with the import pipeline's column name the
 * source column becomes. Deliberately NOT a `z.record(...)` — the same
 * reasoning `parseConfigPatch` (connector-targets.controller.ts) sets out:
 * ZodRecord silently DROPS a key literally named `__proto__` rather than
 * rejecting it, the recurring defect class this project documents in
 * csv.ts/import-row.ts/attribute-validator.ts. Keys are copied via property
 * descriptors onto a null-prototype object so a genuine own `__proto__`
 * survives to be validated (and kept) like any other column name — a CSV
 * header really can be named anything.
 *
 * Duplicate TARGETS are rejected: two source columns mapped onto the same
 * import column would make the produced file's shape depend on object key
 * order, which is exactly the kind of silent ambiguity a per-row failure
 * can never surface.
 */
export function parseColumnMapping(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(['columnMapping: must be an object mapping source columns to import columns'])
  }

  const payload: Record<string, unknown> = Object.create(null)
  Object.defineProperties(payload, Object.getOwnPropertyDescriptors(value))

  const issues: string[] = []
  const result: Record<string, string> = Object.create(null)
  const targetsSeen = new Map<string, string>()

  for (const key of Object.keys(payload)) {
    const keyCheck = mappingValueSchema.safeParse(key)
    if (!keyCheck.success) {
      issues.push(`columnMapping: source column "${key}" ${keyCheck.error.issues[0]?.message ?? 'is invalid'}`)
      continue
    }
    const valueCheck = mappingValueSchema.safeParse(payload[key])
    if (!valueCheck.success) {
      issues.push(`columnMapping.${key}: ${valueCheck.error.issues[0]?.message ?? 'is invalid'}`)
      continue
    }
    const target = valueCheck.data
    const firstSource = targetsSeen.get(target)
    if (firstSource !== undefined) {
      issues.push(
        `columnMapping.${key}: duplicate target column "${target}" (already produced by source column "${firstSource}")`,
      )
      continue
    }
    targetsSeen.set(target, key)
    result[key] = target
  }

  if (issues.length > 0) throw new ValidationError(issues)
  return result
}

/** Minimal CSV quoting — the exact inverse of what `parseCsv` (csv-parse) accepts; round-tripped in test/hr-feed.spec.ts. */
function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export function serializeCsv(headers: readonly string[], rows: ReadonlyArray<Record<string, string>>): string {
  const lines = [headers.map(csvEscape).join(',')]
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header] ?? '')).join(','))
  }
  return lines.join('\n')
}

/**
 * Applies a source's column mapping to a parsed feed: every MAPPED source
 * column is renamed to its import-pipeline name; every UNMAPPED source
 * column is DROPPED. The drop is deliberate and load-bearing: an HR export
 * carries dozens of payroll/benefits columns this system has no business
 * ingesting, and the import pipeline treats every unknown header as a
 * custom attribute whose validation then fails EVERY row
 * (import-row.ts's `extraHeaders`). The mapping is therefore the explicit,
 * closed statement of what crosses the boundary — including identity
 * mappings for columns whose feed name already matches (e.g.
 * `employeeId: employeeId`).
 *
 * A mapped source column missing from the feed's header is a whole-file
 * error, not a per-row one — the file structurally cannot satisfy the
 * mapping, same class as `missingRequiredHeaders`.
 */
export function applyColumnMapping(parsed: ParsedCsv, mapping: Record<string, string>): ParsedCsv {
  const sourceColumns = Object.keys(mapping)
  const missing = sourceColumns.filter((column) => !parsed.headers.includes(column))
  if (missing.length > 0) {
    throw new ValidationError([
      `feed: mapped source column(s) missing from the feed header: ${missing.join(', ')}`,
    ])
  }

  const headers = sourceColumns.map((column) => mapping[column])
  const rows = parsed.rows.map((row) => {
    // Object.create(null) — same reason as csv.ts's own row object: a
    // mapped TARGET header named `__proto__` must become a genuine own key,
    // not a silent no-op through an inherited accessor.
    const mapped: Record<string, string> = Object.create(null)
    for (const column of sourceColumns) {
      mapped[mapping[column]] = row[column] ?? ''
    }
    return mapped
  })

  return { headers, rows }
}

/** Fetch text -> mapped CSV text, ready for the import pipeline's `{ csv }` body — parse and mapping errors surface as ValidationError, exactly like the pipeline's own structural errors. */
export function mapFeedCsv(feedCsv: string, mapping: Record<string, string>): string {
  const mapped = applyColumnMapping(parseCsv(feedCsv), mapping)
  return serializeCsv(mapped.headers, mapped.rows)
}

/**
 * The JSON counterpart of `applyColumnMapping` + `serializeCsv`: fetched
 * records -> the SAME mapped CSV text `mapFeedCsv` produces, so a
 * `rest_json` source rejoins the existing pipeline at exactly the point a
 * `csv_url` source does. Everything downstream — preview, per-row
 * validation, the row cap, the blast-radius guard, commit — is reused
 * untouched and cannot tell the two kinds apart. That is the whole point: a
 * second feed kind must not become a second code path through the parts
 * that actually write to people.
 *
 * The mapping's SOURCE keys are dot-paths into each record (`name.first`,
 * `emails.0.value`), resolved through `hr-fetch.ts`'s `readPath` — own
 * properties and array indices only, never an inherited member. Its TARGET
 * values are import-pipeline column names, exactly as for CSV. Unmapped
 * fields are DROPPED, for the identical reason `applyColumnMapping`
 * documents: an HR API's payload carries dozens of payroll/benefits fields
 * this system has no business ingesting, and the pipeline treats every
 * unknown header as a custom attribute whose validation then fails every
 * row.
 *
 * Two whole-file errors, both deliberately NOT per-row:
 *
 *  - A mapped path absent from EVERY record. This is the JSON analogue of
 *    `applyColumnMapping`'s missing-header error and means the same thing —
 *    the mapping does not describe this feed. Absent from SOME records is
 *    normal (optional fields) and yields an empty value, which the pipeline
 *    then validates per row as it always has.
 *  - A mapped path that resolves to an object or array. The pipeline's
 *    columns are flat strings, so there is no honest coercion: silently
 *    writing `[object Object]` would corrupt a person's record, and blanking
 *    it would be quiet data loss. A subtree at a mapped path means the PATH
 *    is wrong, which is structural, not row-specific.
 */
export function mapJsonFeed(records: readonly unknown[], mapping: Record<string, string>): string {
  const sourcePaths = Object.keys(mapping)
  const headers = sourcePaths.map((path) => mapping[path])
  const seen = new Set<string>()
  const issues: string[] = []

  const rows = records.map((record, index) => {
    // Object.create(null) — same reason as csv.ts's own row object and
    // `applyColumnMapping`'s: a mapped TARGET header named `__proto__` must
    // become a genuine own key, not a silent no-op through an inherited
    // accessor.
    const row: Record<string, string> = Object.create(null)
    for (const path of sourcePaths) {
      const value = readPath(record, path)
      if (value === undefined || value === null) {
        row[mapping[path]] = ''
        continue
      }
      seen.add(path)
      if (typeof value === 'object') {
        issues.push(
          `feed: mapped path "${path}" resolves to ${Array.isArray(value) ? 'an array' : 'an object'} ` +
            `in record ${index + 1} — map a scalar field, not a subtree`,
        )
        row[mapping[path]] = ''
        continue
      }
      // string / number / boolean, stringified exactly as the pipeline would
      // have received them in a CSV cell.
      row[mapping[path]] = String(value)
    }
    return row
  })

  if (records.length > 0) {
    const neverSeen = sourcePaths.filter((path) => !seen.has(path))
    if (neverSeen.length > 0) {
      issues.push(`feed: mapped path(s) absent from every record: ${neverSeen.join(', ')}`)
    }
  }

  // Report at most a handful — a wrong mapping against a 10,000-person feed
  // would otherwise produce one issue per record, which is unreadable and
  // says nothing the first few do not.
  if (issues.length > 0) throw new ValidationError(issues.slice(0, 5))

  return serializeCsv(headers, rows)
}

/** Applied when a `rest_json` source names no pagination — one request, no paging. */
const DEFAULT_PAGINATION: HrJsonPagination = { mode: 'none' }

const paginationSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({
    mode: z.literal('page'),
    pageParam: mappingValueSchema,
    startPage: z.number().int().min(0).default(1),
    sizeParam: mappingValueSchema.nullable().default(null),
    pageSize: z.number().int().min(1).max(10_000).nullable().default(null),
    maxPages: z.number().int().min(1).max(HR_MAX_PAGES_CEILING).default(DEFAULT_HR_MAX_PAGES),
  }),
  z.object({
    mode: z.literal('cursor'),
    nextPath: mappingValueSchema,
    cursorParam: mappingValueSchema.nullable().default(null),
    maxPages: z.number().int().min(1).max(HR_MAX_PAGES_CEILING).default(DEFAULT_HR_MAX_PAGES),
  }),
])

const jsonFeedConfigSchema = z
  .object({
    /** The empty string means the response body IS the record array. */
    recordsPath: noNulChar(z.string().max(MAPPING_KEY_MAX)).default(''),
    pagination: paginationSchema.default(DEFAULT_PAGINATION),
  })
  .strict()

export interface JsonFeedConfig {
  recordsPath: string
  pagination: HrJsonPagination
}

/**
 * Validates the `rest_json` half of `hr_sources.config`. The pagination
 * union is CLOSED and parsed HERE, so `HrSyncService` never dispatches on a
 * raw mode string read back out of jsonb — the same discipline as the source
 * `kind` lookup itself, and the reason `HrJsonPagination` is a discriminated
 * union rather than a bag of optional fields.
 */
export function parseJsonFeedConfig(value: unknown): JsonFeedConfig {
  const parsed = jsonFeedConfigSchema.safeParse(value ?? {})
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((issue) => `config.${issue.path.join('.') || 'root'}: ${issue.message}`),
    )
  }
  return parsed.data
}

export interface HrGuardConfig {
  blastRadiusThreshold: number
  blastRadiusFloor: number
}

export interface HrGuardOverrides {
  /** Commit the non-failing rows even though some rows failed the preview. Default: any failing row aborts. */
  allowPartial?: boolean
  /** Proceed even though the blast-radius guard tripped. Default: a tripped guard aborts. */
  force?: boolean
}

export interface HrGuardDecision {
  /** `null` — proceed to commit. Otherwise the outcome that aborts the run. */
  abort: 'aborted_failures' | 'aborted_blast_radius' | null
  reasons: string[]
  blastRadius: BlastRadiusEvaluation
}

/**
 * The commit gate — evaluated between preview and commit, PURE so it is
 * exhaustively unit-testable. Two independent rails:
 *
 *  1. FAILING ROWS: the default threshold is zero — any failing row aborts
 *     the whole commit and reports, so a feed that suddenly ships garbage
 *     never half-applies. `allowPartial` is the operator's explicit,
 *     per-run override to commit the rows that DID resolve.
 *
 *  2. BLAST RADIUS: `evaluateBlastRadius` — the exact function
 *     `TargetReconciliationJob` uses, percentage AND floor, not a copy —
 *     over the preview's would-be UPDATES against the organization's
 *     existing population. A feed that suddenly wants to change (or, via
 *     endDate, deactivate) a large fraction of existing people is refused
 *     and reported rather than committed; `force` is the explicit override,
 *     mirroring the reconcile job's own. Creates are deliberately not
 *     counted: a brand-new feed onboarding a directory legitimately creates
 *     everyone once, and creating cannot damage an EXISTING person.
 *     Note the preview's `toUpdate` includes rows that would prove no-ops
 *     at commit time (the pipeline only detects no-ops during commit), so
 *     an identical re-run of a large feed can trip this guard — that
 *     false-positive costs one explicit `force`, which is the fail-safe
 *     direction.
 */
export function evaluateHrRun(
  preview: Pick<ImportPreviewResponse, 'summary'>,
  populationSize: number,
  config: HrGuardConfig,
  overrides: HrGuardOverrides = {},
): HrGuardDecision {
  const reasons: string[] = []

  const blastRadius = evaluateBlastRadius(
    preview.summary.toUpdate,
    populationSize,
    config.blastRadiusThreshold,
    config.blastRadiusFloor,
  )

  if (preview.summary.failed > 0 && overrides.allowPartial !== true) {
    reasons.push(
      `${preview.summary.failed} of ${preview.summary.total} row(s) failed the preview — refusing to commit; ` +
        're-run with allow-partial to commit the rows that did resolve',
    )
    return { abort: 'aborted_failures', reasons, blastRadius }
  }

  if (blastRadius.tripped && overrides.force !== true) {
    reasons.push(
      `blast-radius guard tripped: the feed would update ${blastRadius.changedCount} of ` +
        `${blastRadius.populationSize} existing people (threshold ${blastRadius.thresholdPercent}%, ` +
        `floor ${blastRadius.floor}) — refusing to commit; re-run with force to override`,
    )
    return { abort: 'aborted_blast_radius', reasons, blastRadius }
  }

  return { abort: null, reasons, blastRadius }
}
