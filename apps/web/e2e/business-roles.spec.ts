import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { trackGroup, trackUser } from './support/cleanup-tracker'

const ADMIN_USERNAME = 'admin@example.com'
const ADMIN_PASSWORD = 'dev_password_change_me'
const API_BASE_URL = 'http://localhost:3000'

/** Same real sign-in flow every other e2e file's own copy of this helper uses (e2e/login.spec.ts proves it works) — Keycloak's own hosted login page, no form of this app's own. */
async function signIn(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/realms\/identity-manager\/protocol\/openid-connect\/auth/)
  await page.getByLabel(/username|email/i).fill(ADMIN_USERNAME)
  await page.getByRole('textbox', { name: /password/i }).fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: /sign in|log in/i }).click()
  await page.waitForURL('http://localhost:5173/')
}

/** Same technique e2e/groups.spec.ts and e2e/person-picker.spec.ts already use — pulls the real OIDC access token out of sessionStorage so fixtures can be seeded through the actual API rather than by clicking. */
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

async function fetchAnyOrgUnit(request: APIRequestContext, token: string): Promise<{ id: string }> {
  const res = await request.get(`${API_BASE_URL}/org-units?limit=1`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(res.ok()).toBeTruthy()
  const body = (await res.json()) as { items: { id: string }[] }
  return body.items[0]!
}

async function createGroupViaApi(request: APIRequestContext, token: string, name: string): Promise<string> {
  // No `orgUnitId` — a GLOBAL group (GroupsController decision 1). The role's
  // grant names a group id and nothing else, so scope is irrelevant to what
  // this test proves, and global keeps the fixture out of any org unit an
  // unrelated spec might be asserting over.
  const res = await request.post(`${API_BASE_URL}/groups`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name },
  })
  expect(res.ok()).toBeTruthy()
  const created = (await res.json()) as { id: string }
  trackGroup(created.id)
  return created.id
}

async function createPersonViaApi(
  request: APIRequestContext,
  token: string,
  input: { username: string; orgUnitId: string; jobTitle: string },
): Promise<{ id: string }> {
  const res = await request.post(`${API_BASE_URL}/users`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      primaryEmail: `${input.username}@example.com`,
      username: input.username,
      firstName: 'E2E',
      lastName: 'Account Executive',
      orgUnitId: input.orgUnitId,
      jobTitle: input.jobTitle,
    },
  })
  expect(res.ok()).toBeTruthy()
  const created = (await res.json()) as { id: string }
  trackUser(created.id)
  return created
}

/**
 * Milestone 17, Task 20 — the whole feature in one journey, driven through
 * the console exactly as an admin would.
 *
 * WHAT THIS PROVES, in order: a role is created granting nothing; a draft is
 * written and changes nobody's access; Publish is REFUSED until that exact
 * draft has been simulated; simulating names the person who would gain;
 * publishing and enabling actually move the membership; the person's own
 * Entitlements tab attributes that membership BACK to the role by name; and
 * editing the draft again re-arms the gate. Each of those is asserted
 * separately elsewhere — this is the one test that proves they compose.
 *
 * WHY THE FIXTURES ARE SEEDED THROUGH THE API AND NOT THE UI. This suite
 * runs against the shared, persistent dev database (see
 * e2e/connectors.spec.ts's own doc comment), so the simulation's counts are
 * only deterministic if the role's condition matches exactly one row in the
 * WHOLE directory. A per-run `jobTitle` stamp guarantees that — no other
 * person, from this run or any previous one, can carry it — and `POST
 * /users` is the only way to set `jobTitle` at creation time. The plan's own
 * sketch assumed a pre-seeded `seededAeUserId`; there is no such seed in
 * this repo, and inventing one would make this spec depend on fixture data
 * no other spec maintains.
 *
 * The person is left `pending`, deliberately: no condition here names
 * `status`, and `role-evaluator.ts` matches on the conditions it is given
 * and nothing else. Activating would be a second, unrelated moving part
 * (`jml:lifecycle`, a real child process) bought for nothing.
 */
test('a business role grants access, and the person page explains why', async ({ page, request }) => {
  const stamp = Date.now()
  const roleName = `E2E Sales AE ${stamp}`
  const groupName = `E2E BR Sales ${stamp}`
  const jobTitle = `E2E Account Executive ${stamp}`

  await signIn(page)
  const token = await getAccessToken(page)

  const orgUnit = await fetchAnyOrgUnit(request, token)
  await createGroupViaApi(request, token, groupName)
  const person = await createPersonViaApi(request, token, {
    username: `e2e-ae-${stamp}`,
    orgUnitId: orgUnit.id,
    jobTitle,
  })

  // ---- Create the role. It starts disabled, with no formula. ----
  await page.goto('http://localhost:5173/business-roles')
  await page.getByTestId('new-business-role').click()
  await page.getByLabel('Name').fill(roleName)
  await page.getByTestId('business-role-create-submit').click()
  await page.waitForURL(/\/business-roles\/[0-9a-f-]{36}$/)
  const roleId = /\/business-roles\/([0-9a-f-]{36})$/.exec(page.url())![1]!

  await expect(page.getByTestId('business-role-name')).toHaveText(roleName)
  await expect(page.getByTestId('disabled-banner')).toBeVisible()

  // ---- Draft a condition and a grant. ----
  await page.getByTestId('add-condition').click()
  await page.getByLabel('Field').selectOption('jobTitle')
  await page.getByLabel('Operator').selectOption('equals')
  await page.getByLabel('Value').fill(jobTitle)
  await page.getByTestId('add-grant').click()
  await page.getByLabel('Group').selectOption({ label: groupName })
  await page.getByTestId('save-draft').click()

  await expect(page.getByTestId('business-role-state')).toContainText(/pending simulation/i)

  // ---- Publish is refused until THIS EXACT draft has been simulated. ----
  await expect(page.getByTestId('publish-role')).toBeDisabled()

  await page.getByTestId('simulate-role').click()
  // Exactly one person in the whole directory carries this stamped job
  // title, which is what makes a hard number safe to assert here.
  await expect(page.getByTestId('simulate-gains-count')).toContainText('1')
  await expect(page.getByTestId('simulate-gains-count')).toContainText(/person gains/i)
  await expect(page.getByTestId('simulate-losses-count')).toContainText('0')
  // The DISPLAY NAME, not the username: `SimulatePanel` resolves the ids the
  // report carries back to real people (`fetchPeopleByIds`) and falls back to
  // the username only when that resolution fails.
  await expect(page.getByTestId('simulate-gains')).toContainText('E2E Account Executive')
  await expect(page.getByTestId('simulate-gains')).toContainText(groupName)

  // ---- Publish, then enable. ----
  await expect(page.getByTestId('publish-role')).toBeEnabled()
  await page.getByTestId('publish-role').click()
  await expect(page.getByTestId('business-role-state')).toContainText(/no pending changes/i)

  await page.getByTestId('enable-role').click()
  // The toast is the product's own claim about how many people just gained
  // something — asserted, not skipped past, because it is the one place the
  // console states the consequence of enabling in numbers.
  // Generous, and deliberately so: enabling is not a flag flip, it runs the
  // grant sweep across the directory inside the request. The default 5s
  // expect timeout is a UI-render budget, not a reconciliation one.
  await expect(page.getByTestId('toast').last()).toContainText('1 person gained', { timeout: 30_000 })
  await expect(page.getByTestId('disabled-banner')).toBeHidden()

  // ---- The access actually moved, and the person page says WHY. ----
  await page.goto(`http://localhost:5173/people/${person.id}`)
  await page.getByRole('tab', { name: 'Entitlements' }).click()
  const row = page.getByTestId('entitlements-row').filter({ hasText: groupName })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('Role-derived')
  await expect(row).toContainText(roleName)

  // ---- Editing the draft again re-arms the gate. ----
  await page.goto('http://localhost:5173/business-roles')
  await page.getByRole('link', { name: roleName }).click()
  await page.waitForURL(`http://localhost:5173/business-roles/${roleId}`)
  await page.getByLabel('Value').fill(`${jobTitle} SDR`)
  await page.getByTestId('save-draft').click()

  await expect(page.getByTestId('publish-role')).toBeDisabled()
  await expect(page.getByTestId('business-role-state')).toContainText(/pending simulation/i)

  // ---- Leave the shared dev database as close to how this test found it as
  // the product allows. There is no DELETE for a business role (the same "no
  // delete" posture the rest of this product takes), so the row survives —
  // but two things about it must not.
  //
  // Disabled, because an enabled leftover would keep granting to anybody who
  // later happened to match it. And EMPTIED of its published grants, because
  // `business_role_grants.group_id` is a real FK onto `groups`: leaving one
  // behind makes this run's own group undeletable, and the run-final cleanup
  // (`support/cleanup-tracker.ts` -> `apps/api/scripts/e2e-cleanup.ts`)
  // reports it as a row it could not remove — observed, not theorised.
  //
  // Done through the API rather than the UI on purpose: this is teardown,
  // not part of the journey being proved, and it goes through the same gate
  // (draft -> simulate -> publish) any other caller would.
  const auth = { Authorization: `Bearer ${token}` }
  const roleUrl = `${API_BASE_URL}/business-roles/${roleId}`
  const disable = await request.post(`${roleUrl}/disable`, { headers: auth })
  expect(disable.ok()).toBeTruthy()
  const emptyDraft = await request.put(`${roleUrl}/draft`, {
    headers: auth,
    data: { conditions: [], grants: [] },
  })
  expect(emptyDraft.ok()).toBeTruthy()
  const teardownSimulation = await request.post(`${roleUrl}/simulate`, { headers: auth })
  expect(teardownSimulation.ok()).toBeTruthy()
  const teardownPublish = await request.post(`${roleUrl}/publish`, { headers: auth })
  expect(teardownPublish.ok()).toBeTruthy()
})
