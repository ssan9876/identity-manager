# Security Audit — Authentication & Authorization

**Auditor lens:** vertical escalation, horizontal escalation / IDOR, authentication bypass,
scope-evaluation freshness, guard coverage, authz fail-open.
**Date:** 2026-08-06 · **Branch:** `master` · **Method:** live probes against a real booted
NestJS app + real Postgres + real RS256 JWT verification. Two headline findings additionally
reproduced end-to-end against `src/main.ts` on port 3999 with a **real Keycloak-issued token**
(`idm-test-client` direct grant), backed by a throwaway Postgres container. The shared dev DB
on 5432 was never written to; the compose stack was never restarted.

---

## Summary

| # | Severity | Finding |
|---|---|---|
| H-1 | **HIGH** | `POST/DELETE /users/:id/roles` never scope-checks the **target principal**. A scoped `super_admin` can grant and revoke roles on principals in org units they cannot read, update, or even see. |
| M-1 | **MEDIUM** | `POST /groups/:id/child-groups` narrows only against the **parent** group. An actor can nest an out-of-scope group under a group they control and then read its roster through effective-membership. |
| M-2 | **MEDIUM** | Global groups (`org_unit_id IS NULL`) are manageable by any holder of `group:manage_members` at any scope, and membership is synced into real Keycloak groups — the downstream authorization primitive. |
| M-3 | **MEDIUM** | `JwtGuard` never validates that `preferred_username` is a *string*. A non-string claim is accepted, silently changes the generated SQL, and produces unhandled 500s. |
| L-1 | LOW | `GET /me` returns 200 for a `pending`/`suspended`/`deactivated` principal. |
| L-2 | LOW | `GET /groups?userId=<other user>` discloses an out-of-scope user's memberships (narrowed to the actor's own group scope, but the *user* is never scope-checked). |
| L-3 | LOW | Bulk-import **update** rows are authorized with `user:create`, not `user:update`. |
| L-4 | LOW | A target principal holding a `role_key` outside `ROLE_RANK` produces an unmapped 500 (fail-closed, but un-triageable and permanently un-modifiable). |

No **CRITICAL** finding. No path was found from an unprivileged or unauthenticated actor to a
global grant, and no authentication bypass was found.

---

## H-1 (HIGH) — `role:assign` / `role:revoke` do not scope-check the target principal

### What

`RoleAssignmentsController` runs exactly three checks (its own doc comment enumerates them as
"THE THREE CHECKS"):

1. `PermissionGuard` — does the actor hold `role:assign` *anywhere*?
2. `PrivilegeGuards.assertCanAssignRole(actor, roleKey, scopeOrgUnitId)` — may they grant
   **this role** at **this scope**?
3. `PrivilegeGuards.assertCanModifyPrincipal(actor, targetUserId)` — does the target outrank
   them?

There is no fourth check asking **"may this actor reach this target user at all?"**
`assertCanAssignRole` validates the *scope of the grant*, never the *location of the grantee*.
`assertCanModifyPrincipal` compares rank only — and its own doc comment says so explicitly:

> **CONTRACT — what this does NOT check: org-unit scope, on either side.** … Callers MUST
> additionally pair this with `permissionEngine.assertCanIn(actor, 'user:update',
> target.orgUnitId)` … before this method is ever reached.

`role-assignments.controller.ts` is the **only** caller in the tree that does not honour that
contract. Verified by enumerating every call site:

| Call site | `assertCanIn` paired? |
|---|---|
| `users.controller.ts:313` (PATCH) | yes — `user:update` |
| `users.controller.ts:385` (deactivate) | yes — `user:deactivate` |
| `imports.controller.ts:457` (import update) | yes — `user:create` (see L-3) |
| `authz/role-assignments.controller.ts:125` (assign) | **no** |
| `authz/role-assignments.controller.ts:200` (revoke) | **no** |

`scope-narrowing.spec.ts` covers users, org units and groups. It has **no role-assignment
section at all**, and `role-assignments.write.spec.ts` only ever targets users inside the
actor's own scope — so the gap is invisible to the 554-test suite.

### Reproduction (real app, real Keycloak token)

Setup: org tree with two **disjoint roots** — `acme` (containing `acme.sales`) and `otherco`.
`admin@example.com` is a `super_admin` **scoped to `acme.sales`**. `victim` lives in `otherco`.

```
GET   /users/<victim>              -> 403 {"code":"FORBIDDEN","message":"not permitted: user:read"}
PATCH /users/<victim>              -> 403 {"code":"FORBIDDEN","message":"not permitted: user:update"}
POST  /users/<victim>/roles
      {"roleKey":"super_admin","scopeOrgUnitId":"<acme.sales id>"}
                                   -> 201 {"id":"fe2f4380-…","userId":"<victim>",
                                           "roleKey":"super_admin","scopeOrgUnitId":"<sales>"}
```

Database after the call — the grant is committed, audited and outboxed for a principal the
actor is forbidden from reading:

```
     username      |  role_key   |          scope_org_unit_id
-------------------+-------------+--------------------------------------
 admin@example.com | super_admin | fc9f5bfe-…
 victim            | super_admin | fc9f5bfe-…     <-- planted cross-boundary

 audit_log:     role:assign | role_assignment
 outbox_events: user | daa4d4c0-… (victim) | updated
```

Follow-on, confirmed in the Testcontainers harness: the newly-granted out-of-scope principal
immediately reads Sales users (200) and can itself assign roles (201). The **revoke** direction
is symmetric — a Sales-scoped `super_admin` successfully deleted a `read_only@sales` grant held
by an OtherCo principal (200).

### Impact

Bounded but real. The *privilege conferred* is still capped by `assertCanAssignRole` (a scoped
holder cannot mint a global grant — verified, see "what did not work"). What is **unbounded is
the set of principals it can be conferred on**. A departmental administrator can:

- confer their department's administrative privileges on any account in the directory,
  including accounts in subtrees they are forbidden from viewing (contractors, executives,
  service identities) — an account the *real* owner of that subtree can neither see coming nor
  is notified about;
- strip any grant scoped inside their own subtree from any principal anywhere;
- generate audit rows and Keycloak-bound outbox events for users outside their scope.

This breaks the design document's stated guard — *"an administrator … cannot modify a principal
whose privileges exceed their own"* extended in practice to *"cannot modify a principal outside
their scope"* — on the one endpoint the controller's own header calls "the most
security-sensitive writes in the system."

### Fix direction

In `assign`, load the target user and add the missing pairing before the transaction opens:

```ts
const target = await this.users.findById(userId)
if (target === null) throw new NotFoundError('user', userId)
await this.engine.assertCanIn(request.actor, 'role:assign', target.orgUnitId)
await this.privileges.assertCanAssignRole(...)
await this.privileges.assertCanModifyPrincipal(...)
```

In `revoke`, the same check against the loaded `current.userId`'s org unit, inside the existing
transaction alongside the two checks already there. Then add a role-assignment block to
`scope-narrowing.spec.ts` so the property is pinned the way it is for users/org-units/groups.

---

## M-1 (MEDIUM) — Group nesting narrows only against the parent, leaking out-of-scope rosters

### What

`GroupsController.requireGroup` is called with `:id` — the **parent** — for all four membership
mutations. `addChildGroup` never checks the **child** group's own org unit. The doc comment
justifying "narrow against the parent only" reasons about *members* ("membership is a fact about
the GROUP's roster, not about the member"); that reasoning does not extend to pulling an entire
out-of-scope **group** into a container the actor can read, which changes what
`GET /:id/effective-members` will disclose.

Combined with decision 1 (a global group has no org unit, so `requireGroup` skips the check
entirely), the parent can always be chosen to be unguarded.

### Reproduction (real app, real Keycloak token)

Actor: `super_admin` scoped to `acme.sales`. `OtherCo Secret` is a group in `otherco`
containing `victim`.

```
GET  /groups/<otherco-secret>                -> 403 FORBIDDEN "not permitted: group:read"
GET  /groups/<otherco-secret>/members        -> 403 FORBIDDEN "not permitted: group:read"

POST /groups {"name":"Innocuous Global"}     -> 201  (global group, orgUnitId null)
POST /groups/<global>/child-groups
     {"childId":"<otherco-secret>"}          -> 201            <-- no check on the child

GET  /groups/<global>/members                -> 200 {"users":[],"groups":["<otherco-secret>"]}
GET  /groups/<global>/effective-members      -> 200 ["daa4d4c0-…"]   == victim's user id
```

Two things the actor was explicitly denied 30 seconds earlier are now readable: the existence
and id of the out-of-scope group, and its full user roster.

Bounds confirmed: the reverse direction is closed — `POST /groups/<otherco-secret>/child-groups`
is 403 because the *parent* is checked, and `DELETE /groups/<otherco-secret>/members/<user>` is
403. So this is a read-amplification, not a write into the foreign group.

### Fix direction

In `addChildGroup`, narrow against the child as well:

```ts
const child = await this.groups.findById(parsed.childId, tx)
if (child === null) throw new NotFoundError('group', parsed.childId)
if (child.orgUnitId !== null) {
  await this.engine.assertCanIn(request.actor, 'group:manage_members', child.orgUnitId)
}
```

Alternatively, make `effective-members` re-narrow each contributing group. The `assertCanIn`
on the child is the cheaper and more obviously correct fix.

---

## M-2 (MEDIUM) — Global groups are a cross-scope access grant, and they sync to Keycloak

### What

Decision 1 states any actor holding `group:create` / `group:update` / `group:manage_members`
at **any** scope may freely create and manage a **global** group. `requireGroup` skips
`assertCanIn` whenever `group.orgUnitId === null`, and `create` skips it whenever `orgUnitId`
is omitted. Separately, `addMember` never checks the *member's* org unit.

The design note treats this as internally consistent, but `SyncWorker.reconcileUser` calls
`KeycloakAdminClient.ensureGroup` + `setUserGroups`, so local group membership becomes **real
Keycloak group membership** — the standard mechanism downstream applications use for
authorization (role mappings, client scopes, token claims). Group membership in this system is
therefore an access-granting primitive with weaker authorization than `role_assignments`.

### Reproduction

Actor: `user_admin` scoped to Sales (rank 30, cannot touch role assignments at all).

```
POST /groups/<global>/members {"userId":"<eng user>"}     -> 201   (member never scope-checked)
POST /groups/<sales>/members  {"userId":"<eng user>"}     -> 201
POST /groups/<global>/members {"userId":"<otherco user>"} -> 201
PATCH /groups/<global> {"name":"…"}                       -> 200   (renames a global group)
```

Nothing stops the same actor adding **themselves** to any global group. If any global group
carries downstream privilege in Keycloak, that is vertical escalation outside this system's own
RBAC — which is precisely the access model an IdP exists to control.

### Fix direction

Gate global groups the way `OrgUnitsController.create` already gates a root org unit: require a
**global** grant (`scopePathsFor(actor, action) === null`) to create, update, or manage members
of a group with no org unit. Separately, decide deliberately whether `addMember` should narrow
against the member's org unit — today it does not, so a Sales admin can place any directory
user into a Sales group and thereby into a Sales Keycloak group.

---

## M-3 (MEDIUM) — `JwtGuard` does not validate that `preferred_username` is a string

### What

`jwt.guard.ts:72`:

```ts
const username = payload.preferred_username as string | undefined
if (!subject || !username) { throw new UnauthorizedException('invalid token') }
```

The `as string` cast suppresses the compiler; `!username` only rejects falsy values. `Principal.username: string` is therefore a **type lie** for any non-string claim, and the value flows
straight into `PermissionEngine.resolveActor`'s
`` sql`lower(${users.username}) = lower(${principal.username})` `` — the one authorization SQL
site in the codebase that does **not** wrap its value in `sql.param`. Every other site
(`canIn`, `assertCanAssignRole`, `UsersRepository.scopeFilter`, `GroupsRepository.scopeFilter`)
carries a long comment explaining that Drizzle splices a bare JS array as a parenthesized list
of individually-bound scalars rather than one bound value. `resolveActor` is the exception.

### Reproduction (signed tokens, real RS256 verification, `GET /users`)

```
preferred_username = "god"              -> 200  (control)
preferred_username = ["god"]            -> 200  authenticates as god
preferred_username = [["god"]]          -> 200  authenticates as god
preferred_username = ["nope","god"]     -> 500  Internal server error
preferred_username = []                 -> 500  Internal server error
preferred_username = 42 / true / {…}    -> 403  FORBIDDEN
```

`["god"]` degrades to `lower(('god'))`; two elements become a row constructor and blow up
inside the query.

### Impact

Not directly attacker-controlled today — Keycloak's stock `preferred_username` mapper emits a
string, so an attacker would need a multivalued protocol mapper configured on the realm. But:
it is unvalidated input at the authentication boundary; the failure mode is an unhandled 500
rather than a clean 401/403 (the shape this codebase elsewhere treats as unacceptable); and a
single token with `preferred_username: []` reliably 500s every authenticated request made with
it. `jwt.guard.spec.ts` tests a **missing** `preferred_username` but no non-string one.

### Fix direction

```ts
const username = payload.preferred_username
if (typeof subject !== 'string' || typeof username !== 'string' || username.length === 0) {
  throw new UnauthorizedException('invalid token')
}
```

and, defence in depth, bind via `sql.param(principal.username)` in `resolveActor` so the value
can never alter the query's shape.

---

## L-1 — `GET /me` returns 200 for a non-active principal

`MeController` carries `@UseGuards(JwtGuard)` only and echoes `request.principal` verbatim.
A `pending`, `suspended` or `deactivated` user gets 200 while every other route gives 403:

```
GET /me    as deactivated principal -> 200 {"subject":"…","username":"deaduser","email":null}
GET /self  as deactivated principal -> 403 FORBIDDEN
GET /users as deactivated principal -> 403 FORBIDDEN
```

It leaks nothing the caller's own token does not already contain, so this is informational —
but a client that treats `/me` as its session-validity probe will show a revoked account as
signed in. Fix: resolve through `PermissionEngine.resolveActor` (as `SelfServiceController`
does), or document `/me` as a token echo that is explicitly not a session check.

## L-2 — `GET /groups?userId=` does not scope-check the user

The `userId` filter branch calls `listEffectiveGroupsForUser(userId)` with no check on that
user's org unit; only the resulting *groups* are narrowed. A Sales admin querying an Engineering
user's id gets back that user's memberships in Sales-scoped and global groups — confirming both
the user's existence and their membership. Live: `GET /groups?userId=<eng user>` → 200, 2 items,
while `GET /users/<eng user>` → 403. Fix: `assertCanIn(actor, 'user:read', target.orgUnitId)`
before entering that branch, or accept and document it.

## L-3 — Import updates are authorized with `user:create`

`imports.controller.ts:457` narrows an **update** row with
`assertCanIn(actor, 'user:create', existing.orgUnitId)`. Not exploitable today (every role
holding `user:create` also holds `user:update`), but it is a route/action mismatch that will
misauthorize silently the moment the catalog changes. Fix: use `user:update` for the update
branch.

## L-4 — Unknown `role_key` on the target yields an unmapped 500

`assertCanModifyPrincipal` throws a plain `Error` when the target holds a `role_key` absent from
`ROLE_RANK`. This is documented and deliberate, and it does **fail closed** — verified live by
`ALTER TYPE role_key ADD VALUE 'ghost'`:

```
PATCH /users/<user holding 'ghost'>       -> 500
PATCH /users/<user holding 'constructor'> -> 500
GET /users as an actor holding only 'ghost'        -> 403 FORBIDDEN
GET /users as an actor holding only 'constructor'  -> 403 FORBIDDEN
```

Worth noting only because such a principal becomes permanently un-modifiable through the API
with no actionable error, and because the response is indistinguishable from a genuine bug.

---

## WHAT I TRIED THAT DID NOT WORK

Everything below was attempted live and **held**. This is the more useful half of the report.

### Vertical escalation — no path to a broader grant

- **Scoped → global grant.** A `super_admin` scoped to Sales, attempting a global grant in
  every spelling: `{roleKey}` (omitted scope), `{roleKey, scopeOrgUnitId: null}`,
  `scopeOrgUnitId` = the **parent** org unit, = a **sibling**, = a **disjoint root**. All four
  403 with `not permitted to grant super_admin globally` / `… at that scope`. `assertCanAssignRole`'s ltree containment is correct in both directions.
- **Self-grant by a non-`super_admin`.** `user_admin`, `help_desk` and a role-less user all
  403 at `PermissionGuard` entry before a query runs — `role:assign` is `super_admin`-only in
  `ROLE_PERMISSIONS`.
- **Contradictory assignments.** An actor holding global `read_only` **plus** `super_admin@sales`
  was denied a global `user_admin` grant (403). They *could* grant global `read_only` — correct,
  they hold `read_only` globally; the OR-clause behaves exactly as documented.
- **Widening via the org tree.** Creating a child org unit under one's own scope and granting
  `super_admin` there succeeds — but the child is strictly *narrower*. `POST /org-units` with no
  `parentId` (root) is 403 for any scoped actor; `parentId: null` is a clean 400. There is no
  org-unit update/re-parent endpoint, so an existing unit cannot be moved under a scope.
- **Revoking a grant you could not have made.** A Sales-scoped `super_admin` revoking a
  **global** `read_only` assignment: 403. `revoke` correctly re-runs `assertCanAssignRole`
  against the grant being removed.
- **Rank guard.** `help_desk` → `user_admin` in the same scope: 403. `help_desk` →
  `super_admin` in the same scope: 403. Equal-rank peer: 200 (documented as deliberate; still
  gated by `assertCanIn` on the target's org unit).
- **`ROLE_RANK` / `ROLE_PERMISSIONS` prototype attacks.** Added `constructor` as a real
  Postgres enum value and assigned it. Actor holding only `constructor`: 403 (not escalated).
  Target holding `constructor`: hard throw, never a satisfied comparison. The
  `Object.create(null)` catalogs plus `Object.hasOwn` hold.

### Horizontal escalation / IDOR — every scoped endpoint held except the two above

- Cross-scope **reads**: `GET /users/:id`, `/org-units/:id`, `/org-units/:id/subtree`,
  `/groups/:id`, `/groups/:id/members`, `/groups/:id/effective-members` — all 403 (not 404,
  matching decision 2).
- Cross-scope **writes**: `PATCH /users/:id`, `POST /users/:id/deactivate`, `POST /users` into
  a foreign org unit, `POST /org-units` under a foreign parent, `DELETE /groups/:id/members/:userId`
  on a foreign group — all 403.
- **List narrowing**: a Sales-scoped actor's `GET /users?limit=100` returned exactly the 7
  active Sales users out of 12; `total` matched `items`, so the count query is narrowed too.
  `?orgUnitId=<foreign>` returned an empty page rather than leaking.
- **Bulk import**: a two-row CSV mixing an in-scope and an out-of-scope org unit committed
  **only** the in-scope row, reporting the other as a named failure. An import *update*
  targeting an out-of-scope existing user failed with both
  `not permitted: user:create` **and** `not permitted to modify a more privileged principal` —
  the guard pairing is present here. An `employeeId`-collision takeover (reusing a victim's
  `employeeId` with attacker-controlled email/username/org unit) was rejected on all five
  grounds.
- **Deactivated users** are excluded from default list views (`?status=deactivated` requires
  the explicit filter).

### Self-service — could not inject a user id anywhere

Attempted on `GET /self`, `GET /self/groups`, `PATCH /self`: `?userId=`, `?id=`, a path segment
(`/self/<uuid>` → 404, no such route), body `id`, body `userId`, an `X-User-Id` header, a
top-level `__proto__` carrying `userId`, and duplicated/array query params. Every one either
400'd by name (`.strict()` rejects `id`/`userId`/`status`/`orgUnitId`/`username`/`firstName`)
or resolved to the **caller's own** record. The controller genuinely has no id-shaped input.

Prototype pollution through `PATCH /self`: `{attributes:{__proto__:{polluted:'yes'}}}`,
`{attributes:{constructor:{prototype:{…}}}}`, and a top-level `__proto__` were all either
400'd or stored nothing; `Object.prototype.polluted` was `undefined` before and after; the
stored `attributes` column contained only the legitimate key.

Attribute default-deny held: a `self_editable = false` definition 400s by name through `/self`,
and the documented **merge** semantics preserved an admin-set non-self-editable attribute
across a self edit of a different key (`{"nickname":"n2","clearance":"TOPSECRET"}`).

Non-active callers are rejected first: `PATCH /self` as a suspended user → 403.

### Authentication — no bypass found

`GET /users` and `GET /self` were each attacked with: no header; `Bearer ` empty; garbage;
a hand-forged **`alg:none`** token with a valid payload and empty signature; a token from a
**different issuer**; a token with the **wrong audience**; an **expired** token; and a
lowercase `bearer ` keyword. All 401 with the identical generic `invalid token` /
`missing bearer token` — no oracle. An array `aud` containing `idm-api` is accepted, which is
correct RFC 7519 behaviour.

Principal-status handling: `pending`, `suspended` and `deactivated` local users all 403 — the
`=== 'active'` allowlist in `resolveActor` holds, and there is no `pending` denylist hole.

Username handling: `preferred_username: "GLOBALADMIN"` resolves to `globaladmin` (200) — this
is safe, because `users_username_unique` is a unique index on `lower(username)`, so two
case-variant local users cannot coexist and the `limit(1)` cannot pick arbitrarily. Verified in
the schema. A Turkish dotless-i variant (`globaladmın`) and a zero-width-suffixed username both
403 — Postgres `lower()` does not NFKC-fold, so no normalisation collision.

### Scope freshness — no caching anywhere

- **Role revoked mid-session:** `GET /users` → 200 with 2 items; `DELETE FROM role_assignments`;
  the **very next** request with the *same token* → 403.
- **User moved between org units:** an out-of-scope target read 403; moved into the actor's
  subtree → the next request 200; moved back out → 403 again. No restart, same token.
- **Status flipped mid-session:** actor set to `suspended` → next request 403; back to
  `active` → 200.
- Grepped `permission.engine.ts`, `permission.guard.ts`, `privilege.guards.ts`, `jwt.guard.ts`
  and `actions.ts` for `cache`/`memo`/`Map(`/`WeakMap`/`static`/`globalThis` module-level
  state: **zero** hits in all five. The only module-level state is the two frozen-by-convention
  catalogs. `resolveActor` runs once per request from the DB.

### Guard coverage — walked the live route table, not the source

Enumerated the real Express router of a booted `AppModule` (28 routes) and hit **every one**
anonymously and with a role-less-but-authenticated token:

- `GET /health` → 200 / 200 (open by design)
- `GET /me`, `GET /self`, `GET /self/groups`, `PATCH /self` → 401 / 200 (authentication-only by
  design, exempted in `guard-coverage.spec.ts`)
- **All 23 remaining routes** → 401 anonymous / 403 role-less. No route is reachable without
  both guards, and none is missing `@RequirePermission` (a missing decorator fails closed in
  `PermissionGuard` regardless). No JML, outbox, reconciliation, attribute-definition or audit
  route exists on the HTTP surface at all — the system-actor write paths
  (`lifecycle-cli`, `reconcile-cli`, `SyncWorker`) are CLI/worker-only and cannot be induced
  from a request. `forwardRef` is handled correctly by the coverage spec (there are no feature
  modules today; everything is declared directly on `AppModule`).

### Fail-open probes

- **Unknown action**: not reachable — `Action` is a closed union and `@RequirePermission` is the
  only source; a route with no decorator throws `route declares no permission`.
- **Unknown role key**: fails closed on the actor side (403) and throws on the target side
  (L-4). Neither grants.
- **Actor whose scope org unit was deleted**: `role_assignments.scope_org_unit_id` is
  `ON DELETE CASCADE`, so the assignment vanishes with the unit and the actor drops to 403 at
  guard entry. Confirmed live.
- **`[]` vs `null` scope paths**: I could not reach `[]` through the real guard chain, and
  believe it is unreachable. `scopePathsFor` returns `[]` only when every granting assignment
  has a NULL `scopePath`; `org_units.path` is `NOT NULL` and `scope_org_unit_id` is a real FK,
  so a non-null scope always joins to a path. That leaves "no granting assignments" — which
  `PermissionGuard.assertCanAnywhere` already rejected, using the *same* action every
  controller then passes to `scopePathsFor`. The existing `[]` tests reach it only by stubbing
  `PermissionGuard` out. Every consumer nonetheless implements the `!== undefined && !== null`
  form correctly (checked all four repositories); none uses the `?.length` trap.
- **Duplicated / array params**: `?orgUnitId=a&orgUnitId=b` → 400 (`parseId` rejects arrays
  rather than coercing); `?limit[]=1` and `?userId[]=…` fall back to defaults rather than
  bypassing a filter.

---

## Environment hygiene

- Working tree: **clean**. `git diff --stat` is empty; no committed file was modified. Both
  temporary probe specs (`test/zzz-audit-authz-probe.spec.ts`,
  `test/zzz-audit-authz-probe2.spec.ts`) were deleted. The only untracked paths remaining are
  this report, `security-audit-input.md`, and the other three auditors' probe files, which I
  left alone.
- Compose stack: **untouched**. `identity-manager-postgres-1` (up 20h) and
  `identity-manager-keycloak-1` (up 4h) were never restarted. The shared dev database on 5432
  was never connected to or written to — every probe ran against Testcontainers or a throwaway
  `idm-audit-authz-pg` container on port 15433, which has been removed. Keycloak was used
  read-only (JWKS + one direct-grant token); no realm object was created or modified. No
  `docker login`.
- The probe app ran on port **3999** (verified free before boot, `SYNC_WORKER_ENABLED=false` so
  nothing was pushed into Keycloak) and has been stopped; port 3999 confirmed closed.
