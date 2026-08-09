# TODO

A snapshot taken 2026-08-08 ~22:45, after a session was closed mid-flight and the
parallel worktrees were swept for work that had never been committed. Everything
below is either unverified, defective, or unpushed — finished work is not listed.

## Unfinished work — committed so it cannot be lost, but NOT verified

Both commits below pass `tsc --noEmit` and have never had their tests run. Run the
suite before building anything on top of either. Cap vitest at 3 forks; the full
Testcontainers suite will otherwise fill the disk and report phantom failures.

- [ ] **business-roles, Milestone 17 Task 8 — the reconciler**
      Worktree `D:\identity-manager-business-roles`, branch `feat/business-roles-entitlements-wt`, commit `2e36561`.
      Adds `apps/api/src/business-roles/role-reconciler.ts` (268 lines), repository
      support, and the `describe('RoleReconciler (Milestone 17, Task 8)')` block in
      `apps/api/test/business-roles.spec.ts`.
    - [ ] Run the suite — these tests have never executed
    - [ ] Tick the Task 8 checkboxes in `docs/archive/plans/2026-08-08-business-roles-entitlements.md`
    - [ ] `RoleReconciler` is not registered in `app.module.ts`. Confirm that is Task 9's
          job ("Re-evaluate on every user write") and not an omission.

- [ ] **organizations, Task 2 — master adoption backfill**
      Worktree `D:\identity-manager-organizations`, branch `feat/organizations`, commit `17cd3f8`.
      Hand-written `0023_organizations_backfill.sql` plus `organization_id` on
      `org_units`, `users`, `groups` (NOT NULL) and `audit_log` (nullable), a new
      `organizations.repository.ts`, and `test/support/migration-harness.ts`.
    - [ ] Run `organizations.migration.spec.ts` against a real container. This is a data
          backfill inside a migration — a typecheck vouches for nothing here.
    - [ ] Tick the Task 2 checkboxes in `docs/archive/plans/2026-08-08-organizations-multi-tenancy.md`
    - [ ] `0023_organizations_backfill.sql` cites a `task-2-report.md` that does not exist
          anywhere in the tree. Write it or drop the reference.
    - [ ] Do not add migration 0024 until the above passes.

## Known defect

- [ ] **`apps/api/src/users/users.repository.ts:713` — misanchored doc comment.**
      `listPending` was inserted between `listNonDeactivatedWithEndDateOnOrBefore`'s doc
      comment and its body. That method now has no docs, and `listPending` carries two
      doc blocks: the leaver-query one it inherited, then its own. Present in committed
      code on `feat/user-activate` (`6cc78e6`), not just in a stray working copy.

## Housekeeping

- [ ] **The shared main tree `D:\identity-manager` is dirty with stale duplicates.**
      Nine changed files, none of them unique. `bulk-activate.job.ts`,
      `bulk-activate-cli.ts`, its spec, the `users.repository.ts` `listPending` addition
      and the `package.json` `activate` script are byte-identical to `6cc78e6` on
      `feat/user-activate`. `business-roles/draft.ts` and `business-roles.repository.ts`
      are byte-identical to `42b18ad`; that tree's `business-roles.spec.ts` is one test
      *behind* it and its `organizations-multi-tenancy.md` is one line behind `b542a32`.
      Safe to discard — but the tree is shared, so check no agent is live in it first.

- [ ] **`stash@{0}` is superseded.** "WIP on feat/user-activate before switching to
      feat/business-roles-entitlements for Task 7", created 20:45. Its four files became
      `c3524c6` and `a734538`, which are 66 lines further along. Droppable.

- [ ] **`fix/sync-diagnostics` has 7 commits that exist nowhere on GitHub.**
      Worktree `D:\identity-manager-syncfix`, clean. It is the only unpushed branch
      carrying unique work — `audit/availability-dos`, `audit/carried-findings`,
      `audit/client-supply-chain`, `docs/sso-app-onboarding`,
      `feat/attribute-definitions-write-path` and `feat/ui-revamp` are all fully
      contained in branches already pushed, despite reading as "16 commits ahead".
