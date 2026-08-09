# 08 — Authorization model

Authorization has **three independent dimensions**. All of them apply to every guarded
route, and none subsumes another.

1. **Action** — does the actor hold this permission *anywhere*?
2. **Scope** — does their holding cover *this particular resource*?
3. **Rank** — for privilege writes, does the target *outrank* them?

## Identity resolution

An authenticated Keycloak principal becomes a local **Actor** by matching
`preferred_username` against `users.username`.

The resolution **fails closed**:

- No matching local user → denied.
- Local user whose `status` is not exactly `active` → denied. This is an **allow-list**
  (`=== 'active'`), not a deny-list of known-bad statuses, so a status added to the enum
  later is denied by default rather than granted by default.
- Resolved **fresh on every request**, never cached — a revoked or deactivated account
  is denied on the very next request, not after a cache expiry.

`GET /me` is the one deliberate exception: it is a pure echo of already-verified JWT
claims and does not resolve an actor at all. A client that needs "is this account still
active right now" must use `/self` or any permission-gated route, never `/me`.

## Actions

The complete catalog (`apps/api/src/authz/actions.ts`):

| Action | Governs |
|---|---|
| `user:read` | Reading people; also gates the attribute-definition catalog |
| `user:create` | Creating people; also gates CSV import preview **and** commit |
| `user:update` | Editing a person |
| `user:deactivate` | Deactivating a person |
| `group:read` | Reading groups, members and effective members |
| `group:create` | Creating a group |
| `group:update` | Editing a group's name, description, attributes |
| `group:manage_members` | Adding/removing user members and nested child groups |
| `org_unit:read` | Reading the org tree |
| `org_unit:create` | Creating an org unit |
| `role:assign` | Reading, granting and revoking role assignments |
| `audit:read` | The audit log and outbox dead letters |
| `connector:read` | Connector target config and health |
| `connector:manage` | Editing target config, attribute mappings, running reconciles |

## Roles

| Role | Rank | Actions |
|---|---|---|
| `super_admin` | 40 | **everything** |
| `user_admin` | 30 | all `user:*`, all `group:*`, `org_unit:read` |
| `help_desk` | 20 | `user:read`, `user:update`, `group:read`, `org_unit:read` |
| `auditor` | 10 | `user:read`, `group:read`, `org_unit:read`, `audit:read`, `connector:read` |
| `read_only` | 0 | `user:read`, `group:read`, `org_unit:read` |

**The catalog is static code, not database rows.** A permission table is itself a
privilege-escalation surface; these grants should change only through code review. It is
built on `Object.create(null)`, so a lookup with a key like `constructor` or
`__proto__` resolves to `undefined` rather than an inherited, truthy value — `role_key`
is a Postgres enum, and `ALTER TYPE role_key ADD VALUE 'constructor'` is ordinary valid
SQL.

Notice what is **not** granted:

- `role:assign` — only `super_admin`. Getting role assignment wrong is privilege
  escalation, so nothing below the top of the catalog can touch it.
- `connector:manage` — only `super_admin`, deliberately mirroring `role:assign`. Editing
  target config or triggering a reconcile (**including a dry run**, which still makes a
  real outbound call) is a structural, directory-wide capability with outsized blast
  radius, not ordinary directory work.
- `auditor` gets `connector:read` but not `connector:manage` — per-target health and
  dead letters are the same category of operational visibility that role exists to see.

## Scope

A role assignment carries a **scope**: an org unit, or `NULL` for global.

Scope is evaluated over the org tree's `ltree` path, so it is **transitive** — an actor
scoped to `acme.sales` reaches `acme.sales.emea` and everything below it.

`PermissionEngine.scopePathsFor(actor, action)` returns:

| Return | Meaning |
|---|---|
| `null` | **Unrestricted** — every assignment granting this action is global |
| `[]` | **Entitled nowhere** — holds the action, but at no reachable scope |
| `['acme.sales', …]` | The paths the actor's grants cover |

`null` and `[]` are never collapsed. An empty array means "filter that matches nothing"
and produces an empty page — never, ever the unfiltered list.

### How scope is applied

- **List endpoints** filter both `items` **and** `total`. A scoped operator never sees a
  count implying records they cannot open.
- **Single-resource reads and writes** call `assertCanIn(actor, action, orgUnitId)`.
- **An out-of-scope resource that exists returns 403, not 404.** The directory's
  existence is not secret; its contents are.
- **A group with `orgUnitId = NULL` is global** — visible to and writable by any actor
  holding the relevant action, regardless of their own scope.

### Where a global grant is required

Some resources have **no containing org unit**, so there is nothing to narrow a request
*to*. For these, holding the action somewhere is not enough — the grant itself must be
global (`scopePathsFor(...) === null`):

| Route | Why |
|---|---|
| `GET /audit` | `audit_log` has no org unit, and snapshots name principals from other org units. A scoped view would be silently partial. |
| `GET /outbox/dead-letters` | Events are keyed by `(aggregate, target)` with no org unit, and carry raw target error text. |
| `PATCH /connector-targets/:target` | Global infrastructure. A Sales-scoped admin could otherwise disable `keycloak` and stop credential sync organisation-wide. |
| `POST /connector-targets/:target/reconcile` | Walks the **whole** directory and pushes every principal. |
| `POST`/`PATCH`/`DELETE /attribute-target-mappings/*` | Decides what data leaves the system, for everyone. |
| `POST /org-units` **with no parent** | A root has no containing scope. |
| `POST /groups` **with no org unit** | A global group's membership is pushed into real Keycloak groups. |

Connector **read** routes are deliberately left scoped-friendly: reading non-secret
config and a health status from a narrower scope is not the escalation; mutating global
infrastructure is.

## Rank — privilege guards

Two guards protect role assignment specifically.

### `assertCanAssignRole(actor, roleKey, scopeOrgUnitId)`

You may only grant a role **you hold yourself**, at a scope **your own holding covers**.

The critical case: **a scoped holding can never produce a global grant.** A
`super_admin` scoped to Sales cannot grant global `super_admin` — that is exactly the
path that turns a departmental account into a domain-wide one.

### `assertCanModifyPrincipal(actor, targetUserId)`

The target must not **outrank** the actor, by `ROLE_RANK`. This is independent of scope
entirely: a `help_desk` scoped to Sales must not be able to touch a global `super_admin`
who happens to sit in Sales.

Rank also guards ordinary user writes — `PATCH /users/:id`, `POST
/users/:id/deactivate`, and every import row — so a lower-ranked admin cannot edit or
deactivate a higher-ranked one.

### The four checks on a role write

Both `POST /users/:id/roles` and `DELETE /users/:id/roles/:assignmentId` run all four,
in this order:

1. `@RequirePermission('role:assign')` — do you hold it anywhere?
2. `assertCanIn(actor, 'role:assign', target.orgUnitId)` — can you reach this **person**?
3. `assertCanAssignRole(...)` — may you grant **this role** at **this scope**?
4. `assertCanModifyPrincipal(...)` — does the target **outrank** you?

Check 2 is ordered first among the three handler-level checks: there is no reason to
reveal "you may not grant this role at this scope" to an actor who cannot reach the
target user in the first place.

**Revoke evaluates all four against the grant being removed**, using the assignment
row's own `roleKey`, `scopeOrgUnitId` and `userId` — never re-trusting the URL. An actor
who could not have created a grant must not be able to destroy it, or revocation becomes
a side door around assignment's own narrowing.

`:assignmentId` must belong to `:id`: a real assignment id belonging to a different user
returns 404, exactly like a nonexistent one.

## Bootstrapping

Every grant path the API exposes requires the grantor to already hold `role:assign` —
which nobody does on an empty database. `pnpm bootstrap:admin` is the only way out, and
it **bypasses all four checks deliberately**.

It is a local operator script, not an HTTP route, and it is not wired into the Nest
application at all. Anyone able to run it already holds `RUNTIME_DATABASE_URL`, which is
already enough to read and write every row directly — so granting `super_admin` through
it adds no capability beyond what that access already implies. It just does it through
the application's own repositories instead of raw SQL.

## Debugging a 403

Work down this list:

1. **Is there a local user row?** The principal's `preferred_username` must match
   `users.username` exactly (case-insensitively). No row → 403 on everything. Run
   `bootstrap:admin`.
2. **Is that user `active`?** `pending`, `suspended` and `deactivated` are all denied.
3. **Do they hold the action at all?** `GET /self/permissions` returns their effective
   action list. An empty list is a valid state, not an error.
4. **Does their scope cover this resource?** Remember: an out-of-scope resource that
   exists is 403, not 404. If the message mentions scope narrowing, this is it.
5. **Does the route need a global grant?** See the table above. The error message says
   so explicitly and explains why.
6. **For a role write** — do they hold the role being granted, at a scope covering the
   grant, and does the target outrank them?

`GET /self/roles` returns the caller's own assignments, which is what the console's
scope picker uses.

## Guard coverage is tested

`guard-coverage.spec.ts` asserts that every controller carries `JwtGuard` and — unless
explicitly listed as authentication-only — `PermissionGuard` with a
`@RequirePermission` on every route. The only exemptions are `GET /me` and the `/self`
routes, both documented above. A new controller added without guards fails the suite.
