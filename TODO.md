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
- [x] **Tasks 17–20 — console and end-to-end. DONE.** 17–19 (roles list and
      detail, the simulate/publish gate, the person Entitlements tab) merged as
      `feat/br-console-17-19`; Task 20's end-to-end journey merged as
      `feat/br-task20-e2e`. Task 20 found a real product bug: `enable`/`disable`
      answered with the bare `business_roles` row while the console is typed
      against the full detail shape, so the detail page threw
      `Cannot read properties of undefined (reading 'length')` — blank screen,
      no toast — on the first render after enabling. Both routes now re-read the
      whole role after their sweep, with a shape-contract regression test.
      Confirmed fixed by hand in a real browser.

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
- [x] **SETTLED by Task 11, and it is subtler than the question asked.** A
      realm's creator DOES keep admin rights on a realm it created, so
      `ensureRealm` needs no explicit `<realm>-realm` grant. But the
      `<realm>-realm` roles are granted AT creation, so the access token used to
      make the create call PREDATES them: the client that just created a realm is
      the one client guaranteed to be refused on it — 201, then 403. The 401
      retry cannot cover this, because the token is valid and merely lacks a role
      that now exists. Hence `invalidateCachedToken()` on the 201 path; removing
      that one line turns 7 of 17 tests red. Also measured: `GET
      /admin/realms/<realm>` answers 200 with a stub representation to a bare
      `create-realm` holder with no rights in that realm, so it cannot be used as
      an authorization probe — `users/count` is used instead.
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
- [x] **Composite-FK constraint names are translated. DONE in Task 12.** New
      `common/cross-tenant.ts` maps the eight `(…, organization_id)` constraints
      from `0029` to a 409 naming the relationship. Consulted AFTER each
      repository's single-column branches, so `manager not found` (404) still
      beats `manager in another organization` (409).
- [x] **`KeycloakAdminClientFactory.evict(realm)`. DONE in Task 12.** Drops the
      memoized client and its live token; called when an organization is
      suspended. Three unit tests.
**Tasks 10–16 are now all done.** 10–11 (the `organization` outbox aggregate;
the realm connector) and 12–16 (the organizations API, organization-aware
fan-out, realm dispatch and unprovisioned deferral, the console, documentation)
are merged. Two deviations from the plan, both deliberate: fan-out DERIVES the
tenant inside `OutboxWriter.record` from the aggregate's own row rather than
threading `organizationId` through ~24 call sites, so a future call site cannot
forget it and cannot disagree with the row actually written; and master is
EXEMPT from the realm deferral, because its realm predates this system so
`realm_provisioned_at` is null forever and the plan's literal rule would have
deferred every user in every existing deployment.

**Verified in a browser on 2026-08-09**, against a real Keycloak 26 with a
`create-realm`-only provisioning client, every UI claim checked against the
Keycloak Admin API rather than the badge: creating "Acme Corp" derived the slug
`acme-corp` and really created that realm (`enabled: true`, displayName set);
the row showed `Provisioning` then `Active`, and `Keycloak only` against
master's `All enabled targets`; **Suspend disabled the realm without deleting
it** — three realms still present, `acme-corp` `enabled: false` — and Reactivate
re-enabled it. Master carries no Suspend control. No console errors.

**Still not run:** `apps/web/e2e/organizations.spec.ts` as a spec. The blocker
that nothing scripted `KEYCLOAK_PROVISION_*` is gone — `SETUP_PROVISIONER=1
bash scripts/keycloak-setup.sh` now mints the credential. What remains is
wiring that into the e2e harness and CI, and deciding what the spec does about
the realms it creates: each run leaves a Keycloak realm behind, and `create-realm`
can delete the realms it made, so teardown is possible but must be written.

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
| CS-M2 | The console served no Content-Security-Policy, blocked on `index.html`'s inline pre-paint theme script needing its sha256 in the policy. The hash is now DERIVED at build time from the emitted `dist/index.html` and written beside it as `dist/csp.conf`, which both vhosts `include` at all three levels that declare `add_header` of their own; `connect-src`/`frame-src` take the issuer origin from `VITE_KEYCLOAK_ISSUER`, so the policy follows each install's own Keycloak rather than a hardcoded one. Verified in Chromium against real nginx 1.24 serving the real `dist`: the theme script runs, React mounts, zero violations, and a fetch to an unlisted origin is refused. The trap it caught: the HTML parser normalizes CRLF to LF before CSP hashes a script's source text, so hashing the raw bytes of a Windows checkout blocks the script — invisible on the Linux host, fatal for anything built on Windows. |
| SEC-L1 | PKCE `code_verifier`/`nonce` persisted in `localStorage`. Both stores are now sessionStorage. |
| SEC-L2 | `POST /users`' 409 echoed the value back, confirming a cross-scope email/username against global unique indexes. Now non-confirming, with the two regression tests that were missing. |
| SEC-L4 | `jwtVerify` did not require `exp`, so a signed token omitting it never expired. `requiredClaims: ['exp']`, with a test proven non-vacuous. |
| INJ-H-1 residual | `config: z.record(...)` silently dropped a `__proto__` key. Replaced with the `z.unknown()` + explicit-validation shape `rawAttributesSchema` already documents. |
| INJ-H-2 residual | `configPatchValueSchema` had no `noNulChar`, so a JSON-escaped NUL 500'd at the pg driver. Now a 400 at the boundary. |

### Open, in the carried report's own priority order

- [x] **1. Bulk import — re-characterised and largely closed.** The finding as
      written ("5,000 rows x ~10.4 ms ≈ 50 s") describes a tree that no longer
      exists: `b36e7ad` had already lowered `IMPORT_MAX_ROWS` from 5,000 to
      **1,000** before this work started. The single "~10.4 ms/row" was also two
      different costs wearing one number, and only one of them was lookups.

      **Measured** (5,000-row CSV, Testcontainers Postgres, real Nest app, HTTP
      round trip timed before and after; bench spec deleted rather than left to
      add ~140 s of container time to every suite run):

      | phase | before | after |
      |---|---|---|
      | preview (creates) | 14,926 ms | **257 ms** |
      | commit (creates) | 60,915 ms | **42,251 ms** |
      | preview (updates) | 10,047 ms | **188 ms** |
      | commit (updates) | 46,350 ms | **41,670 ms** |

      Batching the per-row lookups into one set-based query per key kind
      (`imports/import-lookups.ts`) made **preview 58x faster** — resolution is
      now effectively free. **Commit improved 31% and then stopped**, and the
      residual is NOT lookups: it is one durable transaction per row (BEGIN,
      write, audit row, outbox row, COMMIT — a WAL flush each). A trivial query
      round trip measured 0.31 ms in the same environment, so latency is not the
      term. One transaction per row is exactly what keeps a failing row rolled
      back alone and row-attributed, so collapsing it is a change to the failure
      contract, not a tuning knob — deliberately not done.

      At 1,000 rows x the measured 8.45 ms/row that is ~8.5 s worst case,
      comparable to the ~7 s the old accidental body limit enforced, so the cap
      stays where `b36e7ad` put it. **A real bug was found on the way:**
      `apps/web/src/imports/api.ts` still mirrored 5,000, so the console would
      accept a file the server then 400s. Fixed, along with four stale doc
      tables. The scope and privilege checks in the batched path call the REAL
      `PermissionEngine`/`PrivilegeGuards` decisions, memoised — no second copy
      of authz logic.

      **Still open, deliberately:** moving commit off the request path. That is
      a job queue, status polling and new console states, and the import flow is
      built around a synchronous preview/commit pair.

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
- [ ] **CS-M2 residuals.** The policy itself is shipped (see the resolved table
      above), but two things are only reasoned about, not observed:
      `style-src 'self'` carries no `'unsafe-inline'` on the belief that React's
      `style={{…}}` props go through the CSSOM, which CSP does not police —
      true in the local Chromium run, unverified in other engines; and
      oidc-client-ts's silent-renew iframe (`automaticSilentRenew` defaults to
      `true`) is allowed to reach the issuer by `frame-src`, but its callback
      leg is still blocked by the pre-existing `X-Frame-Options: DENY`, so
      silent renew does not work now and did not before. Not a regression;
      worth closing properly.
- [ ] **CS-M6.** `vite@5.4.21` + `esbuild@0.21.5` dev-server advisories, unfixed on
      the 5.x line. Developer workstations only, but this project's dev platform is
      Windows, where the path-traversal case is live.
- [x] **`Referrer-Policy` is `no-referrer`, and this item was stale.** It claimed
      the header was still `same-origin` and offered
      `same-origin-when-cross-origin` / `strict-origin-when-cross-origin` as the
      remedies. Checked 2026-08-10: both vhost templates already send
      `no-referrer`, and the comment block in `deploy/nginx/idm.conf` had already
      worked through — and rejected — every alternative this item proposed.
      `same-origin-when-cross-origin` **is not a Referrer-Policy token at all**,
      so a browser would ignore it and fall back to its default;
      `strict-origin-when-cross-origin` still sends the full URL on same-origin
      requests, which is precisely the case that leaked the search term.
      `no-referrer` is the only value at least as strict as `same-origin` in
      every direction, and nothing here reads a `Referer` — the API authorizes
      from the bearer token, CORS never applies (one origin), and the OIDC
      redirect is driven by query parameters and PKCE.

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

- [~] **The console HAS now been driven in a browser — locally, not on a
      deployment.** Two independent passes on 2026-08-09 against the full dev
      stack (Keycloak 26, Postgres, API, Vite console): the Playwright suite
      (**45 passed**, covering sign-in, the OIDC redirect and React rendering
      across People, Groups, Org units, Imports, Audit, Self-service and the new
      business-roles journey), and an interactive pass driving Chrome by hand.
      The interactive pass confirmed the landing page, the OIDC redirect
      (PKCE `S256`, correct client and redirect URI), the People list with status
      and sync badges, the business-roles list and detail with its
      draft/simulate/publish gate, enable-with-toast, the person Entitlements
      tab, and the Sync tab showing a real Keycloak UUID as external id — with
      **zero console errors**, including across a full page load and a deep-link
      reload that kept the session.

      **This is exactly how the enable bug was caught**: `POST
      /business-roles/:id/enable` answered with the bare row while the console is
      typed against the full detail shape, so the detail page threw
      `Cannot read properties of undefined (reading 'length')` — blank screen, no
      toast — on first render after enabling. No API-level test could see it.
      Fixed, with a shape-contract regression test.

      **What remains:** nothing has driven the console against the DEPLOYED host
      (the earlier LXC verification stopped at HTTP), and the Organizations
      console from Tasks 12–16 has never been seen in a browser at all — its
      `apps/web/e2e/organizations.spec.ts` has never executed, because it needs
      the stack with `KEYCLOAK_PROVISION_*` configured.

- [x] **`idm-lifecycle.timer` / `idm-reconcile.timer` are installed and active.**
      `scripts/install.sh` enables both on a fresh host, and `scripts/update.sh`
      closes it generically for existing ones: it renders EVERY unit in
      `deploy/systemd/` and `enable --now`s every `.timer` it finds, so a release
      that adds a timer reaches hosts without anyone remembering to. Confirmed on
      ct:211 2026-08-10 — both timers `enabled` and `active`, including
      `idm-lifecycle` after its unit files were deliberately deleted and restored
      by a single `update.sh` run.

- [x] **`scripts/update.sh` verified on real infrastructure.** Run 2026-08-10
      against ct:211 on proxmox-02 (Ubuntu 24.04, fresh `install.sh` from this
      branch; Keycloak on ct:210, realm created by `keycloak-setup.sh`). Both
      containers were snapshotted first (`blank_pre_install`, `pre_idm_realm`).

      **Repair proven, not assumed.** The deployed host was damaged deliberately
      and the damage confirmed live before each run: the four security headers
      stripped from the vhost and reloaded (verified absent from real responses),
      `/etc/nginx/conf.d/idm-log.conf` deleted, the `idm-lifecycle` timer and
      service units deleted, and the `sites-enabled` symlink removed. One run
      repaired every one of them — headers back, log format back, symlink back,
      timer back to `enabled` **and** `active`. The `sites-enabled` re-assertion
      and the generic `deploy/systemd/` loop each did what they were added for.

      **Three real bugs, none of them findable by reading the script.**
      1. The health probe sampled once, immediately after `systemctl restart`.
         `is-active` reports a Type=simple unit active the moment the process
         forks; Nest binds the port seconds later. Now polls to 60s.
      2. The security-header probe sampled once, immediately after
         `systemctl reload nginx`, which returns while workers under the old
         config are still answering. It reported all three headers MISSING on a
         host it had just repaired correctly — a false red from the one check
         whose whole purpose is catching a re-render that did not happen. Now
         polls to 15s.
      3. **The script replaced itself mid-run.** It pulls into the checkout it
         is executing from, and bash reads a script incrementally by byte
         offset. A run that pulled fix (1)+(2) then executed the PRE-fix
         verifier and reported the exact failures that commit had eliminated;
         the ugly case is bash resuming mid-line on a fragment. It now execs the
         new copy when the pull moves `scripts/update.sh`, carrying the pre-pull
         commit across so the rollback advice still names the right one.

      Final state: four runs, the last two fully green end to end, including a
      genuine pull, a self-update hand-over, migrate, re-render, restart and all
      seven verification checks. Console serves `ed88933`, `/api/users` 401s
      unauthenticated, and the OIDC issuer and API base are correctly baked into
      the bundle.

## Housekeeping

- [x] **`scripts/keycloak-setup.sh` now creates the provisioning client.**
      Behind `SETUP_PROVISIONER=1`, opt-in rather than default: this is the one
      credential whose reach is the whole Keycloak server, and a single-tenant
      install should not hold it. Without the flag the script says plainly that
      Organizations will answer `503 NOT_CONFIGURED` and how to fix it, so the
      failure is no longer a mystery. Verified end to end against Keycloak 26 on
      a throwaway client: the minted credential obtained a token, created a
      realm (201), and administered it.

      The scope of `create-realm` was measured rather than restated, and the
      table is now in `docs/06-configuration.md`. Against a realm it did **not**
      create, the credential gets 200 on a bare `GET /admin/realms/<name>` and
      403 on everything else — users, clients, realm update. The previous doc
      wording implied no access at all; the bare read is the one exception.

      It also settled a question the code had only answered empirically: the
      creator roles attach to the service account, **not** to tokens already
      issued to it. A token minted before the realm existed gets 403 on that
      realm's `users/count`; one minted after gets 200. That is precisely why
      `KeycloakAdminClient.invalidateCachedToken()` is load-bearing and why
      deleting it as dead code turns seven tests red.

- [x] **`.env.example` no longer blocks `db:migrate`.** Of the two remedies
      this item offered, the right one was to ship the lines commented, not to
      relax the schema. I tried the schema first and it was wrong: `test/env.spec.ts`
      already asserts that an empty value is *rejected*, on the deliberate
      grounds that a blank credential is an accident and failing at startup
      beats a client-credentials grant with an empty secret and a confusing 401
      from Keycloak. That reasoning holds, so the schema is untouched.

      `KEYCLOAK_PROVISION_CLIENT_ID` / `_SECRET` are now commented out rather
      than present-but-empty. The mechanism is Node's `--env-file`, not dotenv
      as previously assumed — measured: `FOO=` yields `""`, a commented line
      yields `undefined`. Verified end to end by running the real `.env.example`
      through the real loader: `loadEnv` succeeds and both values come back
      null.

- [x] **`scripts/verify.mjs`'s header was already correct.** Stale item — the
      header now reads "CI is live as of 2026-08-08 ... the repository now has a
      remote and master is pushed". Fixed at some point before this was
      re-checked on 2026-08-09; the ledger simply had not caught up.
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
