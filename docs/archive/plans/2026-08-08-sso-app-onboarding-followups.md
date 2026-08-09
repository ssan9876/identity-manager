# SSO Application Onboarding — Follow-ups

**Date:** 2026-08-08
**Branch:** `feat/sso-apps` (based on `feat/business-roles-entitlements` at `686552f`)
**Plan:** [2026-08-08-sso-app-onboarding.md](2026-08-08-sso-app-onboarding.md)
**Spec:** [../specs/2026-08-08-sso-app-onboarding-design.md](../specs/2026-08-08-sso-app-onboarding-design.md)

All ten plan tasks are implemented and committed. This file records what is
**not** verified and what integration still needs doing, so neither is
mistaken for finished.

## What was verified

| Spec | Result |
|---|---|
| `sso-app-validation` | 28/28 |
| `sso-apps.repository` | 9/9 (real Postgres) |
| `sso-app-sync` | 9/9 (real Postgres) |
| `sso-apps.controller` | 19/19 (real Postgres) |
| `keycloak-sso.connector` | 11/11 |
| `target-fanout` | 9/9 |
| `connector-target-catalog` | 9/9 |
| `outbox-emission` + `outbox-multi-target` | 38/38 — the fan-out regression net |
| `sync.worker` | 25/25, unchanged, incl. concurrency and cross-aggregate races |
| Typechecks | `apps/api` and `apps/web` both clean |
| Console build | clean, 126 modules |

---

## 1. Run the e2e spec — it has never been executed

`apps/web/e2e/sso-apps.spec.ts`. All 8 tests parse and are discovered by
`playwright test --list`; **none has ever run.**

Needs the fixed-port dev stack (Postgres, Keycloak, API on `:3000`, web on
`:5173`) and `scripts/keycloak-setup.sh` re-run so `idm-sso-admin` exists.

```bash
cd D:\identity-manager-sso-apps
pnpm --filter @idm/web test:e2e
```

One expectation is environment-dependent: the minting test asserts the **409
"has not synced to Keycloak yet"** path, because `keycloak_sso` is
unconfigured in dev. If you configure and enable that target, that test needs
updating to assert the modal instead.

## 2. Run the full 73-spec API suite

Never run end-to-end on this branch. Another session held ~41 Testcontainers
containers up throughout the work, and running two container-backed suites
concurrently is what previously exhausted the disk and produced 49 spurious
failures. Wait until that session is idle.

```bash
cd D:\identity-manager-sso-apps
pnpm --filter @idm/api test -- --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3
```

**Both bounds are required.** `maxForks` alone aborts with
`RangeError: options.minThreads and options.maxThreads must not conflict`
before a single test runs, because `minForks` defaults to the CPU count (16
here). Vitest reports that as `Test Files no tests` with the error under an
"Unhandled Errors" heading, so it reads like a filter problem rather than a
bad flag. Do **not** also pass `--pool=forks`.

Read the printed `Test Files` / `Tests` summary, not the exit code — a piped
run has previously reported exit 0 while the summary said 49 files failed.

## 3. Confirm Keycloak 26's partial-PUT semantics

Plan Task 5 Step 1, never done — Docker was unavailable at the time.

**Question:** does `PUT /clients/{uuid}` omitting a field clear it, or
preserve it?

`KeycloakSsoConnector` uses read-modify-write, which is correct under **either
answer** — so this is not a latent bug. What is unproven is only whether the
weaker approach would also have worked. The doc comment in
`apps/api/src/connectors/keycloak-sso.connector.ts` states this explicitly;
replace it with the empirical result once known.

## 4. Rebase before integrating

`feat/sso-apps` is branched from `686552f`. `feat/business-roles-entitlements`
has since advanced to `da74d6d` and keeps moving — it advanced twice during
implementation and once more during the push.

Watch **`c3524c6` — *fix(sync): scope syncState derivation to enabled targets***.
It sits adjacent to the aggregate-aware fan-out change in
`outbox/outbox.writer.ts`. Re-check the remote tip before rebasing; both
branches are now on GitHub.

## 5. Target the PR at `feat/business-roles-entitlements`, not `master`

https://github.com/ssan9876/identity-manager/pull/new/feat/sso-apps

Against `master` the PR shows all 24 commits, including work belonging to
another feature, and the numbered `docs/NN-*.md` files this work's
documentation edits touch **do not exist on `master` at all** — they arrive
with the `7adaed9` documentation reorganisation.

---

## Deviations from the plan, already applied

Recorded here so a reviewer reading the plan alongside the diff is not
surprised.

- **The plan's test command was wrong in all 20 places.** Fixed in `2e4ae73`;
  see item 2 above for the correct form.
- **Migration numbers.** The plan said `0019`/`0020`; those slots were taken
  by the business-roles work, so the migrations are `0022` and `0023`.
- **No `connector_targets` seed migration.** The spec asked for one in a
  separate migration; that would fail a fresh-database migrate, because all
  pending migrations share one transaction and Postgres forbids using a value
  added by `ALTER TYPE ... ADD VALUE` within it. Migration `0017` already
  records this. The row is created at runtime instead.
- **`DIRECTORY_TARGETS` added.** Not in the spec. Five places enumerate the
  target catalog and two walk *users*; without narrowing them, the console
  offers attribute mappings for a target with no users and
  `pnpm target-reconcile keycloak_sso` walks every user against a connector
  that cannot accept one.
- **`ConnectorRegistry.healthFor` added.** Without it the console calls
  `resolve` for `keycloak_sso`, gets "no connector registered", and renders a
  healthy target as **failing**.
- **`config-fields.ts` needed a `keycloak_sso` entry** — caught by the web
  typecheck, not by the plan.
- **Minting is not a fourth `SsoConnector` method.** It is imperative and
  administrator-triggered, not desired-state reconciliation; folding it in
  would imply the sync worker could call it. The factory exposes the admin API
  via `configureAdmin` instead.
- **`PATCH` also refuses `publicClient`**, and **minting for a public client
  is a 409** — neither was in the plan. Flipping a confidential client to
  public invalidates its secret and changes the auth model; public clients use
  PKCE and have no secret to rotate.
- **Sync tests live in their own Postgres-only spec** rather than appended to
  `sync.worker.spec.ts`, which starts a real Keycloak container. The `sso_app`
  path never touches Keycloak's user or group API. 9s versus 77s.
- **Console pages use default exports**, matching the existing convention.

## Still out of scope, by design

SAML in any form — which is why **Google Workspace SSO remains manual**,
since Workspace federates over SAML only. Identity brokering. A third grant
kind in business roles. Per-application scope narrowing of `sso_app:manage`.
