/**
 * The single JS source of truth for the two nav breakpoints docs/design-system.md
 * specifies ("collapses to an icon rail under 1100px, and behind a
 * disclosure under 780px"). Mirrored as literal px values in AppShell.css's
 * @media rules (CSS cannot read a custom property inside an @media
 * condition) and documented again in tokens.css — keep all three in sync if
 * either number ever changes.
 */
export const NAV_RAIL_MAX_WIDTH = 1099
export const NAV_DISCLOSURE_MAX_WIDTH = 779

export type NavMode = 'full' | 'rail' | 'disclosure'

export function navModeForWidth(width: number): NavMode {
  if (width <= NAV_DISCLOSURE_MAX_WIDTH) return 'disclosure'
  if (width <= NAV_RAIL_MAX_WIDTH) return 'rail'
  return 'full'
}
