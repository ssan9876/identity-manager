# 03 — Data model

Every table lives in its own file under `apps/api/src/db/schema/`, re-exported from
`index.ts` (which is what drizzle-kit reads to discover the schema). Migrations are
generated with `db:generate` and applied with `db:migrate`.

## Core directory

### `org_units` — the org tree

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | varchar(255) | |
| `parent_id` | uuid → `org_units.id` | `ON DELETE RESTRICT`; `NULL` for a root |
| `path` | `ltree` | e.g. `acme.sales.emea` — **unique**, GiST-indexed |
| `created_at` / `updated_at` | timestamptz | |

The `ltree` path is what makes scope checks a single indexed containment query rather
than a recursive walk. Scope is transitive: an actor scoped to `acme.sales` reaches
`acme.sales.emea` and everything below it.

There is no update or delete route for an org unit. Creating a **root** requires a
global grant of `org_unit:create`; creating a **child** requires the grant to cover the
parent.

### `users` — people

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `status` | enum | `pending` · `active` · `suspended` · `deactivated` |
| `primary_email` | varchar(320) | unique on `lower(...)` |
| `username` | varchar(128) | unique on `lower(...)`; **this is the Keycloak join key** |
| `first_name`, `last_name`, `display_name` | varchar(128/256) | |
| `employee_id` | varchar(64) | unique when not null — the CSV import's idempotency key |
| `job_title`, `location` | varchar(255) | nullable |
| `org_unit_id` | uuid → `org_units.id` | `RESTRICT`; **required** |
| `manager_id` | uuid → `users.id` | `SET NULL`; self-referential |
| `start_date`, `end_date` | date | drive the JML lifecycle job |
| `attributes` | jsonb | custom attributes, validated against `attribute_definitions` |
| `created_at`, `updated_at`, `deactivated_at` | timestamptz | |

**`deactivated` is terminal.** There is no `DELETE` route for a user anywhere in the
API, and status transitions are constrained by an allow-list in the repository.

`username` is how an authenticated Keycloak principal is matched to a local row
(`preferred_username`). This is documented in the code as interim — `external_identities`
stores the Keycloak subject and is intended to become the authoritative mapping.

### `groups`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | varchar(255) | unique on `lower(...)` |
| `description` | varchar(1024) | nullable |
| `org_unit_id` | uuid → `org_units.id` | **nullable — `NULL` means the group is global** |
| `attributes` | jsonb | |

A group with `org_unit_id = NULL` is global: visible to, and writable by, any actor
holding the relevant action regardless of their own scope. Creating one requires a
**global** grant of `group:create`, because local group membership is pushed into real
Keycloak groups — a downstream authorization primitive.

### `group_user_members` and `group_group_members`

Membership edges. Both are composite-primary-key join tables with `ON DELETE CASCADE`.

`group_user_members` additionally carries **provenance**:

| Column | Notes |
|---|---|
| `grant_source` | `manual` or `business_role` — default `manual` |
| `granted_by` | uuid → `users.id`, `SET NULL` |
| `granted_at` | timestamptz |

The rule these columns exist for: **the reconciler only ever revokes what it granted.**
A hand-added membership survives a role that says otherwise. The `NOT NULL DEFAULT
'manual'` is what made the migration safe — every pre-existing row backfilled to
`manual`, which the reconciler never revokes.

`group_group_members` has a `CHECK` forbidding a self-edge, and cycle detection runs
under a Postgres advisory lock so two concurrent transactions cannot each observe "no
cycle" and jointly create one. A cycle attempt is `409 CYCLE_DETECTED` and writes no
audit row.

**Effective membership** is the transitive closure: direct members of a group, plus
members of every group nested inside it, recursively.

## Authorization

### `role_assignments`

| Column | Notes |
|---|---|
| `user_id` | uuid → `users.id`, cascade |
| `role_key` | enum: `super_admin` · `user_admin` · `help_desk` · `auditor` · `read_only` |
| `scope_org_unit_id` | uuid → `org_units.id`, cascade — **`NULL` means global** |

Two *partial* unique indexes, not one: Postgres does not treat `NULL`s as equal, so a
single unique index over `(user, role, scope)` would permit unlimited duplicate global
assignments.

What each role may do is **not** in the database — see `apps/api/src/authz/actions.ts`
and [08 — Authorization model](08-authorization.md).

## Audit

### `audit_log`

| Column | Notes |
|---|---|
| `id` | bigserial PK |
| `actor_user_id` | uuid → `users.id`, **`ON DELETE RESTRICT`** — nullable for system actions |
| `action` | varchar(64) — e.g. `user:create`, `role:assign`, `import:preview` |
| `resource_type` | varchar(64) |
| `resource_id` | uuid, nullable, **no FK** (it points at one of several tables) |
| `before` / `after` | jsonb snapshots, explicitly-named fields only |
| `batch_id` | uuid, nullable — set once per CSV import commit, on every row it produces |
| `created_at` | timestamptz, indexed |

`ON DELETE RESTRICT` rather than `SET NULL` is deliberate: `SET NULL` would make
Postgres issue an internal `UPDATE` against an append-only table, which the trigger
rejects anyway. `RESTRICT` gets to the same place through an ordinary FK violation.

**Append-only, twice over** — the runtime role has no `UPDATE`/`DELETE`/`TRUNCATE`
privilege, and triggers reject those statements for anyone who does (including the
owner). Defeating one mechanism is not enough.

## Sync

### `outbox_events`

| Column | Notes |
|---|---|
| `id` | bigserial PK — also the ordering key |
| `aggregate_type` | `user` · `group` · `membership` · `org_unit` |
| `aggregate_id` | uuid, no FK (depends on `aggregate_type`) |
| `event_type` | `created` · `updated` · `status_changed` · `membership_changed` |
| `payload` | jsonb — diagnostic context, never replayed as a delta |
| `target` | `keycloak` · `active_directory` · `entra_id` · `google_workspace` · `echo` · `mail_server` |
| `status` | `pending` · `processing` · `done` · `failed` |
| `attempts`, `next_attempt_at`, `last_error` | retry bookkeeping |

Two indexes: the claim index `(status, next_attempt_at)` and the ordering index
`(aggregate_type, aggregate_id, target, id)`. The column order in the second is
load-bearing — the equality columns must lead and the ordering column must trail, or
the plan degrades to a full scan of every id for the aggregate.

### `external_identities` and `external_group_identities`

Correlation only — which remote object corresponds to which local row.

| Column | Notes |
|---|---|
| `user_id` / `group_id` | cascade |
| `system` | same catalog as `outbox_target` |
| `external_id` | the target's **immutable** id — AD `objectGUID`, Graph `id`, Google `id` |
| `sync_state` | `pending` · `synced` · `failed` |
| `last_synced_at` | timestamptz |

Unique per `(user, system)` / `(group, system)`.

Correlating on an immutable id, never a name or address, is what makes renames correct:
a changed email is a rename of an existing object, not an orphan plus a new empty one.
`external_group_identities` is what makes **native AD group nesting** possible — a
group-to-group `member` edge can only be written once the child group has an AD DN to
point at.

### `connector_targets`

One row per target; `target` **is** the primary key.

| Column | Default | Notes |
|---|---|---|
| `enabled` | `false` | `OutboxWriter` fans out only to enabled targets |
| `provisioning_mode` | `all_users` | or `entitled_only` — consults `user_target_accounts` |
| `config` | `{}` | **non-secret only**; secrets are referenced by env-var *name* |
| `blast_radius_threshold` | 20 | percent, `CHECK BETWEEN 1 AND 100` |
| `blast_radius_floor` | 5 | absolute count, `CHECK >= 0` |

**No secret ever lands in this table.** Reading a target through the API returns config
with no secret field present — not redacted, *absent*, because none is stored.

Only `keycloak` is seeded by migration. Postgres forbids using an enum value added by
`ALTER TYPE ... ADD VALUE` inside the same transaction that added it, and all pending
migrations run in one transaction on a fresh database — so the other targets simply have
no row until something configures one. `WHERE enabled = true` treats "no row" and
"disabled row" identically.

## Custom attributes

### `attribute_definitions`

| Column | Notes |
|---|---|
| `key` | varchar(64) — unique per `applies_to` |
| `label` | display name |
| `data_type` | `string` · `number` · `boolean` · `date` · `enum` |
| `required`, `default_value`, `validation_rules` | validation inputs |
| `applies_to` | `user` or `group` |
| `sort_order`, `is_active` | display control |
| `self_editable` | **default false** — whether `PATCH /self` may touch it |

There is **no write endpoint** for this table. Definitions are seeded or managed
directly in the database today; `GET /attribute-definitions` is read-only.

### `attribute_target_mappings`

The opt-in that turns default-deny into propagation, per `(field, target)` pair.

| Column | Notes |
|---|---|
| `attribute_definition_id` **XOR** `core_field` | exactly one, enforced by `CHECK` |
| `core_field` | `given_name` · `surname` · `title` · `department` |
| `target` | which connector target |
| `remote_name` | what the field is called *there* |
| `enabled` | toggle without deleting |

**Absence of a row is what makes default-deny structural** — not a column default. A
field with no mapping row for a target cannot reach that target at all. The core-field
names deliberately use AD/LDAP vocabulary (`given_name`, `surname`) rather than this
codebase's own column names, because the whole point of a remote-name mapping is that
the local identifier need not match any one target's vocabulary.

## Lifecycle automation

### `jml_rules`

| Column | Notes |
|---|---|
| `name` | |
| `enabled` | **default false** — cannot be enabled until simulated at least once |
| `trigger` | `user_created` · `user_attribute_changed` · `start_date_reached` · `end_date_reached` |
| `condition_field` | a `users` column, or `attributes.<key>` — closed by an application allow-list, not a Postgres enum |
| `condition_operator` | `equals` · `not_equals` · `in` |
| `condition_value` | jsonb, nullable |
| `action` | `add_to_group` · `remove_from_group` · `set_attribute` · `deactivate` |
| `action_params` | jsonb |
| `simulated_at` | `NULL` = never simulated; the durable half of the enable gate |

Rules are **data, never code**. The engine treats every value read back from these
columns as untrusted input and never indexes a dispatch map without confirming the key
is present — a migration (or a rolling deploy) can put a label in a column that the
running code does not recognise.

There is **no HTTP surface** for JML rules today. They are database rows plus the
`jml:lifecycle` CLI.

## Business roles — schema landed, engine not yet built

These tables exist and are migrated. Nothing reads them yet. See
[14 — Roadmap](14-roadmap.md).

### `business_roles`

A membership formula plus a set of entitlements. **Two separate gates** live on this
table and do different jobs:

- **`enabled` is the kill switch.** The reconciler's desired set is the union over
  *enabled* roles, so disabling a role removes its rows from that set and they are
  revoked on the next pass. Disable is a **revocation**, not a pause.
- **`draft_definition` + `simulated_draft_hash` are the change gate.** Edits land in the
  draft and affect nobody; publishing is refused unless a simulation ran against that
  exact draft, matched by SHA-256 hash. You cannot simulate something harmless and
  publish something else.

An earlier design froze conditions while enabled, forcing disable–edit–re-enable —
which, because disable revokes, would have churned every downstream target and locked
people out of real systems mid-edit.

### `business_role_conditions`

A **flat AND-list** over a closed vocabulary. There is no expression language.
Operators: `equals`, `not_equals`, `in`, `in_org_subtree`. OR *within* a field is `in`;
OR *across* fields is two roles, because a person's entitlements are the **union** of
every role they hold.

### `business_role_grants`

Two grant kinds and no more: `group_membership` (references a group) and
`target_account` (references a connector target). A `CHECK` enforces that exactly one
reference is present and that it matches the declared kind. `ON DELETE RESTRICT` on the
group: deleting a group a role grants must fail loudly rather than silently stripping
access from everyone holding that role.

### `business_role_exceptions`

Audited per-user overrides — `include` or `exclude`, with a **mandatory** `reason` and
an optional `expires_at`. Exceptions exist because they always happen in practice: a
model that cannot hold one gets a formula bent to cover a single person, which is how
entitlement models rot. Expiring exceptions are also the natural queue for a later
recertification campaign.

### `user_target_accounts`

Desired account existence per `(user, target)` — the second grant kind. Carries the same
provenance columns as `group_user_members`, for the same reason.

`connector_targets.provisioning_mode` decides whether a target consults this table
(`entitled_only`) or provisions everyone (`all_users`, the default and the pre-business-
roles behaviour). The default is deliberate: on the day this ships, if no role yet grants
any target account, `entitled_only` everywhere would mean nobody gets an account in any
system and fan-out simply stops.

### `grant_source`

Exactly two values — `business_role` and `manual` — shared by `group_user_members` and
`user_target_accounts`. A `jml_rule` value would be dead on arrival (JML's group actions
move to roles) and an `import` value would be too (CSV import does not touch
membership). Postgres can `ADD VALUE` to an enum but can never drop one, so speculative
values are permanent mistakes.
