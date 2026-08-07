import { expect, test } from '@playwright/test'

const USERNAME = 'admin@example.com'
const PASSWORD = 'dev_password_change_me'

/**
 * Milestone 8, Task 2 changed what a signed-in user sees at `/`: the
 * Milestone 1 placeholder landing page (a `GET /me` echo — "API says
 * username" / "Subject: <uuid>") is retired in favour of the real console.
 * PRODUCT.md bans a dashboard opener — "this product opens onto a list of
 * people, because that is the job" — so `/` now renders the People list
 * directly. This test's job is unchanged from before: prove the real
 * sign-in mechanics work end to end against Keycloak's own hosted login
 * page, and that the app knows who signed in; it now checks for the NEW
 * landing content instead of the retired `/me` echo. See
 * e2e/people.spec.ts for the fuller People-list proof (search, detail,
 * groups, keyboard operation).
 */
test('signs in through Keycloak and lands on the People list', async ({
  page,
}) => {
  await page.goto('/')

  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await page.getByRole('button', { name: 'Sign in' }).click()

  // Keycloak-hosted login page — this app has no login form of its own.
  await page.waitForURL(/\/realms\/identity-manager\/protocol\/openid-connect\/auth/)
  await page.getByLabel(/username|email/i).fill(USERNAME)
  // Keycloak's default theme renders a "Show password" toggle button whose
  // accessible name also contains "password", so getByLabel(/password/i)
  // matches two elements (the textbox and the toggle button). Scope to the
  // textbox role to disambiguate.
  await page.getByRole('textbox', { name: /password/i }).fill(PASSWORD)
  await page.getByRole('button', { name: /sign in|log in/i }).click()

  await page.waitForURL('http://localhost:5173/')

  await expect(page.getByTestId('signed-in-as')).toHaveText(USERNAME)
  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible()
  await expect(page.getByTestId('people-table')).toBeVisible()
})

test('shows the signed-out state before authentication', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('people-table')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
})
