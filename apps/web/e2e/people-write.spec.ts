import { expect, test, type Page } from '@playwright/test'
import { trackOrgUnit, trackUser } from './support/cleanup-tracker'

/** Pulls the trailing UUID off the current URL — `/people/<id>` or `/org-units/<id>` alike — so a just-created row's id can be handed to the cleanup tracker without a second round trip. */
function idFromUrl(page: Page): string {
  const match = /([0-9a-f-]{36})$/.exec(page.url())
  if (!match) throw new Error(`expected a trailing UUID in the URL, got: ${page.url()}`)
  return match[1]!
}

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
 * Navigates to the create-user form.
 *
 * Task 4 fixed the history/OIDC-callback desync task-3-report.md described
 * (auth/AuthRoot.tsx now drives `onSigninCallback` through react-router's
 * own `useNavigate()` instead of a raw `window.history.replaceState`, so
 * react-router's internal location can no longer drift from the real URL —
 * see AuthRoot's own doc comment, and e2e/groups.spec.ts's dedicated
 * regression test for that exact scenario).
 *
 * The wait below is a DIFFERENT, narrower one, discovered while removing
 * the old blanket 400ms settle: `waitForURL` only proves the BROWSER's
 * address bar changed (react-router's `navigate()` calls `history.
 * pushState` synchronously); it says nothing about whether REACT has
 * actually re-rendered yet, which happens asynchronously. `PeopleListPage`'s
 * own org-unit FILTER and `CreateUserPage`'s org-unit FIELD both carry the
 * accessible name "Org unit" — in the narrow window between the URL
 * changing and React swapping the two pages, `getByLabel('Org unit')`
 * uniquely resolves (no strict-mode ambiguity) to whichever one is STILL
 * attached, which can be the OLD page's filter — reproduced directly via a
 * throwaway diagnostic script: selecting an option landed on
 * `PeopleListPage`'s own handler and changed the URL to `/?orgUnit=...`
 * instead of updating the form. Waiting for `CreateUserPage`'s own,
 * unique-to-it heading first is a real, content-based wait (not a timeout)
 * that closes the gap `waitForURL` alone leaves open — task-3-report.md's
 * own "a semantic wait... does not reliably avoid it" referred to waiting
 * on the SAME ambiguous org-unit select, which is a weak signal since the
 * stale element is already enabled too; waiting on something that can only
 * ever belong to the NEW page is a stronger one.
 */
async function goToCreateUserForm(page: Page): Promise<void> {
  await page.getByTestId('create-user-link').click()
  await page.waitForURL('http://localhost:5173/people/new')
  await expect(page.getByRole('heading', { name: 'Create user' })).toBeVisible()
}

/**
 * Milestone 8, Task 3 — People writes. task-3-brief.md's own "Prove it":
 * "create a user, see it in the list, deactivate it, see the status and
 * sync state change. Assert the confirmation names the session
 * consequence."
 */
test('creates a user, finds them in the list, deactivates them, and sees status/sync change — the confirmation names the session consequence', async ({
  page,
}) => {
  await signIn(page)
  await goToCreateUserForm(page)

  const stamp = Date.now()
  const email = `e2e-create-${stamp}@example.com`
  const username = `e2e-create-${stamp}`

  await page.getByLabel('Org unit').selectOption({ index: 1 })
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('First name').fill('E2E')
  await page.getByLabel('Last name').fill('Created')

  await page.getByTestId('person-form-submit').click()
  await page.waitForURL(/\/people\/[0-9a-f-]{36}$/)
  trackUser(idFromUrl(page))
  await expect(page.getByTestId('person-detail-name')).toHaveText('E2E Created')
  await expect(page.getByTestId('toast').last()).toContainText('Created E2E Created.')

  // ---- See it in the list ----
  await page.goto('http://localhost:5173/people')
  await page.getByTestId('people-search-input').fill(username)
  await expect(page.getByTestId('people-row')).toHaveCount(1)
  await expect(page.getByTestId('people-row-link')).toHaveText('E2E Created')

  // Status/sync badges start uncoloured-active / pending-sync, per DESIGN.md.
  // `data-status`, not text — "Pending" (status) and "Sync pending" (sync
  // state) both contain the substring "pending", so a text-based match is
  // genuinely ambiguous between the two adjacent cells.
  const row = page.getByTestId('people-row')
  await expect(row.locator('[data-status="pending"]')).toBeVisible()

  // ---- Deactivate ----
  await page.getByTestId('people-row-link').click()
  await page.waitForURL(/\/people\/[0-9a-f-]{36}$/)
  await page.getByTestId('deactivate-button').click()

  const dialog = page.getByTestId('deactivate-dialog')
  await expect(dialog).toBeVisible()
  // The confirmation must name the SESSION consequence plainly, not just
  // "the record changes" — task-3-brief.md's exact requirement.
  const consequenceText = await page.getByTestId('deactivate-consequence').textContent()
  expect(consequenceText?.toLowerCase()).toContain('session')
  expect(consequenceText?.toLowerCase()).toMatch(/revoke/)
  // Focus starts on Cancel, never the destructive action, on open.
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused()

  await page.getByTestId('deactivate-dialog-confirm').click()
  await expect(dialog).toBeHidden()

  // ---- Status and sync state changed, and a toast reports what happened ----
  const meta = page.locator('.person-detail__meta')
  await expect(meta).toContainText('Deactivated')
  await expect(meta.getByTestId('deactivated-at')).toBeVisible()
  await expect(page.getByTestId('toast').last()).toContainText('Sign-in is blocked and active sessions were revoked')
  // The Deactivate action itself disappears once terminal; Edit remains.
  await expect(page.getByTestId('deactivate-button')).toHaveCount(0)
  await expect(page.getByTestId('edit-person-link')).toBeVisible()

  // ---- Reflected back in the list too, on a fresh load ----
  await page.goto('http://localhost:5173/people')
  await page.getByTestId('people-search-input').fill(username)
  // Let the search box's own debounce (PeopleListPage: 300ms) settle into
  // the URL BEFORE also changing the status filter — changing both filters
  // back-to-back without letting the first settle raced two independent
  // `updateParams` calls against each other and made this assertion flaky.
  await expect(page).toHaveURL(new RegExp(`q=${username}`))
  await page.getByLabel('Status').selectOption('deactivated')
  await expect(page.getByTestId('people-row')).toHaveCount(1)
  await expect(page.locator('[data-testid="people-row"] [data-status="deactivated"]')).toBeVisible()
})

test('edits a user and the change persists after reload; the API rejects a duplicate email inline on the right field', async ({ page }) => {
  await signIn(page)

  const stamp = Date.now()
  const email = `e2e-edit-${stamp}@example.com`
  const username = `e2e-edit-${stamp}`

  await goToCreateUserForm(page)
  await page.getByLabel('Org unit').selectOption({ index: 1 })
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('First name').fill('Edit')
  await page.getByLabel('Last name').fill('Target')
  await page.getByTestId('person-form-submit').click()
  await page.waitForURL(/\/people\/[0-9a-f-]{36}$/)
  trackUser(idFromUrl(page))

  await page.getByTestId('edit-person-link').click()
  await page.waitForURL(/\/people\/[0-9a-f-]{36}\/edit$/)
  await page.getByLabel('Job title').fill('E2E Test Engineer')
  await page.getByTestId('person-form-submit').click()
  await page.waitForURL(/\/people\/[0-9a-f-]{36}$/)
  await expect(page.getByTestId('toast').last()).toContainText('Saved changes to Edit Target.')

  await page.reload()
  await page.getByRole('tab', { name: 'Profile' }).click()
  await expect(page.getByText('E2E Test Engineer')).toBeVisible()

  // Field-named 400/409s land on the right input, not a banner: creating a
  // SECOND user re-using the first's email must surface on the Email field.
  // `goToCreateUserForm` clicks a link that only exists on the People list
  // itself — the previous step left us on the person's OWN detail page, so
  // navigate back there first.
  await page.goto('http://localhost:5173/people')
  await goToCreateUserForm(page)
  await page.getByLabel('Org unit').selectOption({ index: 1 })
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Username').fill(`${username}-dupe`)
  await page.getByLabel('First name').fill('Dup')
  await page.getByLabel('Last name').fill('Licate')
  await page.getByTestId('person-form-submit').click()

  await expect(page.locator('#person-form-primaryEmail')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.locator('#person-form-primaryEmail-error')).toContainText('already exists')
  // Never as a generic top-of-form banner instead.
  await expect(page.getByTestId('person-form-error')).toHaveCount(0)
})

test('org units: creates a child under an existing unit and sees it in the tree with a mono path', async ({ page }) => {
  await signIn(page)
  await page.goto('/org-units')
  await expect(page.getByTestId('org-tree')).toBeVisible()

  const firstRootLink = page.getByTestId('org-tree-link').first()
  const parentName = (await firstRootLink.textContent())?.trim() ?? ''
  await firstRootLink.click()
  await page.waitForURL(/\/org-units\/[0-9a-f-]{36}$/)
  const parentPath = (await page.getByTestId('org-unit-detail-path').textContent())?.trim() ?? ''

  await page.getByTestId('add-child-org-unit').click()
  const childName = `E2E Child ${Date.now()}`
  await page.getByTestId('org-unit-create-name').fill(childName)
  await page.getByTestId('org-unit-create-submit').click()

  // NOT trackOrgUnit(idFromUrl(page)) immediately after this waitForURL: the
  // PARENT's own detail page (line 198 above) matches this EXACT SAME regex
  // — any UUID does — so if the child's own navigation hasn't landed yet,
  // waitForURL can resolve while the browser is STILL on the parent's URL,
  // and reading the id right then would track the PARENT (a pre-existing
  // org unit this test did not create) instead of the new child. Mirrors
  // goToCreateUserForm's own doc comment above: a URL match alone does not
  // prove React has actually rendered the NEW page yet — only the
  // content-based assertion immediately below (which can only pass once the
  // child's own name is genuinely showing) does. The id is read AFTER it,
  // never before.
  await page.waitForURL(/\/org-units\/[0-9a-f-]{36}$/)
  await expect(page.getByTestId('org-unit-detail-name')).toHaveText(childName)
  trackOrgUnit(idFromUrl(page))
  await expect(page.getByTestId('org-unit-detail-path')).toHaveClass(/mono/)
  // ltree paths render mono (DESIGN.md), and a CHILD's path is its parent's
  // path plus one more dot-separated segment.
  const childPath = await page.getByTestId('org-unit-detail-path').textContent()
  expect(childPath).toContain('.')
  expect(childPath?.startsWith(`${parentPath}.`)).toBe(true)
  // Scoped to the detail pane specifically — the SAME name is also, quite
  // correctly, a link inside the tree at the same time (the parent's own
  // node), so an unscoped getByRole here is genuinely ambiguous by design,
  // not a bug.
  await expect(page.locator('.org-unit-detail').getByRole('link', { name: parentName })).toBeVisible()

  // The new node is now visible and selected in the tree itself.
  await expect(page.getByTestId('org-tree-link').filter({ hasText: childName })).toHaveClass(
    /org-tree__link--selected/,
  )

  // Created toast, and the "Add child" affordance is available again for
  // this new node too (progressive disclosure, not a one-shot form).
  await expect(page.getByTestId('toast').last()).toContainText(`Created ${childName}.`)
  await expect(page.getByTestId('add-child-org-unit')).toBeVisible()
})
