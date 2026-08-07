import { expect, test, type Page } from '@playwright/test'
import { trackGroup, trackUser } from './support/cleanup-tracker'

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

/** Same technique e2e/people.spec.ts already uses — pulls the real OIDC access token out of sessionStorage, to seed/inspect fixtures through the actual API rather than the UI where the UI itself isn't what a given step is testing. */
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
 * Creates a group through the real UI form and returns its id, parsed off
 * the resulting detail-page URL — used (rather than matching a `<select>`
 * option by its LABEL text, which differs for a global vs. scoped group
 * thanks to GroupNestedGroupsTab's own "(Global)" suffix) so every
 * `selectOption({ value: ... })` call below is unambiguous regardless of
 * which kind of group it is.
 *
 * Waits for the "Create group" heading — content unique to this page —
 * before touching any field, not just `waitForURL`: see
 * people-write.spec.ts's `goToCreateUserForm` for why a URL match alone
 * does not prove React has finished swapping the page yet.
 */
async function createGroupViaUi(page: Page, name: string, scopeOptionIndex?: number): Promise<string> {
  await page.goto('http://localhost:5173/groups')
  await page.getByTestId('create-group-link').click()
  await page.waitForURL('http://localhost:5173/groups/new')
  await expect(page.getByRole('heading', { name: 'Create group' })).toBeVisible()
  await page.getByLabel('Name').fill(name)
  if (scopeOptionIndex !== undefined) {
    await page.getByLabel('Scope').selectOption({ index: scopeOptionIndex })
  }
  await page.getByTestId('group-form-submit').click()
  await page.waitForURL(/\/groups\/[0-9a-f-]{36}$/)
  const match = /\/groups\/([0-9a-f-]{36})$/.exec(page.url())
  if (!match) throw new Error(`unexpected URL after creating group: ${page.url()}`)
  trackGroup(match[1]!)
  return match[1]!
}

function groupUrl(id: string): string {
  return `http://localhost:5173/groups/${id}`
}

/**
 * Milestone 8, Task 4 — Groups, nested membership, and role assignment.
 * task-4-brief.md's own "Prove it": "add a user to a nested group, confirm
 * they appear under effective but not direct membership on the ancestor."
 */

test('creates a group scoped to a real org unit, edits its description, and the change persists after reload', async ({
  page,
}) => {
  await signIn(page)
  const stamp = Date.now()
  const name = `E2E Scoped Group ${stamp}`

  const id = await createGroupViaUi(page, name, 1) // index 1 = first REAL org unit (index 0 is "Global")
  await expect(page.getByTestId('group-detail-name')).toHaveText(name)
  // A scoped group's own scope badge renders the org unit's mono PATH, never the word "Global".
  await expect(page.getByTestId('group-scope-badge')).toHaveAttribute('data-scope', 'scoped')
  await expect(page.getByTestId('group-scope-badge')).toHaveClass(/mono/)

  await page.getByTestId('edit-group-link').click()
  await page.waitForURL(/\/groups\/[0-9a-f-]{36}\/edit$/)
  await page.getByLabel('Description').fill('E2E description')
  await page.getByTestId('group-form-submit').click()
  await page.waitForURL(groupUrl(id))
  await expect(page.getByTestId('toast').last()).toContainText(`Saved changes to ${name}`)

  await page.reload()
  // The description legitimately renders TWICE — the header meta row
  // (visible regardless of tab, same as PersonDetailPage's own header) AND
  // the Overview tab's own detail-grid row — so this scopes to the header,
  // same technique people-write.spec.ts uses for `.person-detail__meta`.
  await expect(page.locator('.person-detail__meta').getByText('E2E description')).toBeVisible()
})

test('a group created with no scope is marked Global, visibly and explicitly', async ({ page }) => {
  await signIn(page)
  const stamp = Date.now()
  const name = `E2E Global Group ${stamp}`

  // scopeOptionIndex omitted -> leaves the Scope select on its default first
  // option, "Global — visible everywhere" (GroupForm.tsx).
  await createGroupViaUi(page, name)

  await expect(page.getByTestId('group-scope-badge')).toHaveText('Global')
  await expect(page.getByTestId('group-scope-badge')).toHaveAttribute('data-scope', 'global')
  await expect(page.getByTestId('group-global-note')).toContainText('no org unit')
})

test('adding a user to a NESTED CHILD group shows them as EFFECTIVE, not direct, on the ancestor — direct and effective membership are visually and structurally distinct', async ({
  page,
  request,
}) => {
  await signIn(page)
  const token = await getAccessToken(page)
  const stamp = Date.now()

  const meRes = await request.get(`${API_BASE_URL}/users?search=${encodeURIComponent(USERNAME)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(meRes.ok()).toBeTruthy()
  const me = (await meRes.json()).items[0] as { id: string; displayName: string; username: string }

  const parentName = `E2E Ancestor ${stamp}`
  const childName = `E2E Nested Child ${stamp}`
  const parentId = await createGroupViaUi(page, parentName)
  const childId = await createGroupViaUi(page, childName)

  // ---- Nest the child under the parent, via the UI ----
  await page.goto(groupUrl(parentId))
  await page.getByRole('tab', { name: 'Nested groups' }).click()
  await page.getByTestId('group-show-add-child').click()
  await page.getByTestId('group-add-child-select').selectOption({ value: childId })
  await page.getByTestId('group-add-child-submit').click()
  await expect(page.getByTestId('toast').last()).toContainText(`Nested ${childName} under ${parentName}`)
  await expect(page.getByTestId('group-child-list').getByText(childName)).toBeVisible()

  // ---- Add the admin as a DIRECT member of the CHILD, via the UI ----
  await page.goto(groupUrl(childId))
  await page.getByRole('tab', { name: 'Members' }).click()
  await page.getByTestId('group-show-add-member').click()
  await page.getByTestId('group-add-member-input').fill(USERNAME)
  await expect(page.getByTestId('group-add-member-result').first()).toBeVisible()
  await page.getByTestId('group-add-member-result').filter({ hasText: me.username }).first().click()
  await page.getByTestId('group-add-member-submit').click()
  await expect(page.getByTestId('toast').last()).toContainText(`Added ${me.displayName} to ${childName}`)
  await expect(page.getByTestId('group-direct-members').getByText(me.displayName)).toBeVisible()

  // ---- THE PROOF: on the ANCESTOR (parent), the admin is EFFECTIVE, never DIRECT ----
  await page.goto(groupUrl(parentId))
  await page.getByRole('tab', { name: 'Members' }).click()
  await expect(page.getByTestId('group-effective-members').getByText(me.displayName)).toBeVisible()
  await expect(page.getByTestId('group-direct-members')).not.toContainText(me.displayName)
  // Structural, not a tooltip: two separately-headed, separately-testid'd
  // lists, not one list with a badge distinguishing rows within it.
  await expect(page.getByText('Direct members (0)')).toBeVisible()
  await expect(page.getByText('Members via nested groups (1)')).toBeVisible()
})

test('a cycle attempt is explained in plain language naming the groups involved, never the raw error code — and nothing is actually nested', async ({
  page,
}) => {
  await signIn(page)
  const stamp = Date.now()
  const aName = `E2E Cycle A ${stamp}`
  const bName = `E2E Cycle B ${stamp}`

  const aId = await createGroupViaUi(page, aName)
  const bId = await createGroupViaUi(page, bName)

  // A becomes B's parent (nest B under A).
  await page.goto(groupUrl(aId))
  await page.getByRole('tab', { name: 'Nested groups' }).click()
  await page.getByTestId('group-show-add-child').click()
  await page.getByTestId('group-add-child-select').selectOption({ value: bId })
  await page.getByTestId('group-add-child-submit').click()
  await expect(page.getByTestId('toast').last()).toContainText(`Nested ${bName} under ${aName}`)

  // Attempting to ALSO nest A under B would close a loop: A -> B -> A.
  await page.goto(groupUrl(bId))
  await page.getByRole('tab', { name: 'Nested groups' }).click()
  await page.getByTestId('group-show-add-child').click()
  await page.getByTestId('group-add-child-select').selectOption({ value: aId })
  await page.getByTestId('group-add-child-submit').click()

  const errorText = await page.getByTestId('group-add-child-error').textContent()
  expect(errorText).toBeTruthy()
  expect(errorText).not.toContain('CYCLE_DETECTED')
  expect(errorText?.toLowerCase()).toMatch(/contain|loop|cycle/)
  // Names itself, in the vocabulary the admin is already looking at.
  expect(errorText).toContain(aName)
  expect(errorText).toContain(bName)

  // The rejected attempt left the graph exactly as it was — B never became A's parent.
  await expect(page.getByTestId('group-child-list')).not.toContainText(aName)
})

test('grants a global role and a scoped role, sees both listed distinctly, then revokes one without disturbing the other', async ({
  page,
  request,
}) => {
  await signIn(page)
  const token = await getAccessToken(page)
  const stamp = Date.now()

  const orgRes = await request.get(`${API_BASE_URL}/org-units?limit=1`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(orgRes.ok()).toBeTruthy()
  const org = (await orgRes.json()).items[0] as { id: string; name: string; path: string }

  const createRes = await request.post(`${API_BASE_URL}/users`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      primaryEmail: `e2e-role-target-${stamp}@example.com`,
      username: `e2e-role-target-${stamp}`,
      firstName: 'RoleTarget',
      lastName: String(stamp),
      orgUnitId: org.id,
    },
  })
  expect(createRes.ok()).toBeTruthy()
  const target = (await createRes.json()) as { id: string; displayName: string }
  trackUser(target.id)

  await page.goto(`http://localhost:5173/people/${target.id}`)
  await page.getByRole('tab', { name: 'Roles' }).click()
  await expect(page.getByText(`${target.displayName} holds no role assignments.`)).toBeVisible()

  // ---- Grant GLOBAL read_only ----
  await page.getByTestId('role-show-grant').click()
  await page.getByTestId('role-grant-role').selectOption('read_only')
  await page.getByTestId('role-grant-scope').selectOption({ label: 'Global — every org unit' })
  await page.getByTestId('role-grant-submit').click()
  await expect(page.getByTestId('toast').last()).toContainText(`Granted Read only to ${target.displayName}`)
  const readOnlyRow = page.getByTestId('role-assignment-row').filter({ hasText: 'Read only' })
  await expect(readOnlyRow).toBeVisible()
  await expect(readOnlyRow.getByTestId('role-scope-global')).toBeVisible()

  // ---- Grant SCOPED help_desk, at the org unit the target itself lives in ----
  await page.getByTestId('role-show-grant').click()
  await page.getByTestId('role-grant-role').selectOption('help_desk')
  await page.getByTestId('role-grant-scope').selectOption({ value: org.id })
  await page.getByTestId('role-grant-submit').click()
  await expect(page.getByTestId('toast').last()).toContainText(`Granted Help desk to ${target.displayName}`)
  const helpDeskRow = page.getByTestId('role-assignment-row').filter({ hasText: 'Help desk' })
  await expect(helpDeskRow).toBeVisible()
  await expect(helpDeskRow.getByTestId('role-scope-scoped')).toContainText(org.path)

  // ---- Revoke the global grant ----
  await readOnlyRow.getByTestId('role-revoke-button').click()
  await expect(page.getByTestId('revoke-role-dialog')).toBeVisible()
  await page.getByTestId('revoke-role-dialog-confirm').click()
  await expect(page.getByTestId('revoke-role-dialog')).toBeHidden()
  await expect(page.getByTestId('toast').last()).toContainText(`Revoked Read only from ${target.displayName}`)
  await expect(page.getByTestId('role-assignment-row').filter({ hasText: 'Read only' })).toHaveCount(0)
  // The other grant is untouched.
  await expect(page.getByTestId('role-assignment-row').filter({ hasText: 'Help desk' })).toBeVisible()
})

/**
 * A PRE-EXISTING BUG, fixed as part of this task (see auth/AuthRoot.tsx's
 * own doc comment): `onSigninCallback` used to call `window.history.
 * replaceState` directly, bypassing react-router's history abstraction, so
 * react-router's internal notion of "current location" could desync from
 * the real URL immediately after signing in. The very next
 * `useSearchParams`-driven update anywhere (e.g. a filter `<select>`) would
 * then merge onto that stale internal location instead of the real one,
 * resurrecting the original `?state=&code=` OIDC params into the URL —
 * task-3-report.md reproduced this on the People list's own org-unit
 * filter. This test exercises that EXACT scenario — a filter select acted
 * on immediately after the post-sign-in landing, with no artificial settle
 * — and asserts it no longer happens.
 */
test('immediately after signing in, using a filter select does not resurrect stale OIDC callback params into the URL', async ({
  page,
}) => {
  await signIn(page)
  await expect(page.getByTestId('people-table')).toBeVisible()

  await page.getByLabel('Status').selectOption('active')

  await expect(page).toHaveURL(/status=active/)
  expect(page.url()).not.toContain('code=')
  expect(page.url()).not.toContain('state=')
})
