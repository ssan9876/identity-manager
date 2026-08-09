# SSO Application Onboarding — Design

**Status:** design, not implemented
**Date:** 2026-08-08

## Summary

An IT administrator registers a downstream application for SSO from the Identity Manager
console. Identity Manager masters the application record in Postgres and asserts it into
Keycloak as an OIDC client — client id, redirect URIs, web origins, public/confidential,
and a group-membership protocol mapper — through the same transactional outbox every
other target already uses.

Today this is entirely manual: an admin opens Keycloak's own admin console, creates a
client by hand, and remembers to add a group mapper. Nothing records that it happened,
nothing detects drift, and nothing stops an over-broad redirect URI.

OIDC only. SAML is out of scope for this version, which means Keycloak-as-SAML-IdP for
Google Workspace remains out of reach — see [What this does not
fix](#what-this-does-not-fix).

## Decisions

### 1. Postgres is the system of record; delivery is through the outbox

An `sso_apps` row is the truth. Create and edit write the row, its `audit_log` row and
its `outbox_events` row in one transaction; the sync worker asserts full desired state
into Keycloak.

The alternative — a thin passthrough that proxies Keycloak's `/clients` API live — was
rejected. It has no audit row, no dry run, no drift detection, and it makes every
Keycloak hiccup a console error. It also contradicts the product's own thesis: this
system masters identity and pushes it outward.

### 2. `client_id` is immutable after create

Downstream applications hard-code `client_id` in their own configuration. Keycloak
treats it as renameable, so nothing downstream would stop us from breaking every app
that trusts it. It is settable on create and absent from `PATCH`.

### 3. Correlation is on Keycloak's client UUID, never `clientId`

`external_sso_app_identities` mirrors `external_group_identities` and keys on the
immutable UUID Keycloak assigns, exactly as `docs/09` requires for `objectGUID` and
Graph `id`.

A Keycloak admin *can* rename `clientId` directly. Correlating on it would turn that
rename into an orphaned client plus a second, empty one on the next sync — the precise
failure mode `docs/09` calls "not a cosmetic bug".

### 4. Nothing is deleted

Disabling sets `enabled = false` locally and `enabled: false` on the Keycloak client.
There is no `DELETE /sso-apps/:id`, and `SsoConnector` has no delete method — the same
reasoning `DirectoryConnector` records: removing the capability removes the class of
disaster, rather than leaving a convention to remember.

### 5. Fan-out becomes aggregate-aware

`OutboxWriter.record` currently writes one row per row in `connector_targets` where
`enabled = true`, unconditionally (`apps/api/src/outbox/outbox.writer.ts:111`). An
`sso_app` event under that rule would be handed to Active Directory, Entra and Google,
none of which know what an application is.

A pure function becomes the single source of truth:

```ts
targetsForAggregate(aggregateType, enabledTargets): OutboxTarget[]
```

- `sso_app` → only `keycloak_sso`
- every other aggregate → every enabled target **except** `keycloak_sso`

Asserted in both directions against the pgEnum, in the style of
`connector-target-catalog.spec.ts`, so an unclassified future aggregate or target fails
the suite rather than quietly fanning an application out to a directory.

### 6. A third connector interface family, not a widened `DirectoryConnector`

`DirectoryConnector` is four methods over `DesiredUser`/`DesiredGroup` and its own doc
comment calls it settled and deliberately narrow. An application is neither a user nor a
group.

`ConnectorRegistry` already carries two families — `factories` and `groupFactories` —
each with its own `Implemented*Target` union and the same `Object.create(null)` +
`satisfies` shape. A third family follows that precedent rather than inventing anything.

### 7. `manage-clients` lives on a second Keycloak credential

`idm-sync-service` keeps its exactly-four `realm-management` roles. A new confidential
client, `idm-sso-admin`, holds `manage-clients` alone, and its credential is resolved
only by the code path handling `sso_app` aggregates.

Same process, but the user and group sync path structurally cannot mint or alter a
client. This is the shape of the two-database-role split: a capability the ordinary path
does not merely decline to use, but does not hold.

### 8. The client secret is shown once and retained nowhere

`POST /sso-apps/:id/client-secret` calls Keycloak's `POST /clients/{uuid}/client-secret`
and returns `{ secret }` in that one response. It never enters `sso_apps`, the outbox,
or the audit snapshot. The audit row records that a secret was minted, by whom, for
which application — never the value. Rotation is a re-mint.

Direct precedent: the Google connector's one-time bootstrap password, whose own doc
comment states the rule as "generate it, transmit it once, and retain nothing... no
storage, no log, no audit row, no response body".

## Data model

### `sso_apps`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `client_id` | text, unique | Immutable after create |
| `name` | text not null | |
| `description` | text | |
| `protocol` | `sso_app_protocol` | New pgEnum; only value is `openid-connect` |
| `public_client` | boolean not null | |
| `redirect_uris` | text[] not null | Validated — see [Validation rails](#validation-rails) |
| `web_origins` | text[] not null | |
| `groups_claim` | boolean not null, default true | Whether to assert the group-membership mapper |
| `enabled` | boolean not null, default true | |
| `created_at` / `updated_at` | timestamptz | |

The `protocol` discriminator exists from day one so adding SAML later widens an enum
rather than reshaping a table.

When `groups_claim` is true the connector asserts one `oidc-group-membership-mapper`
named `groups`, emitting the claim `groups`, with Keycloak's "full group path" option
**off** — so a downstream application receives bare group names, matching the flattened
names the Keycloak connector already writes as group membership. The mapper name and
claim name are fixed rather than admin-editable: an application that has to guess which
claim carries its authorization data is a support call waiting to happen.

### `external_sso_app_identities`

`app_id`, `system`, `external_id`, `sync_state`, timestamps. Mirrors
`external_group_identities`.

### Enum widening

`sso_app` joins `outbox_aggregate_type`. `keycloak_sso` joins `outbox_target` and
`external_identity_system`.

No new event types are needed: `created`, `updated` and `status_changed` already exist
and cover create, edit and enable/disable exactly as they do for users.

### Migration order

Per `docs/09`'s "Adding a new target": the enum values land in one migration and the
`connector_targets` seed row in a **separate** one. Postgres forbids using an enum value
in the transaction that added it.

## The connector

### `SsoConnector`

```ts
interface DesiredSsoApp {
  clientId: string
  name: string
  description: string
  protocol: 'openid-connect'
  publicClient: boolean
  redirectUris: readonly string[]
  webOrigins: readonly string[]
  groupsClaim: boolean
  enabled: boolean
  existingExternalId?: string
}

interface SsoConnector {
  planApp(desired: DesiredSsoApp): Promise<ConnectorOperation[]>
  applyApp(desired: DesiredSsoApp): Promise<{ externalId: string }>
  health(): Promise<ConnectorHealth>
}
```

Three methods. No `disable`: unlike a person — who must be disable-able knowing only an
external id, because the offboarding path works from `external_identities` — an
application is always driven from its local row, so `enabled: false` in the desired state
covers it. No delete, per decision 4.

### Two Keycloak behaviours the implementation must handle

**Protocol mappers are ignored on update.** `scripts/keycloak-setup.sh:143` already
records this: Keycloak accepts `protocolMappers` on client create and silently drops
them on update. The group-membership mapper must therefore be asserted separately
against `/clients/{uuid}/protocol-mappers/models`, exactly as that script does for the
audience mapper. The failure mode if this is missed is the confusing one `docs/05`
describes for the audience mapper — everything looks configured and the claim simply is
not there.

**Read-modify-write, never blind overwrite.** Keycloak's client update takes a full
`ClientRepresentation`. The connector reads the current one, overlays only the fields
Identity Manager manages, and writes it back, leaving `defaultClientScopes`,
`attributes` and anything an admin set by hand untouched. Same discipline as
`setEnabledPreservingOtherBits` for AD's `userAccountControl`.

The exact merge semantics must be verified empirically against Keycloak 26 during
implementation, not taken from documentation.

### Configuration and credentials

`keycloak_sso`'s `connector_targets.config` holds the realm base URL, realm name and
client id (`idm-sso-admin`) as plain values, plus
`credentialSecretName: "CONNECTOR_KEYCLOAK_SSO_CLIENT_SECRET"`.

That routes the credential through the existing `resolveSecret` with its `^CONNECTOR_`
guard, so it inherits the sentinel leak test and the `MissingSecretError` /
`ForbiddenSecretNameError` distinction with no new secret machinery.

This must be the **same realm** the console authenticates against and the `keycloak`
target writes users into — an application registered in a different realm would be
invisible to every account this system masters. The two targets carry the value
separately (the `keycloak` target reads `KEYCLOAK_*` from the environment), so
`health()` should compare the configured realm against `KEYCLOAK_ISSUER` and report a
mismatch rather than trusting an admin to keep two sources aligned by hand.

## Authorization

Two new actions in the static catalog: `sso_app:read` and `sso_app:manage`. Both are
**global grant only**.

An SSO application has no containing org unit, so it falls under the rule in `docs/02`
step 3 that already governs the audit log, dead letters, connector targets and attribute
mappings: there is nothing to narrow to, so a global grant is required.

Granted to `super_admin` only — deliberately not `user_admin`. Minting OAuth clients is
realm-security work, not people administration.

## API

| Route | Action | Notes |
|---|---|---|
| `GET /sso-apps` | `sso_app:read` | |
| `GET /sso-apps/:id` | `sso_app:read` | |
| `POST /sso-apps` | `sso_app:manage` | |
| `PATCH /sso-apps/:id` | `sso_app:manage` | Never `client_id`, never `enabled` |
| `POST /sso-apps/:id/enable` | `sso_app:manage` | |
| `POST /sso-apps/:id/disable` | `sso_app:manage` | |
| `POST /sso-apps/:id/client-secret` | `sso_app:manage` | Mints; returns the value once |

Enable and disable are verb routes rather than a `PATCH` field, mirroring `POST
/users/:id/deactivate`: a toggle that changes who can log into what should be a
separately audited action, not a field buried inside an edit.

### Validation rails

Zod `.strict()` throughout, so an unknown key is a 400 naming that key.

**No wildcard redirect URIs.** A bare `*`, or a wildcard anywhere in the scheme or host,
is rejected. Wildcards are permitted only in the path. An over-broad redirect URI is a
token-theft primitive, and the point of moving this into a reviewed system is that the
console can refuse what Keycloak's own admin console accepts without complaint.
`web_origins` gets the same treatment: `+` is allowed, `*` is not.

**PKCE is forced on public clients.** The connector sets
`pkce.code.challenge.method: S256` unconditionally on any `publicClient` and does not
expose it as an editable field. A public client without PKCE is an authorization-code
interception hole; making it unrepresentable is cheaper than making it a checkbox
someone can get wrong.

### Error handling comes for free

No new error codes. `DomainExceptionFilter` already maps everything needed:

| Case | Code | Status |
|---|---|---|
| Unknown key, bad redirect URI | `VALIDATION_FAILED` | 400 |
| Duplicate `client_id` | `CONFLICT` | 409 |
| Mint requested before first successful sync | `CONFLICT` | 409 |
| No such application | `NOT_FOUND` | 404 |
| Missing global grant | `FORBIDDEN` | 403 |

Minting before the first sync is a conflict rather than a 404 because the application
exists here — there is simply no Keycloak client to mint against yet.

## Console

A new **Applications** section, reusing the connector-target detail patterns wholesale:
a list, a detail page with Configuration and Dry run tabs, and the existing
`pending`/`synced`/`failed` sync badge.

The minted secret appears in a modal stating plainly that it will not be shown again,
with a copy button. There is no reveal affordance anywhere, because there is nothing to
reveal — the same architectural honesty that keeps `credentialSecretName` rendered as a
plain text input rather than a masked one.

## The `manage-clients` risk, stated plainly

`manage-clients` in Keycloak is realm-wide. It does not scope to "clients this principal
created". A compromised `idm-sso-admin` credential could rewrite `idm-console`'s own
`redirectUris` and harvest authorization codes for the admin console itself.

Keycloak offers no finer-grained role, so the mitigation is ours: a reserved client-id
denylist — `idm-console`, `idm-api`, `idm-sync-service`, `idm-sso-admin`,
`realm-management`, `account`, `security-admin-console`, `broker` — enforced in the
domain layer and asserted by a static source scan, in the style of the JML rule
vocabulary scan.

This is an application-level guard on an application-level credential. It is **strictly
weaker** than the structural boundaries elsewhere in this system: the runtime database
role cannot violate append-only no matter what code runs, whereas this denylist holds
only as long as the code enforcing it is correct. It belongs in `docs/12` as an open
risk, not as a solved problem.

## Testing

- **Catalog invariant**, extended: every target resolves to exactly one interface
  family, asserted against the pgEnum in both directions.
- **Fan-out**: an `sso_app` event never reaches a directory target; a `user` event never
  reaches `keycloak_sso`.
- **Reserved-client denylist** as a static source scan.
- **Redirect URI table test** covering `*`, `https://*`, `https://*.example.com` and
  `https://app.example.com/*`.
- **Sentinel leak test** for the minted secret across response bodies, logs, audit rows
  and thrown errors.
- **Protocol mapper assertion**: an update to an existing client still results in the
  group mapper being present, which is the regression guard for the
  ignored-on-update behaviour.
- **End-to-end**, mirroring the echo target's: create application → dry run → apply →
  health green.

## Documentation

`docs/02` (new aggregate, the fan-out rule), `03` (the two tables), `05` (the
`idm-sso-admin` client), `06` (the new `CONNECTOR_*` variable), `08` (the two new
actions), `09` (the new target and its interface family), `10` (the endpoints), `12`
(the `manage-clients` risk), `14` (roadmap).

`scripts/keycloak-setup.sh` gains the `idm-sso-admin` client and its `manage-clients`
grant, idempotently, alongside the three clients it already creates.

## What this does not fix

**Google Workspace SSO remains manual.** Workspace federates over SAML only, and this
version is OIDC only. The gap that motivated this work — a connector-provisioned Google
account carrying a throwaway password nobody knows — is untouched. Naming it here so a
reader does not mistake "SSO app onboarding shipped" for "the Workspace account is now
signable-into".

**AD accounts likewise.** They are created with `PASSWD_NOTREQD` and no password, so
they remain unusable for interactive Windows logon. That is a separate decision needing
its own design.

## Out of scope

- SAML, in any form.
- Identity brokering — external IdPs federating *into* Keycloak.
- **A third grant kind in business roles.** An application gets a groups claim;
  authorization inside the application stays the application's business. Business-roles
  decision 2 — "two grant kinds, and no more" — stands unmodified.
- Per-application scope narrowing of `sso_app:manage`. Global only, as above.
