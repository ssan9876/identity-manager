import { parse } from 'csv-parse/sync'
import { ValidationError } from '../common/errors'

export interface ParsedCsv {
  /** Column names, in file order, exactly as they appear in the header row (trimmed). */
  headers: string[]
  /** One entry per data row (the header is excluded), each keyed by header name. */
  rows: Array<Record<string, string>>
}

/**
 * Turns raw CSV text into a header list and an array of header-keyed data
 * rows. Deliberately does NOT use csv-parse's own `columns: true` mode: that
 * mode loses the header list entirely once there are zero data rows (a
 * legitimate "header-only" file — see the empty-vs-header-only distinction
 * below), so this parses in raw array-of-arrays mode instead and zips each
 * data row against the header row itself, which keeps the header list
 * available regardless of how many data rows follow.
 *
 * Never throws anything but ValidationError. Every malformed-input case this
 * milestone's brief calls out — an unterminated quote, a row whose column
 * count disagrees with the header's, or a totally empty/whitespace-only file
 * — is caught here and re-thrown as a ValidationError, which
 * DomainExceptionFilter maps to 400 VALIDATION_FAILED, never an unmapped
 * 500. Confirmed empirically against the installed csv-parse (see
 * task-1-2-report.md): it already enforces consistent column count across
 * every row relative to the first, already strips a leading UTF-8 BOM
 * (`bom: true`), and already treats CRLF and LF as equivalent line endings
 * — none of that needs hand-rolling here.
 *
 * A file containing ONLY a header row (zero data rows) is NOT malformed — it
 * parses to `{ headers: [...], rows: [] }`, a legitimate empty batch. Only a
 * totally empty or whitespace-only file (zero rows AT ALL, not even a
 * header) is treated as an error, since then there is no header to derive
 * column names from at all.
 */
export function parseCsv(content: string): ParsedCsv {
  let matrix: string[][]
  try {
    matrix = parse(content, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
    }) as string[][]
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new ValidationError([`csv: malformed CSV — ${message}`])
  }

  if (matrix.length === 0) {
    throw new ValidationError(['csv: file is empty'])
  }

  const headers = matrix[0]
  const rows = matrix.slice(1).map((line) => {
    // Object.create(null), not {}: a header literally named "__proto__" is
    // legitimate, attacker-controlled input this function must not treat
    // specially. On an ordinary {}, `row['__proto__'] = line[i]` invokes
    // Object.prototype's __proto__ ACCESSOR SETTER instead of creating an
    // own property — a silent no-op for a string value (the spec-defined
    // behaviour) — so the header's cell value simply vanishes: no own key
    // is ever created, `Object.entries(row)` never sees it, yet
    // extraHeaders() (which works off the header STRING list, not this
    // object) still correctly counts it as an extra column. That mismatch
    // is what let a `__proto__` CSV column silently wipe a matched user's
    // `attributes` to `{}` (docs/archive/audits/audit-injection.md HIGH
    // finding — the fourth recurrence of this defect class in this
    // project). A null-prototype object has no inherited __proto__ setter,
    // so the assignment below always creates a genuine own property
    // regardless of the header's name, exactly like buildAttributeSchema's
    // own shape object (attribute-validator.ts).
    const row: Record<string, string> = Object.create(null)
    headers.forEach((header, i) => {
      row[header] = line[i] ?? ''
    })
    return row
  })

  return { headers, rows }
}
