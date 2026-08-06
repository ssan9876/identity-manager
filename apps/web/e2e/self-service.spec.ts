import { expect, test } from '@playwright/test'

const USERNAME = 'admin@example.com'
const PASSWORD = 'dev_password_change_me'

/**
 * Milestone 6, Task 4. Reuses the exact sign-in flow e2e/login.spec.ts
 * already proves (Keycloak's own hosted login page — this app has no login
 * form of its own), then exercises the self-service round trip: land on
 * `/self`, see the caller's own profile, edit a self-editable field
 * (`location` — the one guaranteed to exist in every environment, since it
 * is the fixed core-field whitelist's only member; custom self-editable
 * attributes are opt-in per `attribute_definitions` row and none are
 * seeded by default), save it, and confirm the new value is still there
 * after a full page reload — i.e. it round-tripped through the API and
 * Postgres, not merely local component state.
 */
test('signs in, lands on /self, edits a self-editable field, and the change persists across a reload', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Sign in' }).click()

  await page.waitForURL(/\/realms\/identity-manager\/protocol\/openid-connect\/auth/)
  await page.getByLabel(/username|email/i).fill(USERNAME)
  await page.getByRole('textbox', { name: /password/i }).fill(PASSWORD)
  await page.getByRole('button', { name: /sign in|log in/i }).click()

  await page.waitForURL('http://localhost:5173/')

  await page.getByRole('link', { name: 'My Profile' }).click()
  await page.waitForURL('http://localhost:5173/self')

  await expect(page.getByTestId('self-username')).toHaveText(USERNAME)

  // Credential management is a deep link to Keycloak's Account Console,
  // never a reimplementation — assert the rendered link actually targets
  // Keycloak's realm-scoped account page (task-4-brief.md).
  await expect(page.getByTestId('self-account-console-link')).toHaveAttribute(
    'href',
    /\/realms\/identity-manager\/account$/,
  )

  // Groups render read-only, without needing any specific fixture
  // membership to exist for this assertion to be meaningful — the
  // direct-vs-effective DISTINCTION itself is proven at the API layer
  // (test/self-service.spec.ts), this just proves the section renders.
  await expect(page.getByRole('heading', { name: 'Groups' })).toBeVisible()

  const newLocation = `Testville ${Date.now()}`
  await page.getByTestId('self-edit-location').fill(newLocation)
  await page.getByRole('button', { name: 'Save changes' }).click()

  await expect(page.getByTestId('self-save-success')).toBeVisible()
  await expect(page.getByTestId('self-location-current')).toHaveText(newLocation)

  // Reload from scratch: a fresh GET /self, not merely leftover component
  // state, must show the edit persisted.
  await page.reload()
  await expect(page.getByTestId('self-location-current')).toHaveText(newLocation)
  await expect(page.getByTestId('self-edit-location')).toHaveValue(newLocation)
})
