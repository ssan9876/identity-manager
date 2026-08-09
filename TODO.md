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

- [x] **Task 9 — re-evaluate on every user write.** Done and verified.
      `RoleReconciler` is registered and deliberately NOT `@Optional()`, so a
      missing provider fails boot rather than silently skipping re-evaluation.
      `REEVALUATION_FIELDS` is DERIVED from the evaluator's own condition fields,
      so a newly-nameable field cannot fail to trigger. A refusal throws and
      rolls the write back. Four end-to-end HTTP tests, confirmed non-vacuous
      (stubbing the call sites fails all four). **Confirmed live on a real
      deployment: the app boots with the reconciler resolved** — business roles
      now actually run in a deployed system, which they never did before.
- [x] **Task 10 — sweep job and CLI.** Done and verified: 23/23, including
      idempotence and tolerating a refusal without aborting the sweep. The CLI
      constructs the job itself, mirroring `target-reconcile`.
- [x] **Task 11 — actions, guards, controller.** Done on `feat/br-task11-api`,
      NOT yet merged. `business_role:read` (super_admin, user_admin, auditor,
      read_only) and `business_role:manage` (super_admin alone), plus
      `BusinessRolesController`: list/create/detail/patch, the
      draft/simulate/publish gate, enable/disable, and the two exception
      routes. Every MUTATING route asserts a *global* grant
      (`scopePathsFor(...) === null`), so a scoped super_admin is refused —
      finding AUTHZ-M-2, asserted route by route. Publish, enable and disable
      sweep with `reconcileRole` AFTER their transaction commits; an exception
      re-evaluates one person inside it. 27/27 in
      `test/business-roles.controller.spec.ts`; `guard-coverage`,
      `app.module`, `actions`, `business-roles` and `business-role-evaluator`
      re-run green. **Merged; full suite since run green, including
      `pool-exhaustion` and `outbox-emission`** — the two this task flagged as
      "argued, not measured" for its connection discipline. `simulate` reports
      the diff role-locally, which over-states `lossCount` and never
      under-states it: the safe direction for a screen whose purpose is "am I
      about to remove access". Also registered `RoleReconciliationJob`, which
      Task 10 had left registered nowhere.
- [x] **Task 12 — `GET /api/users/:id/entitlements`.** Done, 10/10.
      `justifiedBy` is three-valued on purpose: a list of roles, `[]` (nothing
      justifies it — the permanent state of a `manual` row), or `null`
      (**unknown**: the engine refused). Collapsing `null` into `[]` would
      render a broken engine as "no role justifies any of this", which reads
      as an instruction to revoke everything. A refusal returns HTTP 200 with
      the rows plus an `unevaluable` marker, because this is the screen someone
      opens *because* something is wrong. Out-of-scope is 403, not 404
      (SEC-L2). No transaction on the route, deliberately — nothing to make
      atomic, and holding one across the reads would be the shape of C1.
- [x] **Tasks 13–15 — sync integration.** Done. `outbox-emission.spec.ts`
      passes **33/33 unmodified**, which was the whole safety property: the
      `all_users` default reproduces existing behaviour exactly.
      Two things worth remembering, both found by deviating from the plan:
      the plan's own illustrative code would have filtered group/org-unit/
      sso_app events by an empty entitlement set and **silently stopped those
      syncs** to any `entitled_only` target — now gated behind a
      `consultsEntitlement` flag; and Task 14 required making
      `SyncWorker.buildDesiredUser` entitlement-aware even though that file was
      not in its list, because otherwise the revoke-disable event lands and the
      worker immediately recomputes `enabled` from status alone and re-asserts
      `enabled: true`. Offboarding independence (settled decision 8) needed no
      production change; its four tests are regression guards, and they first
      assert a 409 to prove the unevaluable-role landmine is genuinely live
      rather than passing vacuously.
- [x] **Task 16 — remove JML's group actions.** Done, 48/48. Business roles own
      desired membership now, so a JML rule granting one would be a second
      writer the reconciler revokes. Migration `0027` is a GUARD, not a schema
      change: Postgres cannot `DROP VALUE`, so the enum keeps both labels and
      application code rejects them — the migration refuses to run while any
      stranded rule survives, because a silently dead rule is a permission
      somebody still believes is being maintained. It can only protect a
      database on the way past, never retroactively.
- [ ] **Tasks 17–20 — console and end-to-end.**

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

- [x] **`organization_id` in `GET` responses — decided in Task 12: EXPOSED.**
      The row types now DECLARE the column they were already returning, rather
      than adding explicit column lists to every read in every repository. It is
      not sensitive to its audience: every actor who can read a directory row is
      a platform operator, and `organization:read` returns the roster and its ids
      to exactly the same super_admin population. Revisit in the DTOs if a
      tenant-facing API is ever added.
- [x] **The `lower(slug)` unique index — resolved in Task 12: the `lower()` was
      dropped** (migration `0032`), and the CHECK survives. The CHECK enforces
      the DNS-label shape a Keycloak realm name needs, which is far more than
      case-folding; the expression index enforced nothing the CHECK did not
      already, and made the index unusable for a plain `WHERE slug = $1`.
- [ ] Minor: `organizations.schema.spec.ts` imports `sql` unused, and uses a dot
      separator where its sibling uses a hyphen.
- [ ] **Unverified assumption, settled only by Task 11:** that Keycloak grants a
      realm's creating service account admin rights on that realm. Decides
      whether `ensureRealm` needs an explicit `<realm>-realm` role grant.

- [x] **Tasks 3–4 — per-organization uniqueness and composite FKs.** Done.
      Migrations `0028`/`0029`. Three bugs in the plan's own SQL were found and
      fixed: `ON DELETE SET NULL` on the composite manager FK would have nulled
      `organization_id` (which is NOT NULL), so **every manager deletion would
      have failed** — now the Postgres 15+ column-list form
      `ON DELETE SET NULL (manager_id)`, which Drizzle cannot express, so the
      SQL is deliberately narrower than the schema declaration and both files
      say why; composite FKs were added before the unique indexes they
      reference; and an edge column was made NOT NULL with no backfill.
- [ ] **NEW CONSTRAINT from Task 4: every migration from `0027` onward must be
      re-runnable.** `migrate.spec.ts` used to rewind the ledger by deleting the
      newest `created_at` row, which silently stopped testing `0027`'s guard the
      moment any later migration landed — it would have kept passing while
      asserting nothing. It now rewinds to `0027`'s own journal `when`, so the
      whole tail replays. Use `ADD COLUMN IF NOT EXISTS` and `duplicate_object`
      guards, as `0025` and `0029` do.
- [ ] **Deferred to Task 12: teach `translateWriteError` the composite-FK
      constraint names.** `GroupsRepository.addUser` now relies on
      `gum_user_organization_fk` to refuse a cross-tenant membership, which
      surfaces as a raw 23503 → 500 rather than a translated 4xx. Safe (the
      write IS refused) and not reachable today, because there is exactly one
      organization until the organizations API exists. Client responses stay
      clean (SEC-L7), so nothing leaks. Do it in Task 12, when the journey that
      makes it reachable is in hand.

- [x] **Tasks 5–7 — Phase 1 complete, and its GATE IS CLOSED.** Migration `0030`.
      Business-role and JML evaluation are now organization-scoped: the plan's
      note that "nothing reads business_roles yet" was **stale** — Milestone 17
      landed a reconciler firing on every user write before this task ran, so
      unscoped, the first non-master tenant would have had another tenant's
      formulas evaluated against its people. The database is not sufficient
      cover either: a cross-tenant *group* grant is refused by the composite FK,
      but `user_target_accounts` carries no organization at all, so a
      cross-tenant *target* grant had no guard. `organizationId` is now a
      required LEADING parameter, so omitting it is a compile error rather than
      a review miss. `business_roles_name_idx` also became
      `(organization_id, name)` — a global unique name would let the first
      tenant to onboard "Engineering Standard Access" deny it to every other,
      with the 409 doubling as a cross-tenant existence oracle (the SEC-L2
      pattern in a new place).

      **Gate evidence**, both halves run serially as the plan requires:
      full API suite **1419/1420** (the one failure is the Keycloak-dependent
      `dev-environment` spec), and a **real boot against a real Keycloak** on
      the lab host — not a container. Adoption worked (`realm=NULL` →
      `realm=identity-manager`, health 200), and the fail-closed half was
      verified by pointing `KEYCLOAK_ISSUER` at a different realm: the API
      **refused to listen** (health `000`) with
      *"KEYCLOAK_ISSUER names realm … but the master organization is bound to …
      Refusing to start: changing it would re-point every existing user."*
      Restoring the issuer recovered cleanly. That path had never run outside a
      container.
      **Gate item 2 — "people, groups and sync behave exactly as before" — is
      now actually exercised**, not inferred from a health check. Driven
      through the real console against the real deployment: created a person
      (organization populated automatically; outbox `user/created` reached
      `done`), created a group, added a membership through the picker. All
      three wrote audit rows attributed to the acting human, and the membership
      emitted `membership_changed`, drained on the first attempt
      (`attempts=0`). The membership row landed with `organization_id` matching
      BOTH the user's and the group's — which is the design: ONE column
      participates in TWO composite FKs (`gum_user_organization_fk` and
      `gum_group_organization_fk`), so a cross-tenant edge is structurally
      unrepresentable rather than merely rejected. Fixtures were cleaned up;
      the lab database is back to its prior state.

      **What the lab CANNOT prove, stated plainly:** the cross-tenant guard
      itself. With exactly one organization every row is same-tenant by
      construction — forcing a foreign `organization_id` is caught by the plain
      FK for not existing, and a "real but different" tenant does not exist to
      try. That guard is covered by `organizations.isolation.spec.ts` (10
      tests) against fabricated tenants, and becomes live-testable only when
      Task 12's API can create a second organization.

- [x] **Tasks 8–9 — provisioning credentials and a per-realm Keycloak admin
      client.** No migration needed; neither touches the schema.

      **The design's load-bearing unverified assumption is now SETTLED, in our
      favour.** The plan assumed Keycloak grants a realm's *creating* service
      account admin rights on that realm, and flagged it unverified until
      Task 11. Proven empirically against a real Keycloak 26 container: a
      master-realm client holding **only** `create-realm` created a realm and
      then read *and* wrote in it with no further grant, while the realm-scoped
      `idm-sync-service` credential could NOT reach a tenant realm.
      **`ensureRealm` does not need an explicit `<realm>-realm` role grant.**
      *Boundary:* this proves the creator keeps rights on a realm **it**
      created. Adopting a realm created by someone else — a pre-existing realm,
      or one created before a credential rotation — is still unproven.

      **A real secret leak was found and fixed, which four audits had missed.**
      `KeycloakAdminClient` held `private readonly config`; TypeScript `private`
      is compile-time only, so `JSON.stringify(client)` printed `clientSecret`
      verbatim — one structured logger or error reporter away from writing a
      Keycloak admin secret to a log. Now a true ECMAScript `#config`, which is
      invisible to `JSON.stringify`, `Object.keys` and `util.inspect`; verified
      independently (the old shape leaks a sentinel, the new one does not).
      Swept the rest of `apps/api/src` for the same pattern: `SyncWorkerConfig`
      (four numbers), `ImportsConfig` (`{maxRows}`) and `JwtGuardOptions`
      (`{issuer, audience}`) carry no credentials, so no others need changing.
- [ ] **Deferred to Task 12: `KeycloakAdminClientFactory.evict(realm)`.**
      `forRealm` memoizes forever with no eviction. Harmless until something
      deletes a realm — which arrives with the organizations API — but a deleted
      tenant's cached admin client and token would otherwise linger. Same
      deferral reasoning as `translateWriteError` and the
      `business_role_grants` composite FK: written now it could not be
      exercised.

Tasks 10–16 are otherwise not started; the plan specifies each.

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
| **CS-H1 (HIGH)** | Dependency lifecycle scripts ran as the service account on the host holding every secret, at every install and upgrade. Closed with `pnpm.onlyBuiltDependencies: ['esbuild']` — an allow-list, not an all-or-nothing block — plus `packageManager` pinned by sha512 and `corepack prepare pnpm@9.12.0` instead of the `pnpm@9` range. The audit assumed this needed pnpm 10; pnpm 9 supports the field, so no upgrade was required. Allow-list determined empirically: a clean install blocks exactly one package, `cpu-features`, an optional native accelerator that already failed to build without a C++ toolchain. |
| CS-M4 | `install.sh` piped a remote script into a root shell with output to `/dev/null`. Now adds NodeSource's GPG key and a `deb [signed-by=…]` source directly, so no remote code runs as root. Plus an explicit post-install version assertion, verified empirically. |
| CS-L3 | Search terms — people's names and emails — were written to `/var/log/nginx/access.log` in plaintext, from the console URL, from `GET /api/users?search=…`, and a third time from the same-origin `Referer`. Both vhosts now log through an `idm_noquery` format that drops the query string from the request line and the referrer; verified against nginx 1.24. Filters stay in the URL, so deep links still work — the browser-history half is documented, not fixed, and the OIDC `code`/`state` in the redirect is protocol behaviour, now merely not retained. |
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
- [x] **3. The system-actor guarantee is stale.** Both halves done: the acting
      `userId` is threaded into `TargetReconciliationJob.auditOverride`, so a
      `connector:reconcile-override` row names a human when one exists (the CLI
      path keeps its system-actor shape), and the two doc comments plus the
      `docs/12-security.md` bullet no longer tell a reader this cannot be induced
      from a user-facing path. **Carried forward, still open:** the per-entity
      writes a reconcile performs are not permission-checked, scope-narrowed,
      audited or outboxed, so security constraint 7 does not hold for that route
      (nor, less dramatically, for `PATCH /connector-targets/:target` and the
      `attribute-target-mappings` routes).
- [x] **4. Attribute values land verbatim and permanently in the audit log.**
      Done. `attribute_definitions` gains a `sensitive` flag (migration `0026`);
      flagged values are withheld from audit snapshots and the withheld keys are
      named in `attributesRedacted`. Applied to every audit path the finding
      lists — users create/update/activate/deactivate, self-service, imports, JML
      lifecycle, the rule applier and bulk-activate — and deliberately NOT to
      outbox payloads, because connectors provision from those. **Correction to
      an earlier note in this file:** the `attribute_definitions` write path has
      NOT merged; that controller still exposes only `@Get()`. So this landed
      before a write path exists, which is what the audit's fix direction asked
      for, rather than after one as previously stated here.
      **Known limitation:** with both `before` and `after` redacted, an audit row
      no longer shows whether a sensitive value CHANGED. A hash would restore
      that, but these values are low-entropy and a hash of one is reversible by
      enumeration, which would put the value back in the log by a side door.
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
- [ ] **CS-M2.** No Content-Security-Policy. Blocked on one specific thing:
      `index.html` carries an inline pre-paint theme script that must run before any
      bundled JS exists, so a CSP needs that script's sha256 injected at build time.
      An unverifiable hash would brick the console.
- [ ] **CS-M6.** `vite@5.4.21` + `esbuild@0.21.5` dev-server advisories, unfixed on
      the 5.x line. Developer workstations only, but this project's dev platform is
      Windows, where the path-traversal case is live.
- [ ] **`Referrer-Policy: same-origin` still sends the search term to the API.**
      Surfaced while fixing CS-L3. The access log no longer retains it, and the
      request is same-origin so it terminates at nginx — not a live exposure. But
      `same-origin-when-cross-origin` or `strict-origin-when-cross-origin` would
      remove the term from the request itself rather than only from what gets
      written down. Deferred because both vhost header blocks were just rewritten
      for CS-M1 and this is a different header and a different finding.
- [ ] **Remaining item-10 residuals** — `Cf`-category Unicode in display names,
      unknown `role_key` yielding an unmapped 500, admin-path audit `before`
      snapshot unlocked, `effective-members` never re-narrowing,
      `ConnectorTargetsRepository.upsert` lost update, `simulate()` ignoring
      `rule.trigger`, no structured logger, inert JML triggers.

## Verified against a real deployment

Run 2026-08-09 against a Proxmox LXC clone of the live host (Ubuntu 24.04,
PostgreSQL 16.14, upgrading from `58c3577` — 90 commits behind). The live
container was never touched; a snapshot was taken first and the work was done on
a full clone.

**Two bugs that only real infrastructure could surface:**

- [x] **Migrations could never run twice on a deployed host.**
      `provisionRuntimeRole` re-ran `ALTER ROLE ... NOSUPERUSER NOCREATEDB` on
      every migrate. PostgreSQL 16 tightened `CREATEROLE` so a role may only set
      attributes it holds itself; `idm_owner` is deliberately NOSUPERUSER, so it
      cannot name those even to set them negative. `CREATE ROLE` with the same
      words still works — so a fresh install succeeds and the SECOND migrate
      fails. Every test database is created fresh, so this branch never ran in
      CI or Testcontainers. Now asserts the password alone and VERIFIES the
      attributes against `pg_roles`, which is strictly stronger.
- [x] **`git pull` does not deploy anything under `deploy/`.** Those are
      templates; only `install.sh` copies them. An upgrade that pulls the CS-M1
      header fix and CS-L3 log fix and restarts `idm-api` leaves the console
      serving no security headers and still logging emails. Both confirmed
      absent after a pull-only upgrade and present after re-rendering. An
      upgrade procedure is now documented in `docs/11-operations.md`.

**Confirmed working against live data** (3 users, 1 org unit, 19 migrations
already applied):

| Check | Result |
|---|---|
| Migrations `0019`→`0026` | applied, 27 total |
| Organizations backfill | master org created; users/org_units/groups **0 orphaned** |
| `sensitive` column (`0026`), `sso_apps` (`0023`) | present |
| API after upgrade | healthy, `/users` 401s, clean journal |
| Security headers (CS-M1/CS-M3) | all 4 present, incl. SPA fall-through, over the network |
| Access log (CS-L3) | search term and referrer stripped; 0 occurrences of the PII |

Two traps worth knowing, both of which made a working fix look broken:

- **The vhost is selected by `server_name`.** `curl https://127.0.0.1/` reaches a
  different server block and shows no headers at all. Always pass
  `-H "Host: <hostname>"`.
- **Check for an IP collision before assigning one to a clone.** A clone
  inherits the source's static IP; reusing an address already held by another
  container makes it answer for the wrong host, which looks exactly like the
  upgrade having deployed the wrong bundle.

### Still unverified on real infrastructure

- [ ] **The console has never been driven in a browser.** Chrome automation was
      unavailable (extension not connected), so verification stopped at HTTP:
      HTML, bundle and SPA routing all serve correctly, but nothing has exercised
      sign-in, the OIDC redirect, or any React rendering path on a deployment.
- [ ] **`idm-lifecycle.timer` / `idm-reconcile.timer` are not installed on the
      live host** — only `idm-api.service` is. They arrive with the deploy/
      re-render described above.

## Housekeeping

- [ ] **`scripts/verify.mjs`'s header is out of date.** It states "This
      repository has no git remote", which is no longer true — `origin` is
      `github.com/ssan9876/identity-manager`, and `.github/workflows/ci.yml`
      will now actually run.
- [x] **Two bare `task-2-report.md` citations removed** from
      `apps/api/test/connector-secrets.spec.ts` and
      `apps/web/e2e/theme.spec.ts`, which pointed at a file that exists at
      no path relative to them. Other `.superpowers/`-qualified citations
      are a deliberate gitignored-ledger convention and are fine.
      **Done** (`fix/security-residuals`): both removed rather than
      repointed — the ledger is gitignored and absent from a fresh worktree,
      so no path written here could be verified. Each comment now stands on
      something in this repository instead: connector-secrets.spec.ts on its
      own in-suite `assertNoLeak` meta-test (the nested "assertNoLeak is not
      a vacuous check" describe block), theme.spec.ts on
      `apps/web/src/styles/tokens.css`, whose header records the computation
      method, the ratios it corrected inline, and the full
      `.superpowers/...` path onward to the complete table.
- [x] **The bare-citation item rested on an inverted premise; closed without
      code changes.** It claimed two (then four) bare citations "remain",
      against a convention where the rest were `.superpowers/`-qualified.
      Measured on the merged tree, tracked files only, excluding this file:
      **103 bare citations across 67 files** — `task-1-brief.md` through
      `task-9-report.md`, of which **30 are in `apps/api/src`** including
      `permission.engine.ts`, `privilege.guards.ts`,
      `sync-state.repository.ts` and migration `0014_known_photon.sql` —
      against **5** path-qualified ones. The bare form IS the convention.
      The two that were rewritten were not stragglers; they were among the
      handful ever written the other way.

      **The ledger is not missing.** It lives at `.superpowers/sdd/`, which
      `.gitignore:7` excludes, so it is present in the original clone and
      absent from every fresh worktree — which is why it reads as
      unresolvable when checked from one. It holds five milestone
      directories, so a bare `task-3-report.md` IS ambiguous on its face
      and resolvable only by matching content.

      **Decided: leave the 103 alone.** Path-qualifying them is a
      comment-only diff across 67 files, touching production code for no
      behavioural gain, and it would encode a path that only a ledger holder
      can follow anyway. A reader without `.superpowers/` cannot use either
      form; a reader with it can find a bare name by grep. What was actually
      worth fixing — a citation whose claim could not be checked at all —
      was fixed in the two files above by resting each comment on something
      that lives in this repository.

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
