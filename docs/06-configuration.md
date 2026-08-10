# 06 — Configuration

There are two configuration surfaces, and they are read at different times.

| Surface | File | Read when | Consumer |
|---|---|---|---|
| API / worker / CLIs | `.env` at the repo root | **Runtime**, on process start | `apps/api/src/config/env.ts` |
| Web console | `apps/web/.env` | **Build** time, inlined by Vite | `apps/web/src/auth/oidc-config.ts` |

Everything else — connector targets, attribute definitions, attribute mappings, JML
rules — lives in the database.

## API environment (`.env`)

Validated by a Zod schema in `apps/api/src/config/env.ts`. This is the **only** place
`process.env` is read for application config; anything invalid or missing fails
`loadEnv` outright with a message naming the field, so the process never boots
half-configured.

### Required

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | **Owner / migration** connection. Owns every table, sequence, and the append-only trigger function. The only credential `db:migrate` ever connects with. Never used by the running app. |
| `RUNTIME_DATABASE_URL` | **Runtime** connection. What the API and sync worker actually connect as. **No fallback to `DATABASE_URL`** — a deployment that forgets it fails to boot rather than silently running with owner privileges. |
| `KEYCLOAK_ISSUER` | Full realm issuer URL, e.g. `https://kc.example.com/realms/identity-manager`. A trailing slash is stripped. |
| `KEYCLOAK_AUDIENCE` | The `aud` claim inbound end-user tokens must carry. Default realm setup uses `idm-api`. |
| `KEYCLOAK_ADMIN_CLIENT_ID` | Service account for the **outbound** client-credentials grant. Default realm setup uses `idm-sync-service`. |
| `KEYCLOAK_ADMIN_CLIENT_SECRET` | That service account's secret, minted by `keycloak-setup.sh`. |

`KEYCLOAK_AUDIENCE` and `KEYCLOAK_ADMIN_CLIENT_ID` are easy to confuse: the first is
checked on **inbound** tokens, the second authenticates **outbound** calls into the
same realm.

### Realm provisioning (required only to create organizations)

| Variable | Purpose |
|---|---|
| `KEYCLOAK_PROVISION_CLIENT_ID` | A **master-realm** service account that may create and administer *other* realms. |
| `KEYCLOAK_PROVISION_CLIENT_SECRET` | That service account's secret. |

Both or neither. A half-configured pair is treated as unconfigured rather than
attempted, so the failure is an actionable "set these two variables" at the point of use
instead of a 401 from Keycloak's token endpoint with an empty secret. With neither set,
everything else works exactly as before and `POST /organizations` answers **503
`NOT_CONFIGURED`** rather than accepting a tenant whose realm could never be created.

They are a **second, separate credential** from `KEYCLOAK_ADMIN_CLIENT_ID`, and that is
not redundancy. The admin credential is *realm-scoped*: its roles are
`realm-management` client roles inside `identity-manager`, and a token minted there
cannot reach `/admin/realms/<anything-else>` at all. Creating a realm is a
**server-level** operation, which only a master-realm principal can perform.

**Creating the service account.** `scripts/keycloak-setup.sh` will do it, but only
when asked:

```
SETUP_PROVISIONER=1 \
  KEYCLOAK_URL=https://kc.example.com \
  KC_ADMIN_USER=admin KC_ADMIN_PASS=... \
  CONSOLE_URL=http://idm.lan \
  bash scripts/keycloak-setup.sh
```

It prints `KEYCLOAK_PROVISION_CLIENT_ID` and `KEYCLOAK_PROVISION_CLIENT_SECRET` at
the end. The flag is opt-in rather than default because this is the only credential
in the system whose reach is the whole Keycloak server; a single-tenant install has
no use for it and is better off without it. Run the script without the flag and it
says so explicitly, so the `503 NOT_CONFIGURED` you would otherwise meet at the
Organizations page is not a mystery.

By hand, the same thing is four steps in the admin console:

1. Switch to the **`master`** realm — not `identity-manager`.
2. **Clients → Create client.** Client ID `idm-provisioner`. Client authentication
   **on**; standard flow and direct access grants **off**; **Service accounts roles
   on**.
3. **Credentials** → copy the secret into `KEYCLOAK_PROVISION_CLIENT_SECRET`.
4. **Service accounts roles → Assign role → Filter by realm roles → `create-realm`.**
   Assign that, and nothing else.

`create-realm` alone is sufficient, and this is measured against a real Keycloak 26
rather than assumed. Holding only that role, the credential gets:

| Request | Realm it created | Realm it did not create |
|---|---|---|
| `GET /admin/realms/<name>` | 200 | 200 |
| `GET .../users/count` | 200 | 403 |
| `GET .../clients` | 200 | 403 |
| `POST .../users` | 201 | 403 |
| `PUT /admin/realms/<name>` | 200 | 403 |

Keycloak grants the creator of a realm the `<realm>-realm` client roles at creation
time, so the provisioner can administer every realm it made and, apart from one bare
top-level read, nothing about any realm it did not. A realm made by hand, or made
before the credential was rotated, is therefore *not* administrable; `ensureRealm`
probes for exactly that on the already-exists path and refuses with a message naming
the remedy.

One consequence is easy to be bitten by: those creator roles are attached to the
service account, not back-filled into tokens already issued to it. A token minted
*before* the realm existed gets 403 on that realm's own `users/count`; one minted
after gets 200. `KeycloakAdminClient.invalidateCachedToken()` is what makes the
provisioning path re-mint at the right moment, which is why deleting it as dead code
turns seven tests red.

Grant nothing beyond `create-realm`. A master-realm `admin` would work, and would also
be a credential that can do anything to anything, held by a long-running service.

### Optional, with defaults

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | API listen port. |
| `SYNC_WORKER_ENABLED` | `true` | Starts the outbox drain in-process. Set to `false` on a second API instance behind a load balancer so only one drains. Spelled as the literal string `true`/`false` — a boolean coercion would treat `"false"` as true and make the off switch impossible to flip. |
| `DB_POOL_MAX` | `10` | Ceiling on physical Postgres connections. Raise for a bigger instance; lower when several API instances share one small one. |
| `BODY_LIMIT_BYTES` | `10485760` (10 MiB) | Explicit ceiling on the whole request body, replacing Express's *accidental* 100 KiB default. Comfortably covers a several-thousand-row CSV import. |
| `IMPORT_MAX_ROWS` | `1000` | Ceiling on **data rows** in one import preview/commit. Bounds worst-case request duration independently of body size (commit is roughly 8.5 ms of serial work per row — measured; preview is now effectively free). |

### Connector secrets

Every connector credential is referenced **by the name of an environment variable**,
never stored in the database. A connector may only resolve variables matching
`^CONNECTOR_[A-Za-z0-9_]+$` — see [02 — Architecture](02-architecture.md#the-connector-secret-rule)
for why that namespace is load-bearing rather than a naming convention.

| Variable | Used by |
|---|---|
| `CONNECTOR_ECHO_CREDENTIAL` | The in-repo echo target, so the console's dry-run/apply flow has a real variable to name |
| `CONNECTOR_MAIL_SERVER_TOKEN` | The mail server's provisioning API service token |
| `CONNECTOR_KEYCLOAK_SSO_CLIENT_SECRET` | The `idm-sso-admin` client secret, for registering SSO applications. A **different** credential from `KEYCLOAK_ADMIN_CLIENT_SECRET`, resolved only by the `sso_app` code path |
| `CONNECTOR_AD_BIND_PASSWORD` *(your choice of name)* | Active Directory bind password |
| `CONNECTOR_ENTRA_CLIENT_SECRET` *(your choice of name)* | Entra ID client secret |
| `CONNECTOR_GOOGLE_SERVICE_ACCOUNT_KEY` *(your choice of name)* | The **full** downloaded Google service-account key JSON, not a bare private key |
| `CONNECTOR_SCIM_SLACK_TOKEN` *(your choice of name)* | A SCIM slot's static bearer token. **One variable per slot** — `scim_slack`, `scim_zoom`, `scim_atlassian`, `scim_box`, `scim_snowflake` and `scim_generic` each name their own, because each is a separately configured application |
| `CONNECTOR_SCIM_CLIENT_SECRET` *(your choice of name)* | A SCIM slot's OAuth2 client secret, for a service that mints short-lived tokens instead of accepting a static bearer. Again one per slot |

Nothing reads any of these unless a `connector_targets` row names it. Anything you add
for a connector **must** start with `CONNECTOR_`; a name outside the namespace is
rejected with `ForbiddenSecretNameError`, and an empty value is treated as unset.

> The console's placeholder text for these fields shows names like `AD_BIND_PASSWORD`.
> The enforced rule is the `CONNECTOR_` prefix — use `CONNECTOR_AD_BIND_PASSWORD`.

### Smoke-test only

| Variable | Purpose |
|---|---|
| `MAIL_SERVER_BASE_URL` | Base URL for `pnpm --filter @idm/api smoke:mail` |
| `MAIL_SMOKE_EMAIL` | An address in a domain **already hosted** by the mail server; it never auto-creates domains |

## Web console environment (`apps/web/.env`)

| Variable | Example |
|---|---|
| `VITE_KEYCLOAK_ISSUER` | `https://kc.example.com/realms/identity-manager` |
| `VITE_KEYCLOAK_CLIENT_ID` | `idm-console` |
| `VITE_API_BASE_URL` | `https://idm.example.com/api` (dev: `http://localhost:3000`) |

**Vite inlines these at build time.** They are compiled into the bundle, not read at
runtime — changing `.env` and restarting does nothing. You must rebuild
(`pnpm build`) and, for a hostname change, re-run `keycloak-setup.sh` with the new
`CONSOLE_URL` so `idm-console`'s `redirectUris` match.

Vite only reads `.env` from its own project directory. The repo-root `.env` is invisible
to it; this is why there are two files.

## Database-held configuration

### Connector targets

One row per target **per organization** — `(organization_id, target)` is the primary key
of `connector_targets` — edited through **Connectors → *target* → Configuration** in the
console, or `PATCH /connector-targets/:target`. An organization with no row for a target
never fans out to it, and absence never falls back to another organization's row.

| Setting | Notes |
|---|---|
| `enabled` | `OutboxWriter` fans out only to enabled targets. Disabling stops new events; it does not undo anything already delivered. |
| `provisioning_mode` | `all_users` (default) or `entitled_only` |
| `config` | Non-secret settings; a `PATCH` **merges** rather than replacing, so a key the form does not know about is never destroyed. A key sent as `null` is *deleted* — that is the only way to remove one. |
| `blast_radius_threshold` | 1–100, default 20 — percent of the population a reconcile may mutate |
| `blast_radius_floor` | ≥ 0, default 5 — absolute count below which the guard never trips |

Both blast-radius conditions must be exceeded for a run to halt.

Per-target `config` keys. The console's own catalog — `TARGET_CONFIG_FIELDS` in
`apps/web/src/connectors/config-fields.ts` — is the authoritative form spec, and
`apps/web/scripts/check-connector-targets.mjs` fails `pnpm verify` if it drifts from
`ALL_CONNECTOR_TARGETS`:

| Target | Keys |
|---|---|
| `keycloak` | *(none — uses `KEYCLOAK_*` from `.env`)* |
| `echo` | `credentialSecretName` |
| `active_directory` | `url` (must be `ldaps://`), `baseDN`, `bindDN`, `credentialSecretName`, `caCertificate` (PEM), `tlsServerName`, `allowInsecureTls`, `createMissingOrgUnits` |
| `entra_id` | `tenantId`, `clientId`, `credentialSecretName` |
| `google_workspace` | `impersonatedAdminEmail`, `domain`, `credentialSecretName` |
| `mail_server` | `baseUrl`, `tokenSecretName`, `allowAdminProvisioning` |
| `scim_slack`, `scim_zoom`, `scim_atlassian`, `scim_box`, `scim_snowflake`, `scim_generic` | `baseUrl`, `tokenSecretName`, `writeMode` — **or** the OAuth2 group `tokenUrl`, `clientId`, `clientSecretName`, `scope` |
| `keycloak_sso` | `baseUrl`, `realm`, `clientId`, `credentialSecretName` |

`allowInsecureTls` is the **only** way certificate verification is ever relaxed for
Active Directory. Off by default; it should stay off outside a test lab. Plain `ldap://`
is never accepted at all.

**The six `scim_*` rows are six target values sharing one adapter**
(`apps/api/src/connectors/scim.connector.ts`). SCIM 2.0 is identical across services, so
only the base URL, the credential and the write mode differ — but they are separate
target values rather than rows of a single `scim` target because
`(organization_id, target)` is `connector_targets`' primary key and `(user_id, system)`
is unique in `external_identities`. One configured instance per target value is a
load-bearing invariant of the outbox and correlation design, so each application has to
be named to get its own credential, its own attribute mappings, its own enable/disable
and its own blast-radius settings. Set **either** `tokenSecretName` **or** the whole
OAuth2 group; configuring both is refused rather than resolved by precedence.
`writeMode` is `patch` (the default) or `put`, and a service that does not advertise
PATCH in its `/ServiceProviderConfig` rejects every write until it is switched to `put`.

**`keycloak_sso` is not a directory target.** It registers OIDC and SAML *applications*
from `sso_apps` and carries no principals, so it has no attribute mappings and
`pnpm target-reconcile` will not accept it — both surfaces iterate `DIRECTORY_TARGETS`,
which is the catalog minus this one value. Its `realm` must be the same realm the
console authenticates against, or every registered application is invisible to the
accounts this system masters; that alignment is **not** checked at runtime today (see
[09 — Connectors and sync](09-connectors-and-sync.md#keycloak-sso-applications--keycloak_sso)).
Its `clientId` is `idm-sso-admin`, a credential holding `manage-clients` and nothing
else — deliberately separate from the sync service account, so the user and group sync
path structurally cannot mint or alter a client.

### Attribute definitions

Rows in `attribute_definitions` define the custom fields that appear on the person and
group forms. **There is no write endpoint** — they are managed directly in the database
today. `GET /attribute-definitions` is read-only.

| Column | Effect |
|---|---|
| `data_type` | Which control the console renders |
| `required`, `validation_rules`, `default_value` | Server-side validation |
| `applies_to` | `user` or `group` |
| `sort_order`, `is_active` | Display order; inactive definitions are not offered |
| `self_editable` | **Default false.** Only `true` definitions may be changed via `PATCH /self`. |

### Attribute → target mappings

Rows in `attribute_target_mappings`, edited through **Connectors → Attribute mappings**.
Each row opts one field into propagation to one target under a chosen remote name.

**Absence of a row is the default-deny.** A field with no mapping row for a target
cannot reach it, structurally.

A row references **either** an `attribute_definition_id` (a custom attribute) **or** a
`core_field` (`given_name`, `surname`, `title`, `department`) — never both, enforced by a
`CHECK` constraint as well as by the API.

### JML rules

Rows in `jml_rules`. **No HTTP surface exists today** — they are managed directly in the
database and executed by the `jml:lifecycle` CLI. A rule cannot be enabled until it has
been simulated at least once, enforced in the repository against the durable
`simulated_at` column rather than by caller convention.

### Organizations

Tenants are **not** database-held configuration — they are created over the API
(`POST /organizations`) or from the console's Organizations page, and each one is
audited. See [07 — Admin guide](07-admin-guide.md#walkthrough-12--create-and-suspend-an-organization).

## Configuration checklist for a new deployment

1. `.env`: both database URLs, all four Keycloak values, and any `CONNECTOR_*` secrets.
2. `apps/web/.env`: issuer, client id, API base URL — then **build**.
3. Keycloak: realm plus **four** clients via `keycloak-setup.sh` — `idm-api`,
   `idm-console`, `idm-sync-service` and `idm-sso-admin` — including the audience
   mapper. A fifth, the master-realm `idm-provisioner`, is opt-in behind
   `SETUP_PROVISIONER=1` and is only needed to create organizations.
4. `db:migrate` — schema **and** runtime role grants.
5. `bootstrap:admin <your-keycloak-username>` — or everything is 403.
6. Connector targets: configure, dry-run, then enable. Never enable first.
7. Attribute mappings: nothing propagates until a row exists.
