import { expect, test, type Locator, type Page } from '@playwright/test'
import { trackGroup } from './support/cleanup-tracker'

const USERNAME = 'admin@example.com'
const PASSWORD = 'dev_password_change_me'
const API_BASE_URL = 'http://localhost:3000'

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
 * Pulls the real OIDC access token out of the session the sign-in flow just
 * produced — same technique task-1-report.md's own clean-install proof
 * used (pulling it from sessionStorage, where react-oidc-context's
 * WebStorageStateStore keeps it). Needed here to seed a REAL fixture (a
 * group, a membership) through the actual API before asserting the UI
 * reflects it — proving the Groups tab renders genuine server data, not
 * just that the tab exists.
 */
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
 * Presses Tab up to `maxTabs` times, stopping as soon as `locator`'s
 * element is the document's active element. Proves the element is
 * TAB-REACHABLE from wherever focus currently is — a fixed count of Tab
 * presses would be fragile to any future change in how many focusable
 * elements precede it; this instead asks the only question that actually
 * matters for "reach it via keyboard": does continuing to press Tab
 * eventually get there.
 */
async function tabUntilFocused(page: Page, locator: Locator, maxTabs = 60): Promise<boolean> {
  for (let i = 0; i < maxTabs; i++) {
    if (await locator.evaluate((el) => el === document.activeElement).catch(() => false)) {
      return true
    }
    await page.keyboard.press('Tab')
  }
  return locator.evaluate((el) => el === document.activeElement).catch(() => false)
}

/**
 * Milestone 8, Task 2 — the People list and detail screens. Complements
 * e2e/login.spec.ts (which stops at "lands on the People list") with the
 * fuller "Prove it" from task-2-brief.md: see a seeded user, open their
 * detail, see their groups — plus a keyboard-only pass over the table.
 */
test('signs in, lands on People, finds a seeded user, opens their detail, and sees a real group they belong to', async ({
  page,
  request,
}) => {
  await signIn(page)
  const token = await getAccessToken(page)

  // The signed-in admin is a real user by construction (bootstrap:admin
  // creates it, and nothing signs in without a matching local row) — read
  // its actual displayName/id from the API directly rather than assuming
  // one, so this test never depends on how any particular dev environment
  // happened to seed that user's name.
  const meRes = await request.get(
    `${API_BASE_URL}/users?search=${encodeURIComponent(USERNAME)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  expect(meRes.ok()).toBeTruthy()
  const meBody = (await meRes.json()) as { items: { id: string; displayName: string }[] }
  expect(meBody.items).toHaveLength(1)
  const me = meBody.items[0]

  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible()
  await expect(page.getByTestId('people-table')).toBeVisible()

  await page.getByTestId('people-search-input').fill(USERNAME)
  await expect(page.getByTestId('people-row')).toHaveCount(1)
  await expect(page.getByTestId('people-row-link')).toHaveText(me.displayName)

  await page.getByTestId('people-row-link').click()
  await page.waitForURL(`http://localhost:5173/people/${me.id}`)
  await expect(page.getByTestId('person-detail-name')).toHaveText(me.displayName)

  // Groups tab starts on Profile — switch to it and prove it renders
  // *something* meaningful before seeding a fixture (either real groups or
  // the honest "not a member of any group" empty state; both are
  // legitimate, this just proves the tab itself works).
  await page.getByRole('tab', { name: 'Groups' }).click()
  await expect(page.getByRole('tabpanel', { name: 'Groups' })).toBeVisible()

  // Seed a REAL group and add the admin to it through the actual API, using
  // the token this exact signed-in session holds.
  const groupName = `E2E Detail Group ${Date.now()}`
  const createRes = await request.post(`${API_BASE_URL}/groups`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: groupName },
  })
  expect(createRes.ok()).toBeTruthy()
  const group = (await createRes.json()) as { id: string }
  trackGroup(group.id)

  const addRes = await request.post(`${API_BASE_URL}/groups/${group.id}/members`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { userId: me.id },
  })
  expect(addRes.ok()).toBeTruthy()

  // Reload so the detail page's own GET /groups?userId= call picks up the
  // membership just created via a separate, out-of-band request.
  await page.reload()
  await page.getByRole('tab', { name: 'Groups' }).click()
  await expect(page.getByTestId(`person-group-${group.id}`)).toContainText(groupName)
})

test('the People table is fully keyboard operable: Tab reaches a row, Enter opens it', async ({ page }) => {
  await signIn(page)
  await expect(page.getByTestId('people-table')).toBeVisible()

  // Narrow to exactly one row so "reached the row link" is unambiguous
  // regardless of how many people a given dev environment has seeded.
  // Typed via the keyboard (not .fill()) once the field itself is reached
  // by keyboard — the whole path from page load to opening the record is
  // driven by the keyboard, never a click.
  const reachedSearch = await tabUntilFocused(page, page.getByTestId('people-search-input'))
  expect(reachedSearch).toBe(true)
  await page.keyboard.type(USERNAME)
  await expect(page.getByTestId('people-row')).toHaveCount(1)

  const reachedRow = await tabUntilFocused(page, page.getByTestId('people-row-link'))
  expect(reachedRow).toBe(true)

  await page.keyboard.press('Enter')
  await page.waitForURL(/\/people\/[0-9a-f-]{36}$/)
  await expect(page.getByTestId('person-detail-name')).toBeVisible()
})

test('ArrowDown/ArrowUp move focus between row links inside the table', async ({ page }) => {
  await signIn(page)
  await expect(page.getByTestId('people-table')).toBeVisible()
  // people-table (and its skeleton rows, which carry no data-row-link) is
  // present the instant the table region renders, before the actual GET
  // /users response lands — wait for a REAL row link specifically, or
  // .count() below would race the fetch and could see 0 rows.
  await expect(page.getByTestId('people-row-link').first()).toBeVisible()

  const rowCount = await page.getByTestId('people-row').count()
  test.skip(rowCount < 2, 'this dev environment has fewer than 2 people — nothing to navigate between')

  await page.getByTestId('people-row-link').nth(0).focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('people-row-link').nth(1)).toBeFocused()

  await page.keyboard.press('ArrowUp')
  await expect(page.getByTestId('people-row-link').nth(0)).toBeFocused()

  await page.keyboard.press('End')
  await expect(page.getByTestId('people-row-link').last()).toBeFocused()

  await page.keyboard.press('Home')
  await expect(page.getByTestId('people-row-link').nth(0)).toBeFocused()
})

test('the Person detail tabs are keyboard operable with arrow keys (WAI-ARIA tabs pattern)', async ({ page }) => {
  await signIn(page)
  await page.getByTestId('people-row-link').first().click()
  await page.waitForURL(/\/people\/[0-9a-f-]{36}$/)

  const profileTab = page.getByRole('tab', { name: 'Profile' })
  await profileTab.focus()
  await expect(profileTab).toHaveAttribute('aria-selected', 'true')

  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'Groups' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: 'Groups' })).toBeFocused()
  await expect(page.getByRole('tabpanel', { name: 'Groups' })).toBeVisible()

  // Milestone 8, Task 4 replaced the "later task" placeholder with real
  // content: the signed-in admin (global super_admin, per bootstrap:admin)
  // holds role:assign, so the Roles tab renders its real grant/revoke UI
  // rather than an explanation of why it can't. The target person here is
  // whichever row happens to sort first, so this asserts something true
  // regardless of who that is — the "Grant a role" affordance is always
  // available to this actor — rather than a specific assignment.
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'Roles' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel', { name: 'Roles' }).getByTestId('role-show-grant')).toBeVisible()

  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('tab', { name: 'Groups' })).toHaveAttribute('aria-selected', 'true')
})
