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
    const row: Record<string, string> = {}
    headers.forEach((header, i) => {
      row[header] = line[i] ?? ''
    })
    return row
  })

  return { headers, rows }
}
