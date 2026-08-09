# 01 — Overview

## What this is

**Identity Manager** is a self-hosted identity provider, run by one operator for one or
more real organisations. It is the **system of record** for:

- **People** — who exists, their profile, their manager, their lifecycle state.
- **Org structure** — a hierarchical tree of org units, stored as a Postgres `ltree`.
- **Groups** — including groups nested inside other groups.
- **Entitlements** — who is in which group, and (in progress) why.
- **Administrative authority** — who may do what, and over which part of the tree.
- **The record of change** — an append-only audit log of every mutation.

It is deliberately **not** a credential store. Keycloak owns passwords, MFA, sessions,
and SSO (OIDC/SAML) to downstream applications. The two systems never share write
access to each other's domain.

## What it does

### 1. Masters identity

People, org units and groups are created, updated and deactivated here first. Every
mutation runs in one database transaction together with its audit row, so a rejected
write commits nothing and leaves no trace, and a successful one always leaves exactly
one.

Users are never deleted. `deactivated` is a terminal status; there is no `DELETE`
route for a user anywhere in the API.

### 2. Pushes identity outward

Every mutation also writes a row to a transactional **outbox**. A background
**sync worker** drains that outbox and asserts desired state into every enabled
target:

| Target | What it receives |
|---|---|
| **Keycloak** | Users, their enabled state, profile attributes, and group membership |
| **Active Directory** | Users over LDAPS, correlated by `objectGUID`, with native group nesting |
| **Entra ID** | Users via Microsoft Graph, correlated by Graph's immutable `id` |
| **Google Workspace** | Users via the Admin SDK, correlated by Google's immutable `id` |
| **Mail server** | Mailbox provisioning, keyed by *this* system's user id |
| **Echo** | An in-repo target that exercises the whole spine without a vendor |

The worker never replays a delta. It reads the current row from Postgres and asserts
full desired state, so a replayed or out-of-order event converges to the same place.

### 3. Offboards, immediately

Deactivation is the one operation that cannot wait for a queue. `POST
/users/:id/deactivate` commits the local transaction, then **synchronously** disables
the Keycloak account and revokes its live sessions before returning. The outbox event
is written too, as the durability fallback if that inline call fails.

### 4. Automates joiners, movers and leavers

Date-driven transitions (`start_date` reaches today → activate; `end_date` reaches
today → deactivate) and event-driven rules run through an on-demand lifecycle job.
Rules are **data, never code** — a closed vocabulary of triggers, operators and
actions, enforced by a static source scan in the test suite.

### 5. Imports in bulk, safely

CSV import previews before it commits. The preview resolves every row exactly as the
commit would — the same permission checks, the same lookups — and reports what would
be created, what would be updated, and what would fail and why. Import is idempotent
on `employeeId`, and every audit row from one commit shares a `batchId`.

### 6. Records everything

`audit_log` is append-only at the database level by **two independent mechanisms**:
the runtime database role has no `UPDATE`/`DELETE`/`TRUNCATE` privilege on it at all,
and triggers reject those statements for anyone who does. Defeating one is not enough.

## Who uses it

**The IT administrator** — one to a handful of people at a single company. They know
what an org unit is. Their day is onboarding a starter, moving someone between
departments, adding people to groups, and offboarding a leaver while a manager waits
on the phone.

**The help-desk operator** — scoped to one part of the tree. Reads and makes small
changes. Structurally cannot see or touch anything outside their scope.

**Every employee** — sees only `/self`: their own profile, their groups, and a link
out to Keycloak's Account Console for password and MFA.

## What it is not

- **Not a multi-tenant SaaS control plane.** It *is* multi-tenant as of the
  organizations milestone — every directory row belongs to an `organizations` row, and
  each tenant gets its own Keycloak realm — but every administrator is a **platform
  operator** authenticating against the master realm, and there is no tenant-facing API
  surface. A tenant's people reach **Keycloak only**: `connector_targets` is keyed by
  target name, so the one Active Directory / Entra / Google / mail configuration in the
  system belongs to the platform, and fanning a tenant out to it would create real
  accounts inside somebody else's estate.
- **Not a credential store.** No password field exists anywhere in the schema, and the
  console has an end-to-end test asserting no password input is ever rendered.
- **Not multi-forest / multi-domain AD.** Explicitly out of scope: one domain per
  configured target.
- **Not a general workflow engine.** JML rules are a closed vocabulary, not a DSL.
- **Not yet safe on an untrusted network.** See [12 — Security model](12-security.md).

## Technology

| Layer | Choice |
|---|---|
| API | NestJS 10 on Node 20+, TypeScript |
| Database | PostgreSQL 16, Drizzle ORM, `ltree` for the org tree |
| Validation | Zod at every HTTP boundary |
| Auth | Keycloak 26 — OIDC, JWT verified with `jose` |
| Console | React 18, Vite 5, React Router 7, `oidc-client-ts` |
| Directory I/O | `ldapts` (AD), `fetch` (Graph, Google, mail server) |
| Tests | Vitest + Testcontainers (API), Playwright (console E2E) |
| Packaging | pnpm workspace, two packages: `@idm/api`, `@idm/web` |

## Where to go next

- Running it locally: [04 — Quickstart](04-quickstart.md)
- Installing it properly: [05 — Installation](05-installation.md)
- Understanding the moving parts: [02 — Architecture](02-architecture.md)
- Using it: [07 — Admin guide](07-admin-guide.md)
