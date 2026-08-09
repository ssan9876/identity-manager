# Organizations and multi-tenancy — outstanding work

**Branch:** `feat/organizations` (off `feat/user-activate`)
**Spec:** [`../specs/2026-08-08-organizations-multi-tenancy-design.md`](../specs/2026-08-08-organizations-multi-tenancy-design.md)
**Plan:** [`2026-08-08-organizations-multi-tenancy.md`](2026-08-08-organizations-multi-tenancy.md) — 16 tasks, two phases

Execution stopped after Task 2. This file is the handover: what landed, what is
unverified, and what remains.

---

## Status

| | Task | State |
|---|---|---|
| ✅ | 1 — The `organizations` table | Complete. Reviewed clean, 7/7 constraint tests pass against real Postgres |
| ⚠️ | 2 — Master adoption backfill | Code committed as `17cd3f8`, **full-suite gate never ran**. Not reviewed |
| ⬜ | 3 — Per-organization uniqueness | Not started |
| ⬜ | 4 — Composite FKs for tenant isolation | Not started |
| ⬜ | 5 — `organization_id` on business roles and JML rules | Not started |
| ⬜ | 6 — Master adoption at startup | Not started |
| ⬜ | 7 — Roots come only from organizations | Not started — **Phase 1 gate follows** |
| ⬜ | 8 — Provisioning credentials | Not started |
| ⬜ | 9 — Keycloak admin client per realm | Not started |
| ⬜ | 10 — `organization` outbox aggregate | Not started |
| ⬜ | 11 — The organization connector | Not started |
| ⬜ | 12 — The organizations API | Not started |
| ⬜ | 13 — Organization-aware fan-out | Not started |
| ⬜ | 14 — Realm dispatch and deferral | Not started |
| ⬜ | 15 — The console Organizations page | Not started |
| ⬜ | 16 — Documentation | Not started — **Phase 2 gate and final review follow** |

Commits so far: `1808d88` (plan) · `89d9325`, `f598d9c`, `fc37acf` (Task 1) ·
`b542a32` (plan amendment) · `17cd3f8` (Task 2, WIP).

---

## Do this first

### 1. Close Task 2's gate — blocking everything else

`17cd3f8` is committed but its full-suite run never completed. The agent
backgrounded it three times and stalled each time; the run's output file was
empty. What *did* pass: 2/2 migration tests, 68/68 across the repository and
schema specs, and a clean typecheck.

```bash
cd D:/identity-manager-organizations
pnpm --filter @idm/api test          # run in the FOREGROUND, do not background it
pnpm --filter @idm/api db:generate   # drift check — must generate NOTHING
pnpm verify:quick
```

The suite is the step that proves Phase 1 is behaviour-preserving. **A
not-null violation means a write path was missed** — `organization_id` is now
`NOT NULL` on `org_units`, `users` and `groups`, and every insert must derive
it. Fix the write path, never the test. If the drift check emits a migration,
the hand-written `0023_organizations_backfill.sql` and the Drizzle schema
disagree; reconcile and delete the spurious file.

Then review `17cd3f8` properly — it is the only task so far that has had no
review at all.

### 2. Review three files Task 2 touched that its brief never named

Each needs a stated justification or a revert:

- `apps/api/test/business-roles-schema.spec.ts`
- `apps/api/test/support/pg.ts`
- `apps/api/src/organizations/organizations.repository.ts` (plausible — the
  plan's Phase 1 file list does include it)

---

## Carry-forward findings

These are real, already diagnosed, and deliberately not fixed where they were
found.

**`organization_id` now leaks into `GET` responses.** `GET /org-units/:id` and
friends return raw repository rows with no response DTO, so Drizzle hands back
the new column regardless of what the TypeScript interface declares. Nothing
breaks today — no existing test asserts a closed response shape — but this is an
unintended API surface change. Decide in **Task 12** whether to expose it
deliberately via response DTOs or suppress it.

**The `lower(slug)` unique index is unreachable.** `organizations_slug_format`
already restricts `slug` to lowercase, so the case-folding in
`organizations_slug_unique` can never be exercised by any insert path. Either
drop the `lower()` or relax the CHECK — currently one of them is dead weight,
and the test named for case-insensitivity actually proves only plain duplicate
rejection.

**Deferred minors** — `organizations.schema.spec.ts:1` imports `sql` and never
uses it; that filename uses a dot separator where the sibling
`business-roles-schema.spec.ts` uses a hyphen.

---

## Two things the plan itself gets wrong

Both were found during execution and are already corrected in the plan file,
but they show where its remaining tasks may need the same scepticism.

1. **The pre-flight defect.** Task 2 originally made `organization_id`
   `NOT NULL` without populating it anywhere, which would have broken every
   user and group create for the whole of Phase 1. Fixed by adding Step 5
   (derive from the org unit) and Step 7 (full suite).
2. **Tests that assert nothing.** Task 1's test only checked that column names
   existed on a TypeScript object — it could not detect a broken CHECK, a
   partial index that lost its `WHERE`, or a wrong enum. A standing constraint
   now requires real-database assertions for Tasks 2, 3, 4, 5 and 10.

---

## Still unverified from the spec

**Task 11 settles this and nothing before it can.** The design assumes Keycloak
grants a realm's *creating* service account admin rights on that realm, and
explicitly flags the assumption as unverified. Task 11's fifth test — create a
realm, then create a user in it with the provisioning client — is what decides
whether `ensureRealm` also needs an explicit `<realm>-realm` role grant.

---

## Environment notes

- **Docker Desktop's backend service must be running.** It was stopped at the
  start of this work; the named pipes still existed and answered, but the engine
  returned HTTP 500 on every call and Testcontainers crashed the vitest worker
  rather than failing cleanly. `Start-Service com.docker.service` (elevated), or
  restart Docker Desktop.
- **Do not let an implementer background the test suite.** Three stalls came
  from exactly that. Foreground only.
- **Never run `git checkout -- .`, `reset --hard`, `stash` or `clean` in this
  worktree.** An implementer destroyed an uncommitted plan edit that way.
- The SDD ledger with the full blow-by-blow lives at
  `.superpowers/sdd/2026-08-08-organizations-multi-tenancy/progress.md`
  (git-ignored, local to the worktree — it will not survive a clone).

---

## Out of scope, by design

Deferred to later specs, each named in the design doc: per-realm admin login
(`JwtGuard` stays single-issuer), tenant-scoped admin roles, per-organization
connector targets for AD/Entra/Google/mail, and realm-level Keycloak
configuration such as themes, token lifespans and per-tenant OIDC clients.
