# 09 — Connectors and sync

## The model

Every mutation writes an **outbox event** in the same transaction as the mutation. A
background **sync worker** claims events and hands each to a **connector** for its
target.

A connector's job is narrow and total: given a fully-resolved desired state, make the
target match it. Connectors never read Postgres. They receive plain data:

```ts
interface DesiredUser {
  userId: string          // OUR user id — for targets that key on it (mail server)
  username: string
  email: string
  firstName: string
  lastName: string
  enabled: boolean        // status === 'active'
  status?: UserStatus     // full lifecycle status, for targets that need all four
  attributes: Record<string, string[]>   // ALREADY filtered to this target's mappings
  groups: readonly string[]              // flattened EFFECTIVE membership, as names
  // ...plus target-gated fields: orgUnitPath, existingExternalId,
  //    managedAttributeRemoteNames
}
```

Three properties carry the design:

- **`attributes` is pre-filtered per target.** A field with no `attribute_target_mappings`
  row for this target never appears — structurally, regardless of what any other target
  receives.
- **`groups` is the flattened effective set**, already resolved from the nested local
  DAG. Each connector maps that onto its own representation.
- **`status` is optional and target-gated.** `enabled` collapses four states into two,
  and for the mail target that is data loss, not lost fidelity: only `deactivated`
  stamps the counterpart's `deactivated_at`, which starts its retention clock. Only
  targets that need the distinction receive it.

### Assert, never replay

The worker never replays an event payload as a delta. It re-reads the current row from
Postgres and asserts **full desired state**. A replayed, duplicated or out-of-order
event therefore converges to the same place.

### Correlate on immutable ids

Each target's correlation lives in `external_identities` / `external_group_identities`,
keyed on the target's own **immutable** id — AD `objectGUID`, Graph `id`, Google `id` —
never a DN, a UPN, an email or a name. All of those move.

Getting this wrong is not a cosmetic bug: a rename would become an orphan plus a new
empty object.

## The targets

| Target | Users | Groups | Correlated by |
|---|---|---|---|
| `keycloak` | ✅ | flattened membership | Keycloak user id |
| `active_directory` | ✅ | ✅ **native nesting** | `objectGUID` |
| `entra_id` | ✅ | flattened via `$ref` | Graph `id` |
| `google_workspace` | ✅ | flattened via Members API | Google `id` |
| `mail_server` | ✅ | — | **our** `users.id` |
| `scim_slack` | ✅ | flattened via `/Groups` | SCIM `id` |
| `scim_zoom` | ✅ | flattened via `/Groups` | SCIM `id` |
| `scim_atlassian` | ✅ | flattened via `/Groups` | SCIM `id` |
| `scim_box` | ✅ | flattened via `/Groups` | SCIM `id` |
| `scim_snowflake` | ✅ | flattened via `/Groups` | SCIM `id` |
| `scim_generic` | ✅ | flattened via `/Groups` | SCIM `id` |
| `echo` | ✅ | ✅ | in-repo, for testing the spine |
| `keycloak_sso` | — | — | Keycloak **client** UUID (applications, not people) |

`keycloak_sso` is the one target that carries no principals at all. Everything that
walks users — the attribute mapping editor and `pnpm target-reconcile` — iterates
`DIRECTORY_TARGETS` (`connectors/connector.ts`), which is `ALL_CONNECTOR_TARGETS`
minus this one. The dead-letter filter and the connector target list deliberately keep
the full catalog: an `sso_app` event can dead-letter, and `keycloak_sso` is
configurable and disable-able like any other target.

### Three interface families

`DirectoryConnector` (users) and `DirectoryGroupConnector` (groups) are joined by
`SsoConnector` (applications): `planApp`, `applyApp`, `health`. An application is
neither a user nor a group, and `DirectoryConnector` is deliberately narrow — widening
it would make four methods over `DesiredUser` mean something different per target.
`ConnectorRegistry.healthFor` dispatches to whichever family owns a target, so the
console's target list can summarize all of them; calling `resolve` for `keycloak_sso`
throws by design, and would otherwise render a healthy target as failing.

`SsoConnector` has no `disable` (an application is always driven from its local row,
so `enabled: false` in the desired state covers it) and no delete at all. Minting a
client secret is deliberately **not** on this interface either — it is imperative and
administrator-triggered, not desired-state reconciliation, and folding it in would
imply the sync worker could call it.

### Keycloak (SSO applications) — `keycloak_sso`

Registers OIDC clients from `sso_apps`. Configured with `baseUrl`, `realm`, `clientId`
(`idm-sso-admin`) and `credentialSecretName`
(`CONNECTOR_KEYCLOAK_SSO_CLIENT_SECRET`).

The realm **must** be the same one the console authenticates against — an application
registered elsewhere is invisible to every account this system masters. The two
targets carry that value separately, so `health()` should compare it against
`KEYCLOAK_ISSUER` rather than trusting an admin to keep them aligned by hand.

Two Keycloak behaviours the implementation handles explicitly:

- **Protocol mappers are ignored on update.** Keycloak accepts `protocolMappers` on
  client create and silently drops them on update — `scripts/keycloak-setup.sh` hits
  the identical trap with the `idm-api` audience mapper. The `groups` mapper is
  therefore asserted against `/clients/{uuid}/protocol-mappers/models` on every apply.
  Miss this and the failure is the confusing one: the client looks fully configured and
  the claim is simply absent from the token.
- **Read-modify-write, never blind overwrite.** Client update takes a full
  `ClientRepresentation`, so the connector reads the current one and overlays only the
  fields this system manages, leaving `defaultClientScopes` and admin-set `attributes`
  intact. *Not yet verified empirically against Keycloak 26 — it is the safe choice
  under either answer, but whether a partial PUT would also work is unproven.*

### Keycloak

The only target enabled by default, and the only one seeded by migration. Reached
through the Admin REST API using the `KEYCLOAK_ADMIN_CLIENT_ID`/`_SECRET`
client-credentials grant.

Pushes the user's profile, `enabled` state, mapped attributes, and group membership
(creating groups as needed). Also the target of the **synchronous** disable + session
revocation on deactivation.

The service account needs exactly four `realm-management` roles: `manage-users`,
`query-users`, `view-users`, `query-groups`.

### Active Directory

LDAPS via `ldapts`. Configuration:

| Key | Required | Notes |
|---|---|---|
| `url` | ✅ | Must be `ldaps://`. Plain `ldap://` is never accepted. |
| `baseDN` | ✅ | e.g. `DC=corp,DC=example,DC=com` |
| `bindDN` | ✅ | The service account's DN |
| `credentialSecretName` | ✅ | Name of a `CONNECTOR_*` env var holding the bind password |
| `caCertificate` | | PEM. Blank trusts the host's OS root store. |
| `tlsServerName` | | SNI/verification override |
| `allowInsecureTls` | | **The only** way certificate verification is relaxed. Off by default; keep it off outside a lab. |
| `createMissingOrgUnits` | | Create OUs to match the org path |

Defaults: 5s connect timeout, 15s operation timeout.

**Native group nesting.** A group-to-group `member` edge can only be written once the
child group has its own AD DN to point at — which requires knowing whether the child has
ever successfully synced. `external_group_identities` is the only place that fact lives,
which is what makes native nesting possible rather than flattening.

Accounts are created as normal accounts with `ACCOUNTDISABLE` cleared or set from
`enabled`. LDAP `modify` is a partial update: an attribute omitted from the request is
left untouched, never cleared. That is why `managedAttributeRemoteNames` is passed — the
connector must know which remote names it owns in order to clear one that has been
unmapped, without touching anything it does not manage.

### Entra ID

Microsoft Graph v1.0, client-credentials against
`https://login.microsoftonline.com`. Configuration: `tenantId`, `clientId`,
`credentialSecretName`.

Group membership uses `$ref` rather than a nested representation, so this connector
receives the flattened effective set like Keycloak does.

Graph's `PATCH` is a partial update with exactly the same semantics as LDAP `modify`,
confirmed against Microsoft's own "Update user" documentation — so the same managed-name
handling applies.

Throttling: up to 4 retries honouring `Retry-After`, capped at a 30s wait, with a 2s
fallback when no header is present. Tokens are cached with a 10s expiry safety margin.

### Google Workspace

Admin SDK Directory API, service account with **domain-wide delegation**.
Configuration: `impersonatedAdminEmail` (the real Workspace admin the service account
acts as), `domain`, and `credentialSecretName` naming the variable that holds the
**full downloaded service-account key JSON** — not a bare private key.

Scopes requested: `admin.directory.user`, `admin.directory.group`,
`admin.directory.group.member`.

`users.update` is a partial update ("fields set to null will be cleared"), the same
shape as Graph and LDAP. Throttling matches Entra's: 4 retries, 30s cap, honouring
quota-exceeded reasons.

### Mail server

The one target that is not a general-purpose directory. Configuration: `baseUrl` and
`tokenSecretName`.

It addresses a principal by **this system's own `users.id`** —
`PUT /provisioning/identities/{external_id}` where that key is our uuid. Keying on the
address is explicitly rejected by the counterpart's spec: keying on an immutable id is
what makes a changed email a *rename* of an existing mailbox rather than an orphan plus
a new empty one.

It receives the full `status`, not just `enabled`, because only `deactivated` may stamp
`deactivated_at` and start the retention clock. A suspension must never do that.

Cross-host transport is documented in [11 — Operations](11-operations.md#mail-server-over-a-separate-host).

Contract check:

```bash
MAIL_SERVER_BASE_URL=... MAIL_SMOKE_EMAIL=someone@a-hosted-domain \
  pnpm --filter @idm/api smoke:mail
```

`MAIL_SMOKE_EMAIL` must be in a domain the mail server **already hosts**; it never
auto-creates domains.

### SCIM 2.0 — the six `scim_*` slots

Six target values, **one** adapter class (`connectors/scim.connector.ts`). SCIM 2.0
(RFC 7643 schema, RFC 7644 protocol) is what most SaaS applications expose for exactly
this, and the protocol is identical across them — only the base URL, the credential and
the write mode differ, all of which are configuration.

**Why slots rather than instances.** `connector_targets`' primary key is
`(organization_id, target)` and `external_identities` is unique per `(user_id, system)`.
One configured instance per target value is a load-bearing invariant of the outbox and
correlation design, not an accident. Naming each application as its own target value is
what lets one organization provision Slack *and* Zoom *and* Box without touching that
invariant — and each slot keeps its own credential, its own attribute mappings, its own
enable/disable, its own dry run and its own blast-radius settings.

Adding a seventh application is a migration widening the two pgEnums, one entry in
`SCIM_TARGETS` (`connector-registry.ts`), and one label in the console — **no new
adapter logic**.

| Config key | Meaning |
|---|---|
| `baseUrl` | The SCIM service root, e.g. `https://api.slack.com/scim/v2` |
| `tokenSecretName` | Names the `CONNECTOR_*` variable holding a static bearer token |
| `writeMode` | `patch` (default) or `put` |
| `tokenUrl`, `clientId`, `clientSecretName`, `scope` | OAuth2 client-credentials, for services that mint short-lived tokens |

Set **either** `tokenSecretName` or the OAuth2 group — configuring both is refused
rather than resolved by precedence.

`writeMode` matters on day one: PATCH is an *optional* SCIM feature a service advertises
in `/ServiceProviderConfig`, and a service that lacks it rejects every write until this
is switched to `put`. In `patch` mode a de-mapped attribute is actively **removed**
(RFC 7644 §3.5.2.2), the same partial-update clearing gap Graph and the Admin SDK have;
in `put` mode the whole resource is replaced, which self-clears.

Correlation is on the SCIM `id`, which RFC 7643 §3.1 makes service-assigned and
immutable — never `userName`, which is as mutable here as a UPN is in Entra. Groups are
**flat**: one remote SCIM group per local group. RFC 7643 §4.2 does permit a group to
contain a group, but the mainstream services these slots target do not implement it, so
this connector does not implement `DirectoryGroupConnector` — the same choice Keycloak,
Entra and Google already make.

`disable` sets `active: false`. RFC 7644 §3.6 defines `DELETE /Users/{id}` and this
connector has no code path that can emit it.

Unlike Entra — whose `POST /users` requires a `passwordProfile` — RFC 7643 §4.1.1 makes
`password` optional, so a SCIM user is created without one and no credential for the
provisioned person is ever generated or sent.

### Echo

An in-repo target that exercises the entire spine — registry, per-target dispatch,
secret resolution, correlation writes — without any vendor protocol. It is a genuine
`outbox_target` citizen, not a test-only bypass: the console's own end-to-end test
configures it, dry-runs it, applies, and watches health go green through exactly the
same code path AD and Entra use.

## Enabling a target — the order matters

1. **Configure** it (config + credential variable **name** + blast-radius settings).
   Nothing has fanned out yet, because it is still disabled.
2. **Set the `CONNECTOR_*` environment variable** on the host and restart the service.
3. **Add attribute mappings.** Nothing propagates without them — absence of a row is the
   default-deny.
4. **Check health.** `not_configured` and `disabled` never attempt a live check;
   `failing` tells you what went wrong.
5. **Dry run** — `POST /connector-targets/:target/reconcile` with `dryRun: true`, or the
   console's Dry run tab. Nothing is written anywhere. Read the plan.
6. **Enable.** From now on, every mutation fans out to this target.
7. **Apply a reconcile** to bring the existing population into line.

Enabling before dry-running means the next mutation fans out to a target you have not
proven you can reach.

## Secrets

`connector_targets.config` stores a secret's **name**, never its value. The value is
resolved from the environment **at the point of use**, every time:

- never cached beyond one call;
- never written back to any table;
- never returned by any endpoint;
- never logged, and never included in an error message or stack trace.

`resolveSecret` is the only function permitted to read one, and a connector may only
resolve variables matching `^CONNECTOR_[A-Za-z0-9_]+$`. See
[02 — Architecture](02-architecture.md#the-connector-secret-rule) for why that namespace
is a security boundary rather than a convention.

Two distinct failures:

| Error | Meaning |
|---|---|
| `MissingSecretError` | The named variable is unset or empty. Set it and restart. |
| `ForbiddenSecretNameError` | The name is outside the `CONNECTOR_*` namespace. Rename the variable. |

An empty string counts as unset — `FOO=` in a `.env` file is almost always an accident,
and treating it as present would let a connector "successfully" authenticate with
nothing.

## Health

`GET /connector-targets` returns a health status per target:

| Status | Live check? | Meaning |
|---|---|---|
| `not_configured` | no | No row. Nothing to reach. |
| `disabled` | no | Configured but deliberately off. |
| `failing` | yes | The check failed; `healthDetail` says why. |
| `never_synced` | yes | Check passed, but nothing has ever synced successfully. |
| `healthy` | yes | Check passed **and** there is a proven track record. |

Five states, not three, because "configured but never successfully synced" must not
read as healthy.

`healthDetail` is guaranteed free of resolved secret values by the connector interface's
own contract, proven by a sentinel-value test through this endpoint specifically.

## Retries and dead letters

| Setting | Value |
|---|---|
| Max attempts | 8 |
| Backoff | exponential, base 2s, ceiling 10 min, jittered |
| Idle poll | 5s |

After the last attempt the event is **dead-lettered** (`status = 'failed'`) and appears
at `GET /outbox/dead-letters` and in the console.

Dead letters are **not retried over HTTP** — deliberately. Fix the cause, then run a
reconciliation. That keeps "retry" from becoming an un-audited way to re-trigger
arbitrary outbound calls.

## The sync badge, and what it aggregates

`GET /users` and `GET /users/:id` carry a derived `syncState` per person —
`synced`, `pending` or `failed` — which the console renders as a badge. It is computed
per request, never stored, and it aggregates over **every target currently `enabled` in
`connector_targets`**, taking the worst state it finds. A healthy Keycloak sync does not
mask a broken mail sync: `docs/product-brief.md`'s second requirement is that nobody
should look healthy while a real sync is broken.

Per target, two sources are consulted **in order**:

1. The latest `outbox_events` row for that `(user, target)`. `failed` → failed,
   `pending`/`processing` → pending, `done` → healthy.
2. Only if that target has no event at all, the `external_identities` row for it.

The ordering matters for a connector that returns `NotApplicableError` — "this user has
nothing for me to represent", e.g. someone with no mailbox. That leaves a `done` event
and **no** identity row, and the ordering makes it read as settled rather than as a
target that never synced.

The badge also folds in `group` and `membership` events for groups the person is an
effective member of, because a fan-out that dead-letters partway through cannot cleanly
attribute itself to any single user. That is the case the whole derivation exists for,
and it is why a person can show `failed` while all of their own targets are green.

### Why is this person's badge that colour?

`GET /users/:id/sync`, and the **Sync** tab on their detail page in the console. One row
per enabled target: state, external id, last synced, attempts, next retry, and the
error. Any group holding them back is listed separately.

It shows events that are still **retrying**, which `GET /outbox/dead-letters` by
definition cannot — that endpoint lists only `status = 'failed'`. An event mid-backoff,
or head-of-line blocked behind an older event for the same aggregate and target, is
otherwise invisible.

Two permission levels, deliberately:

| Caller holds | Sees |
|---|---|
| `user:read` | Every structural fact — per-target state, attempts, next retry, timestamps, external id |
| …**and** a global `audit:read` | The above, plus the raw error text from the target |

Without the global `audit:read` the response sets `errorDetailRedacted: true` and nulls
`lastError`, and the console says so rather than showing an empty cell. This is the same
reasoning that gates `GET /outbox/dead-letters`: raw target error text can name internal
hosts and directory paths, and should not widen with a narrow grant. An ordinary admin
still learns *which* target failed and how many times, which is enough to diagnose and
escalate.

## Reconciliation and the blast-radius guard

```bash
pnpm --filter @idm/api reconcile                              # Keycloak drift
pnpm --filter @idm/api target-reconcile <target>              # DRY RUN (default)
pnpm --filter @idm/api target-reconcile <target> --apply
pnpm --filter @idm/api target-reconcile <target> --apply --force
```

A run **halts** if it would mutate more than `blastRadiusThreshold` percent of the
target's population **and** more than `blastRadiusFloor` principals in absolute terms.

Both conditions are required, and the reason is scale. 20% of a ten-person directory is
two people, so three unrelated ordinary changes — a hire, a transfer, a title change —
would already halt a legitimate sync on a percentage alone. The floor lets a small real
batch proceed at a scary-looking percentage while a large one still halts at a modest
one.

Defaults are 20% and 5, both tunable per target. `--force` overrides and is separately
audited. Every reconcile invocation is audited, dry runs included, so "who ran this
against this target, and what did it do" is always answerable.

## Inbound sources — where data comes FROM

Everything above is outbound. The inbound half is `hr_sources`: **pull-based** feeds
this system fetches on a schedule or on demand. The standing rule is that nothing
writes into this system except its own API — an HR feed is never a pushed webhook and
never inbound SCIM; the table only describes where *we* go to fetch.

| Kind | What it reads |
|---|---|
| `csv_url` | An HTTPS URL serving CSV |
| `rest_json` | An HTTPS JSON API, with optional pagination |

`rest_json` is deliberately **generic** rather than one kind per vendor. Workday RaaS,
BambooHR, HiBob, SuccessFactors and Personio all serve JSON over HTTPS and differ only
in where the record array sits, how pages are walked, and what the fields are called —
all three of which are configuration:

| Config key | Meaning |
|---|---|
| `recordsPath` | Dot-path to the array of people, e.g. `data.items`. Blank means the body *is* the array |
| `pagination.mode` | `none`, `page` (a page-number query parameter), or `cursor` (follow a next-page field) |

The column mapping's **source** keys are dot-paths into each record (`name.first`,
`emails.0.value`); its target values are import-pipeline columns, exactly as for CSV.
Unmapped fields are dropped — an HR payload's payroll fields must not reach the
pipeline as unknown custom attributes.

Both kinds converge on the **same mapped CSV** before anything else runs, so the
preview, per-row validation, row cap, blast-radius guard and commit are one code path
that cannot tell the two apart. A second feed kind must never become a second route
through the parts that write to people.

Two safety properties worth knowing:

- The byte ceiling spans the **whole run**, not each page — a per-page cap would let an
  N-page feed allocate N times the ceiling. Page count is separately bounded, because an
  upstream returning a cheap self-referential next-link costs almost no bytes.
- A mistyped `recordsPath` **fails loudly** rather than reading as an empty feed.
  Downstream, "the HR system has no people" is indistinguishable from a real,
  catastrophic emptying.

Feed credentials follow the same rule as every connector: `auth_secret_name` stores the
NAME of a `CONNECTOR_*` environment variable, resolved through the same `resolveSecret`,
and is never logged, thrown or returned.

## The data-flow map

`GET /api/data-flows` (console: **Data flows**) answers the question neither the
Connectors page nor the attribute mapping editor does — *what leaves this system, and to
whom*. One response carries every inbound source, every outbound target, and the
attributes riding each outbound edge, for one organization.

It stores nothing new; every fact already lives in `hr_sources`, `connector_targets` and
`attribute_target_mappings`. It deliberately makes **no live health check**: that is the
Connectors page's question, and doing it here would mean an outbound HTTP call per
target on every page load, and would make the map of the estate unavailable exactly when
part of the estate is down. Disabled mappings are shown rather than hidden — "this used
to flow and no longer does" is precisely what the screen is for.

## Adding a new target

1. Add the value to the `outbox_target` **and** `external_identity_system` pgEnums, in a
   migration. Do **not** seed a `connector_targets` row in that same migration — Postgres
   forbids using an enum value in the transaction that added it.
2. Add it to `ALL_CONNECTOR_TARGETS` in `connectors/connector.ts`. That array is the
   single source of truth; the union derives from it, and
   `connector-target-catalog.spec.ts` asserts it matches the pgEnum in **both**
   directions.
3. Write the connector implementing `DirectoryConnector` (and `DirectoryGroupConnector`
   if it supports native nesting). Read config from the `config` object; read the
   credential only through `resolveSecret`.
4. Register it in `ConnectorRegistry` — widen `ImplementedConnectorTarget` and the
   `satisfies` literal together.
5. Add its form fields to `TARGET_CONFIG_FIELDS` in the console.
6. Add tests, including a sentinel-value secret-leak test.

A target present in the wider union but absent from the registry fails **safely** rather
than silently.

If the target speaks **SCIM 2.0**, steps 3–5 collapse: add it to `SCIM_TARGETS` in
`connector-registry.ts` and give it a label and the shared field spec in the console.
There is no new adapter to write.
