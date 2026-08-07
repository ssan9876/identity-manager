import { useEffect, useState } from 'react'
import { useToast } from './ToastProvider'
import { applyTheme, getEffectiveTheme, getSystemTheme, persistTheme, type Theme } from './theme'

function SunIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="3.5" />
      <path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1 4.7 4.7" />
    </svg>
  )
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M16.5 12.3A6.5 6.5 0 0 1 7.7 3.5a6.5 6.5 0 1 0 8.8 8.8Z" />
    </svg>
  )
}

/**
 * The top-bar light/dark toggle — Milestone 9, Task 2. `prefers-color-scheme`
 * is the default signal (styles/tokens.css); this is the explicit override
 * DESIGN.md now calls for, and it persists (shell/theme.ts, localStorage) so
 * a returning visit keeps the choice instead of reverting to the OS signal.
 *
 * DESIGN.md requires every interactive component ship all seven states
 * (default, hover, focus, active, disabled, loading, error). For this one:
 *   - default / hover / focus-visible / active — plain `.btn--ghost` states,
 *     reused rather than reinvented (this IS a `.btn--ghost`).
 *   - disabled / loading — deliberately NOT exercised. The first version of
 *     this component briefly set `disabled` for ~200ms after each toggle,
 *     to debounce a rapid double-activation across the icon crossfade. The
 *     e2e suite (theme.spec.ts's "is keyboard operable" test) caught why
 *     that was wrong: disabling the currently-focused element blurs it —
 *     browsers won't keep focus on an element that becomes unfocusable —
 *     and focus does not return on its own once it re-enables. A second
 *     Enter/Space press after the first toggle landed on nothing. Breaking
 *     keyboard operability to smooth over a ~180ms cosmetic edge case (two
 *     rapid activations just land back where they started; nothing actually
 *     breaks) is the wrong trade, so the guard is gone — the underlying
 *     `.btn` primitive still SUPPORTS a real `disabled`/`[data-loading]`
 *     state for whichever future caller has a genuine one (a server-synced
 *     preference, say), this component just doesn't fabricate one it
 *     doesn't have. This is also why there is no page-wide transition on
 *     theme switch — see base.css's own doc comment for the matching flash
 *     bug that turned up in the very same test run.
 *   - error — `localStorage.setItem` can throw (private browsing, full
 *     quota, storage disabled). The theme still applies for this tab/
 *     session — the visible toggle never silently fails — but the choice
 *     will not survive a reload, so that is reported the same way every
 *     other consequential result in this console is reported: a toast
 *     (ToastProvider), not a state on the button itself. Mirrors DESIGN.md's
 *     own precedent for buttons — "surfaced via the surrounding message
 *     region, not the button itself."
 */
export function ThemeToggle() {
  const { showToast } = useToast()
  const [theme, setTheme] = useState<Theme>(() => getEffectiveTheme())

  // Keeps the icon truthful if the OS-level scheme changes while this tab is
  // open AND the user has never made an explicit choice here — same
  // matchMedia-listener shape as useNavMode (shell/useMediaQuery.ts), for
  // the same reason: cheap, fires only on an actual change, never a poll.
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    function onSystemChange() {
      if (document.documentElement.getAttribute('data-theme') === null) {
        setTheme(getSystemTheme())
      }
    }
    query.addEventListener('change', onSystemChange)
    return () => query.removeEventListener('change', onSystemChange)
  }, [])

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    setTheme(next)

    try {
      persistTheme(next)
    } catch {
      showToast("Theme choice couldn't be saved on this device — it won't persist after reload.", 'warn')
    }
  }

  const isDark = theme === 'dark'

  return (
    <button
      type="button"
      className="btn btn--ghost theme-toggle"
      onClick={toggle}
      aria-pressed={isDark}
      title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      data-testid="theme-toggle"
    >
      <SunIcon className="theme-toggle__icon theme-toggle__icon--sun" />
      <MoonIcon className="theme-toggle__icon theme-toggle__icon--moon" />
      <span className="sr-only">Dark mode</span>
    </button>
  )
}
