# Carried-findings verification pass

## STATUS: COMPLETE — but read the scope boundary below

This pass ran to completion: **all 44 ledger rows were verified against the source and
carry a `file:line` citation. Zero rows are unverified.** The table's "verified state"
column is load-bearing everywhere; nothing in it is inferred from a fix-wave report alone.

The boundary that *does* matter, because it limits what any row can claim:

- **Source reading only.** No test suite was run, no container started, no request issued —
  per the constraints of this pass. Every verdict is a reading of the code, not a live
  reproduction. Where a finding's truth depends on runtime behaviour rather than on what the
  source says (the measured 10.4 ms/row import cost in item 1; the measured lost-update rate
  behind INT-H4's residual; the ~9.2 s event-loop block behind the ReDoS), I have relied on
  the original audits' own measurements against unchanged code and said so at the point of use.
- **Verified on `audit/carried-findings` only**, branched from `da74d6d`. Concurrent branches
  — notably the `attribute_definitions` write path being added on
  `feat/business-roles-entitlements` — are **not** reflected. See CAR-ReDoS for the exact
  dependency and what changes if that branch merges.
- **No fixes were applied.** This is a verification and reporting pass; every remaining item
  is a recommendation, not a change.

---

`docs/12-security.md` states that "roughly twenty findings remain unverified" and that its
**Known open items** list should be verified "before looking elsewhere". Nobody had done
that pass. This is it.

**Method.** Source reading only — no test suite was run, no container was started, nothing
was fixed. Every claim below is backed by a `file:line` citation against the tree as it
exists on `audit/carried-findings` (branched from the current tip, at `da74d6d`). The five
fix-wave reports were treated as claims to check, not as evidence.

**Ledger.** 46 items: 8 from `audit-authz.md`, 6 from `audit-injection.md`, 14 from
`audit-integrity.md`, 10 from `audit-secrets.md`, and 12 carried claims from
`security-audit-input.md` / `docs/12-security.md`'s *Known open items* (two of which
duplicate a dimension finding and are cross-referenced rather than counted twice, giving 44
distinct rows below).

**Headline.** The fix waves are, on the whole, honest: 21 of 22 claimed fixes are present
in the code and do what the reports say. The interesting results are elsewhere — **three
places where a fix landed in one file and the identical pattern was later reintroduced in a
newer one**, and **two carried guarantees that decayed through drift** (the system-actor
claim, and the propagation-flag claim, both broken by subsystems built after the audit).

---

## RE-COUNT, 2026-08-14 — the "~20 still holds" figure is stale

The table below was accurate when it was written and has been quoted ever
since as "roughly twenty unverified findings", including by
`docs/12-security.md`, `docs/05-installation.md` and `docs/14-roadmap.md`.
Every one of those said it was an upper bound carried forward without
re-counting. This is the re-count the roadmap asked for.

**Eight of the twenty have since been closed.** Verified by reading the code,
not by trusting a ledger — `TODO.md` has itself been wrong about closures
before, by its own admission.

> **This section was wrong on its first pass and is corrected here.** It
> originally reported six closures and listed `SEC-L2` and `INT-M7` among the
> open MEDIUMs. Both are closed. The mistake was the exact one this paragraph
> claims to avoid: six closures were verified against the code and the *rest of
> the table was taken at face value*. Verifying the closures you expect and
> trusting the remainder is not a re-count. The two are added below with their
> evidence.

| ID | Was | Now | Evidence in the tree today |
|---|---|---|---|
| `INT-M3` | Still holds (MEDIUM) | **Closed** | `ReconciliationJob.detectKeycloakOnly()` pages the realm and reports `keycloakOnlyUsernames` |
| `SEC-M1` | Still holds (MEDIUM) | **Closed** | `attribute_definitions.sensitive` (migration `0026`); flagged values withheld from audit snapshots, withheld keys named in `attributesRedacted` |
| `SEC-L6` | No longer unreachable (MEDIUM) | **Closed** | `acknowledgedExportCount` is required on both write paths and re-derived inside the writing transaction (8 references) |
| `INJ-INFO` | Still holds (INFO) | **Closed** | `simulate()` now refuses a rule whose `trigger` is not in `KNOWN_TRIGGERS`, the same check `matchRules` makes |
| `CAR-ReDoS` | Still holds (HIGH-if-opened) | **Closed** | `new RegExp` no longer appears in `src/` outside comments; `validationRules.pattern` is replaced by the closed `attribute-formats.ts` vocabulary, asserted by a static source scan |
| `INJ-M-1` / `INT-M6` | Fixed, widened default (MEDIUM) | **Closed** | Cap is 1,000 (`b36e7ad`); measured at ~8.5 s worst case, and the console mirror that still said 5,000 was fixed |
| `SEC-L2` | Still holds (MEDIUM) | **Closed** | `users.repository.ts` throws `'primaryEmail: not available'` / `'username: not available'`, with a comment naming SEC-L2 — the direct-create sibling the import fix missed |
| `INT-M7` | Still holds (MEDIUM) | **Closed** | The serial `for … of await` loops are gone; `resolveForUsers` batches via `listEffectiveGroupMembershipsForUsers` under one `Promise.all`, and `listEffectiveUserMembers` is no longer called there at all |

**`CAR-system-actor` is half-closed** and stays on the list. The acting
`userId` is now threaded into `TargetReconciliationJob.auditOverride`, so a
`connector:reconcile-override` row names a human. What remains open is the
larger half: the per-entity writes a reconcile performs are still not
permission-checked, scope-narrowed, audited or outboxed, so security
constraint 7 does not hold for that route.

### The current count

**Twelve still hold**, of which:

- **MEDIUM — 2:** `SEC-L5` (partially addressed — see below) and the open half
  of `CAR-system-actor`.
- **LOW — 6:** `AUTHZ-M-1`, `AUTHZ-L-4`, `INJ-H-1`, `INJ-H-2`, `INJ-L-1`,
  `INT-H4`, `INT-L2`, `SEC-L1`, `SEC-L4`, `SEC-L7`, `CAR-group-rename`,
  `CAR-jml-triggers` — counted as a band rather than individually, because
  several are "the pattern recurs in one new place" rather than a distinct
  defect.
- **INFO / deliberate — the remainder:** `AUTHZ-L-1`, `INT-L1`, `SEC-L3`,
  `CAR-username`, `CAR-no-suspend`, `CAR-self-merge`, `CAR-self-editable`,
  `CAR-jml-revocation`, `CAR-import-uuid`. These are recorded decisions, not
  a backlog.

**`SEC-L5` is partially addressed**, which the table does not capture. The
audit asked for "rename plus disable". The rename happened —
`keycloak/realm-import/identity-manager-realm.dev.json` is now explicitly
named as development-only, `scripts/keycloak-setup.sh` builds a real realm
through the Admin API instead, and `sslRequired` has moved from `none` to
`external`. The disable happened too: `idm-test-client` is now `enabled: false`. What
remains is a seeded `admin@example.com` whose password
`dev_password_change_me` is published in this repository, so importing the
file by mistake still creates one working account. That is kept deliberately —
removing it makes the file useless for the local development it exists for —
which makes the residue a documentation-and-naming risk rather than an
unaddressed finding.

**Nothing HIGH or CRITICAL remains open.** `CAR-ReDoS` was the only
HIGH-if-opened item and it is closed; the gate it guarded was confirmed shut
before the JML rules API was built on top of it.

The honest summary is therefore: **two MEDIUM findings and a band of LOW
ones**, none of them structural, plus a set of deliberate decisions that were
never findings. That is a materially different picture from "roughly twenty
unverified findings" and should be quoted instead of it.

### What this re-count did NOT do

It did not re-verify the findings that remain open. Each was read closely
enough to establish whether the closure claim was true, not to re-derive the
original finding. A finding marked "still holds" here still means "still held
when it was last examined".

---

## Summary table

| ID | Dimension | Claimed state | Verified state | Severity now |
|---|---|---|---|---|
| AUTHZ-H-1 | authz | Fixed (Wave B) | **Fixed, sound** — and extended to the new `GET /:id/roles` | — |
| AUTHZ-M-1 | authz | Fixed (Wave B) | **Fixed, but incomplete** — write path closed; read amplification via `effective-members` never re-narrows | LOW |
| AUTHZ-M-2 | authz | Fixed (Wave B) | **Fixed, sound** | — |
| AUTHZ-M-3 | authz | Fixed (Wave B) | **Fixed, sound** (both layers) | — |
| AUTHZ-L-1 | authz | Accepted as risk | **Still holds** (deliberate) | INFO |
| AUTHZ-L-2 | authz | Fixed (Wave B) | **Fixed, sound** | — |
| AUTHZ-L-3 | authz | Fixed (Wave B) | **Fixed, sound** | — |
| AUTHZ-L-4 | authz | Never addressed | **Still holds** | LOW |
| INJ-H-1 | injection | Fixed (Wave C) | **Fixed, but the pattern recurs** — a new `z.record()` in `connector-targets.controller.ts` | LOW |
| INJ-H-2 | injection | Fixed (Wave C) | **Fixed, but incomplete** — `connector_targets.config` values have no `noNulChar` | LOW |
| INJ-M-1 | injection | Fixed (Wave D as INT-M6) | **Fixed, but the new cap is wider than the accident it replaced** | MEDIUM |
| INJ-L-1 | injection | Partially fixed (Wave C) | **Partially holds** — NFC landed; `Cf`-category characters still unconstrained | LOW |
| INJ-L-2 | injection | Fixed (Wave C) | **Fixed, sound** | — |
| INJ-INFO | injection | Never addressed | **Still holds** | INFO |
| INT-C1 | integrity | Fixed (Wave A) | **Fixed, sound** — discipline held in every new path checked | — |
| INT-H1 | integrity | Fixed (Wave E) | **Fixed, sound** under the stated threat model | — |
| INT-H2 | integrity | Fixed (Wave D) | **Fixed, sound** | — |
| INT-H3 | integrity | Fixed (Wave D) | **Fixed, sound**; dead-letter view exists and is globally gated | — |
| INT-H4 | integrity | Fixed (Wave D) | **Fixed, but the pattern recurs** — `ConnectorTargetsRepository.upsert` is an unlocked read-merge-write | LOW |
| INT-M1 | integrity | Fixed (Wave D) | **Fixed, sound** | — |
| INT-M2 | integrity | Fixed (Wave D) | **Fixed, sound** | — |
| INT-M3 | integrity | Not addressed | **Still holds** | MEDIUM |
| INT-M4 | integrity | Fixed (Wave D) | **Fixed, sound** | — |
| INT-M5 | integrity | Fixed (Wave D) | **Fixed, sound** | — |
| INT-M6 | integrity | Fixed (Wave D) | **Fixed, with a widened default** — see INJ-M-1 | MEDIUM |
| INT-M7 | integrity | Not addressed | **Still holds** (and the loop grew a second arm) | MEDIUM |
| INT-L1 | integrity | Documented, not fixed | **Still holds** (deliberate) | INFO |
| INT-L2 | integrity | Partially fixed (Wave D) | **Partially holds** — admin `before` snapshot still unlocked | LOW |
| SEC-H1 | secrets | Fixed (Waves C+D) | **Fixed, sound** | — |
| SEC-M1 | secrets | Not addressed | **Still holds, and the blast radius grew** | MEDIUM |
| SEC-L1 | secrets | Not addressed | **Still holds** | LOW |
| SEC-L2 | secrets | Claimed fixed via SEC-H1 | **Still holds — the fix landed only on the import path** | MEDIUM |
| SEC-L3 | secrets | Documented, deliberate | **Still holds** (deliberate) | INFO |
| SEC-L4 | secrets | Not addressed | **Still holds** | LOW |
| SEC-L5 | secrets | Not addressed | **Still holds**, mitigated only by documentation | MEDIUM |
| SEC-L6 | secrets | "Unreachable today" | **NO LONGER UNREACHABLE — regression through drift** | MEDIUM |
| SEC-L7 | secrets | Not addressed | **Still holds** | LOW |
| CAR-ReDoS | carried | "Verify no write path" | **Still holds** — with one precision correction | HIGH-if-opened |
| CAR-username | carried | Deliberate | **Still holds** | INFO |
| CAR-no-suspend | carried | Deliberate | **Still holds** | INFO |
| CAR-group-rename | carried | Deliberate | **Still holds**, and the backstop is weaker than documented | LOW |
| CAR-self-merge | carried | Deliberate | **Still holds**, now race-safe | INFO |
| CAR-self-editable | carried | Deliberate | **Still holds** | INFO |
| CAR-jml-revocation | carried | Deliberate | **Still holds** | INFO |
| CAR-system-actor | carried | "Confirm not user-inducible" | **NO LONGER HOLDS — regression through drift** | MEDIUM |
| CAR-jml-triggers | carried | Known gap | **Still holds** | LOW |
| CAR-import-uuid | carried | Deliberate | **Still holds** | INFO |

Counts: **Fixed and sound — 16.** **Fixed but incomplete/bypassable/recurring — 6.**
**Still holds (accurate today) — 20.** **No longer holds (stale claim) — 2.**
**Cannot verify by reading — 0.**

---

## Authorization dimension

### AUTHZ-H-1 — role assign/revoke did not scope-check the target — *Fixed, sound*

`assign` loads the target and runs `assertCanIn(actor, 'role:assign', target.orgUnitId)`
before the other two checks and before the transaction opens
(`apps/api/src/authz/role-assignments.controller.ts:201`). `revoke` runs the symmetric check
inside the transaction against `current.userId`'s org unit, threading `tx`
(`apps/api/src/authz/role-assignments.controller.ts:294`). The class doc comment was
rewritten from "THE THREE CHECKS" to four.

Beyond the claim: a route added *after* the audit, `GET /users/:id/roles`, runs the same
check (`apps/api/src/authz/role-assignments.controller.ts:157`) — the fix was carried
forward rather than forgotten. Every `assertCanModifyPrincipal` call site in the tree is now
paired with an `assertCanIn` on the same target: `users.controller.ts:458/459`,
`users.controller.ts:532/533`, `imports.controller.ts:664/670`, and the two above. No
unpaired site remains.

### AUTHZ-M-1 — group nesting narrowed only against the parent — *Fixed, but incomplete*

The write half is closed: `addChildGroup` loads the child and calls `assertCanIn(actor,
'group:manage_members', child.orgUnitId, tx)` whenever the child is scoped
(`apps/api/src/groups/groups.controller.ts:447`).

**What remains.** The audit offered two fixes and the report took only the first: "make
`effective-members` re-narrow each contributing group" was not done.
`GroupsController.effectiveMembers` still returns `this.groups.listEffectiveUserMembers(id)`
verbatim (`apps/api/src/groups/groups.controller.ts:174`), and `requireGroup` skips the scope
check entirely for a **global** group under `group:read`
(`apps/api/src/groups/groups.controller.ts:566` — the branch only fires when
`action !== 'group:read'`). So a global group that a *global* admin has legitimately nested
an out-of-scope group under still discloses that out-of-scope roster (user ids only) to any
holder of `group:read` at any scope. AUTHZ-M-2 removes the attacker's ability to *create*
that nesting, which is why this degrades from MEDIUM to LOW — but it is a read channel that
survives, not one that was closed.

### AUTHZ-M-2 — global groups manageable from any scope — *Fixed, sound*

`requireGroup`'s global branch requires `scopePathsFor(actor, action) === null` for any
action other than `group:read` (`apps/api/src/groups/groups.controller.ts:566-570`);
`create`'s global branch does the same (`:203-206`); `addMember` now scope-checks the member
(`:340`). `removeMember`/`removeChildGroup` deliberately keep the old shape — revoking
membership grants nothing — and that reasoning is sound.

### AUTHZ-M-3 — `preferred_username` not validated as a string — *Fixed, sound*

Explicit `typeof`/length checks on **both** `sub` and `preferred_username`
(`apps/api/src/auth/jwt.guard.ts:97-103`), and the defence-in-depth
`sql.param(principal.username)` in `resolveActor`
(`apps/api/src/authz/permission.engine.ts:64`). Two independent layers, as claimed.

One residual the audit did not raise and the fix did not sweep: `email` is still an
unchecked cast (`apps/api/src/auth/jwt.guard.ts:107`). `Principal.email` is therefore still
a type lie for a non-string claim. It reaches only `GET /me`'s echo and no SQL, so it is not
exploitable — noted for completeness, not as a finding.

### AUTHZ-L-1 — `GET /me` returns 200 for a non-active principal — *Still holds, deliberate*

`MeController` still carries `@UseGuards(JwtGuard)` only
(`apps/api/src/auth/me.controller.ts:42`), with no `PermissionGuard` and no
`resolveActor`. `guard-coverage.spec.ts:30` lists it (with `SelfServiceController`) in the
`AUTHENTICATION_ONLY` exemption set, so the exemption is explicit and reviewable rather than
accidental. Wave B's decision to document rather than deny is intact and its reasoning still
applies.

### AUTHZ-L-2 / AUTHZ-L-3 — *Fixed, sound*

`GET /groups?userId=` loads the target and calls `assertCanIn(actor, 'user:read',
target.orgUnitId)` when it resolves (`apps/api/src/groups/groups.controller.ts:127`); a
nonexistent id is still folded into the empty page, correctly avoiding a new oracle.
`resolveUpdateRow` narrows with `user:update` (`apps/api/src/imports/imports.controller.ts:664`).

### AUTHZ-L-4 — unknown `role_key` on the target yields an unmapped 500 — *Still holds*

`assertCanModifyPrincipal` still throws a plain `Error` on a `role_key` absent from
`ROLE_RANK` (`apps/api/src/authz/privilege.guards.ts:205-208`). It fails closed. Deliberate
and untouched by any wave, exactly as Wave B stated.

---

## Injection dimension

### INJ-H-1 — `__proto__` silent key elision — *Fixed, but the pattern recurs*

All five original sites are fixed. `csv.ts:72` builds each row on `Object.create(null)`;
`import-row.ts:138` does the same for `rawAttributes`; `rawAttributesSchema =
z.unknown().optional()` (`apps/api/src/attributes/attribute-validator.ts:265`) replaced
`z.record(z.unknown())` in the users/groups/self body schemas; `buildTargetAttributes` and
`buildSyncedAttributes` both use `Object.create(null)`.

**What remains.** A `z.record()` was reintroduced in a file written after the fix:

```
apps/api/src/connectors/connector-targets.controller.ts:67
    config: z.record(z.string().min(1).max(128), configPatchValueSchema).optional(),
```

`ZodRecord` still funnels through `ParseStatus.mergeObjectSync`, which silently refuses to
assign a key named `__proto__` — the exact mechanism Wave C documented. A
`PATCH /connector-targets/:target` body carrying `"__proto__"` in `config` is silently
dropped rather than reported as an unrecognized key. The consequence is bounded (the
repository *merges* config rather than replacing it — `connector-targets.repository.ts:143`
— so nothing is destroyed, unlike the original CSV finding), and the route needs a global
`connector:manage` grant. But it is the fifth recurrence of a defect class this project has
a documented history with, in code that post-dates the fix for it.

### INJ-H-2 — JSON-escaped NUL is an unhandled 500 — *Fixed, but incomplete*

`noNulChar` exists (`apps/api/src/common/http/safe-string.ts:39`) and is applied to every
field the audit named, plus every free-text field added since: `attribute-target-mappings`'s
`remoteName` (`:33`) and `audit.controller.ts`'s `actor`/`action`/`resourceType` filters
(`:16-17`). `writeAttemptFailureReasons` keeps a mid-batch infrastructure error from
aborting the import and losing `batchId` (`apps/api/src/imports/imports.controller.ts:149`).

**What remains.** One admin-editable free-text field that lands in a `jsonb` column has no
`noNulChar`:

```
apps/api/src/connectors/connector-targets.controller.ts:62
const configPatchValueSchema = z.union([z.string().max(4000), z.number(), z.boolean(), z.null()])
```

`PATCH /connector-targets/:target` with `{"config":{"host":"a\u0000b"}}` reproduces the
original failure exactly: legal JSON, passes Zod, fails at Postgres as a raw `pg` error that
`DomainExceptionFilter` (`@Catch(DomainError)`) does not touch, so an unmapped 500. This is
a fix applied in one place while the same pattern exists elsewhere unfixed — and the
"elsewhere" is newer code, so no wave could have caught it. Reachable only by a global
`connector:manage` holder (`super_admin`), hence LOW.

### INJ-M-1 / INT-M6 — no row or size cap on bulk import — *Fixed, with a widened default*

Both controls exist. `IMPORT_MAX_ROWS` defaults to 5,000 (`apps/api/src/config/env.ts:72`),
checked in `parseAndPrepare` before any row is resolved
(`apps/api/src/imports/imports.controller.ts:325`), with a cheap line-break pre-count so an
oversized file is refused before allocation (`:312`). `BODY_LIMIT_BYTES` defaults to 10 MiB
(`env.ts:63`) and `main.ts` boots with `bodyParser: false` plus two explicit
`useBodyParser` calls (`apps/api/src/main.ts:41-43`), which is the only ordering that
actually applies the limit.

**Be sceptical of "fixed" here.** The audit measured import commit at 10.3–10.5 ms/row of
serial, blocking, on-request work, and observed that express's *accidental* 100 KiB default
capped a request at ~800 rows / ~7 s. The deliberate replacement is 5,000 rows behind a
10 MiB body limit — roughly **6× the row count and ~50 s of serial work per request**
against a pool of 10 (`DB_POOL_MAX`, `env.ts:54`). Commit is still one transaction per row
on the request path; Wave D's own Concerns section says so. So the *stated contract* replaced
an *accident*, which was the point — but the numbers chosen make the worst case materially
worse than the accident did, and nothing in the wave reports reckons with that. This is the
single most consequential "fixed" item that deserves a second look.

### INJ-L-1 — Unicode identity confusion — *Partially holds*

NFC normalisation landed on the one site that sets `username`
(`apps/api/src/users/users.repository.ts:160`), and `PATCH` still deliberately excludes
`username`. The rest of the audit's fix direction did not land: nothing rejects
`Cf`-category characters (RTL overrides U+202A–U+202E, ZWJ, U+2066–U+2069) in `username`,
`firstName`, `lastName` or `primaryEmail`, and `displayName` is still derived from
`firstName`/`lastName` and shown directory-wide. Wave C flagged this omission honestly in
its own Concerns. The display-layer impersonation half of the finding is open.

### INJ-L-2 — array coercion on `limit`/`offset` — *Fixed, sound*

`scalarOnly` is `z.union([z.string(), z.number()]).pipe(target)`
(`apps/api/src/common/pagination.ts:34`), applied to both fields (`:39`, `:46`). The union
has no array member, so an array is rejected before `Number()` ever runs.

### INJ-INFO — `simulate()` ignores `rule.trigger` — *Still holds*

`simulate` calls `evaluateRule` per user and never consults `trigger`
(`apps/api/src/jml/rule-engine.ts:301-312`), while `matchRules` checks
`Object.hasOwn(KNOWN_TRIGGERS, rule.trigger)` and refuses an unknown one (`:252`). A rule
with a garbage trigger still previews as `wouldApply: true` while it can never fire. No HTTP
surface exposes `simulate` today, so this remains informational.

---

## Integrity / concurrency dimension

### INT-C1 — pool-exhaustion deadlock — *Fixed, sound; discipline held under drift*

`canIn`/`assertCanIn` take an optional trailing handle
(`apps/api/src/authz/permission.engine.ts:160-165`, `:194`), and every in-transaction caller
passes `tx`. I checked the paths written *after* Wave A, since this is exactly the class of
guarantee that decays:

- `GroupsController.requireGroup` forwards `db` into `assertCanIn`, not just into `findById`
  (`apps/api/src/groups/groups.controller.ts:547`) — the site the audit reproduced through.
- `AttributeTargetMappingsController` and `ConnectorTargetsController` run their
  `scopePathsFor` check *before* opening a transaction
  (`attribute-target-mappings.controller.ts:136`, `connector-targets.controller.ts:194`);
  `scopePathsFor` performs no query at all, so there is nothing to redirect.
- `TargetReconciliationJob` opens one short transaction **per user** and per group rather
  than one spanning the population walk, and its doc comment cites C1 by name
  (`apps/api/src/outbox/target-reconciliation.job.ts:503-527`).
- `UsersController.syncDetail` (added after all five waves) does all its reads on the pool
  with no transaction open (`apps/api/src/users/users.controller.ts:310-338`).

No new violation found. The one thing Wave A promised and did not deliver — a lint or test
that fails when a `db.transaction` callback reaches a `DB_CLIENT` holder — still does not
exist, so this remains guaranteed by review discipline rather than structurally.

### INT-H1 — audit-log append-only not meaningful — *Fixed, sound under the stated threat model*

`provisionRuntimeRole` creates `idm_app` with `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`
(`apps/api/src/db/roles.ts:67`), grants `USAGE` but deliberately **not** `CREATE` on schema
`public` (`:108-111` — the privilege that would allow `CREATE OR REPLACE FUNCTION
audit_log_append_only()`), and grants `audit_log` exactly `SELECT, INSERT` followed by an
explicit `REVOKE UPDATE, DELETE, TRUNCATE` (`:125-126`). `app.module.ts:82-86` builds
`DB_CLIENT` from `env.runtimeDatabaseUrl` with no fallback, so a deployment that forgets
`RUNTIME_DATABASE_URL` fails `loadEnv` rather than silently running as owner.

The honesty check in Wave E's report is accurate: the owner role remains superuser, and the
finding's threat model was explicitly the *application's* credentials, not the operator's.
The trigger remains the owner-side defence. Neither of the audit's other two directions
(hash chain, external sink) landed, and both remain open as tamper-*evidence* rather than
tamper-*proofing*.

### INT-H2 / INT-H3 / INT-H4 / INT-M1 / INT-M2 / INT-M4 / INT-M5 — *Fixed, sound*

- **H2**: `reconcileUser`'s first statement is
  `SELECT pg_advisory_xact_lock($SYNC_USER_LOCK_NAMESPACE, hashtext($userId::text))`
  (`apps/api/src/outbox/sync.worker.ts:445`), namespace `0x1d3a_0002` chosen with nonzero
  high bits so it cannot collide with `GROUP_GRAPH_LOCK_ID` (`:50`).
- **H3**: `SyncStateRepository` folds `payload.userId` and `payload.childGroupId` from the
  event itself, not from current membership
  (`apps/api/src/outbox/sync-state.repository.ts:278-288`), so a dead-lettered *removal*
  surfaces against the user who was removed. `GET /outbox/dead-letters` exists and is gated
  behind a **global** `audit:read` (`apps/api/src/outbox/outbox.controller.ts:76-93`).
- **H4**: `findByIdForUpdate` (`apps/api/src/users/users.repository.ts:218`) is used by
  `SelfServiceController.update` (`:378`) and `RuleApplier.applySetAttribute` (`:235`).
- **M1**: `UsersRepository.update` reads `current` via `findByIdForUpdate` (`:322`), so
  `displayName` derivation is inside the lock for every caller.
- **M2**: `enqueueRepair` writes an `actorUserId: null` audit row in the same transaction as
  the outbox event (`apps/api/src/outbox/reconciliation.job.ts:279-292`).
- **M4**: `isNoopUpdate` short-circuits the write and reports `unchanged`
  (`apps/api/src/imports/imports.controller.ts:184`, `:495`).
- **M5**: `pending: ['active', 'deactivated']` (`apps/api/src/users/users.repository.ts:84`),
  and `LifecycleJob` reports skips rather than only logging them (`lifecycle.job.ts:231`).

### INT-H4 addendum — the read-merge-write pattern recurs in newer code

Wave D fixed the two sites the audit found. A third, written afterward, has the same shape
and no lock:

```
apps/api/src/connectors/connector-targets.repository.ts:135   const [existingRow] = await tx.select()...  // plain SELECT, no FOR UPDATE
apps/api/src/connectors/connector-targets.repository.ts:143   const mergedConfig = { ...current.config, ...(patch.config ?? {}) }
```

Two concurrent `PATCH /connector-targets/:target` calls setting different config keys lose
one, exactly as `PATCH /self` did (measured 30/30 by the audit). Impact is far lower —
admin-only, global-grant-gated, config rather than identity — but it is the H4 mechanism
reappearing in a path the fix did not reach.

### INT-M3 — Keycloak-only accounts invisible to reconciliation — *Still holds*

`ReconciliationJob.run` (`apps/api/src/outbox/reconciliation.job.ts:135-179`) walks
`users` in Postgres by status and compares each against Keycloak. There is no reverse walk
and no `orphaned_in_keycloak` drift reason anywhere in the file. An account existing only in
Keycloak is still never checked, reported, or disabled. Wave D explicitly listed this as out
of scope; nothing since has addressed it.

### INT-M7 — `syncState` derivation is O(unsettled aggregates), serially — *Still holds*

`resolveForUsers` still runs a `listEffectiveUserMembers` recursive CTE per troubled
aggregate inside a serial `for … of await` loop — now in **two** loops, one for `group`
events (`apps/api/src/outbox/sync-state.repository.ts:261`) and one for `membership` events
(`:283`), the second added by the H3 fix. `UsersController.list` calls this on every page
(`users.controller.ts:250`-region) and `findOne`/`syncDetail` call it per user. Commit
`c3524c6` narrowed the derivation to *enabled* targets, which reduces the constant factor
but not the shape. The audit's measurement — 200 pending membership events costing 171 ms
per 50-user page, ~1.7 s at 2,000 unsettled aggregates — still applies.

### INT-L1 / INT-L2 — *Still holds / partially holds*

L1 (Keycloak writes surviving a rolled-back savepoint) was in the audit's "document rather
than fix" bucket and is unchanged. L2: the self-service path is fixed for free by the H4
lock, but `UsersController.update` and `.deactivate` still snapshot `before` from an
unlocked `findById` (`apps/api/src/users/users.controller.ts:453` and `:527`) while the
repository re-reads under `FOR UPDATE` — so an admin-path audit `before` image can still
record a state that was never the immediate predecessor of `after`. Wave D flagged this
omission itself.

---

## Secrets / disclosure dimension

### SEC-H1 — `POST /imports/preview` enumeration oracle — *Fixed, sound*

`resolveUpdateRow` runs scope and privilege first into a separate `scopeReasons` array and
returns immediately on rejection, so the three field-mismatch reasons never run for an
unreachable row (`apps/api/src/imports/imports.controller.ts:652-677`). `preview()` writes
exactly one `import:preview` audit row per invocation (`:372-378`). `resolveCreateRow`'s
collision messages are the non-confirming `"primaryEmail: not available"` /
`"username: not available"` (`:775`, `:779`).

### SEC-L2 — `POST /users` 409 discloses another org unit's email/username — *Still holds; the fix landed only on the import path*

This is the clearest case of a fix applied in one place while the identical pattern survives
elsewhere. Wave D changed `resolveCreateRow`'s messages to `"not available"`. The *same*
oracle in the direct-create path was never touched:

```
apps/api/src/users/users.repository.ts:461
        throw new ConflictError(`a user with email "${input.primaryEmail}" already exists`)
apps/api/src/users/users.repository.ts:464
        throw new ConflictError(`a user with username "${input.username}" already exists`)
```

`users_primary_email_unique` and `users_username_unique` are **global**, unscoped indexes, so
an actor holding `user:create` in one org unit still confirms, one candidate per request,
that a given email or username exists somewhere in the directory — including for principals
`GET /users/:id` 403s them on. The transaction rolls back, so zero audit rows are written:
the probing is still silent. This is lower-volume than SEC-H1 (one candidate per request
versus ~1,500), which is the only reason it is MEDIUM rather than HIGH, and Wave D's own
report describes fixing "the import path" without noting the sibling.

### SEC-M1 — attribute values copied verbatim into the audit log; no read-visibility control — *Still holds, and the blast radius grew*

`snapshotUser` is still an explicit field list with one wholesale passthrough:
`attributes: user.attributes` (`apps/api/src/users/users.controller.ts:200`). The
`attribute_definitions` schema still has no `sensitive`/`redact_in_audit` column
(`apps/api/src/db/schema/attribute-definitions.ts:24-56`) and there is no per-attribute read
filter anywhere. Every `user:create`/`user:update`/`user:self_update`/`jml:*`/import audit
row still writes the full bag as both `before` and `after`, into a table whose
`UPDATE`/`DELETE`/`TRUNCATE` are now blocked by *both* privilege and trigger — so, correctly,
there is even less retrofit available than when the finding was written.

Drift note: the audit's fix direction said this "must land **before** `attribute_definitions`
gets a write path." No write path has landed, so the window is still open — but migration
`0018_mail_attribute_definitions.sql:18` has since seeded four real attribute definitions
(`mail_enabled`, `mail_quota_mb`, `mail_aliases`, `mail_admin_role`), so the table now has
production content in every environment rather than being empty as it was during the audit.
The finding is no longer hypothetical in the same way.

### SEC-L6 — flipping propagation on retroactively exports withheld values — *No longer unreachable: regression through drift*

The audit rated this LOW **solely** because it was unreachable: "Unreachable today (no write
path for `attribute_definitions` — carried finding), but when that write path lands, one
UPDATE re-classifies a 'never leaves the system' field for the whole directory."

The gate moved, and the new gate has a write path. Migration `0014_known_photon.sql:48`
drops `attribute_definitions.sync_to_keycloak` and replaces it with rows in
`attribute_target_mappings`. That table now has a full CRUD HTTP surface:
`POST/PATCH/DELETE /attribute-target-mappings`
(`apps/api/src/attributes/attribute-target-mappings.controller.ts:134`, `:168`, `:205`).
`buildTargetAttributes` emits a value for **every enabled mapping row**, from the user's
already-stored attribute bag, with no re-validation and no separate consent
(`apps/api/src/connectors/attribute-mapping.ts:120`+). So one `POST /attribute-target-mappings`
naming an existing attribute and a target re-classifies that field for the whole directory —
exactly the finding, now reachable over HTTP.

Two things bound it, and both are real mitigations rather than accidents:

1. `requireGlobalManageGrant` requires a **global** `connector:manage` grant
   (`attribute-target-mappings.controller.ts:104`), which in today's static catalog is
   `super_admin` only (`apps/api/src/authz/actions.ts` — `connector:manage` is deliberately
   withheld even from `auditor`).
2. The create **is** audited in the same transaction
   (`attribute-target-mappings.controller.ts:154-161`), which satisfies the "explicit and
   audited" half of the audit's own fix direction.

What is missing versus that fix direction is the "confirmed" half — there is no
acknowledgement step, no count of how many users' stored values this will newly export, and
no outbox event, so propagation happens lazily and invisibly on each affected user's next
sync. Reported here because the *carried claim in `docs/12-security.md` and
`audit-secrets.md` is now stale*: this is no longer an unreachable finding.

### SEC-L1 / L3 / L4 / L5 / L7 — *All still hold*

- **L1**: `apps/web/src/auth/oidc-config.ts:36` sets `userStore` to `sessionStorage` and
  still leaves `stateStore` unset, so oidc-client-ts's `localStorage` default still persists
  `code_verifier`/`nonce` across browser restarts. Unfixed.
- **L3**: 403-for-out-of-scope, 404-for-nonexistent is unchanged and still documented as
  deliberate (`users.controller.ts:280`-region). With SEC-H1 closed, its pairing risk is
  materially reduced.
- **L4**: `jwtVerify` is still called with only `issuer`/`audience`/`algorithms`
  (`apps/api/src/auth/jwt.guard.ts:63-69`) — no `requiredClaims: ['exp']`, no `maxTokenAge`.
  A validly-signed token with no `exp` is still accepted. Defence-in-depth only; Keycloak
  always sets `exp`.
- **L5**: `keycloak/realm-import/identity-manager-realm.json` is unchanged and unrenamed —
  still `"sslRequired": "none"` (line 4), still seeds `"value": "dev_password_change_me"`
  (line 91), still ships `idm-test-client` with `"enabled": true` and
  `"directAccessGrantsEnabled": true` (lines 47-52). `.env.example:20` still carries the
  real working `KEYCLOAK_ADMIN_CLIENT_SECRET`. `docker-compose.yml:35` still carries
  `KC_BOOTSTRAP_ADMIN_PASSWORD`. The only mitigation added is documentation: the hardening
  checklist in `docs/12-security.md` now says "Do **not** import
  `keycloak/realm-import/identity-manager-realm.json`. Use `keycloak-setup.sh`", and
  `scripts/keycloak-setup.sh` exists. A checklist line is not the rename-plus-disable the
  audit asked for.
- **L7**: 50 `console.log/warn/error` calls across `apps/api/src` and no structured logger
  (`useLogger`/`winston`/`pino` appear nowhere). Unmapped 500s still print raw Postgres
  messages and stack traces to stdout. Client responses remain clean.

---

## Carried claims (`security-audit-input.md` / `docs/12-security.md` "Known open items")

### CAR-ReDoS — "`attribute_definitions` has no write path" — *Still holds, with one precision correction*

The ReDoS itself is unchanged and is still the only dynamic regex in the tree — a
tree-wide grep for `new RegExp|RegExp\(|sql.raw|eval\(|new Function` across `apps/api/src`
returns exactly one construction hit:

```
apps/api/src/attributes/attribute-validator.ts:89
      if (rules.pattern !== undefined) schema = schema.regex(new RegExp(rules.pattern))
```

`apps/web/src` has none. The gate holds on this branch:

- The only HTTP surface for the table is **read-only**: `GET /attribute-definitions`
  (`apps/api/src/attributes/attribute-definitions.controller.ts:55-56`), and its repository
  exposes a single `listActive` method with no insert/update/delete
  (`apps/api/src/attributes/attribute-definitions.repository.ts`).
- Tree-wide, the only non-test `INSERT`/`UPDATE`/`DELETE` against `attribute_definitions` is
  migration `0018_mail_attribute_definitions.sql:18`.

**Correction to the claim as written.** "`attribute_definitions` has no write path" is now
strictly false: migration 0018 seeds four rows. The claim that actually matters is narrower
and *does* hold — **no runtime or user-facing path writes `validation_rules`**. Migration
0018 sets only `key/label/data_type/applies_to/self_editable/sort_order`, runs as the owner
role, and cannot be induced from a request. Anyone re-checking this later should verify the
narrow claim, not the broad one, or they will find a false alarm and dismiss it.

**Dependency flag.** A concurrent branch (`feat/business-roles-entitlements` in the shared
tree) is reported to be adding an `attribute_definitions` write path with a mandated ReDoS
fix. Nothing on `audit/carried-findings` reflects that work. If that branch merges, this
item's state changes from "unreachable" to "reachable, mitigated by whatever that branch
ships", and the `SECURITY (deferred, not fixed here)` comment at
`attribute-validator.ts:81-88` — which says the ReDoS "MUST be addressed … by whichever
change first exposes a write path" — becomes the acceptance criterion for that merge.
`buildSyncedAttributes` and `buildTargetAttributes` were already pre-swept onto
`Object.create(null)` in anticipation of that write path, so the prototype half is ready;
the regex half is not.

### CAR-system-actor — "System-actor writes bypass `PermissionEngine` … confirm this cannot be induced from a user-facing path" — *No longer holds*

This is the item the brief predicted would decay, and it did.

At audit time the authz report verified this by walking the live route table: "No JML,
outbox, reconciliation, attribute-definition or audit route exists on the HTTP surface at
all — the system-actor write paths (`lifecycle-cli`, `reconcile-cli`, `SyncWorker`) are
CLI/worker-only and cannot be induced from a request."

That is no longer true. `POST /connector-targets/:target/reconcile` invokes
`TargetReconciliationJob.reconcile(target, options)` directly from an HTTP handler:

```
apps/api/src/connectors/connector-targets.controller.ts:256
    const report = await this.reconciliationJob.reconcile(target, options)
```

The job then walks the **entire directory** with `scopePaths: null`
(`apps/api/src/outbox/target-reconciliation.job.ts:283`, and the group walk at `:341`), and
on a non-dry run calls `SyncWorker.reconcileUser` / `reconcileGroupById` per entity
(`:445`, `:466`) — writing `external_identities` / `user_target_accounts` rows and pushing
state to a real external target for every principal in the organisation. None of those
per-entity writes is permission-checked, scope-narrowed, or individually audited/outboxed.

The job's own doc comments still assert the pre-drift world, and are now wrong:

- `:239` — "Unscoped (`scopePaths`-free), like `ReconciliationJob`/`LifecycleJob` before it:
  a trusted, on-demand admin/CLI operation, **not a request from a scoped actor**."
- `:597` — "`actorUserId: null` … **this job runs from a CLI, not a JWT-guarded request**,
  so there is no `Actor` to record here."

The second one has a concrete consequence. `auditOverride` — the one row that records
"someone deliberately overrode the blast-radius guard", explicitly described as "overriding
is explicit and audited" — writes `actorUserId: null`
(`apps/api/src/outbox/target-reconciliation.job.ts:613`) even when the override arrived over
HTTP with a fully authenticated actor. Attribution for the single most dangerous action this
endpoint offers is discarded. The controller's own `connector_target:reconcile` row does
carry `request.actor.userId` (`connector-targets.controller.ts:262`), so an investigator can
correlate by timestamp — but the override row itself, the one an auditor would search for,
names nobody.

**How bad is it?** Bounded, and deliberately so. `requireGlobalManageGrant`
(`connector-targets.controller.ts:152-159`) requires `scopePathsFor(actor,
'connector:manage') === null`, and `connector:manage` is `super_admin`-only in the static
catalog. So this is not a privilege escalation for a scoped actor — the doc comment at
`:123-150` shows the author found and closed exactly that hole. What changed is the carried
*claim*: system-actor writes are now inducible from a user-facing path, by one specific
role, and `docs/12-security.md` should stop saying otherwise. Constraint 7 ("every mutation
is permission-checked, scope-narrowed, audited and outboxed in one transaction") does not
hold for the mutations this endpoint performs, and the same is true, to a lesser degree, of
`PATCH /connector-targets/:target` and the three `attribute-target-mappings` routes, which
audit but never outbox.

### CAR-group-rename — "re-syncs only current effective members; reconciliation is the backstop" — *Still holds, and the backstop is weaker than documented*

`SyncWorker.reconcileGroup` still fans out to `listEffectiveUserMembers(groupId, tx)`
(`apps/api/src/outbox/sync.worker.ts:769`) — current members only. That half is accurate.

The backstop claim is worth qualifying: `deploy/systemd/` contains `idm-api.service`,
`idm-lifecycle.service` and `idm-lifecycle.timer` — and **no reconciliation timer**. The
lifecycle pass now runs daily (commit `a734538`); `ReconciliationJob` is still on-demand via
`reconcile-cli.ts` only, exactly as the integrity audit observed ("it is on-demand only,
with no scheduler — confirmed: `reconcile-cli.ts`, no cron, no timer"). Anyone reading
"reconciliation is the backstop" should know nothing schedules it.

### CAR-self-merge / CAR-self-editable / CAR-jml-revocation / CAR-username / CAR-no-suspend / CAR-import-uuid — *All still hold, all deliberate*

- `PATCH /self` still merges rather than replaces, now under `SELECT … FOR UPDATE`
  (`apps/api/src/self-service/self-service.controller.ts:378`), so the merge is race-safe.
  The abuse question the input document asked is answered by the authz audit's own negative
  results (no id-shaped input exists on the controller) plus the unchanged
  `.strict()` body schema; nothing since has widened it.
- `SELF_EDITABLE_CORE_FIELDS = ['location']` (`self-service.controller.ts:48`), unchanged.
  Nothing else is reachable: `PATCH /self`'s schema declares only `location` and
  `attributes` (`:64`), and attributes are filtered to `selfEditable` definitions (`:210-212`).
- JML `deactivate` still performs synchronous Keycloak revocation
  (`apps/api/src/jml/rule-applier.ts:338`), as does `LifecycleJob` (`lifecycle.job.ts:226`),
  both via `revokeKeycloakAccessBestEffort`.
- Principal resolution is still by `lower(username)`
  (`apps/api/src/authz/permission.engine.ts:64`), never `external_identities`.
- No suspend/activate HTTP endpoint exists. `UsersController` exposes only
  `POST /:id/deactivate` (`users.controller.ts:517`); status transitions otherwise come from
  `LifecycleJob`.
- Bulk import still references org units and managers by UUID
  (`apps/api/src/imports/import-row.ts:60`, `:62`), never by name.

### CAR-jml-triggers — "`user_created`/`user_attribute_changed` exist but nothing auto-fires them" — *Still holds*

Both values are present in the enum (`apps/api/src/db/schema/jml-rules.ts:24-25`), the type
(`apps/api/src/jml/rule-engine.ts:19-20`) and `KNOWN_TRIGGERS` (`:54-55`). The only caller of
`matchRules` in the whole tree is `LifecycleJob.fireTriggerRules`
(`apps/api/src/jml/lifecycle.job.ts:242-247`), whose `trigger` parameter is typed
`'start_date_reached' | 'end_date_reached'`. Neither of the two carried triggers is fired
from anywhere — including from `UsersController.create` or `.update`, which would be the
natural sites. A rule authored against either is silently inert.

### CAR-me-200 — see AUTHZ-L-1. CAR-import-cap — closed by INT-M6/INJ-M-1; the claim in the input document no longer holds.

---

## What genuinely remains open, in priority order

Ordered by real risk to a deployment, not by original severity label.

**1. Bulk import's deliberate cap is ~7× the accidental one it replaced.** (INJ-M-1 /
INT-M6.) 5,000 rows × ~10.4 ms serial ≈ 50 s of blocking, on-request work behind a 10 MiB
body limit and a 10-connection pool, reachable by any holder of `user:create` in one org
unit. The audit's measurement is the basis; nothing has changed the per-row cost. Either
lower `IMPORT_MAX_ROWS` to something near the ~800 the accident enforced, batch the per-row
lookups, or move commit off the request path. This is the item most likely to take a real
deployment down, and it is currently labelled "fixed".

**2. `POST /users`' 409 is still a cross-scope existence oracle.** (SEC-L2.) The sibling of
a HIGH finding that was fixed on the import path only —
`apps/api/src/users/users.repository.ts:461` and `:464`. Same one-line fix that already
landed at `imports.controller.ts:775`/`:779`: return `"primaryEmail: not available"` rather
than echoing the value with `already exists`. Silent (the transaction rolls back, so zero
audit rows), and it defeats org-unit scoping for the directory's two most identifying fields.

**3. The system-actor guarantee is stale, and override attribution is lost.**
(CAR-system-actor.) `POST /connector-targets/:target/reconcile` induces a directory-wide,
unscoped, per-entity-unaudited system write from an HTTP request. Two actions: (a) thread
the acting `userId` into `TargetReconciliationJob.auditOverride` so
`connector:reconcile-override` names a human when one exists
(`target-reconciliation.job.ts:613`); (b) correct the two doc comments at `:239` and `:597`
and the *Known open items* bullet in `docs/12-security.md`, which currently tell a reader
this cannot happen.

**4. Sensitive attribute values still land verbatim and permanently in the audit log, with
no read control.** (SEC-M1.) `users.controller.ts:200`. There is no retrofit for rows
already written, and the table now has real seeded definitions in every environment. This
must land before any `attribute_definitions` write path does — which makes it a blocker on
the concurrent branch, not a follow-up.

**5. Enabling a propagation mapping still retroactively exports previously withheld
values — and is now reachable.** (SEC-L6.) `POST /attribute-target-mappings`
(`attribute-target-mappings.controller.ts:134`). It is audited, which is half the fix
direction; what is missing is a confirmation step that states how many users' stored values
a new mapping will newly export. Interacts directly with item 4.

**6. Reconciliation cannot see Keycloak-only accounts, and nothing schedules it.**
(INT-M3 + CAR-group-rename.) `reconciliation.job.ts:135-179` walks Postgres only, and
`deploy/systemd/` has no reconciliation timer. Two independent gaps in the same backstop
that several other findings' residual risk is parked against.

**7. `syncState` derivation still degrades linearly with unsettled aggregates.** (INT-M7.)
`sync-state.repository.ts:261` and `:283`, on the directory's main list page. It now has two
serial loops rather than one. Degrades exactly when an operator most needs the page.

**8. Committed dev fixtures are still real, working, `sslRequired: "none"` secrets.**
(SEC-L5.) `keycloak/realm-import/identity-manager-realm.json` — unrenamed, `idm-test-client`
still enabled with direct access grants. Mitigated by one checklist line in
`docs/12-security.md`. Rename to `.dev.json`, set `sslRequired: "external"`, ship the test
client disabled.

**9. Two clean, one-line residuals in newer code that reintroduce already-fixed classes.**
`configPatchValueSchema` needs `noNulChar` (`connector-targets.controller.ts:62`), and
`config: z.record(...)` should not be a `ZodRecord` (`:67`). Both are `super_admin`-only, so
low risk — but they are evidence that the Wave C fixes were applied as edits rather than as
a rule anything enforces.

**10. Lower-priority carried items, unchanged and correctly documented.** PKCE
`code_verifier` in `localStorage` (SEC-L1, `oidc-config.ts:36`, one line:
`stateStore: new WebStorageStateStore({ store: window.sessionStorage })`); no
`requiredClaims: ['exp']` on `jwtVerify` (SEC-L4, `jwt.guard.ts:63`); `Cf`-category Unicode
unconstrained in display names (INJ-L-1); unknown `role_key` → unmapped 500 (AUTHZ-L-4);
admin-path audit `before` snapshot still unlocked (INT-L2, `users.controller.ts:453`,
`:527`); `effective-members` never re-narrows contributing groups (AUTHZ-M-1 residual,
`groups.controller.ts:174`); `ConnectorTargetsRepository.upsert` lost update (INT-H4
residual, `connector-targets.repository.ts:143`); `simulate()` ignores `rule.trigger`
(INJ-INFO); no structured logger (SEC-L7); `user_created`/`user_attribute_changed` inert
(CAR-jml-triggers).

**Not open, and worth saying plainly.** The ReDoS gate holds on this branch. The audit log's
append-only guarantee is now a privilege property, not a trigger property, and the eight
bypasses the audit demonstrated are closed for the runtime role. Every route on every
controller — including the eight added since the audit — is behind `JwtGuard` +
`PermissionGuard` with a declared `@RequirePermission`, verified against `AppModule`'s own
metadata by `guard-coverage.spec.ts`, with exactly two named exemptions. The
`scopePathsFor(...) === null` global-grant idiom that closed AUTHZ-M-2 was independently
applied to all four global-resource controllers added afterward (`audit`, `outbox`,
`connector-targets`, `attribute-target-mappings`). Connector secret resolution is namespaced
and validated before the environment is indexed. That is a good record, and most of the
remaining list is small.
