import { z } from 'zod'
import { noNulChar } from '../common/http/safe-string'

/**
 * The columns every import row MUST supply. `employeeId` is required here
 * even though it is optional on the JSON `POST /users` create body
 * (createUserBodySchema) — bulk import's whole idempotency contract
 * ("existing employee_id -> update, new -> create", task-2-brief.md) is
 * matched on this field, so a row without one has no way to be matched on
 * re-run and no meaning in this endpoint's model at all.
 */
export const REQUIRED_IMPORT_HEADERS = [
  'employeeId',
  'primaryEmail',
  'username',
  'firstName',
  'lastName',
  'orgUnitId',
] as const

const OPTIONAL_KNOWN_HEADERS = ['jobTitle', 'managerId', 'location', 'startDate', 'endDate'] as const

const KNOWN_HEADERS = new Set<string>([...REQUIRED_IMPORT_HEADERS, ...OPTIONAL_KNOWN_HEADERS])

/** Every required column not present in this file's header row (structural — whole-file). */
export function missingRequiredHeaders(headers: readonly string[]): string[] {
  return REQUIRED_IMPORT_HEADERS.filter((header) => !headers.includes(header))
}

/**
 * Columns beyond the fixed/known set, in file order. Each becomes a custom
 * attribute key (see ImportsController's doc comment on how these feed
 * `validateAttributes`) — an admin who mistypes a known column name (e.g.
 * `orgunitid`) gets a clear "unrecognized attribute" validation failure per
 * row rather than the column being silently ignored.
 */
export function extraHeaders(headers: readonly string[]): string[] {
  return headers.filter((header) => !KNOWN_HEADERS.has(header))
}

// YYYY-MM-DD shape only — same convention and same scope decision as
// users.controller.ts's own isoDateSchema (see that file's comment): full
// calendar validity is Postgres's job at write time.
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)')

// noNulChar wraps every free-text field below (never orgUnitId/managerId,
// already UUID-constrained, or startDate/endDate, already ISO-date-regex-
// constrained — neither shape can contain a NUL and pass) — see
// docs/archive/audits/audit-injection.md's HIGH "JSON-escaped NUL" finding and
// safe-string.ts's own doc comment for why this must be rejected here,
// before a row can ever reach Postgres.
const shapeSchema = z.object({
  employeeId: noNulChar(z.string().min(1, 'required')),
  primaryEmail: noNulChar(z.string().min(1, 'required').max(320).email('must be a well-formed email')),
  username: noNulChar(z.string().min(1, 'required').max(128)),
  firstName: noNulChar(z.string().min(1, 'required').max(128)),
  lastName: noNulChar(z.string().min(1, 'required').max(128)),
  orgUnitId: z.string().min(1, 'required').uuid('must be a UUID'),
  jobTitle: noNulChar(z.string().max(255)).nullable(),
  managerId: z.string().uuid('must be a UUID').nullable(),
  location: noNulChar(z.string().max(255)).nullable(),
  startDate: isoDateSchema.nullable(),
  endDate: isoDateSchema.nullable(),
})

export type ShapeParsedRow = z.infer<typeof shapeSchema> & {
  /**
   * Raw (trimmed, non-empty) string values keyed by extra-header name.
   * `undefined` — not `{}` — when the FILE has no extra headers at all, so a
   * downstream update-row can tell "this import says nothing about
   * attributes" (leave the stored value untouched) apart from "this import
   * explicitly supplies zero attributes" (`{}`, which — same as the JSON
   * PATCH contract — replaces the stored object wholesale). See
   * ImportsController's doc comment.
   */
  rawAttributes: Record<string, string> | undefined
}

function emptyToNull(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Shape-validates ONE CSV row: required-field presence, UUID/email/date
 * format. Pure — no DB access, no permission checks, no existence checks.
 * Resolvability (does this org unit/manager id actually exist?), scope, and
 * collision checks are SEMANTIC checks the caller performs separately
 * because they need a repository — see ImportsController.resolveRow. Never
 * throws; returns a discriminated result so a caller can accumulate a
 * per-row failure without a try/catch.
 *
 * `fileHasExtraHeaders` is computed once per file (`extraHeaders(headers).length
 * > 0`) and passed in for every row, rather than re-derived per row, so the
 * undefined-vs-{} distinction on `rawAttributes` depends on the FILE's
 * header shape, never on which cells one particular row happens to leave
 * blank.
 */
export function parseImportRowShape(
  raw: Record<string, string>,
  fileHasExtraHeaders: boolean,
): { ok: true; row: ShapeParsedRow } | { ok: false; issues: string[] } {
  const normalized = {
    employeeId: (raw.employeeId ?? '').trim(),
    primaryEmail: (raw.primaryEmail ?? '').trim(),
    username: (raw.username ?? '').trim(),
    firstName: (raw.firstName ?? '').trim(),
    lastName: (raw.lastName ?? '').trim(),
    orgUnitId: (raw.orgUnitId ?? '').trim(),
    jobTitle: emptyToNull(raw.jobTitle),
    managerId: emptyToNull(raw.managerId),
    location: emptyToNull(raw.location),
    startDate: emptyToNull(raw.startDate),
    endDate: emptyToNull(raw.endDate),
  }

  const result = shapeSchema.safeParse(normalized)
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map(
        (issue) => `${issue.path.join('.') || 'row'}: ${issue.message}`,
      ),
    }
  }

  let rawAttributes: Record<string, string> | undefined
  if (fileHasExtraHeaders) {
    // Object.create(null), not {} — same reason as csv.ts's own row object
    // (see its doc comment): `raw` now correctly carries a genuine own
    // "__proto__" key when that's the header name (csv.ts's fix), and
    // `rawAttributes[key] = trimmed` below must not silently swallow it a
    // SECOND time on its way into this bag. This was the second of the two
    // sites the audit named (csv.ts:55-61 and here) — fixing only one and
    // not the other leaves the exact same silent-elision bug one hop later.
    rawAttributes = Object.create(null) as Record<string, string>
    for (const [key, value] of Object.entries(raw)) {
      if (KNOWN_HEADERS.has(key)) continue
      const trimmed = value.trim()
      if (trimmed !== '') {
        rawAttributes[key] = trimmed
      }
    }
  }

  return { ok: true, row: { ...result.data, rawAttributes } }
}
