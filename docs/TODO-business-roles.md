# TODO — Business Roles and Entitlements (sub-project 4)

**Branch:** `feat/business-roles-entitlements-wt` (pushed to origin)
**Worktree:** `D:\identity-manager-business-roles`
**Spec:** `docs/archive/specs/2026-08-08-business-roles-entitlements-design.md`
**Plan:** `docs/archive/plans/2026-08-08-business-roles-entitlements.md` (20 tasks, M15–M19)
**Execution ledger:** `.superpowers/sdd/2026-08-08-business-roles-entitlements/progress.md`

Both spec and plan were filed under `docs/archive/` by an unrelated docs restructure
while this work was still active. They are current, not historical.

---

## Where it stands

| Milestone | Tasks | State |
|---|---|---|
| M15 — Schema and provenance | 1–3 | **Done**, reviewed clean |
| M16 — The pure evaluator | 4–6 | **Done**, reviewed clean |
| M17 — Reconciler, gate, API | 7–12 | Task 7 done and reviewed; **Task 8 in progress**; 9–12 not started |
| M18 — Sync integration | 13–15 | Not started |
| M19 — JML cleanup and console | 16–20 | Not started |

Last verified full gate: `pnpm verify` green at the M16 boundary — 73/73 files,
1147/1147 tests. Nothing since Task 7 has been through the full gate.

### Commits on this branch

```
2e36561 wip(business-roles): the reconciler, tests not yet run   <-- see warning below
42b18ad test(business-roles): prove the publish hash comparison is load-bearing
a9ab01a feat(business-roles): repository with the draft-simulate-publish gate
348b3eb docs(plan): correct three defects found implementing Task 7
0695a0a feat(business-roles): role evaluation, exception precedence, and the source scan
5fc3fe2 feat(business-roles): org-subtree matching on labels, not characters
6910d7e feat(business-roles): closed condition matching that refuses to act on the unknown
e1c017c feat(business-roles): target-account entitlement state and per-target provisioning mode
ea162ca feat(business-roles): role, condition, grant and exception tables
391f7b4 feat(business-roles): provenance on group membership
```

> **RESOLVED 2026-08-08, on the merged `master`: 19/19 pass.** The diagnosis in
> section 1 below was correct — cross-test contamination, not a reconciler bug —
> and its recommended fix (a per-seed unique `jobTitle`) is in the merged code.
> The fixtures additionally now seed `organizationId` from
> `OrganizationsRepository.findMaster()`, which `feat/organizations` made
> mandatory. Section 1's failure table is kept as history; **tasks 9-20 below
> are still current.**

---

## 1. Finish Task 8 — the reconciler (IN PROGRESS)

`apps/api/src/business-roles/role-reconciler.ts` exists and compiles; 14 of 19 tests in
`apps/api/test/business-roles.spec.ts` pass. The five failures:

| Failing test | Symptom |
|---|---|
| re-adds a role-derived row that was removed by hand | expected 1 row, got 5 |
| two roles justifying one group produce exactly one row | expected 1, got 6 |
| disabling a role revokes its rows | expected `[]`, got 6 |
| REFUSES to act when any enabled role is unevaluable | expected 1 row, got 7 |
| writes exactly one audit row for a changed pass, none for a no-op | expected 1 audit row, got 0 |

**Diagnosis of the first four (strong hypothesis, not yet confirmed).** Cross-test
contamination, not a reconciler bug. `withTestDatabase()` starts one container per test
*file* and never truncates between `it` blocks. Every `seedRoleGrantingGroup` call creates
another *enabled* role whose condition is `jobTitle equals 'Account Executive'`, plus
another group — so by the fifth test several enabled roles all match the same user and
reconciling correctly grants all their groups. The surplus rows are all
`grantSource: 'business_role'` with distinct `groupId`s and the same `userId`, which fits.

If confirmed, fix the **fixtures**, not the assertions: give each seeded role a unique
discriminator (e.g. a per-seed `jobTitle`) so roles cannot cross-match other tests' users.
Do not relax "expected exactly one row" — that exactness is the property under test.

**The fifth failure is separate and may be a real bug.** Zero audit rows were written.
Check whether `AuditWriter.record` is called at all, whether the `auditRowsFor` helper
queries the right columns (`apps/api/src/db/schema/audit-log.ts`), and whether the audit
row goes on the same `tx`.

**Invariants that must hold in the final code** (from the plan's Task 8 rules):

- Revokes **only** rows whose `grant_source` is `business_role`. A `manual` row is never
  touched by automation, in any path.
- The `grant_source` predicate lives in the SQL `DELETE`, not only in a JavaScript filter
  above it — otherwise a hand-grant landing between read and write is deleted anyway.
- A row existing from **any** source satisfies the desired state and is not re-added.
- Refusal (`evaluateRoles` returning `evaluable: false`) writes nothing: nothing granted,
  nothing revoked, error surfaced.
- Everything runs on the caller's `tx`. No second pool connection while a transaction is
  open — see finding C1 in `docs/archive/audits/audit-integrity.md`, guarded by
  `apps/api/test/pool-exhaustion.spec.ts`.
- Outbox events mirror the member add/remove handler in
  `apps/api/src/groups/groups.controller.ts` exactly. Do not invent an event type.
- One audit row per pass that changed something; none for a no-op.

Verify with: `vitest run test/business-roles.spec.ts` (19 passing),
`vitest run test/pool-exhaustion.spec.ts`, and `tsc -p tsconfig.json --noEmit`.

---

## 2. Remaining tasks

Each is fully specified in the plan; the section names below match its task headings.

### Milestone 17 — finish the API

- [ ] **Task 9 — Re-evaluate on every user write.** Export `REEVALUATION_FIELDS`
      (`jobTitle`, `location`, `status`, `orgUnitId`, `attributes`) and call the reconciler
      inside the existing transaction of the user create and update handlers. Register
      `BusinessRolesRepository` and `RoleReconciler` in `app.module.ts`. A refusal must roll
      the write back rather than save a user whose access is silently wrong. Skip the call
      entirely when a patch touches none of those fields. **The trigger list must stay
      identical to the evaluator's field allowlist** — a field nameable in a formula that
      does not trigger re-evaluation is a mover whose access silently fails to follow them.
- [ ] **Task 10 — Sweep job and CLI.** `RoleReconciliationJob` walking *every* user status,
      one transaction per user, idempotent, tolerating a refusal without aborting the sweep.
      Plus `role-reconcile-cli.ts` and a `role-reconcile` package script, modelled on the
      existing `target-reconcile` pair.
- [ ] **Task 11 — Actions, guards, controller.** `business_role:read` (super_admin,
      user_admin, auditor, read_only) and `business_role:manage` (super_admin only).
      Mutating a role requires a **global** grant (`scopeOrgUnitId: null`), following
      commits `2648b9f` and `617a0b4`. Routes per the plan's API table. Publish and
      enable/disable enqueue `reconcileRole`; exception writes enqueue `reconcileUser` for
      one person and are permitted while the role is live.
- [ ] **Task 12 — `GET /api/users/:id/entitlements`.** Gated on `user:read` with normal
      org-unit scoping (403 out of scope, not 404). `justifiedBy` computed live per request,
      never stored. A `manual` row always reports `justifiedBy: []`. If evaluation refuses,
      return the rows with an `unevaluable` marker rather than failing the whole read — this
      is the screen someone opens *because* something is wrong.

### Milestone 18 — sync integration

- [ ] **Task 13 — Fan out by entitlement.** `OutboxWriter` consults `user_target_accounts`
      for `entitled_only` targets. **`outbox-emission.spec.ts` must pass unmodified** — if it
      needs editing to go green, the default is not preserving old behaviour and that is the
      bug. Non-`user` aggregates (groups, org units) must keep fanning out to every enabled
      target regardless of entitlement state.
- [ ] **Task 14 — Entitlement loss disables.** A revoked target account emits an explicit
      `disable`, written directly rather than through the entitlement-filtered writer (the
      row it would consult has just been deleted). Same transaction as the delete.
      **Plus the offboarding-independence tests** — deactivation must disable every target
      and kill sessions with no business role present *and* with an unevaluable one present.
      Settled decision 8 must be asserted, not assumed.
- [ ] **Task 15 — Target reconciliation respects the mode.** On `entitled_only`, an
      unentitled user's desired state is *disabled*, not skipped. The blast-radius guard must
      halt a bare mode flip that would plan a disable for the whole directory — add a test
      asserting zero operations reach the target in that case.

### Milestone 19 — cleanup and console

- [ ] **Task 16 — Remove JML group actions.** Narrow `JmlActionType` to `set_attribute` and
      `deactivate`. Postgres cannot `DROP VALUE`, so the labels stay in the `jml_action` enum
      and application code rejects them. Hand-write the migration guard (drizzle-kit will not
      generate it) so it **hard-fails** on any stranded `add_to_group`/`remove_from_group`
      row rather than leaving a rule that will never fire again.
- [ ] **Task 17 — Business roles list and detail.** New console section, nav entry gated on
      `business_role:read`, and relabel the existing "Roles" nav item to **"Admin roles"** —
      two entries both reading "Roles" would be ambiguous, and this work creates the
      ambiguity. Tables not card grids, tabs not accordions, status as a word never colour
      alone, all seven interactive states.
- [ ] **Task 18 — Simulate panel, publish, enable, disable.** The simulate panel is the
      safety rail and must read as one. Publish stays disabled until a simulation exists for
      the *current* draft; a changed draft clears the panel. **Disable is a revocation, not a
      pause** — it needs a confirmation naming how many people lose access, and a toast that
      states consequence.
- [ ] **Task 19 — Person Entitlements tab.** What they have, where it came from, which roles
      justify it right now. Manual rows show with no role behind them — that is the queue a
      later recertification campaign works from, so make it legible rather than buried.
- [ ] **Task 20 — End-to-end.** Playwright: create → draft → simulate → publish → enable →
      groups change → Entitlements tab explains why → edit the draft again and confirm
      publish is refused until re-simulated.

---

## 3. Deferred minors (triage before merge)

Raised by task reviews, none blocking at the time:

- [ ] `in_org_subtree` identifies "is this the `orgUnitId` field" by comparing the *resolved
      value* to `user.orgUnitId`, because the `Matcher` signature never receives the field
      name. Inert today — the computation always uses the real `orgUnitPath`, so the worst
      case is failing to refuse a malformed condition, never a wrong grant. Fixing means
      widening `Matcher` to take the field name.
- [ ] `recordSimulation` has no compare-and-swap against the draft it claims to simulate.
      Not exploitable today (no caller yet); `publish` recomputes and would catch a stale
      write. Worth handling when Task 11 builds the simulate endpoint.
- [ ] `parseDefinition` does not reject duplicate grants. They pass `saveDraft` and fail at
      publish as a raw Postgres unique violation (500) instead of a clean `ValidationError`.
- [ ] The "exception requires a reason" test uses a bare `.rejects.toThrow()` with no
      constraint-name regex. Verified non-vacuous today, but loose.
- [ ] The seeded-`keycloak`-row assertion has no `length > 0` guard. Provably non-vacuous via
      migration `0011`'s unconditional seed, but it rests on that rather than asserting it.
- [ ] New imports were appended mid-file in `business-role-evaluator.spec.ts` rather than
      merged into the top import block. Cosmetic; no linter is configured.
- [ ] `apps/api/src/db/migrations/meta/0018_snapshot.json` is missing (pre-existing, predates
      this work). `0019` correctly chains to `0017`. Harmless so far.

---

## 4. Environment notes for whoever picks this up

- **Docker has been unreliable on this machine** and it blocked this work repeatedly — the
  service stopped, the engine 500'd on `/_ping`, the named pipe vanished, and containerd's
  metadata store remounted read-only. Every remaining API task needs Testcontainers and
  Task 20 needs the Compose stack, so confirm `docker run --rm hello-world` genuinely works
  before starting. Note `docker info` and `docker version` can exit 0 while printing a
  connection error — probe by actually running a container.
- **The `docker` CLI is not on PATH** in Git Bash here. It lives at
  `C:\Program Files\Docker\Docker\resources\bin\docker.exe`. This does not affect
  Testcontainers, which reaches the daemon over the named pipe directly.
- **`D:\identity-manager` is shared by several concurrent sessions** on different branches
  (`feat/user-activate`, `feat/organizations`, `feat/sso-apps`, `fix/sync-diagnostics`,
  `feat/ui-revamp`). Work for this sub-project belongs in the
  `D:\identity-manager-business-roles` worktree. Do not switch the shared checkout's branch
  or stash in it — that has already displaced another session's work once
  (recoverable at `stash@{0}` in the main checkout at the time of writing).
- **Full `pnpm verify` takes ~3 minutes** and is best run at milestone boundaries rather than
  per task. Backgrounding it inside a subagent caused repeated stalls; run it in the
  foreground.
