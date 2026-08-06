# Identity Provider — Milestones 5–7 (Bulk Import, Self-Service, JML Automation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Complete sub-project 1 — bulk import to load a real organisation, a self-service portal, and joiner/mover/leaver automation.

**Architecture:** All three build on the existing spine. Bulk import is a dry-run-then-commit batch that reuses the same write paths, so every row is permission-checked, audited and outboxed like a single mutation. Self-service is authentication-only by construction — its handlers never accept a user id, they only ever act on the resolved principal. JML rules are stored **as data, never code**: an identity provider that executes user-supplied script is a privilege-escalation vector by design.

**Tech Stack:** TypeScript, NestJS 10, Drizzle ORM, Postgres 16, Keycloak 26, React 18 + Vite, Zod, Vitest, Testcontainers, Playwright.

**Builds on:** M1–M4 all merged. 425 API tests + 2 E2E green.

**Plan style:** contracts and decisions, not transcribed code.

## Global Constraints

- Never generate, transmit, or store a credential. Keycloak owns them — credential actions **deep-link to Keycloak's Account Console**, they are never reimplemented.
- Attribute propagation is default-deny (`sync_to_keycloak`). Self-service edits are default-deny too (`self_editable`).
- No delete for users; `deactivated` is terminal. Deactivated users excluded from default list views.
- Authorization enforced in the API, never the UI.
- Testcontainers, never mocks. Single tenant, no `tenant_id`. `strict: true`, no `any`/`@ts-ignore`.
- Explicit `@Inject(Token)` on every constructor dependency.
- Every mutation: permission-checked, scope-narrowed, audited **and** outboxed, all in one transaction. Rejected mutations write zero audit rows and zero outbox events.
- Any `package.json` change commits `pnpm-lock.yaml`; any schema change runs `db:generate` and commits the migration + `meta/`.
- Audit rows pin users via a `restrict` FK and can never be deleted — new spec files that write audit rows must not `DELETE FROM users`.

---

## Key decisions (settled — do not re-litigate)

1. **Self-service handlers accept no user id, ever.** Not in the path, not in the body, not in a query param. They operate solely on the user resolved from `request.principal`. This makes IDOR impossible by construction rather than by check. The controller is `AUTHENTICATION_ONLY` (like `MeController`) — add it to that named set in `guard-coverage.spec.ts`.
2. **Self-service works for users with no role at all.** An ordinary employee has no admin role; `resolveActor` requires only an *active* user, not a grant. Do not gate self-service behind a permission.
3. **JML rules are data.** `trigger → condition → action`, stored as rows, with `action` a closed enum. No expression language, no scripting, no `eval`, no dynamic `Function`.
4. **The scheduler is an on-demand script**, in the same style as `db:migrate` and the reconciliation job. No cron, no in-process timer.
5. **Bulk import reuses the existing single-record write paths.** It must not open a side door that skips permission checks, audit, or outbox emission.
6. **Import is idempotent on `employee_id`.** A row whose `employee_id` already exists is an update, not a duplicate-create failure.

---

## Milestone 5 — Bulk Import

### Task 1: CSV parse, validate, and dry-run diff

**Contract:**
- `POST /imports/preview` → requires `user:create`. Accepts a CSV body (or multipart file), parses it, validates every row, and returns a **diff preview**: rows that would create, rows that would update (matched on `employee_id`), and rows that would fail — each failure carrying its row number and reason.
- **Nothing is written.** No user rows, no audit rows, no outbox events. Assert all three counts unchanged after a preview.
- Validation covers: required columns, `org_unit` resolvable, `manager` resolvable if present, email/username well-formed and not colliding with a *different* existing user, and custom attributes passing `validateAttributes` against active definitions.
- The actor's scope narrows what a preview may touch: a row targeting an org unit outside the actor's scope is a failure row, not a silent skip.
- Parse defensively — a malformed CSV must produce a 400 `VALIDATION_FAILED`, never a 500. Probe: unterminated quotes, wrong column count, a BOM, CRLF vs LF, and an empty file.

**Tests that matter:** preview writes nothing; out-of-scope row reported as a failure; duplicate `employee_id` within the same file reported rather than silently last-wins; malformed CSV → 400.

### Task 2: Commit the batch

**Contract:**
- `POST /imports/commit` → requires `user:create`. Same validation as preview, then applies.
- **One `batch_id` per import**, recorded on every audit row the batch produces, so an import is reviewable as a unit afterwards.
- Idempotent on `employee_id`: existing → update, new → create.
- **All-or-nothing per row, not per batch**: a row that fails validation is reported and skipped; rows that succeed commit. But each individual row's user write, audit row and outbox event still commit together atomically.
- Response reports created/updated/failed counts and the `batch_id`.
- Reuses the existing write paths — no side door around permission checks, audit, or outbox.

**Tests that matter:** a 3-row import produces 3 audit rows sharing one `batch_id` and 3 outbox events; re-running the identical file updates rather than duplicating; a file mixing valid and invalid rows commits the valid ones and reports the rest; an out-of-scope row commits nothing for that row.

---

## Milestone 6 — Self-Service Portal

### Task 3: Self-service API

**Contract:**
- New `SelfServiceController`, `@UseGuards(JwtGuard)` only, added to `AUTHENTICATION_ONLY` in `guard-coverage.spec.ts`.
- `GET /self` → the caller's own user record.
- `PATCH /self` → updates **only** attributes whose definition has `self_editable = true`, plus a small fixed whitelist of core fields (decide it explicitly and document it — at minimum `location`; **never** `status`, `orgUnitId`, `username`, `primaryEmail`, `employeeId`, or `managerId`).
- `GET /self/groups` → the caller's effective groups, read-only.
- Every handler resolves the user from `request.principal` and **takes no id from the request**. A test must prove that supplying another user's id anywhere has no effect.
- Mutations are audited and outboxed like any other write, with the actor being the user themselves.
- Attempting to edit a non-`self_editable` attribute is a 400 `VALIDATION_FAILED` naming the field — not a silent drop. A silent drop would let a user believe they changed something they did not.

**Tests that matter:** a role-less active user can read and update their own profile; a non-`self_editable` attribute is rejected by name; no request-supplied id can redirect the write; a deactivated user gets 403.

### Task 4: Self-service UI

**Contract:**
- Extend the existing React console (`apps/web`). Add a `/self` route showing the caller's profile, their groups read-only, and an edit form covering only `self_editable` fields — driven by the attribute definitions, not hard-coded.
- **Credential management is a deep link to Keycloak's Account Console**, never a reimplementation. No password field, no MFA enrolment UI. The link target is derivable from the existing issuer URL.
- Direct and effective group membership must be visually distinct where both are shown.
- Playwright E2E: sign in, land on `/self`, see own profile, edit a self-editable field, see it persist. Reuse the existing login flow.

**Tests that matter:** the E2E proves the round trip; a static check asserts no password input exists anywhere in `apps/web/src`.

---

## Milestone 7 — Joiner/Mover/Leaver Automation

### Task 5: Rule storage and evaluation

**Contract:**
- `jml_rules` table: `id`, `name`, `enabled` (default **false**), `trigger` (enum: `user_created`, `user_attribute_changed`, `start_date_reached`, `end_date_reached`), `conditionField`, `conditionOperator` (enum: `equals`, `not_equals`, `in`), `conditionValue jsonb`, `action` (enum: `add_to_group`, `remove_from_group`, `set_attribute`, `deactivate`), `actionParams jsonb`, `createdAt`, `updatedAt`.
- A rule engine that, given a user and a trigger, returns the matching rules' actions. **No expression evaluation of any kind** — condition matching is a closed comparison over a named field.
- Rules are seeded/managed through the repository in this milestone; no HTTP CRUD (that would need the ReDoS gate closed and is not required here).
- A rule with an unknown enum value must fail closed — skipped and logged, never applied.

**Tests that matter:** a matching rule yields its action; a non-matching one does not; a disabled rule never fires; an unknown action enum is skipped rather than crashing or applying something else.

### Task 6: Applying rules, with mandatory simulate

**Contract:**
- `simulate(rule, users)` returns exactly what *would* happen, writing nothing. **A rule cannot be enabled until it has been simulated** — enforce this in the repository, not by convention: enabling a rule that has never been simulated is a `ValidationError`.
- Applying an action goes through the existing write paths, so each is permission-checked as the system actor, audited and outboxed.
- The system actor for automated actions is `null` in the audit row — the schema already allows it, and "no human did this" is the honest record.

**Tests that matter:** simulate writes nothing (assert user, audit and outbox counts unchanged); enabling an unsimulated rule is rejected; an applied action produces an audit row with a null actor and an outbox event.

### Task 7: Date-driven lifecycle scheduler

**Contract:**
- An on-demand script (like `db:migrate` / the reconciliation job) that activates users whose `start_date` has arrived and deactivates those whose `end_date` has passed, plus fires `start_date_reached` / `end_date_reached` rules.
- Idempotent: running it twice in a day must not double-apply. A user already `active` is not re-activated; `deactivated` is terminal and already rejected by the transition matrix.
- Every action audited and outboxed. Deactivation goes through the synchronous-revocation path so sessions die immediately.

**Tests that matter:** a user with a past `start_date` and status `pending` becomes `active`; one with a past `end_date` becomes `deactivated` and their Keycloak session is revoked; a second run changes nothing and writes no new audit rows.

---

## Definition of Done

- [ ] Import preview writes nothing — user, audit and outbox counts all unchanged
- [ ] Import commit shares one `batch_id` across its audit rows and is idempotent on `employee_id`
- [ ] Self-service handlers accept no user id from the request, proven by test
- [ ] A non-`self_editable` field is rejected by name, not silently dropped
- [ ] No password input exists anywhere in `apps/web/src`
- [ ] JML rules contain no expression language, no `eval`, no dynamic `Function`
- [ ] A rule cannot be enabled until simulated
- [ ] Simulate writes nothing
- [ ] The scheduler is idempotent across repeated runs
- [ ] Suite, build, `smoke:dev` and the Playwright E2E all green

## Carried forward into the security audit

- ReDoS gate on `new RegExp(rules.pattern)` — still open; `attribute_definitions` still has no write path.
- `apps/api/scripts/` outside the `tsc` program; no CI.
- No suspend/activate HTTP endpoint exists (revocation is a reusable private method awaiting a route).
- Group-rename fan-out reaches only current effective members; `ReconciliationJob` is the backstop.
- Principal resolution deliberately remains on `username`.
