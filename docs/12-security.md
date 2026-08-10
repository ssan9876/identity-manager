# 12 — Security model

> ## Current status
>
> **The adversarial security audit for this build is incomplete.**
>
> Five dimensions ran — authentication/authorization, injection, integrity/concurrency,
> secrets, and client-side/supply-chain ([`archive/audits/audit-client-supply-chain.md`](archive/audits/audit-client-supply-chain.md),
> dated 2026-08-08) — and their findings were fixed across five waves plus the
> follow-up work in [Recently closed findings](#recently-closed-findings) below.
>
> Planned dimensions remain unrun and a number of findings are still unverified. The
> only *total* on record is **six planned dimensions**, in
> [14 — Roadmap](14-roadmap.md); five have now run, so **one** remains unrun. That
> roadmap line also says "four of six ran", which is the same stale count corrected in
> this banner — the arithmetic above is derived from a record that has itself drifted,
> not from an independent re-count, and no enumeration of the planned dimensions by
> *name* exists anywhere. [`archive/README.md`](archive/README.md) carries only the
> older "two never ran" figure.
>
> The **~twenty unverified findings** figure is likewise carried forward from that
> record and was **not re-counted in this pass**. It predates the closures below, so
> treat it as an upper bound rather than a current figure.
>
> **Installing this on an internal or lab network is reasonable. Exposing it to
> untrusted users is not, yet.** The full record is in [`archive/audits/`](archive/audits/).

## What the system claims to uphold

These are the binding constraints. Each has a mechanism behind it, not just an
intention.

1. **It never generates, transmits, or stores a credential.** Keycloak owns them. There
   is no password column anywhere in the schema, and the console has an end-to-end test
   asserting no password input is ever rendered.
2. **Attribute propagation is default-deny.** A field with no `attribute_target_mappings`
   row for a target cannot reach that target — absence of a row, not a column default,
   is what makes this structural.
3. **Self-service edits are default-deny.** Only `location` plus attributes explicitly
   marked `self_editable`.
4. **There is no delete for users.** `deactivated` is terminal.
5. **Deactivated users are excluded from default list and search views.**
6. **Authorization is enforced in the API, never the UI.** The console hides what you
   cannot do; it never decides it.
7. **Every mutation is permission-checked, scope-narrowed, audited and outboxed in one
   transaction.**
8. **A rejected mutation writes zero audit rows and zero outbox events.**
9. **The audit log is append-only**, by two independent mechanisms.
10. **Scope is evaluated per request and never cached across requests.**
11. **JML rules are data, never executable code** — proven by a static source scan in
    the test suite.
12. **Tenancy is enforced by the database, not by application code.** Every directory
    row carries `organization_id`, and every reference that could cross a tenant
    boundary — a user's org unit and manager, a group's org unit, an org unit's parent,
    both endpoints of every membership and nesting edge — is a **composite foreign key**
    including that column, so a cross-tenant row cannot be inserted by any writer: not
    the API, not a CSV import, not a connector write-back, not a future endpoint, not a
    bug. Application checks are bypassable; a composite foreign key is not.
    Administrators are **platform operators** who authenticate against the master realm,
    and a global role assignment therefore spans every organization. Tenant isolation
    here is about the DATA, not about who may see it.

## The mechanisms

### Authentication

`JwtGuard` verifies every bearer token against Keycloak's JWKS: signature, `iss`, `aud`,
expiry, and that `sub` and `preferred_username` are present **and are strings**. An
`alg: none` token, a wrong issuer, or a wrong audience is rejected before any handler
runs.

The principal is then resolved to a local `users` row by username, **fresh on every
request**. Resolution fails closed: no local row → denied; status not exactly `active` →
denied, via an allow-list rather than a deny-list of known-bad statuses.

### Authorization

Three independent dimensions — action, scope, rank — all applied, none subsuming
another. See [08 — Authorization model](08-authorization.md).

The two structural properties worth repeating here:

- **An out-of-scope resource that exists returns 403, not 404.** The directory's
  existence is not secret; its contents are.
- **Resources with no containing org unit require a *global* grant**, not merely the
  action somewhere. This closed three real findings where an org-unit-scoped admin held
  the same authority over global infrastructure as a global one — including the ability
  to disable `keycloak` and stop credential sync organisation-wide.

### The audit log

Append-only, twice over:

1. **Privilege.** The runtime role has no `UPDATE`/`DELETE`/`TRUNCATE` on `audit_log`.
   Those grants were never made.
2. **Triggers.** DML triggers reject those statements for anyone who *does* hold them,
   including the owner.

Defeating one is not enough. This matters because a role that both serves runtime
traffic and owns its own schema can always defeat a trigger it owns — one
`CREATE OR REPLACE FUNCTION ... RETURN NULL` disarms every trigger on the table, and an
`ALTER TABLE ... ALTER COLUMN ... TYPE ... USING` rewrites every row without firing a
DML trigger at all. The privilege split makes the guarantee structural rather than
voluntary.

`actor_user_id` uses `ON DELETE RESTRICT`, not `SET NULL` — attribution cannot quietly
erode either.

Audit snapshots name their fields **explicitly**, never `{ ...user }`. A spread would
silently carry a future sensitive column into a log a leak can never be removed from.

### Secrets

`connector_targets.config` stores a secret's **name**, never its value. Resolution
happens at the point of use, every time: never cached beyond one call, never written
back, never returned by any endpoint, never logged, never in an error message or stack
trace.

Only variables matching `^CONNECTOR_[A-Za-z0-9_]+$` are resolvable, and the pattern is
checked **before** the environment is indexed.

This closed a CRITICAL finding that no adversarial verifier could refute: connector
config is admin-editable and names both the credential *and* the destination host, so
without the namespace a holder of `connector:manage` could set `credentialSecretName` to
`DATABASE_URL`, point the target at a host they control, and receive the database
password in an `Authorization` header — with `healthDetail` available as a convenient
oracle.

A sentinel-value test seeds a recognisable value into the environment and greps every
response, log line and thrown error for it.

### Input handling

- Every HTTP boundary parses with a `.strict()` Zod schema — unknown keys are 400s
  naming the key.
- Every free-text field rejects NUL characters, closing a JSON-escaped-NUL finding
  confirmed live against `POST /org-units`.
- Every SQL parameter is bound, including in the authorization engine. One site used
  bare interpolation and was fixed: a bare JS array in Drizzle is spliced as a
  parenthesised list of individually-bound scalars rather than sent as one bound value.
- Query pagination rejects array-shaped parameters before coercion — Express's `qs`
  parser turns `?limit[]=5` into `['5']`, and `Number(['5'])` is `5`.
- `offset` is bounded by `MAX_SAFE_INTEGER`; without it, `1e21` passed `.int()` and only
  failed at Postgres as an unmapped 500.

### Resource limits

| Limit | Default | Why |
|---|---|---|
| `BODY_LIMIT_BYTES` | 10 MiB | Replaces Express's *accidental* 100 KiB default. That accidental limit capped imports at ~800 rows purely by chance and would have vanished the moment anyone set a parser limit for a legitimate reason. |
| `IMPORT_MAX_ROWS` | 1,000 | Import commit is ~8.5 ms of serial work per row (measured, after the per-row lookups were batched); this bounds request duration independently of body size. Checked before any row is resolved. |
| `DB_POOL_MAX` | 10 | Pool size and timeout behaviour are load-bearing for availability, not just performance. |

Both parsers are registered explicitly with `bodyParser: false` on the Nest factory —
registering a second parser after Nest's default never applies its limit, because
`body-parser` skips re-parsing a body a prior middleware already consumed.

### Concurrency

- **Group nesting cycles** are detected under a Postgres advisory lock, so two
  concurrent transactions cannot each observe "no cycle" and jointly create one.
- **`PATCH /self`** reads the current row with `SELECT ... FOR UPDATE`. A plain read
  inside a transaction takes no lock and gives no repeatable read under READ COMMITTED —
  two concurrent edits both merged onto the same stale snapshot and the later commit
  silently overwrote the earlier one, measured 30 times out of 30.
- **Per-user sync** takes an advisory lock in a namespace disjoint from the group-graph
  lock.
- **Checks that need a loaded row** run *inside* the transaction and are passed the
  transaction handle explicitly, so a handler holding one pooled connection never checks
  out a second for the lifetime of a query running while the first is held.

### Defect classes this project has actually hit

Each shipped at least once and was caught late. Worth probing for recurrences.

1. **Fail-open lookups.** `ROLE_RANK[unknown]` → `undefined` → `NaN` → every comparison
   false → the guard never threw. Also a status *deny-list* that let `pending` — the
   default status — through.
2. **Prototype-chain bypasses.** `'constructor' in ROLE_RANK` is `true`, and
   `ROLE_RANK['constructor']` is a truthy inherited function, so `?? fallback` never
   fired. **Hit four times.** Every catalog indexed by a database-sourced value is now
   `Object.create(null)` with `Object.hasOwn`.
3. **Vacuous tests.** A decorator-metadata test that passed with the plugin removed; a
   "no credential is set" assertion that was vacuous because the target never echoes
   credentials anyway.
4. **Catalog drift.** A hand-copied literal list of connector targets left five
   consumers stale, so a live outbound integration could not be listed, configured,
   enabled or *disabled* through the API. The array is now the single source and the
   union derives from it, asserted in both directions against the pgEnum.
5. **Type assertions that assert nothing.** `Object.assign(Object.create(null), {...}) as
   Record<K, V>` — `Object.create`'s return type is `any`, so the `as` succeeded
   unconditionally and a typo'd action, a dropped role and a wrong-typed rank all
   compiled clean. Fixed with `satisfies` on the literal.

## Recently closed findings

Kept here rather than deleted. A closed finding that still explains the original
defect is how the next person avoids reintroducing it.

### ReDoS in the attribute validator — closed by `6b75107`

**What it was.** `attribute-validator.ts` called `new RegExp(rules.pattern)` on a
pattern read straight out of `attribute_definitions.validation_rules` — admin-authored
jsonb — and executed it against user input. A regex is a program, so this was the
system running admin-supplied code against its own directory. **Re-measured** against
the pre-fix code while fixing it (`6b75107`): `^(a+)+$` blocked the event loop for
**12.5 seconds** on a 28-character input. The **96.7 seconds at 33 characters** quoted
throughout this document is the *original audit's* figure, carried forward and not
re-measured here; cost doubles per added character, so the two sit on the same curve.
One Node process serves the whole API and drains the outbox, so either number is a total
outage, not a slow request.

**What closed it.** `6b75107` — *fix(security): close the attribute-validator ReDoS with
a closed vocabulary*. Caller-supplied regex is gone entirely, replaced by
`validationRules.format`: a closed vocabulary of named validators written as static
literals in `apps/api/src/attributes/attribute-formats.ts`, each backtracking-free by
construction. RE2 bindings, static rejection of catastrophic constructs, and a
worker-per-match were each considered and rejected in that commit message.

**What the code does now** (`apps/api/src/attributes/attribute-validator.ts`, lines
117-140). A definition row still carrying `pattern` **fails closed and loudly**: it
throws an `AttributeValidationError` naming the key and the replacement vocabulary,
mapping to a 400. It is never silently ignored — ignoring it would drop a constraint an
admin deliberately set, which is a fail-*open* weakening dressed up as a security fix.
An unrecognised `format` fails closed for the same reason. The format catalog is
null-prototype and indexed with `Object.hasOwn` (defect class 2 above).

`new RegExp` is now absent from `apps/api/src/` altogether, which a static source scan
asserts — a stronger guarantee than "we checked the pattern was safe". The scan strips
comments first, so the two files that explain at length why the constructor is gone do
not trip it.

**This therefore no longer gates the `attribute_definitions` write path.** The previous
entry made adding that write path conditional on the ReDoS being fixed; it is fixed. The
write path is still absent — `attributes/attribute-definitions.controller.ts` exposes a
single `@Get()` and nothing else — but that is now a feature gap, not a security hold.

### CS-M2, no Content-Security-Policy — closed 2026-08-10 by `02c0aa0`

**What it was.** There was no Content-Security-Policy anywhere on the console, while the
access *and* refresh token live in `sessionStorage`. One script injection anywhere became
total admin session theft with nothing in the way.

**What closed it.** `02c0aa0` — *feat(web): serve a Content-Security-Policy with a
build-derived script hash*, shipped 2026-08-10 and live on the deployment. The policy is
generated from the **built** `dist/index.html` on every build by the vite plugin in
`apps/web/vite.config.ts` (the reasoning lives in `apps/web/scripts/csp.mjs`), written
next to it as `dist/csp.conf`, and `include`d by both nginx vhosts —
`deploy/nginx/idm.conf` and `deploy/nginx/idm-tls.conf` — at every level that declares
`add_header`, because nginx's `add_header` inheritance discards inherited headers the
moment a nested level declares one of its own. That inheritance rule is CS-M1, the same
trap, which is why the include is repeated rather than set once.

**The trap it caught, worth carrying forward.** The console's `index.html` carries an
inline pre-paint theme script that must run before any bundled JS exists, so it needs a
`sha256` hash source. The HTML parser **normalises every CRLF and every lone CR to a
single LF** while preprocessing the input stream, before any element's text content
exists — and CSP hashes the script's *source text*, i.e. the post-parse text. Hashing the
raw bytes of a Windows checkout, where git checks `index.html` out with CRLF, therefore
yields a hash that matches nothing and blocks the very script it was written for:
observed here as `sha256-yH5Rqspb…` computed while Chromium demanded `sha256-0pH0FSFd…`,
producing a blank console shell. On the Linux deploy host the file is already LF, so the
mistake would have been **invisible there and fatal on every Windows-built artifact**.
`scriptSourceText()` in `csp.mjs` normalises before hashing, which is what makes both
platforms agree with the browser and with each other. The hash is derived on every build
and never written by hand, so it cannot go stale either.

CS-M2's *other* half is unchanged and deliberate: the tokens still live in
`sessionStorage` (`apps/web/src/auth/oidc-config.ts`, which pins `stateStore` there too
per finding SEC-L1, and now sets `revokeTokensOnSignout: true`). The CSP is what closed
the exploitability gap, not a change of storage.

### `POST /users/:id/activate` — shipped `803bcf9`, 2026-08-08

Previously listed as absent. It exists: `apps/api/src/users/users.controller.ts:938`,
gated on the `user:activate` action. It deliberately does *not* pre-check
`current.status` (`changeStatus` decides transition legality in one atomic conditional
UPDATE, so a pre-check would be a second, racy authority on the same question), does
*not* call Keycloak inline (unlike `deactivate`, where a live session on a deactivated
user cannot wait for the outbox), and does *not* fire `start_date_reached` JML rules —
that remains `LifecycleJob`'s job, not a hand-click's.

## Known open items

Verify these still hold before looking elsewhere. Each entry states what was checked to
confirm it is still open.

- **`manage-clients` is realm-wide, and the mitigation is application-level.**
  Registering SSO applications requires `manage-clients`, which Keycloak does not scope
  to "clients this principal created". A compromise of the `idm-sso-admin` credential
  could therefore rewrite `idm-console`'s own `redirectUris` and harvest authorization
  codes for the admin console itself. Two things reduce the blast radius and neither
  eliminates it: the credential is separate from `idm-sync-service` (so the user and
  group sync path does not hold the capability at all), and a reserved-client denylist
  in `sso-apps/sso-app-validation.ts` refuses to register over `idm-console`,
  `idm-api`, `idm-sync-service`, `idm-sso-admin` or Keycloak's own built-ins, with a
  source scan asserting the list still names every client `keycloak-setup.sh` creates.
  **That denylist is a guard in application code and is strictly weaker than the
  structural boundaries elsewhere in this document.** The runtime database role cannot
  violate append-only no matter what code runs; this list holds only as long as the
  code consulting it is correct. Treat it as an open risk, not a solved problem.
  Still true as written: `RESERVED_CLIENT_IDS` in
  `apps/api/src/sso-apps/sso-app-validation.ts:36` names all four clients plus
  Keycloak's built-ins, is applied case-insensitively to both a `clientId` (line 57) and
  a SAML `entityId` (line 155), and `apps/api/test/sso-app-validation.spec.ts` carries
  the source scan. The Keycloak-side half — that `manage-clients` cannot be scoped to
  "clients this principal created" — is a property of Keycloak, not of this repository,
  and is carried forward from the 2026-08-08 audit rather than independently
  re-verified here.

- **Principal resolution uses `username`**, deliberately, rather than
  `external_identities`. A username change is an identity change. Still true:
  `JwtGuard` hands `preferred_username` downstream (`auth/jwt.guard.ts`, lines 78-116)
  and `PermissionEngine.resolveActor` resolves it with
  `lower(users.username) = lower($1)` (`authz/permission.engine.ts:66`), failing closed
  on `status <> 'active'` (line 73).
- **Nothing in the application ever sets `suspended`.** There is no suspend route, and
  `PATCH /users/:id` does not accept `status` at all — its `.strict()` body schema has no
  such key (`users/users.controller.ts`, `updateUserBodySchema`). Nor does any background
  path reach it: `UsersRepository.changeStatus` (`users/users.repository.ts:464`) is the
  only writer of `users.status`, and every one of its seven callers passes `active` or
  `deactivated` — `lifecycle.job.ts:154`/`:223`, `rule-applier.ts:226`,
  `bulk-activate.job.ts:122`, `users.controller.ts:973`/`:1046`,
  `bootstrap-admin.ts:156`. There is no JML `suspend` action. `active → suspended` is a
  legal edge in `ALLOWED_TRANSITIONS` (`users/users.repository.ts:97`) with **no code
  path that reaches it**, so today `suspended` is attainable only by direct SQL. Do not
  plan compromised-account response around it: `deactivate` is the only mechanism the
  application actually offers, and it is terminal. (`activate` and `deactivate` *do*
  exist as routes; this entry previously claimed there was no activate endpoint either,
  which was wrong — see [Recently closed findings](#recently-closed-findings).)
- **Group-rename fan-out re-syncs only *current* effective members**; reconciliation is
  the backstop. Still true, and documented as a known limit in the code:
  `outbox/sync.worker.ts`, lines 1102-1140 — a user removed from the group in the same
  window, before the event is processed, is not fanned out to, because nothing records
  who was a member *before* the removal. `ReconciliationJob` is the general backstop for
  both that and the read-model side.
- **`PATCH /self` merges** rather than replacing, diverging from the admin convention.
  Deliberate — it prevents a self-service edit erasing admin-set attributes. Still true:
  `self-service/self-service.controller.ts`, lines 342-394.
- **The self-editable core allow-list is only `location`.** `firstName`, `lastName` and
  `jobTitle` were deliberately excluded as an impersonation surface. Still true:
  `SELF_EDITABLE_CORE_FIELDS = ['location']`, `self-service/self-service.controller.ts:48`.
- **The JML `deactivate` action performs synchronous Keycloak revocation.** Still true:
  `jml/rule-applier.ts:262` calls `revokeKeycloakAccessBestEffort` once the transaction
  has committed, matching `UsersController.deactivate`'s contract.
- **System-actor writes bypass `PermissionEngine`, and one such path IS user-facing.**
  Jobs that run as the system actor (`LifecycleJob`, `RuleApplier`,
  `ReconciliationJob.enqueueRepair`, `SyncWorker`) write with `actorUserId` null and no
  principal, so no permission check applies to them. This was previously documented as
  "confirm this cannot be induced from a user-facing path"; that confirmation no longer
  holds. `POST /connector-targets/:target/reconcile` calls
  `TargetReconciliationJob.reconcile` straight from an HTTP handler, and that job walks
  the whole directory with `scopePaths: null`, writing `external_identities` /
  `user_target_accounts` and pushing state to a real target for every principal — none of
  those per-entity writes individually permission-checked, scope-narrowed or outboxed.
  What bounds it is authorization, not unreachability: `requireGlobalManageGrant`
  (`connectors/connector-targets.controller.ts`) requires a **global** grant of
  `connector:manage`, which the static catalog gives to `super_admin` alone, so a scoped
  actor cannot use it to reach outside their subtree. The invocation and any
  blast-radius override are both audited against the calling user
  (`connector_target:reconcile` and `connector:reconcile-override`). **Still open:** the
  individual writes that reconcile performs are not, so constraint 7 ("every mutation is
  permission-checked, scope-narrowed, audited and outboxed in one transaction") does not
  hold for this route. The same is true, less dramatically, of
  `PATCH /connector-targets/:target` and the `attribute-target-mappings` routes, which
  audit but never outbox. Re-verified: `requireGlobalManageGrant` and the
  `@Post(':target/reconcile')` handler are at
  `apps/api/src/connectors/connector-targets.controller.ts` lines 221 and 347-389, and
  the handler's own doc comment states the same gap in the same terms. (Finding
  CAR-system-actor,
  [`archive/audits/carried-findings-verification.md`](archive/audits/carried-findings-verification.md).)
- **`user_created` / `user_attribute_changed` JML triggers exist but nothing auto-fires
  them.** Still true: both are in the `jml_trigger` pgEnum (`db/schema/jml-rules.ts`,
  lines 25-26) and in `rule-engine.ts`'s union, but the only caller of `matchRules` is
  `LifecycleJob.fireTriggerRules`, whose trigger parameter is typed literally
  `'start_date_reached' | 'end_date_reached'` (`jml/lifecycle.job.ts:279`). No other
  dispatch site exists in `apps/api/src`.
- **Bulk import references org units and managers by UUID**, not by name. Still true:
  `imports/import-row.ts`, lines 71 and 73 — both parsed with `.uuid('must be a UUID')`.
- **`GET /me` returns 200 for a non-active principal** — documented as safe rather than
  fixed, because it echoes only claims the caller's own token already contains. Still
  true, and stated as such in the handler's own doc comment (`auth/me.controller.ts`,
  lines 5-38): `/me` is a pure JWT-claims echo and explicitly not a session-validity
  check. `GET /self` is the route that resolves through `resolveActor` and fails closed.

## Why `bootstrap:admin` is not a backdoor

It grants global `super_admin` while bypassing all four privilege checks, deliberately.

- It is a **local operator script**, not an HTTP route, and it is not wired into the
  Nest application at all. Nothing makes it reachable over the network.
- Anyone able to run it already holds `RUNTIME_DATABASE_URL`, or a shell on the box that
  has it — which is already enough to read and write every row in the directory
  directly. Granting `super_admin` through the application's own repositories adds no
  capability beyond what that access already implies.
- It exists because a fresh install otherwise has **no way to grant its first role at
  all**: every grant path the API exposes requires the grantor to already hold
  `role:assign`, which nobody does on an empty database.

## Supply chain

Finding CS-H1 was the highest-leverage exposure in this system: a malicious
`postinstall` in any of ~460 packages ran as the `idm` service account, on the
machine holding `RUNTIME_DATABASE_URL`, `KEYCLOAK_ADMIN_CLIENT_SECRET` and every
`CONNECTOR_*` secret — reached on a schedule (every install and upgrade) rather
than by finding a flaw. Two changes close it:

**Dependency lifecycle scripts are blocked by an allow-list.** `package.json`
carries `pnpm.onlyBuiltDependencies`, and only what is listed there may run a
`preinstall`/`install`/`postinstall`. Everything else is installed as inert
files. The list is deliberately tiny:

| Package | Why it must build |
|---|---|
| `esbuild` | Resolves and links its platform binary; Vite and tsx cannot run without it. |

`cpu-features` is the only package this blocks in practice — it is an optional
native accelerator for `ssh2`, itself a Testcontainers dependency. It already
failed to build on any host without a C++ toolchain and nothing depended on it;
the full API suite and the Playwright suite both pass with it absent.

The audit assumed this needed pnpm 10's `onlyBuiltDependencies`. It does not —
pnpm 9 supports the same field, so no package-manager upgrade was required.

**To add a package to the allow-list**, verify it genuinely fails without its
script rather than assuming: run `pnpm install --frozen-lockfile` and read the
"dependencies have build scripts that were ignored" line, then confirm the build
and test suite actually break. A package added on suspicion re-opens the hole
for that package permanently.

**Node is installed from a signed apt repository, not a piped script.**
`install.sh` used to run `curl … /setup_20.x | bash -` as root, with output to
`/dev/null` so an operator saw nothing of what ran (finding CS-M4). It now adds
NodeSource's GPG key to `/etc/apt/keyrings/` and writes a `deb [signed-by=…]`
source directly — NodeSource's own documented alternative — so apt verifies
every package and no remote code executes as root. The *packages* were always
verified; it was the bootstrap script that was not, and it ran first.

**The package manager itself is pinned by digest.** `packageManager` carries
`pnpm@9.12.0+sha512.…`, and `scripts/install.sh` runs
`corepack prepare pnpm@9.12.0` rather than the `pnpm@9` range it used to. A
range resolved to whatever the newest 9.x was that day, fetched with no
integrity check, into a root shell. Corepack verifies the digest; CI inherits it
because `pnpm/action-setup` reads the same field. **Bump both together** or
corepack fails with a hash mismatch — which is the intended failure.

**The digest must be HEX, not the registry's base64.** npm publishes integrity
as `sha512-<base64>`; corepack's `packageManager` field wants
`+sha512.<128 hex chars>` and rejects anything else with *"Invalid package
manager specification … expected a semver version"* — a message that names the
wrong thing entirely and sends you looking at the version number. This was got
wrong once here and only surfaced when installing on a real host; a local
install with pnpm already activated did not re-validate the field. Produce the
value with `sha512sum` on the published tarball, and prove it is the same
artefact by converting hex to base64 and comparing against the registry
integrity.

## Hardening checklist for a real deployment

- [ ] TLS on **both** the console and Keycloak. Without it, sign-in silently fails.
- [ ] Do **not** import `keycloak/realm-import/identity-manager-realm.dev.json`. Use
      `keycloak-setup.sh`. That file is hardened against the accident — `.dev.json`
      suffix, `sslRequired: "external"`, `idm-test-client` imported disabled (SEC-L5) —
      but it still carries a real, published password for `admin@example.com` and a
      published `idm-sync-service` secret, which no rename can fix.
- [ ] If a realm was ever created from that file, confirm `idm-test-client` is absent or
      disabled: `pnpm smoke:dev` and the test harness enable it deliberately and the
      smoke script restores it, but a crashed run can leave it on.
- [ ] Confirm `idm-sync-service` holds exactly four `realm-management` roles.
- [ ] Confirm `RUNTIME_DATABASE_URL` is set and is a *different* role from
      `DATABASE_URL`. Verify `idm_app` has only `SELECT`/`INSERT` on `audit_log`.
- [ ] `.env` is mode 0640, owned by the service user.
- [ ] The API's own port is firewalled; only nginx reaches it.
- [ ] `allowInsecureTls` is **off** on every connector target.
- [ ] Every connector secret name starts with `CONNECTOR_`.
- [ ] `NODE_EXTRA_CA_CERTS` for a self-signed Keycloak — **never**
      `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- [ ] Exactly one instance has `SYNC_WORKER_ENABLED=true`.
- [ ] Dead letters and connector health are monitored.
- [ ] Postgres backups run, and a restore has actually been tested — followed by
      `db:migrate` to re-assert runtime grants.

## Reporting a problem

There is no published security contact for this project. Treat findings as you would for
any internal system: route them to whoever operates the deployment before disclosing
them anywhere else.
