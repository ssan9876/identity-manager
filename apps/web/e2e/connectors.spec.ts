import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

const USERNAME = 'admin@example.com'
const PASSWORD = 'dev_password_change_me'
const API_BASE_URL = 'http://localhost:3000'
// Set in the root .env (CONNECTOR_ECHO_CREDENTIAL=...) so the API process
// this suite's own webServer starts from cold has a real value to resolve —
// see connectors/secrets.ts and connector-targets.repository.ts's own doc
// comments for why this console only ever asks for the NAME of a variable,
// never a value.
const ECHO_CREDENTIAL_ENV_VAR = 'CONNECTOR_ECHO_CREDENTIAL'

/** Same real sign-in flow every other E2E spec in this suite already proves — Keycloak's own hosted login page, no form of this app's own. */
async function signIn(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/realms\/identity-manager\/protocol\/openid-connect\/auth/)
  await page.getByLabel(/username|email/i).fill(USERNAME)
  await page.getByRole('textbox', { name: /password/i }).fill(PASSWORD)
  await page.getByRole('button', { name: /sign in|log in/i }).click()
  await page.waitForURL('http://localhost:5173/')
}

/** Same technique groups.spec.ts/people.spec.ts already use — pulls the real OIDC access token out of sessionStorage to inspect state through the actual API, not just the UI. */
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

interface ReconcileReportResponse {
  toMutate: Array<{ username: string }>
}

/**
 * The FULL, UNCAPPED plan for `echo`, read directly from the API (never the
 * console's own rendered table, which caps what it displays client-side —
 * DryRunTab.tsx's own `MAX_ROWS_SHOWN`). This shared dev database's
 * in-scope population only grows across repeated runs (nothing in this
 * project's own E2E fixtures is ever deleted — the whole system has no
 * delete for a user, by design), so "is THIS ONE specific person still in
 * the plan" is asserted against the complete, authoritative set, never
 * against however many rows happen to fit on screen.
 */
async function fetchEchoPlanUsernames(request: APIRequestContext, token: string): Promise<Set<string>> {
  const res = await request.post(`${API_BASE_URL}/connector-targets/echo/reconcile`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { dryRun: true },
  })
  expect(res.ok()).toBeTruthy()
  const report = (await res.json()) as ReconcileReportResponse
  return new Set(report.toMutate.map((p) => p.username))
}

/**
 * Milestone 14, Task 9's own "Prove it": "configure the echo target, run a
 * dry run, read the plan, apply, and see health go green. Assert the dry
 * run wrote nothing."
 *
 * THE DRY-RUN-WROTE-NOTHING PROOF, and why it is shaped the way it is: this
 * suite runs 34 specs across 8 PARALLEL Playwright workers, against ONE
 * shared, persistent dev database and ONE live background SyncWorker —
 * exactly the environment `echo` (a genuine, globally-enabled
 * `connector_targets` row once this test configures it) is designed to
 * participate in honestly. Two consequences follow, both confirmed live
 * while developing this test, not assumed:
 *
 *  1. `connector-targets/echo`'s own GLOBAL `lastSuccessfulSyncAt`/
 *     `healthStatus` are NOT safe facts to diff "immediately before" vs
 *     "immediately after this test's own dry run": every OTHER
 *     concurrently-running spec creating a person also fans an outbox
 *     event out to `echo` the instant it is enabled, and the live
 *     SyncWorker drains those in the background, genuinely advancing that
 *     SAME global timestamp for reasons that have nothing to do with this
 *     test's own dry run.
 *  2. The console's own rendered plan table is intentionally CAPPED
 *     (DryRunTab's `MAX_ROWS_SHOWN`) — and this database's own
 *     never-converged-to-echo population (every person any spec in this
 *     suite has ever created, across every run, since nothing here is ever
 *     deleted) is large enough that a freshly created person is not
 *     guaranteed to land inside that cap. Checking "is my person still
 *     un-synced" against the rendered table is exactly as flaky as
 *     checking the global timestamp, for the same underlying reason: both
 *     read a view that is legitimately affected by everything else this
 *     shared environment is concurrently doing.
 *
 * (A controlled, single-writer proof of the identical dry-run-writes-
 * nothing guarantee — using an isolated Testcontainer, not this shared dev
 * stack — already lives in apps/api/test/connector-targets.controller.spec.ts.)
 *
 * The race-free version of the same proof stays entirely SCOPED to the one
 * uniquely-stamped person this test itself creates, read via the
 * uncapped, authoritative report (`fetchEchoPlanUsernames`) rather than the
 * page's own rendering of it: a dry run that genuinely wrote nothing
 * leaves that person un-converged, so a second, immediate plan still lists
 * them; only a real apply makes them converge and disappear from the next
 * one. This depends on nothing but this test's own data, so it holds
 * regardless of whatever unrelated concurrent activity this shared
 * environment is also doing. Every ACTION (configure, dry run, apply) is
 * still driven entirely through the real console UI, exactly as the task
 * asks — only the fine-grained "did this one person's own state move"
 * verification reads the uncapped source of truth instead of the
 * deliberately-capped screen.
 */
test('configure the echo target, dry-run, read the plan, apply, and watch health become healthy — the dry run itself writes nothing', async ({
  page,
  request,
}) => {
  // This dev database's in-scope population only grows, run over run, across
  // every spec in this suite (nothing here is ever deleted — see this test
  // file's own top-of-file doc comment) — and `EchoConnector`'s own
  // converged-state map (what makes a SECOND apply a no-op) lives in the API
  // process's memory, not in Postgres, so a cold `webServer` start (this
  // suite's own normal mode — see playwright.config.ts) means EVERY in-scope
  // principal genuinely needs a real `apply()` call the first time this
  // test's Apply button is used after any restart, not just this run's one
  // freshly-created person. `TargetReconciliationJob`'s own apply loop is
  // sequential, one Postgres transaction per principal (task-9-report.md's
  // own Concern #1) — confirmed to comfortably exceed Playwright's default
  // 5s assertion timeout at this population's current size. The default
  // per-test 60s budget (playwright.config.ts) is widened here specifically,
  // not globally, since every other test in this suite touches at most a
  // handful of principals it created itself.
  test.setTimeout(120_000)

  await signIn(page)
  const token = await getAccessToken(page)
  const stamp = Date.now()

  // ---- Guarantee echo starts DISABLED before the fresh person below is
  // created. `connector_targets` is a real, persistent row in this shared
  // dev database, and this very test's own later steps enable echo but
  // never disable it again afterward — so on any run after the first,
  // echo is already enabled here from a PRIOR run. If it were left enabled,
  // creating the user below would make `OutboxWriter.record` (which fans
  // out only to targets `enabled = true` AT THAT MOMENT) immediately queue
  // an echo-targeted event, and this environment's own live background
  // SyncWorker could drain and apply it before this test ever reaches its
  // OWN explicit dry-run/apply steps — silently converging the person early
  // and making the "dry run wrote nothing" proof below false by accident,
  // not by a real bug. Confirmed live: this is exactly what was happening.
  // Explicitly disabling first removes the precondition entirely, so the
  // only way this person ever reaches echo is through this test's own
  // actions, in the order it performs them.
  const disableRes = await request.patch(`${API_BASE_URL}/connector-targets/echo`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { enabled: false },
  })
  expect(disableRes.ok()).toBeTruthy()

  // ---- A fresh person, via the real API, so the plan below has a
  // guaranteed, deterministic "would create" row to read. ----
  const orgRes = await request.get(`${API_BASE_URL}/org-units?limit=1`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(orgRes.ok()).toBeTruthy()
  const org = (await orgRes.json()).items[0] as { id: string }

  const username = `e2e-connector-${stamp}@example.com`
  const createRes = await request.post(`${API_BASE_URL}/users`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      primaryEmail: username,
      username,
      firstName: 'Connector',
      lastName: `E2E${stamp}`,
      orgUnitId: org.id,
    },
  })
  expect(createRes.ok()).toBeTruthy()

  // ---- Configure the echo target through the real console ----
  await page.goto('http://localhost:5173/connectors')
  await expect(page.getByRole('heading', { name: 'Connectors' })).toBeVisible()
  await page.getByTestId('connector-target-link-echo').click()
  await page.waitForURL('http://localhost:5173/connectors/echo')
  await expect(page.getByTestId('target-detail-name')).toHaveText('Echo (in-repo test target)')

  await page.getByRole('tab', { name: 'Configuration' }).click()
  await expect(page.getByTestId('secret-architecture-note')).toContainText('never stored in this console')
  await page.getByTestId('target-enabled-checkbox').check()
  await page.getByTestId('config-field-credentialSecretName').fill(ECHO_CREDENTIAL_ENV_VAR)
  // Generous blast-radius settings — this run's own population must never
  // trip the guard, since this test proves APPLY succeeds, not the halt path
  // (that is covered directly at the API level).
  await page.getByTestId('blast-radius-threshold').fill('100')
  await page.getByTestId('blast-radius-floor').fill('1000000')
  await page.getByTestId('config-form-submit').click()
  await expect(page.getByTestId('toast').last()).toContainText('Saved configuration for Echo')

  // ---- Dry run, through the console — read the plan before anything applies ----
  await page.getByRole('tab', { name: 'Dry run' }).click()
  await page.getByTestId('dry-run-button').click()
  await expect(page.getByTestId('dry-run-plan')).toBeVisible()
  await expect(page.getByTestId('dry-run-safety-note')).toContainText('This is a plan only')
  await expect(page.getByTestId('dry-run-plan-table')).toBeVisible()
  const changedCountText = await page.getByTestId('dry-run-changed-count').textContent()
  expect(Number(changedCountText)).toBeGreaterThan(0)

  // THE ASSERTION THAT MATTERS: the dry run wrote NOTHING — the uncapped
  // plan still lists this exact person as needing a create.
  let planUsernames = await fetchEchoPlanUsernames(request, token)
  expect(planUsernames.has(username)).toBe(true)

  // ---- Apply, through the console ----
  // A REAL apply against the full current population, not just this test's
  // own one person — see this test's own leading doc comment for why that
  // can genuinely take well past Playwright's default 5s assertion timeout
  // at this shared database's current scale.
  await page.getByTestId('dry-run-apply-button').click()
  await expect(page.getByTestId('dry-run-result')).toBeVisible({ timeout: 90_000 })
  await expect(page.getByTestId('toast').last()).toContainText('Applied')

  // ---- Health becomes healthy, visibly, and the API agrees — a fact only
  // a genuine successful apply can ever produce (SyncWorker.reconcileUser's
  // own upsert), true regardless of this target's prior history. ----
  await expect(page.locator('[data-health-status="healthy"]')).toBeVisible()

  // ---- And the apply GENUINELY converged this specific person: the fresh,
  // uncapped plan no longer lists them at all. ----
  planUsernames = await fetchEchoPlanUsernames(request, token)
  expect(planUsernames.has(username)).toBe(false)
})

/**
 * The attribute mapping editor's own core requirement: "show plainly that
 * an unmapped attribute does not leave the system... default-deny is
 * structural here (absence of a row), and the UI should make that legible
 * rather than hiding it behind a toggle that reads as off."
 *
 * Self-cleaning by construction: an earlier, failed attempt at driving this
 * SAME UI flow (e.g. an assertion throwing between creating the mapping and
 * removing it again) would otherwise leave a real Title -> Echo mapping
 * behind forever — this system has no delete for anything by default, and
 * this suite runs against a persistent, never-reset dev database. The
 * `finally` block removes whatever mapping this run created regardless of
 * how the test body exits, and the leading cleanup step removes any
 * pre-existing one from a PRIOR run before this run's own assertions ever
 * look at that cell — both confirmed necessary, not defensive-for-its-own-
 * sake: an earlier iteration of this exact test, without either, left
 * exactly this residue and made the NEXT run's "starts unmapped" assertion
 * fail for a reason that had nothing to do with the feature under test.
 */
test('mapping a core field to one target leaves it visibly unmapped for every other target — creating, toggling and removing a mapping all work end to end', async ({
  page,
  request,
}) => {
  await signIn(page)
  const token = await getAccessToken(page)

  const mappingsRes = await request.get(`${API_BASE_URL}/attribute-target-mappings`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(mappingsRes.ok()).toBeTruthy()
  const existingMappings = (await mappingsRes.json()) as Array<{ id: string; coreField: string | null; target: string }>
  for (const row of existingMappings) {
    if (row.coreField === 'title' && row.target === 'echo') {
      await request.delete(`${API_BASE_URL}/attribute-target-mappings/${row.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    }
  }

  await page.goto('http://localhost:5173/connectors')
  await page.getByRole('tab', { name: 'Attribute mappings' }).click()
  await expect(page.getByTestId('mapping-editor-table')).toBeVisible()

  const stamp = Date.now()
  const remoteName = `e2eJobTitle${stamp}`

  // Core fields render first, in ALL_CORE_FIELDS' own fixed order
  // (given_name, surname, title, department) — row index 2 is always
  // "Title", regardless of whatever custom attributes this shared dev
  // database happens to have, so this is robust against a naming collision
  // a text filter would not be.
  const titleRow = page.getByTestId('mapping-editor-row').nth(2)
  await expect(titleRow).toContainText('Title')
  // Keycloak, AD, Entra, Google, Echo — Echo is last. The "control" cell
  // (proving a DIFFERENT target for the same field is unaffected) uses
  // Active Directory, not Keycloak: this suite's own console-driven visual
  // pass may have left a real Title -> Keycloak mapping behind as reference
  // demo data, so Keycloak's own cell is not a safe "known unmapped"
  // baseline to assert against here — Active Directory is never touched by
  // anything else in this repo's fixtures.
  const echoCell = titleRow.getByTestId('mapping-editor-cell').nth(4)
  const adCell = titleRow.getByTestId('mapping-editor-cell').nth(1)

  try {
    // Before mapping anything: BOTH cells read as unmapped, structurally —
    // no checkbox anywhere, just plain text.
    await expect(echoCell.getByTestId('mapping-unmapped')).toHaveText('not mapped')
    await expect(adCell.getByTestId('mapping-unmapped')).toHaveText('not mapped')

    // Map Title -> Echo only.
    await echoCell.getByTestId('mapping-add-button').click()
    await echoCell.getByTestId('mapping-add-input').fill(remoteName)
    await echoCell.getByTestId('mapping-add-save').click()
    await expect(echoCell.getByTestId('mapping-enabled-toggle')).toBeVisible()
    await expect(echoCell).toContainText(remoteName)

    // THE ASSERTION THAT MATTERS: a DIFFERENT target for the SAME field is
    // completely unaffected — still plainly, structurally unmapped.
    await expect(adCell.getByTestId('mapping-unmapped')).toHaveText('not mapped')

    // Disable without deleting — a distinct, visible state from "no row".
    // `mapping-enabled-toggle` IS the checkbox input itself (see
    // AttributeMappingsEditor.tsx), not a wrapping label.
    await echoCell.getByTestId('mapping-enabled-toggle').uncheck()
    await expect(echoCell.getByTestId('mapping-enabled-toggle')).not.toBeChecked()
    await expect(echoCell).toContainText(remoteName) // still present, just disabled

    // Remove it entirely — the cell returns to plain "not mapped".
    await echoCell.getByTestId('mapping-remove-button').click()
    await expect(echoCell.getByTestId('mapping-unmapped')).toHaveText('not mapped')
  } finally {
    const finalMappingsRes = await request.get(`${API_BASE_URL}/attribute-target-mappings`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (finalMappingsRes.ok()) {
      const rows = (await finalMappingsRes.json()) as Array<{ id: string; coreField: string | null; target: string }>
      for (const row of rows) {
        if (row.coreField === 'title' && row.target === 'echo') {
          await request.delete(`${API_BASE_URL}/attribute-target-mappings/${row.id}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        }
      }
    }
  }
})
