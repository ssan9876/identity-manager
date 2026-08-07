import { buildDiffEntries, formatDiffValue, humanizeFieldKey } from './api'

/**
 * Renders one audit row's `before`/`after` readably — task-5-brief.md: "with
 * before/after rendered readably rather than as raw JSON blobs." Three
 * shapes, decided by which side is present:
 *  - CREATE (`before` null): every `after` field, flat "Field: value" list —
 *    nothing to diff against, so nothing is marked changed.
 *  - REMOVAL (`after` null — e.g. `group:remove_child_group`): the same flat
 *    list, but built from `before`.
 *  - UPDATE (both present): a Field/Before/After table, but ONLY for fields
 *    that actually differ — "what changed," matching PRODUCT.md's own
 *    framing ("who did that, and what changed") — with every OTHER field
 *    still available, never hidden, behind a collapsed "Show unchanged
 *    fields" disclosure for an auditor who wants to confirm nothing else
 *    moved.
 *
 * Every branch shares ONE outer `.audit-diff` wrapper (never returns a bare
 * fragment/element of its own) — visual-pass finding: this renders inside a
 * `<td colSpan>` of a horizontally-scrollable `.table-wrap`, and only the
 * OUTERMOST element gets the CSS that keeps it pinned to the visible left
 * edge regardless of the table's current scroll position (AuditPage.css's
 * own doc comment on `.audit-diff` has the full story). A per-branch class
 * on three DIFFERENT top-level elements — the bug as first shipped — means
 * two of the three branches render pinned and the third renders wherever
 * the table happened to be scrolled, invisible exactly when a narrow
 * viewport auto-scrolled the table to reach the trailing "Details" toggle.
 */
export function AuditDiff({ before, after }: { before: unknown; after: unknown }) {
  const entries = buildDiffEntries(before, after)

  if (entries.length === 0) {
    return (
      <div className="audit-diff">
        <p className="cell-muted">No further detail recorded for this entry.</p>
      </div>
    )
  }

  const isCreate = before === null || before === undefined
  const isRemoval = after === null || after === undefined

  if (isCreate || isRemoval) {
    return (
      <div className="audit-diff">
        <dl className="detail-grid audit-diff__fields" data-testid="audit-diff-single">
          {entries.map((entry) => (
            <div key={entry.key}>
              <dt>{humanizeFieldKey(entry.key)}</dt>
              <dd>{formatDiffValue(isCreate ? entry.after : entry.before)}</dd>
            </div>
          ))}
        </dl>
      </div>
    )
  }

  const changed = entries.filter((entry) => entry.changed)
  const unchanged = entries.filter((entry) => !entry.changed)

  return (
    <div className="audit-diff" data-testid="audit-diff-update">
      {changed.length === 0 ? (
        <p className="cell-muted">No fields changed.</p>
      ) : (
        <table className="audit-diff__table" data-testid="audit-diff-changed-table">
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Before</th>
              <th scope="col">After</th>
            </tr>
          </thead>
          <tbody>
            {changed.map((entry) => (
              <tr key={entry.key}>
                <td>{humanizeFieldKey(entry.key)}</td>
                <td>{formatDiffValue(entry.before)}</td>
                <td>{formatDiffValue(entry.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {unchanged.length > 0 && (
        <details className="audit-diff__unchanged">
          <summary>Show unchanged fields ({unchanged.length})</summary>
          <dl className="detail-grid audit-diff__fields">
            {unchanged.map((entry) => (
              <div key={entry.key}>
                <dt>{humanizeFieldKey(entry.key)}</dt>
                <dd>{formatDiffValue(entry.after)}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  )
}
