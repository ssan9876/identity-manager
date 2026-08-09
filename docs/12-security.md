# 12 — Security model

> ## Current status
>
> **The adversarial security audit for this build is incomplete.**
>
> Four dimensions ran — authentication/authorization, injection, integrity/concurrency,
> and secrets — and their findings were fixed across five waves. But two planned
> dimensions never ran, and roughly twenty findings remain unverified.
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
12. **Single tenant.** There is no `tenant_id` anywhere.

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
| `IMPORT_MAX_ROWS` | 5,000 | Import commit is ~10 ms of serial work per row; this bounds request duration independently of body size. Checked before any row is resolved. |
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

## Known open items

Verify these still hold before looking elsewhere.

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

- **ReDoS in the attribute validator.** `new RegExp(rules.pattern)` compiles an
  unvalidated database-sourced pattern. Measured: `^(a+)+$` blocked the event loop for
  **96.7 seconds** on a 33-character input. Currently unreachable because
  `attribute_definitions` has no write path — **confirm that is still true** before
  adding one.
- **Principal resolution uses `username`**, deliberately, rather than
  `external_identities`. A username change is an identity change.
- **No suspend/activate HTTP endpoint** — status transitions come from lifecycle
  automation and deactivation only.
- **Group-rename fan-out re-syncs only *current* effective members**; reconciliation is
  the backstop.
- **`PATCH /self` merges** rather than replacing, diverging from the admin convention.
  Deliberate — it prevents a self-service edit erasing admin-set attributes.
- **The self-editable core allow-list is only `location`.** `firstName`, `lastName` and
  `jobTitle` were deliberately excluded as an impersonation surface.
- **The JML `deactivate` action performs synchronous Keycloak revocation.**
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
  audit but never outbox. (Finding CAR-system-actor,
  `docs/archive/audits/carried-findings-verification.md`.)
- **`user_created` / `user_attribute_changed` JML triggers exist but nothing auto-fires
  them.**
- **Bulk import references org units and managers by UUID**, not by name.
- **`GET /me` returns 200 for a non-active principal** — documented as safe rather than
  fixed, because it echoes only claims the caller's own token already contains.

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
