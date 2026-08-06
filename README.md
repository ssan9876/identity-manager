# Identity Manager

A single-tenant identity provider for one real organization: the system of
record for users, org structure, groups, and lifecycle state. Postgres holds
all identity data; Keycloak owns credentials, MFA, sessions, and SSO
(OIDC/SAML) to downstream applications. The two never share write access to
each other's domain — identity data flows one way, from this system outward.
See `docs/superpowers/specs/2026-08-04-identity-provider-core-design.md` for
the full design.

## Prerequisites

- Node.js 20+
- pnpm 9+
- Docker (for Postgres and Keycloak via Docker Compose)

## Starting the dev stack

```bash
docker compose up -d
cp .env.example .env
pnpm install
pnpm --filter @idm/api db:migrate
pnpm --filter @idm/api start:dev
```

`docker compose up -d` starts Postgres (`5432`) and Keycloak (`8080`/`9000`).
The API reads its configuration from `.env` (see `.env.example`) and listens
on `PORT` (default `3000`). `db:migrate` does more than apply schema changes
here — see "Database roles" below before assuming it's a one-line no-op step.

## Database roles

Postgres access is split across **two roles**, not one — see
`docs/superpowers/audit-integrity.md` finding H1 for the full attack this
closes. `.env.example` documents both; the short version:

| | `DATABASE_URL` (OWNER) | `RUNTIME_DATABASE_URL` (RUNTIME) |
|---|---|---|
| Who connects as it | `db:migrate` only | the API process, the SyncWorker, `reconcile`, `jml:lifecycle`, `smoke:dev` |
| Owns the schema | yes | no |
| `CREATE` on schema `public` | yes | **no** |
| DML on ordinary tables | yes | full SELECT/INSERT/UPDATE/DELETE |
| DML on `audit_log` | yes | **SELECT/INSERT only** |

Why two roles: a database role that both serves runtime traffic and owns
its own schema can always defeat any DML trigger guarding a table it
owns — one `CREATE OR REPLACE FUNCTION audit_log_append_only() ... RETURN
NULL` silently disarms every trigger on it, and an `ALTER TABLE ... ALTER
COLUMN ... TYPE ... USING ...` rewrites every row without firing a DML
trigger at all. Splitting the roles turns "append-only" from a property
the owner merely *chooses* to respect into one the runtime role is
database-level **incapable** of violating: it cannot rewrite the guard
because it does not own the function, and it cannot `UPDATE`/`DELETE`/
`TRUNCATE` `audit_log` because those privileges were never granted to it.
That privilege boundary and the append-only triggers (`db/migrate.ts`) are
two *independent* mechanisms — defeating one alone is not enough.

**How a deployer sets this up:** provision one Postgres login that will own
the schema (superuser is fine for a dev/CI box; against a managed Postgres
it needs at least `CREATEROLE` plus ownership/`CREATE` on the target
database) and put its connection string in `DATABASE_URL`. Pick a **second**
username/password for the runtime role — it does not need to exist in
Postgres yet — and put that connection string in `RUNTIME_DATABASE_URL`.
Running `db:migrate` (`apps/api/src/db/roles.ts`) then creates that second
role if it doesn't exist (or re-asserts its password/attributes if it does)
and grants it exactly the table above, every time migrations run — so
rotating the runtime password is just editing `RUNTIME_DATABASE_URL` and
re-running `db:migrate`. The application (`app.module.ts`'s `DB_CLIENT`
provider) reads only `RUNTIME_DATABASE_URL` and has **no fallback** to
`DATABASE_URL` — a deployment that forgets to set the runtime connection
string fails to boot instead of silently running with owner privileges.

## Running tests

```bash
pnpm test                          # unit + integration tests across all packages
pnpm --filter @idm/api smoke:dev   # boots the real dev server and hits it over HTTP
pnpm --filter @idm/web test:e2e    # Playwright end-to-end tests
```

`pnpm test` runs each package's Postgres-backed tests against disposable
Testcontainers, independent of the Compose stack. `smoke:dev` and the
Playwright suite exercise the app the way a human would, against the running
Compose stack.

## SECURITY STATUS

**This build must not be deployed to a real network.**

Every route — read and write alike — requires both a valid Keycloak-issued
JWT **and** a role assignment that grants the specific action being
performed (e.g. `user:read`, `user:update`, `role:assign`) — an
unauthenticated request, or one from a principal whose roles don't grant the
action, is rejected before a single query runs.

Every route is also narrowed to the actor's org-unit **scope**, not just
gated by the permission itself. Role assignments can themselves be scoped
(e.g. `help_desk` limited to Sales): every list endpoint filters its results
(and its `total`) to the actor's scope, and every single-resource read *and
write* asserts the target is actually within that scope
(`PermissionEngine.assertCanIn`) before acting on it — an out-of-scope but
existing resource returns **403**, not 404 (the directory's existence is not
secret; its contents are). A global role assignment (`scopeOrgUnitId: null`)
still reaches everything, a group with `orgUnitId: null` is global — visible
to and writable by any actor holding the relevant action regardless of their
own scope — and an actor whose role grants an action at no reachable scope
sees an empty page, never the unfiltered list.

**Writes.** `POST`/`PATCH`/`DELETE` routes now exist for users (create,
update, deactivate — **never** delete; `deactivated` is terminal, there is no
route to remove a user), org units (create), groups (create, update,
membership, nesting), and role assignments (grant, revoke). Every mutation
runs inside one database transaction together with its audit row
(`audit_log`, append-only at the database level by two independent
mechanisms — see "Database roles" above: the runtime role's privileges
don't extend to `UPDATE`/`DELETE`/`TRUNCATE` on it at all, and triggers
reject those same statements for anyone who does hold them, e.g. the owner
role): a rejected or failed write commits nothing and leaves no audit trace,
and a successful one always leaves exactly one.

**Role assignment is the most security-sensitive write in the system** —
getting it wrong is privilege escalation, not merely disclosure — so
granting or revoking a role is gated by three independent checks, all
required, none subsuming another:
1. Does the actor hold `role:assign` **anywhere** at all (`PermissionGuard`
   — only `super_admin` does, in today's static role catalog)?
2. May the actor grant *this specific role* at *this specific scope*
   (`PrivilegeGuards.assertCanAssignRole`)? An actor may only grant a role
   they themselves hold, at a scope their own holding covers — a SCOPED
   holding can never produce a GLOBAL grant, the exact path that would turn
   a departmental account into a domain-wide one.
3. Does the target principal **outrank** the actor
   (`PrivilegeGuards.assertCanModifyPrincipal`)? Independent of scope
   entirely — a `help_desk` scoped to Sales must not be able to touch a
   GLOBAL `super_admin` who happens to sit in Sales.

Milestone 3a's and 3b's reviews established that rank and scope are
independent and neither check subsumes the other — shipping only some of
these three is the bug. Revoking a role requires the same three checks as
granting it, evaluated against the grant being removed, so revocation cannot
be used as a side door around assignment's own narrowing.

Do not point this build at a real organization's data, and do not expose it
beyond a local development environment: there is still **no CI**, so every
compile-time guarantee depends on someone remembering to run `build`, and the
comprehensive adversarial security audit planned for the end of this
sub-project has not run yet.
