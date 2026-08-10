# 04 — Quickstart (local development)

This gets you from a clean clone to a browser session you can sign in to and use. It
runs Vite's dev server and a throwaway Keycloak in Docker. For a real install, see
[05 — Installation](05-installation.md).

## Prerequisites

- **Node.js 20+**
- **pnpm 9+**
- **Docker** (for Postgres and Keycloak via Docker Compose)

`pnpm setup:all` checks all three itself and tells you exactly which one is missing,
rather than failing partway through.

## Three commands

```bash
pnpm setup:all         # start Postgres + Keycloak, install deps, migrate the database
pnpm bootstrap:admin   # create your local admin account — safe to re-run
pnpm dev               # start the API and the web console together
```

Then open **http://localhost:5173** and sign in with:

- **username:** `admin@example.com`
- **password:** `dev_password_change_me`

You should land on a People list showing at least the admin user you just bootstrapped.

> **Why `setup:all` and not `setup`?** `pnpm setup` is a genuine, unrelated pnpm
> built-in that writes `PNPM_HOME`/`PATH` changes to *your shell profile*. A bare
> `pnpm setup` silently runs pnpm's own command instead of this project's script. No
> pnpm built-in command name contains a colon, which is why `setup:all` and
> `bootstrap:admin` work as written above with no `run` needed.
>
> **`db:migrate` is not a root script.** It lives in `apps/api/package.json` only, so at
> the repo root it is `pnpm --filter @idm/api db:migrate`. The root `package.json`
> defines exactly nine scripts: `setup:all`, `bootstrap:admin`, `dev`, `build`,
> `typecheck`, `test`, `check:docs`, `verify` and `verify:quick`. Everything else in
> this document is reached through `--filter`.

## What each command does

### 1. `pnpm setup:all`

- **Preflight checks.** Docker daemon reachable; ports `5432`, `8080`, `9000`, `3000`,
  `5173` free; Node ≥ 20; pnpm ≥ 9. Each failure is a specific, actionable message —
  never a stack trace. If a port is taken by something other than this project's own
  Compose stack, it names the container or process holding it.
- **Starts the Compose stack** (`docker compose up -d`) and waits for Postgres to
  report healthy **and** for Keycloak's realm-discovery endpoint to answer. Keycloak
  takes 20–40 seconds on a first start; this step exists so nothing races ahead of it.
- **Seeds env files** if they do not already exist — `.env.example` → `.env` (the
  API's config, at the repo root) and `apps/web/.env.example` → `apps/web/.env` (the
  console's Vite config; Vite only ever reads `.env` from its own project directory,
  never the repo root). It never overwrites an existing `.env`.
- **Runs `pnpm install`.**
- **Runs `pnpm --filter @idm/api run db:migrate`**, which applies the schema **and**
  provisions the runtime database role. That is not a no-op step — see
  [02 — Architecture](02-architecture.md#the-two-database-roles).

It ends by printing exactly what to run next.

### 2. `pnpm bootstrap:admin`

**Without this, signing in gets you 403 on everything.**

Authorization requires a local `users` row whose `username` matches your Keycloak
`preferred_username`, plus a role grant. A fresh install has neither, and there is no
path through the UI to fix it, because the UI needs exactly the permission you do not
have yet.

This command creates (or reuses) a local user for a given Keycloak username, activates
it, creates a root org unit if the directory is empty, and grants it global
`super_admin`.

```bash
pnpm bootstrap:admin                    # defaults to admin@example.com, the seeded dev user
pnpm bootstrap:admin someone@else.com   # or bootstrap any other Keycloak username
```

**It is idempotent.** Run it as often as you like — it reports what it did or what
already existed, and a repeat run never fails or duplicates anything.

It is a local operator script, like `db:migrate`, not an HTTP endpoint. It talks to
the database directly — as the **runtime** role, not the owner — and grants a privilege
no request is ever allowed to grant itself. See
[12 — Security model](12-security.md#why-bootstrapadmin-is-not-a-backdoor).

### 3. `pnpm dev`

Starts the API and the console together with clearly labelled, interleaved output —
`[api] ...` / `[web] ...`. Ctrl-C stops both.

| Service | URL |
|---|---|
| Web console | http://localhost:5173 |
| API | http://localhost:3000 |
| Keycloak | http://localhost:8080 (admin: `admin` / `admin_dev_password`) |
| Postgres | `localhost:5432`, database `identity_manager` |

## The development Keycloak realm

`keycloak/realm-import/identity-manager-realm.dev.json` is imported automatically by the
Compose stack. It contains a realm named `identity-manager` with:

| Client | Type | Purpose |
|---|---|---|
| `idm-api` | confidential | The **audience**. Nobody logs into it; it exists so access tokens carry an `aud` the API matches against `KEYCLOAK_AUDIENCE`. |
| `idm-console` | public | Browser SSO for the web UI. |
| `idm-sync-service` | confidential, service account | What the sync worker authenticates as to write into Keycloak. |
| `idm-test-client` | public, password grant — **imported disabled** | Direct grant for `smoke:dev` and the API test suite. Switched on at runtime, not by the import. |

…plus one seeded human user, `admin@example.com` / `dev_password_change_me`.

> **Never import this file into a real Keycloak.** It contains a working account whose
> password is committed to a public repository, plus a client secret of
> `idm_sync_dev_secret_change_me` and a password-grant test client. Use
> `scripts/keycloak-setup.sh` instead, which builds the realm through the Admin API with
> generated secrets, no seeded human user, and no `idm-test-client` at all. It creates
> `idm-api`, `idm-console`, `idm-sync-service` and `idm-sso-admin` — plus
> `idm-provisioner` in the master realm, but only under `SETUP_PROVISIONER=1`.

The `.dev.json` suffix, the realm's `sslRequired: "external"`, and `idm-test-client`
shipping `"enabled": false` are all deliberate — finding SEC-L5. `pnpm smoke:dev` and the
Testcontainers harness each enable the test client for themselves through
`setDevTestClientEnabled` (`apps/api/scripts/dev-test-client.ts`), using a bootstrap
admin. They then diverge, deliberately: `smoke:dev` runs against the long-lived Compose
stack, so it records the flag's previous value and restores it in a `finally` — a run that
found the client disabled leaves it disabled, and a failure to restore prints a loud
warning rather than being swallowed. The Testcontainers harness does **not** restore it,
because its Keycloak is a disposable container destroyed at the end of the suite. Either
way nothing you run leaves a password grant live in a Keycloak that outlives it. Nothing
else in the dev flow touches the client, and `keycloak/realm-import/README.md` explains
why it could not simply be deleted.

## Verifying it works

```bash
pnpm verify:quick                  # every gate except the API suite — no containers
pnpm verify                        # the same gates plus the API suite (needs Docker)
pnpm check:docs                    # the documentation guard on its own
pnpm test                          # pnpm -r test — the API suite plus the web checks
pnpm --filter @idm/api smoke:dev   # boots the real dev server and hits it over HTTP
pnpm --filter @idm/web test:e2e    # Playwright end-to-end tests
```

`scripts/verify.mjs` runs its stages in this order, stopping at the first failure:

| Stage | What it runs | In `verify:quick`? |
|---|---|---|
| typecheck | `pnpm -r run typecheck` | yes |
| lint | only if an ESLint config exists — this repo has none, so it logs and skips | yes (skipped) |
| build | `pnpm -r build` | yes |
| web checks | `pnpm --filter @idm/web test` | yes |
| docs checks | `pnpm run check:docs` | yes |
| API suite | `pnpm --filter @idm/api test` | **no** |

So `verify:quick` skips **exactly one** stage — the API suite, the only one that needs
Docker. (`verify.mjs`'s own startup line still calls that "typecheck + build only",
which predates the web-checks and docs-checks stages.)

The two package `test` scripts are not the same kind of thing. `@idm/api`'s is
`vitest run`: Postgres-backed, one disposable Testcontainers database per spec file,
independent of the Compose stack, and slow. `@idm/web`'s is three static checks with no
browser and no database — the CSS design-token check, the connector-target catalogue
drift check, and the CSP hash check. `smoke:dev` and the Playwright suite are the ones
that exercise the app the way a human would, against the running Compose stack.

## Common first-run problems

| Symptom | Cause and fix |
|---|---|
| Everything returns **403** after signing in | `bootstrap:admin` was never run. This is expected, not a bug. |
| `setup:all` fails on a port | Something else holds `5432`/`8080`/`9000`/`3000`/`5173`. The message names the container or process. |
| Login redirects, then every call is **401** | The token's audience does not match `KEYCLOAK_AUDIENCE`. On the dev realm this should not happen; if you edited the realm, check the `idm-console` audience mapper. |
| Keycloak refuses connections right after `setup:all` | It should not — `setup:all` waits for realm discovery. If you started Compose by hand, wait 20–40s. |
| API will not boot: "Invalid environment configuration" | A required variable is missing from `.env`. `RUNTIME_DATABASE_URL` has no fallback, deliberately. |
| Changed `.env`, the console still uses the old value | Vite inlines `VITE_*` at build time and reads them from `apps/web/.env`, not the repo root. Restart `pnpm dev`. |

## Resetting

```bash
docker compose down -v     # drops the Postgres volume and the Keycloak state
pnpm setup:all
pnpm bootstrap:admin
```

`setup:all` re-runs the migration for you, which matters after every fresh volume: it
applies the schema *and* provisions the runtime role, which the Compose file deliberately
does not create. If you brought the stack up by hand instead, run
`pnpm --filter @idm/api db:migrate` yourself.
