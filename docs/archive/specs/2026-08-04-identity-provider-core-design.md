# Identity Provider — Core Directory Design

**Date:** 2026-08-04
**Status:** Approved
**Scope:** Sub-project 1 of 3 (core directory + Keycloak SSO)

## Summary

A single-tenant identity provider for one real organization. The system is the
authoritative source of identity data — users, org structure, groups, and
lifecycle state. Keycloak is delegated all credential and authentication
concerns and provides OIDC/SAML SSO to downstream applications. Changes flow
one way, from this system outward, over a transactional outbox.

Two later sub-projects (Active Directory connector, Google Workspace connector)
attach as additional consumers of that same outbox. They are out of scope here
but the architecture is designed so they require no re-plumbing.

## Context and constraints

| Decision | Value |
|---|---|
| Tenancy | Single tenant (one organization) |
| Purpose | Production directory for a real org — real security posture required |
| Source of truth | This system. Greenfield org, no existing directory to reconcile with |
| Sync direction | One-way outbound only. No bidirectional reconciliation |
| Data model | Full HR/IT model with admin-definable custom attributes |
| Admin model | Role-based, scoped to org-unit subtrees |
| Stack | TypeScript end-to-end — NestJS + Postgres + React |

Because the org is greenfield and this system is master, the hardest problem in
directory products — bidirectional conflict resolution between two systems that
both believe they own a user — is designed out entirely rather than solved.

## Architecture

### Components

| Component | Responsibility |
|---|---|
| Postgres | System of record for all identity data |
| API service (NestJS + TypeScript) | Business logic, validation, permission checks, audit writes |
| Admin console (React) | Directory management UI; an OIDC client of Keycloak |
| Self-service portal | Same React application, role-gated routes — not a second app |
| Keycloak | Credentials, MFA, sessions, tokens, OIDC/SAML to downstream apps |
| Sync worker | Drains the outbox and applies changes to Keycloak |

The admin console authenticates via Keycloak itself. The system contains no
login form of its own, and administrators inherit MFA from Keycloak.

### The transactional outbox

The keystone of the design. When the API mutates a record it writes the row
change, the audit entry, and an outbox event in a single Postgres transaction.
A worker drains the outbox and applies each change to Keycloak.

Consequences:

- **No lost writes.** If Keycloak is unavailable, changes queue and drain on
  recovery.
- **No distributed transaction.** Postgres and Keycloak never need to commit
  atomically.
- **Connectors are additive.** AD and Google Workspace become new consumers of
  the existing outbox, not new integration plumbing.
- **The outbox is a change log**, feeding the audit trail rather than
  duplicating it.

### Data flow — user creation

```
Admin -> console -> API
  |- check caller's scoped permission
  |- validate against attribute schema
  \- BEGIN TX
       insert user + insert audit entry + insert outbox event
     COMMIT
         |
   sync worker -> Keycloak Admin REST (create user, assign groups, no password)
         |
   Keycloak emails set-password / MFA-enrollment link
```

The system never generates, transmits, or stores a credential. Keycloak's
required-action email flow owns that path end to end.

### External identity linkage

```sql
external_identities(user_id, system, external_id, last_synced_at, sync_state)
    system IN ('keycloak', 'active_directory', 'google_workspace')
```

Kept in its own table so that adding a connector never alters `users`.

## Data model

### Hybrid attributes

Core attributes are real columns with real constraints. Admin-defined custom
attributes live in validated JSONB. Making everything dynamic would sacrifice
foreign keys, type safety, and query sanity on the fields used most.

```sql
users
  id, status, primary_email, username
  first_name, last_name, display_name
  employee_id, job_title
  org_unit_id  -> org_units      -- FK
  manager_id   -> users          -- FK, self-referential
  location, start_date, end_date
  attributes JSONB               -- custom fields
  created_at, updated_at, deactivated_at

attribute_definitions
  key, label, data_type, required, default_value,
  validation_rules JSONB, applies_to, sort_order, is_active,
  sync_to_keycloak BOOLEAN,      -- default false
  self_editable BOOLEAN          -- default false
```

`attribute_definitions` serves three purposes from one table: server-side
validation, automatic form rendering in the console, and declaration of which
fields propagate outward. Frequently-queried custom fields get expression
indexes, e.g. `CREATE INDEX ON users ((attributes->>'cost_center'))`.

### Org hierarchy

```sql
org_units(id, name, parent_id, path ltree)   -- GiST index on path
```

Postgres `ltree` is chosen specifically to make scoped RBAC cheap. An
authorization check reduces to an indexed containment test
(`target.path <@ actor_scope.path`) rather than a recursive walk on every
request.

### Groups

`groups` and `group_members`, supporting nested groups, with two requirements:

- **Cycle guard on membership insert.** Nested groups must remain a DAG or
  effective-membership expansion does not terminate.
- **Effective membership** computed by recursive CTE, cached, invalidated on
  change. Direct and effective membership must be visually distinct in the UI.

### Lifecycle and deletion

Status transitions: `pending -> active -> suspended -> deactivated`.
`deactivated` is terminal.

There is no delete operation. Removing a user means transitioning to
`deactivated` and stamping `deactivated_at`; the row is retained permanently.
A production directory must be able to answer "who had access last March", and
retention preserves manager and audit foreign keys. Deactivated users are
excluded from all default list and search views.

### Supporting tables

`roles`, `role_assignments`, `audit_log` (append-only), `outbox_events`,
`external_identities`.

## Keycloak integration

### Ownership split

This system owns identity data and lifecycle state. Keycloak owns passwords,
MFA enrollment, sessions, tokens, and login flows. Neither writes into the
other's domain.

### Attribute sync is default-deny

Only attributes flagged `sync_to_keycloak` are pushed. Anything sent to
Keycloak may surface in a JWT claim, and JWTs are logged, cached, and
forwarded between services. Identity and authorization data propagates; HR
data does not, unless explicitly and deliberately flagged.

### Outbox schema

```sql
outbox_events(
  id, aggregate_type, aggregate_id, event_type,
  payload JSONB, target, status, attempts,
  next_attempt_at, last_error, created_at)
```

`aggregate_type IN ('user','group','membership','org_unit')`.
`event_type IN ('created','updated','status_changed','membership_changed')`.
There is no `deleted` event type — deletion does not exist in the model;
removal propagates as a `status_changed` event carrying `deactivated`.
`status IN ('pending','processing','done','failed')`.
`target` is `'keycloak'` for this sub-project; connector targets are added later.

### Worker semantics

Three rules make the sync reliable:

1. **`SELECT ... FOR UPDATE SKIP LOCKED`** to claim work. Supports multiple
   workers, prevents double-processing, and is crash-safe — a dead worker's
   lock releases and the event is retried.
2. **Strict ordering per aggregate.** Events for a single user apply in
   sequence. Out-of-order application allows a stale update to silently clobber
   a rename.
3. **Reconcile to desired state, not apply-the-diff.** The worker reads the
   current row and asserts full desired state into Keycloak rather than
   replaying the recorded delta. Every retry is therefore idempotent, and a
   partially-applied change converges on the next attempt.

Retries use exponential backoff with jitter, a capped attempt count, and a
dead-letter state.

### Synchronous exception for access revocation

Suspend and deactivate execute synchronously first, with the outbox as
durability fallback. When someone is terminated, the account is disabled and
live sessions revoked immediately rather than whenever the queue drains. All
other operations may be eventually consistent; access revocation may not.

### Failure handling

| Failure | Behavior |
|---|---|
| Keycloak unreachable | Events queue, drain on recovery, UI shows pending badge |
| Conflict (409, username taken) | Dead-letter, surfaced as actionable error in console |
| Partial apply | Next retry reconciles to desired state |
| Worker crash mid-event | Lock releases, event remains pending, reprocessed |
| Direct edit in Keycloak | Nightly reconciliation job detects drift and re-asserts |

### Sync visibility

Every user record displays sync state per target, and stale or failed records
surface on the dashboard. Silent sync failure is the worst failure mode in a
directory product: an administrator believes access was revoked when it was
not. This must be observable rather than discovered.

## Authorization

### Model

```sql
role_assignments(user_id, role_id, scope_org_unit_id)
```

A check resolves to: does the actor hold a role granting this action, whose
scope path contains the target's path? Implemented as one authorization
service, deny by default, enforced in the API. The UI hides actions but never
decides them.

Baseline roles: Super Admin, User Admin, Help Desk, Auditor, Read-only.

### Required guards

- **No privilege escalation.** An administrator cannot grant a role they do not
  themselves hold, and cannot modify a principal whose privileges exceed their
  own. Absent this, "Help Desk can reset passwords" becomes "Help Desk can
  reset any executive's password and take over the organization."
- **Scope evaluated per request** against the target's current org unit, never
  cached into a session token. Otherwise moving a user between org units leaves
  stale access behind.

## Features

### Self-service portal

Same React application, role-gated. Users may edit fields flagged
`self_editable`, and view their group memberships read-only. All
credential-related actions — password change, MFA enrollment, device
management — deep-link into Keycloak's Account Console rather than a
reimplementation. This preserves the invariant that the system exposes no
credential surface of its own.

### Bulk import

CSV upload, then validate, then dry-run diff preview, then commit as a single
audited batch carrying a `batch_id`. Idempotent on `employee_id`. The preview
step is what makes the feature safe to delegate to an administrator; a silent
half-applied import across hundreds of users is unacceptable.

### Audit log

Append-only. Every mutation records actor, action, target, before/after state,
and timestamp, written in the same transaction as the mutation itself.
Searchable and filterable in the console.

### Joiner/mover/leaver automation

Rules are stored as data, not code: `trigger -> condition -> action`. No
scripting engine — an identity provider that executes arbitrary user-supplied
script is a privilege-escalation vector by construction.

A nightly scheduler drives date-based transitions: activation on `start_date`,
deactivation on `end_date`. Every rule must pass a simulate/dry-run before it
can be enabled.

## Testing strategy

Postgres and Keycloak both run as Testcontainers rather than mocks. The design
depends on real Keycloak behavior, and a mocked Admin API would only validate
assumptions about Keycloak rather than Keycloak itself.

| Layer | Focus |
|---|---|
| Unit | Permission engine (exhaustive), attribute validation, group cycle detection, effective membership |
| Integration | Real Postgres via Testcontainers |
| Contract | Real Keycloak Admin API via Testcontainers |
| Property | Applying any outbox event twice yields identical state |
| E2E (Playwright) | Create user in console -> user logs in via Keycloak -> assert token claims |
| Security | Privilege escalation attempts, scope boundary violations, IDOR on user endpoints |

Two areas carry disproportionate weight. The **permission engine** is the
security boundary — a coverage gap there is a vulnerability, not a missing
test. The **idempotence property test** validates the assumption the entire
outbox design rests upon.

## Build order

| # | Milestone | Rationale |
|---|---|---|
| 1 | Schema, migrations, attribute definitions, console login via Keycloak OIDC | Foundation |
| 2 | Core CRUD — users, org units, groups, effective membership | |
| 3 | RBAC engine + audit log | Must land before other write paths; retrofitting either is brutal |
| 4 | Outbox + sync worker + reconciliation | First genuinely useful system — a working IdP with SSO |
| 5 | Bulk import | Enables loading the real organization |
| 6 | Self-service portal | |
| 7 | Joiner/mover/leaver automation | Sequenced last so it can slip without blocking |

Milestone 4 is the meaningful delivery point. Milestones 5–7 approximately
double the total effort, which is why the ordering matters: the system is
usable well before the scope is complete.

## Out of scope

- **Device and asset assignment.** An IT asset management domain that shares
  only the concept of a person. Deliberately excluded to keep inventory
  concepts out of the identity schema. Candidate for its own subsystem.
- **Active Directory connector.** Sub-project 2, separate spec.
- **Google Workspace connector.** Sub-project 3, separate spec.
- **Multi-tenancy.** Single-tenant by decision; not designed for.
- **SCIM server.** Not required by any known consumer.

## Forward dependencies

One decision is deferred to the Active Directory connector spec and recorded
here so it is not forgotten: **on-premises Active Directory and Entra ID are
different integration targets** with different protocols, authentication
models, and capabilities. On-prem AD implies LDAPS and a delegated service
account; Entra ID implies Microsoft Graph. Kerberos, Group Policy, and file
share ACLs require accounts that physically exist in on-prem AD and cannot be
emulated. Which of the two is the target must be settled before that spec is
written.
