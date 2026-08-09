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
Import rows are capped by `IMPORT_MAX_ROWS` (5,000 default → 400).

---

## Health

### `GET /health`

No authentication. → `{ "status": "ok" }`

---

## Session

### `GET /me`

Auth only. Echoes verified JWT claims: `{ subject, username, email }`.

> **Not a session-validity check.** A `pending`, `suspended` or `deactivated` principal
> still gets 200 here, because this route resolves nothing from the directory. Use
> `GET /self` for liveness.

---

## Users

`GET`/`POST` on `/users`; `PATCH` and deactivate on `/users/:id`. All user-returning
routes respond with the same shape — the user record plus a derived
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

Omitting `parentId` creates a **root**, which requires a **global** grant. With a
`parentId`, the grant must cover the parent.

> There is no update or delete route for an org unit.

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
| `target` | One of the six target names; an unknown value is a 400, never a silently empty result |
| `limit`, `offset` | Standard |

Rows carry the aggregate, target, attempts and `lastError`.

Read-only. Retrying is reconciliation's job, not an HTTP route.

---

## Routes that do not exist

Worth stating explicitly, because their absence is a design decision:

| Not available | Why |
|---|---|
| `DELETE /users/:id` | `deactivated` is terminal; users are never deleted |
| `PATCH`/`DELETE /org-units/:id` | Not built |
| `DELETE /groups/:id` | Not built |
| Any `PATCH /users/:id` change to `orgUnitId`, `username`, `primaryEmail`, `status` | Out of the PATCH surface by design |
| Any write to `attribute-definitions` | Database-managed today |
| Any JML rule API | Database rows plus the `jml:lifecycle` CLI |
| Any business-roles API | Schema only so far — see [14 — Roadmap](14-roadmap.md) |
| Dead-letter retry | Use reconciliation |
