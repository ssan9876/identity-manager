import { expect, test, type Page } from '@playwright/test'

const USERNAME = 'admin@example.com'
const PASSWORD = 'dev_password_change_me'
const API_BASE_URL = 'http://localhost:3000'

/** Same real sign-in flow every other E2E spec in this suite already proves — Keycloak's own hosted login page, no form of this app's own. */
async function signIn(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/realms\/identity-manager\/protocol\/openid-connect\/auth/)
  await page.getByLabel(/username|email/i).fill(USERNAME)
  await page.getByRole('textbox', { name: /password/i }).fill(PASSWORD)
  await page.getByRole('button', { name: /sign in|log in/i }).click()
  await page.waitForURL('http://localhost:5173/')
}

/** Same technique groups.spec.ts/people.spec.ts use — the real OIDC token out of sessionStorage, so cleanup can go through the API. */
async function getAccessToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)
      if (key?.startsWith('oidc.user:')) {
        const raw = sessionStorage.getItem(key)
        if (raw) return (JSON.parse(raw) as { access_token: string }).access_token
      }
    }
    throw new Error('no oidc user found in sessionStorage after sign-in')
  })
}

/**
 * Unique per run. There is no DELETE for an SSO application by design, so a
 * fixture cannot be removed afterwards — a fixed clientId would 409 on the
 * second run of this suite against the same dev database.
 */
function uniqueClientId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10_000)}`
}

test('registers an application and shows it on the detail page', async ({ page }) => {
  await signIn(page)
  const clientId = uniqueClientId('e2e-billing')

  await page.goto('/applications')
  await page.getByRole('link', { name: 'Register application' }).click()

  await page.getByLabel('Client ID').fill(clientId)
  await page.getByLabel('Name').fill('E2E Billing Portal')
  await page.getByLabel('Redirect URIs').fill('https://billing.example.com/callback')
  await page.getByRole('button', { name: 'Register' }).click()

  await expect(page.getByRole('heading', { name: 'E2E Billing Portal' })).toBeVisible()
  await expect(page.getByText(clientId).first()).toBeVisible()
  await expect(page.getByText('Confidential client')).toBeVisible()

  // And it appears in the list.
  await page.goto('/applications')
  await expect(page.getByRole('link', { name: 'E2E Billing Portal' })).toBeVisible()
})

test('refuses a wildcard redirect URI, showing the API reason verbatim', async ({ page }) => {
  // The console does not re-implement the rail; it renders the API's reason,
  // which names the offending value so an admin can find it among several
  // pasted lines.
  await signIn(page)

  await page.goto('/applications/new')
  await page.getByLabel('Client ID').fill(uniqueClientId('e2e-bad'))
  await page.getByLabel('Name').fill('E2E Bad App')
  await page.getByLabel('Redirect URIs').fill('https://*')
  await page.getByRole('button', { name: 'Register' }).click()

  await expect(page.getByText(/wildcard/i)).toBeVisible()
  // Still on the form — nothing was created.
  await expect(page.getByRole('heading', { name: 'Register application' })).toBeVisible()
})

test('refuses a reserved client id', async ({ page }) => {
  await signIn(page)

  await page.goto('/applications/new')
  await page.getByLabel('Client ID').fill('idm-console')
  await page.getByLabel('Name').fill('Impostor')
  await page.getByLabel('Redirect URIs').fill('https://evil.example.com/cb')
  await page.getByRole('button', { name: 'Register' }).click()

  await expect(page.getByText(/reserved/i)).toBeVisible()
})

test('disables an application without offering any way to delete it', async ({ page }) => {
  await signIn(page)
  const clientId = uniqueClientId('e2e-toggle')

  await page.goto('/applications/new')
  await page.getByLabel('Client ID').fill(clientId)
  await page.getByLabel('Name').fill('E2E Toggle App')
  await page.getByLabel('Redirect URIs').fill('https://toggle.example.com/cb')
  await page.getByRole('button', { name: 'Register' }).click()

  await expect(page.getByRole('heading', { name: 'E2E Toggle App' })).toBeVisible()

  await page.getByRole('button', { name: 'Disable' }).click()
  await expect(page.getByRole('button', { name: 'Enable' })).toBeVisible()

  // Nothing deletes. There is no route, no repository method and no connector
  // method — the console must not imply otherwise.
  await expect(page.getByRole('button', { name: /delete|remove/i })).toHaveCount(0)
})

test('a public client is offered no client secret button', async ({ page }) => {
  // PKCE replaces the secret entirely for a public client, and the API 409s.
  // Hiding the button beats offering one whose only outcome is an error.
  await signIn(page)
  const clientId = uniqueClientId('e2e-public')

  await page.goto('/applications/new')
  await page.getByLabel('Client ID').fill(clientId)
  await page.getByLabel('Name').fill('E2E Public App')
  await page.getByLabel('Redirect URIs').fill('https://spa.example.com/cb')
  await page.getByLabel('Public client').check()
  await page.getByRole('button', { name: 'Register' }).click()

  await expect(page.getByRole('heading', { name: 'E2E Public App' })).toBeVisible()
  await expect(page.getByText('Public client (PKCE)')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Generate client secret' })).toHaveCount(0)
})

test('minting before the first sync explains itself rather than failing opaquely', async ({ page }) => {
  // keycloak_sso is not configured in the dev environment, so this exercises
  // the 409 path. The application exists here; there is simply no Keycloak
  // client yet.
  await signIn(page)
  const clientId = uniqueClientId('e2e-unsynced')

  await page.goto('/applications/new')
  await page.getByLabel('Client ID').fill(clientId)
  await page.getByLabel('Name').fill('E2E Unsynced App')
  await page.getByLabel('Redirect URIs').fill('https://unsynced.example.com/cb')
  await page.getByRole('button', { name: 'Register' }).click()

  await expect(page.getByRole('heading', { name: 'E2E Unsynced App' })).toBeVisible()
  await page.getByRole('button', { name: 'Generate client secret' }).click()

  await expect(page.getByText(/has not synced to Keycloak yet/i)).toBeVisible()
  // No modal, and therefore no secret shown.
  await expect(page.getByTestId('secret-modal')).toHaveCount(0)
})

test('the Applications nav entry is present for an admin', async ({ page }) => {
  await signIn(page)
  await expect(page.getByRole('link', { name: 'Applications' })).toBeVisible()
})

test('the API rejects a wildcard even if the console is bypassed', async ({ page, request }) => {
  // The rail lives in the domain layer, not the form.
  await signIn(page)
  const token = await getAccessToken(page)

  const res = await request.post(`${API_BASE_URL}/sso-apps`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: {
      clientId: uniqueClientId('e2e-direct'),
      name: 'Direct',
      publicClient: false,
      redirectUris: ['*'],
    },
  })

  expect(res.status()).toBe(400)
  expect(JSON.stringify(await res.json())).toMatch(/wildcard|any host/i)
})
