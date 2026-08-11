import { expect, test, type Page } from '@playwright/test'
import { slugFromName } from '../src/organizations/slug'
import { syncLabel } from '../src/organizations/status'
import type { Organization } from '../src/organizations/api'

const USERNAME = 'admin@example.com'
const PASSWORD = 'dev_password_change_me'

/** Same real sign-in flow every other E2E spec in this suite already proves — Keycloak's own hosted login page, no form of this app's own. */
async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/realms\/identity-manager\/protocol\/openid-connect\/auth/)
  await page.getByLabel(/username|email/i).fill(USERNAME)
  await page.getByRole('textbox', { name: /password/i }).fill(PASSWORD)
  await page.getByRole('button', { name: /sign in|log in/i }).click()
  await page.waitForURL('http://localhost:5173/')
}

/**
 * Unique per run. There is no DELETE for an organization by design — a
 * retired tenant is suspended, never removed, because deleting it would mean
 * deleting a Keycloak realm and every credential inside it — so a fixture
 * cannot be cleaned up afterwards and a fixed slug would 409 on the second
 * run of this suite against the same dev stack. Same reasoning, and the same
 * shape, as sso-apps.spec.ts's `uniqueClientId`.
 *
 * Kept to a DNS label: the slug becomes a realm name, and the API's own
 * pattern rejects anything else.
 */
function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1_000)}`
}

// ---------------------------------------------------------------------
// Pure units. No browser, no stack — these two functions are the whole of
// this feature's client-side logic, and both are easy to get subtly wrong
// (a trailing hyphen the server's pattern rejects; a suspended tenant
// reading as "Provisioning"). apps/web has no unit-test runner of its own,
// and Playwright's runner is a perfectly good one for a pure function, so
// they live here rather than justifying a second framework for two files.
// ---------------------------------------------------------------------
test.describe('slugFromName', () => {
  test('lower-cases and hyphenates a name', () => {
    expect(slugFromName('Acme Corp!')).toBe('acme-corp')
  })

  test('trims leading and trailing separators', () => {
    expect(slugFromName('  --Acme--  ')).toBe('acme')
  })

  test('truncates to 63 characters with no trailing hyphen', () => {
    // 70 characters, with the 64th position landing on a word boundary —
    // the case where a naive `.slice(0, 63)` leaves a trailing hyphen that
    // the server's `^[a-z0-9](...)[a-z0-9]$` pattern would reject.
    const name = `${'a'.repeat(63)} tail`
    const slug = slugFromName(name)
    expect(slug.length).toBeLessThanOrEqual(63)
    expect(slug.endsWith('-')).toBe(false)
    expect(slug).toBe('a'.repeat(63))
  })

  test('produces something the server would accept', () => {
    expect(slugFromName('Ürsel & Sons, GmbH')).toMatch(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/)
  })
})

test.describe('syncLabel', () => {
  const base: Organization = {
    id: 'x',
    slug: 'acme',
    name: 'Acme',
    realm: 'acme',
    status: 'active',
    isMaster: false,
    realmProvisionedAt: null,
    createdAt: '',
    updatedAt: '',
  }

  test('an active tenant whose realm has not landed is Provisioning', () => {
    expect(syncLabel(base)).toBe('Provisioning')
  })

  test('an active tenant whose realm has landed is Active', () => {
    expect(syncLabel({ ...base, realmProvisionedAt: '2026-08-09T00:00:00Z' })).toBe('Active')
  })

  test('a suspended tenant is Suspended, provisioned or not', () => {
    expect(syncLabel({ ...base, status: 'suspended' })).toBe('Suspended')
    expect(
      syncLabel({ ...base, status: 'suspended', realmProvisionedAt: '2026-08-09T00:00:00Z' }),
    ).toBe('Suspended')
  })

  test('master is Active despite never being provisioned by this system', () => {
    // Master's realm predates this system, so `realmProvisionedAt` is null
    // forever — the one row where "not provisioned" does not mean "not there".
    expect(syncLabel({ ...base, isMaster: true, slug: 'master' })).toBe('Active')
  })
})

// ---------------------------------------------------------------------
// End to end, against the real stack.
// ---------------------------------------------------------------------
test('creates an organization and shows it provisioning', async ({ page }) => {
  await signInAsAdmin(page)
  const slug = uniqueSlug('e2e-acme')

  await page.getByRole('link', { name: 'Organizations' }).click()
  await page.getByRole('button', { name: 'New organization' }).click()
  await page.getByLabel('Name').fill('Acme Corp')

  // The slug derives from the name, and stays editable — this run needs a
  // unique one, which is exactly the case the field exists for.
  await expect(page.getByLabel('Slug')).toHaveValue('acme-corp')
  await page.getByLabel('Slug').fill(slug)

  await page.getByRole('button', { name: 'Create' }).click()

  const row = page.getByRole('row', { name: /Acme Corp/ })
  await expect(row).toContainText(slug)
  // Either is correct: the realm is created asynchronously, usually within a
  // second, so this races the sync worker on purpose rather than sleeping.
  await expect(row).toContainText(/Provisioning|Active/)
})

test('the Targets column links to that tenant\'s own connector scope, not a guessed label', async ({ page }) => {
  await signInAsAdmin(page)
  const slug = uniqueSlug('e2e-globex')

  await page.goto('/organizations')
  await page.getByRole('button', { name: 'New organization' }).click()
  await page.getByLabel('Name').fill('Globex')
  await page.getByLabel('Slug').fill(slug)
  await page.getByRole('button', { name: 'Create' }).click()

  // `connector_targets` is keyed `(organization_id, target)` and a tenant
  // fans out to whichever of ITS OWN rows are enabled (OutboxWriter.record) —
  // this page has no per-tenant target data to summarise, so it links out to
  // the Connectors page, scoped to that organization, instead of guessing.
  const tenantRow = page.getByRole('row', { name: new RegExp(slug) })
  await expect(tenantRow.getByRole('link', { name: 'View targets' })).toBeVisible()

  const masterRow = page.getByRole('row', { name: /master/ })
  await expect(masterRow.getByRole('link', { name: 'View targets' })).toBeVisible()

  await tenantRow.getByRole('link', { name: 'View targets' }).click()
  await expect(page).toHaveURL(/\/connectors\?organizationId=/)
  await expect(page.getByTestId('connector-org-scope-select')).toBeVisible()
})

test('suspends and reactivates a tenant, and never offers to delete one', async ({ page }) => {
  await signInAsAdmin(page)
  const slug = uniqueSlug('e2e-initech')

  await page.goto('/organizations')
  await page.getByRole('button', { name: 'New organization' }).click()
  await page.getByLabel('Name').fill('Initech')
  await page.getByLabel('Slug').fill(slug)
  await page.getByRole('button', { name: 'Create' }).click()

  const row = page.getByRole('row', { name: new RegExp(slug) })
  await row.getByRole('button', { name: 'Suspend' }).click()
  await expect(row).toContainText('Suspended')

  await row.getByRole('button', { name: 'Reactivate' }).click()
  await expect(row).not.toContainText('Suspended')

  // There is no delete anywhere in this product, and least of all here.
  await expect(row.getByRole('button', { name: /delete|remove/i })).toHaveCount(0)
})

test('refuses to suspend the master organization', async ({ page }) => {
  await signInAsAdmin(page)
  await page.goto('/organizations')

  // Not disabled-but-present: the control is not rendered at all for master,
  // because suspending it would disable the realm every admin — including
  // whoever clicked — signs in through.
  const masterRow = page.getByRole('row', { name: /master/ })
  await expect(masterRow.getByRole('button', { name: /suspend/i })).toHaveCount(0)
})
