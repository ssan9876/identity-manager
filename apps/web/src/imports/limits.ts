/**
 * The two COURTESY limits the import page shows before an upload, kept in a
 * module of their own with NO imports at all.
 *
 * Split out of ./api.ts so a Playwright spec can import them. That file
 * reaches `auth/oidc-config` through `api/client`, and oidc-config reads
 * `import.meta.env` — Vite syntax that Playwright's Node transform cannot
 * parse, so importing a plain number from there brought the entire e2e suite
 * down with a syntax error before a single test ran.
 *
 * Worth the split rather than a literal in the spec: e2e/import.spec.ts
 * hard-coded `5,000` against a limit that has been 1,000 since the per-row
 * lookups were batched, and failed on every run for months while looking like
 * a product regression. A number with one definition cannot drift from
 * itself.
 */
/**
 * Mirrors env.ts's `IMPORT_MAX_ROWS` default (1,000) — task-5-brief.md: "The
 * API caps row count and body size; surface those limits before the user
 * hits them rather than as a 400 after a long upload." A COURTESY limit
 * only: the server (ImportsController.parseAndPrepare) re-enforces its own
 * REAL, possibly-reconfigured limit regardless of what this constant says,
 * and its own 400 message is shown verbatim if this estimate ever
 * undercounts (see `estimateDataRowCount` below).
 */
export const IMPORT_MAX_ROWS = 1_000

/** Mirrors env.ts's `BODY_LIMIT_BYTES` default (10 MiB) — the whole JSON request body, of which the `csv` field is by far the dominant byte count for any realistically-sized file. Same courtesy-limit caveat as IMPORT_MAX_ROWS above. */
export const MAX_CSV_FILE_BYTES = 10 * 1024 * 1024
