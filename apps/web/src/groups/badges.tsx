import type { Group } from './api'

/**
 * A group's scope indicator — task-4-brief.md: "Remember a group with
 * org_unit_id = NULL is global... Make that status visible in the UI." This
 * is the ONE place that decides how "global" renders, reused by the list
 * table, the detail page's Overview tab, and the edit page's read-only
 * scope line, so the three can never describe the same group differently.
 *
 * Global is rendered as the WORD "Global" in an uncoloured badge — same
 * convention PersonDetailPage's own GroupsTab already established for this
 * exact case (DESIGN.md: status is never colour alone, and "global" is not
 * even an exception state to begin with, just a fact worth naming). A
 * scoped group renders its mono org unit path instead of a badge — the path
 * itself already answers "which scope", so wrapping it in a second, redundant
 * "Scoped" badge would be noise DESIGN.md's own "colour marks the exception"
 * principle argues against.
 */
export function GroupScopeBadge({ group, orgUnitPath }: { group: Group; orgUnitPath: string | null }) {
  if (group.orgUnitId === null) {
    return (
      <span className="badge badge--neutral" data-testid="group-scope-badge" data-scope="global">
        Global
      </span>
    )
  }
  return (
    <span className="mono cell-muted" data-testid="group-scope-badge" data-scope="scoped">
      {orgUnitPath ?? group.orgUnitId}
    </span>
  )
}
