# 03 — Data model

Every table lives in its own file under `apps/api/src/db/schema/`, re-exported from
`index.ts` (which is what drizzle-kit reads to discover the schema). Migrations are
generated with `db:generate` and applied with `db:migrate`.

## Tenancy

### `organizations` — tenants

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `slug` | varchar(63) | Unique. A **DNS label** (`organizations_slug_format` CHECK), because it becomes the Keycloak realm name |
| `name` | varchar(255) | |
| `realm` | varchar(63) | The Keycloak realm. Always equal to `slug`. Nullable for **master alone** (`organizations_realm_present` CHECK) |
| `status` | enum | `active` \| `suspended` |
| `is_master` | boolean | Exactly one row may be true (`organizations_master_unique`, a partial unique index) |
| `realm_provisioned_at` | timestamptz | Stamped by the sync worker once the realm genuinely exists. `NULL` means "provisioning" |
| `created_at` / `updated_at` | timestamptz | |

`organizations_slug_unique` is a **plain** unique index on `slug`, not on `lower(slug)`:
the format CHECK already forbids any uppercase character, so folding the case did
nothing except make the index unusable for an ordinary equality lookup.

**Master** is the platform's own organization, created by migration 0025 and pinned at
startup: `adoptMasterRealm` records which realm `KEYCLOAK_ISSUER` names and refuses to
start if that ever disagrees with what is already stored — re-pointing it would strand
every existing user in a realm where none of their accounts exist. Master's realm
already exists, so nothing provisions it and `realm_provisioned_at` stays `NULL`
forever. Master cannot be suspended: doing so would disable the realm every
administrator, including whoever asked, signs in through.

There is **no delete**, and there is no `root_org_unit_id` column — that would form a
foreign-key cycle with `org_units.organization_id`, and "non-null unless master" cannot
be a CHECK because checks are immediate and the intermediate state inside the creating
transaction would violate it. The root is derived: `parent_id IS NULL AND
organization_id = $1`.

### `organization_id` and the composite foreign keys

`org_units`, `users`, `groups`, `group_user_members`, `group_group_members` and
`audit_log` all carry `organization_id`. On the directory tables it is `NOT NULL`; on
`audit_log` it is nullable, because rows predating organizations have none and
platform-level actions legitimately have none.

The column alone would not stop a cross-tenant reference — a user in Acme could still
name a manager in Globex, and every id involved would be perfectly valid. What stops it
is that **every such reference is a composite foreign key including `organization_id`**:

| Constraint | Refuses |
|---|---|
| `users_org_unit_organization_fk` | A user whose org unit is in another organization |
| `users_manager_organization_fk` | A manager in another organization |
| `groups_org_unit_organization_fk` | A group whose org unit is in another organization |
| `org_units_parent_organization_fk` | An org unit parented under another organization's subtree |
| `gum_group_organization_fk` / `gum_user_organization_fk` | A membership edge joining one tenant's group to another's person |
| `ggm_parent_organization_fk` / `ggm_child_organization_fk` | A nesting edge bridging two tenants — which would be a silent privilege bridge, since a nested group grants its parent's members everything the child grants |

`MATCH SIMPLE` semantics mean a NULL in either column satisfies the constraint outright,
which is exactly right for a root org unit (no parent), a global group (no org unit) and
most users (no manager recorded): none of those can be cross-tenant, because they point
at nothing at all.

Each of these reaches an API caller as a **409** naming the relationship
(`common/cross-tenant.ts`), never as an untranslated SQLSTATE 23503 — which would be an
indistinguishable-from-a-crash 500 on a request that was refused for a perfectly
comprehensible reason.

`organization_id` is **exposed on GET responses**, deliberately. The API has no response
DTOs, so Drizzle returns the column regardless; rather than adding explicit column lists
to every read in every repository, the field is owned and declared on the row types. It
is neither sensitive nor secret to its audience: every actor who can read a directory
row at all is a platform operator holding master-realm credentials, and
`organization:read` — which returns the roster and its ids — is held by exactly the same
population. If a tenant-facing API is ever added, this decision has to be revisited
*there*, with real DTOs.

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
| `target` | the `outbox_target` enum — **thirteen** values, listed in [The target catalog](#the-target-catalog) below |
| `status` | `pending` · `processing` · `done` · `failed` |
| `attempts`, `next_attempt_at`, `last_error` | retry bookkeeping |

Two indexes: the claim index `(status, next_attempt_at)` and the ordering index
`(aggregate_type, aggregate_id, target, id)`. The column order in the second is
load-bearing — the equality columns must lead and the ordering column must trail, or
the plan degrades to a full scan of every id for the aggregate.

### The target catalog

`outbox_target` and `external_identity_system` are two pgEnums holding the **same
thirteen labels, in the same order**, and that one-for-one correspondence is
load-bearing: `SyncWorker` writes a correlation row using `event.target` directly as
`external_identities.system`, with no mapping table between them. The canonical list in
application code is `ALL_CONNECTOR_TARGETS` in `apps/api/src/connectors/connector.ts`;
`test/connector-target-catalog.spec.ts` asserts the array and the pgEnum match in
**both** directions.

| Target | What it is |
|---|---|
| `keycloak` | The realm this system masters — users, groups, sessions |
| `active_directory` | LDAPS, with native group nesting |
| `entra_id` | Microsoft Graph |
| `google_workspace` | Admin SDK Directory API |
| `mail_server` | The mail sub-project; addresses a principal by **our** `users.id` |
| `echo` | The in-repo target that exercises the spine without a vendor protocol |
| `scim_slack` · `scim_zoom` · `scim_atlassian` · `scim_box` · `scim_snowflake` · `scim_generic` | Six SCIM 2.0 application slots — see below |
| `keycloak_sso` | OIDC/SAML **application** registration. Carries no principals at all |

**The six `scim_*` values share ONE adapter** (`apps/api/src/connectors/scim.connector.ts`).
SCIM 2.0 is identical across services; only the base URL, the credential and the write
mode differ, and all three are configuration. They are separate *target values* rather
than rows of a single `scim` target because **`(organization_id, target)` is
`connector_targets`' primary key and `(user_id, system)` is unique in
`external_identities`** — one configured instance per target value is a load-bearing
invariant of the outbox and correlation design, not an accident of naming. Naming each
application is what lets one organization provision Slack *and* Zoom *and* Box without
breaking that invariant, and it gives each slot its own credential, attribute mappings,
enable/disable, dry run and blast-radius settings. Adding a seventh application is a
list entry in `ALL_CONNECTOR_TARGETS`, a value in each pgEnum, a migration, one line in
`ConnectorRegistry` and one in the console's `TARGET_CONFIG_FIELDS` — **no new adapter
logic**.

**`keycloak_sso` is a different interface family.** It implements `SsoConnector`, not
`DirectoryConnector`, and it carries no principals: it registers OIDC and SAML clients
from `sso_apps`. That is why the type `DirectoryTarget` (`ALL_CONNECTOR_TARGETS` minus
this one value) exists, and why the attribute-mapping editor and `pnpm target-reconcile`
iterate it rather than the full catalog. No row in `external_identities` will ever carry
`keycloak_sso`; its correlation rows live in `external_sso_app_identities`, which reuses
the same enum.

### `external_identities` and `external_group_identities`

Correlation only — which remote object corresponds to which local row.

| Column | Notes |
|---|---|
| `user_id` / `group_id` | cascade |
| `system` | `external_identity_system` — the same thirteen labels as `outbox_target`, one for one |
| `external_id` | the target's **immutable** id — AD `objectGUID`, Graph `id`, Google `id`, SCIM `id` |
| `sync_state` | `pending` · `synced` · `failed` |
| `last_synced_at` | timestamptz |

Unique per `(user, system)` / `(group, system)`. That uniqueness is half of why the SCIM
slots are separate target values: one correlated remote account per person per slot.

Correlating on an immutable id, never a name or address, is what makes renames correct:
a changed email is a rename of an existing object, not an orphan plus a new empty one.
`external_group_identities` is what makes **native AD group nesting** possible — a
group-to-group `member` edge can only be written once the child group has an AD DN to
point at.

### `connector_targets`

One row per target **per organization**; `(organization_id, target)` **is** the primary
key (`connector_targets_pkey`, swapped in place by migration 0033) — there is no
surrogate `id`.

| Column | Default | Notes |
|---|---|---|
| `organization_id` | `master_organization_id()` | → `organizations.id`. An INSERT naming no organization lands in **master**; no read path ever falls back across organizations |
| `target` | | the `outbox_target` enum — all thirteen values above |
| `enabled` | `false` | `OutboxWriter` fans out only to enabled targets |
| `provisioning_mode` | `all_users` | or `entitled_only` — consults `user_target_accounts` |
| `config` | `{}` | **non-secret only**; secrets are referenced by env-var *name* |
| `blast_radius_threshold` | 20 | percent, `CHECK BETWEEN 1 AND 100` |
| `blast_radius_floor` | 5 | absolute count, `CHECK >= 0` |

An organization with no row for a target is simply not configured for it and never fans
out to it. Absence never resolves to another organization's row — that fallback would
push one tenant's people into a directory configured for a different tenant's estate,
which is exactly what the composite key makes unrepresentable.

**No secret ever lands in this table.** Reading a target through the API returns config
with no secret field present — not redacted, *absent*, because none is stored.

`keycloak` is the only target ever seeded, and it is seeded twice over: by migration for
**master**, and by `POST /organizations` — as its own audited `connector_target:configure`
row — for every new tenant, because a tenant with no row would fan out to nothing and
leave its realm empty forever. No migration seeds any other target: Postgres forbids
using an enum value added by `ALTER TYPE ... ADD VALUE` inside the same transaction that
added it, and all pending migrations run in one transaction on a fresh database. The
other twelve simply have no row until something configures one. `WHERE enabled = true`
treats "no row" and "disabled row" identically.

## SSO applications

### `sso_apps`

A downstream application registered for single sign-on, driven through the
`keycloak_sso` target. THIS row is the system of record; the Keycloak client is a
projection of it, asserted through the outbox like every other target.

| Column | Notes |
|---|---|
| `client_id` | Unique. **Immutable after create** — downstream applications hard-code it. For a SAML row this is also the SP's **entity id**: Keycloak keys a SAML client by entity id in this same field, so there is no second column to drift |
| `name`, `description` | |
| `protocol` | `sso_app_protocol` enum: `openid-connect` (default) or `saml`. Settable on create, **absent from update** — changing an application's protocol in place is a different application wearing the same row |
| `public_client` | PKCE is forced on, and is not an editable field |
| `redirect_uris`, `web_origins` | `text[]`; a wildcard is permitted only in the path |
| `groups_claim` | Whether to assert group membership — one flag, two realisations: the OIDC `groups` claim mapper or the SAML group attribute statement |
| `enabled` | |
| `saml_acs_urls`, `saml_sp_certificate`, `saml_sign_assertions`, `saml_name_id_format` | Added by migration **0039**. Nullable, and NULL on every OIDC row — nullable rather than defaulted so an OIDC row cannot quietly carry a plausible-looking SAML configuration. `saml_name_id_format` is the `sso_app_name_id_format` enum: `email` · `persistent` · `username` |

Both protocols share one table, deliberately: uniqueness, the reserved-name denylist,
the immutability rule, correlation and outbox fan-out are all protocol-independent, and
a second table would duplicate every one of those paths. There is deliberately **no
CHECK** tying the SAML columns to `protocol = 'saml'` — 0039 adds `'saml'` to the enum
and uses it nowhere, because Postgres rejects using an `ALTER TYPE ... ADD VALUE` value
in the transaction that added it. The closed request schemas in `sso-apps.controller.ts`
own that shape rule instead, as they already own every other rule for this table.

Uniqueness on `client_id` is a database index, not merely a controller check: it is
what every downstream application trusts, so a race must not be able to slip past it.

### `external_sso_app_identities`

Mirrors `external_group_identities` — `(app_id, system)` unique, reusing
`external_identity_system` and `external_identity_sync_state`. `external_id` is the
immutable UUID Keycloak assigns a client, **never `clientId`**. A Keycloak admin can
rename `clientId` directly; correlating on it would turn that rename into an orphaned
client plus a second, empty one on the next sync. Correlating on the UUID makes the
same rename self-correcting.

There is no delete for an application — no route, no repository method, no connector
method. Disabling sets `enabled = false` here and on the Keycloak client.

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

## Business roles

The engine that reads these tables **has shipped**. `business-roles/role-evaluator.ts`
computes the desired set, `role-reconciler.ts` applies it, `role-reconciliation.job.ts`
sweeps, `sod-checker.ts` enforces separation of duties, and `role-miner.ts` proposes
drafts from observed membership. `RoleReconciler` is registered in `app.module.ts` as an
ordinary provider — deliberately **not** `@Optional()`, so a wiring mistake fails at
boot rather than silently skipping entitlement changes. There is an HTTP surface
(`business-roles.controller.ts`) and a `role-reconcile` CLI. See
[14 — Roadmap](14-roadmap.md#business-roles-and-entitlements--landed).

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

### `role_conflicts`

Separation-of-duties pairs (migration 0034), enforced by `business-roles/sod-checker.ts`.
A conflicting pair of roles held by one person is a standing violation the controller
sweeps for after every change.

### Related tables that grew out of this area

Three more tables ride the same model and are **not** documented in detail here:
`business_roles.requestable` (0035, default false — nothing is offered in the
self-service catalogue until an administrator opts it in), `access_requests` (0036), and
`recert_campaigns` / `recert_items` (0037, 0038). Their behaviour is described in
[14 — Roadmap](14-roadmap.md); the schema files are `db/schema/access-requests.ts`,
`recert-campaigns.ts` and `recert-items.ts`.

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
