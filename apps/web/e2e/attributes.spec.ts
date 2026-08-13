import { expect, test, type Page } from '@playwright/test'
import { trackUser } from './support/cleanup-tracker'

const USERNAME = 'admin@example.com'
const PASSWORD = 'dev_password_change_me'

/** Pulls the trailing UUID off `/people/<id>` — same helper people-write.spec.ts uses, for the same reason. */
function idFromUrl(page: Page): string {
  const match = /([0-9a-f-]{36})$/.exec(page.url())
  if (!match) throw new Error(`expected a trailing UUID in the URL, got: ${page.url()}`)
  return match[1]!
}

/** The same real Keycloak sign-in every other spec here performs. */
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
 * Creates one OPTIONAL choice attribute on people and returns its key.
 *
 * Unique per run: attribute definitions cannot be deleted (by design — the
 * key is what every stored value is filed under), only deactivated, so a
 * shared literal key would collide with the previous run's leftover.
 */
async function createOptionalChoiceAttribute(page: Page): Promise<string> {
  const key = `e2eOptional_${Date.now()}`

  await page.goto('http://localhost:5173/attributes')
  await page.getByTestId('new-attribute').click()
  await page.getByTestId('attribute-key').fill(key)
  // The LABEL carries the unique key too, not just the key column. A label is
  // what `getByLabel` matches on, and a definition this spec failed to
  // deactivate stays ACTIVE and keeps rendering its field on the person form
  // — two runs then put two identically-labelled selects on one page and
  // every `getByLabel` here dies of strict-mode ambiguity rather than of the
  // thing under test. Observed exactly once, from the deliberately-red run
  // that proved this spec fails without the fix.
  await page.getByTestId('attribute-label').fill(`E2E optional choice ${key}`)
  await page.getByTestId('attribute-data-type').selectOption('enum')
  await page.getByTestId('attribute-options').fill('alpha\nbeta')
  // Required stays UNTICKED — an optional attribute is the whole point.
  await page.getByTestId('attribute-form-submit').click()

  await expect(page.getByTestId('attributes-table')).toContainText(key)
  return key
}

/**
 * Switches a definition off again, which is the closest thing to cleanup this
 * table allows — definitions cannot be deleted, by design.
 *
 * NEVER THROWS, and that is not laziness. This runs from a `finally`, so on a
 * failing test it runs with the timeout budget the failure already exhausted
 * and against a page Playwright may have torn down. Letting it throw replaces
 * the real assertion error with `page.goto: Target page ... has been closed`,
 * which is precisely what happened on this spec's first red run: the genuine
 * failure (a 400 naming an attribute nobody touched) was invisible, and only
 * the trace's page snapshot revealed it.
 *
 * A leftover ACTIVE definition would be cross-test contamination — an
 * optional enum attribute is exactly what breaks other specs' person writes —
 * so the failure is reported loudly rather than swallowed silently.
 */
async function deactivate(page: Page, key: string): Promise<void> {
  try {
    await page.goto('http://localhost:5173/attributes')
    const row = page.getByTestId('attributes-row').filter({ hasText: key })
    await row.getByTestId('attribute-toggle-active').click()
    await expect(row.locator('[data-attribute-active="false"]')).toBeVisible()
  } catch (cause) {
    console.error(
      `[attributes.spec] could not deactivate "${key}" — it is still ACTIVE and will affect ` +
        `other specs' person and group writes. Deactivate it by hand on /attributes.`,
      cause,
    )
  }
}

/**
 * THE REGRESSION THIS FILE EXISTS FOR.
 *
 * `coerceAttributeValue` mapped an empty input to `undefined` for `number`
 * ALONE; every other dataType submitted `''`. The API builds an optional
 * attribute as `field.optional()`, which admits `undefined` and never `''`,
 * so a single optional `enum`, `date`, or formatted `string` definition made
 * EVERY person and group unsavable while its field was left blank —
 * `Invalid enum value. Expected 'alpha' | 'beta', received ''`.
 *
 * Why it survived to a live run: the seeded definitions are all plain
 * `string`, and plain `string` plus `number` were exactly the two types that
 * worked. Nothing in the suite created an optional enum/date/format
 * definition, because nothing could create definitions from the console at
 * all until the attribute write path landed — which is also what made this
 * reachable in the first place.
 *
 * The assertion is deliberately on the PERSON write, not on the attribute:
 * that is where the failure lands, and the 400 names an attribute the admin
 * never touched on a form they were only trying to fill in.
 */
test('an optional choice attribute left empty does not block saving a person', async ({ page }) => {
  // A real Keycloak sign-in, a definition write and a person write in one
  // test does not fit the 60s default.
  test.setTimeout(150_000)
  await signIn(page)
  const key = await createOptionalChoiceAttribute(page)

  try {
    await page.goto('http://localhost:5173/people/new')
    await expect(page.getByRole('heading', { name: 'Create user' })).toBeVisible()

    const stamp = Date.now()
    await page.getByLabel('Org unit').selectOption({ index: 1 })
    await page.getByLabel('Email').fill(`e2e-attr-${stamp}@example.com`)
    await page.getByLabel('Username').fill(`e2e-attr-${stamp}`)
    await page.getByLabel('First name').fill('E2E')
    await page.getByLabel('Last name').fill('EmptyChoice')

    // The new field is present and left on its empty option — untouched,
    // exactly as an admin who has no value for it would leave it.
    await expect(page.getByLabel(`E2E optional choice ${key}`)).toBeVisible()

    await page.getByTestId('person-form-submit').click()

    // Before the fix this never navigated: the request came back 400 and the
    // form stayed put showing a validation error about `${key}`.
    await page.waitForURL(/\/people\/[0-9a-f-]{36}$/)
    trackUser(idFromUrl(page))
    await expect(page.getByTestId('person-detail-name')).toHaveText('E2E EmptyChoice')
  } finally {
    await deactivate(page, key)
  }
})

/**
 * The same coercion, exercised through the EDIT path and a second dataType.
 *
 * `date` failed differently from `enum` — "must be a valid ISO calendar date"
 * rather than an enum complaint — so this is not the same assertion twice: it
 * covers the second of the three broken types, and the write path where the
 * attributes bag is REPLACED rather than built from nothing.
 */
test('an optional date attribute left empty does not block editing a person', async ({ page }) => {
  // A real Keycloak sign-in, a definition write and a person write in one
  // test does not fit the 60s default.
  test.setTimeout(150_000)
  await signIn(page)

  const key = `e2eDate_${Date.now()}`
  await page.goto('http://localhost:5173/attributes')
  await page.getByTestId('new-attribute').click()
  await page.getByTestId('attribute-key').fill(key)
  await page.getByTestId('attribute-label').fill(`E2E optional date ${key}`)
  await page.getByTestId('attribute-data-type').selectOption('date')
  await page.getByTestId('attribute-form-submit').click()
  await expect(page.getByTestId('attributes-table')).toContainText(key)

  try {
    await page.goto('http://localhost:5173/people/new')
    await expect(page.getByRole('heading', { name: 'Create user' })).toBeVisible()

    const stamp = Date.now()
    await page.getByLabel('Org unit').selectOption({ index: 1 })
    await page.getByLabel('Email').fill(`e2e-date-${stamp}@example.com`)
    await page.getByLabel('Username').fill(`e2e-date-${stamp}`)
    await page.getByLabel('First name').fill('E2E')
    await page.getByLabel('Last name').fill('EmptyDate')
    await page.getByTestId('person-form-submit').click()
    await page.waitForURL(/\/people\/[0-9a-f-]{36}$/)
    const id = idFromUrl(page)
    trackUser(id)

    // Now EDIT, still leaving the date empty, and change something else.
    await page.goto(`http://localhost:5173/people/${id}/edit`)
    await page.getByLabel('Job title').fill('Edited with an empty date')
    await page.getByTestId('person-form-submit').click()

    await page.waitForURL(/\/people\/[0-9a-f-]{36}$/)
    await expect(page.getByTestId('toast').last()).toContainText('Saved')
  } finally {
    await deactivate(page, key)
  }
})
