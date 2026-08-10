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

The bottom row is abbreviated. There are **thirteen** connector targets, not five: the six
`scim_*` values share one adapter, `keycloak_sso` is a different interface family
(`SsoConnector`) that carries applications rather than principals, and `echo` is an
in-repo target that exercises the spine without a vendor. See
[09 — Connectors and sync](09-connectors-and-sync.md).

## Processes

There is **one long-running Node process** in a default deployment: `idm-api.service`. It
runs both the HTTP API and the outbox sync worker. Three systemd timers additionally start
short-lived `Type=oneshot` processes and let them exit — `idm-backup` (01:00),
`idm-lifecycle` (02:00) and `idm-reconcile` (03:00); `scripts/install.sh` renders all
seven units from `deploy/systemd/` and enables every timer it finds. See
[11 — Operations](11-operations.md).

The worker is started from `main.ts` only — never from a Nest lifecycle hook. That is
deliberate: every test that compiles `AppModule` constructs an inert worker that never
polls. `SYNC_WORKER_ENABLED=false` turns the loop off for a second API instance behind
a load balancer, so exactly one process drains the outbox.

nginx serves the built web bundle and proxies `/api` to the API on the same origin.
The API's `enableCors` is hardcoded to `http://localhost:5173` (the Vite dev server),
so a split-origin production deployment would be refused by the browser — same-origin
via nginx is the supported shape, and the installer firewalls the API's own port so it
cannot be reached directly (`ufw deny <IDM_PORT>/tcp`, skipped when `ufw` is absent or
`SKIP_UFW=1` is set — `install.sh` warns loudly in that case).

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
   - routes governing resources with no containing org unit — the audit log, dead
     letters, connector-target writes, attribute mappings, HR-source writes, every
     `/sso-apps` route including the reads, every `/organizations` route including the
     read, `business_role:manage` routes, recertification-campaign writes, and writes to
     a group whose `orgUnitId` is `NULL` — additionally require a **global** grant,
     because there is nothing to narrow *to*. The authoritative row-by-row list is the
     global-grant table in [08 — Authorization model](08-authorization.md). Note
     `POST /org-units` is **not** on it: `parentId` is required, so every org unit this
     route creates has a parent to narrow to, and the old root-org-unit branch is gone.
4. **Zod** parses the body and query with `.strict()` object schemas. An unknown key is
   a 400 naming that key, never a silent drop.
5. **One transaction** wraps the mutation, its `audit_log` row, and — for the aggregates
   the worker synchronises — its `outbox_events` row.
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
| `NOT_CONFIGURED` | 503 |
| `DATA_INTEGRITY_FAULT` | 500 |

`NOT_CONFIGURED` is the one refusal that is **not** the caller's fault: the request is
well-formed and the actor entitled, but the deployment is not equipped to serve it.
`POST /organizations` raises it when `KEYCLOAK_PROVISION_CLIENT_ID` /
`KEYCLOAK_PROVISION_CLIENT_SECRET` are unset, rather than accepting a row whose realm
could never be created. `DATA_INTEGRITY_FAULT` is also not the caller's fault and is
mapped **explicitly** rather than left to the 500 fallback, so the response still carries
a `code` and a message an operator can act on.

Every error body is `{ statusCode, code, message, issues? }`.

## The outbox

Every mutation to an aggregate the worker synchronises writes an `outbox_events` row
inside the same transaction as the mutation itself. Either both land or neither does.
Configuration writes — `connector-targets`, `attribute-definitions`,
`attribute-target-mappings`, `hr-sources` — are audited but emit no outbox row of their
own: none of those controllers holds an `OutboxWriter` at all. (Approving an access
request or deciding a recertification item *does* produce outbox rows, but indirectly:
`RoleReconciler` writes them for the affected **user**.)

An event carries `(aggregateType, aggregateId, eventType, payload, target, status,
attempts, nextAttemptAt, lastError)`.

- **Aggregates**: `user`, `group`, `membership`, `org_unit`, `sso_app`, `organization`.
  `membership`
  is its own aggregate because a membership row is a pure edge with no id of its own —
  it is anchored on the parent group but is not the same stream as that group's own
  name/description/attributes. Two of the six describe something other than a principal
  or a grouping of principals: `sso_app` is a registered application — OIDC **or** SAML,
  `sso_app_protocol` is `('openid-connect', 'saml')` — and `organization` is a Keycloak
  realm.
- **There is no `deleted` event type.** No *principal* is ever deleted: a user terminates
  at `deactivated`, and neither a group nor an org unit has a `DELETE` route that removes
  the thing itself — `org-units.controller.ts` has no `@Delete` at all, and
  `groups.controller.ts` has two that delete no group. Removal of a person propagates as
  `status_changed` carrying `deactivated`. **Edges** are the exception, and there are two
  of them: `DELETE /groups/:id/members/:userId` and
  `DELETE /groups/:id/child-groups/:childId` both really do hard-delete their row, and each
  propagates as `membership_changed`, not as a deletion event.
- **Fan-out happens at write time, and is aggregate-aware.** `OutboxWriter.record`
  reads the enabled `connector_targets` rows for the aggregate's own organization (see
  the next bullet — that scoping happens first), then filters that list through
  `targetsForAggregate` (`outbox/target-fanout.ts`) before writing a row per surviving
  target. `targetsForAggregate` has three branches, not two: an `sso_app` event reaches
  `keycloak_sso` and nothing else; an `organization` event reaches `keycloak` and nothing
  else, because a realm is a Keycloak concept no other target has; every remaining
  aggregate reaches every enabled target *except* `keycloak_sso`. Without that filter
  an application would be handed to Active Directory, Entra and Google — none of which
  know what an application is — and every one of those rows would fail, retry and
  dead-letter. The split is asserted against both pgEnums in
  `test/target-fanout.spec.ts`, so a future aggregate added and left unclassified
  fails the suite rather than defaulting to the directory branch.
- **Fan-out is also organization-aware, and this is read first.** Before either filter,
  `OutboxWriter.record` calls `resolveAggregateOrganizationId` (`aggregate-organization.ts`)
  and then reads `connector_targets WHERE enabled = true AND organization_id = <that>`.
  The organization is **derived** — from the aggregate's own row for `user`, `group`,
  `membership` and `org_unit`, and from **master** for `sso_app` and `organization`, both
  of which are platform-level — never from a caller-supplied argument, so cross-tenant
  fan-out is not one mistyped parameter away at any call site. An unknown organization
  (`null`) fans out to **nothing**.

  `connector_targets` is keyed by `(organization_id, target)`, so **each organization owns
  its own catalog** and an organization with no row for a target simply never reaches it —
  absence never falls back to another organization's row. This *replaced* the older
  hard-coded rule that narrowed every non-master tenant to `keycloak` alone; that rule
  existed only while the table was keyed by target. The old behaviour is now the default
  rather than a special case, because `POST /organizations` seeds a freshly provisioned
  tenant with exactly one row: `keycloak`, enabled.
- **Fan-out is finally entitlement-aware, but only where opted in.** Each
  `connector_targets` row carries a `provisioning_mode`. `all_users` is the default and
  every pre-business-roles row was backfilled to it: such a target receives every
  aggregate, exactly as before the feature existed. `entitled_only` is the opt-in — a
  `user` aggregate reaches such a target only if that user holds a `user_target_accounts`
  row for it. Only `user` aggregates have an entitlement to consult; groups, memberships,
  org units and applications reach an `entitled_only` target unchanged. The extra read is
  skipped entirely when no enabled target is in `entitled_only` mode, which is every
  deployment until an operator moves one.
- **The `organization` aggregate provisions a realm.** `SyncWorker.reconcileOrganization`
  calls `OrganizationConnector.ensureRealm`, sets the realm enabled to match the
  organization's status, and only then stamps `realm_provisioned_at`. Suspension
  *disables* the realm and evicts the memoized admin client and its live token; it never
  deletes.
- **A user whose realm does not exist yet is DEFERRED, not failed.** `DeferredError`
  reschedules the event with backoff but leaves `attempts` untouched, so waiting on a
  prerequisite can never spend the dead-letter budget — the reason lands in `last_error`
  so the wait is visible. Master is exempt: its realm predates this system, so
  `realm_provisioned_at` is `NULL` forever and the check would otherwise defer every
  user in every deployment that has only ever had the one organization.
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
| Max attempts before dead-letter | 8 (the first attempt counts) |
| Backoff base | 2s |
| Backoff ceiling | 10 min |
| Idle poll interval | 5s |

Backoff is exponential with **equal jitter**: `computeBackoffDelayMs` takes
`baseDelayMs × 2^(attempts − 1)`, caps it at the ceiling, and returns a random point in
the upper half of that — `[capped/2, capped]`. Never a near-zero retry, and never
perfectly synchronised across a batch of events that failed together.

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

Two jobs walk reality and compare it against the database, because a queue alone cannot
detect drift someone caused directly inside a target. They are **not** the same shape and
they are **not** guarded the same way.

- **`reconcile`** walks users at every status, compares against Keycloak, reports drift,
  enqueues corrective events and drains them. It has **no dry-run mode, no `--force`, no
  arguments at all, and no blast-radius rail** — it always repairs what it finds. It runs
  on demand *and* daily at 03:00 via `idm-reconcile.timer`, which `install.sh` enables.
- **`target-reconcile <target>`** walks the whole directory for one connector target,
  builds a plan, and applies it. **Dry run is the default**; `--apply` is explicit. It is
  deliberately never put on a timer.

Of the three reconcilers, the **blast-radius** rail belongs to `target-reconcile` alone
(`outbox/target-reconciliation.job.ts`, `evaluateBlastRadius`) — but not to it alone
system-wide: the inbound `hr:sync` path calls the same `evaluateBlastRadius`, with its own
threshold and floor (`hr/hr-feed.ts`, `evaluateHrRun`). A run halts if it would
mutate more than `blastRadiusThreshold` percent of the target's population **and** more
than `blastRadiusFloor` principals in absolute terms. Both conditions must hold — so a
small real batch proceeds at a scary-looking percentage, while a large one still halts at
a modest one. Overriding requires `--force` (or `force: true` on
`POST /connector-targets/:target/reconcile`, the only one of the two with an HTTP route)
and is separately audited.

A third reconciler, **`role-reconcile`**, keeps the entitlements business roles grant —
`group_user_members` rows and `user_target_accounts` rows, both carrying
`grant_source = 'business_role'` — matching what the published roles say they should be.
It is not a target-drift job: it compares the database against itself, and only ever
revokes rows it granted. It ships no systemd unit, so nothing runs its sweep until you
do.

## Trust boundaries

| Boundary | What crosses | How it is controlled |
|---|---|---|
| Browser → API | Bearer JWT | Verified against Keycloak JWKS; issuer and audience matched |
| API → Postgres | SQL as the **runtime** role | Owns nothing; no `CREATE`; `SELECT`/`INSERT` only on `audit_log` |
| Migrations → Postgres | DDL as the **owner** role | Only `db:migrate` ever connects as this |
| API → Keycloak Admin | Client-credentials grant (`KEYCLOAK_ADMIN_CLIENT_*`) | The sync service account holds exactly four `realm-management` roles: `manage-users`, `query-users`, `view-users`, `query-groups` |
| API → Keycloak, realm provisioning | A **separate** client-credentials grant (`KEYCLOAK_PROVISION_CLIENT_*`) | A master-realm service account holding `create-realm` and nothing else. Optional — `keycloak-setup.sh` creates it only under `SETUP_PROVISIONER=1`, and `POST /organizations` returns `NOT_CONFIGURED` without it |
| Worker → targets | Credentials resolved at point of use | Only `CONNECTOR_*` variables are resolvable; never stored, logged, or returned. The SSO-client registrar is one of these — its `credentialSecretName` is conventionally `CONNECTOR_KEYCLOAK_SSO_CLIENT_SECRET` — a third Keycloak identity holding `manage-clients` alone |

### The two database roles

The single most load-bearing structural decision in the deployment.

| | `DATABASE_URL` (owner) | `RUNTIME_DATABASE_URL` (runtime) |
|---|---|---|
| Who connects as it | `db:migrate` only | The API process (and the sync worker inside it) and **every** other CLI: `bootstrap:admin`, `reconcile`, `target-reconcile`, `role-reconcile`, `jml:lifecycle`, `hr:sync`, `activate` |
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
  access-requests/  the requestable-role catalogue, request inbox, approver resolution
  admin/            bootstrap-admin — the anti-lockout operator script
  attributes/       custom attribute definitions, per-target mappings, validator
  audit/            append-only writer, repository, read API
  auth/             JwtGuard, GET /me
  authz/            action catalog, PermissionEngine, privilege guards, role assignments
  business-roles/   definitions, draft/simulate/publish, evaluator, reconciler,
                    SoD checker, role miner
  common/           errors, exception filter, pagination, HTTP parsing helpers
  config/           env schema (Zod) — the only place process.env is read
  connectors/       the connector spine, one file per ADAPTER (all six scim_* targets
                    share scim.connector.ts), secret resolution, GET /data-flows
  db/               schema (one file per table), migrations, role provisioning
  groups/           groups, membership, nesting
  health/           GET /health
  hr/               HR sources — csv_url and rest_json feeds, fetch/preview/commit
  imports/          CSV parse, row shape, preview/commit
  jml/              joiner/mover/leaver rules, engine, applier, lifecycle job
  keycloak/         Admin REST client, session revocation
  org-units/        the ltree tree
  organizations/    tenants and their realms, master-organization resolution
  outbox/           writer, repository, sync worker, reconciliation jobs
  recertification/  campaigns, reviewer inbox, per-item decisions
  self-service/     /self — no id anywhere, by construction
  sso-apps/         OIDC and SAML application registrations
  users/            users controller + repository

apps/web/src/
  api/              shared fetch plumbing and ApiError
  attributes/       dynamic attribute field rendering
  audit/            audit log + dead letters
  auth/             OIDC config, AuthRoot, Account Console deep link
  brand/            BRAND, BrandMark, BrandLockup — the one source of the product name
  business-roles/   definitions, definition editor, simulate panel, conflicts, mining
  connectors/       target list, configuration, dry run, attribute mapping editor
  forms/            Field, Combobox, API error → field error mapping
  hr/ organizations/ recertification/ sso-apps/
  groups/ imports/ org-units/ people/ roles/ self-service/
  shell/            AppShell, nav, toasts, theme, confirm dialog, permission gating
  styles/           tokens.css, base.css, components.css — tokens.css is the
                    design-system contract every feature stylesheet is checked against
```

## Design decisions worth knowing

- **The permission catalog is static code, not database rows.** A permission table is
  itself a privilege-escalation surface; these grants change only through code review.
- **Lookup tables indexed by database-sourced values use `Object.create(null)`.** A
  Postgres enum can gain a label via `ALTER TYPE ... ADD VALUE`, and a plain `{}`
  resolves `constructor` / `__proto__` / `toString` to inherited, truthy values that
  defeat a `?? fallback`. The convention is applied throughout — around sixty call sites
  in `apps/api/src` and `apps/web/src` today — and a null-prototype catalog plus
  `Object.hasOwn` removes the hazard at its source. **This bit the project four times.**
  That figure is a running tally the code itself keeps and enumerates: `authz/actions.ts`
  names the first three (the attribute validator's two `__proto__` findings, then the
  `ROLE_PERMISSIONS`/`ROLE_RANK` finding that closed it) and
  `connectors/connector-registry.ts` adds the fourth (`jml/rule-engine.ts`'s `closedSet`
  and `CONDITION_FIELD_EXTRACTORS`). One later comment, `common/cross-tenant.ts`, says
  *five* without naming a fifth — so four is the enumerated floor, not a ceiling.
- **The connector target catalog has one canonical source, and one guarded copy.**
  In the API, `ALL_CONNECTOR_TARGETS` (`connectors/connector.ts`) is the array and the
  `ConnectorTarget` union derives from it; `test/connector-target-catalog.spec.ts`
  asserts it matches the `outbox_target` pgEnum in both directions. The console cannot
  import it, so `apps/web/src/connectors/api.ts` hand-writes its own union, array and
  `CONNECTOR_TARGET_LABEL` record — and `apps/web/scripts/check-connector-targets.mjs`
  (run by `pnpm --filter @idm/web test`, and so by `verify:quick`) fails the build if
  any of the three drifts. That guard exists because the hand-copy already went stale
  once, when `mail_server` was added: TypeScript could not see it — a narrower literal
  list is assignable to a wider union — and the result was a live outbound integration
  the console could not list, configure, enable or **disable** without direct database
  access.
- **Whole-request rejections happen before any row is touched.** Missing CSV columns,
  oversized row counts and malformed bodies fail up front — never a truncated partial
  apply.
- **Audit snapshots name their fields explicitly.** Never `{ ...user }` — a spread
  would silently carry a future sensitive column into an append-only log a leak can
  never be removed from.
