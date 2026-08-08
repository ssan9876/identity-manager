# Sub-project 4 — Business Roles and Entitlements Design

**Date:** 2026-08-08

**Status:** approved direction — build order M15 → M19.

## What this is

Sub-projects 1–3 made this system the master directory and pushed mastered identity
outward: Postgres holds people, org units and groups; Keycloak holds credentials; and
connectors assert desired state into Active Directory, Entra ID, Google Workspace and a
mail server.

None of them answer *who should have what*. Access is decided two ways today. Someone is
added to a group by hand, or a JML rule fires once on an event and adds them. Both are
imperative: they describe a moment, not a standing truth. Neither can answer "why does
this person have this?", and neither reacts when the answer should change — a mover who
transfers from Sales to Finance keeps every Sales group until a human notices.

This sub-project adds the missing layer. A **business role** owns a membership formula
and a set of entitlements, and an engine continuously reconciles the two. It is the
capability HelloID sells as "Role Based Access Control — assign entitlements based on
roles", and it is the dependency root for the rest of that product's surface: segregation
of duties and periodic recertification both need entitlements to operate on, and a
requestable service-catalogue product is an entitlement someone asks for.

## Settled decisions — do not re-litigate

1. **Membership is derived, with audited exceptions.** A role holds a formula over user
   fields and the engine computes its member set continuously. An admin may also include
   or exclude a specific person, and every such exception carries a mandatory reason and
   an optional expiry. Exceptions exist because they always happen in practice: a model
   that cannot hold one gets a formula bent to cover a single person, which is how
   entitlement models rot. Expiring exceptions are also the natural queue for a later
   recertification campaign.

2. **Two grant kinds, and no more.** A role grants group membership and target-account
   existence. It does not grant licences, mailbox settings, share permissions, or
   anything else a connector might advertise. Generic connector-declared entitlement
   types would require widening `DirectoryConnector`, which sub-project 2 settled as a
   deliberately narrow, settled interface. That is a later sub-project, once the model
   has proven itself on two kinds.

3. **Memberships carry provenance, and the engine only ever revokes what it granted.**
   Automation and hand-grants coexist; neither silently eats the other. A hand-added
   membership survives a role that says otherwise, and displays as manually granted with
   no role behind it.

4. **JML keeps state transitions; business roles own desired state.** JML answers "when
   this moment arrives or this event fires, change the person's state" — it retains
   `set_attribute` and `deactivate`, including the schedule-driven `start_date_reached`
   and `end_date_reached` triggers. Business roles answer "given the person's state, what
   should they have". `add_to_group` and `remove_from_group` move to roles. A start-date
   rule flips `status` from `pending` to `active` and the role engine reacts to the
   result, so the temporal case still works without roles needing a scheduler of their
   own.

5. **The formula is a flat AND-list over a closed vocabulary. There is no expression
   language.** Every condition must match. This is less limiting than it looks: the `in`
   operator already gives OR within one field, `in_org_subtree` covers department-and-
   below, and a person's entitlements are the **union** of every role they hold, so OR
   across different fields is expressed as two roles granting the same set. The JML
   engine's core safety property — rules are data, never code, proven by a static source
   scan — extends to this module unchanged.

6. **The engine computes into existing tables.** There is no new authoritative
   entitlement ledger with `group_members` as its projection. A second writer on group
   membership, or a rewrite of the existing `group:manage_members` endpoint and its three
   privilege guards, is a large disturbance to proven, audited code — and it buys only a
   query that a view over two provenance-carrying tables already answers.

7. **Nothing takes effect until that exact thing has been simulated.** Edits land in a
   draft that affects nobody. Publishing requires a simulation of the precise draft being
   published, matched by hash, so you cannot simulate something harmless and publish
   something else. Enforced in the repository rather than by caller convention, as
   `jml_rules` already does with its own weaker version of the same gate.

8. **Offboarding never acquires a dependency on a formula being correct.** Deactivation
   keeps its existing unconditional path.

9. **Target-account provisioning changes per target, and opt-in.** The old behaviour
   stays the default until an operator deliberately migrates one target.

## Data model

### New tables

Following the existing Drizzle conventions: `uuid` primary keys with `defaultRandom()`,
`withTimezone` timestamps, `pgEnum` for closed vocabularies, and `check` constraints in
the shape `connector-targets.ts` already uses.

**`business_roles`**

| Column | Notes |
|---|---|
| `id` | uuid pk |
| `name` | varchar(255), unique |
| `description` | text |
| `enabled` | boolean, `notNull().default(false)` — the kill switch; disabling revokes, see "The safety gate" |
| `draft_definition` | jsonb, nullable — pending edits, affecting nobody until published |
| `simulated_at` | timestamp, nullable — NULL means never simulated |
| `simulated_draft_hash` | varchar(64), nullable — hash of the draft that simulation ran against |
| `created_at` / `updated_at` | |

`enabled` defaults false at the column level, so a freshly created role grants nothing
until someone deliberately turns it on.

**`business_role_conditions`** — the flat AND-list, and the **published** definition: these
rows are what the engine evaluates. Edits do not land here directly; they land in
`draft_definition` and are copied down transactionally on publish. Keeping the live path in
typed, enum-constrained columns rather than in jsonb is the point of the split — the draft
is scratch, and the thing the engine reads is schema-enforced.

| Column | Notes |
|---|---|
| `id` | uuid pk |
| `business_role_id` | → `business_roles.id`, `onDelete: cascade` |
| `field` | varchar(128) |
| `operator` | pgEnum `business_role_condition_operator`: `equals`, `not_equals`, `in`, `in_org_subtree` |
| `value` | jsonb, nullable |

`field` is deliberately **not** a Postgres enum, for exactly the reason
`jml_rules.condition_field` is not: it names a column on `users` plus the open-ended
`attributes.<key>` form, so the vocabulary is closed by an application-code allowlist
(`CONDITION_FIELD_EXTRACTORS`), not by the schema. `value` is nullable so a condition can
compare against the JSON literal `null`, matching `jml_rules.condition_value`.

**`business_role_grants`** — what a role grants. Part of the published definition, on the
same terms as the conditions above.

| Column | Notes |
|---|---|
| `id` | uuid pk |
| `business_role_id` | → `business_roles.id`, `onDelete: cascade` |
| `kind` | pgEnum `business_role_grant_kind`: `group_membership`, `target_account` |
| `group_id` | → `groups.id`, nullable, `onDelete: restrict` |
| `target` | varchar, nullable — the `ConnectorTarget` vocabulary |

A `check` constraint asserts exactly one of `group_id` / `target` is set and that it
matches `kind`. `onDelete: restrict` on `group_id` is deliberate: deleting a group that a
role grants must fail loudly rather than silently stripping access from everyone holding
the role. Unique indexes on `(business_role_id, kind, group_id)` and
`(business_role_id, kind, target)`.

**`business_role_exceptions`** — the audited overrides.

| Column | Notes |
|---|---|
| `id` | uuid pk |
| `business_role_id` | → `business_roles.id`, `onDelete: cascade` |
| `user_id` | → `users.id` |
| `mode` | pgEnum `business_role_exception_mode`: `include`, `exclude` |
| `reason` | text, **notNull** |
| `expires_at` | timestamp, nullable |
| `granted_by` | → `users.id` |
| `created_at` | |

Unique on `(business_role_id, user_id)`. `reason` is not nullable because an unexplained
exception is the thing a recertification campaign cannot act on.

**`user_target_accounts`** — desired account existence per target.

| Column | Notes |
|---|---|
| `id` | uuid pk |
| `user_id` | → `users.id` |
| `target` | the `ConnectorTarget` vocabulary |
| provenance columns | see below |

Unique on `(user_id, target)`.

### Provenance

`group_members` and `user_target_accounts` both gain:

| Column | Notes |
|---|---|
| `grant_source` | pgEnum `grant_source`: `business_role`, `manual` |
| `granted_by` | → `users.id`, nullable |
| `granted_at` | timestamp |

**Exactly two values, deliberately.** A `jml_rule` value would be dead on arrival, because
this sub-project removes JML's `add_to_group` and `remove_from_group` — nothing in JML will
ever grant a membership again. An `import` value would be dead too: the CSV import does not
touch group membership at all today. Both are tempting to add speculatively, and both would
be permanent, because Postgres can `ADD VALUE` to an enum but can never drop one. The
asymmetry decides it — start with the two sources that genuinely exist, and add a third the
day something genuinely becomes a third.

The migration backfills every existing `group_members` row to `manual`. That is safe by
construction rather than by luck: the reconciler never revokes a `manual` row, so a
backfill that guesses conservatively cannot cause a revocation.

### Why provenance does not record *which* role

Provenance records **that** a row is role-derived, not which role derived it. When two
roles both grant group G there is still one membership row, and a stored list of
justifying roles would go stale the instant a formula changed.

Instead the reconciler recomputes the entire role-derived desired set for a user on every
pass — it only needs to know whether that set still contains the row — and the console
answers "why does this person have this?" by running the evaluator live. Always correct,
never stale, and no join table.

Two consequences follow, and both are intended:

- A membership that is both hand-granted and role-justified remains a single `manual`
  row, and therefore **survives** the role ceasing to match. A human deliberately granted
  it; the engine did not, so the engine does not take it away.
- If someone hand-removes a membership that a role still wants, the next pass **re-adds
  it** as `business_role`.

## Architecture

A new `apps/api/src/business-roles/`, split along the pure/impure line the codebase
already draws between `jml/rule-engine.ts` and `jml/rule-applier.ts`.

### The evaluator — pure and total

`role-evaluator.ts` computes `(user, roles[]) → { groupIds: Set, targets: Set }`. No
database, no ambient clock — `now` is injected, so expiry comparison is testable at its
boundary.

Condition matching reuses the JML engine's discipline exactly: `Object.create(null)`-based
closed sets for operators and an allowlisted `CONDITION_FIELD_EXTRACTORS` for fields, so a
value read back from a Postgres enum column that happens to collide with an
`Object.prototype` name cannot dispatch to an inherited value. This is the fourth time
this project has defended that hazard; see `authz/actions.ts` and `jml/rule-engine.ts` for
the previous three.

**A role with zero conditions matches nobody.** Not vacuously everybody, which is what a
naive "every condition must match" fold over an empty list returns, and which would make an
unfinished role grant its entitlements to the entire directory the moment it was enabled.
This is stated here because it is the single most dangerous default in the whole design and
it must be a named, tested case rather than an emergent property of a `reduce`.

**The field allowlist is exactly five entries:** `jobTitle`, `orgUnitId`, `location`,
`status`, and the open-ended `attributes.<key>` form. It must stay identical to the trigger
list under "When reconciliation runs" below — a field that can be named in a formula but
does not trigger re-evaluation when it changes is a mover whose access silently fails to
follow them, which is the exact failure this sub-project exists to remove.

Three fields are excluded on purpose. `managerId` immediately raises whether "reports to X"
means direct reports or the whole subtree, and the org-unit hierarchy already answers the
question people reach for it to ask. `startDate` and `endDate` are inputs to JML state
transitions, not standing truths: a date that has passed should already have moved `status`,
and keying a formula off the raw date as well would put two disagreeing clocks in the
system.

Exception precedence, in order:

1. `exclude` beats everything.
2. `include` grants regardless of the formula.
3. Otherwise the formula decides.

An expired exception is treated as **absent**, not as a denial — an expired `exclude` stops
excluding, and an expired `include` stops including.

The static source scan that proves `src/jml` contains no `eval`, no `new Function`, and no
template interpolation into anything executable is extended to cover `src/business-roles`.

### The reconciler — impure

`role-reconciler.ts` loads the user and the enabled roles, calls the evaluator, diffs the
result against current rows, and writes adds and removes in **one database transaction
together with its audit row**, enqueuing outbox events in that same transaction. That is
the pattern every existing mutation in this codebase already follows, and the new engine
inherits its guarantees by writing through the existing repositories rather than around
them.

It only ever revokes rows whose `grant_source` is `business_role`.

### When reconciliation runs

1. **On any user write that touches an evaluable field** — `jobTitle`, `orgUnitId`,
   `location`, `status`, or `attributes` — inside the same transaction as the write. A
   mover's access changes atomically with the move, and there is one audit story rather
   than two that can disagree.
2. **On a role change** — conditions, grants, exceptions, or enablement. That potentially
   touches thousands of people, so it is a job, not a request: the write enqueues a sweep
   for that role.
3. **A periodic full sweep** — a new `role-reconcile-cli.ts` and job alongside the
   existing `reconcile-cli.ts` and `target-reconcile-cli.ts`, following their conventions
   including walking **every** user status rather than only `active`.

### The safety gate: draft, simulate, publish

Editing a role's conditions or grants writes to `draft_definition`, and nothing about live
access changes. Simulation is then a dry run of the evaluator across the whole directory —
current published state versus the state the draft would produce — committing nothing and
returning the diff: N people gain these grants, M people lose these. It records both
`simulated_at` and `simulated_draft_hash`.

Publishing validates the draft, **refuses unless its hash equals `simulated_draft_hash`**,
copies it down into `business_role_conditions` and `business_role_grants` transactionally,
and clears the draft. That hash equality is what makes the gate airtight: it is not enough
to have simulated *something*, you must have simulated *this*. `name` and `description` sit
outside the draft entirely and stay freely editable, because neither can affect access.

An earlier version of this design instead made conditions and grants immutable while a role
was enabled, forcing a disable-edit-re-simulate-re-enable cycle. That was wrong, and the
reason is worth recording so it is not reinvented: because disabling revokes (below), every
edit to a live role would have revoked every entitlement it granted and re-granted them
moments later — churning every downstream target and briefly locking people out of real
systems in the middle of an edit. Drafts remove the need to disable in order to edit at all.

**There is deliberately no blast-radius cap.** The simulation already puts the number in
front of the admin before they commit; a hard cap would be a second mechanism guessing at
the same judgement, and it would have to be overridable to be usable, at which point it is a
dialog rather than a control.

**Exceptions stay editable at any time**, unlike conditions and grants — that is the entire
point of an exception. It is the live adjustment made to a running role without touching the
formula that governs everyone else, so it goes through no draft and enqueues re-evaluation
for exactly one person rather than a sweep. It is still audited, still requires its reason,
and still appears on that person's Entitlements tab.

**Disabling revokes.** The reconciler's desired set is the union over *enabled* roles, so a
disabled role's rows leave that set and are revoked on the next pass. Disable is a kill
switch, not a pause, and the console must say so before it happens: it belongs to the same
class of consequential action as deactivating a person, and PRODUCT.md's rule about making
consequence visible applies to it directly. Freezing instead would require knowing which
role owns each row, which provenance deliberately does not record.

### Unknown conditions: refuse to act

If the evaluator meets a condition it cannot understand — an operator or field written by
a migration newer than the running code — it does **not** skip the condition, because that
fails open and grants access that was never intended. It also does **not** simply treat the
role as non-matching, because that fails closed by silently *stripping* access.

It marks the role non-evaluable, and the reconciler then **refuses to compute a desired set
for that user at all**: nothing is granted, nothing is revoked, and the error surfaces the
way a failed sync already surfaces. A user who looks healthy while something dead-lettered
is the worst outcome this product can produce, and a rule engine that quietly removes
access is the same failure wearing a different hat.

### Sync integration

Unchanged: the `DirectoryConnector` interface (no widening), `SyncWorker`, the dead-letter
path, and attribute reconciliation.

Changed: `OutboxWriter` currently writes one outbox row per `enabled` row in
`connector_targets`, for every user. It must instead consult `user_target_accounts`.

**That flip, done naively, is a catastrophic silent regression.** On the day it ships, if
no role yet grants any target account, nobody gets an account in any system and the fan-out
simply stops. So the switch is per-target and opt-in: `connector_targets` gains a
`provisioning_mode` pgEnum, `all_users` or `entitled_only`. The migration sets every
existing row to `all_users`, so behaviour is unchanged until an operator deliberately
migrates one target, having first simulated the roles that will feed it. One system at a
time, each with a preview, and the old behaviour is always the default.

**Losing a target-account entitlement enqueues a `disable`.** It never merely drops out of
the fan-out. An account silently dropped from management stays enabled in the target
forever, which is precisely the orphaned account the governance sub-project would later
have to go and find. Commit `92055ee` already established this behaviour for the mail
connector's IdM-owned aliases; this generalises it.

`TargetReconciliationJob` learns the same distinction. On an `all_users` target it behaves
exactly as today. On an `entitled_only` target, "should this account exist at all" becomes
part of the desired state it corrects toward.

### Offboarding

Deactivation keeps its existing unconditional path: `revoke-access` still kills live
sessions synchronously, and the existing disable-on-deactivate still fires for every target
regardless of what any role says.

Role evaluation *also* strips the entitlements — `status` is a condition field, so a
deactivated person falls out of every role — but that is the second belt, never the braces.
The Friday-afternoon scene in PRODUCT.md is the one operation that must not acquire a new
dependency on rule correctness.

## Authorization

Two new actions in `authz/actions.ts`:

| Action | Held by |
|---|---|
| `business_role:read` | `super_admin`, `user_admin`, `auditor`, `read_only` |
| `business_role:manage` | `super_admin` only |

Mutating a business role requires a **global** grant (`scopeOrgUnitId: null`), following
the precedent commits `2648b9f` and `617a0b4` set for global connector infrastructure and
the audit log. The reasoning is direct: a formula spans the whole directory and a grant can
place anyone into any group, so a `user_admin` scoped to Sales authoring one would be a
scoped holding producing directory-wide effects — the exact escalation shape
`PrivilegeGuards.assertCanAssignRole` already exists to prevent.

Exceptions are global-only for the same reason, even though a scoped helpdesk exception is
superficially attractive: the role's grant set can reach groups far outside the granter's
own scope. If the catalog ever widens beyond `super_admin`,
`PrivilegeGuards.assertCanModifyPrincipal`'s rank check applies to exception targets too;
it is moot while only `super_admin` holds `business_role:manage`.

## API surface

A new `business-roles.controller.ts`:

| Route | Purpose |
|---|---|
| `GET /api/business-roles` | list |
| `POST /api/business-roles` | create — disabled by construction |
| `GET /api/business-roles/:id` | detail with conditions, grants and exceptions |
| `PATCH /api/business-roles/:id` | name and description only — neither can affect access |
| `PUT /api/business-roles/:id/draft` | write pending conditions and grants; affects nobody |
| `POST /api/business-roles/:id/simulate` | dry run of the draft, returns the diff, commits nothing, records `simulated_at` and `simulated_draft_hash` |
| `POST /api/business-roles/:id/publish` | refuses unless the draft's hash matches the simulated one; copies the draft down transactionally and clears it |
| `POST /api/business-roles/:id/enable` | |
| `POST /api/business-roles/:id/disable` | revokes this role's grants on the next pass |
| `POST /api/business-roles/:id/exceptions` | add an include/exclude with reason and optional expiry |
| `DELETE /api/business-roles/:id/exceptions/:userId` | |
| `GET /api/users/:id/entitlements` | every grant, its provenance, and — for role-derived rows — which roles justify it right now, from a live evaluator run |

`GET /api/users/:id/entitlements` is a read *about a user*, so it is narrowed by the actor's
org-unit scope exactly as every other single-user read already is
(`PermissionEngine.assertCanIn`): an out-of-scope but existing person returns 403, not 404.
It requires `user:read`, not `business_role:read` — a scoped help-desk operator should be
able to see why the people they support have the access they have.

## JML cleanup

`set_attribute` and `deactivate` stay. `add_to_group` and `remove_from_group` go, along
with their `rule-applier.ts` dispatch entries and their console affordances.

No data migration is required, because nothing is deployed and there is no production rule
data. There is one implementation wrinkle worth planning for rather than discovering:
Postgres cannot `DROP VALUE` from an enum, so the two labels remain in `jml_action` while
application code rejects them, and the migration **hard-fails if any existing row uses
one** rather than silently leaving behind a rule that will never fire again.

## Console

A new `apps/web/src/business-roles/`, and a nav item **Business roles** at
`/business-roles`, gated on `business_role:read`.

That collides with today's `/roles`, which is the console RBAC catalog
(`RolesCatalogPage`). Two entries reading "Roles" and "Business roles" would be genuinely
ambiguous, and this work is what creates the ambiguity, so the targeted fix is relabelling
the existing nav entry **"Roles" → "Admin roles"** — label only; the path, route and
component are untouched.

- **Role detail** — a conditions editor (field / operator / value rows), a grants list, an
  exceptions list showing reason and expiry, and a **Simulate** panel. The editor writes a
  draft, so the screen must make three states legible without a modal: published and
  unchanged, draft pending simulation, and draft simulated and ready to publish. Publish is
  the only control that changes anyone's access, and Simulate is the safety rail standing in
  front of it — per PRODUCT.md it must read as one, the way the import preview does.
- **Disable** carries a confirmation naming what it will revoke and how many people it
  affects, because it is a revocation and not a pause.
- **Person detail** gains an **Entitlements** tab: what someone has, where it came from,
  and which role or roles currently justify each role-derived row. Manual rows appear with
  no role behind them — which is exactly the queue a later recertification campaign works
  from.
- Everything follows DESIGN.md: tables rather than card grids, tabs rather than accordions,
  skeletons rather than spinners, status carried by a word and never by colour alone, and
  all seven states on every interactive component.

## Testing

**Evaluator — pure unit tests, table-driven.** Exception precedence (`exclude` over
`include` over formula), expiry at its exact boundary, `in_org_subtree` against real ltree
paths, `in` against a multi-value list, an unknown field or operator producing
refuse-to-act rather than grant-or-strip, and — named explicitly, not left to an emergent
`reduce` — **a role with zero conditions matching nobody**.

**The publish gate.** Publishing refuses when the draft hash does not match
`simulated_draft_hash`, including the case where the draft was edited *after* a successful
simulation. Writing a draft changes no live membership row. Publishing copies the draft down
and clears it in one transaction, and a failure part-way leaves neither half applied.

**Static source scan** over `src/business-roles`, extending the existing `src/jml` scan.

**Reconciler — Testcontainers integration.** A `manual` row survives a role that stops
matching. A hand-removed row is re-added as `business_role`. Two roles justifying one group
produce exactly one row, and it survives one of them ceasing to match. Disabling a role
revokes its rows and leaves every other role's rows alone. Deactivation strips role grants
*and* the unconditional disable path fires independently of role evaluation.

**Migration tests.** Every existing `group_members` row backfills to `manual`; every
existing `connector_targets` row lands on `all_users`; the `jml_action` migration fails
loudly on a surviving `add_to_group` row.

**Authorization tests.** A scoped `super_admin` is rejected for `business_role:manage`,
matching the connector-infrastructure precedent. `user_admin` can read and cannot manage.

**E2E.** Create a role, draft its conditions and grants, simulate it, read the diff, publish
it, enable it, watch a person's groups change, and open the Entitlements tab to see why.
Then edit the draft again and confirm publish is refused until the new draft is simulated.

## Build order

| Milestone | Scope |
|---|---|
| **M15** | Schema and provenance: five new tables, provenance columns, the `group_members` backfill, `provisioning_mode` on `connector_targets` defaulting to `all_users` |
| **M16** | The evaluator, pure and fully tested, including the static source scan |
| **M17** | The reconciler, its three trigger paths, the draft/simulate/publish gate, disable-revokes, and audit integration |
| **M18** | Sync integration: `OutboxWriter` consulting `user_target_accounts`, `entitled_only` targets, disable-on-entitlement-loss, `TargetReconciliationJob` |
| **M19** | Console: business roles nav and detail, the simulate panel, the person Entitlements tab, the "Roles" → "Admin roles" relabel, and the JML action removal |

M16 is deliberately isolated and ships before anything can write: a pure evaluator with no
database is provably correct on its own, and every later milestone depends on it being
right.

## Out of scope

- **Segregation of duties, periodic recertification, and orphaned-account reconciliation.**
  The governance sub-project. All three need this entitlement model to exist first, and
  orphan detection additionally needs a target-enumeration capability that
  `DirectoryConnector` does not have.
- **A self-service request catalogue with approval workflows.** A requestable product is an
  entitlement someone asks for, so it builds on this. Separate sub-project.
- **Generic connector-declared entitlement types** — licences, mailbox settings, share
  permissions. Requires widening `DirectoryConnector`; revisit once two grant kinds have
  proven the model.
- **An app launchpad portal.** Keycloak already owns SSO and ships its own account console.
- **Nested or inherited business roles.** A person's entitlements are the flat union of the
  roles they hold. Role hierarchies are a second graph to reason about and debug, and the
  union already covers what they are usually reached for.
- **Time-bounded role membership** beyond exception expiry. If a whole role needs to
  activate on a date, that is a JML state transition feeding a condition field.
