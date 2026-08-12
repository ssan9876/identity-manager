# Attribute definitions write path — design

**Date:** 2026-08-10
**Status:** approved

## The problem

`attribute_definitions` is the only directory table with no write path. Its
controller exposes exactly one route — `@Get()` — so every custom attribute in a
deployed system was created by connecting to PostgreSQL and issuing an
`INSERT`. There is no audit row for any of it, no validation beyond what the
column types enforce, and no way for an operator without database credentials
to add a field.

The roadmap ranked this second of four remaining capabilities, promoted from
third. Its old blocker is gone: the caveat "fix the ReDoS first, because that
path is what makes it reachable" no longer applies. Commit `6b75107` removed
`new RegExp(rules.pattern)` and `validationRules.pattern` is now rejected
outright, so the validator this endpoint would sit in front of already fails
closed.

## Why the shape is not obvious

Attribute **values** live in `users.attributes`, a single `jsonb` column. There
is no separate values table, no foreign key, and no referential integrity
between a definition and the values written under its key. Three consequences
drive the entire design:

1. Changing a definition's `dataType` does not migrate anything. Existing jsonb
   values keep whatever shape they had.
2. Deleting a definition orphans values rather than cascading.
3. Nothing detects the resulting mismatch. A definition claiming `number` over
   users holding strings validates on write and fails nowhere visible.

So the interesting half of this feature is not the CRUD. It is what happens to
data that already exists.

## Settled decisions

### 1. Full edit, including `dataType`, with migration

Rejected: leaving `dataType` immutable. That is the smaller, safer feature and
it was considered; the decision is to support the real operation rather than
document a limitation. A type change rewrites existing values, and this design
treats that as the bulk data operation it is rather than hiding it behind a
`PATCH`.

`key` remains **immutable**. It is the jsonb map key, so renaming it rewrites
every user's blob for no gain that create-plus-deactivate does not already
give.

### 2. Two edit paths, split by whether user data moves

**Safe edits — plain `PATCH`, synchronous, audited.** `label`, `required`,
`defaultValue`, `validationRules`, `sortOrder`, `isActive`, `selfEditable`,
`sensitive`. None of these touch a stored value.

**Value-rewriting edits — preview then commit.** `dataType` and `appliesTo`
only.

### 3. Preview → commit, blast-radius guarded

Follows the two precedents already in the tree: `POST /imports/preview` →
`POST /imports/commit`, and `evaluateBlastRadius(changedCount, populationSize,
thresholdPercent, floor)` as used by `TargetReconciliationJob` and `hr-feed`.

`POST /attribute-definitions/:id/preview` reports which users change, which
values fail to convert, and the resulting counts, changing nothing. `POST
/attribute-definitions/:id/commit` applies it, refuses when the change exceeds
**both** the percentage threshold and the floor, and audits `force`.

Both conditions are required together, matching `connector_targets`' existing
`blast_radius_threshold` (default 20) and `blast_radius_floor` (default 5). A
percentage alone fires on a three-user tenant; a floor alone never fires on a
large one.

### 4. Migration is a job, driven by both HTTP and a CLI

`AttributeMigrationJob` sits beside `TargetReconciliationJob` and
`HrSyncService`. The controller calls it; `pnpm attribute-migrate` calls the
same class.

This project has five job+CLI pairs — `reconcile`, `target-reconcile`,
`role-reconcile`, `jml:lifecycle` and `hr:sync` — of which exactly two are also
reachable over HTTP (`POST /connector-targets/:target/reconcile` and `POST
/hr-sources/:id/preview`). The pattern to follow is therefore those two, not
all five: a job class that a CLI can drive for the unbounded case and a
controller can drive for the interactive one. Every one of the five exists
because a bulk operation needs a path that does not run inside a request. A `dataType` change
is bounded by user count, not by an uploaded file, so the synchronous shape CSV
import uses does not transfer. The CLI also makes the risky operation testable
without HTTP, which is how the reconcilers are already tested.

### 5. Two refusals, enforced in the repository

Enforced in the repository rather than the controller, matching how
`BusinessRolesRepository` enforces its publish gate — a caller cannot bypass
them by reaching the repository directly.

**`selfEditable` on an attribute a business-role formula references is
refused**, with an error naming the roles. `role-evaluator.ts` supports an
open-ended `attributes.<key>` condition form, so a custom attribute can drive
entitlement grants. Marking such an attribute self-editable would let a user
grant themselves entitlements by editing their own profile — a privilege
escalation route that does not exist today and that this write path would
create. Refusal, not a warning: the system already refuses on this class of
problem when a draft publish is blocked by an SoD violation.

**A commit whose preview does not match the exact change being committed is
refused.** Taken directly from the business-roles publish gate, which requires a
simulation of the precise draft being published, matched by hash. It stops
"preview something harmless, commit something else."

### 6. `sensitive` is audited distinctly

`sensitive` governs the **audit log only** — `snapshotUserForAudit` redacts
those keys; outbox payloads still carry real values, because a connector cannot
provision a mailbox quota it is not given.

Turning it on therefore reduces what the audit log can see, which makes it the
one field whose own change must be unmissable. It gets its own audit action
rather than folding into a generic update.

Worth recording: the column's schema comment says it was landed deliberately
while the table was still read-only, "the control has to exist before a write
path can create sensitive attributes, not after." This design is the write path
that comment anticipated.

## Authorization

Two new actions, following the existing `resource:verb` convention:

| Action | Covers | Roles |
|---|---|---|
| `attribute:read` | Listing and reading definitions | `super_admin`, `user_admin`, `auditor`, `read_only` |
| `attribute:manage` | Create, edit, deactivate, preview, commit | `super_admin` only |

`attribute:manage` is `super_admin`-only because a definition is schema rather
than data, and because `sensitive` and `selfEditable` ride on it.

**This narrows an existing permission.** The current `@Get()` is gated on
`user:read`, so today anyone holding it — including `help_desk` — can list
definitions. Moving it to `attribute:read` removes `help_desk`'s access. That is
defensible (help desk reads people, not schema) but it is a deliberate
behaviour change, not a side effect, and it must be called out in the
implementation plan and in `docs/08-authorization.md`.

Ripples: `ALL_ACTIONS` goes 24 → 26, `ROLE_PERMISSIONS` gains entries,
`guard-coverage.spec.ts` must list the controller, and `docs/08-authorization.md`
— corrected to "24 actions" earlier today — needs updating in the same change.

## API surface

| Route | Action | Notes |
|---|---|---|
| `GET /attribute-definitions` | `attribute:read` | Existing route, re-gated |
| `POST /attribute-definitions` | `attribute:manage` | Create |
| `PATCH /attribute-definitions/:id` | `attribute:manage` | Safe fields only; 400 naming `dataType`/`appliesTo` if either is present |
| `POST /attribute-definitions/:id/preview` | `attribute:manage` | Reports the effect of a `dataType`/`appliesTo` change; writes nothing |
| `POST /attribute-definitions/:id/commit` | `attribute:manage` | Applies a previously previewed change; blast-radius guarded |

Deactivation is `PATCH { isActive: false }`, not `DELETE` — nothing in this
system is deleted, and the column already exists.

## The migration job

```
AttributeMigrationJob.preview(definitionId, change) -> AttributeMigrationReport
AttributeMigrationJob.commit(definitionId, change, previewHash, opts) -> AttributeMigrationReport
```

`AttributeMigrationReport` carries: the population size, the count that would
change, the count that cannot be converted, a bounded sample of unconvertible
values with their user ids, and the blast-radius evaluation.

**Conversion is total or refused, never partial.** If any value cannot be
converted, `commit` refuses and names them. A partially migrated attribute —
some users `number`, some still `string`, under one definition claiming
`number` — is worse than either end state, and is exactly the silent mismatch
this design exists to prevent. `force` overrides the blast-radius refusal only;
it never overrides an unconvertible value.

Conversion rules are explicit, not inferred: `string` → `number` accepts only a
value that round-trips; `→ boolean` accepts only the literal forms already
accepted elsewhere in the codebase; `→ date` accepts only ISO-8601; `→ enum`
accepts only a value already in the definition's allowed list. Anything else is
unconvertible and reported.

## Console

A minimal surface, in the existing `apps/web/src/attributes/` directory, which
today holds only `AttributeField.tsx` and `api.ts`:

- A list page: key, label, data type, applies to, active, and the two flags.
- A create/edit form — about a dozen fields, no rule-builder complexity.
- The preview rendered before commit, showing the counts and the unconvertible
  sample, with commit disabled while any value is unconvertible.

The console must not be the only place the refusals are enforced. It renders
what the API tells it; the repository is what refuses.

A nav entry is required (the shell currently has 12 `action`-gated items), gated
on `attribute:read`.

## Testing

- The two refusals are the highest-value tests: a `selfEditable` set on a
  business-role-referenced attribute must be refused with the roles named, and
  a commit whose preview hash does not match must be refused.
- Conversion rules get a table-driven spec per source/target pair, including
  the unconvertible cases.
- Blast-radius behaviour reuses the existing evaluation, so the test is that it
  is *called* with the right population and that `force` is audited — not a
  re-test of the function.
- Every test must be shown failing before its implementation. Specs live in
  **two** directories here — `apps/api/src/**/*.spec.ts` and
  `apps/api/test/*.spec.ts`; search both before adding one.
- The API suite must be run capped: `--poolOptions.forks.minForks=1
  --poolOptions.forks.maxForks=3`. Both bounds are required.

## Risks

- **The `user:read` → `attribute:read` narrowing** silently removes access for
  `help_desk`. Called out above; must appear in the plan and the docs.
- **A `dataType` migration is irreversible** — the pre-change values are
  overwritten in place. The audit row must carry the before-values for the
  affected users, or the operation is unrecoverable. This is the single
  most important detail in the implementation.
- **`ALL_ACTIONS` changing to 26** touches documentation corrected hours ago;
  the docs guard does not check action counts, so nothing will catch a missed
  update automatically.
