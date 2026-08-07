/** A timestamp (createdAt/updatedAt/deactivatedAt, ...) — full date + time, in the viewer's own locale/timezone. Moved out of PersonDetailPage.tsx (Milestone 8, Task 2) so OrgUnitsPage.tsx (Task 3) formats timestamps the same way rather than growing a second copy. */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

/**
 * A plain `YYYY-MM-DD` value (startDate/endDate — no time component, no
 * timezone). Parsing with an explicit UTC anchor avoids the classic
 * "renders as the previous day" bug from letting `new Date('2026-01-01')`
 * get interpreted in the browser's local timezone and then reformatted in
 * that same local timezone (a no-op) VS. an environment where the two
 * disagree.
 */
export function formatDateOnly(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    dateStyle: 'medium',
    timeZone: 'UTC',
  })
}
