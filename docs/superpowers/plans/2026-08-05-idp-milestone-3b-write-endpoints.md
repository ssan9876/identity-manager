# Identity Provider — Milestone 3b (Scope Narrowing + Write Endpoints) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the per-resource scope gap on reads, then add permission-checked, privilege-guarded, transactionally-audited write endpoints.

**Architecture:** Every read narrows by the actor's scope — lists filter by `scopePathsFor`, single-resource reads assert `canIn` against the target's *current* org unit. Every write runs inside one transaction that also writes its audit row, so a mutation and its record commit together or not at all.

**Tech Stack:** TypeScript, NestJS 10, Drizzle ORM, Postgres 16 (`ltree`), Zod, Vitest, Testcontainers.

**Builds on:** M1 (`f00a61c`), M2 (`a391570`), M3a (`730aa13`) — all merged to `master`. 242 API tests green.

**Plan style note:** this plan specifies contracts, decisions, and the tests that matter. It deliberately does NOT transcribe implementation code — earlier milestones showed plan-embedded code to be this project's largest defect source. Implementers write the code from the contract.

## Global Constraints

- Never generate, transmit, or store a credential. Keycloak owns them.
- Attribute propagation is default-deny.
- **No delete for users.** `deactivated` is terminal. No `DELETE` against `users`.
- Deactivated users are excluded from all default list and search views.
- Authorization enforced in the API, never the UI.
- Testcontainers, never mocks. Single tenant, no `tenant_id`.
- `strict: true`; no `any` / `@ts-ignore` / `@ts-expect-error`.
- Controllers use explicit `@Inject(Token)` for every constructor dependency.
- Any `package.json` change commits `pnpm-lock.yaml`. Any schema change runs `db:generate` and commits the migration + `meta/`.

### Milestone-specific

- **Task 1 is a hard gate.** No write endpoint may land until per-resource narrowing is wired, because the same omission on a write route is privilege escalation rather than disclosure.
- **Every write is audited inside its own transaction**, via `AuditWriter.record(tx, …)`. The writer only accepts a transaction handle — that is enforced at the type level.
- **Every write route pairs its checks.** `PermissionGuard` gates entry; the handler must additionally `assertCanIn` against the target's org unit, and — where roles or principals are involved — call the matching `PrivilegeGuards` method. Neither check subsumes the other.

---

## Key decisions (settled here, do not re-litigate)

1. **A group with `org_unit_id = NULL` is global.** Visible to any actor holding `group:read`; writable by any actor holding the write action at any scope. A scoped actor sees global groups ∪ groups within their subtree. This is the only rule that avoids inventing containment for "belongs nowhere."
2. **Out-of-scope single-resource reads return 403, not 404.** The directory's existence is not secret; its contents are. Consistency beats enumeration-hardening here, and 404 would make "missing" and "forbidden" indistinguishable in logs.
3. **Test isolation:** existing spec files are unchanged. Only files whose code path writes audit rows must avoid `DELETE FROM users` — audit rows pin users via the `restrict` FK and can never be removed. Those files use unique fixture identities per test and scope their assertions, letting rows accumulate within the file's container.
4. **`attribute_definitions` gets no write endpoint in this milestone**, so the ReDoS gate on `new RegExp(rules.pattern)` stays open and stays recorded.

---

### Task 1: Per-resource scope narrowing on reads  — THE GATE

**Files:** `users.controller.ts`, `org-units.controller.ts`, `groups.controller.ts`, `users.repository.ts`, `org-units.repository.ts`, `groups.repository.ts`, `permission.guard.ts` (comment only), `test/scope-narrowing.spec.ts` (new), `test/permission.guard.spec.ts` (the two pinning tests flip)

**Contract:**
- Repositories gain scope-aware list/count. Signature shape: an optional `scopePaths: string[] | null` where `null` means unrestricted and `[]` means nothing. Filter with `path <@ ANY ($n::ltree[])` bound via `sql.param(...)` — never string interpolation. Follow the existing pattern in `permission.engine.ts:131`.
- `UsersController.list` / `OrgUnitsController.list` / `GroupsController.list` call `scopePathsFor(actor, <action>)` and pass the result through. `total` must reflect the filtered count, not the global one.
- Single-resource reads (`findOne`, `subtree`, `members`, `effectiveMembers`) load the resource, then `assertCanIn(actor, <action>, resource.orgUnitId)`. For a group with `org_unit_id = NULL`, skip the check — global groups are visible to any holder (decision 1).
- The actor is on `request.actor`, attached by `PermissionGuard`. Do not re-resolve it.

**Tests that matter:**
- A `help_desk` scoped to Sales: `GET /users` returns only Sales-subtree users and `total` matches; `GET /users/:id` for an Engineering user returns **403**; for a Sales user returns 200.
- Same three for org-units and groups.
- A global role still sees everything (`scopePathsFor` → `null` → no filter).
- An actor whose role grants the action **nowhere** (`[]`) sees an empty page with `total: 0` — **not** everything. This is the `if (paths?.length)` trap; assert it explicitly.
- A group with `org_unit_id = NULL` is visible to a scoped actor.
- Moving a user between org units changes the next request's result with no restart.

**Also:** update the two pinning tests in `permission.guard.spec.ts` — the one asserting a scoped actor reaches an out-of-scope resource must now assert 403. Update the guard's comment to say narrowing IS wired. Update README's SECURITY STATUS.

---

### Task 2: User write endpoints

**Files:** `users.controller.ts`, `users.repository.ts`, `test/users.write.spec.ts` (new)

**Contract:**
- `POST /users` → `user:create`. `PATCH /users/:id` → `user:update`. `POST /users/:id/deactivate` → `user:deactivate`. No `DELETE` route, ever.
- Every handler: `assertCanIn(actor, action, targetOrgUnitId)` **and** — for `PATCH` and `deactivate` — `assertCanModifyPrincipal(actor, targetUserId)`. Both, not one.
- Each mutation runs in `db.transaction`, writing its audit row via `AuditWriter.record(tx, …)` in the same transaction with `before`/`after` payloads.
- Request bodies validated with Zod; custom attributes validated via `validateAttributes` against active definitions. A validation failure is 400 `VALIDATION_FAILED`.
- **Close the carried finding:** a bogus `orgUnitId` must produce 404 `NOT_FOUND`, not an unmapped 500. Map Postgres `23503` (foreign key violation) to `NotFoundError` — check the constraint name, not just the SQLSTATE.
- **Redaction:** audit `before`/`after` must exclude nothing today (no credential fields exist) but the handler must construct payloads explicitly from named fields rather than spreading the whole row, so a future sensitive column is not swept in by default.

**Tests that matter:**
- Create/update/deactivate succeed for an in-scope actor and are audited — assert the audit row exists with correct `before`/`after` in the same transaction.
- A failed mutation leaves **no** audit row (throw mid-transaction, assert count unchanged).
- Out-of-scope target → 403, and **no audit row written**.
- A `help_desk` cannot modify a `super_admin` → 403 (privilege guard), even in scope.
- Bogus `orgUnitId` → 404, not 500.
- `DELETE /users/:id` → 404 (route does not exist).
- Deactivating twice → 409 `INVALID_TRANSITION` (terminal state).

---

### Task 3: Org-unit and group write endpoints

**Files:** `org-units.controller.ts`, `groups.controller.ts`, `groups.repository.ts`, `test/groups.write.spec.ts`, `test/org-units.write.spec.ts` (new)

**Contract:**
- `POST /org-units` → `org_unit:create`, scoped by the **parent's** org unit (a root creation requires a global grant).
- `POST /groups` → `group:create`; `PATCH /groups/:id` → `group:update`; `POST /groups/:id/members` and `DELETE /groups/:id/members/:userId` → `group:manage_members`; `POST /groups/:id/child-groups` and its delete → `group:manage_members`.
- Same pairing rule: guard gates entry, handler asserts `canIn` against the target's org unit (skipped for global groups per decision 1).
- All mutations audited in-transaction, same as Task 2.
- **Close the carried finding:** `GroupsRepository.create`'s `23505` catch must check `cause.constraint`, not just the SQLSTATE, so a future second unique constraint is not mislabelled "a group named X already exists."
- Adding a child group must still go through the advisory-locked cycle guard. A cycle attempt → 409 `CYCLE_DETECTED`, and **no audit row**.

**Tests that matter:**
- Cycle attempt over HTTP → 409, audit count unchanged.
- Adding a user to a group is audited; removing is audited.
- Out-of-scope group → 403, no audit row.
- Duplicate group name → 409 `CONFLICT` with a message naming the right constraint.
- A global group (`org_unit_id = NULL`) is writable by a scoped actor holding the action.

---

### Task 4: Role assignment endpoints

**Files:** `authz/role-assignments.controller.ts` (new), `app.module.ts`, `test/role-assignments.write.spec.ts` (new)

**Contract:**
- `POST /users/:id/roles` → `role:assign`; `DELETE /users/:id/roles/:assignmentId` → `role:assign`.
- Handler must call **both** `PrivilegeGuards.assertCanAssignRole(actor, roleKey, scopeOrgUnitId)` **and** `PrivilegeGuards.assertCanModifyPrincipal(actor, targetUserId)`. The engine's `role:assign` permission check happens at the guard; these two are the narrowing. All three are load-bearing — the M3a review established that rank and scope are independent and neither subsumes the other.
- Audited in-transaction like every other write.
- The new controller must carry `@UseGuards(JwtGuard, PermissionGuard)` and every route `@RequirePermission('role:assign')`, and must be added to `guard-coverage.spec.ts`'s expected-controller list deliberately.

**Tests that matter:**
- A `super_admin` can assign any role anywhere; the assignment is audited.
- A scoped actor cannot grant globally → 403.
- An actor cannot grant a role they do not hold → 403.
- An actor cannot assign a role to a principal who outranks them → 403.
- Every 403 path writes **no** audit row.
- Revoking is audited.

---

## Definition of Done

- [ ] Scoped actors see only their subtree (plus global groups) on every list, with `total` matching
- [ ] Out-of-scope single-resource reads return 403
- [ ] An actor entitled nowhere gets an empty page, not everything
- [ ] Every write endpoint pairs entry-gate + `canIn` + (where relevant) a privilege guard
- [ ] Every successful mutation has exactly one audit row, written in the same transaction
- [ ] Every rejected mutation has **zero** audit rows
- [ ] No `DELETE /users/:id` route exists
- [ ] `23503` → 404 and `23505` → constraint-aware 409
- [ ] `pnpm --filter @idm/api test`, `build`, and `smoke:dev` all green

## Carried forward, still open

- ReDoS gate on `new RegExp(rules.pattern)` — closes when `attribute_definitions` gets a write path.
- `apps/api/scripts/` outside the `tsc` program.
- No CI, so compile-time guarantees depend on someone running `build`.
- The comprehensive adversarial security audit runs once at the end of sub-project 1.
