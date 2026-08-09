# Identity Manager

A self-hosted identity provider, run by one operator for one or more real
organisations: the system of record for people, org structure, groups, entitlements and
lifecycle state. Each organisation gets its own Keycloak realm; every administrator is a
platform operator authenticating against the master realm.

Postgres holds all identity data. Keycloak owns credentials, MFA, sessions and SSO.
Connectors push mastered identity outward into Active Directory, Entra ID, Google
Workspace and a mail server. A React admin console is the surface an IT administrator
works in.

Identity flows one way — **outward**. Nothing downstream writes back.

## Quickstart

Requires Node 20+, pnpm 9+, and Docker.

```bash
pnpm setup:all         # Postgres + Keycloak in Docker, deps, migrations
pnpm bootstrap:admin   # grant yourself access — without this, everything is 403
pnpm dev               # API on :3000, console on :5173
```

Then open **http://localhost:5173** and sign in as `admin@example.com` /
`dev_password_change_me`.

Full walkthrough: **[docs/04-quickstart.md](docs/04-quickstart.md)**.

## Documentation

**All documentation lives in [`docs/`](docs/). Start at
[docs/README.md](docs/README.md).**

| | |
|---|---|
| [01 — Overview](docs/01-overview.md) | What it is and what it does |
| [02 — Architecture](docs/02-architecture.md) | Processes, request path, outbox, trust boundaries |
| [03 — Data model](docs/03-data-model.md) | Every table and why it is shaped that way |
| [04 — Quickstart](docs/04-quickstart.md) | Local development in three commands |
| [05 — Installation](docs/05-installation.md) | Production install, Keycloak setup, TLS |
| [06 — Configuration](docs/06-configuration.md) | Every environment variable and setting |
| [07 — Admin guide](docs/07-admin-guide.md) | Using the console, with walkthroughs |
| [08 — Authorization](docs/08-authorization.md) | Roles, actions, scope, privilege guards |
| [09 — Connectors and sync](docs/09-connectors-and-sync.md) | AD, Entra, Google, mail, reconciliation |
| [10 — API reference](docs/10-api-reference.md) | Every endpoint |
| [11 — Operations](docs/11-operations.md) | CLIs, scheduling, monitoring, backups, playbooks |
| [12 — Security model](docs/12-security.md) | What holds, what is enforced, what is not yet safe |
| [13 — Development](docs/13-development.md) | Repo layout, tests, conventions |
| [14 — Roadmap](docs/14-roadmap.md) | What exists, what is half-built, what is not built |

Design references: [product brief](docs/product-brief.md) ·
[design system](docs/design-system.md). Historical specs, plans and audit findings are in
[`docs/archive/`](docs/archive/) and are not authoritative.

## Common commands

```bash
pnpm verify:quick                  # typecheck + build — run before every commit
pnpm verify                        # the full gate, incl. the API suite
pnpm test                          # unit + integration tests
pnpm --filter @idm/web test:e2e    # Playwright end-to-end tests

pnpm --filter @idm/api db:migrate                    # schema + runtime role grants
pnpm --filter @idm/api jml:lifecycle                 # daily joiner/leaver transitions
pnpm --filter @idm/api reconcile                     # Keycloak drift
pnpm --filter @idm/api target-reconcile <target>     # one connector — dry run by default
```

## Security status

**This build must not be exposed to untrusted users.** The adversarial security audit is
incomplete: four dimensions ran and their findings were fixed, but two never ran and
roughly twenty findings remain unverified. Installing on an internal or lab network is
reasonable.

Read [docs/12-security.md](docs/12-security.md) before pointing this at a network you
care about.
