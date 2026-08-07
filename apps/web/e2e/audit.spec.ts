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

async function fetchFirstOrgUnit(page: Page, token: string): Promise<{ id: string }> {
  const res = await page.request.get(`${API_BASE_URL}/org-units?limit=1`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(res.ok()).toBeTruthy()
  const body = (await res.json()) as { items: { id: string }[] }
  return body.items[0]
}

/**
 * Milestone 8, Task 5 — the audit log viewer and sync visibility (dead
 * letters). Not the literal two-row-CSV scenario task-5-brief.md's "Prove
 * it" names (that lives in import.spec.ts) — this file covers the OTHER two
 * thirds of the same task's contract: the audit log renders before/after
 * readably, and the dead-letter view is reachable and keyboard-operable.
 */

test('a person\'s Activity tab shows both a create and an update entry, each with a readable before/after — never a raw JSON blob', async ({
  page,
}) => {
  await signIn(page)
  const token = await getAccessToken(page)
  const stamp = Date.now()
  const org = await fetchFirstOrgUnit(page, token)

  const username = `e2e-audit-target-${stamp}`
  const email = `${username}@example.com`
  const createRes = await page.request.post(`${API_BASE_URL}/users`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      primaryEmail: email,
      username,
      firstName: 'AuditTarget',
      lastName: String(stamp),
      orgUnitId: org.id,
    },
  })
  expect(createRes.ok()).toBeTruthy()
  const created = (await createRes.json()) as { id: string; displayName: string }
  trackUser(created.id)

  const patchRes = await page.request.patch(`${API_BASE_URL}/users/${created.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { jobTitle: 'Staff Engineer' },
  })
  expect(patchRes.ok()).toBeTruthy()

  await page.goto(`http://localhost:5173/people/${created.id}`)
  await page.getByRole('tab', { name: 'Activity' }).click()
  await expect(page.getByTestId('audit-log-table')).toBeVisible()

  // ---- The CREATE row: a flat "field: value" list built from `after` alone. ----
  const createdRow = page.getByTestId('audit-log-row').filter({ hasText: 'Person created' })
  await expect(createdRow).toBeVisible()
  await createdRow.getByTestId('audit-row-toggle').click()
  await expect(page.getByTestId('audit-diff-single').first()).toContainText(email)

  // ---- The UPDATE row: a Field/Before/After table, scoped to what actually changed. ----
  const updatedRow = page.getByTestId('audit-log-row').filter({ hasText: 'Person updated' })
  await expect(updatedRow).toBeVisible()
  await updatedRow.getByTestId('audit-row-toggle').click()
  const changedTable = page.getByTestId('audit-diff-changed-table').first()
  await expect(changedTable).toContainText('Job title')
  await expect(changedTable).toContainText('Staff Engineer')
  // Readable, not a raw JSON blob — the field label is humanized, not the literal snapshot key.
  await expect(changedTable).not.toContainText('jobTitle')

  // A caller without audit:read gets an explanation, never a silent empty tab or a bare 403 — proven statically by
  // PersonDetailPage's own permission gate (see people/PersonDetailPage.tsx); this session holds super_admin, so it
  // always sees the real table, which the assertions above already exercise.
})

test('the Import page\'s batch link opens the audit log pre-filtered to that batch, and the Dead letters tab is reachable by keyboard', async ({
  page,
}) => {
  await signIn(page)
  const token = await getAccessToken(page)
  const stamp = Date.now()
  const org = await fetchFirstOrgUnit(page, token)

  const username = `e2e-audit-batch-${stamp}`
  const csv = [
    'employeeId,primaryEmail,username,firstName,lastName,orgUnitId',
    `EMP-BATCH-${stamp},${username}@example.com,${username},Batch,${stamp},${org.id}`,
  ].join('\n')

  const commitRes = await page.request.post(`${API_BASE_URL}/imports/commit`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { csv },
  })
  expect(commitRes.ok()).toBeTruthy()
  const commit = (await commitRes.json()) as { batchId: string; created: number }
  expect(commit.created).toBe(1)

  // The commit response carries no id — imports.controller.ts only reports
  // created/failed counts plus the batchId — so look the new person up by
  // the exact username this test just imported, to track it for cleanup.
  const lookupRes = await page.request.get(
    `${API_BASE_URL}/users?search=${encodeURIComponent(username)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  expect(lookupRes.ok()).toBeTruthy()
  const lookup = (await lookupRes.json()) as { items: { id: string }[] }
  expect(lookup.items).toHaveLength(1)
  trackUser(lookup.items[0]!.id)

  await page.goto(`http://localhost:5173/audit?batchId=${commit.batchId}`)
  await expect(page.getByTestId('audit-batch-chip')).toContainText(commit.batchId)
  await expect(page.getByTestId('audit-log-table')).toContainText('Person created')
  // Every row shown belongs to this one batch — the chip is a real filter, not decoration.
  const rowCount = await page.getByTestId('audit-log-row').count()
  expect(rowCount).toBe(1)

  // Clearing the chip removes the filter (the control actually does something, not just displays the id).
  await page.getByTestId('audit-batch-chip').getByRole('button', { name: 'Clear' }).click()
  await expect(page.getByTestId('audit-batch-chip')).toHaveCount(0)

  // ---- Dead letters tab: reachable by keyboard, not just a mouse click. ----
  const logTab = page.getByRole('tab', { name: 'Log' })
  const deadLettersTab = page.getByRole('tab', { name: 'Dead letters' })
  await logTab.focus()
  await page.keyboard.press('ArrowRight')
  await expect(deadLettersTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel', { name: 'Dead letters' })).toBeVisible()
  await expect(page.getByRole('tabpanel', { name: 'Dead letters' })).toContainText(
    /no dead letters|aggregate/i,
  )
})
