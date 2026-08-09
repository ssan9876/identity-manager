import type { SyncState, UserStatus } from './api'

/**
 * Status/sync badges — docs/design-system.md: "word + optional shape, never colour
 * alone. Active is uncoloured." Both badges always render their word as
 * plain text in --ink (see styles/components.css's file header for why:
 * --warn text directly on --warn-bg measures under the 4.5:1 body-text
 * floor). Colour is carried by the background tint plus a small decorative
 * dot — never the word's own colour, and never the sole signal.
 */

const STATUS_WORD: Record<UserStatus, string> = {
  pending: 'Pending',
  active: 'Active',
  suspended: 'Suspended',
  deactivated: 'Deactivated',
}

// 'active' is the uncoloured norm (docs/design-system.md). 'pending'/'suspended' are
// reversible, in-flight states -> warn (docs/design-system.md's own example: "pending,
// sync in flight"). 'deactivated' is terminal -> danger (docs/design-system.md's own
// example: "deactivate, destructive, sync failed").
const STATUS_VARIANT: Record<UserStatus, 'neutral' | 'warn' | 'danger'> = {
  pending: 'warn',
  active: 'neutral',
  suspended: 'warn',
  deactivated: 'danger',
}

export function StatusBadge({ status }: { status: UserStatus }) {
  const variant = STATUS_VARIANT[status]
  return (
    <span className={`badge badge--${variant}`} data-status={status}>
      {variant !== 'neutral' && <span className="badge__dot" aria-hidden="true" />}
      {STATUS_WORD[status]}
    </span>
  )
}

// Exported (not module-private, unlike STATUS_WORD/STATUS_VARIANT above) so
// the deactivate confirmation's post-action toast (PersonDetailPage,
// Milestone 8 Task 3) reports the sync outcome in the EXACT same words the
// badge next to this same person's row will show a moment later — one
// vocabulary for "what is the sync state", never a second, hand-written copy
// that could drift from this one.
export const SYNC_WORD: Record<SyncState, string> = {
  pending: 'Sync pending',
  synced: 'Synced',
  failed: 'Sync failed',
}

// 'synced' (healthy) mirrors 'active' — the norm, uncoloured. docs/design-system.md's
// own examples name both the other two directly: "pending, sync in
// flight" -> warn; "sync failed" -> danger. docs/product-brief.md's #2 requirement
// ("a user who looks healthy while their group sync dead-lettered is the
// worst outcome this product can produce") is exactly why this is its own
// badge, separate from account status, rather than folded into it.
export const SYNC_VARIANT: Record<SyncState, 'neutral' | 'warn' | 'danger'> = {
  pending: 'warn',
  synced: 'neutral',
  failed: 'danger',
}

export function SyncBadge({ state }: { state: SyncState }) {
  const variant = SYNC_VARIANT[state]
  return (
    <span className={`badge badge--${variant}`} data-sync-state={state}>
      {variant !== 'neutral' && <span className="badge__dot" aria-hidden="true" />}
      {SYNC_WORD[state]}
    </span>
  )
}
