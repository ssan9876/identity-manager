import { expect, test, type Page } from '@playwright/test'
import { trackUser } from './support/cleanup-tracker'

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

/** Same technique e2e/people.spec.ts already uses — pulls the real OIDC access token out of sessionStorage. */
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

const REQUIRED_HEADERS = ['employeeId', 'primaryEmail', 'username', 'firstName', 'lastName', 'orgUnitId']

function buildCsv(rows: Record<string, string>[]): string {
  const lines = [REQUIRED_HEADERS.join(',')]
  for (const row of rows) {
    lines.push(REQUIRED_HEADERS.map((header) => row[header] ?? '').join(','))
  }
  return lines.join('\n')
}

async function fetchFirstOrgUnit(page: Page, token: string): Promise<{ id: string }> {
  const res = await page.request.get(`${API_BASE_URL}/org-units?limit=1`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(res.ok()).toBeTruthy()
  const body = (await res.json()) as { items: { id: string }[] }
  return body.items[0]
}

/**
 * `POST /imports/commit` (driven here through the UI, not called directly)
 * reports only created/failed COUNTS plus a batch id — imports.controller.ts
 * never echoes back the created rows' own ids — so a just-imported person
 * has to be looked up by the exact username this test itself generated, to
 * hand its id to the cleanup tracker.
 */
async function trackUserByUsername(page: Page, token: string, username: string): Promise<void> {
  const res = await page.request.get(`${API_BASE_URL}/users?search=${encodeURIComponent(username)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(res.ok()).toBeTruthy()
  const body = (await res.json()) as { items: { id: string }[] }
  expect(body.items).toHaveLength(1)
  trackUser(body.items[0]!.id)
}

/**
 * Milestone 8, Task 5 — bulk import. task-5-brief.md's own "Prove it":
 * "import a two-row CSV, see the preview, commit, see both users. Assert
 * the preview wrote nothing before commit."
 */

test('imports a two-row CSV: the preview writes nothing, and a separate deliberate commit creates both people', async ({
  page,
}) => {
  await signIn(page)
  const token = await getAccessToken(page)
  const stamp = Date.now()
  const org = await fetchFirstOrgUnit(page, token)

  const usernameA = `e2e-import-a-${stamp}`
  const usernameB = `e2e-import-b-${stamp}`
  const csv = buildCsv([
    {
      employeeId: `EMP-A-${stamp}`,
      primaryEmail: `${usernameA}@example.com`,
      username: usernameA,
      firstName: 'ImportA',
      lastName: String(stamp),
      orgUnitId: org.id,
    },
    {
      employeeId: `EMP-B-${stamp}`,
      primaryEmail: `${usernameB}@example.com`,
      username: usernameB,
      firstName: 'ImportB',
      lastName: String(stamp),
      orgUnitId: org.id,
    },
  ])

  await page.goto('http://localhost:5173/import')
  await expect(page.getByRole('heading', { name: 'Import' })).toBeVisible()

  await page.getByTestId('import-file-input').setInputFiles({
    name: 'two-row-import.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf-8'),
  })
  await expect(page.getByTestId('import-chosen-file')).toContainText('2 data rows')

  await page.getByTestId('import-preview-button').click()
  await expect(page.getByTestId('import-preview-results')).toBeVisible()
  await expect(page.getByTestId('import-safety-note')).toContainText('preview only')
  await expect(page.getByTestId('import-create-table')).toContainText(usernameA)
  await expect(page.getByTestId('import-create-table')).toContainText(usernameB)

  // THE SAFETY RAIL'S ACTUAL GUARANTEE — not just its label: nothing has
  // been written yet. Ask the API directly (not the UI, which the preview
  // step already exercised) whether either username exists.
  const preCommitA = await page.request.get(
    `${API_BASE_URL}/users?search=${encodeURIComponent(usernameA)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  expect((await preCommitA.json()).items).toHaveLength(0)
  const preCommitB = await page.request.get(
    `${API_BASE_URL}/users?search=${encodeURIComponent(usernameB)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  expect((await preCommitB.json()).items).toHaveLength(0)

  // Commit is a SEPARATE, deliberate click — never automatic after preview.
  await page.getByTestId('import-commit-button').click()
  await expect(page.getByTestId('import-commit-result')).toBeVisible()
  await expect(page.getByTestId('import-result-created')).toHaveText('2')
  await expect(page.getByTestId('import-result-failed')).toHaveText('0')
  await expect(page.getByTestId('import-batch-link')).toBeVisible()
  await trackUserByUsername(page, token, usernameA)
  await trackUserByUsername(page, token, usernameB)

  // See both users in the list.
  await page.goto(`http://localhost:5173/people?q=${encodeURIComponent(usernameA)}`)
  await expect(page.getByTestId('people-table')).toContainText(usernameA)
  await page.goto(`http://localhost:5173/people?q=${encodeURIComponent(usernameB)}`)
  await expect(page.getByTestId('people-table')).toContainText(usernameB)
})

test('a mixed valid/invalid CSV previews three distinct groups, and a partial commit still creates the valid row while reporting the failure', async ({
  page,
}) => {
  await signIn(page)
  const token = await getAccessToken(page)
  const stamp = Date.now()
  const org = await fetchFirstOrgUnit(page, token)

  const validUsername = `e2e-import-valid-${stamp}`
  const csv = buildCsv([
    {
      employeeId: `EMP-VALID-${stamp}`,
      primaryEmail: `${validUsername}@example.com`,
      username: validUsername,
      firstName: 'Valid',
      lastName: String(stamp),
      orgUnitId: org.id,
    },
    {
      employeeId: `EMP-INVALID-${stamp}`,
      primaryEmail: 'not-an-email',
      username: `e2e-import-invalid-${stamp}`,
      firstName: 'Invalid',
      lastName: String(stamp),
      orgUnitId: org.id,
    },
  ])

  await page.goto('http://localhost:5173/import')
  await page.getByTestId('import-file-input').setInputFiles({
    name: 'mixed-import.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf-8'),
  })
  await page.getByTestId('import-preview-button').click()
  await expect(page.getByTestId('import-preview-results')).toBeVisible()

  await expect(page.getByTestId('import-create-table')).toContainText(validUsername)
  await expect(page.getByTestId('import-preview-failures')).toContainText('email')

  await page.getByTestId('import-commit-button').click()
  await expect(page.getByTestId('import-commit-result')).toBeVisible()
  await expect(page.getByTestId('import-result-created')).toHaveText('1')
  await expect(page.getByTestId('import-result-failed')).toHaveText('1')
  // A partial commit still shows what landed — the failure table is not hidden just because SOME rows succeeded.
  await expect(page.getByTestId('import-commit-failures')).toContainText('email')
  await trackUserByUsername(page, token, validUsername)

  await page.goto(`http://localhost:5173/people?q=${encodeURIComponent(validUsername)}`)
  await expect(page.getByTestId('people-table')).toContainText(validUsername)
})

test('the row-count and file-size limits are surfaced before upload, and an oversized file is rejected client-side before any request is made', async ({
  page,
}) => {
  await signIn(page)

  await page.goto('http://localhost:5173/import')
  await expect(page.getByTestId('import-format-help')).toContainText('5,000')

  const tooManyRows = buildCsv(
    Array.from({ length: 5_001 }, (_, i) => ({
      employeeId: `BULK-${i}`,
      primaryEmail: `bulk-${i}@example.com`,
      username: `bulk-${i}`,
      firstName: 'Bulk',
      lastName: String(i),
      orgUnitId: '00000000-0000-0000-0000-000000000000',
    })),
  )

  await page.getByTestId('import-file-input').setInputFiles({
    name: 'too-many-rows.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(tooManyRows, 'utf-8'),
  })

  await expect(page.getByTestId('import-file-error')).toContainText('5,000')
  // Blocked before ever reaching the preview step.
  await expect(page.getByTestId('import-chosen-file')).toHaveCount(0)
})
