# 07 — Admin guide

How to do the job in the console. Every action here is also available over HTTP —
see [10 — API reference](10-api-reference.md).

> **The console calls the product Keystone.** `apps/web/src/brand/index.tsx` is the single
> source of truth for that name, so the sign-in gate and the browser tab read "Keystone"
> while these chapters say "Identity Manager". The brand is a UI layer only — see
> [Brand](brand.md). Screen names, buttons and nav labels below are quoted as the console
> actually shows them.

## The shell

| Region | Contents |
|---|---|
| **Top bar** (48px) | Brand lockup (links to People) · global search over people (`⌘K` / `Ctrl-K`) · theme toggle · **Approvals** · **My Profile** · signed-in identity · Sign out |
| **Left nav** (240px) | Three named groups — Directory, Access, Operations |
| **Content** | max-width 1440px |

The nav collapses to an icon rail at 1099px and below, and behind a `<dialog>` disclosure
at 779px and below.

**Approvals and My Profile sit in the top bar, not the left nav, on purpose.** Both belong
to every authenticated user — an ordinary manager deciding a direct report's access
request holds no admin permission at all — so neither can be gated by
`GET /self/permissions`. An employee who manages nobody simply sees an empty inbox.

**Left-nav items you cannot use are not shown.** Visibility is driven by `GET
/self/permissions`, which returns the caller's own effective actions. A group whose every
item is filtered out renders nothing at all — no empty heading advertising links you
cannot follow.

| Group | Nav item | Requires |
|---|---|---|
| Directory | People | `user:read` |
| Directory | Groups | `group:read` |
| Directory | Org units | `org_unit:read` |
| Access | Admin roles | `role:assign` |
| Access | Business roles | `business_role:read` |
| Access | Recertification | *nothing — visible to every authenticated user* |
| Access | Applications | `sso_app:read` |
| Operations | Import | `user:create` |
| Operations | Audit | `audit:read` |
| Operations | Connectors | `connector:read` |
| Operations | Data flows | `connector:read` |
| Operations | HR sources | `connector:read` |
| Operations | Organizations | `organization:read` |

**Recertification is the one ungated item.** Its "My reviews" queue must reach the
managers a campaign resolved as reviewers, and those are ordinary people holding no role
in the catalog. The campaigns half of that page gates itself on `recert:read` internally.

**"Admin roles", not "Roles".** The nav label was changed once Business roles existed;
the path is still `/roles` and the page is still the static administrative-role catalog.

The UI hides what you cannot do; it never *decides* it. Every action is still enforced
server-side, and reaching a hidden route by typing its URL shows an explanatory panel
rather than a bare 403 or a silent empty screen.

> **A visible control is not a promise the write will succeed.** `GET /self/permissions`
> reports the *action*, not its scope. Several areas — business roles, SSO applications,
> HR sources, dead letters, the audit log — additionally require the grant to be
> **global**, and the API refuses a scoped holder with a message that says exactly that.

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
| **Sync pending** | A change is queued and not yet delivered. |
| **Synced** | Everything queued for this person has landed. |
| **Sync failed** | Something dead-lettered. **Go and look** — the badge is a button; it opens the person's own Sync tab, and from there see [Dead letters](#walkthrough-8--investigate-a-failed-sync). |

---

## Walkthrough 1 — Find a person

The People list is the landing page, because that is the job.

1. Type into **Search** — matches name, username or email, debounced, and reflected in
   the URL so the result is linkable and survives a reload.
2. Narrow with **Status**. The default is *All except deactivated*: leavers do not
   clutter everyday work, but are one selection away.
3. Narrow with **Org unit**.
4. Click a row to open the person.

The list is paginated (50 per page; the API's own maximum is 100). Both the rows **and
the total** are filtered to your scope — a scoped operator never sees a count that implies
records they cannot open.

`⌘K` / `Ctrl-K` focuses global search from anywhere. It searches people.

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

### The person detail page

Six tabs, in this order:

| Tab | What | Gated on |
|---|---|---|
| **Profile** | The record, plus custom attributes | — |
| **Groups** | Direct memberships, with a *Global* badge on groups that have no org unit | — |
| **Roles** | Administrative role grants — see [Walkthrough 6](#walkthrough-6--grant-and-revoke-administrative-roles) | `role:assign` |
| **Entitlements** | Everything they hold and **why** — see [Walkthrough 15](#walkthrough-15--answer-why-does-this-person-have-this) | — (`user:read` is enough) |
| **Sync** | One row per enabled connector target: state, external id, attempts, next retry, error | — |
| **Activity** | This person's audit history | `audit:read` |

Header actions are **Edit** (`user:update`), **Activate** (`user:activate`, and only when
the status is *pending* or *suspended*) and **Deactivate** (`user:deactivate`, and only
when they are not already deactivated).

### What happens next

- An `audit_log` row is written in the same transaction as the user row.
- An `outbox_events` row is written per enabled target **for that person's organization**,
  in that same transaction.
- The sync worker picks it up and asserts the user into each target. `syncState` moves
  from `pending` to `synced`.

### Activating them

A pending person exists in the directory but is **disabled everywhere downstream** —
every connector derives its enabled flag from `status = 'active'`. Two ways to move them:

- **Activate them directly.** On the person's detail page, click **Activate**. The
  confirmation says what it does: sign-in is enabled in Keycloak and in every connected
  directory *once the change syncs — not instantly*. This is the right move for someone
  who is already here, or who was created without a start date.
- **Set a start date.** When `jml:lifecycle` next runs on or after that date, the user
  transitions `pending → active` automatically, and any `start_date_reached` rules fire
  once. This is the right move for a future joiner.

**Needs:** `user:activate` covering the person's org unit, and you must outrank them.
`help_desk` does not hold it — its whole set is `user:read`, `user:update`, `group:read`,
`org_unit:read`. Enabling an account is a different kind of act from editing one.

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
2. **Deactivate**. Confirm the dialog — it names the person and says what will happen:
   sign-in is blocked immediately and active sessions are revoked, and *deactivation is
   permanent; they cannot be reactivated from this console*.
3. A toast reports the result, including the resulting sync state.

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

**A move can change access on its own.** If a published business role's formula names
`Job title`, `Location` or `Org unit`, editing that field is what makes the person start
or stop matching it. See [Walkthrough 13](#walkthrough-13--publish-a-business-role).

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
2. **Grant a role** → pick the role and the scope (an org unit, or *Global — every org
   unit*). The scope selector offers only what your own holding covers, and resets when
   you change the role so the choice is always explicit.
3. To revoke, use the row's **Revoke** action and confirm.

### The four checks, all required

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

The **Admin roles** page in the left nav shows the static catalog: which of the five
roles grants which of the 24 actions. See [08 — Authorization model](08-authorization.md).

**These are not business roles.** An administrative role says what you may *do in this
console*; a business role says what *access an employee gets* — see
[Walkthrough 13](#walkthrough-13--publish-a-business-role).

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

1. **Import** → choose a **CSV file**. It is a file picker; there is no paste box. The
   page pre-checks the file before anything is sent — over 10 MiB, or an estimated row
   count over `IMPORT_MAX_ROWS`, and it tells you to split the file rather than making
   you wait for a 400.
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

**A pull-based feed goes through the same pipeline.** See
[Walkthrough 19](#walkthrough-19--connect-an-hr-feed).

---

## Walkthrough 8 — Investigate a failed sync

You noticed a **Sync failed** badge, or someone reports access that never appeared.

Two places to look, in this order:

1. **The person's own Sync tab.** Click the sync badge on their detail page. One row per
   enabled target — target, state, external id, last synced, attempts, next retry, and
   the error. It also lists **Blocked by group**: groups with an unsettled sync of their
   own, which is why a person's badge can be red while every one of their own targets is
   healthy. A dead letter shows no next-retry time, because nothing is coming.
2. **Audit → Dead letters** (requires a **global** grant of `audit:read`) for the
   estate-wide view. Filter by target. Each row shows the aggregate, the target, the
   attempt count, and `lastError` — the raw error text from the target.

**Dead letters require a global `audit:read` grant, not a scoped one.** An outbox event
has no org unit, and `lastError` carries raw target error text. A scope-narrowed view
would be silently partial — worse than no view, because its reader could not tell.

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

If the failing thing is a *business-role* grant rather than a target write, the person's
Entitlements tab will say so — see
[Walkthrough 15](#walkthrough-15--answer-why-does-this-person-have-this).

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

Actions you will see include:

| Area | Actions |
|---|---|
| People | `user:create`, `user:update`, `user:self_update`, `user:activate`, `user:deactivate`, `user:bulk_activate` |
| Groups and org units | `group:create`, `group:update`, `group:add_member`, `group:remove_member`, `group:add_child_group`, `group:remove_child_group`, `org_unit:create` |
| Admin roles | `role:assign`, `role:revoke` |
| Business roles | `business_role:create`, `business_role:update`, `business_role:draft`, `business_role:simulate`, `business_role:publish`, `business_role:exception_set`, `business_role:exception_clear`, `business_role:requestable_set`, `business_role:conflict_create`, `business_role:conflict_update` |
| Access requests | `access_request:create`, `access_request:approve`, `access_request:deny`, `access_request:cancel` |
| Recertification | `recert_campaign:create`, `recert_campaign:open`, `recert_campaign:close`, `recert_item:decide` |
| Connectors and sync | `connector_target:configure`, `connector_target:reconcile`, `attribute_target_mapping:create`, `attribute_target_mapping:update`, `attribute_target_mapping:delete`, `reconciliation:repair` |
| SSO applications | `sso_app:create`, `sso_app:update`, `sso_app:enable`, `sso_app:disable`, `sso_app:mint_secret` |
| Inbound | `import:preview`, `hr_source:create`, `hr_source:update`, `hr_source:sync` |
| Tenants | `organization:create`, `organization:update` |
| Lifecycle (system) | `jml:lifecycle_activate`, `jml:lifecycle_deactivate`, `jml:deactivate`, `jml:set_attribute` |

`user:self_update` is deliberately distinct from `user:update`, so a review can tell
"the user changed their own profile" from "an administrator changed it for them" at a
glance.

System-originated actions (the lifecycle job, rule applications) have a null actor.

---

## Walkthrough 10 — Configure a connector target

**Needs:** a **global** grant of `connector:manage`. Only `super_admin` holds it.
`connector:read` (super_admin and auditor) is enough to look.

1. **Connectors** — two tabs, **Targets** and **Attribute mappings**.
2. On **Targets**, first check the **Organization** selector at the top of the page.
   Connector targets are keyed by *(organization, target)*: everything below —
   configuration, health, dead letters, dry run — describes **one tenant at a time**.
   Omitting a selection means the master organization. Without `organization:read` the
   control degrades to a fixed "Master" label rather than a picker that cannot do
   anything.
3. Read the health of each target.

   | Status | Meaning |
   |---|---|
   | `Not configured` | No row yet. No live check attempted. |
   | `Disabled` | Configured but off. No live check attempted. |
   | `Failing` | Live check failed. `healthDetail` says why. |
   | `Never synced` | Live check passed, but nothing has ever synced successfully. |
   | `Healthy` | Live check passed **and** there is a proven track record. |

   "Configured but never successfully synced" must not read as healthy — hence five
   states rather than three. `Never synced` and `Failing` carry colour; the other three,
   including `Healthy`, do not.

4. Open the target → **Configuration**.
5. Fill in the non-secret settings and the **credential environment variable name**.

   > That field is a plain text input, never masked, and it is never pre-filled with a
   > value. Nothing stores a secret here to show. `config` holds the **name** of an
   > environment variable, resolved server-side at sync time. A masked box would be a
   > lie about the architecture.

6. Set the **Blast-radius guard**: **Threshold (%)** (a whole number 1–100, default 20)
   and **Floor (absolute count)** (default 5). A run halts only when **both** are
   exceeded.
7. **Save configuration.** A `PATCH` **merges** config, so a key this form does not know
   about is never destroyed.
8. **Dry run** tab → run it. Nothing is written anywhere. Read the plan.
9. Only then **enable** the target.

**Configure, dry-run, then enable — in that order.** Enabling first means the next
mutation fans out to a target you have not proven you can reach.

### Attribute mappings

**Connectors → Attribute mappings.** Nothing propagates without a row here.

It is a matrix: one row per **field**, one column per **target that carries users**, one
cell per pair. That is 12 of the 13 targets — `keycloak_sso` registers applications, not
people, so it has no user attributes to map and gets no column. The fields are the four
core profile fields — Given name, Surname, Title, Department (current org unit) —
followed by every active custom user attribute definition. A cell holds the remote name
the field is written under on that target.

Absence of a cell is the default-deny, and the empty cell is what makes that legible.
`enabled` lets you turn a mapping off without losing it; delete removes it outright.

Editing a mapping changes only `enabled` and `remoteName` — never which field or target
it governs. Change those by deleting and recreating, so the audit trail shows two
distinct facts rather than one row quietly meaning something else.

---

## Walkthrough 11 — Self-service (`/self`)

Every authenticated, **active** user can reach **My Profile** from the top bar, whatever
roles they hold — including none at all.

Five sections: **Profile**, **Credentials**, **Request access**, **Groups**, **Edit
profile**.

- **Credentials** is a link out to Keycloak's own Account Console (*Manage password &
  MFA*). Password and MFA are never handled here; there is no password input anywhere in
  the console, and `no-password-input.spec.ts` scans the source to prove it.
- **Groups** lists effective membership, each row badged **Direct** or **Inherited**.
- **Edit profile** renders exactly the fields `GET /self` advertises as editable — today
  `location` plus any custom attribute whose definition has `self_editable = true`.
  Nothing is hard-coded in the form. Everything else is rejected by name with a 400 —
  never silently dropped.
- **Request access** is the self-service catalogue — see
  [Walkthrough 17](#walkthrough-17--request-and-approve-access).

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

## Walkthrough 12 — Create and suspend an organization

An **organization** is a tenant: its own root org unit, its own people and groups, and
its own Keycloak realm. Creating one is a platform-operator act — `organization:read`,
`:create` and `:update` are held by `super_admin` alone, and all three require a
**global** grant.

**Before you start**, the deployment needs a realm-provisioning credential
(`KEYCLOAK_PROVISION_CLIENT_ID` / `_SECRET` — see
[06 — Configuration](06-configuration.md#realm-provisioning-required-only-to-create-organizations)).
Without it the console answers *"creating an organization requires
KEYCLOAK_PROVISION_CLIENT_ID and KEYCLOAK_PROVISION_CLIENT_SECRET, which are not
configured"* and writes nothing — deliberately, rather than accepting a tenant whose
realm could never be created.

### Create

1. **Operations → Organizations → New organization.**
2. **Name** — the human name, e.g. `Acme Corp`.
3. **Slug** — derived from the name (`acme-corp`) but **editable, and worth editing**.
   The slug becomes the Keycloak realm name, permanently: it appears in the issuer URL
   every person in this tenant authenticates against, and **there is no rename**.
   Lower-case letters, digits and hyphens only. Once you edit the slug by hand, further
   typing in Name stops overwriting it.
4. **Create.**

The row appears immediately, showing **Provisioning**. That is honest rather than
cosmetic: the organization exists in Postgres, the realm does not exist yet. The sync
worker drains the `organization` event within a second or two, creates the realm, and
the badge becomes **Active** — the page re-checks on its own a few seconds later.

The table is Name · Slug · Realm · State · Targets, with one action. Master is labelled
`· platform`. There is no per-organization detail page: a tenant has four facts and they
all fit in the row.

### What happens, in order

1. In **one transaction**: the `organizations` row, its single root org unit, an enabled
   `keycloak` connector-target row of its own, an audit row (`organization:create`) and
   one `organization` outbox event.
2. The sync worker claims that event, calls Keycloak's server-level realm API, sets the
   realm enabled, and stamps `realm_provisioned_at`.
3. Any person you create in the new organization before step 2 finishes is **deferred**,
   not failed: their event stays `pending` with `attempts` still at 0 and
   `last_error` reading *"waiting on realm provisioning for organization acme"*. It
   converges on its own once the realm lands. Waiting on a prerequisite never spends the
   dead-letter budget.

### Which targets a tenant reaches

A tenant fans out to **whichever targets its own catalogue enables**. `connector_targets`
is keyed by *(organization, target)*, and the outbox writer reads only the rows belonging
to the aggregate's own organization — it never falls back to another organization's
configuration, because that would create real accounts inside a different tenant's
directory.

A freshly provisioned tenant therefore starts at **Keycloak only**, because
`POST /organizations` seeds exactly that one row. It is a starting point, not a ceiling:
select the tenant in the Connectors page's **Organization** selector and configure any
other target for it.

> **The Organizations table's `Targets` column has not caught up.** It renders a fixed
> string — *All enabled targets* for master, *Keycloak only* for every tenant — derived
> from `isMaster` alone rather than from that tenant's actual catalogue. It was accurate
> when the rule was hard-coded and is now stale for any tenant that has been given a
> second target. Read the Connectors page, scoped to the tenant, for the truth.

### Suspend

**Suspend** on the row (hidden entirely for master). This disables the tenant's realm:
nobody in it can sign in, and every session ends. It does **not** delete anything — the
realm, its users, its clients and its credentials are all still there, and
**Reactivate** puts it back.

There is no delete, here or anywhere in this product. Deleting a realm destroys every
credential inside it irreversibly, which is the same reason a terminated person is
`deactivated` rather than removed.

**Master carries no Suspend control at all** — not a disabled one, none. Suspending
master would disable the realm every administrator signs in through, including whoever
clicked it, with no API path back in because there would be no way to authenticate to
call it. The API refuses it independently with a 409, and so does the connector.

---

## Walkthrough 13 — Publish a business role

A **business role** is a formula — *"everyone whose job title is Account Executive"* —
paired with what those people get. Joiners pick it up on their first day; movers lose it
the moment the formula stops describing them.

**Needs:** `business_role:read` to look (`user_admin`, `auditor`, `read_only` and
`super_admin` hold it). Every control that changes anything needs `business_role:manage`,
which is `super_admin`'s alone **and must be a global grant** — a business role belongs
to no org unit, so a scoped grant has nothing to narrow to.

### The gate: draft → simulate → publish

This sequence is the whole design, and the API enforces it inside the publishing
transaction regardless of what the screen shows.

1. **Access → Business roles → New business role.** Name, optional description. It is
   created **disabled with no formula**, so creating it changes nobody's access.
2. On the role's **Definition** tab, build the formula:
   - **Conditions** — a field, an operator, a value. Fields are Job title, Location,
     Account status and Org unit, plus any custom attribute as `attributes.<key>`.
     Operators are *is*, *is not*, *is one of* and *is at or below* (org-unit subtree).
     **A role with zero conditions matches nobody** — the deliberate opposite of the
     naive "every condition matched" fold, which would have granted an unfinished role to
     the entire directory.
   - **Grants** — either a group membership or an account on a connector target.
3. **Save draft.** Nobody's access changes, and saving **clears any recorded
   simulation**, so "simulated" always means "simulated as it stands now".
4. **Simulate.** Nothing is committed, but the run *is* recorded. You get the true totals
   across the directory — how many people would gain, how many would lose — with capped,
   named samples and an explicit truncation marker.
5. **Publish.** Available only when a draft exists **and** the recorded simulation belongs
   to that exact draft, with no unsaved edits in the editor. The header states which of
   the three states the role is in, in words, and a disabled Publish button always says
   why.

Publishing reconciles everyone it touches and the toast reports how many people moved.

### Enable and disable

A role can be fully drafted, simulated and published while **disabled** — none of it
takes effect until the role is enabled.

- **Enable** grants immediately, and the toast says how many people gained what it grants.
- **Disable is a revocation, not a pause.** The sweep runs as part of the action;
  everyone currently held by the role loses every grant it makes. Anything they hold from
  another role, or that was granted by hand, is untouched — a role only ever revokes what
  it made.

### Exceptions

The **Exceptions** tab overrides the formula for one person: **include** them though the
formula does not describe them, or **exclude** them though it does. Columns are Person,
Mode, Reason, Set by, Expires.

**The reason is mandatory** — `NOT NULL` in the database and required on every write.
An unexplained exception is precisely what a later recertification campaign cannot act
on. An expiry is optional; blank means never.

### The Members tab is honest about not existing

There is no "who holds this role" list, and the tab says so rather than inventing one:
membership is derived, recomputed per person by the reconciler, and never materialised as
a role-keyed list. To see who a role *would* hold, simulate it. To see why one person
holds something, open their Entitlements tab.

---

## Walkthrough 14 — Segregation of duties

A **conflict** is a statement about a *pair* of business roles: no one person may hold
both. It lives at the bottom of the **Business roles** page rather than on either role's
detail page, because it belongs to neither of the two more than the other.

**Needs:** `business_role:read` to see it, `business_role:manage` to define or retire one.

### Define a conflict

Pick two different roles and write the **reason** — a later audit acts on that sentence,
so it is required. Defining a conflict changes nobody's access. It does two things:

- **Preventive.** A publish whose simulation would put anyone in both roles of an enabled
  pair is **refused** with a 409, and the simulation panel already shows exactly who and
  why. The count is recorded server-side beside the draft hash, so the refusal is not a
  race.
- **Detective.** Anyone *already* holding both appears under **standing violations**,
  with each side labelled *by formula* or *by include-exception*.

### Nothing is auto-revoked

The violations list is a report. Which of a person's two holdings is the wrong one is a
judgement this product refuses to automate, so it names the person, the pair, the reason
and how each side is held — and stops there.

### Retiring one

A conflict pair is stored in canonical order and is immutable. It is never deleted, only
**retired**: the badge moves from **Enforced** to **Retired**, and nothing is revoked —
a control simply stopped being applied.

---

## Walkthrough 15 — Answer "why does this person have this?"

Open the person → **Entitlements** tab. One table, everything they hold:

| Column | What |
|---|---|
| **Entitlement** | The group (linked) or *"<Target> account"* |
| **Kind** | `Group` or `Target account` |
| **Source** | `Role-derived` or `Granted by hand` |
| **Since** | When it was granted |
| **Justified by** | The business roles that justify it, each linked |

Neither Source value takes colour — neither is an exception. The words differ because the
consequences do: a role-derived row lasts as long as a role justifies it; a row granted by
hand is theirs until somebody takes it away, and no role will.

Three answers in **Justified by** are worth recognising:

- **A list of role names** — normal.
- **"No role behind it"** on a hand-granted row, naming who granted it where that is
  known.
- **"Nothing justifies this"** (carrying colour) on a *role-derived* row — the reconciler
  will remove it on its next pass.
- **"Unknown — not evaluated"** — the role engine could not evaluate one of the roles, so
  nothing on the screen can be attributed. A banner above the table names the role and the
  reason. **This is not the same as "no role justifies this"**, and the tab is careful to
  say so: while a role is unevaluable, reconciliation is refusing for this person, so
  nothing is being added or revoked either.

The tab is read-only, and it never fails closed — a role-engine refusal comes back as a
200 with the rows intact plus the marker, because this is the screen someone opens
*because* something is already wrong.

Needs nothing beyond `user:read`: anyone who can open the person can read this tab.

---

## Walkthrough 16 — Run a recertification campaign

A campaign freezes a review set and asks the right people to certify or revoke each piece
of it.

**Access → Recertification.** Two audiences on one page.

### My reviews (everybody)

Not permission-gated, and first on the page: a reviewer is usually an ordinary manager
holding no role at all. Columns are Campaign, Access under review, Why it was granted,
Due, Decision.

Two buttons per row:

- **Certify** — records an attestation. Nothing about the access changes.
- **Revoke** on an include-exception, or **Flag for revocation** on a formula item. The
  labels differ because the consequences do (see below).

No comment is collected in the console today; the decision is one click.

### Campaigns (`recert:read`)

Columns are Name, Status, Progress, Reviewed by, Due. Creating one needs
`recert:manage` — `super_admin`'s alone — and takes three fields: **Name**, **Reviewed
by** (*Manager of each person* or *Campaign owner*) and an optional **Due date**.

A campaign is created as a **Draft** covering **every enabled business role**; there is
no scope picker in the console. Nobody sees anything until you open it.

| Status | Meaning |
|---|---|
| **Draft** | No review set yet. Asks nothing of anyone. |
| **Open** | Snapshotted and assigned. The only state with outstanding work. |
| **Closed** | Terminal. |

- **Open — snapshot & assign reviews** freezes the review set from current membership and
  exception state in one server-side transaction — one item per enabled role's formula,
  one item per include-exception per person — and assigns each to its reviewer.
- **Close — permanent** is terminal and **revokes nothing**. Undecided items stay recorded
  as never reviewed, and a closed campaign cannot reopen.

### What a decision actually does

Revocation happens at decision time, per item, and **only for exceptions**:

- Certifying records the attestation and changes nothing.
- Revoking an **include-exception** expires it, and the engine revokes what that exception
  granted. Hand-added memberships are untouched.
- Revoking a **formula** item records a *finding* and revokes nothing at all. Formula
  access changes in one place only: edit the role, simulate, publish — behind the gate in
  [Walkthrough 13](#walkthrough-13--publish-a-business-role).

Nobody decides an item about their own access — the API enforces that against admins too.

---

## Walkthrough 17 — Request and approve access

The requester's side lives in **My Profile → Request access**; the approver's side is the
**Approvals** link in the top bar. Both are reachable by every authenticated user and
neither is permission-gated — the API resolves who may decide, and an empty inbox is a
valid state.

### Asking for access

The catalogue lists business roles that are **requestable and enabled** in your
organization. Each row offers **Request**, which opens a small form:

- **Justification (required)** — it becomes the approval's exception reason verbatim, so
  write it for the person who will read it later in a recertification campaign.
- **Access until (optional)** — a date, converted to end-of-day UTC.

**Submit request.** The row's button is replaced by a **Requested** badge while it is
pending. **My requests** below lists your own, badged **Pending**, **Approved**, **Denied**
or **Cancelled**, with the approver's comment where one was left. You may **Cancel** your
own request while it is pending.

### Deciding

**Approvals → Waiting on you** shows *requester → role*, when it was asked for, any
requested expiry, and the justification in full. Each row has an optional comment field
and two buttons: **Approve** and **Deny**. There is no confirmation step.

Approval is applied in the same transaction as the decision. It writes a business-role
**include exception** carrying the request id and justification as its mandatory reason
and the requested expiry as its expiry, then re-reconciles the subject inline. It
deliberately does **not** write a group membership: the grant carries provenance, it
expires with the exception, and a recertification campaign can act on it.

Requests are never deleted; they end in a terminal state. **Nobody decides their own
request** — checked before everything else, so not even a global admin can approve what
they asked for.

---

## Walkthrough 18 — Register an SSO application

**Access → Applications** registers an OIDC or SAML 2.0 client that this system masters
and asserts into Keycloak.

**Needs:** `sso_app:read` to see the nav item at all — `super_admin`'s alone, not the
auditor's. Every write needs `sso_app:manage`, and the API requires **both** to be global
grants, because an application belongs to no org unit.

The list is Name · Client ID · Type · Status, where Type reads *SAML 2.0*,
*Public (PKCE)* or *Confidential*.

### Register

**Register application** → choose the **Protocol** first. It cannot be changed later —
switching protocol is a new application — and neither can the client id or entity id,
because the application hard-codes it in its own configuration.

| OIDC | SAML 2.0 |
|---|---|
| **Client ID** (required) | **Entity ID** (required) — the SP's entity id, an `https` URL or `urn:` |
| **Redirect URIs** (required, one per line) — a wildcard is allowed **only in the path** | **ACS URLs** (required, one per line) — `https` only (`http` for localhost), **no wildcards**; the first is the primary POST endpoint |
| **Web origins** (optional, scheme and host only; `+` mirrors the redirect URIs) | **NameID format** — Email, Persistent or Username |
| **Public client** — for apps that cannot keep a secret. **PKCE is always enforced and is not optional** | **Sign assertions** — signs each assertion individually; the response document is always signed |
| | **SP signing certificate** (optional) — supplying one *requires* the SP to sign its requests. Never paste a private key |

Both take **Name**, **Description** and **Include group membership** (on by default),
which adds a `groups` claim to the token or a `groups` attribute statement to the
assertion, carrying bare group names.

The form does no client-side validation: every refusal comes from the API and is shown
verbatim, because the API's message names the offending value — which is what you need
when you have pasted twelve URIs.

### The client secret is shown once

**Generate client secret** appears only for a confidential OIDC client — not for a public
client (PKCE replaces the secret) and not for SAML (SPs authenticate assertions by
signature). The dialog says it plainly: *"This will not be shown again."* The value is
never stored, so no endpoint can return it and there is no reveal affordance anywhere.
Generating a new secret replaces the old one, which stops working immediately.

### SAML: what to give the other side

A SAML application's detail page carries an **Identity provider details** section — the
IdP entity id, the SSO endpoint URL, and a link to download the IdP metadata descriptor
(XML), which is also where the signing certificate comes from. One source for it, not two.

### What this page does not do

- **No edit.** Register, view, enable/disable, mint a secret. Nothing on the detail page
  can be changed afterwards.
- **No delete.** The API exposes no delete route; **Disable** is the off switch, and it is
  a separately audited verb rather than a PATCH field.
- **No access assignment.** There is no group or person picker here. *Include group
  membership* controls what rides in the token, not who may sign in.

---

## Walkthrough 19 — Connect an HR feed

**Operations → HR sources** configures pull-based feeds that this system fetches and runs
through the same preview-then-commit pipeline as a CSV upload. Nothing pushes in.

**Needs:** `connector:read` to see it; every mutating control needs `connector:manage`,
and the API additionally requires that grant to be **global** — which no on-screen text
says, so an org-scoped holder sees enabled buttons and discovers the refusal as an error.

### Create a source

**New HR source** takes: **Organization**, **Name**, **Kind**, **Feed URL**, an optional
**Auth header name** / **Secret name** pair, and a **Column mapping**.

- **Kind** is *CSV over HTTPS* or *REST / JSON API*, and is **fixed once created** — a
  configuration validated for one kind means nothing for the other. A REST/JSON source
  additionally takes a **Records path** and a pagination mode (*None*, *Page number*, or
  *Cursor / next link*) with the parameter names that go with it. A CSV source takes no
  further configuration at all.
- **The feed URL must be `https://`.** A plain-HTTP feed would carry people data in
  cleartext, and the form refuses it.
- **The credential is never stored or shown here.** You name the HTTP header to send and
  the `CONNECTOR_*` environment variable set on the API host; the value is resolved there
  at fetch time. The input is a plain text box naming a variable — set both fields or
  neither.
- **The column mapping is an allowlist.** Feed columns become import columns; **unmapped
  feed columns are dropped**. That is the point: this list is what crosses into the
  directory.

A new source starts **disabled**. Preview it first, then enable it.

### Preview, and where the commit lives

**Run preview now** is the only run this page performs. It reports the row counts
(*total / to create / to update / failing*), the **blast radius** against the existing
population with the configured threshold and floor — saying outright when it *would refuse
to commit* — and a failures table of row number, employee id and every reason.

**There is no commit button, and no schedule.** A run that writes people goes through the
`hr:sync` CLI (`--commit`), where dry-run is the default and the operator owns the
cadence. See [11 — Operations](11-operations.md).

**Run history** shows When · Outcome · Counts · Batch. The outcomes are *Previewed*,
*Committed*, *Committed (partial)*, *Aborted: failing rows*, *Aborted: blast radius*,
*Fetch failed*, *Preview failed*, and *Never run*.

A disabled source can still be previewed but refuses to commit. **There is no delete —
disable instead.**

---

## Walkthrough 20 — See the whole estate at once

**Operations → Data flows** answers the question the Connectors page does not: *what
leaves this system, and to whom.* Read-only, `connector:read`, scoped by the same
**Organization** selector.

Three columns: **Sources** (the HR feeds this system pulls from) → **Identity Manager**
(the system of record) → **Targets** (everything it pushes to). Each card carries the
attributes that actually ride that edge, disabled mappings included behind a *"N mappings
turned off"* disclosure — *"this used to flow and no longer does"* is exactly what this
screen is for.

An outbound edge reads **Not configured**, **Disabled**, **Enabled, never synced** or
**Live**, plus its population: *All users*, *Only entitled users*, or *Applications, not
people*. Targets that are unconfigured or off are collapsed behind a *"show N targets not
currently receiving data"* toggle — on a fresh install, **twelve of thirteen**, because
migration `0011` seeds exactly one `connector_targets` row (`keycloak`) and no migration
seeds another. The console's own comment in `DataFlowsPage.tsx` still says eleven; that
comment is stale.

**It is deliberately not a health dashboard.** No live reachability check runs here, and a
dormant edge and a broken one look the same on purpose: *"is it working right now"* is the
Connectors page's question, and duplicating it would make the map unavailable exactly when
part of the estate is down.

Inbound cards show the upstream **host**, never the feed URL with its query string.

> **One wording inconsistency to expect.** This page prints a source's last-run outcome as
> the raw value with underscores replaced by spaces (`aborted blast radius`), where the HR
> sources page prints the polished label (*Aborted: blast radius*). Same fact, two spellings.

---

## Walkthrough 21 — Mine roles from what people already have

**Business roles → Mining** (`business_role:manage`) looks for formulas that explain
existing manual group memberships, so a role catalogue can be *discovered* rather than
guessed.

Set **Min precision %** (how exclusive the match must be), **Min coverage %** (how much of
the group it must explain) and optionally **Scope to org unit**, then **Run analysis**.
Running it changes nothing.

Each recommendation is a candidate formula for one group, scored two ways — *precision*
("of the N people the formula matches, this share are members today") and *coverage* ("of
the group's M manual members, this share are matched") — with both residual lists named:
who **would newly gain the group**, and which members the formula **does not** describe.

**Open as draft** creates a **disabled** business role carrying the recommendation as its
draft. It changes nobody's access and still has to walk the same simulate-then-publish
gate as a hand-typed formula.

---

## What the console cannot do yet

These exist in the data model or the API but have no console surface:

- **Create or edit attribute definitions** — `GET /attribute-definitions` is the only
  route; there is no write endpoint at all. Database only.
- **Create or edit JML rules** — database rows plus the `jml:lifecycle` CLI. There is no
  controller.
- **Mark a business role requestable** — `PUT /business-roles/:id/requestable` exists and
  is separately audited, but no screen calls it. Until it is set, the self-service
  catalogue in [Walkthrough 17](#walkthrough-17--request-and-approve-access) has nothing
  to offer.
- **Commit an HR feed** — preview only; the commit is the `hr:sync --commit` CLI, on the
  operator's own cadence. There is no scheduler UI.
- **Edit a registered SSO application** — register, enable, disable and mint a secret;
  nothing else.
- **List a business role's members** — membership is derived per person and never
  materialised. Simulate the role, or read one person's Entitlements tab.
- **Leave a comment on a recertification decision** — the item carries a Comment column
  and the API accepts one, but no screen collects it.
- **Scope a recertification campaign to some roles** — the API accepts `scopeRoleIds`;
  the console always sends every enabled role.
- **Move a person between org units**, rename an org unit, or delete anything — no
  route exists for any of them.
- **Retry a dead letter** — reconciliation is the retry path.
