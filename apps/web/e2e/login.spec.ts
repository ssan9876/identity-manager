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

/**
 * Regression test for a silent failure that cost a full debugging session on
 * real hardware. The gate's button was `onClick={() => void
 * auth.signinRedirect()}` — `void` discarded the promise, so an unreachable
 * issuer produced NOTHING: no console error, no message, no navigation. The
 * button simply did not work, with nothing on screen to say why.
 *
 * This lives at the rendered level rather than as a unit test of the handler
 * BECAUSE the first attempted fix — a try/catch around an awaited
 * `signinRedirect()` — did not work either. react-oidc-context catches
 * internally and dispatches to `auth.error`, so the call settles without
 * throwing and the catch never runs. A handler-level test would have passed
 * against that broken fix; only the rendered output tells the two apart, so
 * only a rendered assertion can hold the real fix in place.
 *
 * Aborting the discovery request reproduces the original condition exactly:
 * oidc-client-ts must read `.well-known/openid-configuration` from the
 * authority before it can build an authorize URL, which is why an untrusted
 * certificate, a down IdP, and a wrong issuer all surface at this one point.
 */
test('reports an unreachable issuer instead of failing silently', async ({
  page,
}) => {
  await page.route('**/.well-known/openid-configuration', (route) =>
    route.abort(),
  )

  await page.goto('/')
  await page.getByRole('button', { name: 'Sign in' }).click()

  const failure = page.getByRole('alert')
  await expect(failure).toBeVisible()
  await expect(failure).toContainText('Could not reach the sign-in service')
  // The issuer must be NAMED. "Something went wrong" would not have shortened
  // the original investigation by a single step.
  await expect(failure).toContainText(/realms\/identity-manager/)
  // And the user stays on the gate rather than being navigated into a dead end.
  await expect(page).toHaveURL(/localhost:5173\/?$/)
})
