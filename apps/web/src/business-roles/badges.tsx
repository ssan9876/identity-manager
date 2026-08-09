import { draftStateOf, type BusinessRole, type DraftState } from './api'

/**
 * The business-role status vocabulary — docs/design-system.md: "word + optional
 * shape, never colour alone", and "the norm is uncoloured".
 *
 * TWO badges, not one, because a role carries two independent facts and
 * folding them into a single word would hide one of them. `Enabled` says
 * whether the role is granting anything at all; the draft badge says whether
 * there are unpublished changes and how far through the gate they are. A
 * role can perfectly well be enabled AND have a draft pending simulation,
 * and an admin needs to see both.
 */

const ENABLED_WORD = { true: 'Enabled', false: 'Disabled' } as const

/**
 * `Enabled` is the norm and takes no colour (the same reasoning that keeps
 * "Active" uncoloured on a person). `Disabled` earns --danger rather than
 * --warn because disable is a REVOCATION, not a pause: the role's grants are
 * gone, which is the same class of fact as a deactivated account.
 */
export function BusinessRoleStatusBadge({ enabled }: { enabled: boolean }) {
  const variant = enabled ? 'neutral' : 'danger'
  return (
    <span className={`badge badge--${variant}`} data-role-enabled={String(enabled)}>
      {!enabled && <span className="badge__dot" aria-hidden="true" />}
      {ENABLED_WORD[enabled ? 'true' : 'false']}
    </span>
  )
}

const DRAFT_WORD: Record<DraftState, string> = {
  none: 'No pending changes',
  'pending-simulation': 'Draft pending simulation',
  'ready-to-publish': 'Draft ready to publish',
}

const DRAFT_VARIANT: Record<DraftState, 'neutral' | 'warn' | 'brand'> = {
  none: 'neutral',
  // In flight and not yet safe to act on — docs/design-system.md's own --warn example.
  'pending-simulation': 'warn',
  // The one state where Publish is available; the badge and the primary
  // button agree, both in --primary.
  'ready-to-publish': 'brand',
}

export function DraftStateBadge({ role }: { role: Pick<BusinessRole, 'draftDefinition' | 'simulatedAt'> }) {
  const state = draftStateOf(role)
  const variant = DRAFT_VARIANT[state]
  return (
    <span className={`badge badge--${variant}`} data-draft-state={state}>
      {variant !== 'neutral' && <span className="badge__dot" aria-hidden="true" />}
      {DRAFT_WORD[state]}
    </span>
  )
}

/** The header sentence for each of the three states — docs/archive/plans/2026-08-08-business-roles-entitlements.md's own table, verbatim in spirit. */
export const DRAFT_HEADLINE: Record<DraftState, string> = {
  none: 'Published — no pending changes',
  'pending-simulation': 'Draft pending simulation',
  'ready-to-publish': 'Draft simulated — ready to publish',
}
