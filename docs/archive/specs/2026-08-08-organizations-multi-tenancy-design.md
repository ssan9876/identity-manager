# Organizations — multi-tenancy and Keycloak realm provisioning

**Status:** design, not yet implemented.
**Date:** 2026-08-08.

## The problem

This system is single-tenant, deliberately and in writing. `docs/01-overview.md` says
"Not multi-tenant. One organisation per deployment." `docs/12-security.md` says "There is
no `tenant_id` anywhere." `docs/14-roadmap.md` lists single tenancy as a design decision
rather than a gap.

This design reverses that decision. An **organization** becomes a first-class object that
owns a Keycloak realm. Creating one creates the realm downstream, the way Keycloak's own
console creates a realm. One master organization is adopted at startup; every other one is
created through the API and the outbox.

## Scope

**In scope.** Organizations as an object; a Keycloak realm per organization, provisioned
through the existing outbox; tenant-partitioned directory data with per-organization
uniqueness; the migration that adopts all existing data into master; a console surface for
creating and suspending organizations; the documentation updates that retire the
single-tenancy claim.

**Out of scope**, each deferred to its own later spec:

- **Per-realm admin login.** `JwtGuard` stays single-issuer. Admins authenticate against
  the master realm and operate every tenant, exactly as a Keycloak master-realm admin does.
- **Tenant-scoped admin roles.** A global `role_assignments` grant spans all organizations.
- **Per-organization connector targets** for Active Directory, Entra ID, Google Workspace
  and the mail server.
- **Realm-level Keycloak configuration** — themes, token lifespans, per-tenant OIDC clients.

## Settled decisions

### 1. One organization owns exactly one root org unit

Scope is enforced today entirely through `org_units.path` (ltree): `PermissionEngine.assertCanIn`
and every list filter narrow on subtree containment. Binding an organization
to a single ltree root means "scoped to Acme" is already expressible as "scoped to path
`acme`", so every existing scope check, list filter and subtree query keeps working with no
change to its logic.

Rejected: **many roots per organization** (turns one indexed containment check into a
multi-root query everywhere scope is evaluated) and **organization as a free-standing
label** with no relation to the tree (permits a user in org A under an org unit in org B,
which then has to be checked for everywhere rather than made impossible).

### 2. One root per organization is held by removing free-standing root creation

`POST /org-units` starts requiring a parent. Roots are created only by organization
creation. This is a breaking change to that route and the right one: after this design a
root with no organization is meaningless.

It cannot be an index instead. The natural constraint — one root per organization — must
exempt master (decision 6), and a partial unique index cannot consult another table in its
predicate. Repository-level enforcement of an invariant has precedent here: status
transition allow-lists and group cycle detection both work this way.

### 3. There is no `root_org_unit_id` column

It would form a FK cycle with `org_units.organization_id`, and the rule "non-null unless
master" cannot be a `CHECK`, because checks are immediate and the intermediate state inside
the creating transaction would violate it. The root is derived: `parent_id IS NULL AND
organization_id = $1`.

### 4. Cross-tenant references are impossible, not merely checked

Given a unique index on `org_units (id, organization_id)`, the composite FK
`users (org_unit_id, organization_id) → org_units (id, organization_id)` makes a user in
org A physically unable to reference an org unit in org B. The same shape covers
`users.manager_id`, `groups.org_unit_id`, and both membership edge tables.

Nullable cases — a global group's `NULL` org unit, a user with no manager — pass
automatically under `MATCH SIMPLE`, which is the wanted behaviour.

This is the largest single piece of migration work in the design. It buys immunity to the
worst bug class in multi-tenancy, in the database rather than in application code that has
to remember.

### 5. Tenant organizations reach Keycloak and nothing else

`connector_targets`' primary key **is** the target: one Active Directory configuration, one
Entra configuration, one Google configuration for the entire system. Fanning a tenant's
people out to those would push every tenant into one shared downstream directory that has
no notion of organizations.

So `OutboxWriter.record` becomes organization-aware. Master fans out exactly as it does
today. A tenant organization emits `keycloak` only. The console shows tenant organizations
as Keycloak-only, so the restriction is visible rather than silent.

### 6. Master is exempt from the one-root rule and adopts everything

Multiple roots are permitted today. The migration adopts every existing root, and
everything beneath it, into the master organization. No ltree path is rewritten, so nothing
existing moves and the migration is reversible.

Rejected: **re-parenting existing roots** under a synthetic `master` root, which rewrites
every path in a unique, GiST-indexed, widely referenced column for a cosmetic invariant;
and **refusing to migrate** when several roots exist, which turns an upgrade into a manual
data-modelling exercise.

The invariant therefore reads: one root per organization, except master.

### 7. Realm provisioning uses a second, master-realm credential

`POST /admin/realms` is a server-level endpoint requiring the `create-realm` role, which
exists only in Keycloak's `master` realm. The current admin service account lives inside
the `identity-manager` realm holding realm-scoped `realm-management` roles, so it
structurally cannot create realms. New credentials are unavoidable.

`KEYCLOAK_PROVISION_CLIENT_ID` / `KEYCLOAK_PROVISION_CLIENT_SECRET` name a service account
in the `master` realm. It creates realms and administers tenant realms. Today's credential
keeps serving the master organization unchanged, so existing deployments need no Keycloak
reconfiguration and the ordinary user-sync path keeps its current narrow privileges.

Rejected: **one master credential for everything**, which would run every routine user
update under a server-wide admin identity; and **per-realm generated clients**, which is
the best least-privilege end state but requires storing and rotating N generated secrets —
forbidden outright by this repo's rule that no secret is ever stored, only referenced by
environment-variable name and resolved at point of use. It can be added later without
redesigning any of this.

### 8. Nothing deletes a realm

Suspending an organization sets the realm to `enabled: false`. Deleting a realm destroys
its users, sessions and clients irreversibly, which is precisely what this system's
no-delete principle exists to prevent.

## Data model

### New table `organizations`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `slug` | varchar(63) | unique; **this is the Keycloak realm name** for organizations created through the API |
| `name` | varchar(255) | display name, becomes the realm's `displayName` |
| `realm` | varchar(63) | stored, not derived — master's realm comes from `KEYCLOAK_ISSUER` and will not equal its slug |
| `status` | enum | `active` · `suspended` |
| `is_master` | boolean | exactly one `true`, via a partial unique index |
| `realm_provisioned_at` | timestamptz | null until the connector confirms the realm exists |
| `created_at` / `updated_at` | timestamptz | |

`slug` matches `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`. `CHECK (realm IS NOT NULL OR
is_master)` keeps the transient null legal for master alone, between the migration and
first startup.

The migration gives the master organization the slug `master`. Reserved-name rejection —
`master`, and the master organization's own realm name — applies **only to user-supplied
slugs at the API boundary**, so the migration setting that exact value is not a
contradiction. Note that master's slug and its realm are unrelated strings: the slug is
only used as a realm name for organizations created through the API, whereas master's
realm comes from `KEYCLOAK_ISSUER` and is typically `identity-manager`.

`slug` and `realm` are **immutable after creation**. There is no route that changes either;
renaming a realm would orphan every user in it.

### Columns added to the core directory tables

`organization_id` — uuid, `NOT NULL`, `ON DELETE RESTRICT` — on `org_units`, `users` and
`groups`. Nullable on `audit_log`, so per-tenant audit filtering is possible while
platform-level actions can still have no organization.

Two further tables take the column for reasons of their own — see "Every other table"
below, which accounts for all eighteen.

### Uniqueness becomes per-organization

| Table | Was | Becomes |
|---|---|---|
| `users` | unique `lower(username)` | unique `(organization_id, lower(username))` |
| `users` | unique `lower(primary_email)` | unique `(organization_id, lower(primary_email))` |
| `users` | unique `employee_id` when not null | unique `(organization_id, employee_id)` when not null |
| `groups` | unique `lower(name)` | unique `(organization_id, lower(name))` |
| `org_units` | unique `path` | **unchanged** |

`org_units.path` needs no change: each organization's paths begin with its own unique root
label, so they remain globally unique for free.

### Every other table, decided explicitly

Eighteen tables exist. The ones above are changed; these are the rest, and the reason each
is left alone or not.

| Table | Decision |
|---|---|
| `business_roles`, `business_role_conditions`, `business_role_grants`, `business_role_exceptions` | **Gain `organization_id`** (on `business_roles`; the other three inherit through their parent). A role's formula uses `in_org_subtree` and its grants hand out group membership — a role with no organization would evaluate across every tenant. Nothing reads these tables yet, so the column is nearly free now and expensive once a reconciler exists. |
| `jml_rules` | **Gains `organization_id`**, backfilled to master. Rules fire on user events and users are now per-organization; a rule with no organization would act on every tenant's people. |
| `attribute_definitions`, `attribute_target_mappings` | **Unchanged — platform-global.** Tenants do not define their own custom attributes or target mappings in this slice. |
| `connector_targets` | **Unchanged.** Per-organization targets are explicitly out of scope; decision 5 is what keeps that safe. |
| `role_assignments` | **Unchanged.** Admins are platform operators here, so a global grant spanning all organizations is correct for this slice. It is the first thing tenant-scoped admin roles will revisit. |
| `external_identities`, `external_group_identities`, `user_target_accounts` | **Unchanged.** Each row hangs off exactly one user or group, so its organization is already derivable through that FK. A column would be denormalisation with drift potential and no query to justify it. |

### Outbox

`outbox_aggregate_type` gains `organization`. Existing event types suffice — creation is
`created`, suspend and reactivate are `status_changed`.

The value is added in its **own migration**. `db/schema/connector-targets.ts` documents the
trap: Postgres forbids using a value added by `ALTER TYPE ... ADD VALUE` in the same
transaction that added it, and drizzle applies every pending migration inside one
transaction. No migration here inserts an outbox row, so this is precautionary rather than
load-bearing — but it matches the precedent that file set.

`outbox_events` needs no organization column. The worker re-reads the current row and
derives the organization from it, exactly as it already re-derives all other desired state.

## Components

### `KeycloakAdminClientFactory`

Returns a `KeycloakAdminClient` bound to a named realm, memoized per realm, sharing one
token provider. The master realm resolves to today's realm-scoped credentials; every other
realm resolves to the provisioning credentials.

`KeycloakAdminClient`'s existing constructor is unchanged — it already derives its admin
base URL from an issuer of the form `<serverRoot>/realms/<realm>` — so no existing test
changes.

### Master adoption at startup

Master's realm already exists; it is the one in `KEYCLOAK_ISSUER`. Startup makes **no**
Keycloak call for master.

The migration creates the master row with `realm` null and backfills every org unit, user
and group to it before adding the `NOT NULL` constraints. Startup then resolves the realm
from `KEYCLOAK_ISSUER` and fills it in.

If master already has a realm and it **differs** from `KEYCLOAK_ISSUER`, the API refuses to
start. Silently accepting a changed issuer would re-point every existing user at a
different realm.

This runs in `main.ts` before `listen`, never as a Nest lifecycle hook — the same reasoning
that keeps the sync worker out of one, so that every test compiling `AppModule` gets no
side effect.

### Creating an organization

`POST /organizations`, gated on a new global `organization:create` action. One transaction
writes:

1. the `organizations` row, `status = active`, `realm_provisioned_at = null`
2. its root org unit, `path = slug`, `parent_id = null`
3. the `audit_log` row
4. one `outbox_events` row — `(organization, <id>, created, keycloak)`

The worker claims it and calls `POST /admin/realms` with `{ realm, enabled: true, displayName }`
through the provisioning client, then sets `realm_provisioned_at`.

A 409 from Keycloak counts as success — the realm exists, which is the desired state. This
mirrors how `ensureGroup` already treats its own 409.

### Provisioning order

Outbox ordering is per `(aggregate, target)`. A user created in Acme moments after Acme is
a **different aggregate**, so nothing prevents that user's event being claimed before the
realm exists.

Left alone this half-works: the push fails, backs off and eventually succeeds — but it
consumes attempts against the max-8 dead-letter budget, and if realm creation itself
dead-letters then every user in the organization dead-letters behind it with no legible
reason.

So reconciling a user whose organization has `realm_provisioned_at IS NULL` raises a
distinct **retryable, non-counting** error that defers the event instead of failing it.
This surfaces through the sync-diagnostics work already merged: "waiting on realm
provisioning" is a pending reason a badge can explain, rather than an unexplained stall.

### Suspend and reactivate

`PATCH /organizations/:id` with `status`. Suspend emits `status_changed`; the connector
sets the realm to `enabled: false`. Reactivate re-enables. No path deletes a realm.

### Console

An Organizations page: the list with realm and sync status, a create form, and
suspend/reactivate. Tenant organizations display as Keycloak-only, per decision 5.

## Error handling

| Condition | Result |
|---|---|
| Malformed slug | `VALIDATION_FAILED` → 400 |
| Slug taken, or reserved (`master`, master's realm) | `CONFLICT` → 409 |
| Provisioning credential not configured | `NOT_CONFIGURED` → 503 |
| Keycloak 409 on realm create | success — desired state reached |
| Keycloak unreachable or 5xx | ordinary retryable outbox failure, backoff then dead letter |

`NOT_CONFIGURED` → 503 is a new row in the error table in `docs/02-architecture.md`. The
alternative — accept the write and let the sync fail — is more consistent with the outbox
rule that writes never depend on Keycloak being reachable, but it manufactures
organizations that can never provision. A 503 saying why is more honest than a dead letter
found later.

A realm created whose subsequent role grant failed is repaired by retry: both steps are
idempotent and the connector re-asserts full desired state.

## Testing

Against the real Keycloak container that `test/support/keycloak.ts` already provides.

1. **Migration.** Seed a pre-migration database with users, groups and *several* roots.
   Assert all of it lands in master and no ltree path changed.
2. **Per-organization uniqueness.** `jsmith` in two organizations succeeds; twice in one is
   a 409.
3. **The structural claim.** A user in org A pointed at an org unit in org B is rejected
   *by the database*. If this passes only because application code caught it first, the
   composite FKs are not doing their job and the test is not testing decision 4.
4. **Idempotence.** Creating the same organization twice yields one realm and no error.
5. **Provisioning authority.** After creating a realm, the provisioning client can create a
   user *in* it. Keycloak's auto-grant to the creating account is treated as **unverified**;
   this test settles whether an explicit `<realm>-realm` role grant is also required.
6. **Deferral.** A user in an unprovisioned organization defers without consuming attempts,
   then converges once the realm lands.
7. **Fan-out.** A tenant user emits exactly one `keycloak` row; a master user's fan-out is
   unchanged.
8. **Isolation.** Tenant operations leave master's Keycloak state untouched.

## Documentation

Retiring the single-tenancy claim is part of this work, not a follow-up.

| Document | Change |
|---|---|
| `01-overview.md` | Remove "Not multi-tenant. One organisation per deployment." |
| `12-security.md` | Replace claim 12, "Single tenant. There is no `tenant_id` anywhere" |
| `14-roadmap.md` | Move multi-tenancy from non-goal to delivered, with the deferrals named |
| `03-data-model.md` | `organizations`, the new columns, the per-organization uniqueness |
| `02-architecture.md` | Organization-aware fan-out; the `NOT_CONFIGURED` error row |
| `06-configuration.md` | `KEYCLOAK_PROVISION_CLIENT_ID` / `_SECRET` |
| `10-api-reference.md` | The `/organizations` routes; `POST /org-units` now requires a parent |
| `07-admin-guide.md` | Creating and suspending an organization |
