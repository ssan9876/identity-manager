# Fix Wave D — INTEGRITY / CONCURRENCY findings

Branch: `fix/audit-critical-pool-exhaustion`, continuing from `c8fb15c` (Wave A —
pool-exhaustion deadlock), `19ee90a` (Wave B — authorization scope checks), and
`abefeca` (Wave C — prototype elision, NUL handling, enumeration oracle). Fixes
every HIGH and MEDIUM finding from `docs/superpowers/audit-integrity.md`, plus
three cheap items. Every query added inside an already-open transaction threads
`tx`, never the pool — the Wave A discipline holds throughout, and this wave's
own H2 fix extends it with a per-user advisory lock for the one race
transaction-threading alone cannot close.

## Summary of fixes

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | HIGH | H2 — two sync workers silently diverge Postgres/Keycloak | Per-user `pg_advisory_xact_lock` at the top of `SyncWorker.reconcileUser`, serializing all three aggregate types on the entity they actually mutate |
| 2 | HIGH | H4 — `PATCH /self` / JML `set_attribute` lost update | New `UsersRepository.findByIdForUpdate` (`SELECT ... FOR UPDATE`), used by both read-merge-write sites |
| 3 | HIGH | H3 — dead-lettered removal invisible; no dead-letter view | `SyncStateRepository` now folds `payload.userId`/`childGroupId` into the affected set; new `GET /outbox/dead-letters`, gated by `audit:read` |
| 4 | MEDIUM | M5 — never-onboarded leaver never deactivated | `pending → deactivated` added to the transition matrix; `LifecycleJob` now reports skips instead of only logging them |
| 5 | MEDIUM | M2 — reconciliation writes zero audit rows | `ReconciliationJob.enqueueRepair` now writes an `actorUserId: null` audit row in the same transaction as the outbox event |
| 6 | MEDIUM | M6 — bulk import has no size/row cap | New `IMPORT_MAX_ROWS` (clean 400) and `BODY_LIMIT_BYTES` (explicit `useBodyParser`, replacing express's accidental 100 KiB default) |
| 7 | cheap | M1 — `displayName` desync | Same `findByIdForUpdate` fix reused inside `UsersRepository.update` |
| 8 | cheap | M4 — import re-run writes no-op audit/outbox rows | `isNoopUpdate` skips the write when the resolved `UpdateUserInput` already matches the current row |
| 9 | cheap | `resolveCreateRow` oracle residual | Email/username collision messages changed to non-confirming `"not available"` |

---

## 1 (HIGH) — H2: cross-aggregate races silently diverge Postgres and Keycloak

**Root cause.** `OutboxRepository.claimNext` only serializes per
`(aggregate_type, aggregate_id)`. A `user`, a `group`, and a `membership` event
for the *same user* are three different aggregate rows, so two workers can
`reconcileUser` the same person concurrently — whoever calls `setUserGroups`
last wins regardless of who read fresher data.

**Fix** (`apps/api/src/outbox/sync.worker.ts`): `reconcileUser`'s first action,
before any read, is now
`SELECT pg_advisory_xact_lock($SYNC_USER_LOCK_NAMESPACE, hashtext($userId::text))`.
The lock is taken via whatever handle the caller passed (frequently the nested
savepoint `runOnce` opens for `applyEvent`), but — confirmed against Postgres's
documented behaviour and already relied on by `GroupsRepository.
addChildGroup`'s `GROUP_GRAPH_LOCK_ID` — an xact-scoped advisory lock is tied
to the *outer* transaction regardless of savepoint nesting, so it is held for
the worker's entire claim, covering every Keycloak round trip, not just the
Postgres reads. A second worker touching the same user — whether fanned out
from `group`/`membership` or claimed directly as `user` — blocks until the
first's whole `runOnce()` transaction ends, then re-reads fresh (this method
never trusts a value read before the lock). The lock namespace's high 32 bits
are nonzero, keeping the resulting 64-bit key space disjoint from
`GROUP_GRAPH_LOCK_ID`'s single-bigint form.

**Tests** (`sync.worker.spec.ts`, new `describe('cross-aggregate races on the
same user (finding H2)')`): both of the auditor's directions, 20 iterations
each, against real Postgres + real Keycloak. A new `GatedKeycloakAdminClient`
test helper (subclasses the real client — required, since it carries private
fields no hand-rolled double could satisfy) lets the test deterministically
pause a "slow" worker's `ensureGroup`/`setUserGroups` calls exactly after its
stale read completes, signal a "reached" promise, let a second "fast" worker
fully process a conflicting change, then release — plus a small fixed handicap
after release so a genuinely un-gated concurrent worker has room to finish
first, mirroring the auditor's own "Keycloak at 120 ms/call" technique.
**ADD**: postgres and Keycloak agree on `{g1, g2}`. **REMOVE**: agree on
`{g1}`. Both 20/20.

---

## 2 (HIGH) — H4: `PATCH /self` / JML `set_attribute` lost update

**Root cause.** The doc comment claimed loading `current` "inside this same
transaction" made a stale read impossible; false under READ COMMITTED — a
plain `SELECT` takes no lock, so two concurrent merges can both read the same
snapshot and whichever commits last silently discards the other.

**Fix.** New `UsersRepository.findByIdForUpdate` (`SELECT ... FOR UPDATE`).
Under READ COMMITTED, a blocked `FOR UPDATE` unblocked by the blocker's commit
re-fetches the just-committed row, not the stale snapshot it originally
requested — that is what makes the merge atomic. Used by
`SelfServiceController.update` and `RuleApplier.applySetAttribute` (identical
shape, same fix). The false doc-comment claim is corrected in place.

**Tests**, three files:
- `self-service.spec.ts`: 30 concurrent `PATCH /self` on one user, each
  setting a different attribute — all 30 survive.
- `self-service.spec.ts` (new top-level describe, `stubJwtGuardByHeader` — a
  per-request `x-test-username` header, since two *different* actors racing
  truly concurrently can't share one closure variable): 30 iterations of 1
  admin write vs. 4 concurrent self-service writes on a fresh user each time —
  the admin's attribute is never lost. (A bare 2-way race did not reliably
  reproduce the bug — real scheduling could land either order on a single
  pair; widening to a 5-way fan-in on one row, mirroring why the self-vs-self
  test is reliable, made the pre-fix failure land on iteration 1 every time.)
- `jml-rule-applier.spec.ts`: 20 concurrent `set_attribute` applications for
  one user, each a different key — all 20 survive.

---

## 3 (HIGH) — H3: dead-lettered removal invisible; no operator view

**Root cause (read model).** `SyncStateRepository` derived the "who is
affected by this troubled group/membership event" set from *current*
effective membership. A user who was just *removed* is, by definition, no
longer in that set — so the removal's own dead letter surfaced against
nobody, while `external_identities` (never regressed by a fan-out failure —
see `SyncWorker.markUserSyncFailed`) still read `synced`.

**Fix** (`sync-state.repository.ts`): for `membership`-aggregate events,
additionally consults the event's own `payload.userId` (direct add/remove —
recorded by the controller *before* the edge is deleted) and
`payload.childGroupId` (nested — still walkable via current membership, since
the child itself is never removed by this edge change), mirroring
`SyncWorker.reconcileMembership`'s own affected-set computation exactly. Every
real emitter (`GroupsController` ×4, `RuleApplier` ×2) already populates one
of the two fields; confirmed by grep.

**Root cause (visibility).** No controller read `outbox_events` at all — the
derived per-user `syncState` was the only surface.

**Fix**: new `GET /outbox/dead-letters` (`outbox.controller.ts`), gated behind
`audit:read` (the `auditor` role) — read-only, paginated, `status = 'failed'`
rows newest-first. `OutboxRepository.listFailed`/`countFailed` added
(explicit pool handle, matching the class's existing "no silent pooled
default" convention).

**Tests**: `sync-state.repository.spec.ts` — a user removed from a group whose
removal event dead-letters now reads `failed`, not `synced`; a companion test
confirms the nested-child direction (already reachable pre-fix, via descent
from the parent) still works. `outbox.controller.spec.ts` (new file, 4 tests):
only `failed` rows surface, pagination is scoped to the failed count,
`auditor` succeeds, `read_only`/no-role both 403. `guard-coverage.spec.ts`
updated for the new controller.

---

## 4 (MEDIUM) — M5: never-onboarded leaver never deactivated

**Root cause.** `listNonDeactivatedWithEndDateOnOrBefore` deliberately selects
a `pending` leaver whose `end_date` passed, but `pending → deactivated` was
not in `ALLOWED_TRANSITIONS` — `changeStatus` threw on every run, forever,
caught and reduced to a `console.warn`.

**Fix**: `pending: ['active', 'deactivated']` in `users.repository.ts`.
`LifecycleJob.activateDueUsers`/`deactivateDueUsers` now return `{
transitioned, skipped }`; `LifecycleReport.skipped: LifecycleSkip[]` surfaces
anything a run could not action instead of only logging it; `lifecycle-cli.ts`
prints the list.

**Tests** (`jml-lifecycle.job.spec.ts`, `users.repository.spec.ts`): a
never-activated `pending` user with a past `end_date` is deactivated directly;
a healthy run reports `skipped: []`; a genuine race (`UsersRepository.
prototype.changeStatus` spied to throw for one specific user) is captured in
`skipped` rather than silently dropped; a direct repository-level
`pending → deactivated` transition test.

---

## 5 (MEDIUM) — M2: reconciliation writes zero audit rows

**Fix** (`reconciliation.job.ts`): `AuditWriter` threaded into the
constructor (and `reconcile-cli.ts`'s manual wiring). `detectDrift` now
returns the observed `KeycloakUser` alongside `reasons` so `enqueueRepair`
doesn't re-fetch it. `enqueueRepair` writes `actorUserId: null,
action: 'reconciliation:repair', before: <observed Keycloak state>,
after: {...desired, reasons}` in the *same* transaction as the outbox event —
the existing `LifecycleJob`/`RuleApplier` null-actor convention, extended to
the one system write path that hadn't adopted it.

**Tests** (`reconciliation.spec.ts`): reproduces the audit's own measured
scenario (a deactivated user re-enabled directly in Keycloak) and confirms
exactly one new audit row with the right shape; a companion test confirms no
row is written when there is no drift.

---

## 6 (MEDIUM) — M6: bulk import has no size/row-count cap

**Fix, two independent controls:**
- `IMPORT_MAX_ROWS` (env-configurable, default 5,000) — new `IMPORTS_CONFIG`
  DI token, checked in `ImportsController.parseAndPrepare` right after CSV
  parsing; over the cap is a clean `ValidationError` naming both the actual
  and allowed counts, before a single row is resolved.
- `BODY_LIMIT_BYTES` (env-configurable, default 10 MiB) — `main.ts` now boots
  with `bodyParser: false` and two explicit `useBodyParser` calls; registering
  a *second* parser without disabling the default first would never take
  effect (express's body-parser skips a body a prior middleware already
  consumed). New `payloadTooLargeMiddleware` (own file — `main.ts` cannot be
  imported by a test, since it self-executes `bootstrap()`) answers a
  too-large body with the same quiet, structured JSON shape
  `DomainExceptionFilter` gives every other rejection, instead of the
  "unhandled ExceptionsHandler ERROR" the audit flagged.

**Tests**: `env.spec.ts` (6 new), `payload-too-large.middleware.spec.ts` (new
file, 4 tests, pure unit — fake req/res/next), `imports.write.spec.ts` (new
describe block with its own small-`maxRows` module: over-cap commit and
preview both 400 with zero audit/outbox/user writes; at-cap succeeds).

---

## 7–9 (cheap items)

**M1 — `displayName` desync.** Same mechanism, same fix as H4:
`UsersRepository.update`'s internal `current` read (used to derive
`displayName` from whichever of `firstName`/`lastName` a patch didn't name)
switched to `findByIdForUpdate`. Covers every caller uniformly (admin PATCH,
bulk import, JML). Test: `users.write.spec.ts`, 30 iterations of concurrent
firstName-only / lastName-only PATCHes — `displayName` always reflects both.

**M4 — import re-run writes no-op audit/outbox rows.** New `isNoopUpdate` +
`attributesEqual` helpers in `imports.controller.ts`; `commit()`'s update
branch skips the transaction entirely (and increments a new `unchanged`
counter on `ImportCommitResponse`) when the resolved `UpdateUserInput` already
matches the current row field-for-field. The pre-existing "re-running the
identical file" test's assertions changed to match (was asserting the *old*,
now-fixed behaviour — `updated: 2` — the new correct value is `unchanged: 2`);
a new companion test pins the mixed case (one row genuinely changed, one
didn't → exactly one new audit/outbox pair).

**`resolveCreateRow` oracle residual.** `findByEmail`/`findByUsername` are
global, unscoped lookups; the row's own target org unit passing the scope
check does not mean the *colliding* existing user is in scope too. Collision
messages changed from `"a user with email \"X\" already exists"` to
`"primaryEmail: not available"` (and the username equivalent) — still
correctly rejects the row, no longer confirms a specific out-of-scope
victim's existence or echoes the guessed value back. Three new tests in
`imports.write.spec.ts` (email oracle, username oracle, commit still refuses
the write).

---

## Files changed

Source: `apps/api/src/outbox/sync.worker.ts`, `apps/api/src/outbox/
sync-state.repository.ts`, `apps/api/src/outbox/outbox.repository.ts`,
`apps/api/src/outbox/outbox.controller.ts` (new), `apps/api/src/outbox/
reconciliation.job.ts`, `apps/api/src/outbox/reconcile-cli.ts`,
`apps/api/src/users/users.repository.ts`, `apps/api/src/self-service/
self-service.controller.ts`, `apps/api/src/jml/rule-applier.ts`,
`apps/api/src/jml/lifecycle.job.ts`, `apps/api/src/jml/lifecycle-cli.ts`,
`apps/api/src/imports/imports.controller.ts`, `apps/api/src/config/env.ts`,
`apps/api/src/main.ts`, `apps/api/src/common/http/
payload-too-large.middleware.ts` (new), `apps/api/src/app.module.ts`.

Tests: `apps/api/test/sync.worker.spec.ts`, `sync-state.repository.spec.ts`,
`outbox.controller.spec.ts` (new), `self-service.spec.ts`,
`jml-rule-applier.spec.ts`, `jml-lifecycle.job.spec.ts`,
`users.repository.spec.ts`, `users.write.spec.ts`, `reconciliation.spec.ts`,
`imports.write.spec.ts`, `env.spec.ts`, `payload-too-large.middleware.spec.ts`
(new), `guard-coverage.spec.ts`.

No schema or migration changed — `db:generate` reports no pending changes.

## Existing tests that changed meaning, and why

- `imports.write.spec.ts`'s "re-running the identical file" test (M4): was
  asserting `updated: 2` on the second run, which was the bug (a full no-op
  rewrite every time). Now asserts `unchanged: 2, updated: 0`, plus that
  `audit_log`/`outbox_events` counts don't move.

## Counterfactual verification

Every fix disabled in place (never git-stashed, since several share a file
with an already-verified fix from earlier in this same wave), confirmed the
relevant new test failed for the *predicted* reason, then restored:

- **H2 lock**: commented out the `pg_advisory_xact_lock` call — both 20-
  iteration race tests failed on iteration 1 (`postgres={g1,g2}
  keycloak={g1}` for ADD; `postgres={g1} keycloak={g1,g2}` for REMOVE — the
  exact mismatches the audit measured).
- **H4 lock**: reverted `findByIdForUpdate` → `findById` in
  `SelfServiceController.update` — the 30-way self-vs-self test failed
  (`expected undefined to be 'value-1'`); the 5-way self-vs-admin test failed
  on iteration 1 (`expected 200 to be 200` — admin's attribute `undefined`).
  Same revert in `RuleApplier.applySetAttribute` — the 20-way JML test failed
  identically.
- **H3 read model**: reverted the `membership` branch to its old
  aggregate-id-only derivation — the direct-removal test failed
  (`expected 'synced' to be 'failed'`); the nested-child test correctly kept
  passing either way (confirming it tests a genuinely different code path).
- **H3 endpoint gate**: removed `@RequirePermission('audit:read')` — both
  positive tests failed with 403 (PermissionGuard defaults to deny with no
  declared permission) and `guard-coverage.spec.ts`'s own
  "declares a permission on every route" check failed independently,
  confirming defense in depth.
- **M5 transition matrix**: reverted `pending: ['active']` — the
  never-onboarded-leaver test failed (`expected [] to include <id>`), and,
  because this file accumulates fixtures across tests, the STUCK user then
  polluted the "healthy run reports empty skipped" test too — a live
  illustration of "skipped forever, every run."
- **M5 reporting**: removed the `skipped.push(...)` call alone (transition
  matrix left fixed) — the genuine-race test failed
  (`expected [] to deep equally contain {...}`).
- **M2 audit write**: disabled the `auditWriter.record` call in
  `enqueueRepair` — the new test failed (`expected +0 to be 1` audit rows),
  reproducing the audit's own T5 measurement exactly.
- **M6 row cap**: disabled the `rows.length > maxRows` check — both the
  commit and preview over-cap tests failed (`expected 400 to be 200`).
- **M6 middleware**: forced `isPayloadTooLarge = false` — both matching unit
  tests failed (`next()` was called instead of a clean 413).
- **M1 displayName**: reverted `findByIdForUpdate` → `findById` in
  `UsersRepository.update` — the 30-iteration test failed on iteration 1
  (`expected 'Test RaceLast1' to be 'RaceFirst1 RaceLast1'`).
- **M4 no-op skip**: short-circuited `isNoopUpdate` to always false — both
  the re-run and the mixed-change tests failed (`expected 2 to be 0`,
  `expected 2 to be 1`).
- **resolveCreateRow oracle**: reverted both messages to the old
  echoing/confirming text — all three new tests failed, showing the exact
  pre-fix leak (`"...already exists"`, echoing the guessed email/username).

All counterfactuals restored; `grep -rn "COUNTERFACTUAL-DISABLED"` across
`src/`/`test/` is empty. Full suite re-verified green after every restore.

## Verification

- `pnpm --filter @idm/api build`: exit 0.
- `pnpm --filter @idm/api test`: **50 files, 653 tests passed** (618 baseline
  + 35 new; 2 new files — `outbox.controller.spec.ts`,
  `payload-too-large.middleware.spec.ts`), run in full at the end (175s).
- `pnpm --filter @idm/api db:generate`: `No schema changes, nothing to
  migrate` — 11 tables listed, matches the pre-existing schema exactly.
- `pnpm --filter @idm/api smoke:dev`: green — real `start:dev` transform,
  real Keycloak token for `admin@example.com`, `GET /users` → 200 (12 items),
  `GET /groups` → 200 (5 items).
- **Live** (real dev server booted directly via `pnpm run start:dev`, real
  Keycloak-issued token, `SYNC_WORKER_ENABLED=true` as configured in `.env`):
  a throwaway script (deleted after, never committed) confirmed:
  - `GET /outbox/dead-letters` with no token → 401.
  - A dead-letter row inserted directly, then correctly returned (with its
    `lastError`) by `GET /outbox/dead-letters` using a real
    `admin@example.com` token (`super_admin` → `audit:read`); row deleted
    afterward, table left as found (2 pre-existing dead letters untouched).
  - `POST /imports/preview` with a real JSON body through the reconfigured
    body parser (`bodyParser: false` + `useBodyParser`) → 200, confirming the
    M6 body-parser rewiring doesn't break ordinary requests.
- Compose stack (`identity-manager-postgres-1`, `identity-manager-keycloak-1`)
  left running throughout, untouched — confirmed via `docker ps` before and
  after. Port 3000 confirmed free before the live-verification boot and again
  after killing its full process tree (cmd.exe → pnpm → node, all four
  descendants).
- Working tree clean except this wave's intended source/test diffs and this
  report (`git status`); the five other auditors' untracked files
  (`audit-authz.md`, `audit-injection.md`, `audit-integrity.md`,
  `audit-secrets.md`, `security-audit-input.md`) left alone, matching prior
  waves' hygiene convention.

## Requirements checklist

- Rejected mutations still write zero audit rows and zero outbox events:
  pinned directly for the two NEW rejection paths this wave adds (M6's
  row-cap check on both `commit`/`preview`) and unaffected everywhere else —
  no existing "writes nothing on rejection" test needed to change.
- Regression tests reproduce each finding, with the auditor's own iteration
  counts wherever a race is involved (H2: 20/20 both directions; H4: 30
  self-vs-self, 30×5-way self-vs-admin, 20 JML) — every race test loops for
  real, never runs once.
- Each fix counterfactually verified: revert → new test fails for the
  predicted reason → restore. See above.

## Concerns / follow-ups (not fixed here, out of this wave's scope)

- **H1 (audit-log tamper-proofing)**: untouched — CRITICAL/HIGH severity but
  outside INTEGRITY/CONCURRENCY's own priority list for this wave (the task
  explicitly enumerated H2/H4/H3/M5/M2/M6 plus three cheap items; H1's fix
  direction — role separation, a hash chain, or an external append-only sink
  — is a materially larger, deployment-topology-level change, not a
  same-shape code fix like the others here).
- **M3 (Keycloak-only accounts invisible to reconciliation)** and **M7
  (`syncState` derivation is O(unsettled aggregates), serially)**: not in
  this wave's named list; left as documented, pre-existing findings.
- **L1/L2**: L2 (audit `before` snapshots can be stale) is explicitly noted
  in the audit as "fixed for free by the H4 row lock" for the self-service
  path; the ADMIN path's own outer (still-unlocked) `current` read — used
  only for `PATCH /users/:id`'s audit `before` snapshot, not for computing
  the write — was not additionally locked, since that is a distinct,
  lower-priority finding not in this wave's list. L1 (Keycloak writes surviving
  a rolled-back savepoint) was in the audit's own "worth documenting rather
  than fixing" bucket.
- **M6's row cap is a request-scoped check, not a queue/streaming redesign**:
  `parseAndPrepare` still buffers the whole parsed CSV in memory before
  counting rows; the cap bounds the WORST case (rejects before any row is
  resolved/written) but does not change `commit`'s serial ~10 ms/row
  processing model, which the audit separately notes as a performance
  concern, not this wave's INTEGRITY-scoped ask.
- **M4's no-op detection is request-local**: it compares against
  `resolution.current`, read non-transactionally during `resolveRow` (same
  staleness window every other check in that method already accepts) — a
  provably-benign trade-off (worst case: one redundant write on a *later*
  re-run), not a new correctness gap.
