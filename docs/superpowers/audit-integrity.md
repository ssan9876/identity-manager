# Security audit — INTEGRITY, CONCURRENCY, AVAILABILITY

Adversarial audit of sub-project 1 at `91aa5b9` (master). Method was live probing, not
source reading: throwaway Postgres containers, the real controllers/repositories/jobs wired
through Nest DI, real concurrent HTTP requests via supertest, and an in-memory Keycloak
double so the shared dev stack was never mutated. Rates below are measured, not estimated.

Other auditors cover authz, injection, and secrets/exposure — those lenses are excluded here.

---

## CRITICAL

### C1 — 11 concurrent `PATCH /users/:id` permanently deadlock the API process

**What.** `createDbClient` is `new Pool({ connectionString })` — pg defaults, `max = 10`,
`connectionTimeoutMillis` unset (wait forever). Several write handlers open
`this.db.transaction(...)` (which checks out one pooled connection for the whole callback)
and then, *inside* that callback, call `PermissionEngine.assertCanIn` /
`PrivilegeGuards.assertCanModifyPrincipal`, which run their queries on `this.db` — the
**pool**, not the transaction handle. Each in-flight request therefore needs **two**
connections from a pool of ten. Once ten requests hold a transaction each, every one of
them blocks forever waiting for an eleventh connection that will never be released.

**Reproduction (deterministic, 2/2 at ≥11; 10 concurrent still passes).**
Boot `UsersController` against the production `createDbClient`, grant one actor
`user_admin` on one org unit, then fire 11 concurrent `PATCH /users/:id`:

```
pool max = 10, connectionTimeoutMillis = undefined
--- 10 concurrent PATCH /users/:id --- completed in 82ms; statuses = 200 x10
--- 11 concurrent PATCH /users/:id --- *** HUNG: no response after 8s
    pg_stat_activity = [{"state":"active","c":"1"},{"state":"idle in transaction","c":"10"}]
    pool: total=10 idle=0 waiting=11
```

The process never recovers. Postgres side, ten sessions sit `idle in transaction`
indefinitely, holding row locks and pinning the xmin horizon (VACUUM starvation).

**Reach.** Any actor holding `user:update` on one org unit — an ordinary help-desk-tier
account, not an admin. Nothing about the payload matters; it is pure concurrency.

**Also affected** (same shape — pooled query inside an open transaction):
- `POST /users/:id/deactivate` — `assertCanIn` + `assertCanModifyPrincipal`
- `PATCH /groups/:id`, `POST/DELETE /groups/:id/members`, `POST/DELETE /groups/:id/child-groups`
  — `requireGroup(..., tx)` loads the row on `tx` but then calls `engine.assertCanIn` on the pool
- `DELETE /users/:id/roles/:assignmentId` — both privilege checks run inside the transaction
- `SyncWorker.runOnce` — holds the claim transaction while
  `GroupsRepository.listEffectiveGroupsForUser` / `listByIds` / `listEffectiveUserMembers`
  and `listActiveAttributeDefinitions` all run on the pool. With `SYNC_WORKER_ENABLED` the
  worker shares the API's pool, so it permanently consumes 2 of the 10 slots while draining.

**Fix direction.** Three independent fixes, all worth doing:
1. Thread the transaction handle through `PermissionEngine`/`PrivilegeGuards`
   (`canIn(actor, action, orgUnitId, db = this.db)`, the convention every repository already
   uses) so a handler in a transaction never re-enters the pool.
2. Set `max` explicitly and, critically, `connectionTimeoutMillis` to a finite value so
   exhaustion degrades into 503s instead of a permanent wedge.
3. Add a lint/test that fails when a `db.transaction` callback reaches a collaborator that
   holds `DB_CLIENT` — this is exactly the "guard with a hole shaped like the mistake"
   class already on the project's historical-defect list.

---

## HIGH

### H1 — The audit-log append-only guarantee is not meaningful under the stated threat model

**What.** The guarantee is three `BEFORE ... FOR EACH STATEMENT` triggers calling one
`plpgsql` function. The threat model is explicitly "a party holding the application's own
database credentials", and that role (`idm`) both runs migrations and serves runtime — it
owns `audit_log` **and, on the live compose stack, is a Postgres superuser**
(`SELECT usesuper FROM pg_user WHERE usename = current_user` → `t`). Owner and superuser
privileges are precisely what is needed to remove the guard.

**Reproduction.** Fresh container, `runMigrations`, three seeded rows, each attempt in its
own transaction:

| attempt | result |
|---|---|
| `UPDATE audit_log SET action = 'tampered'` | blocked |
| `DELETE FROM audit_log` | blocked |
| `TRUNCATE audit_log` / `TRUNCATE ... CASCADE` | blocked |
| `INSERT ... ON CONFLICT (id) DO UPDATE` | blocked (fires the UPDATE trigger) |
| `MERGE ... WHEN MATCHED THEN UPDATE` | blocked |
| `WITH d AS (DELETE ... RETURNING *) SELECT ...` | blocked |
| cascade delete via `audit_log.actor_user_id` FK | blocked (`ON DELETE RESTRICT`) |
| `CREATE RULE "_RETURN" ... DO INSTEAD SELECT` | blocked (Postgres refuses on a non-view) |
| **`CREATE OR REPLACE FUNCTION audit_log_append_only() ... RETURN NULL`** | **SUCCEEDED — rows 1 → 0** |
| **`DROP TRIGGER audit_log_no_delete ON audit_log; DELETE`** | **SUCCEEDED — 3 → 0** |
| **`ALTER TABLE audit_log DISABLE TRIGGER ALL; DELETE; ENABLE`** | **SUCCEEDED — 3 → 0** |
| **`SET session_replication_role = 'replica'; DELETE`** | **SUCCEEDED — 3 → 0** |
| **`ALTER TABLE audit_log ALTER COLUMN action TYPE varchar(64) USING 'REDACTED'`** | **SUCCEEDED — every row rewritten, 3 rows kept** |
| **`ALTER TABLE audit_log ALTER COLUMN before TYPE jsonb USING '{}'::jsonb`** | **SUCCEEDED — every before-image wiped in place** |
| **`ALTER TABLE audit_log DROP COLUMN before`** | **SUCCEEDED** |
| **`ALTER TABLE ... RENAME` + `CREATE TABLE (LIKE ... INCLUDING ALL)` + `DROP`** | **SUCCEEDED — 3 → 0** |
| **`DROP TABLE audit_log CASCADE`** | **SUCCEEDED** |

The two most damaging are the quietest:

- **Function hijack.** One statement — `CREATE OR REPLACE FUNCTION audit_log_append_only()
  RETURNS trigger AS $$ BEGIN RETURN NULL; END; $$ LANGUAGE plpgsql` — neuters all three
  triggers at once. Nothing on `audit_log` is touched. Afterwards
  `UPDATE`/`DELETE`/`TRUNCATE` all succeed, and `pg_trigger` still shows
  `audit_log_no_update`, `audit_log_no_delete`, `audit_log_no_truncate`, all `tgenabled = 'O'`.
  Verified end to end: a `user:deactivate` row rewritten, then the table emptied, with the
  three triggers still listed and enabled. Any monitoring that checks "are the triggers
  present and enabled" passes throughout.
- **DDL rewrite.** `ALTER COLUMN ... TYPE ... USING <expr>` performs a full table rewrite
  applying the expression to every row. Triggers are DML-only, so none fire. Every
  `action`, or every `before` image, can be replaced with the row count and the triggers
  untouched. This is the same class as the shipped `TRUNCATE` gap — a write path the
  trigger vocabulary does not cover — but is not on the list of things that were checked.

Re-running migrations restores the function and the triggers, so a later `db:migrate`
silently erases the evidence that the guard was ever removed.

**Fix direction.** A DML trigger cannot defend against the table's owner; stop claiming it
does and change the property. Concretely: (a) split roles so the runtime role is not the
migration role and is not superuser, and `REVOKE` `TRUNCATE`/`UPDATE`/`DELETE`, ownership,
and `CREATE` on the function's schema from it; (b) if the log must be tamper-*evident*
rather than tamper-*proof*, add a hash chain (`prev_hash`/`row_hash` computed in the
trigger) plus an external verifier — that survives DDL rewrite, `DISABLE TRIGGER`, and
function replacement, none of which the current design does; (c) ship audit rows to an
append-only sink outside this database. Also add an `EVENT TRIGGER` on
`ddl_command_start`/`sql_drop` rejecting DDL against `audit_log` — that closes the ALTER and
DROP paths for a non-superuser owner, though not for a superuser.

### H2 — Two sync workers on one backlog silently diverge Postgres and Keycloak (20/20)

**What.** `OutboxRepository.claimNext` enforces strict ordering *per
`(aggregate_type, aggregate_id)`*. But a `user` event, a `group` event and a `membership`
event all funnel into `SyncWorker.reconcileUser` for the *same user* — three different
aggregates, so `claimNext` deliberately hands them to different workers in parallel
(`FOR UPDATE SKIP LOCKED`). Worse, `reconcileUser`'s desired-state reads
(`listEffectiveGroupsForUser`, `listByIds`) run on the **pool**, outside the claim
transaction, so there is a read-then-write window across every Keycloak round trip. Whoever
calls `setUserGroups` last wins, regardless of who read fresher data.

**Reproduction (20/20, both directions).** Two `SyncWorker` instances, one backlog, a
Keycloak at 120 ms/call (slow, not down). Worker A claims a `user` event and reads the
user's effective groups; while A is inside `ensureGroup`, an admin changes the membership
and worker B drains the resulting `membership` event to completion. A then writes the set
it read before the change.

```
[race:add]    postgres=2 group(s), keycloak=1 group(s); outbox=done,done,done   -> 20/20
[race:remove] postgres=1 group(s), keycloak=2 group(s) ["kcg-rg","kcg-rg0"]     -> 20/20
```

The remove direction is the security-relevant one: **the admin removed the user from a
group, the removal was applied to Keycloak, and then a stale concurrent worker put it
back.** Every outbox event ends `done`, `external_identities.sync_state` is `synced`, and
`GET /users` reports `syncState: 'synced'`. Nothing anywhere records that the two systems
disagree. The reconciliation job would fix it — but it is on-demand only, with no scheduler
(confirmed: `reconcile-cli.ts`, no cron, no timer).

**Fix direction.** Either (a) take a per-*user* advisory lock
(`pg_advisory_xact_lock(hashtext(userId))`) around `reconcileUser` so all three aggregate
types serialize on the entity they actually mutate, or (b) extend `claimNext`'s blocking
predicate to cover any pending event that fans out to an overlapping user set, or (c) at
minimum move the desired-state reads onto `tx` and re-read + compare immediately before
`setUserGroups`, treating a change as a retry. Document that "multiple workers are safe"
only holds per aggregate id, which is not the unit of state being written.

### H3 — A dead-lettered group *removal* reports as `synced` while the user keeps access

**What.** `SyncStateRepository` was added specifically to close the "membership fan-out
failed but the user looks healthy" hole. It genuinely closes it for *current* effective
members — but not for the case that matters most. It folds a troubled `group`/`membership`
aggregate into a user's state by walking `listEffectiveUserMembers(aggregateId)`, i.e. who
is in the group **now**. A user who was just removed is, by definition, no longer in that
set. The removal event that failed to reach Keycloak therefore surfaces against nobody.

**Reproduction.** User joins group G, syncs cleanly (Keycloak membership
`["kcg-xg"]`). Admin removes them; the `membership` event dead-letters (`maxAttempts: 1`,
Keycloak failing).

```
R2  removal dead-lettered:
      postgres groups = 0
      KEYCLOAK  groups = ["kcg-xg"]        <- user still holds the group, i.e. still has access
      GET /users syncState = 'synced'      <- console says everything is fine
      external_identities.sync_state = 'synced'
```

The complementary cases *do* work, which is what makes this so easy to miss:
`T2` a still-current member of a dead-lettered membership event reads `failed`;
`T2b` a member of a dead-lettered `group` event reads `failed`;
a dead-lettered `user` event regresses `external_identities` to `failed`.
Only the removal direction — the one where "looks synced" means "access was not actually
revoked" — is invisible.

Compounding it: there is **no operator-facing view of dead letters at all**. No controller
reads `outbox_events`; the derived per-user `syncState` is the only surface, and it has this
hole. A permanently failed revocation can sit in the table indefinitely with nothing
pointing at it.

**Fix direction.** Record the affected user ids in the `membership`/`group` event payload at
write time (the controller knows exactly who is affected — it is already in
`payload.userId` / derivable from `payload.childGroupId` *before* the edge is deleted), and
fold those recorded ids into `SyncStateRepository`, instead of re-deriving membership at
read time from state that has already moved on. Separately, add an admin endpoint or metric
for `outbox_events WHERE status = 'failed'` so a dead letter is never only visible through a
derived per-user field.

### H4 — `PATCH /self`'s attribute merge is a lost update (30/30)

**What.** `SelfServiceController.update` reads the current row, merges
`{ ...current.attributes, ...attributePatch }`, and writes it back. The doc comment states
this is safe because the read is inside the transaction: *"Merging onto `current.attributes`
(loaded inside this same transaction, so it can never be a stale read racing a concurrent
write)"*. That is false under Postgres's default READ COMMITTED. A plain `SELECT` inside a
transaction takes no lock and gives no repeatable read; the subsequent `UPDATE` blocks on
the row lock, then applies the *already-computed* merged object over the winner's data.

**Reproduction (30/30).** Two concurrent `PATCH /self` for the same user, one setting
`pronouns`, one setting `desk` (both active, `self_editable` definitions):

```
S1  statuses 200/200; final attributes = {"desk":"D-12"}      <- `pronouns` lost
S1  PATCH /self merge lost-update rate: 30/30
```

Both requests return 200. The user is told their change was saved; it was not.

Same mechanism, same rate, for **self-service racing an admin edit** (`PATCH /self` setting
one attribute vs `PATCH /users/:id` setting another): `S1b 30/30`. This is exactly the
erasure the merge was introduced to prevent, just triggered by concurrency instead of by
wholesale replacement.

`RuleApplier.applySetAttribute` (JML `set_attribute`) uses the identical
read-merge-write shape and is in the same position.

**Fix direction.** `SELECT ... FOR UPDATE` on the user row inside the transaction (a
`findByIdForUpdate` variant), or do the merge in SQL (`attributes = attributes || $1::jsonb`)
so the read and write are one statement. Fix the doc comment either way — it currently
asserts a property Postgres does not provide.

---

## MEDIUM

### M1 — `displayName` permanently desynchronises from `firstName`/`lastName` (30/30)

`UsersRepository.update` recomputes the derived `displayName` from
`patch.firstName ?? current.firstName` where `current` came from an unlocked read. Two
concurrent PATCHes, one naming `firstName` and one naming `lastName`, each recompute
`displayName` from their own stale half.

```
S2  first=Xavier last=Zed display="A Zed"     (30/30)
```

`displayName` is the name shown to every other user in the directory, and the file that
excludes `firstName`/`lastName` from self-service does so explicitly because *"that name is
shown to every other user in the directory, so letting someone silently rewrite it would let
them impersonate a colleague."* The value ends up stale rather than attacker-chosen, but it
is now permanently inconsistent with the fields it is supposed to derive from, and no later
write repairs it unless someone touches a name field again. Same fix as H4 (row lock), or
make `display_name` a generated column.

### M2 — The reconciliation job changes Keycloak security state and writes zero audit rows

Binding constraint 7 says every mutation is *"permission-checked, scope-narrowed, audited
AND outboxed in one transaction."* `ReconciliationJob.enqueueRepair` opens a transaction and
writes an outbox event only — there is no `AuditWriter.record` anywhere in
`reconciliation.job.ts`. Measured over a run that detected and repaired a genuinely
security-relevant drift (a suspended user manually re-enabled directly in Keycloak):

```
T5  drift = [["enabled_mismatch"]], enqueued = 1
    audit rows 0 -> 0 -> 0   |   outbox 1 -> 2 -> 2
    => Keycloak account re-disabled, 0 audit rows written
```

So "who disabled this account, and why" is unanswerable for every reconciliation-driven
change. Contrast `LifecycleJob` and `RuleApplier`, which are also system actors with
`actorUserId: null` and *do* write audit rows — the precedent exists and reconciliation is
the odd one out. Fix: write an `actorUserId: null` audit row (action e.g.
`reconciliation:repair`, `before` = observed Keycloak state, `after` = desired) in the same
transaction as the outbox event.

Idempotency itself is fine: run 1 enqueued 1 repair, run 2 found no drift and enqueued 0.

### M3 — Keycloak-only accounts are invisible to reconciliation

`ReconciliationJob.run` walks `users` in Postgres and compares each one against Keycloak. It
never walks the other direction, so an account that exists **only** in Keycloak is never
checked, never reported, and never disabled.

```
T5b  Keycloak-only account "ghost-account" (enabled):
     usersChecked = 1, drift reported = 0, still enabled in Keycloak = true
```

Given the system's own premise — "Postgres is the system of record, Keycloak owns
credentials" — a live Keycloak account with no Postgres row is a directory record that this
system claims authority over and cannot see. Anyone with Keycloak admin access (or an
operator mid-incident) can leave one behind permanently. Fix: page Keycloak's `/users` and
report/disable any account with no corresponding `external_identities` row, as a distinct
`orphaned_in_keycloak` drift reason.

### M4 — Bulk import re-run is idempotent on user rows but not on audit or outbox rows

The claim tested is "re-running the identical file updates rather than duplicates." User
identity holds. Audit and outbox do not:

```
run1 created=100 updated=0 | run2 created=0 updated=100
user rows identical: true
audit rows 1000 -> 1100 (+100), outbox rows 1000 -> 1100 (+100)
```

Every re-run writes a full round of `user:update` audit rows whose `before` equals `after`,
bumps `updated_at` on every matched row, and enqueues a full round of Keycloak sync events.
Because `audit_log` can never be pruned, a habit of re-running a 700-row nightly file is
7,000 no-op audit rows and 7,000 no-op Keycloak reconciliations a month, diluting the log
this system exists to keep. Fix: skip the write (and both records) when the resolved
`UpdateUserInput` is field-for-field equal to the current row, and report the row as
`unchanged` rather than `updated`.

### M5 — A `pending` leaver can never be deactivated, silently, forever

`listNonDeactivatedWithEndDateOnOrBefore` deliberately selects `status <> 'deactivated'`,
documented as *"an offboarded-before-ever-onboarded employee is exactly as much a leaver as
an active one."* But `ALLOWED_TRANSITIONS.pending = ['active']` — `pending → deactivated` is
not a legal transition — so `changeStatus` throws `InvalidTransitionError`, which
`deactivateDueUsers` catches and turns into a `console.warn`. The documented intent is
unreachable by construction:

```
[jml:lifecycle] skipped deactivation for ... — cannot transition from pending to deactivated
   (3 users, every run, forever)
```

Consequence: a never-activated leaver stays `pending` indefinitely, is retried on every run
(permanent log noise), never reaches the terminal state, and is **not excluded from default
list/search views** (only `deactivated` is). Their Keycloak account is disabled — desired
`enabled` is `false` for any non-`active` status — so this is a bookkeeping and
"leaver never closes out" problem, not an open access path. Fix: either add
`pending → deactivated` to the transition matrix (it is a legitimate offboarding path) or
narrow the leaver query and say so.

### M6 — Import commit is ~10 ms/row of blocking, serial work, capped only by an accidental body limit

`POST /imports/commit` does ~6 sequential round trips per row in `resolveRow` plus one
transaction per row, all serial, all on the request path:

```
commit 200 rows -> 200 created in 2108ms (10.5 ms/row), heap 62 -> 49 MiB
commit 700 rows -> 700 created in 7240ms (10.3 ms/row), heap 49 -> 93 MiB
```

The "no row-count or file-size cap" open item is real, but the damage is bounded by
something nobody chose: `main.ts` never configures a body parser, so express's default
100 KiB JSON limit applies.

```
  500 rows,  60 KiB body -> 200
 1000 rows, 123 KiB body -> 413 PayloadTooLargeError
```

So the practical ceiling is ~800 rows / ~7 s per request. That is an *accidental* control:
it disappears the instant anyone sets `bodyParser: { limit }` for a legitimate reason, or
puts a proxy in front that buffers. The 413 is also logged as an unhandled
`ExceptionsHandler` ERROR rather than a clean domain error. Fix: make the cap explicit — a
row-count limit in `parseAndPrepare` and a deliberate body limit in `main.ts` — and either
batch the per-row lookups or move commit off the request path.

### M7 — `GET /users`' `syncState` derivation is O(unsettled group/membership aggregates), serially

`SyncStateRepository.resolveForUsers` runs, on every `GET /users`, a `DISTINCT ON` across
the whole `outbox_events` table for `group` and for `membership`, then a **separate recursive
CTE per troubled aggregate**, in a serial `for ... of await` loop. Cost scales with how much
of the system is mid-sync, not with page size, and pagination does not bound it:

```
  0 group/membership events              :  16ms for a 50-user page
200 PENDING membership events            : 171ms for a 50-user page
200 DONE   membership events             :   2ms for a 50-user page
```

Every membership edit is `pending` between write and drain, so a bulk group re-org (or a
stalled/dead worker, or Keycloak down) makes the directory's main list page degrade linearly
— exactly when an operator most needs it. 2,000 unsettled aggregates ≈ 1.7 s per page view.
Fix: replace the per-aggregate loop with one set-returning query joining the troubled
aggregates to their members, and cap how many aggregates are folded in.

---

## LOW

### L1 — Keycloak writes survive a rolled-back fan-out with no Postgres record of them

`SyncWorker.runOnce` wraps `applyEvent` in a savepoint so bookkeeping survives a failure.
Correct, but Keycloak is not transactional: a `group` event fanning out to three members that
fails on the second leaves member #1 created in Keycloak while the savepoint discards the
`external_identities` row proving it.

```
T3  partial fan-out: outbox = [["group","failed"]]
    keycloak users created: t3a:true  t3b:false  t3c:false
    external_identities rows written: 0
```

Self-healing on retry (everything is desired-state), and the event is visible as `failed`.
Worth documenting rather than fixing, but it means "the nested transaction rolled back" must
not be read as "nothing happened."

### L2 — Audit `before` snapshots can be stale under concurrency

`UsersController.update`/`deactivate` snapshot `before` from an unlocked read taken earlier
in the transaction, and `UsersRepository.update` re-reads the row a second time. Under the
same races as H4/M1, the recorded `before` may be a state that was never the immediate
predecessor of `after`. Fixed for free by the H4 row lock.

---

## WHAT I TRIED THAT DID NOT WORK

Documenting these because a clean result from a real attempt is worth as much as a finding.

**Audit log — attacks that were correctly blocked.** `UPDATE`, `DELETE`, `TRUNCATE`,
`TRUNCATE ... CASCADE`, `INSERT ... ON CONFLICT DO UPDATE` (fires the statement-level UPDATE
trigger — the upsert-shaped bypass does not exist), `MERGE ... WHEN MATCHED THEN UPDATE`,
`DELETE` inside a writable CTE, `CREATE RULE "_RETURN" ... DO INSTEAD SELECT` (Postgres
refuses to convert a populated table into a view), and cascade deletion via
`audit_log.actor_user_id` — the FK is `ON DELETE RESTRICT` specifically so it collides with
the FK layer instead of the trigger, and it does. The statement-level trigger choice is right:
it fires even on a zero-row `UPDATE ... WHERE false`.

**`changeStatus` is genuinely race-free.** 30 pairs of concurrent
`POST /users/:id/deactivate` on the same user: `statusPairs = {"200/409": 30}`, and every
target ended with exactly one audit row and exactly one outbox event. The single conditional
`UPDATE ... WHERE status IN (...)` with EvalPlanQual re-evaluation does what its doc comment
claims. This is the pattern the rest of the write layer should copy.

**The nested-group cycle lock holds.** 30 iterations of three concurrent
`POST /groups/:id/child-groups` forming `a→b`, `b→c`, `c→a` simultaneously: **0 cycles
formed, 0 5xx responses, 0 deadlocks.** `pg_advisory_xact_lock` taken inside the savepoint
is still scoped to the outer transaction, so serialization survives the nesting.

**Concurrent role grants are safe.** 30 pairs of concurrent identical
`POST /users/:id/roles`: always exactly 1 assignment row and exactly 1 audit row — the
partial unique indexes plus `translateWriteError` handle it cleanly.

**Concurrent bulk imports of the same `employee_id` are safe.** 30 pairs: always exactly one
user, the loser reporting a named per-row failure rather than a 500 or a duplicate.

**Concurrent group add/remove of the same edge is consistent.** 30 iterations of a concurrent
`POST members` + `DELETE members/:userId` on the same edge: the outbox tail always agreed
with the final `group_user_members` state, 0/30 anomalies.

**Rejected mutations write nothing.** Out-of-scope PATCH (403), out-of-scope deactivate
(403), create against a bogus org unit (403), create with an unrecognised attribute (400),
an import commit where every row is rejected (200 with `failed > 0`), a self PATCH naming a
non-editable field (400), and a nesting request against nonexistent groups (404) —
`audit_log` and `outbox_events` both unchanged at 270 rows across all seven. Constraint 8
holds.

**Outbox replay is idempotent.** Forcing every `done` event back to `pending` and re-draining
produced byte-identical Keycloak state and no extra `external_identities` rows. The
"reconcile to desired state, never replay the payload" design does hold — the H2 divergence
is a concurrency problem, not a replay problem.

**`LifecycleJob` is idempotent, including concurrently.** Three sequential runs: 5 activated
then 0 then 0, with `audit`/`outbox`/`group_user_members` frozen at 10/10/5 after run 1.
Two *concurrent* runs over the same 5 due users: `activated 5 + 0`, +10 audit, +10 outbox, no
duplicated group memberships — the atomic `changeStatus` makes the loser skip cleanly.

**The recursive CTEs are not a DoS surface.** A 300-deep group chain resolved
`listEffectiveGroupsForUser` in 8 ms and `listEffectiveUserMembers` in 11 ms. A dense
12-level × 4-wide DAG (176 edges, exponential in path count) resolved 45 effective groups in
1 ms — `UNION` deduplication keeps it linear in nodes, not paths. Syncing that user cost 48
Keycloak calls in 32 ms. No pathological input found.

**Pagination is capped.** `limit=100000` and `limit=1e9` both clamp to 100; `offset` is
bounded at `MAX_SAFE_INTEGER`; `limit=0` and `limit=-1` are 400s. No unbounded page.

**`attribute_definitions` still has no write path**, so the 96.7-second ReDoS in
`attribute-validator.ts` remains unreachable — confirmed by grep across `src/` and
`scripts/`: only two `SELECT`s, no insert or update anywhere.

**The `DbHandle` type narrowing works.** Every one of the 20 `AuditWriter.record` /
`OutboxWriter.record` call sites passes a live `tx`; the pooled handle is structurally
rejected. I could not construct a call site that hands the audit writer a pooled handle.
(Note this is a *type-level* guarantee only, and `apps/api/scripts/` is outside the `tsc`
program with no CI — the known open items are still true.)

**A crashed worker's claim is releasable.** The claim lives in the worker's own open
transaction, so a killed process never commits `processing` and the row reverts to `pending`.
No event-loss path found here.

**Not attempted, deliberately:** I did not run the 554-test suite or the Playwright E2E,
because `revocation.spec.ts` / `dev-environment.spec.ts` drive the shared Keycloak on :8080
and three other auditors are working against it concurrently. I did not boot the app on
:3000. Every destructive probe ran against a throwaway `postgres:16-alpine` container on
:55432 with an in-memory Keycloak double.

---

## Environment left as found

- `git status` on `master` shows only `docs/superpowers/security-audit-input.md` (pre-existing,
  untracked) and this file. No committed file was modified.
- All probe code lived in `apps/api/__probe/` and has been deleted; the directory no longer exists.
- Throwaway container `idm-audit-probe` (port 55432) removed.
- The shared compose stack is untouched and still running: `identity-manager-postgres-1`
  (:5432, healthy, up 21h) and `identity-manager-keycloak-1` (:8080/:9000, up 4h). Neither
  was restarted.
- The shared dev database was only ever read (three `SELECT`s against `pg_user`, `pg_trigger`,
  `pg_proc`, and `count(*) FROM audit_log`). Its append-only triggers are all present and
  `tgenabled = 'O'`, `audit_log_append_only` still contains its `RAISE EXCEPTION`, and
  `audit_log` still holds its 31 rows. No `docker login` was performed.
