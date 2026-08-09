import { expect, test, type Page } from '@playwright/test'

const USERNAME = 'admin@example.com'
const PASSWORD = 'dev_password_change_me'

/** Same real sign-in flow e2e/login.spec.ts already proves — Keycloak's own hosted login page, no form of this app's own. */
async function signIn(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/realms\/identity-manager\/protocol\/openid-connect\/auth/)
  await page.getByLabel(/username|email/i).fill(USERNAME)
  await page.getByRole('textbox', { name: /password/i }).fill(PASSWORD)
  await page.getByRole('button', { name: /sign in|log in/i }).click()
  await page.waitForURL('http://localhost:5173/')
}

/**
 * Milestone 9, Task 2 — dark mode. Two things get automated coverage here
 * beyond the visual pass: the pre-paint resolution that prevents a flash of
 * the wrong theme, and the top-bar toggle's own contract (persists, keyboard
 * operable). Contrast itself is verified by computation — see
 * apps/web/src/styles/tokens.css's own header comment, which records the
 * computation method, the ratios it corrected inline, and the full
 * `.superpowers/...` path to the report holding the complete table — not
 * by a browser assertion: a screenshot diff or an in-page luminance check
 * would only re-derive numbers already proven correct
 * against the CSS Color 4 conversion the browser itself implements.
 *
 * The two bare `task-2-report.md` references that used to appear above are
 * gone. A bare filename resolves to nothing from here, so it read as
 * evidence while being impossible to follow; the one pointer that does
 * resolve is tokens.css, which is in this repository, and it carries the
 * ledger path onward for anyone who has the ledger.
 */
test.describe('theme resolution', () => {
  /**
   * Proves the mechanism, not just the outcome: index.html's inline script
   * runs synchronously in <head>, before any stylesheet or body content, so
   * by the time this check runs the attribute — and the computed colour it
   * drives — are already final. Deliberately exercised on the SIGNED-OUT
   * gate (no login needed, and it is one of the screens the visual pass is
   * required to check in both themes): the mechanism is document-level, not
   * tied to being authenticated.
   */
  test('a persisted dark preference is applied before first paint, even signed out', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('idm-theme', 'dark')
    })
    await page.goto('/')

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()

    // Not just the attribute — the computed colour it drives (Chromium
    // echoes an oklch()-specified value back verbatim from
    // getComputedStyle, rather than converting to rgb()). Confirms
    // tokens.css's dark block actually won, not merely that the attribute
    // was set with no matching CSS rule.
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(bg).toBe('oklch(0.16 0.004 110)')
  })

  /**
   * The other direction of the override matrix, and the harder half of
   * tokens.css's four-block precedence to get right: an explicit LIGHT
   * choice must win even when the OS itself prefers dark (this is exactly
   * why :root[data-theme='light'] has to restate light's values rather than
   * relying on :root's own unconditional defaults — see that file's header
   * comment).
   */
  test('a persisted light preference overrides a dark OS preference before first paint', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.addInitScript(() => {
      window.localStorage.setItem('idm-theme', 'light')
    })
    await page.goto('/')

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(bg).toBe('oklch(1 0 0)')
  })

  test('with no persisted choice, the OS signal governs and no attribute is forced', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/')

    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/)
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(bg).toBe('oklch(0.16 0.004 110)') // the dark palette, via prefers-color-scheme alone
  })
})

test.describe('theme toggle', () => {
  test('switches themes and persists across a reload', async ({ page }) => {
    await signIn(page)
    const toggle = page.getByTestId('theme-toggle')
    await expect(toggle).toBeVisible()

    const startedDark = (await toggle.getAttribute('aria-pressed')) === 'true'
    await toggle.click()
    const expectedTheme = startedDark ? 'light' : 'dark'

    await expect(toggle).toHaveAttribute('aria-pressed', String(!startedDark))
    await expect(page.locator('html')).toHaveAttribute('data-theme', expectedTheme)

    await page.reload()

    await expect(page.locator('html')).toHaveAttribute('data-theme', expectedTheme)
    await expect(page.getByTestId('theme-toggle')).toHaveAttribute('aria-pressed', String(!startedDark))
  })

  /** Enter AND Space — both are the standard activation keys for a native <button>. */
  test('is keyboard operable', async ({ page }) => {
    await signIn(page)
    const toggle = page.getByTestId('theme-toggle')

    await toggle.focus()
    await expect(toggle).toBeFocused()

    const initial = (await toggle.getAttribute('aria-pressed')) === 'true'

    await page.keyboard.press('Enter')
    await expect(toggle).toHaveAttribute('aria-pressed', String(!initial))
    await expect(toggle).toBeFocused() // still focused — nothing disables it mid-toggle

    await page.keyboard.press(' ')
    await expect(toggle).toHaveAttribute('aria-pressed', String(initial))
  })

  test('has a visible focus ring', async ({ page }) => {
    await signIn(page)
    const toggle = page.getByTestId('theme-toggle')
    await toggle.focus()
    await expect(toggle).toBeFocused()

    const outlineStyle = await toggle.evaluate((el) => getComputedStyle(el).outlineStyle)
    expect(outlineStyle).toBe('solid')
  })
})
