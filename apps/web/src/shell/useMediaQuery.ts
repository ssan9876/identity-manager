import { useEffect, useState } from 'react'
import { NAV_DISCLOSURE_MAX_WIDTH, NAV_RAIL_MAX_WIDTH, navModeForWidth, type NavMode } from './breakpoints'

/**
 * Tracks the nav's current responsive mode (DESIGN.md: full nav / icon
 * rail under 1100px / disclosure under 780px). Driven by two `matchMedia`
 * listeners rather than a `resize` handler — cheaper (only fires on an
 * actual breakpoint crossing, not every intermediate pixel) and matches
 * how the equivalent CSS @media rules in AppShell.css express the same two
 * thresholds, so the JS-rendered structure (disclosure needs a different
 * DOM shape, not just different CSS) and the CSS-only rail styling can
 * never disagree about where the lines are — both read from
 * shell/breakpoints.ts.
 */
export function useNavMode(): NavMode {
  const [mode, setMode] = useState<NavMode>(() =>
    typeof window === 'undefined' ? 'full' : navModeForWidth(window.innerWidth),
  )

  useEffect(() => {
    const railQuery = window.matchMedia(`(max-width: ${NAV_RAIL_MAX_WIDTH}px)`)
    const disclosureQuery = window.matchMedia(`(max-width: ${NAV_DISCLOSURE_MAX_WIDTH}px)`)

    const update = () => setMode(navModeForWidth(window.innerWidth))
    update()

    railQuery.addEventListener('change', update)
    disclosureQuery.addEventListener('change', update)
    return () => {
      railQuery.removeEventListener('change', update)
      disclosureQuery.removeEventListener('change', update)
    }
  }, [])

  return mode
}
