# 07 — Admin guide

How to do the job in the console. Every action here is also available over HTTP —
see [10 — API reference](10-api-reference.md).

## The shell

| Region | Contents |
|---|---|
| **Top bar** (48px) | Product name · global search (`⌘K` / `Ctrl-K`) · theme toggle · "My Profile" · signed-in identity · Sign out |
| **Left nav** (240px) | People · Groups · Org units · Roles · Import · Audit · Connectors |
| **Content** | max-width 1440px |

The nav collapses to an icon rail under 1100px and behind a disclosure under 780px.

**Nav items you cannot use are not shown.** Visibility is driven by `GET
/self/permissions`, which returns the caller's own effective actions:

| Nav item | Requires |
|---|---|
| People | `user:read` |
| Groups | `group:read` |
| Org units | `org_unit:read` |
| Roles | `role:assign` |
| Import | `user:create` |
| Audit | `audit:read` |
| Connectors | `connector:read` |

The UI hides what you cannot do; it never *decides* it. Every action is still enforced
server-side, and reaching a hidden route by typing its URL shows an explanatory panel
rather than a bare 403 or a silent empty screen.

**Light theme is the default.** An explicit toggle in the top bar overrides
`prefers-color-scheme` and persists in `localStorage`, resolving before first paint.

### Reading a status

Most of a directory is active, so **active carries no colour** — it renders in muted
ink with no fill. Colour marks the exception: pending, suspended, deactivated,
sync-failed. Status is never conveyed by colour alone; every badge carries its word.

| Badge | Meaning |
|---|---|
| **Active** | Normal. Can sign in. |
| **Pending** | Created, not yet activated. Typically a starter whose `startDate` has not arrived. |
| **Suspended** | Temporarily disabled. **Not** offboarding — does not start any retention clock downstream. |
| **Deactivated** | Terminal. Sessions revoked. Cannot be undone through the API. |
| **Sync: pending** | A change is queued and not yet delivered. |
| **Sync: synced** | Everything queued for this person has landed. |
| **Sync: failed** | Something dead-lettered. **Go and look** — see [Dead letters](#walkthrough-8--investigate-a-failed-sync). |

---

## Walkthrough 1 — Find a person

The People list is the landing page, because that is the job.

1. Type into **Search** — matches name, username or email, debounced, and reflected in
   the URL so the result is linkable and survives a reload.
2. Narrow with **Status**. The default is *All except deactivated*: leavers do not
   clutter everyday work, but are one selection away.
3. Narrow with **Org unit**.
4. Click a row to open the person.

The list is paginated (50 per page, max 100). Both the rows **and the total** are
filtered to your scope — a scoped operator never sees a count that implies records
they cannot open.

`⌘K` / `Ctrl-K` opens global search from anywhere.

---

## Walkthrough 2 — Onboard a starter

**Needs:** `user:create` covering the target org unit.

1. **People → New person**.
2. Fill the required fields: first name, last name, username, primary email, org unit.
   - **Username is the join key to Keycloak.** It is what an authenticated principal is
     matched against. Choose it deliberately; keep it stable.
   - Email and username are both unique case-insensitively.
3. Optional: employee id (unique; the CSV import's idempotency key), job title, manager,
   location, start date, end date.
4. Any custom attributes defined for users appear below, rendered by their data type
   and validated server-side.
5. **Create.**

You land on the new person's detail page. The person is created with status **pending**.

### What happens next

- An `audit_log` row is written in the same transaction as the user row.
- An `outbox_events` row is written per enabled target, in that same transaction.
- The sync worker picks it up and asserts the user into each target. `syncState` moves
  from `pending` to `synced`.

### Activating them

A pending person exists in the directory but is **disabled everywhere downstream** —
every connector derives its enabled flag from `status = 'active'`. Two ways to move them:

- **Activate them directly.** On the person's detail page, click **Activate**. This is the
  right move for someone who is already here, or who was created without a start date.
- **Set a start date.** When `jml:lifecycle` next runs on or after that date, the user
  transitions `pending → active` automatically, and any `start_date_reached` rules fire
  once. This is the right move for a future joiner.

**Needs:** `user:activate` covering the person's org unit, and you must outrank them.
`help_desk` does not hold it — enabling an account is a different kind of act from
editing one.

> **Activation is not instant downstream.** Unlike deactivation, which disables the
> Keycloak account before the request returns, activation only queues the change. The
> account is enabled when the sync worker drains the event; the sync badge tells you when
> that has happened.

> **There is still no status field on the edit form.** Activation and deactivation are
> discrete, audited, permission-gated actions — not a dropdown you can set to anything.
> Only `jml:lifecycle` reaches `active` any other way.

---

## Walkthrough 3 — Offboard a leaver

**This is the operation the product is designed around.** Someone is waiting on the
phone and you need to be *certain* it took effect.

**Needs:** `user:deactivate` covering the person's org unit, and you must outrank them.

1. Open the person.
2. **Deactivate**. Confirm the dialog — it names the person and says what will happen.
3. A toast reports the result, including sessions revoked.

### What actually happens, in order

1. One transaction: status → `deactivated`, `deactivated_at` stamped, an `audit_log`
   row, and an `outbox_events` `status_changed` event.
2. **After** that transaction commits, and **before the response returns**, the API
   calls Keycloak synchronously:
   - `setEnabled(false)` — blocks future logins;
   - `revokeSessions` — kills sessions and tokens already issued.

   Neither substitutes for the other. Disabling an account does not invalidate a token
   already in a browser; revoking sessions does not stop the next login.
3. If that inline call fails, **the request still succeeds** — the queued outbox event
   is the durability fallback, and the worker's reconcile pass re-asserts `enabled`
   every time it runs.

### Why the badge still says "pending" afterwards

Deliberately. The synchronous revocation handles credentials; the queued event still
has to land to finish full reconciliation (profile, groups, attributes, other targets).
The response never implies more has happened than has.

### Deactivation is terminal

`deactivated` is a terminal status and there is **no delete route for a user, ever**.
Re-hiring someone means a new record, or a database-level intervention.

**Suspension is not offboarding.** Only `deactivated` stamps `deactivated_at`, which
starts the retention clock on the mail target. Map suspension onto deactivation and a
suspended employee's mail is eventually purged; map it the other way and offboarded
mail never purges.

---

## Walkthrough 4 — Move someone between departments

**Needs:** `user:update` covering the person.

1. Open the person → **Edit**.
2. Change what moved — job title, manager, location, attributes.
3. **Save.**

> **The edit form does not include org unit, username, email or status.** A scope
> transfer is not part of the PATCH surface: moving a person between org units changes
> who can see and act on them, which is an authorization change wearing a profile
> edit's clothing. Today it requires a database-level change.

Attributes **replace** wholesale on an admin PATCH — send the full object you want.
(`PATCH /self` is the exception: it merges, so a self-service edit cannot erase
attributes only an admin can set.)

---

## Walkthrough 5 — Groups and nesting

**Needs:** `group:read` to view, `group:create`/`group:update` to change,
`group:manage_members` to change membership.

### Create a group

1. **Groups → New group**.
2. Name (unique, case-insensitive), optional description, optional org unit.
3. **Create.**

**Leaving the org unit empty makes the group global** — visible to and writable by any
actor holding the relevant action, regardless of their own scope. Creating one requires
a **global** grant of `group:create`, because local group membership is pushed into
real Keycloak groups, which are a downstream authorization primitive.

### Add and remove members

Group detail → **Members** tab. The person picker searches within your scope.

Members outside what your role can see are shown as an explicit *"Member outside what
your role can see"* row rather than being silently omitted — a scoped operator can tell
"this group has 12 members, 3 of which I cannot see" from "this group has 9 members".

### Nest a group inside another

Group detail → **Nested groups** tab → add a child group.

- **Effective membership** is transitive: members of the child are effective members of
  the parent, recursively.
- A cycle is rejected with `409 CYCLE_DETECTED` and writes **no audit row**. Detection
  runs under a Postgres advisory lock, so two concurrent requests cannot each observe
  "no cycle" and jointly create one.
- A group cannot contain itself (a database `CHECK`, not just application logic).

The **Members** tab shows direct edges; effective membership is what gets pushed
downstream. Active Directory receives native nesting where the child group has
successfully synced and therefore has a DN to point at; Keycloak, Entra and Google
receive the flattened effective set instead.

---

## Walkthrough 6 — Grant and revoke administrative roles

**Needs:** `role:assign` — in today's catalog, only `super_admin` holds it.

1. Open the person → **Roles** tab.
2. **Grant role** → pick the role and the scope (an org unit, or *Global*).
3. To revoke, use the row's revoke action.

### The three checks, all required

Role assignment is the most security-sensitive write in the system — getting it wrong
is privilege escalation, not merely disclosure. Every grant and every revoke passes
**four** independent checks, none of which subsumes another:

1. **Do you hold `role:assign` at all?** (`PermissionGuard`)
2. **Can you reach this person?** `assertCanIn(actor, 'role:assign', target.orgUnitId)`
   — a Sales-scoped admin cannot touch someone in Engineering, even to read their
   grants.
3. **May you grant *this role* at *this scope*?** You may only grant a role you hold
   yourself, at a scope your own holding covers. **A scoped holding can never produce a
   global grant** — the exact path that would turn a departmental account into a
   domain-wide one.
4. **Does the target outrank you?** Independent of scope entirely: a `help_desk` scoped
   to Sales must not be able to touch a global `super_admin` who happens to sit in
   Sales.

**Revoking requires the same four checks**, evaluated against the grant being removed —
otherwise revocation becomes a side door around assignment's own narrowing.

The **Roles** page in the left nav shows the static catalog: which role grants which
actions. See [08 — Authorization model](08-authorization.md).

---

## Walkthrough 7 — Bulk import from CSV

**Needs:** `user:create`. Every row is additionally checked against your scope, and
rows outside it fail individually rather than failing the request.

### The file

Required columns:

```
employeeId, primaryEmail, username, firstName, lastName, orgUnitId
```

Optional known columns: `jobTitle`, `managerId`, `location`, `startDate`, `endDate`
(`YYYY-MM-DD`).

**Any other column becomes a custom attribute key.** That is deliberate: mistyping a
known column (`orgunitid`) produces a clear "unrecognized attribute" failure per row,
rather than the column being silently ignored.

`employeeId` is required here even though it is optional on `POST /users` — it is the
idempotency key the whole import model is matched on.

```csv
employeeId,primaryEmail,username,firstName,lastName,orgUnitId,jobTitle,startDate
E1001,ada@example.com,ada,Ada,Lovelace,3f1c…,Engineer,2026-09-01
E1002,alan@example.com,alan,Alan,Turing,3f1c…,Engineer,2026-09-01
```

### The flow

1. **Import** → paste or upload the CSV.
2. **Preview.** Nothing about a user is written. Every row is resolved exactly as the
   commit would resolve it — same permission checks, same lookups — and you get:
   - **To create** — rows whose `employeeId` matches nothing;
   - **To update** — rows whose `employeeId` matches an existing user;
   - **Failures** — row number, employee id, and every reason.
3. Read the preview. **It is the safety rail.**
4. **Commit** — a separate, deliberate click.

### What commit does

- Mints one `batchId` for the whole request and stamps it on **every** audit row that
  request produces, so `WHERE batch_id = ?` reviews the import as a unit.
- Runs **one transaction per row**, not one for the batch: a row that fails mid-write
  (a race against the preview's earlier reads — someone else took the same email a
  moment later) rolls back only that row. Every other row's commit is untouched.
- Reports `created`, `updated`, `unchanged`, `failed`, plus every failure reason.

**`unchanged` is counted separately from `updated`.** A row that matched an existing
user but resolved to a field-for-field identical record writes no audit row and enqueues
no sync event. Re-running an unchanged file is a genuine no-op, not a full round of
churn.

### Limits

| Limit | Default | Behaviour |
|---|---|---|
| Rows per request | 1,000 (`IMPORT_MAX_ROWS`) | Whole-request 400 **before any row is resolved** — never a truncated partial apply |
| Body size | 10 MiB (`BODY_LIMIT_BYTES`) | 413 |

A missing required **column** fails the whole request too — a column that is absent can
never produce a valid row, so it is structural rather than per-row noise.

### Preview is audited

`POST /imports/preview` writes exactly one audit row per invocation — actor, row count,
timestamp. Preview performs unscoped existence lookups, so without this an actor scoped
to one org unit could silently probe email/username/employee-id existence across the
whole directory. One row per invocation, never per candidate row: `audit_log` is
append-only, and per-row logging would itself be an amplified write.

---

## Walkthrough 8 — Investigate a failed sync

You noticed a **Sync: failed** badge, or someone reports access that never appeared.

1. **Audit → Dead letters** (requires a **global** grant of `audit:read`).
2. Filter by target.
3. Each row shows the aggregate, the target, the attempt count, and `lastError` — the
   raw error text from the target.

**Requires a global `audit:read` grant, not a scoped one.** An outbox event has no org
unit, and `lastError` carries raw target error text. A scope-narrowed view would be
silently partial — worse than no view, because its reader could not tell.

### Resolving it

Dead letters are not retried over HTTP. Fix the cause, then run reconciliation:

```bash
# Keycloak drift
pnpm --filter @idm/api reconcile

# One connector target — dry run FIRST, it is the default
pnpm --filter @idm/api target-reconcile active_directory
pnpm --filter @idm/api target-reconcile active_directory --apply
```

Or from the console: **Connectors → *target* → Dry run**.

Common causes: a `MissingSecretError` (the named `CONNECTOR_*` variable is unset or
empty), a credential that expired, a target unreachable, or a `ForbiddenSecretNameError`
(the configured secret name is outside the `CONNECTOR_*` namespace).

---

## Walkthrough 9 — Read the audit log

**Audit → Log.** Requires a **global** grant of `audit:read`, for the same reason as
dead letters: `audit_log` has no org unit to narrow by, and a `role_assignment` or
membership snapshot names principals from other org units even when the resource itself
sits inside your scope.

Filters: actor, action, resource type, resource id, batch id, and a date range (day
boundaries in UTC — `to=2026-08-04` includes everything on the 4th).

Each row expands to a `before`/`after` diff. Snapshots name their fields explicitly —
never a spread — so a column added later cannot silently leak into an append-only log.

Actions you will see include `user:create`, `user:update`, `user:self_update`,
`user:activate`, `user:deactivate`, `group:*`, `org_unit:create`, `role:assign`,
`import:preview`, `connector_target:configure`, `connector_target:reconcile`,
`attribute_target_mapping:*`.

`user:self_update` is deliberately distinct from `user:update`, so a review can tell
"the user changed their own profile" from "an administrator changed it for them" at a
glance.

System-originated actions (the lifecycle job, rule applications) have a null actor.

---

## Walkthrough 10 — Configure a connector target

**Needs:** a **global** grant of `connector:manage`. Only `super_admin` holds it.

1. **Connectors** — every target with its health status.

   | Status | Meaning |
   |---|---|
   | `not_configured` | No row yet. No live check attempted. |
   | `disabled` | Configured but off. No live check attempted. |
   | `failing` | Live check failed. `healthDetail` says why. |
   | `never_synced` | Live check passed, but nothing has ever synced successfully. |
   | `healthy` | Live check passed **and** there is a proven track record. |

   "Configured but never successfully synced" must not read as healthy — hence five
   states rather than three.

2. Open the target → **Configuration**.
3. Fill in the non-secret settings and the **credential environment variable name**.

   > That field is a plain text input, never masked, and it is never pre-filled with a
   > value. Nothing stores a secret here to show. `config` holds the **name** of an
   > environment variable, resolved server-side at sync time. A masked box would be a
   > lie about the architecture.

4. Set the blast-radius **threshold** (percent, 1–100, default 20) and **floor**
   (absolute, default 5). A run halts only when **both** are exceeded.
5. Save. A `PATCH` **merges** config, so a key this form does not know about is never
   destroyed.
6. **Dry run** tab → run it. Nothing is written anywhere. Read the plan.
7. Only then **enable** the target.

**Configure, dry-run, then enable — in that order.** Enabling first means the next
mutation fans out to a target you have not proven you can reach.

### Attribute mappings

**Connectors → Attribute mappings.** Nothing propagates without a row here.

Each row maps **one field** to **one target** under a chosen remote name. The field is
either a custom attribute definition or one of four core profile fields (`given_name`,
`surname`, `title`, `department`).

Absence of a row is the default-deny. `enabled` lets you turn a mapping off without
losing it; delete removes it outright.

Editing a row changes only `enabled` and `remoteName` — never which field or target it
governs. Change those by deleting and recreating, so the audit trail shows two distinct
facts rather than one row quietly meaning something else.

---

## Walkthrough 11 — Self-service (`/self`)

Every authenticated, **active** user can reach **My Profile**, whatever roles they hold
— including none at all.

They see their profile, their **direct** and **effective** groups (visually distinct),
and a link out to Keycloak's Account Console for password and MFA.

They may edit **`location`**, plus any custom attribute whose definition has
`self_editable = true`. Everything else is rejected by name with a 400 — never silently
dropped.

Two properties worth knowing:

- **No user id appears anywhere in `/self`.** No route declares one, no body schema
  accepts one, no handler reads a query parameter. The only source of "which user" is
  the verified JWT. IDOR is impossible by construction, not by a check that could be
  forgotten on a future route.
- **A `/self` attribute edit merges** rather than replacing, and reads the current row
  with `SELECT ... FOR UPDATE`. Without that, two concurrent edits could both merge onto
  the same stale snapshot and the later commit would silently overwrite the earlier one
  — measured 30 times out of 30 before it was fixed.

A deactivated or suspended user gets 403 on every `/self` route.

---

## What the console cannot do yet

These exist in the data model or the API but have no console surface:

- **Create or edit attribute definitions** — no write endpoint at all; database only.
- **Create or edit JML rules** — database rows plus the `jml:lifecycle` CLI.
- **Business roles** — schema only; no engine, API or UI yet. See [14 — Roadmap](14-roadmap.md).
- **Move a person between org units**, rename an org unit, or delete anything.
- **Retry a dead letter** — reconciliation is the retry path.
