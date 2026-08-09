# TODO

Rewritten 2026-08-08 after every outstanding branch was merged into `master`.
The previous version of this file described a world of eleven parallel
worktrees that no longer exists, and was wrong on both of its branch-disposition
claims (see "Corrections" at the bottom).

Finished work is not listed. Everything below is unverified, deferred, or
known-defective.

---

## State of `master`

All unique work is merged. Verified on the merged tree:

| Gate | Result |
|---|---|
| `pnpm typecheck` (api + web) | clean |
| `apps/api` suite, 3 forks | **1304/1305 pass, 83/84 files** |
| `apps/web` `check-css-tokens` | clean |
| `apps/web` build | clean, 127 modules |
| `drizzle-kit generate` drift check | "No schema changes, nothing to migrate" |

The single failing test is **`test/dev-environment.spec.ts`** — it fetches
`http://localhost:8080/realms/identity-manager/.well-known/openid-configuration`
and needs the dev Keycloak running. It is unrelated to any merged change; bring
the compose stack up before reading it as a regression.

### What the merge itself had to fix

Recorded because none of it was visible as a merge conflict:

- **Migration index collision.** `feat/sso-apps` and `feat/organizations` both
  claimed `0022` and `0023`. organizations was renumbered to `0024`/`0025`;
  sso-apps keeps its numbers because it was already pushed.
- **A migration that would have been silently skipped.** After renumbering, the
  journal's `when` values were non-monotonic. `drizzle-orm/pg-core/dialect.js`
  applies a migration only when `lastDbMigration.created_at < folderMillis`, so
  on a database already at `0023`, migration `0024` (which creates the
  organizations schema) would have been skipped with no error and `0025`'s
  backfill would then have run against tables that did not exist. Timestamps are
  now strictly increasing.
- **A forked snapshot chain.** Both renumbered snapshots still chained from
  `0021`, which made `drizzle-kit` refuse to run at all, and both predated
  sso-apps so the head snapshot omitted the `sso_apps` tables. Rebuilt; the two
  lines were exactly disjoint, so they composed without guesswork.
- **`organization_id` NOT NULL vs. older fixtures.** The business-roles
  reconciler fixtures predate the column. Now seed via
  `OrganizationsRepository.findMaster()`.
- **Four raw colour literals in `SsoApps.css`.** `feat/sso-apps` verified the
  console build but never ran `check-css-tokens`. All four had existing tokens.

---

## Business roles and entitlements — Milestones 17–19

Spec: `docs/archive/specs/2026-08-08-business-roles-entitlements-design.md`
Plan: `docs/archive/plans/2026-08-08-business-roles-entitlements.md` (20 tasks)
Detail: `docs/TODO-business-roles.md` — still accurate for tasks 9–20.

Task 8 (the reconciler) **is now green: 19/19**. `docs/TODO-business-roles.md`
describes five failures and diagnoses them as cross-test contamination; that
diagnosis was right and its fix (a per-seed unique `jobTitle`) is in the merged
code. Treat that file's "5 of 19 fail" section as history.

- [ ] **Task 9 — re-evaluate on every user write.** Register
      `BusinessRolesRepository` and `RoleReconciler` in `app.module.ts` (still
      unregistered), export `REEVALUATION_FIELDS`, call the reconciler inside the
      existing transaction of user create/update. A refusal must roll the write
      back. The trigger list must stay identical to the evaluator's field
      allowlist.
- [ ] **Task 10 — sweep job and CLI**, modelled on the `target-reconcile` pair.
- [ ] **Task 11 — actions, guards, controller.** `business_role:read` /
      `business_role:manage`; mutation requires a *global* grant.
- [ ] **Task 12 — `GET /api/users/:id/entitlements`.** `justifiedBy` computed
      live, never stored; an unevaluable result returns rows with a marker
      rather than failing the read.
- [ ] **Tasks 13–15 — sync integration.** `outbox-emission.spec.ts` must pass
      **unmodified**; if it needs editing, that is the bug.
- [ ] **Tasks 16–20 — JML cleanup and console.**

---

## Organizations and multi-tenancy — Tasks 3–16

Plan: `docs/archive/plans/2026-08-08-organizations-multi-tenancy.md`
Detail: `docs/archive/plans/2026-08-08-organizations-TODO.md`

Task 2's gate is now closed: the full suite, the migration spec against a real
container, and the drift check all pass on the merged tree. Its two remaining
asks stand:

- [ ] **Review `17cd3f8` properly.** It is still the only task with no review.
- [ ] **Justify or revert three files Task 2 touched that its brief never
      named:** `test/business-roles-schema.spec.ts`, `test/support/pg.ts`,
      `src/organizations/organizations.repository.ts`.

Carry-forward findings, already diagnosed:

- [ ] **`organization_id` leaks into `GET` responses.** No response DTOs, so
      Drizzle returns the column regardless of the declared interface. Decide in
      Task 12 whether to expose or suppress it.
- [ ] **The `lower(slug)` unique index is unreachable** — the
      `organizations_slug_format` CHECK already forces lowercase. Drop the
      `lower()` or relax the CHECK; one of them is dead weight, and the test
      named for case-insensitivity proves only duplicate rejection.
- [ ] Minor: `organizations.schema.spec.ts` imports `sql` unused, and uses a dot
      separator where its sibling uses a hyphen.
- [ ] **Unverified assumption, settled only by Task 11:** that Keycloak grants a
      realm's creating service account admin rights on that realm. Decides
      whether `ensureRealm` needs an explicit `<realm>-realm` role grant.

Tasks 3–16 are otherwise not started; the plan specifies each.

---

## SSO application onboarding

Detail: `docs/archive/plans/2026-08-08-sso-app-onboarding-followups.md`.
Its items 4 and 5 (rebase, PR targeting) are obsolete — the work is merged.
Item 2 (run the full API suite) is done and green.

- [ ] **Run `apps/web/e2e/sso-apps.spec.ts` — it has never executed.** Needs the
      fixed-port dev stack and `scripts/keycloak-setup.sh` re-run so
      `idm-sso-admin` exists. One expectation is environment-dependent: the
      minting test asserts the 409 "has not synced to Keycloak yet" path because
      `keycloak_sso` is unconfigured in dev; configuring that target means
      updating the test to assert the modal instead.
- [ ] **Confirm Keycloak 26's partial-PUT semantics.** Does `PUT /clients/{uuid}`
      omitting a field clear or preserve it? `KeycloakSsoConnector` is correct
      under either answer, so this is not a latent bug — only the doc comment in
      `keycloak-sso.connector.ts` is unproven. Replace it with the empirical
      result.

---

## Security findings

Two audits were sitting uncommitted in worktrees and are now merged:
`docs/archive/audits/audit-client-supply-chain.md` (13 findings, console +
supply chain) and `docs/archive/audits/carried-findings-verification.md` (44
verified ledger rows). Read those for the full reasoning; this is only the
state of each.

### Closed

| ID | What |
|---|---|
| CS-M1 | nginx dropped all three security headers on every console response. Fixed and verified against real nginx: 0 of 3 headers before, 3 of 3 after, including the SPA fall-through route. |
| CS-M3 | No HSTS on the TLS vhost. Added. |
| CS-M5 | CI ran with the default GITHUB_TOKEN scope, mutable action tags, and the token left on disk beside dependency lifecycle scripts. All three closed. |
| CS-L1 | A failed sign-out was silent and the session survived. Now reported, driven by `auth.error` (a try/catch cannot see it), and `removeUser()` runs on the failure path. |
| CS-L2 | `revokeTokensOnSignout` left at its `false` default. Set. |
| SEC-L1 | PKCE `code_verifier`/`nonce` persisted in `localStorage`. Both stores are now sessionStorage. |
| SEC-L2 | `POST /users`' 409 echoed the value back, confirming a cross-scope email/username against global unique indexes. Now non-confirming, with the two regression tests that were missing. |
| SEC-L4 | `jwtVerify` did not require `exp`, so a signed token omitting it never expired. `requiredClaims: ['exp']`, with a test proven non-vacuous. |
| INJ-H-1 residual | `config: z.record(...)` silently dropped a `__proto__` key. Replaced with the `z.unknown()` + explicit-validation shape `rawAttributesSchema` already documents. |
| INJ-H-2 residual | `configPatchValueSchema` had no `noNulChar`, so a JSON-escaped NUL 500'd at the pg driver. Now a 400 at the boundary. |

### Open, in the carried report's own priority order

- [ ] **1. Bulk import's cap is ~7x the accidental one it replaced.** 5,000 rows
      x ~10.4 ms ≈ 50 s of blocking on-request work, reachable by any holder of
      `user:create`. Lower `IMPORT_MAX_ROWS`, batch the per-row lookups, or move
      commit off the request path. **The item most likely to take a real
      deployment down, and it is currently labelled "fixed".** Left alone here
      because choosing between those three is a product decision, not a defect fix.
- [ ] **3. The system-actor guarantee is stale.**
      `POST /connector-targets/:target/reconcile` induces a directory-wide,
      unscoped, per-entity-unaudited system write from an HTTP request. Thread the
      acting `userId` into `TargetReconciliationJob.auditOverride`, and correct the
      two doc comments and the `docs/12-security.md` bullet that currently tell a
      reader this cannot happen.
- [ ] **4. Attribute values land verbatim and permanently in the audit log**, with
      no read control (`users.controller.ts:200`). The report says this must land
      **before** any `attribute_definitions` write path does — and that write path
      has now merged, so this is a live blocker rather than a follow-up.
- [ ] **5. Enabling a propagation mapping retroactively exports withheld values**,
      and is now reachable. Needs a confirmation step stating how many users' values
      a new mapping will newly export. Interacts with item 4.
- [ ] **6. Reconciliation cannot see Keycloak-only accounts, and nothing schedules
      it.** `deploy/systemd/` has no reconciliation timer.
- [ ] **7. `syncState` derivation degrades linearly** with unsettled aggregates, on
      the directory's main list page.
- [x] **8. Committed dev fixtures are real, working, `sslRequired: "none"`
      secrets.** Done: renamed to `identity-manager-realm.dev.json`,
      `sslRequired: "external"`, `idm-test-client` imported disabled, plus
      `keycloak/realm-import/README.md`. The test client stays load-bearing
      (its `idm-api` audience mapper is what makes a direct-grant token
      acceptable), so the Testcontainers harness and `smoke:dev` enable it at
      runtime via `apps/api/scripts/dev-test-client.ts`. **Residual:** the
      seeded `admin@example.com` / `dev_password_change_me` and the
      `idm_sync_dev_secret_change_me` client secret are still real and still
      committed. Three deliberate, reasoned NON-fixes, not oversights:
      (a) `.env.example`'s `KEYCLOAK_ADMIN_CLIENT_SECRET` is a copy of the
      fixture's value, so it authenticates against nothing but a realm built
      from that fixture; changing the literal breaks `setup:all`, local
      onboarding and CI's hardcoded `env:` block, which is a bad trade for a
      value already inert outside dev. (b) `docker-compose.yml`'s
      `KC_BOOTSTRAP_ADMIN_PASSWORD` stays — it configures a laptop/CI-only
      container and both the test harness and `smoke:dev` now depend on it;
      the file instead carries a loud loopback-only warning. (c) Stripping the
      seeded `admin@example.com` credential would break `smoke:dev`, the E2E
      login and CI's `bootstrap:admin`, which is far beyond what a LOW finding
      on a dev fixture justifies.
- [ ] **CS-H1 (HIGH).** Dependency lifecycle scripts run unsandboxed as the service
      user at every install and upgrade, and `corepack prepare pnpm@9` is unpinned
      and integrity-unverified. The CI half is closed; the installer half is not.
- [ ] **CS-M2.** No Content-Security-Policy. Blocked on one specific thing:
      `index.html` carries an inline pre-paint theme script that must run before any
      bundled JS exists, so a CSP needs that script's sha256 injected at build time.
      An unverifiable hash would brick the console.
- [ ] **CS-M4.** `scripts/install.sh` pipes a remote script into `bash` as root with
      no pinning or checksum.
- [ ] **CS-M6.** `vite@5.4.21` + `esbuild@0.21.5` dev-server advisories, unfixed on
      the 5.x line. Developer workstations only, but this project's dev platform is
      Windows, where the path-traversal case is live.
- [ ] **CS-L3.** People's names and emails go into the URL query string, so they
      land in browser history and nginx access logs in plaintext.
- [ ] **Remaining item-10 residuals** — `Cf`-category Unicode in display names,
      unknown `role_key` yielding an unmapped 500, admin-path audit `before`
      snapshot unlocked, `effective-members` never re-narrowing,
      `ConnectorTargetsRepository.upsert` lost update, `simulate()` ignoring
      `rule.trigger`, no structured logger, inert JML triggers.

## Housekeeping

- [ ] **`scripts/verify.mjs`'s header is out of date.** It states "This
      repository has no git remote", which is no longer true — `origin` is
      `github.com/ssan9876/identity-manager`, and `.github/workflows/ci.yml`
      will now actually run.
- [ ] **Two bare `task-2-report.md` citations remain** in
      `apps/api/test/connector-secrets.spec.ts:45` and
      `apps/web/e2e/theme.spec.ts:19`, pointing at a file that exists nowhere.
      Other `.superpowers/` citations are a deliberate gitignored-ledger
      convention and are fine; these two are not.
- [ ] **`stash@{0}` is superseded** — "WIP on feat/user-activate…". Its four
      files became `c3524c6` and `a734538`, which are 66 lines further along.
      Droppable.

### Test-running notes, learned the hard way

- Cap vitest at 3 forks and pass **both** bounds:
  `--poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3`. `maxForks`
  alone aborts with `RangeError: options.minThreads and options.maxThreads must
  not conflict` before a single test runs, and vitest reports that as
  `Test Files no tests`, which reads like a filter problem.
- Read the printed `Test Files` / `Tests` summary, not the exit code — a piped
  run has previously reported exit 0 while the summary said 49 files failed.
- Docker Desktop's backend service must actually be running. When it is stopped
  the named pipes still answer, but the engine returns HTTP 500 and
  Testcontainers crashes the vitest worker rather than failing cleanly.

---

## Corrections to the previous TODO

Both claims were checked against the history and were wrong. Recorded so the
same conclusions are not reached again:

1. It called `feat/attribute-definitions-write-path` "fully contained in
   branches already pushed" and listed it as safe to delete. It was not: commit
   `6b75107`, *fix(security): close the attribute-validator ReDoS with a closed
   vocabulary*, existed on no remote. Deleting that branch on this advice would
   have destroyed a security fix.
2. It called `fix/sync-diagnostics` "the only unpushed branch carrying unique
   work". It carried none. Its whole tree delta against the business-roles line
   was stale pre-reorganisation doc paths (`docs/superpowers/` →
   `docs/archive/audits/`, `PRODUCT.md` → `docs/product-brief.md`) across ~150
   files, plus the absence of business-roles work. Its sync commits are the
   pre-reorganisation originals of what the business-roles line already carried
   in updated form; merging it would have resurrected dead doc paths repo-wide.
   It was deleted rather than merged.
