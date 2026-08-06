# Fix Wave B — AUTHORIZATION findings (H-1, M-1, M-2, M-3, L-1, L-2, L-3)

Branch: `fix/audit-critical-pool-exhaustion`, continuing from `c8fb15c` (the
CRITICAL pool-exhaustion fix, Wave A). Fixes every finding in
`docs/superpowers/audit-authz.md` except L-4 (documented-and-deliberate,
no fix direction given, not in this task's scope). Nothing from
`audit-injection.md` / `audit-integrity.md` / `audit-secrets.md` is touched.

## Summary of fixes

| # | Severity | Fix |
|---|---|---|
| H-1 | HIGH | `RoleAssignmentsController.assign`/`revoke` now load the target user and call `assertCanIn(actor, 'role:assign', target.orgUnitId)` — the fourth check, alongside the three that already existed. |
| M-1 | MEDIUM | `GroupsController.addChildGroup` now also loads the CHILD group and calls `assertCanIn` against its org unit (skipped only when the child is itself global). |
| M-2 | MEDIUM | A group with `org_unit_id = NULL` now requires a GLOBAL grant (`scopePathsFor(...) === null`) to create, update, or manage members of — mirroring `OrgUnitsController.create`'s root case. `addMember` also now scope-checks the member being added. |
| M-3 | MEDIUM | `JwtGuard` validates `sub`/`preferred_username` with explicit `typeof`/length checks instead of a cast + truthy check. `PermissionEngine.resolveActor` binds `principal.username` via `sql.param` (defence in depth). |
| L-1 | LOW | Documented, not denied — see "L-1 decision" below. |
| L-2 | LOW | `GroupsController.list`'s `?userId=` branch now loads the target user and calls `assertCanIn(actor, 'user:read', target.orgUnitId)` when the user exists. |
| L-3 | LOW | `ImportsController.resolveUpdateRow` now narrows with `user:update`, not `user:create`. |

## H-1 (HIGH) — role assignment now scope-checks the target principal

`role-assignments.controller.ts`: `assign` loads the target user and calls
`assertCanIn` **before** `assertCanAssignRole`/`assertCanModifyPrincipal`
(all three still run before the transaction opens, unchanged shape).
`revoke` loads the target inside the existing transaction, alongside the
two checks already there, all three passed `tx` explicitly (same
finding-C1 discipline Wave A established). `RoleAssignmentsController` now
depends on `UsersRepository`.

The class doc comment's "THE THREE CHECKS" became "THE FOUR CHECKS,"
documenting why (2) is independent of both (3) [scope of the grant] and
(4) [rank of the target].

## M-1 (MEDIUM) — group nesting now scope-checks the child

`addChildGroup` loads `parsed.childId` and calls `assertCanIn(actor,
'group:manage_members', child.orgUnitId, tx)` whenever the child has a
real org unit (skipped when the child is itself global — decision 1, per
the audit's explicit instruction to respect it). The parent-side check
(`requireGroup`) is unchanged.

## M-2 (MEDIUM) — global groups now require a global grant to manage; members are scope-checked on add

`requireGroup` (shared by every write handler) now branches on a global
group: reads (`group:read`, the default) are **unchanged** — decision 1's
visibility rule stands. Any other action requires
`scopePathsFor(actor, action) === null`, otherwise `ForbiddenError`. The
same gate was added to `create`'s global-group branch (previously skipped
`assertCanIn` unconditionally).

`addMember` additionally loads the target user and calls `assertCanIn(actor,
'group:manage_members', member.orgUnitId, tx)` — closing the "any
directory user into any in-scope group" half of the finding.
`removeMember` is deliberately unchanged (revoking membership never grants
anything).

This reverses two previously-**documented-as-deliberate** decisions
(`GroupsController.create`'s and `requireGroup`'s doc comments both said
"any scope, anywhere" for a global group) — the doc comments were rewritten
in place to record why finding M-2 supersedes that reasoning
(`SyncWorker.reconcileUser` pushing local membership into real Keycloak
groups, a downstream authorization primitive).

`GroupsController` now depends on `UsersRepository`.

## M-3 (MEDIUM) — `preferred_username` validated as a string; `resolveActor` uses `sql.param`

`jwt.guard.ts`: `const username = payload.preferred_username as string |
undefined; if (!subject || !username)` became explicit `typeof subject
!== 'string' || subject.length === 0 || typeof username !== 'string' ||
username.length === 0` — every non-string shape (array, nested array,
number, boolean, object) is now a generic 401 at the authentication
boundary, before `resolveActor` ever sees it. `subject` is hardened the
same way (the original code's `!subject` caught empty string; a bare
`typeof` check alone would not have).

`permission.engine.ts`: `resolveActor`'s query now reads
`lower(${sql.param(principal.username)})`, not a bare `${principal.username}`
interpolation — the one authorization SQL site that wasn't already doing
this. Defence in depth: `JwtGuard`'s fix means this is no longer reachable
with a non-string value through any real HTTP call, but the query can no
longer change SHAPE based on the value regardless.

## L-1 decision — `GET /me` is documented as a token echo, not denied

Decided **not** to gate `/me` through `PermissionEngine.resolveActor`
(which would make a `pending`/`suspended`/`deactivated` principal 403,
matching `/self`). Two things drove this, in order:

1. **Something concrete depends on the current contract.**
   `test/jwt.guard.spec.ts` deliberately targets `MeController` because it
   carries no dependency beyond `JwtGuard` — that isolation is what lets it
   exercise JwtGuard's claim validation (missing/malformed
   `sub`/`preferred_username`, wrong issuer/audience, `alg:none`, expired,
   ...) with **no database at all**. Making `/me` resolve through the DB
   would entangle a guard-layer unit test with a full Postgres-backed
   active-user fixture for every one of its cases, for a route that
   already has an equivalent, actively-used session check elsewhere
   (`GET /self`, which DOES resolve through `resolveActor`, and is
   documented in `guard-coverage.spec.ts` as the "authenticated but not
   authorized" exemption pattern this shape of route already follows).
2. **It leaks nothing new.** `/me` echoes exactly the claims the caller's
   own already-verified token carries. There is no information disclosure
   to a caller who, by construction, already holds that exact token.

Checked whether anything in `apps/web` depends on the 200:
`HomePage.tsx` is the only caller, and it fetches `/me` once, right after
`auth.isAuthenticated` flips true (i.e. right after OIDC login), purely to
display "signed in as" — never as a polled liveness probe, never gating
anything. No production behaviour depends on a revoked account being
denied at `/me` specifically.

`MeController` now carries an extensive doc comment recording this
decision and its reasoning, per the task's "either deny, or state
explicitly why echoing your own principal is safe" instruction. No code
behaviour changed.

## L-2 — `GET /groups?userId=` now scope-checks the supplied user

When `?userId=` resolves to a real user, `assertCanIn(actor, 'user:read',
target.orgUnitId)` runs before entering the effective-membership branch.
A **nonexistent** id is deliberately left undistinguished from "a real
user in no groups" (both were already, and remain, an empty page) — this
fix does not add a new existence oracle on top of the one already
documented and accepted for this specific filter.

## L-3 — bulk import UPDATE rows now narrow with `user:update`

`ImportsController.resolveUpdateRow`'s `assertCanIn(actor, 'user:create',
existing.orgUnitId)` → `assertCanIn(actor, 'user:update', ...)`. Confirmed
not exploitable today (every role holding `user:create` also holds
`user:update`, and the whole controller is gated on `user:create` at
`PermissionGuard` besides) — pinned with a `vi.spyOn(engine, 'assertCanIn')`
test instead of an HTTP-level 403, since no live 403 is constructible from
today's role catalog.

## Files changed

Source: `apps/api/src/authz/role-assignments.controller.ts`,
`apps/api/src/groups/groups.controller.ts`, `apps/api/src/auth/jwt.guard.ts`,
`apps/api/src/authz/permission.engine.ts`, `apps/api/src/auth/me.controller.ts`,
`apps/api/src/imports/imports.controller.ts`.

Tests: `apps/api/test/role-assignments.write.spec.ts`,
`apps/api/test/scope-narrowing.spec.ts`, `apps/api/test/groups.write.spec.ts`,
`apps/api/test/groups.controller.spec.ts` (provider only, no new tests),
`apps/api/test/outbox-emission.spec.ts`, `apps/api/test/jwt.guard.spec.ts`,
`apps/api/test/permission.engine.spec.ts`, `apps/api/test/imports.write.spec.ts`.

No schema, migration, or non-authz file touched.

## Existing tests that changed meaning, and why

Four pre-existing `groups.write.spec.ts` tests asserted the OLD, vulnerable
behaviour by name ("...with no assertCanIn check") and had to be corrected,
not just extended — each now asserts 403 and is paired with a new,
adjacent positive-control test proving the legitimate case (a truly global
actor) still works:

- `POST /groups` (global, scoped actor): 201 → 403, + new global-actor 201 test.
- `PATCH /groups/:id` (global, scoped actor): 200 → 403, + new global-actor 200 test.
- `POST /groups/:id/members` (global group, scoped actor): 201 → 403, + new global-actor test.
- `POST /groups/:id/child-groups` (global parent, scoped actor): 201 → 403, + new global-actor test.

A fifth, `"adds a member from a completely different org unit, since
membership narrows on the group, not the member"`, documented the OLD
member-scope behaviour as intentional; it now asserts 403, with a new
adjacent test (`"...DESCENDANT of the group's own scope..."`) pinning that
an in-scope (including subtree) member add still works.

## New regression tests

`scope-narrowing.spec.ts` gained the role-assignment section the task
called out by name — `describe('POST/DELETE /users/:id/roles (role
assignment)', ...)`, using the audit's own fixture shape (`acme` /
`acme.sales` / disjoint `otherco`). Declared **last** in the file and
deliberately does not call `resetTables` between tests (every other block
in that file only exercises read routes or seeds via direct repository
calls, so `DELETE FROM users` between tests never conflicts with anything
there; this block makes real HTTP writes that legitimately commit an
`audit_log` row once the fix lands, and `audit_log` is append-only, so a
later `resetTables` would hit its FK — this file's own new comment records
this so nobody "fixes" the ordering later).

`role-assignments.write.spec.ts` gained a dedicated H-1 block with four
tests: reject-grant, reject-revoke (symmetric), a positive in-scope
control, and a direct check that the would-be grantee gains no assignments
at all.

`groups.write.spec.ts`'s "nested child groups" section gained an M-1
reproduction that deliberately does **not** depend on M-2's fix (an
in-scope, non-global parent + a foreign, non-global child) — proving M-1
closes the bug on its own, not merely as a side effect of M-2 blocking
global-group creation. It also asserts the read-amplification never opens
up (`effective-members` stays empty).

`jwt.guard.spec.ts` gained 11 cases for every non-string
`preferred_username`/`sub` shape from the audit's reproduction table
(single/nested/two-element/empty array, number, boolean, object,
empty-string on both claims) plus one positive control.
`permission.engine.spec.ts` gained one defence-in-depth test that forges a
non-string `username` (bypassing TypeScript) directly against
`resolveActor`.

`outbox-emission.spec.ts` gained three representative outbox-zero tests
(M-2 global-create, M-1 child-scope, M-2 member-scope) — one per NEW
denial mechanism, matching this file's own documented convention ("audit
row and outbox event share the same transaction, so one representative
case per resource area is enough" — already stated in its header comment)
rather than duplicating every rejection path from the write-spec files.

**Every new denial-path test asserts zero new audit rows** (and, for H-1
and the three representative group cases above, zero new outbox events
too — the remaining group cases rely on the same-transaction argument the
codebase already documents and enforces elsewhere).

## Counterfactual verification

Per this branch's own established practice (Wave A), each major fix was
verified by `git stash push -- <source file(s)>`, running the new tests
against the pre-fix code, confirming they fail for the right reason, then
`git stash pop`:

- **H-1** (`role-assignments.controller.ts` alone): all 3 new
  reject/would-be-grantee tests failed — `expected 403, got 201`/`got 200`
  — the positive-control test (unaffected by the bug) still passed.
- **M-1/M-2** (`groups.controller.ts` alone): all 6 new reject tests
  failed, all with `expected 403, got 201`/`got 200`; the other 29 tests
  in the file were unaffected.
- **M-3** (`jwt.guard.ts` + `permission.engine.ts` together): 9 failed
  exactly as predicted (8 of the 11 new `jwt.guard.spec.ts` cases — the
  3 that were already correctly rejected pre-fix, by design, still
  passed — plus the `permission.engine.spec.ts` defence-in-depth test).
  That last failure is the clearest reproduction in this whole pass:
  `engine.resolveActor({ username: ['god'] })` **resolved successfully**
  to the real `god` user (`{ username: "god", ... }`), proving the exact
  "authenticates as god" finding directly at the unit level, not merely
  inferred.

All three counterfactuals were restored (`git stash pop`) and the full
suite re-verified green afterward.

## Verification

- `pnpm --filter @idm/api build`: exit 0.
- `pnpm --filter @idm/api test`: **48 files, 594 tests passed** (564
  baseline + 30 new). Breakdown of the 30: `jwt.guard.spec.ts` +11,
  `groups.write.spec.ts` +6, `role-assignments.write.spec.ts` +4,
  `scope-narrowing.spec.ts` +4, `outbox-emission.spec.ts` +3,
  `permission.engine.spec.ts` +1, `imports.write.spec.ts` +1.
  `groups.controller.spec.ts` gained a provider only (0 new tests — its
  actor is already global, unaffected by the new checks).
- `pnpm --filter @idm/api db:generate`: `No schema changes, nothing to
  migrate` — confirmed no new migration file in `git status`.
- `pnpm --filter @idm/api smoke:dev`: green (`GET /users` → 200, 12 items;
  `GET /groups` → 200, 5 items).
- **Live** (real dev server, real Keycloak-issued token for
  `admin@example.com` / `idm-test-client` direct grant): a throwaway
  script reproduced H-1's exact scenario — `admin@example.com`'s local
  role assignment temporarily reassigned from its normal global
  `super_admin` to `super_admin` scoped to a freshly-created `acme.sales`,
  against a disjoint `otherco` root holding the victim (mirroring the
  audit's own live setup, since that's the one identity this task's
  environment provides real credentials for). All four checks passed:
  baseline `GET /users/<victim>` → 403; the attack, `POST
  /users/<victim>/roles {roleKey: super_admin, scopeOrgUnitId:
  <acme.sales>}` → **403** (was 201); the symmetric revoke direction →
  **403**; and the positive control, granting a role to an in-scope
  colleague → **201**, proving the fix narrows who can be targeted without
  breaking the feature. The database was restored afterward (verified via
  `docker exec ... psql`: zero leftover users/org units, `admin@example.com`
  back to exactly one `super_admin` / `scope_org_unit_id: NULL` row) and
  the throwaway script deleted (never committed).
- Compose stack (`identity-manager-postgres-1`, `identity-manager-keycloak-1`)
  left running throughout, untouched. Port 3000 confirmed free before and
  after every server-booting step.
- Working tree clean except the intended source/test diffs (verified via
  `git status`); the four other auditors' untracked files
  (`audit-injection.md`, `audit-integrity.md`, `audit-secrets.md`,
  `security-audit-input.md`) were left alone, matching Wave A's own
  hygiene note.

## Concerns / follow-ups (not fixed here, out of this pass's scope)

- **L-4** (unknown `role_key` on the target → unmapped 500) is untouched,
  as instructed — the audit itself calls it "documented and deliberate"
  with no fix direction given.
- `docs/superpowers/audit-injection.md`, `audit-integrity.md` (beyond the
  already-landed C1), and `audit-secrets.md` are untouched — out of this
  task's AUTHORIZATION-only scope.
- M-2's reversal of the two "any scope, anywhere may manage a global
  group" decisions is a genuine behaviour change for any real deployment
  that has scoped (non-global) admins currently relying on it to manage
  global groups. Nothing in this codebase's own fixtures/seed data does
  so, but a real environment might; worth a release note if this ships.
- The M-1 fix does not add a symmetric check to `removeChildGroup` (only
  the parent is scope-checked there, unchanged) — removing a nesting edge
  cannot itself disclose anything, so this was judged out of scope, same
  reasoning already applied to `removeMember`.
