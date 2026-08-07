/**
 * Light/dark resolution — Milestone 9, Task 2. Shared by the pre-paint
 * inline script in index.html (which cannot import this module — it runs
 * before any bundled JS exists) and ThemeToggle.tsx (which can). The two
 * MUST agree on the storage key and the resolution algorithm; if you change
 * one, change the other. See styles/tokens.css's header comment for the
 * full four-block CSS precedence this feeds (`:root`, the dark media query,
 * and the two explicit `[data-theme]` overrides).
 */

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'idm-theme'

/** The user's persisted explicit choice, if any — null means "follow the OS". */
export function getStoredTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    // Storage inaccessible (private browsing, disabled, …) — no persisted
    // choice, fall back to the OS signal. Never throws from a read.
    return null
  }
}

export function getSystemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * The theme actually in effect right now: the DOM attribute the pre-paint
 * script (or a prior applyTheme call) already set, falling back to the OS
 * signal when no explicit choice has ever been made. Safe to call from a
 * useState initializer — reads the DOM synchronously, no flash, no effect
 * needed to "catch up" after first render.
 */
export function getEffectiveTheme(): Theme {
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr === 'light' || attr === 'dark') return attr
  return getSystemTheme()
}

/** Sets the DOM attribute tokens.css's four colour blocks key off. Does not
 * persist by itself — see persistTheme — so callers can apply instantly and
 * handle a storage failure separately (ThemeToggle: the visible theme still
 * changes for this session even if persistence throws). */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
}

/** Throws if storage is unavailable (private browsing, quota, disabled) —
 * deliberately NOT swallowed here, so a caller can tell the difference
 * between "applied" and "applied and will survive a reload". */
export function persistTheme(theme: Theme): void {
  window.localStorage.setItem(STORAGE_KEY, theme)
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
