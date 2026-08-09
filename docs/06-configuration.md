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

### Optional, with defaults

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | API listen port. |
| `SYNC_WORKER_ENABLED` | `true` | Starts the outbox drain in-process. Set to `false` on a second API instance behind a load balancer so only one drains. Spelled as the literal string `true`/`false` — a boolean coercion would treat `"false"` as true and make the off switch impossible to flip. |
| `DB_POOL_MAX` | `10` | Ceiling on physical Postgres connections. Raise for a bigger instance; lower when several API instances share one small one. |
| `BODY_LIMIT_BYTES` | `10485760` (10 MiB) | Explicit ceiling on the whole request body, replacing Express's *accidental* 100 KiB default. Comfortably covers a several-thousand-row CSV import. |
| `IMPORT_MAX_ROWS` | `5000` | Ceiling on **data rows** in one import preview/commit. Bounds worst-case request duration independently of body size (commit is roughly 10 ms of serial work per row). |

### Connector secrets

Every connector credential is referenced **by the name of an environment variable**,
never stored in the database. A connector may only resolve variables matching
`^CONNECTOR_[A-Za-z0-9_]+$` — see [02 — Architecture](02-architecture.md#the-connector-secret-rule)
for why that namespace is load-bearing rather than a naming convention.

| Variable | Used by |
|---|---|
| `CONNECTOR_ECHO_CREDENTIAL` | The in-repo echo target, so the console's dry-run/apply flow has a real variable to name |
| `CONNECTOR_MAIL_SERVER_TOKEN` | The mail server's provisioning API service token |
| `CONNECTOR_AD_BIND_PASSWORD` *(your choice of name)* | Active Directory bind password |
| `CONNECTOR_ENTRA_CLIENT_SECRET` *(your choice of name)* | Entra ID client secret |
| `CONNECTOR_GOOGLE_SERVICE_ACCOUNT_KEY` *(your choice of name)* | The **full** downloaded Google service-account key JSON, not a bare private key |

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

One row per target in `connector_targets`, edited through **Connectors → *target* →
Configuration** in the console, or `PATCH /connector-targets/:target`.

| Setting | Notes |
|---|---|
| `enabled` | `OutboxWriter` fans out only to enabled targets. Disabling stops new events; it does not undo anything already delivered. |
| `provisioning_mode` | `all_users` (default) or `entitled_only` |
| `config` | Non-secret settings; a `PATCH` **merges** rather than replacing, so a key the form does not know about is never destroyed |
| `blast_radius_threshold` | 1–100, default 20 — percent of the population a reconcile may mutate |
| `blast_radius_floor` | ≥ 0, default 5 — absolute count below which the guard never trips |

Both blast-radius conditions must be exceeded for a run to halt.

Per-target `config` keys:

| Target | Keys |
|---|---|
| `keycloak` | *(none — uses `KEYCLOAK_*` from `.env`)* |
| `echo` | `credentialSecretName` |
| `active_directory` | `url` (must be `ldaps://`), `baseDN`, `bindDN`, `credentialSecretName`, `caCertificate` (PEM), `tlsServerName`, `allowInsecureTls`, `createMissingOrgUnits` |
| `entra_id` | `tenantId`, `clientId`, `credentialSecretName` |
| `google_workspace` | `impersonatedAdminEmail`, `domain`, `credentialSecretName` |
| `mail_server` | `baseUrl`, `tokenSecretName` |

`allowInsecureTls` is the **only** way certificate verification is ever relaxed for
Active Directory. Off by default; it should stay off outside a test lab. Plain `ldap://`
is never accepted at all.

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

## Configuration checklist for a new deployment

1. `.env`: both database URLs, all four Keycloak values, and any `CONNECTOR_*` secrets.
2. `apps/web/.env`: issuer, client id, API base URL — then **build**.
3. Keycloak: realm plus three clients via `keycloak-setup.sh`, including the audience
   mapper.
4. `db:migrate` — schema **and** runtime role grants.
5. `bootstrap:admin <your-keycloak-username>` — or everything is 403.
6. Connector targets: configure, dry-run, then enable. Never enable first.
7. Attribute mappings: nothing propagates until a row exists.
