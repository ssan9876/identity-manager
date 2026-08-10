import { z } from 'zod'
import { ValidationError } from '../common/errors'
import { noNulChar } from '../common/http/safe-string'
import { parseCsv, type ParsedCsv } from '../imports/csv'
import type { ImportPreviewResponse } from '../imports/imports.controller'
import {
  evaluateBlastRadius,
  type BlastRadiusEvaluation,
} from '../outbox/target-reconciliation.job'

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
