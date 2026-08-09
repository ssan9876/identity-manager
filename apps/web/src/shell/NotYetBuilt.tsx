/**
 * An honest "coming in a later task" state — docs/design-system.md/task-2-brief.md:
 * nav items with no screen behind them yet must stay visible (never a dead
 * link) and say plainly what they are and that they're not built yet,
 * rather than 404ing or silently doing nothing. Used both for whole nav
 * destinations (Groups, Org units, Roles, Import, Audit — Milestone 8
 * builds each in a later task per docs/archive/plans/2026-08-06-idp-
 * milestone-8-admin-console.md) and for the Person detail page's Roles/
 * Activity tabs, which have the same shape of gap: no read endpoint exists
 * for either yet (role assignments and the audit log both arrive in later
 * tasks of this same milestone).
 */
export function NotYetBuilt({ title, note }: { title: string; note: string }) {
  return (
    <div className="not-yet-built" role="status">
      <h2 className="text-title">{title}</h2>
      <p>{note}</p>
    </div>
  )
}
