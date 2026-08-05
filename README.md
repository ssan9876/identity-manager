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
`POST`/`PUT`/`PATCH`/`DELETE` route exists anywhere) and **authenticated-only**:
every controller requires a valid Keycloak-issued JWT, but there is
**no per-user authorization** yet. Any authenticated user can currently read
the entire directory — users, org units, and groups — regardless of role or
org-unit scope. The RBAC engine and audit log that enforce who may see or
change what land in Milestone 3, which is also the gate for any write
endpoint. Do not point this build at a real organization's data, and do not
expose it beyond a local development environment before Milestone 3 lands.
