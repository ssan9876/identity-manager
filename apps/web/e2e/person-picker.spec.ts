import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

const ADMIN_USERNAME = 'admin@example.com'
const ADMIN_PASSWORD = 'dev_password_change_me'
const API_BASE_URL = 'http://localhost:3000'

// Keycloak's own admin REST API, hit directly — see
// provisionKeycloakPassword's own doc comment for why. Values match
// keycloak/realm-import/identity-manager-realm.json and apps/api/.env
// exactly: the `idm-sync-service` client this dev realm already grants
// `manage-users` on `realm-management`, the SAME capability
// KeycloakAdminClient (apps/api/src/keycloak/keycloak-admin.client.ts) uses
// for ordinary user sync.
const KEYCLOAK_BASE_URL = 'http://localhost:8080'
const KEYCLOAK_REALM = 'identity-manager'
const KEYCLOAK_ADMIN_CLIENT_ID = 'idm-sync-service'
const KEYCLOAK_ADMIN_CLIENT_SECRET = 'idm_sync_dev_secret_change_me'

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** Same real sign-in flow every other e2e file's own copy of this helper uses (e2e/login.spec.ts proves it works) — parameterized on username/password so this file can sign in as more than just the seeded admin. */
async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/realms\/identity-manager\/protocol\/openid-connect\/auth/)
  await page.getByLabel(/username|email/i).fill(username)
  await page.getByRole('textbox', { name: /password/i }).fill(password)
  await page.getByRole('button', { name: /sign in|log in/i }).click()
  await page.waitForURL('http://localhost:5173/')
}

/** Same technique e2e/groups.spec.ts already uses — pulls the real OIDC access token out of sessionStorage to seed fixtures through the actual API. */
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
  return body.items[0]
}

interface CreatedPerson {
  id: string
  displayName: string
  username: string
}

async function createPersonViaApi(
  request: APIRequestContext,
  token: string,
  input: { firstName: string; lastName: string; username: string; orgUnitId: string; startDate?: string },
): Promise<CreatedPerson> {
  const res = await request.post(`${API_BASE_URL}/users`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      primaryEmail: `${input.username}@example.com`,
      username: input.username,
      firstName: input.firstName,
      lastName: input.lastName,
      orgUnitId: input.orgUnitId,
      startDate: input.startDate,
    },
  })
  expect(res.ok()).toBeTruthy()
  return (await res.json()) as CreatedPerson
}

/**
 * `POST /users` always creates `status: 'pending'` (UsersRepository.create;
 * activation is deliberately not part of the create route's own contract —
 * see the milestone plan's transition matrix), and
 * `PermissionEngine.resolveActor` fails closed for anything but `status:
 * 'active'` (apps/api/src/authz/permission.engine.ts) — a fixture person
 * this file actually signs IN as (the scoped operator, below) therefore
 * needs to be activated for real, and there is no HTTP route that does
 * that directly. The only path is the same `pnpm run jml:lifecycle` CLI
 * README.md documents as this project's real, on-demand joiner/mover/leaver
 * mechanism (apps/api/src/jml/lifecycle-cli.ts) — it activates every
 * `pending` user whose `startDate` has already arrived. Run as a real child
 * process against the SAME dev database and Keycloak this whole file
 * already talks to; harmless to run more than once (idempotent — an
 * already-active user is simply not selected again) and safe against every
 * OTHER fixture in this shared, persistent dev database, since none of this
 * suite's other create calls ever set a `startDate` at all (the activation
 * query requires a non-null one).
 */
function activatePendingUsers(): void {
  const e2eDir = dirname(fileURLToPath(import.meta.url))
  const repoRoot = join(e2eDir, '..', '..', '..')
  execSync('pnpm --filter @idm/api run jml:lifecycle', { cwd: repoRoot, stdio: 'pipe' })
}

async function createOrgUnitViaApi(
  request: APIRequestContext,
  token: string,
  name: string,
  parentId: string,
): Promise<{ id: string }> {
  const res = await request.post(`${API_BASE_URL}/org-units`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name, parentId },
  })
  expect(res.ok()).toBeTruthy()
  return (await res.json()) as { id: string }
}

async function getKeycloakAdminToken(): Promise<string> {
  const res = await fetch(`${KEYCLOAK_BASE_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: KEYCLOAK_ADMIN_CLIENT_ID,
      client_secret: KEYCLOAK_ADMIN_CLIENT_SECRET,
    }),
  })
  if (!res.ok) {
    throw new Error(`Keycloak admin token request failed: ${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as { access_token: string }
  return body.access_token
}

/**
 * Provisions a REAL, sign-in-able Keycloak identity for `username`, so this
 * file's scoped-operator test can drive the actual hosted login page as a
 * SECOND principal, not just the one seeded admin every other e2e test
 * signs in as. Find-or-create, defensive against a genuine race against the
 * app's own SyncWorker (which independently, eventually creates a Keycloak
 * user for the SAME local user this test also creates, via its outbox) —
 * mirrors KeycloakAdminClient.ensureGroup's own find-then-recover-on-409
 * shape for the identical reason.
 *
 * This is TEST INFRASTRUCTURE reaching directly into Keycloak's own admin
 * REST API to set up a fixture principal — the same category of thing
 * apps/api/test/scope-narrowing.spec.ts's fixtures already do by calling
 * repository methods directly, bypassing the ordinary write path, to set up
 * a scoped actor. It does not touch this product's own code paths: the
 * milestone's global constraint ("never generate, transmit or store a
 * credential") binds apps/api and apps/web, which still never do this
 * anywhere — KeycloakAdminClient.createUser's own binding contract ("no
 * method here ever sends a password") is completely unchanged and untouched
 * by this helper existing in a test file.
 */
async function provisionKeycloakPassword(
  username: string,
  email: string,
  password: string,
  name: { firstName: string; lastName: string },
): Promise<void> {
  const adminToken = await getKeycloakAdminToken()
  const authHeader = { Authorization: `Bearer ${adminToken}` }

  async function findUserId(): Promise<string | null> {
    const res = await fetch(
      `${KEYCLOAK_BASE_URL}/admin/realms/${KEYCLOAK_REALM}/users?username=${encodeURIComponent(username)}&exact=true`,
      { headers: authHeader },
    )
    if (!res.ok) throw new Error(`Keycloak find user failed: ${res.status} ${await res.text()}`)
    const rows = (await res.json()) as { id: string }[]
    return rows[0]?.id ?? null
  }

  let keycloakUserId = await findUserId()

  if (keycloakUserId === null) {
    const createRes = await fetch(`${KEYCLOAK_BASE_URL}/admin/realms/${KEYCLOAK_REALM}/users`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      // firstName/lastName are load-bearing, not cosmetic: the realm's own
      // declarative user profile (keycloak/realm-import/identity-manager-
      // realm.json's kc.user.profile.config) marks both `required` for role
      // "user" — omitting them left Keycloak's login flow stuck on its own
      // "update account information" required-action screen, which this
      // file's signIn() does not know how to drive, hanging every waitForURL
      // after it until the test's own timeout (confirmed by running this
      // test for real: it failed at exactly that waitForURL, not at any of
      // this file's own assertions). Matches the seeded admin@example.com
      // fixture's own shape.
      body: JSON.stringify({
        username,
        email,
        firstName: name.firstName,
        lastName: name.lastName,
        enabled: true,
        emailVerified: true,
      }),
    })
    if (createRes.status === 409) {
      keycloakUserId = await findUserId()
      if (keycloakUserId === null) {
        throw new Error(`Keycloak create user 409'd but no matching user was found afterward for "${username}"`)
      }
    } else if (!createRes.ok) {
      throw new Error(`Keycloak create user failed: ${createRes.status} ${await createRes.text()}`)
    } else {
      const id = createRes.headers.get('location')?.split('/').pop()
      if (!id) throw new Error('Keycloak create user succeeded but returned no Location header')
      keycloakUserId = id
    }
  }

  const passwordRes = await fetch(
    `${KEYCLOAK_BASE_URL}/admin/realms/${KEYCLOAK_REALM}/users/${keycloakUserId}/reset-password`,
    {
      method: 'PUT',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      // temporary: false — a temporary password would force Keycloak's own
      // "update password" required-action screen on first login, which
      // would strand signIn() before it ever reaches this app. Matches the
      // seeded admin@example.com fixture's own credential shape exactly
      // (keycloak/realm-import/identity-manager-realm.json).
      body: JSON.stringify({ type: 'password', value: password, temporary: false }),
    },
  )
  if (!passwordRes.ok) {
    throw new Error(`Keycloak reset-password failed: ${passwordRes.status} ${await passwordRes.text()}`)
  }
}

async function goToCreateUserForm(page: Page): Promise<void> {
  await page.goto('http://localhost:5173/people/new')
  await expect(page.getByRole('heading', { name: 'Create user' })).toBeVisible()
}

/**
 * Milestone 9, Task 3 — the person picker, and the end of hand-typed UUIDs.
 * PersonForm's `managerId` field used to be a raw text input whose own hint
 * read "copy it from the mono ID on their own profile page" — these four
 * tests are this task's own "Prove it": typing a name and choosing from
 * results (not typing a UUID), the manager's NAME surviving both the detail
 * page and a re-opened edit form, full keyboard operability, the debounce/
 * cancellation race actually being closed rather than merely asserted, and
 * a scoped operator's results genuinely staying inside their own scope.
 */

test('sets a user\'s manager by typing a name and choosing from results; the manager\'s NAME — never a UUID — appears on the detail page, and on a re-opened edit form', async ({
  page,
  request,
}) => {
  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD)
  const token = await getAccessToken(page)
  const stamp = Date.now()
  const org = await fetchAnyOrgUnit(request, token)

  const manager = await createPersonViaApi(request, token, {
    firstName: 'Manager',
    lastName: `Candidate ${stamp}`,
    username: `e2e-picker-manager-${stamp}`,
    orgUnitId: org.id,
  })

  await goToCreateUserForm(page)
  await page.getByLabel('Org unit').selectOption({ value: org.id })
  await page.getByLabel('Email').fill(`e2e-picker-report-${stamp}@example.com`)
  await page.getByLabel('Username').fill(`e2e-picker-report-${stamp}`)
  await page.getByLabel('First name').fill('Report')
  await page.getByLabel('Last name').fill('Line')

  // getByRole('combobox', ...), not getByLabel — Playwright's getByLabel does
  // a case-insensitive SUBSTRING match, which also matches the clear
  // button's own aria-label ("Clear manager"), a real ambiguity caught by
  // running this file for real (strict-mode violation) before trusting it.
  const managerField = page.getByRole('combobox', { name: 'Manager' })
  await expect(managerField).toHaveAttribute('role', 'combobox')
  await expect(managerField).toHaveAttribute('aria-expanded', 'false')

  // Type the manager's real NAME — never their id — and choose them from
  // the results list. This is the defect closing: the old field asked for
  // a hand-typed UUID; this one only ever accepts an actual resolved person.
  await managerField.fill(manager.displayName)
  const option = page.getByTestId('combobox-option').filter({ hasText: manager.displayName })
  await expect(option).toBeVisible()
  await option.click()
  await expect(managerField).toHaveValue(manager.displayName)
  await expect(page.getByTestId('combobox-listbox')).toHaveCount(0)

  await page.getByTestId('person-form-submit').click()
  await page.waitForURL(/\/people\/[0-9a-f-]{36}$/)

  // ---- Detail page: the manager renders as a NAME (and a link to them),
  // never a raw id ----
  const managerCell = page.getByTestId('person-detail-manager')
  const managerLink = page.getByTestId('person-detail-manager-link')
  await expect(managerLink).toHaveText(manager.displayName)
  const managerCellText = await managerCell.textContent()
  expect(managerCellText).not.toMatch(UUID_PATTERN)

  await managerLink.click()
  await page.waitForURL(`http://localhost:5173/people/${manager.id}`)
  await expect(page.getByTestId('person-detail-name')).toHaveText(manager.displayName)

  // ---- Re-opening EDIT on the report's own record shows the manager's
  // NAME too, pre-filled — not blank, not the raw id. Getting this wrong is
  // the most likely way to half-fix the defect (task-3 brief, verbatim). ----
  await page.goto('http://localhost:5173/people')
  await page.getByTestId('people-search-input').fill(`e2e-picker-report-${stamp}`)
  // PeopleListPage's own search box debounces 300ms before it updates the
  // URL and re-fetches (PeopleListPage.tsx) — wait for that to actually land
  // (down to exactly the one row) before clicking, same reasoning
  // people-write.spec.ts's own equivalent step documents.
  await expect(page.getByTestId('people-row')).toHaveCount(1)
  await page.getByTestId('people-row-link').click()
  await page.waitForURL(/\/people\/[0-9a-f-]{36}$/)
  await page.getByTestId('edit-person-link').click()
  await page.waitForURL(/\/people\/[0-9a-f-]{36}\/edit$/)
  await expect(page.getByRole('combobox', { name: 'Manager' })).toHaveValue(manager.displayName)
})

test('the picker is fully keyboard operable: arrow-key navigation moves between real results, Enter selects, Escape reverts an uncommitted draft, and the clear control is keyboard-reachable', async ({
  page,
  request,
}) => {
  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD)
  const token = await getAccessToken(page)
  const stamp = Date.now()
  const org = await fetchAnyOrgUnit(request, token)

  // Two distinct people sharing one search term, ordered deterministically
  // by username (UsersRepository.list orders asc(username)) so pressing
  // ArrowDown once has a predictable, provable effect: index 0 (A) -> 1 (B).
  const sharedTerm = `Kbnav${stamp}`
  const candidateA = await createPersonViaApi(request, token, {
    firstName: sharedTerm,
    lastName: 'Alpha',
    username: `e2e-kbnav-${stamp}-a`,
    orgUnitId: org.id,
  })
  const candidateB = await createPersonViaApi(request, token, {
    firstName: sharedTerm,
    lastName: 'Beta',
    username: `e2e-kbnav-${stamp}-b`,
    orgUnitId: org.id,
  })

  await goToCreateUserForm(page)
  // getByRole('combobox', ...), not getByLabel — Playwright's getByLabel does
  // a case-insensitive SUBSTRING match, which also matches the clear
  // button's own aria-label ("Clear manager"), a real ambiguity caught by
  // running this file for real (strict-mode violation) before trusting it.
  const managerField = page.getByRole('combobox', { name: 'Manager' })

  // ---- Escape reverts an uncommitted draft, never lets typed-but-not-
  // selected text become the value ----
  await managerField.click()
  await managerField.fill('nobody matches this text at all')
  await expect(page.getByTestId('combobox-listbox')).toBeVisible()
  await managerField.press('Escape')
  await expect(managerField).toHaveValue('')
  await expect(page.getByTestId('combobox-listbox')).toHaveCount(0)

  // ---- Arrow-key navigation genuinely moves the highlight between two
  // real options (not just a no-op on a single result) ----
  await managerField.fill(sharedTerm)
  await expect(page.getByTestId('combobox-option')).toHaveCount(2)

  const firstActiveId = await managerField.getAttribute('aria-activedescendant')
  expect(firstActiveId).toBeTruthy()
  await expect(page.locator(`#${firstActiveId}`)).toContainText(candidateA.displayName)

  await managerField.press('ArrowDown')
  const secondActiveId = await managerField.getAttribute('aria-activedescendant')
  expect(secondActiveId).toBeTruthy()
  expect(secondActiveId).not.toBe(firstActiveId)
  await expect(page.locator(`#${secondActiveId}`)).toContainText(candidateB.displayName)
  // The results announcement for screen-reader users.
  await expect(page.getByRole('status')).toHaveText('2 results available.')

  await managerField.press('Enter')
  await expect(managerField).toHaveValue(candidateB.displayName)
  await expect(page.getByTestId('combobox-listbox')).toHaveCount(0)

  // ---- The clear control is reachable and operable via keyboard alone ----
  const clearButton = page.getByRole('button', { name: 'Clear manager' })
  await expect(clearButton).toBeVisible()
  await clearButton.press('Enter')
  await expect(managerField).toHaveValue('')
  await expect(clearButton).toHaveCount(0)
  // Clearing returns focus to the field itself, so the admin can immediately
  // start a fresh search without an extra Tab.
  await expect(managerField).toBeFocused()
})

/**
 * The debounce+cancellation race — "an admin typing fast must never see an
 * earlier response overwrite a later one" — asserted against real,
 * deliberately reordered network responses, not a hypothetical. `page.route`
 * delays ONLY the first-typed term's response well past the second's, then
 * this waits past that delay too before asserting: a naive implementation
 * with no cancellation at all would show the SLOW term's results the moment
 * they finally arrive, clobbering the already-displayed fast ones — exactly
 * the failure this proves does not happen.
 */
test('typing a second, faster search before a first, slower one resolves never lets the slower response overwrite the faster one\'s results', async ({
  page,
  request,
}) => {
  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD)
  const token = await getAccessToken(page)
  const stamp = Date.now()
  const org = await fetchAnyOrgUnit(request, token)

  const slowTerm = `Eslow${stamp}`
  const fastTerm = `Efast${stamp}`
  const slowPerson = await createPersonViaApi(request, token, {
    firstName: slowTerm,
    lastName: 'Target',
    username: `e2e-race-slow-${stamp}`,
    orgUnitId: org.id,
  })
  const fastPerson = await createPersonViaApi(request, token, {
    firstName: fastTerm,
    lastName: 'Target',
    username: `e2e-race-fast-${stamp}`,
    orgUnitId: org.id,
  })

  await goToCreateUserForm(page)

  const SLOW_DELAY_MS = 1500
  await page.route(/\/users\?/, async (route) => {
    const url = new URL(route.request().url())
    const search = url.searchParams.get('search') ?? ''
    if (search.includes(slowTerm)) {
      await new Promise((resolve) => setTimeout(resolve, SLOW_DELAY_MS))
    }
    await route.continue()
  })

  // getByRole('combobox', ...), not getByLabel — Playwright's getByLabel does
  // a case-insensitive SUBSTRING match, which also matches the clear
  // button's own aria-label ("Clear manager"), a real ambiguity caught by
  // running this file for real (strict-mode violation) before trusting it.
  const managerField = page.getByRole('combobox', { name: 'Manager' })

  // Type the SLOW term first, and give its own 300ms debounce time to
  // actually fire the (now artificially delayed) request before moving on —
  // otherwise this would only prove debounce cancels a pending TIMER, a much
  // weaker property than cancelling/ignoring an already IN-FLIGHT request.
  await managerField.fill(slowTerm)
  await page.waitForTimeout(350)

  // Now type the FAST term. Its own request is not delayed at all.
  await managerField.fill(fastTerm)

  await expect(page.getByTestId('combobox-option').filter({ hasText: fastPerson.displayName })).toBeVisible()
  await expect(page.getByTestId('combobox-option').filter({ hasText: slowPerson.displayName })).toHaveCount(0)

  // Wait well past when the slow response finally arrives, and assert the
  // fast term's results are STILL what's showing — the actual proof.
  await page.waitForTimeout(SLOW_DELAY_MS + 500)
  await expect(page.getByTestId('combobox-option').filter({ hasText: fastPerson.displayName })).toBeVisible()
  await expect(page.getByTestId('combobox-option').filter({ hasText: slowPerson.displayName })).toHaveCount(0)
  await expect(managerField).toHaveValue(fastTerm)
})

/**
 * Scope safety — the picker calls the SAME `GET /users?search=` route
 * PeopleListPage already uses, which narrows through
 * `PermissionEngine.scopePathsFor` inside `UsersController.list`
 * unconditionally (search present or not — see users.controller.ts). No new
 * endpoint exists for this picker. This test proves that reuse is actually
 * safe for a REAL scoped actor, not just by reading the controller: two
 * people share one search term, one inside a help_desk-scoped operator's own
 * org unit, one in a disjoint sibling unit — only the in-scope one may ever
 * appear in that operator's own picker results.
 */
test('a scoped operator\'s picker results stay inside their own scope — an out-of-scope person sharing the same search term never appears', async ({
  page,
  request,
  browser,
}) => {
  // Real fixture-building over HTTP (two org units, three people, a role
  // grant), a real `jml:lifecycle` CLI child process, real Keycloak
  // admin-REST provisioning, AND a full, real, interactive hosted-login flow
  // for a SECOND identity — comfortably more sequential real work than the
  // default 60s budget under the best of conditions, and running the FULL
  // suite in parallel (8 workers, every other file also hitting the same
  // dev-mode Keycloak/API concurrently) measurably slows the second login's
  // own redirect specifically, confirmed by running the full suite for
  // real — this test alone took ~3s in isolation, repeatedly, but over
  // 120s once amid the full suite's own concurrent load. Generous on
  // purpose: a genuine hang still fails, just not by being mistaken for
  // ordinary contention on a single dev-mode Keycloak instance.
  test.setTimeout(240_000)
  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD)
  const adminToken = await getAccessToken(page)
  const stamp = Date.now()
  const root = await fetchAnyOrgUnit(request, adminToken)

  const orgA = await createOrgUnitViaApi(request, adminToken, `E2E Scope A ${stamp}`, root.id)
  const orgB = await createOrgUnitViaApi(request, adminToken, `E2E Scope B ${stamp}`, root.id)

  const sharedTerm = `Zscope${stamp}`
  const inScopePerson = await createPersonViaApi(request, adminToken, {
    firstName: sharedTerm,
    lastName: 'InsideA',
    username: `e2e-zscope-${stamp}-in`,
    orgUnitId: orgA.id,
  })
  const outOfScopePerson = await createPersonViaApi(request, adminToken, {
    firstName: sharedTerm,
    lastName: 'OutsideB',
    username: `e2e-zscope-${stamp}-out`,
    orgUnitId: orgB.id,
  })

  const operatorUsername = `e2e-scope-operator-${stamp}`
  const operatorPassword = `E2e-Scope-Pw-${stamp}!`
  const operator = await createPersonViaApi(request, adminToken, {
    firstName: 'Scope',
    lastName: 'Operator',
    username: operatorUsername,
    orgUnitId: orgA.id,
    // A real, already-passed start date — required for activatePendingUsers
    // below to pick them up at all (LifecycleJob.listPendingWithStartDate
    // OnOrBefore requires a non-null one).
    startDate: '2020-01-01',
  })

  const grantRes = await request.post(`${API_BASE_URL}/users/${operator.id}/roles`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { roleKey: 'help_desk', scopeOrgUnitId: orgA.id },
  })
  expect(grantRes.ok()).toBeTruthy()

  // A brand new person is `pending`, and `resolveActor` fails closed for
  // anything but `active` — see activatePendingUsers' own doc comment for
  // why this is the one HTTP-unreachable step this fixture genuinely needs.
  activatePendingUsers()

  await provisionKeycloakPassword(operatorUsername, `${operatorUsername}@example.com`, operatorPassword, {
    firstName: 'Scope',
    lastName: 'Operator',
  })

  // ---- Sign in as the SCOPED OPERATOR, for real, through the same hosted
  // Keycloak login page every other e2e test's own signIn() drives — in a
  // FRESH browser context, never the admin's own `page`. react-oidc-context
  // persists a signed-in session in sessionStorage; re-navigating the SAME
  // page to "/" while already authenticated as admin just resumes that
  // session (no "Sign in" button ever appears to click, hanging until
  // Playwright's own timeout — caught by actually running this test before
  // trusting it). A second, independent context is also the more honest
  // simulation: two different people are two different browser sessions,
  // not one session signing out and back in.
  // Not explicitly closed: Playwright already tears down every context a
  // test creates at the test's own end regardless, and an explicit close()
  // here raced the test's own timeout in practice (confirmed by running
  // this test for real) — every assertion below had already passed by the
  // time that redundant close() call itself became the failure.
  const operatorContext = await browser.newContext()
  const operatorPage = await operatorContext.newPage()
  await signIn(operatorPage, operatorUsername, operatorPassword)

  // help_desk holds user:update, scoped to orgA — the operator's own
  // record lives in orgA, so editing themselves is in-scope without
  // needing a separate "subject" person or user:create (help_desk does
  // not hold it).
  await operatorPage.goto(`http://localhost:5173/people/${operator.id}/edit`)
  await expect(operatorPage.getByRole('heading', { name: `Edit ${operator.displayName}` })).toBeVisible()

  // getByRole('combobox', ...), not getByLabel — Playwright's getByLabel
  // does a case-insensitive SUBSTRING match, which also matches the clear
  // button's own aria-label ("Clear manager"), a real ambiguity caught by
  // running this file for real (strict-mode violation) before trusting it.
  const managerField = operatorPage.getByRole('combobox', { name: 'Manager' })
  await managerField.fill(sharedTerm)

  await expect(
    operatorPage.getByTestId('combobox-option').filter({ hasText: inScopePerson.displayName }),
  ).toBeVisible()
  await expect(operatorPage.getByTestId('combobox-option')).toHaveCount(1)
  await expect(
    operatorPage.getByTestId('combobox-option').filter({ hasText: outOfScopePerson.displayName }),
  ).toHaveCount(0)
  await expect(operatorPage.getByTestId('combobox-no-results')).toHaveCount(0)
})
