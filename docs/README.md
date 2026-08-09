# Identity Manager — documentation

Everything about this system lives in this directory. Read in order for a
first pass; jump straight to a chapter once you know the shape.

| # | Document | Read it when |
|---|---|---|
| 01 | [Overview](01-overview.md) | You want to know what this is and whether it fits your problem. |
| 02 | [Architecture](02-architecture.md) | You need to know how the pieces fit — processes, data flow, trust boundaries. |
| 03 | [Data model](03-data-model.md) | You are reasoning about the database, or writing a query against it. |
| 04 | [Quickstart (local development)](04-quickstart.md) | You want it running on your machine in three commands. |
| 05 | [Installation (production)](05-installation.md) | You are installing on a real host against a real Keycloak. |
| 06 | [Configuration](06-configuration.md) | You need to know what every environment variable and setting does. |
| 07 | [Admin guide](07-admin-guide.md) | You are using the console to do the job — with full walkthroughs. |
| 08 | [Authorization model](08-authorization.md) | You are deciding who gets what, or debugging a 403. |
| 09 | [Connectors and sync](09-connectors-and-sync.md) | You are wiring up AD, Entra, Google Workspace, or the mail server. |
| 10 | [API reference](10-api-reference.md) | You are calling the HTTP API directly. |
| 11 | [Operations](11-operations.md) | It is running and something needs doing — upgrades, CLIs, backups, incidents. |
| 12 | [Security model](12-security.md) | You are assessing it, or you need to know what is not yet safe. |
| 13 | [Development](13-development.md) | You are changing the code. |
| 14 | [Roadmap and current state](14-roadmap.md) | You want to know what exists, what is half-built, and what is not built. |

## Design references

These two are contracts the code holds itself to, not narrative documentation.
Source comments across the repository cite them by name.

- [Product brief](product-brief.md) — who this is for, the scene it is used in, and what
  it must do well. Decides the interface's priorities.
- [Design system](design-system.md) — the visual system: colour tokens in both themes,
  type scale, layout, component states, motion, and the explicit bans.

## Archive

[`archive/`](archive/) holds the historical record — the original design specs, the
milestone-by-milestone build plans, and the security audit findings. It is **not**
authoritative and is not maintained. The chapters above supersede it. It is kept
because the source comments cite specific findings by identifier (`finding H1`,
`finding M-2`, …) and because the design specs record *why* several decisions came
out the way they did in more depth than a reference chapter should carry.

## The two-minute version

An identity provider run by one operator for one or more organisations, each with its
own Keycloak realm. Postgres is the system of record for people, org structure, groups and lifecycle state. Keycloak owns
credentials, MFA, sessions and SSO. Connectors push mastered identity outward into
Active Directory, Entra ID, Google Workspace and a mail server. A React admin console
is the surface an IT administrator actually works in.

Identity data flows one way: **out of this system**. Nothing downstream writes back.

```
pnpm setup:all         # Postgres + Keycloak in Docker, deps, migrations
pnpm bootstrap:admin   # grant yourself access — without this everything is 403
pnpm dev               # API on :3000, console on :5173
```
