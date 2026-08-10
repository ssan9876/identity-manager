# 10 — API reference

Base URL: the API root. In a production install nginx proxies it at `/api` on the
console's own origin; in development it is `http://localhost:3000`.

## Conventions

**Authentication.** Every route except `GET /health` requires
`Authorization: Bearer <access token>` — a Keycloak-issued JWT whose `iss` matches
`KEYCLOAK_ISSUER` and whose `aud` includes `KEYCLOAK_AUDIENCE`.

**Content type.** `application/json` for all request and response bodies.

**Bodies are strict.** Every schema is a `.strict()` Zod object: an unknown key is a
`400 VALIDATION_FAILED` naming that key, never a silent drop.

**PATCH semantics.** A PATCH touches only the fields it names. Fields whose column is
nullable additionally accept an explicit `null` to clear them. Admin `attributes`
updates **replace** the object wholesale; `PATCH /self` is the one exception and merges.

**Pagination.** List endpoints accept `limit` (default 50, max 100 — an oversized value
is *clamped*, not rejected) and `offset` (default 0). They return:

```json
{ "items": [ ... ], "total": 1234, "limit": 50, "offset": 0 }
```

`total` is filtered to the caller's scope, exactly like `items`.

**Errors.**

```json
{ "statusCode": 403, "code": "FORBIDDEN", "message": "…", "issues": ["…"] }
```

| `code` | Status |
|---|---|
| `VALIDATION_FAILED` | 400 |
| `FORBIDDEN` | 403 |
| `NOT_FOUND` | 404 |
| `CONFLICT` | 409 |
| `INVALID_TRANSITION` | 409 |
| `CYCLE_DETECTED` | 409 |

An out-of-scope resource **that exists** returns **403, not 404**.

**Limits.** Request bodies are capped by `BODY_LIMIT_BYTES` (10 MiB default → 413).
Import rows are capped by `IMPORT_MAX_ROWS` (1,000 default → 400).

---

## Health

### `GET /health`

No authentication. → `{ "status": "ok" }`

### `GET /health/ready`

No authentication — the probes that call it (a shell script with curl, a systemd unit,
a kubelet) hold no token.

Readiness, deliberately a **different** question from liveness: checks that the
database answers a trivial query and that the applied-migration ledger is not behind
the migration journal this build ships. → **200**
`{ "status": "ready", "checks": { "database": "ok", "migrations": "ok" } }`; **503**
`{ "status": "not_ready", "checks": {...} }` otherwise. `database` ∈ `ok` ·
`unreachable`. `migrations` ∈ `ok` · `pending` · `unknown`.

Deliberately does **not** check outbound connectors (Keycloak, SCIM/Entra/Google/AD
targets) or outbox depth — an outage there must not take this service out of rotation
for routes that never touch it.

---

## Session

### `GET /me`

Auth only. Echoes verified JWT claims: `{ subject, username, email }`.

> **Not a session-validity check.** A `pending`, `suspended` or `deactivated` principal
> still gets 200 here, because this route resolves nothing from the directory. Use
> `GET /self` for liveness.

---

## Users

`GET /users`, `POST /users`, `PATCH /users/:id` and deactivate on `/users/:id`. All
user-returning routes respond with the same shape — the user record plus a derived
`syncState: "pending" | "synced" | "failed"`.

### `GET /users` — `user:read`

| Query | Notes |
|---|---|
| `limit`, `offset` | Standard pagination |
| `status` | `pending` · `active` · `suspended` · `deactivated`. **Omitted excludes deactivated users.** |
| `orgUnitId` | UUID |
| `search` | Matches name, username or email. Empty/whitespace means "no search", never a 400. Max 255 chars. |
| `ids` | Comma-separated UUIDs, max 200. Resolves a known set in one round trip. `ids=` (empty) means "match nothing", **never** "no filter". |

Scope narrows both `items` and `total`.

### `GET /users/:id` — `user:read`

404 if it does not exist; **403** if it exists outside your scope.

### `GET /users/:id/sync` — `user:read`

Per-target sync detail behind the `syncState` field every user-returning route already
carries — for each connector target: state, attempts, next retry, timestamps, the
external id, and `lastError`.

`lastError` is **redacted** (`errorDetailRedacted: true`, and every `lastError`
nulled) unless the caller **also** holds a **global** grant of `audit:read` — the raw
target error string can name internal hosts or directory paths, so a `user:read`
holder alone learns *that* a target failed and how many times, never the vendor's
error text.

### `GET /users/:id/entitlements` — `user:read`

Every group membership and target account this user holds, each with where it came
from (`grantSource`, `grantedBy`, `grantedAt`) and — for role-derived rows — which
enabled business roles justify it **right now**. `justifiedBy` is computed live on
every request and never stored, so it cannot go stale.

`justifiedBy` is three-valued: a non-empty list names the roles holding it open; `[]`
means nothing currently justifies the row (a genuine finding for a `business_role`
row, the normal state for a `manual` one); `null` means the role engine could not be
evaluated at all, so nobody can say. A `manual` row always reports `justifiedBy: []`,
even when a role would also want it — a human granted it by hand and the reconciler
never revokes it.

`unevaluable` is non-null, naming the role and reason, when the engine refused —
the rows are still returned even then, since they are facts in Postgres and this is
the screen an operator opens *because* something is wrong.

### `POST /users` — `user:create`

```json
{
  "primaryEmail": "ada@example.com",
  "username": "ada",
  "firstName": "Ada",
  "lastName": "Lovelace",
  "orgUnitId": "…uuid…",
  "employeeId": "E1001",
  "jobTitle": "Engineer",
  "managerId": "…uuid…",
  "location": "London",
  "startDate": "2026-09-01",
  "endDate": null,
  "attributes": { "costCentre": "CC-12" }
}
```

Required: `primaryEmail`, `username`, `firstName`, `lastName`, `orgUnitId`. Dates are
`YYYY-MM-DD`. Custom attributes are validated against active `attribute_definitions`.

Created with status `pending`. → **201**

Requires `user:create` covering `orgUnitId`.

### `PATCH /users/:id` — `user:update`

Accepts `firstName`, `lastName`, `jobTitle`, `employeeId`, `managerId`, `location`,
`startDate`, `endDate`, `attributes`. The nullable ones also accept `null` to clear.

> `primaryEmail`, `username`, `orgUnitId` and `status` are **deliberately not** in this
> surface. An org-unit change is an authorization change; status is owned by lifecycle
> automation and deactivation.

Also requires that the target does not outrank you.

### `POST /users/:id/activate` — `user:activate`

No body. → **200** with the updated user.

Accepts `pending → active` and `suspended → active`. A `deactivated` target is **409**
`INVALID_TRANSITION` — that status is terminal. An already-`active` target is **409** too,
not a silent no-op.

Also requires that the target does not outrank you.

> Unlike deactivate, this does **not** call Keycloak inline. It writes a `status_changed`
> outbox event, and the account is enabled downstream when the sync worker drains it.
> Expect `syncState: "pending"` in the response.

### `POST /users/:id/deactivate` — `user:deactivate`

No body. → **200** with the updated user.

Commits the local transaction, then **synchronously** disables the Keycloak account and
revokes its sessions before returning. A failure there does not fail the request — the
queued outbox event is the durability fallback.

`deactivated` is terminal. **There is no `DELETE /users/:id`.**

---

## Role assignments

Mounted under `/users`. All three require `role:assign`, plus the reachability, grant-
scope and rank checks described in [08 — Authorization](08-authorization.md#the-four-checks-on-a-role-write).

### `GET /users/:id/roles`

→ the target's assignments.

### `POST /users/:id/roles`

```json
{ "roleKey": "help_desk", "scopeOrgUnitId": "…uuid…" }
```

`scopeOrgUnitId` omitted or `null` means **global**. → **201**

### `DELETE /users/:id/roles/:assignmentId`

`:assignmentId` must belong to `:id` — one belonging to a different user is a 404.

---

## Org units

### `GET /org-units` — `org_unit:read`

Paginated, scope-narrowed.

### `GET /org-units/:id` — `org_unit:read`

### `GET /org-units/:id/subtree` — `org_unit:read`

The whole subtree as a flat array. Checking the requested root suffices: `ltree`
containment is transitive.

### `POST /org-units` — `org_unit:create`

```json
{ "name": "EMEA", "parentId": "…uuid…" }
```

`parentId` is **required**. Every org unit this route creates is a child, and the grant
must cover the parent. A **root** org unit belongs to an *organization*, which owns
exactly one, and the only thing that creates one is creating the organization — so there
is deliberately no route that makes one. (Before organizations landed, omitting
`parentId` created a root under a global grant; that branch is gone, and omitting it now
is a **400**.)

> There is no update or delete route for an org unit.

---

## Organizations

Every route requires a **global** grant of the named action — an organization belongs to
no org unit, so a scoped grant has nothing to narrow to — and all three actions are held
by `super_admin` alone. Creating a tenant is a platform-operator act.

### `GET /organizations` — `organization:read`

Paginated, ordered by `slug`, and **includes master** — an operator's first question
about the roster is usually which of these is the platform's own.

### `POST /organizations` — `organization:create`

```json
{ "slug": "acme", "name": "Acme Corp" }
```

`slug` must match `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` — a DNS label, because it
becomes the Keycloak realm name. `realm` is not accepted: it is always the slug.

→ **201** with the row. `realmProvisionedAt` is `null`: the realm is created
asynchronously by the sync worker, usually within a second or two.

In one transaction this writes the organization, its single root org unit, an audit row
and one `organization` outbox event.

| Refusal | Status |
|---|---|
| No provisioning credential configured | **503** `NOT_CONFIGURED`, naming the two environment variables — refused *before* the insert |
| `master`, or this deployment's own master realm/slug | **409** — reserved |
| Malformed slug, or any unknown key | **400** |
| Slug already taken | **409** |

### `PATCH /organizations/:id` — `organization:update`

```json
{ "status": "suspended" }
```

`status` is the **only** accepted key, and the schema is `.strict()`, so an attempt to
change `slug` is a **400** rather than a silently ignored field — a slug is a realm name
that every one of the tenant's people authenticates against, and there is no rename
anywhere in this product.

Suspending disables the tenant's realm; it never deletes it. Master answers **409**:
suspending it would disable the realm every administrator, including the caller, signs
in through.

---

## Groups

### `GET /groups` — `group:read`

| Query | Notes |
|---|---|
| `limit`, `offset` | Standard |
| `userId` | Filters to that user's **effective** membership. The named user must be reachable under `user:read`, or 403 — otherwise this filter would be an existence oracle. |

Global groups (`orgUnitId: null`) are always included, regardless of scope.

### `GET /groups/:id` — `group:read`

### `GET /groups/:id/members` — `group:read`

→ `{ "users": ["…uuid…"], "groups": ["…uuid…"] }` — **direct** edges only, ids only.
Resolve them with `GET /users?ids=…`.

### `GET /groups/:id/effective-members` — `group:read`

→ `["…uuid…"]` — the transitive closure of user members.

### `POST /groups` — `group:create`

```json
{ "name": "Engineering", "description": "…", "orgUnitId": "…uuid…", "attributes": {} }
```

Omitting `orgUnitId` creates a **global** group, which requires a **global** grant. →
**201**

### `PATCH /groups/:id` — `group:update`

`name`, `description` (nullable), `attributes`. `orgUnitId` is not in this surface.

### `POST /groups/:id/members` — `group:manage_members`

```json
{ "userId": "…uuid…" }
```

### `DELETE /groups/:id/members/:userId` — `group:manage_members`

### `POST /groups/:id/child-groups` — `group:manage_members`

```json
{ "childId": "…uuid…" }
```

A cycle is `409 CYCLE_DETECTED` and writes no audit row. Self-nesting is rejected by a
database `CHECK`.

### `DELETE /groups/:id/child-groups/:childId` — `group:manage_members`

---

## Business roles

The admin API for business roles: the catalog, the draft → simulate → publish gate,
the enable/disable kill switch, per-person exceptions, segregation-of-duties (SoD)
conflicts, and role mining.

**Global grant only on every mutating route.** A business role belongs to no org
unit, so a scoped grant has nothing to narrow to — the same posture as connector
targets, HR sources, SSO applications, and the audit log. Read routes are **not**
global-gated (a role's conditions and grants *describe* access, they do not confer
it) — **except** `GET /business-roles/mining/recommendations`, which reads the
entire directory's manual memberships and requires `business_role:manage` held
globally even though it is a GET.

| Route | Action | Notes |
|---|---|---|
| `GET /business-roles` | `business_role:read` | |
| `POST /business-roles` | `business_role:manage` **(global)** | New role is disabled and undrafted by construction |
| `GET /business-roles/:id` | `business_role:read` | |
| `PATCH /business-roles/:id` | `business_role:manage` **(global)** | `name`, `description` only |
| `PUT /business-roles/:id/draft` | `business_role:manage` **(global)** | Replaces `draft_definition` wholesale; clears any prior simulation |
| `POST /business-roles/:id/simulate` | `business_role:manage` **(global)** | Dry run over the whole directory; commits nothing but the simulation record |
| `POST /business-roles/:id/publish` | `business_role:manage` **(global)** | Refuses (409) unless simulated against this exact draft hash; also refuses when the recorded SoD-violation count is non-zero **or `null`** (a pre-0034 simulation predating SoD checking) — re-simulate first. Sweeps affected users afterward. |
| `POST /business-roles/:id/enable` | `business_role:manage` **(global)** | Sweeps immediately |
| `POST /business-roles/:id/disable` | `business_role:manage` **(global)** | A revocation, not a pause — sweeps immediately |
| `PUT /business-roles/:id/requestable` | `business_role:manage` **(global)** | Publishes into (or withdraws from) the self-service catalogue; grants/revokes nothing |
| `POST /business-roles/:id/exceptions` | `business_role:manage` **(global)** | Per-person include/exclude override; re-evaluates that one user in the same transaction |
| `DELETE /business-roles/:id/exceptions/:userId` | `business_role:manage` **(global)** | Mirrors `POST .../exceptions` |
| `GET /business-roles/conflicts` | `business_role:read` | Every SoD conflict, retired ones included |
| `POST /business-roles/conflicts` | `business_role:manage` **(global)** | Defines a conflicting pair; changes nobody's access |
| `GET /business-roles/conflicts/violations` | `business_role:read` | Detective report: who currently holds both roles of an enabled pair |
| `PATCH /business-roles/conflicts/:conflictId` | `business_role:manage` **(global)** | `reason` only — the pair is immutable |
| `POST /business-roles/conflicts/:conflictId/enable` | `business_role:manage` **(global)** | Retire/restore; there is no delete |
| `POST /business-roles/conflicts/:conflictId/disable` | `business_role:manage` **(global)** | |
| `GET /business-roles/mining/recommendations` | `business_role:manage` **(global)** | Read-only, but requires the global manage grant — see above |
| `POST /business-roles/mining/drafts` | `business_role:manage` **(global)** | Adopts a recommendation as a new disabled role plus a pre-filled draft |

There is no `DELETE /business-roles/:id`.

---

## Access requests

The self-service access-request catalogue: browse requestable roles, ask for one
with a justification, cancel your own pending ask, and — for the resolved
approver — an inbox with one-click approve/deny.

**Authentication only**, like `/self` — an ordinary employee holds no admin role
and no permission grant, yet requesting access and deciding a direct report's
request are exactly their job. Authorization is per-route instead:

- the requester is always the authenticated caller — no route accepts a
  requester/subject id anywhere;
- cancelling requires being the request's own requester, and only while pending;
- deciding requires being the request's resolved approver, or holding a
  **global** grant of `business_role:manage`;
- nobody decides their own request, checked before either of the above.

### `GET /access-requests/catalogue`

Requestable **and** enabled roles in the caller's own organization.

### `GET /access-requests/mine`

The caller's own request history.

### `GET /access-requests/inbox`

Pending requests whose resolved approver is the caller. `{ "requests": [] }` for
someone who manages nobody and holds no admin role — a normal 200.

### `POST /access-requests`

```json
{ "businessRoleId": "…uuid…", "justification": "…", "requestedExpiresAt": null }
```

`justification` is required. A role outside the caller's catalogue is a 404
indistinguishable from one that does not exist.

### `POST /access-requests/:id/cancel`

Cancels the caller's **own** pending request. Someone else's request — even a
real id — is a 404, not a 403.

### `POST /access-requests/:id/approve`

```json
{ "comment": null }
```

Writes a business-role **include exception** (the request id plus the
justification as its reason, the requested expiry as its expiry) and
re-reconciles the subject in the same transaction. A refusal (an unevaluable
role) rolls the approval back — **409**, never a 200 for an approval that
silently did nothing.

### `POST /access-requests/:id/deny`

```json
{ "comment": null }
```

State → denied. No exception, no reconciliation.

There is no delete route — requests end in a terminal state.

---

## Recertification

Access-recertification campaigns: create a draft, open it (which snapshots the
review set), close it, and read progress. The reviewer surface — "my pending
items", decide — is separate: reviewers are ordinary managers who may hold no
role in the catalog at all.

**Campaign routes require a global grant of `recert:manage`** for every
mutation (a campaign belongs to no org unit and its review set spans the whole
directory) and `recert:read` for reads. **Review routes are authentication
only** and identity-based: the caller must be the item's resolved reviewer, or
hold a global `recert:manage` grant — and nobody reviews their own access,
checked first, unconditionally.

### `GET /recert-campaigns` — `recert:read`

### `POST /recert-campaigns` — `recert:manage` **(global)**

```json
{ "name": "…", "scopeRoleIds": null, "reviewerStrategy": "manager_of_subject", "dueDate": null }
```

`reviewerStrategy` ∈ `manager_of_subject` · `role_owner` — resolved per include-exception
item when the campaign opens: `manager_of_subject` tries the subject's manager, else the
campaign's creator; `role_owner` tries the campaign's creator, else the subject's manager
(`business_roles` carries no owner column). `scopeRoleIds` is either `null` (every enabled
role at open time) or a non-empty array of role ids — `[]` is a **400**, never a campaign
that silently reviews nothing. A new campaign is a **draft** by construction.

### `GET /recert-campaigns/:id` — `recert:read`

The campaign plus its items.

### `POST /recert-campaigns/:id/open` — `recert:manage` **(global)**

Snapshots the review set into `recert_items`, in the same transaction as the
draft → open transition. Formula-derived membership is reviewed **per role**
(one decision covers the formula); include-exceptions are reviewed **per
person**. An unevaluable role refuses the whole open.

### `POST /recert-campaigns/:id/close` — `recert:manage` **(global)**

Terminal. Undecided items stay `pending` forever and leave every reviewer's
queue.

### `GET /recert/my-reviews`

Auth only. The caller's pending items on open campaigns, filtered to
`reviewer_user_id = caller` in SQL.

### `POST /recert/items/:id/decide`

Auth only, identity-based.

```json
{ "decision": "certified", "comment": null }
```

`decision` ∈ `certified` · `revoked_requested`. `certified` records the
attestation and touches nothing else. `revoked_requested` on an
include-exception item expires that exception and re-reconciles the subject in
the same transaction — a reconciler refusal rolls the whole decision back.
`revoked_requested` on a role-formula item performs **no revocation**; it
records the finding and points the operator at the role's own
draft → simulate → publish path.

---

## Imports

Both routes require `user:create` and return **200**.

### `POST /imports/preview`

```json
{ "csv": "employeeId,primaryEmail,username,firstName,lastName,orgUnitId\nE1,…" }
```

Required columns: `employeeId`, `primaryEmail`, `username`, `firstName`, `lastName`,
`orgUnitId`. Optional known columns: `jobTitle`, `managerId`, `location`, `startDate`,
`endDate`. **Any other column becomes a custom attribute key.**

Writes nothing about a user; resolves every row exactly as commit would.

```json
{
  "toCreate": [{ "row": 2, "employeeId": "E1", "primaryEmail": "…", "username": "…" }],
  "toUpdate": [{ "row": 3, "employeeId": "E2", "userId": "…", "primaryEmail": "…", "username": "…" }],
  "failures": [{ "row": 4, "employeeId": "E3", "reasons": ["orgUnitId: not found"] }],
  "summary": { "toCreate": 1, "toUpdate": 1, "failed": 1, "total": 3 }
}
```

`row` is the line number in the file (data starts at 2). Preview writes **one** audit
row per invocation — actor and row count.

### `POST /imports/commit`

Same body. One transaction **per row**; one `batchId` for the request, stamped on every
audit row it produces.

```json
{ "batchId": "…uuid…", "created": 10, "updated": 3, "unchanged": 40, "failed": 1,
  "failures": [ … ] }
```

`unchanged` counts rows that matched an existing user but resolved to an identical
record — no audit row, no sync event. A batch with only failures is still 200.

---

## Self-service

`GET`/`PATCH /self` and friends. **Authentication only** — no role required, works for a
user with zero role assignments. Any non-`active` user gets 403.

No route here takes an id, in the URL, the body, or a query parameter.

### `GET /self`

Profile plus what you may edit:

```json
{
  "id": "…", "username": "…", "status": "active", "…": "…",
  "editable": { "coreFields": ["location"], "attributes": [ /* self-editable definitions */ ] }
}
```

### `GET /self/groups`

→ `{ "direct": [ … ], "effective": [ … ] }` — resolved unscoped, because these are your
own memberships.

### `GET /self/permissions`

→ `{ "actions": ["user:read", …] }` — your effective actions, ignoring scope entirely.
An empty array is a valid state, never an error. This is what drives console nav
visibility.

### `GET /self/roles`

→ `{ "assignments": [{ "roleKey": "…", "scopeOrgUnitId": "…", "scopePath": "…" }] }`

### `PATCH /self`

```json
{ "location": "Berlin", "attributes": { "dietaryNotes": "none" } }
```

Only `location` and attributes whose definition has `self_editable = true`. Anything
else is a 400 naming the field. Attributes **merge**, under `SELECT ... FOR UPDATE`, so a
self-service edit can never erase attributes only an admin can set, and two concurrent
edits cannot lose one another.

Audited as `user:self_update`, distinct from `user:update`.

Credentials (password, MFA) have no route here at all, by design — the console deep-links
to Keycloak's Account Console.

---

## Attributes

### `GET /attribute-definitions` — `user:read`

| Query | Notes |
|---|---|
| `appliesTo` | `user` or `group` |

Active definitions only. **There is no write endpoint** — definitions are managed
directly in the database.

### `GET /attribute-target-mappings` — `connector:read`

Every mapping row.

### `POST /attribute-target-mappings` — `connector:manage` **(global)**

```json
{
  "attributeDefinitionId": "…uuid…",
  "coreField": null,
  "target": "active_directory",
  "remoteName": "extensionAttribute1",
  "enabled": true
}
```

Exactly one of `attributeDefinitionId` or `coreField` (`given_name` · `surname` ·
`title` · `department`). `enabled` defaults to `true`. → **201**

### `PATCH /attribute-target-mappings/:id` — `connector:manage` **(global)**

Only `enabled` and `remoteName`. Never which field or target the row governs.

### `DELETE /attribute-target-mappings/:id` — `connector:manage` **(global)**

→ `{ "deleted": true }`

---

## Connector targets

### `GET /connector-targets` — `connector:read`

Every target in the catalog, each with configuration (**never a secret value — the field
is absent, not redacted**), blast-radius settings, `lastSuccessfulSyncAt`,
`healthStatus` and `healthDetail`.

`healthStatus` ∈ `not_configured` · `disabled` · `failing` · `never_synced` · `healthy`.
The first two never attempt a live check.

### `GET /connector-targets/:target` — `connector:read`

### `PATCH /connector-targets/:target` — `connector:manage` **(global)**

```json
{
  "enabled": true,
  "config": { "url": "ldaps://dc1.corp.example.com:636", "credentialSecretName": "CONNECTOR_AD_BIND_PASSWORD" },
  "blastRadiusThreshold": 20,
  "blastRadiusFloor": 5
}
```

`config` **merges** — a key this call omits is preserved, not destroyed.
`blastRadiusThreshold` is 1–100; `blastRadiusFloor` is ≥ 0.

### `POST /connector-targets/:target/reconcile` — `connector:manage` **(global)**

```json
{ "dryRun": true, "force": false }
```

`dryRun` is **required** — there is no default, so an apply is always explicit.
`dryRun: true` writes nothing anywhere. `dryRun: false` is a real apply, still gated by
the blast-radius guard unless `force: true`.

400 if the target has no blast-radius configuration yet. → **200** with the report:
`populationSize`, `toMutate`, `toMutateGroups`, `appliedCount`, `appliedGroupCount`,
`halted`, `overridden`, `failed`.

Every invocation is audited, dry runs included.

---

## HR sources

CRUD-minus-delete over inbound HR feeds, a run-history view, and "run preview now".
There is deliberately no `DELETE` route — a source that has run is named by
append-only audit rows, so it is disabled instead.

**Authorization follows connector targets exactly:** reads need `connector:read`;
every mutating route (and the run-preview route, which fetches from an
admin-configured URL with a resolved credential and walks the directory) needs
`connector:manage` held **globally** — an HR feed is organization-wide
infrastructure.

### `GET /hr-sources` — `connector:read`

### `GET /hr-sources/:id` — `connector:read`

### `GET /hr-sources/:id/runs` — `connector:read`

The 50 most recent `hr_source:sync` audit rows for this source, newest first (hard
`LIMIT 50`, no pagination) — the durable ledger behind the source row's own
`lastRun*` fields, which only ever show the latest run.

### `POST /hr-sources` — `connector:manage` **(global)**

```json
{
  "organizationId": "…uuid…",
  "name": "Workday export",
  "kind": "csv_url",
  "url": "https://…",
  "auth": { "headerName": "X-Api-Key", "secretName": "CONNECTOR_WORKDAY_KEY" },
  "columnMapping": {},
  "config": {},
  "enabled": true
}
```

`kind` ∈ `csv_url` · `rest_json`. → **201**

### `PATCH /hr-sources/:id` — `connector:manage` **(global)**

Everything but `organizationId` and `kind`.

### `POST /hr-sources/:id/preview` — `connector:manage` **(global)**

Fetches the feed, applies the mapping, and runs the import pipeline's **preview** —
never a commit; commits happen through the `hr:sync --commit` CLI. Writes nothing
about any user, but records the run's outcome on the source row and one
`hr_source:sync` audit row. → **200**

---

## Data flows

### `GET /data-flows` — `connector:read`

"What of ours goes where" — one read-only map of an organization's whole data flow,
inbound and outbound, in a single response: every HR source (inbound) and every
connector target with its configured attribute mappings (outbound). Deliberately
**no live health check** — `GET /connector-targets` already covers "is it reachable
right now"; this answers a structural question.

| Query | Notes |
|---|---|
| `organizationId` | Optional; omitted means master. Readable for any organization, not scoped to the caller's org units — matching `GET /connector-targets`. |

---

## SSO applications

Every route requires a **global** grant; `sso_app:read` and `sso_app:manage` are held
by `super_admin` alone. A scoped grant is rejected with an explanation — an application
belongs to no org unit, so there is nothing to narrow to.

| Route | Action | Notes |
|---|---|---|
| `GET /sso-apps` | `sso_app:read` | |
| `GET /sso-apps/:id` | `sso_app:read` | |
| `POST /sso-apps` | `sso_app:manage` | |
| `PATCH /sso-apps/:id` | `sso_app:manage` | |
| `POST /sso-apps/:id/enable` | `sso_app:manage` | |
| `POST /sso-apps/:id/disable` | `sso_app:manage` | |
| `POST /sso-apps/:id/client-secret` | `sso_app:manage` | Mints; returns the value once |

There is no `DELETE`.

`PATCH` accepts `name`, `description`, `redirectUris`, `webOrigins`, `groupsClaim` and
nothing else. Bodies are `.strict()`, so sending `clientId`, `publicClient` or `enabled`
is a **400 naming the field**, not a silent no-op — an admin who thinks they renamed a
client must not be told it worked. `clientId` is immutable because downstream
applications hard-code it; `publicClient` because flipping it invalidates the secret and
changes the whole auth model; `enabled` because enable/disable are separately audited
verb routes, mirroring `POST /users/:id/deactivate`.

**Validation rails.** A wildcard is permitted only in the path of a redirect URI —
`https://app.example.com/*` is accepted, `https://*` and `*` are rejected. `webOrigins`
accepts `+` but not `*`. Every offending value is reported in one response rather than
failing on the first, and each reason names the value verbatim. A reserved client id is
rejected (see [12 — Security](12-security.md#known-open-items)).

**Client secrets.** `POST /sso-apps/:id/client-secret` mints a new secret, invalidating
the previous one, and returns it in that one response. It is never stored — not in
`sso_apps`, the outbox, or the audit snapshot — so there is no endpoint that can return
it again and no reveal affordance in the console. The audit row records that a secret
was minted, by whom, for which application, never the value. Rotation is a re-mint.

| Case | Status |
|---|---|
| Minted before the first successful sync | **409** — the application exists here; no Keycloak client does yet |
| Minted for a public client | **409** — public clients use PKCE and have no secret |
| Duplicate `client_id` | **409** |

---

## Audit and dead letters

Both require a **global** grant of `audit:read`. A scoped grant is rejected with an
explanation — see [08 — Authorization](08-authorization.md#where-a-global-grant-is-required).

### `GET /audit`

| Query | Notes |
|---|---|
| `actor` | Free text, ≤ 255 |
| `action` | ≤ 64, e.g. `user:deactivate` |
| `resourceType` | ≤ 64 |
| `resourceId` | UUID |
| `batchId` | UUID — every row from one import commit |
| `from`, `to` | `YYYY-MM-DD`, inclusive **day boundaries in UTC** |
| `limit`, `offset` | Standard |

Rows carry `actorUserId` (null for system actions), `action`, `resourceType`,
`resourceId`, `before`, `after`, `batchId`, `createdAt`.

### `GET /outbox/dead-letters`

| Query | Notes |
|---|---|
| `target` | One of the **thirteen** connector target names — the filter is `z.enum(ALL_CONNECTOR_TARGETS)` (`outbox/outbox.controller.ts`), so every target the outbox can write is a valid value here, each `scim_*` slot and `keycloak_sso` included. An unknown value is a 400, never a silently empty result. (The 400's *message* still names only the original five targets — a stale string in that handler, not a narrower filter.) |
| `limit`, `offset` | Standard |

Rows carry the aggregate, target, attempts and `lastError`.

Read-only. Retrying is reconciliation's job, not an HTTP route.

---

## Routes that do not exist

Worth stating explicitly, because their absence is a design decision:

<!-- ABSENCE-TABLE: scripts/check-docs.mjs anchors on this exact comment and parses
     every row below whose FIRST cell is exactly one canonical `METHOD /path` token —
     nothing else in the cell: no surrounding prose, and no two methods joined into
     one cell (joining a PATCH and a DELETE claim into a single cell, as this table
     once did for org-units, silently hides the second method from the parser — keep
     one method per row). Each such token is asserted ABSENT from the live API and is excluded
     from the phantom-route check for that reason: this table's entire job is to hold
     tokens shaped exactly like "this route exists" while meaning the opposite, and a
     route claimed absent here that has since shipped is exactly the drift this guard
     exists to catch — it fails loudly, naming the route, rather than leaving this
     table to silently go stale. Do not move or delete this comment; if the anchor
     text changes, update ABSENCE_TABLE_MARKER in scripts/check-docs.mjs to match.
     Rows that are prose rather than a bare token (the "Any ..." rows below) are left
     alone by the parser — they are not machine-checked. -->

| Not available | Why |
|---|---|
| `DELETE /users/:id` | `deactivated` is terminal; users are never deleted |
| `PATCH /org-units/:id` | Not built |
| `DELETE /org-units/:id` | Not built |
| `DELETE /groups/:id` | Not built |
| `DELETE /business-roles/:id` | Retire via `POST .../disable` instead — a role's history (conflicts, exceptions, past simulations) survives |
| Any `PATCH /users/:id` change to `orgUnitId`, `username`, `primaryEmail`, `status` | Out of the PATCH surface by design |
| Any write to `attribute-definitions` | Database-managed today |
| Any JML rule API | Database rows plus the `jml:lifecycle` CLI |
| Dead-letter retry | Use reconciliation |
| `DELETE /organizations/:id` | Deleting a realm destroys every user, session, client and credential inside it. A retired tenant is `suspended` |
| Any tenant-facing route | Every administrator is a platform operator authenticating against the master realm |
