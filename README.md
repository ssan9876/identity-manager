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
on `PORT` (default `3000`).

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

The entire HTTP surface shipped so far is **read-only** (`GET` only — no
`POST`/`PUT`/`PATCH`/`DELETE` route exists anywhere). Every route now requires
both a valid Keycloak-issued JWT **and** a role assignment that grants the
specific action being performed (e.g. `user:read`) — an unauthenticated
request, or one from a principal whose roles don't grant the action, is
rejected.

What this does **not** yet do: enforce a role's org-unit *scope* per resource.
Role assignments can be scoped (e.g. `help_desk` limited to Sales), but no
controller narrows results by that scope today — any actor holding a
qualifying read permission, at any scope, can read the entire directory (all
users, org units, and groups), not just their own subtree. Closing that gap,
and enforcing it on every write endpoint before one ships, is Milestone 3b's
first task. Do not point this build at a real organization's data, and do not
expose it beyond a local development environment before Milestone 3b lands.
