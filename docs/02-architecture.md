# 02 — Architecture

## The shape of it

```
                        ┌──────────────────────────────┐
   browser ─── OIDC ───▶│          Keycloak            │
      │                 │  credentials, MFA, sessions, │
      │                 │  SSO to downstream apps      │
      │                 └──────────────────────────────┘
      │                          ▲            ▲
      │ Bearer JWT               │ JWKS       │ Admin REST
      │                          │ (verify)   │ (client credentials)
      ▼                          │            │
┌─────────────────┐      ┌───────┴────────────┴─────────┐
│  Web console    │─────▶│         API (NestJS)         │
│  React + Vite   │ HTTP │  controllers → repositories  │
└─────────────────┘      └──────────────┬───────────────┘
                                        │
                          ┌─────────────┴───────────────┐
                          │        PostgreSQL 16        │
                          │  people · org units ·       │
                          │  groups · roles · audit ·   │
                          │  outbox                     │
                          └─────────────┬───────────────┘
                                        │ claim + drain
                          ┌─────────────┴───────────────┐
                          │        Sync worker          │
                          │  (same process by default)  │
                          └─────────────┬───────────────┘
                                        │
        ┌──────────────┬────────────────┼──────────────┬──────────────┐
        ▼              ▼                ▼              ▼              ▼
    Keycloak    Active Directory    Entra ID    Google Workspace  Mail server
```

Identity flows one way — **outward**. No target ever writes back into Postgres.

## Processes

There is **one Node process** in a default deployment: `idm-api.service`. It runs both
the HTTP API and the outbox sync worker.

The worker is started from `main.ts` only — never from a Nest lifecycle hook. That is
deliberate: every test that compiles `AppModule` constructs an inert worker that never
polls. `SYNC_WORKER_ENABLED=false` turns the loop off for a second API instance behind
a load balancer, so exactly one process drains the outbox.

nginx serves the built web bundle and proxies `/api` to the API on the same origin.
The API's `enableCors` is hardcoded to `http://localhost:5173` (the Vite dev server),
so a split-origin production deployment would be refused by the browser — same-origin
via nginx is the supported shape, and the installer firewalls the API's own port so it
cannot be reached directly.

## Request path

1. **`JwtGuard`** verifies the bearer token against Keycloak's JWKS: signature,
   `iss`, `aud`, expiry, and the presence of `sub` and `preferred_username`. An
   `alg: none` token, a wrong issuer, or a wrong audience is rejected here.
2. **`PermissionGuard`** reads the `@RequirePermission(...)` decorator on the handler,
   resolves the JWT principal to a **local `users` row by username**, and asserts the
   actor holds that action *somewhere*. A principal with no local user row, or a
   non-`active` one, is denied. The resolved `Actor` is attached to the request.
3. **The handler narrows to scope.** Holding an action anywhere is not enough:
   - list endpoints filter both `items` and `total` to the actor's scope paths;
   - single-resource reads *and writes* call `PermissionEngine.assertCanIn(actor,
     action, orgUnitId)`, which returns **403 for an out-of-scope resource that
     exists** — not 404. The directory's existence is not secret; its contents are.
   - routes governing global infrastructure (audit log, dead letters, connector
     targets, attribute mappings, root org units, global groups) additionally require
     a **global** grant, because there is no containing org unit to narrow to.
4. **Zod** parses the body and query with `.strict()` object schemas. An unknown key is
   a 400 naming that key, never a silent drop.
5. **One transaction** wraps the mutation, its `audit_log` row, and its
   `outbox_events` row.
6. **`DomainExceptionFilter`** maps domain errors to status codes. Anything that is
   not a `DomainError` is a genuine bug and surfaces as a 500.

| Error code | HTTP status |
|---|---|
| `VALIDATION_FAILED` | 400 |
| `FORBIDDEN` | 403 |
| `NOT_FOUND` | 404 |
| `CONFLICT` | 409 |
| `INVALID_TRANSITION` | 409 |
| `CYCLE_DETECTED` | 409 |

Every error body is `{ statusCode, code, message, issues? }`.

## The outbox

Every mutation writes an `outbox_events` row inside the same transaction as the
mutation itself. Either both land or neither does.

An event carries `(aggregateType, aggregateId, eventType, payload, target, status,
attempts, nextAttemptAt, lastError)`.

- **Aggregates**: `user`, `group`, `membership`, `org_unit`, `sso_app`. `membership`
  is its own aggregate because a membership row is a pure edge with no id of its own —
  it is anchored on the parent group but is not the same stream as that group's own
  name/description/attributes. `sso_app` is the one aggregate that describes something
  other than a principal or a grouping of principals: a registered OIDC application.
- **There is no `deleted` event type.** Nothing in this system is deleted. Removal
  propagates as `status_changed` carrying `deactivated`.
- **Fan-out happens at write time, and is aggregate-aware.** `OutboxWriter.record`
  reads `connector_targets WHERE enabled = true`, then filters that list through
  `targetsForAggregate` (`outbox/target-fanout.ts`) before writing a row per surviving
  target. An `sso_app` event reaches `keycloak_sso` and nothing else; every other
  aggregate reaches every enabled target *except* `keycloak_sso`. Without that filter
  an application would be handed to Active Directory, Entra and Google — none of which
  know what an application is — and every one of those rows would fail, retry and
  dead-letter. The split is asserted against both pgEnums in
  `test/target-fanout.spec.ts`, so a future aggregate added and left unclassified
  fails the suite rather than defaulting to the directory branch.
- **Ordering is per `(aggregate, target)`**, not per aggregate. A stalled Active
  Directory delivery for a user must not head-of-line block that same user's later
  Keycloak events.
- **The payload is diagnostic context only.** The worker never replays it as a delta;
  it re-reads the current row and asserts full desired state. Replayed or out-of-order
  events therefore converge.

### The worker loop

`claimNext` selects the oldest claimable event with `FOR UPDATE SKIP LOCKED`, subject
to "no older pending or processing event exists for this same (aggregate, target)".

| Setting | Default |
|---|---|
| Max attempts before dead-letter | 8 |
| Backoff base | 2s |
| Backoff ceiling | 10 min |
| Idle poll interval | 5s |

A dead-lettered event (`status = 'failed'`) appears at `GET /outbox/dead-letters` and
in the console's **Audit → Dead letters** tab.

Per-user reconciliation takes a Postgres advisory lock in a namespace disjoint from
the group-graph lock, so two workers cannot interleave on the same user.

### Sync state, as users see it

`GET /users` and `GET /users/:id` return a derived `syncState` of `pending`, `synced`
or `failed`. It is **not** a passthrough of `external_identities.sync_state`.

That column only regresses to `failed` for a direct `user`-aggregate dead-letter. A
`group` or `membership` fan-out that dead-letters partway through never touches any one
user's row — so `SyncStateRepository` combines the per-system fact with any pending or
failed outbox events affecting the user, including a *removal*, whose affected user is
recoverable only from the payload recorded before the edge was deleted. A user who
looks healthy while their group sync dead-lettered is the worst outcome this product
can produce; this is the machinery that prevents it.

## Reconciliation

Two on-demand jobs exist because a queue alone cannot detect drift someone caused
directly inside a target.

- **`reconcile`** walks users, compares against Keycloak, reports drift, and enqueues
  corrective events.
- **`target-reconcile <target>`** walks the whole directory for one connector target,
  builds a plan, and applies it. **Dry run is the default**; `--apply` is explicit.

Both are guarded by a **blast-radius** rail. A run halts if it would mutate more than
`blastRadiusThreshold` percent of the target's population **and** more than
`blastRadiusFloor` principals in absolute terms. Both conditions must hold — so a small
real batch proceeds at a scary-looking percentage, while a large one still halts at a
modest one. Overriding requires `--force` (or `force: true` over HTTP) and is
separately audited.

## Trust boundaries

| Boundary | What crosses | How it is controlled |
|---|---|---|
| Browser → API | Bearer JWT | Verified against Keycloak JWKS; issuer and audience matched |
| API → Postgres | SQL as the **runtime** role | Owns nothing; no `CREATE`; `SELECT`/`INSERT` only on `audit_log` |
| Migrations → Postgres | DDL as the **owner** role | Only `db:migrate` ever connects as this |
| API → Keycloak Admin | Client-credentials grant | Service account holds exactly four `realm-management` roles |
| Worker → targets | Credentials resolved at point of use | Only `CONNECTOR_*` variables are resolvable; never stored, logged, or returned |

### The two database roles

The single most load-bearing structural decision in the deployment.

| | `DATABASE_URL` (owner) | `RUNTIME_DATABASE_URL` (runtime) |
|---|---|---|
| Who connects as it | `db:migrate` only | API, sync worker, `reconcile`, `jml:lifecycle`, `bootstrap:admin` |
| Owns the schema | yes | no |
| `CREATE` on schema `public` | yes | **no** |
| DML on ordinary tables | yes | full `SELECT`/`INSERT`/`UPDATE`/`DELETE` |
| DML on `audit_log` | yes | **`SELECT`/`INSERT` only** |

A role that both serves runtime traffic and owns its own schema can always defeat a
trigger guarding a table it owns — one `CREATE OR REPLACE FUNCTION ... RETURN NULL`
disarms every trigger on it, and an `ALTER TABLE ... ALTER COLUMN ... TYPE ... USING`
rewrites every row without firing a DML trigger at all. Splitting the roles turns
"append-only" from a property the owner *chooses* to respect into one the runtime role
is structurally **incapable** of violating.

`db:migrate` creates the runtime role from `RUNTIME_DATABASE_URL`'s own
username/password (or re-asserts its password and attributes if it exists) and
re-grants exactly the table above on **every** run — so rotating the runtime password
is editing that URL and re-running the migration, and a migration that adds a table
also grants the runtime role access to it.

The application reads only `RUNTIME_DATABASE_URL` and has **no fallback** to
`DATABASE_URL`: a deployment that forgets it fails to boot rather than silently running
with owner privileges.

### The connector secret rule

`connector_targets.config` is admin-editable and names *both* the environment variable
to read *and* the destination host. Without a constraint, a holder of
`connector:manage` could point a target at a host they control, name `DATABASE_URL` as
its credential, and receive the database password in an `Authorization` header.

So a connector may only resolve variables matching `^CONNECTOR_[A-Za-z0-9_]+$`:

- `resolveSecret` is the only function in the codebase permitted to read a connector
  credential from the environment.
- The pattern is checked **before** the lookup, so a prototype-chain key such as
  `hasOwnProperty` is never even indexed.
- An empty string is treated as unset — `FOO=` is almost always an accident.
- A test seeds a sentinel value into the environment and greps every response, log
  line and thrown error for it.

Config storing a secret *name* rather than a *value* is why the console renders that
field as a plain text input and never a masked one: a password-style box would be a
lie about the architecture.

## Repository layout

```
apps/api/src/
  admin/         bootstrap-admin — the anti-lockout operator script
  attributes/    custom attribute definitions, per-target mappings, validator
  audit/         append-only writer, repository, read API
  auth/          JwtGuard, GET /me
  authz/         action catalog, PermissionEngine, privilege guards, role assignments
  common/        errors, exception filter, pagination, HTTP parsing helpers
  config/        env schema (Zod) — the only place process.env is read
  connectors/    the connector spine, one file per target, secret resolution
  db/            schema (one file per table), migrations, role provisioning
  groups/        groups, membership, nesting
  health/        GET /health
  imports/       CSV parse, row shape, preview/commit
  jml/           joiner/mover/leaver rules, engine, applier, lifecycle job
  keycloak/      Admin REST client, session revocation
  org-units/     the ltree tree
  outbox/        writer, repository, sync worker, reconciliation jobs
  self-service/  /self — no id anywhere, by construction
  users/         users controller + repository

apps/web/src/
  api/           shared fetch plumbing and ApiError
  attributes/    dynamic attribute field rendering
  audit/         audit log + dead letters
  auth/          OIDC config, AuthRoot, Account Console deep link
  connectors/    target list, configuration, dry run, attribute mapping editor
  forms/         Field, Combobox, API error → field error mapping
  groups/ imports/ org-units/ people/ roles/ self-service/
  shell/         AppShell, nav, toasts, theme, confirm dialog, permission gating
```

## Design decisions worth knowing

- **The permission catalog is static code, not database rows.** A permission table is
  itself a privilege-escalation surface; these grants change only through code review.
- **Lookup tables indexed by database-sourced values use `Object.create(null)`.** A
  Postgres enum can gain a label via `ALTER TYPE ... ADD VALUE`, and a plain `{}`
  resolves `constructor` / `__proto__` / `toString` to inherited, truthy values that
  defeat a `?? fallback`. This bit the project four times; a null-prototype catalog
  plus `Object.hasOwn` removes the hazard at its source.
- **The connector target catalog has exactly one source of truth.**
  `ALL_CONNECTOR_TARGETS` is the array; the union derives from it. A hand-copied
  literal list once left five consumers stale, which made a live outbound integration
  impossible to disable through the API.
- **Whole-request rejections happen before any row is touched.** Missing CSV columns,
  oversized row counts and malformed bodies fail up front — never a truncated partial
  apply.
- **Audit snapshots name their fields explicitly.** Never `{ ...user }` — a spread
  would silently carry a future sensitive column into an append-only log a leak can
  never be removed from.
