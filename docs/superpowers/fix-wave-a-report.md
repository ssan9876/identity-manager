# Fix Wave A — C1 (CRITICAL): connection-pool exhaustion deadlock

Branch: `fix/audit-critical-pool-exhaustion`, from `master` at `91aa5b9`.
Fixes finding **C1** from `docs/superpowers/audit-integrity.md` only — the
single CRITICAL finding from the integrity/concurrency/availability audit.
No other finding (H1–H4, M1–M7, L1–L2) is touched in this pass.

## The finding, restated

`createDbClient` built a `pg.Pool` with defaults: `max: 10`,
`connectionTimeoutMillis` unset. Several write handlers opened
`db.transaction(async (tx) => …)` (one pooled connection for the whole
callback) and then, *inside* that callback, called `PermissionEngine`/
`PrivilegeGuards` methods that queried `this.db` — the **pool**, not `tx`.
Every in-flight write therefore held 2 connections instead of 1. At 10
concurrent `PATCH /users/:id`, the pool's 10 connections were exactly used
up by the transactions themselves; an 11th request's *second* connection
request had nothing left to wait for, and with no `connectionTimeoutMillis`
it waited forever — 10 sessions `idle in transaction` forever, the process
never recovering.

## The fix

**Part 1 — thread the transaction handle through the authorization layer.**
`PermissionEngine.canIn`/`assertCanIn` and `PrivilegeGuards.assertCanAssignRole`/
`assertCanModifyPrincipal` now take an **optional trailing `db` handle**,
defaulting to the injected pooled connection — the exact convention already
used by every repository's write methods (`UsersRepository.create`,
`GroupsRepository.create`, etc.: `db: NodePgDatabase<typeof schema> = this.db`).
This was the smallest change that fit the codebase's own established
pattern; see "Design note" below for why a more invasive redesign was not
attempted. Every write handler that calls these from inside an open
transaction now passes its `tx` explicitly:

- `UsersController.update` / `.deactivate` — `assertCanIn` + `assertCanModifyPrincipal`
- `GroupsController`'s five write handlers, all via the shared `requireGroup`
  helper — this was the exact bug the audit reproduced through this method
  ("loads the row on `tx` but then calls `engine.assertCanIn` on the pool")
- `RoleAssignmentsController.revoke` — `assertCanAssignRole` + `assertCanModifyPrincipal`

`scopePathsFor` was deliberately left unchanged: it performs no database
query at all (pure in-memory reduction over `actor.assignments`), so there
is nothing for it to redirect onto `tx` — confirmed by reading the method,
not assumed.

**Same shape, same fix, for `SyncWorker`** (explicitly named in the audit as
"Also affected" — `SYNC_WORKER_ENABLED` defaults to `true`, so this runs
continuously in every real deployment): `UsersRepository.listActiveAttributeDefinitions`
and `GroupsRepository.listEffectiveGroupsForUser`/`listByIds`/`listEffectiveUserMembers`
gained the same optional trailing `db` parameter, and `SyncWorker.reconcileUser`/
`syncEffectiveGroups`/`reconcileGroup`/`reconcileMembership` now thread their
open claim/nested transaction through instead of defaulting to the pool.
`GroupsRepository.listActiveAttributeDefinitions` (the group-scoped sibling)
was left untouched — every call site is before its caller's transaction
opens, never inside one.

**Part 2 — fail fast instead of hanging.** `createDbClient(databaseUrl, options?)`
now sets `connectionTimeoutMillis` (default 5s, overridable) so a genuinely
exhausted pool rejects with `Error: timeout exceeded when trying to connect`
instead of queuing forever; that error is uncaught and becomes a 500 via
Nest's default handler (`DomainExceptionFilter` only catches `DomainError`,
so "a bug/outage must look like a bug/outage" — no new mapping needed).
`max` is now configurable via a new `DB_POOL_MAX` env var (`loadEnv`,
`.env.example`; defaults to 10, i.e. pg's own default — a no-op for every
existing deployment that hasn't set it). All four `createDbClient` call
sites (`app.module.ts`'s `DB_CLIENT` provider, `migrate-cli.ts`,
`reconcile-cli.ts`, `lifecycle-cli.ts`) now pass `{ max: env.dbPoolMax }`.

**Design note — why "optional trailing default" rather than a required
parameter or a narrowed type.** The task allowed either; a required
parameter (forcing every call site, including read-only ones, to state its
handle explicitly) was considered but rejected: `canIn`/`assertCanIn` are
legitimately called both inside transactions (the buggy case) and outside
them (`UsersController.findOne`, `.list`, and the pre-transaction checks in
`.create`/`RoleAssignmentsController.assign` — see their own doc comments
on why the check runs before `db.transaction` opens). A narrowed type like
`AuditWriter`/`OutboxWriter`'s `DbHandle` (which rejects the pool entirely)
doesn't fit for the same reason — those two are *always* called inside a
transaction by design; these are not. Widening to the existing
optional-default convention kept the change mechanical, low-risk, and
consistent with three existing repositories, and every outside-transaction
call site required zero changes. A static lint/test guard ("fails when a
`db.transaction` callback reaches a collaborator holding `DB_CLIENT`") was
in the audit's fix directions but is a separate, more invasive mechanism
(type-aware ESLint rule or AST walk) not attempted here — flagged as a
reasonable follow-up, not required by this task's Part 1/Part 2/PROVE IT
scope.

## Files changed

Source: `apps/api/src/db/client.ts`, `apps/api/src/config/env.ts`,
`.env.example`, `apps/api/src/app.module.ts`, `apps/api/src/db/migrate-cli.ts`,
`apps/api/src/outbox/reconcile-cli.ts`, `apps/api/src/jml/lifecycle-cli.ts`,
`apps/api/src/authz/permission.engine.ts`, `apps/api/src/authz/privilege.guards.ts`,
`apps/api/src/users/users.controller.ts`, `apps/api/src/users/users.repository.ts`,
`apps/api/src/groups/groups.controller.ts`, `apps/api/src/groups/groups.repository.ts`,
`apps/api/src/authz/role-assignments.controller.ts`, `apps/api/src/outbox/sync.worker.ts`.

Tests: `apps/api/test/pool-exhaustion.spec.ts` (new), `apps/api/test/db-client.spec.ts`
(new), `apps/api/test/support/pg.ts` (exposes `connectionUri` so a test can
open a second, independent `createDbClient` pool against the same
throwaway container), `apps/api/test/env.spec.ts` (updated for the new
`dbPoolMax` field + `DB_POOL_MAX` coverage).

## Regression coverage

`test/pool-exhaustion.spec.ts` builds the Nest app's `DB_CLIENT` from the
**real** `createDbClient` (not the test harness's own ad-hoc pool) bound to
a throwaway Postgres container, so the app under test has production pool
behaviour end to end.

1. **20 concurrent `PATCH /users/:id` against a pool of 10** — fires all 20
   via `Promise.all`, asserts every status is `200`, hard 30s test timeout.
   Also asserts peak concurrent pool checkouts stays `<= 10` (structurally
   guaranteed by `pg-pool` regardless, kept as documentation of the
   invariant).
2. **Direct measurement of one write's connection count** — replicates
   `UsersController.update`'s transaction body directly (below the HTTP
   layer, deliberately) and asserts the peak concurrent pool checkouts
   during that transaction is exactly `1`. Measured via `pool.on('acquire'
   /'release', …)`, not `pg_stat_activity` polling — deterministic, no race:
   every `pool.query()` and every `db.transaction()` goes through exactly
   one connect/release pair (confirmed by reading the installed
   `pg-pool`/`drizzle-orm` node-postgres driver source directly, not
   assumed). The HTTP-level route was deliberately NOT used for this
   assertion: a full request also calls `SyncStateRepository.resolveForUser`
   *after* the transaction commits, which correctly and safely fires 4
   concurrent reads against the pool via `Promise.all` — conflating that
   with the transaction would make a clean "1" assertion impossible even on
   fixed code (confirmed: it measured `4` before this was isolated below the
   HTTP layer).

`test/db-client.spec.ts` pins `createDbClient`'s option wiring directly
(`pool.options.connectionTimeoutMillis`/`.max`), no live Postgres needed.

### Counterfactual (Part 1 reverted, Part 2 kept)

`git stash push` on exactly the Part 1 files (`permission.engine.ts`,
`privilege.guards.ts`, the three controllers, `sync.worker.ts`, both
repositories), test run, `git stash pop` to restore.

**Reverted — both new tests fail, in ~10s (not a hang, thanks to Part 2):**

```
 ❯ test/pool-exhaustion.spec.ts (2 tests | 2 failed) 9930ms
   × 20 concurrent PATCH /users/:id all complete against a pool of 10 (none hang, none 5xx) 3150ms
     → expected [ 500, 500, 500, 500, 500, 500, …(14) ] to deeply equal [ 200, 200, 200, 200, 200, 200, …(14) ]
   × a single in-transaction write ... checks out exactly ONE connection, never two 48ms
     → expected 2 to be 1 // Object.is equality
```

The captured stack trace for the 500s shows the exact mechanism:
`Error: timeout exceeded when trying to connect` (pg-pool) raised from
`PermissionEngine.canIn` (`permission.engine.ts:165`), called from
`PermissionEngine.assertCanIn` (`:178`), called from
`UsersController.update` (`users.controller.ts:313`) — i.e. the
authorization check re-entering the pool from inside the open transaction,
exactly as diagnosed. The single-connection test measured `peakConcurrent
=== 2` on the reverted code — the exact "2 connections per write" the
audit describes, directly measured, not inferred.

Also confirms Part 2 in isolation: with Part 1 reverted but Part 2 intact,
exhaustion now fails in ~3–9s with clear `500`s instead of hanging forever
— Part 2 alone does not make concurrent writes succeed, only fail safely;
Part 1 is what's required for correctness.

**Restored — clean:**

```
 ✓ test/env.spec.ts (15 tests) 6ms
 ✓ test/db-client.spec.ts (4 tests) 3ms
 ✓ test/pool-exhaustion.spec.ts (2 tests) 6998ms

 Test Files  3 passed (3)
      Tests  21 passed (21)
```

## Verification

- `pnpm --filter @idm/api test` (root): **48 files, 564 tests passed**
  (554 baseline + 10 new: 2 in `pool-exhaustion.spec.ts`, 4 in
  `db-client.spec.ts`, 4 new `DB_POOL_MAX` cases in `env.spec.ts`). Exit 0.
- `pnpm --filter @idm/api build`: exit 0.
- `pnpm --filter @idm/api db:generate`: `No schema changes, nothing to
  migrate` — confirmed no new migration file appears in `git status`.
- `pnpm --filter @idm/api smoke:dev`: green (`GET /users` -> 200,
  `GET /groups` -> 200).
- **Live**: booted the real dev server (`pnpm run start:dev`), minted a
  real token from the running dev Keycloak (`idm-test-client` direct grant,
  `admin@example.com` / `dev_password_change_me`), created 20 fresh target
  users, fired 20 concurrent `PATCH /users/:id`:
  `statuses = 20 × 200, completed in 66ms`. Shut down cleanly; port 3000
  confirmed free afterward (also independently re-checked after the script
  exited). The 20 throwaway users and their outbox events were removed
  directly from Postgres afterward (no `DELETE /users` route exists, by
  design — see `UsersRepository.changeStatus`'s doc comment); confirmed no
  `external_identities` rows or Keycloak accounts had been created for them
  first (`SyncWorker` hadn't reached them before shutdown), so the cleanup
  was a plain, side-effect-free delete.
- Compose stack (`identity-manager-postgres-1`, `identity-manager-keycloak-1`)
  left running throughout, untouched, healthy.
- Working tree clean after commit (verified via `git status`).

## Concerns / follow-ups (not fixed here, out of this pass's scope)

- The audit's fix direction #3 (a lint/test that fails when a
  `db.transaction` callback reaches a collaborator holding `DB_CLIENT`) was
  not implemented — it's a genuinely separate, more invasive mechanism
  (type-aware static analysis), not required by this task's Part 1/Part
  2/PROVE IT scope, and risked exceeding "don't rewrite half the codebase."
  Worth a follow-up pass.
- H1–H4, M1–M7, L1–L2 from the same audit are untouched, as instructed —
  this pass is C1 only.
- `DB_POOL_MAX` defaults to 10 everywhere unless explicitly set; no
  deployment's behavior changes unless someone opts in.
