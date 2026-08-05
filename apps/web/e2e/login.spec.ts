import { expect, test } from '@playwright/test'

const USERNAME = 'admin@example.com'
const PASSWORD = 'dev_password_change_me'

test('signs in through Keycloak and reads the protected endpoint', async ({
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
  await expect(page.getByTestId('me-username')).toHaveText(USERNAME)
})

test('shows the signed-out state before authentication', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('me-username')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
})
