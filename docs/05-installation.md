# 05 — Installation (production)

Installs the API, the outbox sync worker, PostgreSQL and nginx **natively under
systemd**. No Docker, so an LXC container can be **unprivileged with nesting off**.

> ## Read this first
>
> **All six planned adversarial audit dimensions have now run**, the sixth — tenant
> isolation — on 2026-08-14. They found and closed real issues: three authorization
> gaps where holding a permission *anywhere* satisfied a route governing the whole
> directory, a catalog drift that made a live outbound integration impossible to
> disable through the API, and a cross-tenant transfer that was refused by the
> database but reported as a 500.
>
> **At most nine findings remain open**, re-counted against the code on 2026-08-14 —
> the long-quoted "roughly twenty" was stale by eleven closures. **Two are MEDIUM and
> nothing HIGH or CRITICAL is open.** Both are named in
> [12 — Security model](12-security.md) rather than left as a number.
>
> One of them bears directly on installing: **do not import
> `keycloak/realm-import/identity-manager-realm.dev.json`.** It seeds
> `admin@example.com` with a password published in this repository. Use
> `scripts/keycloak-setup.sh`, which builds the same realm through the Admin API with
> generated secrets and no seeded user.
>
> See [12 — Security model](12-security.md) for the dimensions by name and what the
> sixth pass deliberately did not cover — in particular, a **tenant-facing API would
> be a second authorization model and would need its own pass**.

## What you need

- A Proxmox host, or any Ubuntu 24.04 machine for the manual path
- **An existing Keycloak** you can create a realm in, plus admin credentials for it
- A hostname for the console (e.g. `idm.lan`) that resolves to the machine
- TLS on **both** the console and Keycloak — see [TLS is required](#tls--required-not-optional).
  This is not hardening advice; without it the sign-in button silently does nothing.

## Path A — Proxmox, one command

On the Proxmox host, as root:

```bash
git clone https://github.com/ssan9876/identity-manager.git /tmp/idm
cd /tmp/idm

IDM_HOSTNAME=idm.lan \
KEYCLOAK_ISSUER=https://kc.example.com/realms/identity-manager \
bash scripts/proxmox-create-lxc.sh
```

That creates an unprivileged container, clones the repo into `/opt/identity-manager`,
and runs the installer. It **stops short of starting the service**, because the service
cannot work until Keycloak is wired up — the next section.

Overrides: `CTID`, `CT_HOSTNAME`, `CORES` (2), `RAM_MB` (2048), `SWAP_MB` (1024),
`DISK_GB` (12), `STORAGE` (`local-lvm`), `TEMPLATE_STORAGE` (`local`), `BRIDGE`
(`vmbr0`), `NET_IP` (`dhcp`), `REPO_URL`, `REPO_BRANCH`.

## Path B — any Ubuntu 24.04 machine

```bash
git clone https://github.com/ssan9876/identity-manager.git /opt/identity-manager
cd /opt/identity-manager

IDM_HOSTNAME=idm.lan \
KEYCLOAK_ISSUER=https://kc.example.com/realms/identity-manager \
bash scripts/install.sh
```

### What `install.sh` does

1. Installs Node 20, PostgreSQL 16 and nginx.
2. Creates the `idm` service user.
3. Creates the database and **both** roles — `idm_owner` (schema owner) and `idm_app`
   (runtime), with a generated password each.
4. Writes `/opt/identity-manager/.env` (mode 0640, owned by `idm`) and
   `apps/web/.env`.
5. `pnpm install --frozen-lockfile` and `pnpm build`, asserting both bundles exist.
6. Runs `db:migrate` — schema **and** runtime-role grants.
7. Installs every unit in `deploy/systemd/` — **seven today**: `idm-api.service`, plus
   a `.service`/`.timer` pair each for backup, lifecycle and reconciliation — and
   enables `idm-api.service` plus each
   timer it finds there — currently `idm-backup.timer` (daily `pg_dump`, 01:00),
   `idm-lifecycle.timer` (daily JML pass, 02:00) and `idm-reconcile.timer` (daily
   Keycloak reconciliation, 03:00). It enables the **timers**; the oneshot services
   behind them are never enabled directly. Both the render and the enable are by glob
   rather than by name, so a release that adds a timer reaches fresh installs and
   upgraded hosts alike. It also creates `/var/backups/identity-manager` (0700, owned
   by `postgres`) for the dumps to land in. See
   [11 — Operations](11-operations.md#scheduled-work).
8. Generates a self-signed certificate if running HTTPS and none was supplied,
   configures nginx to serve the bundle and proxy `/api`, and reloads it.
9. Firewalls: opens 22/80/443, **denies** the API's own port so nginx cannot be
   bypassed.

If no Keycloak client secret was supplied, it leaves the service **stopped** and prints
the remaining steps.

### `install.sh` environment variables

| Variable | Default | Notes |
|---|---|---|
| `IDM_HOSTNAME` | *(required)* | Console hostname |
| `KEYCLOAK_ISSUER` | *(required)* | Full realm issuer URL |
| `IDM_SCHEME` | `https` | `http` is only viable for a localhost-only install |
| `KEYCLOAK_CA_CERT` | — | Path to a CA/self-signed cert for Keycloak. **Required** if Keycloak uses a self-signed cert, or the API cannot fetch JWKS and every token 401s |
| `KEYCLOAK_AUDIENCE` | `idm-api` | |
| `KEYCLOAK_ADMIN_CLIENT_ID` | `idm-sync-service` | |
| `KEYCLOAK_ADMIN_CLIENT_SECRET` | — | If omitted, a placeholder is written and the service is left stopped |
| `IDM_USER` | `idm` | Service account |
| `IDM_PORT` | `3000` | API listen port, blocked from the network by ufw |
| `SKIP_UFW` | — | Set to `1` to leave the firewall alone |

> **The Keycloak values are required up front** because Vite inlines
> `VITE_KEYCLOAK_ISSUER`, `VITE_KEYCLOAK_CLIENT_ID` and `VITE_API_BASE_URL` at **build**
> time. They are compiled into the web bundle, not read at runtime. Changing them later
> requires a rebuild — see [Reconfiguring](#reconfiguring-after-install).

## Connecting to your existing Keycloak

### Do not import the bundled realm file

`keycloak/realm-import/identity-manager-realm.dev.json` is the **development** realm. It
contains a user `admin@example.com` with the password `dev_password_change_me`,
`idm-sync-service` with the secret `idm_sync_dev_secret_change_me`, and
`idm-test-client`, a public client with the password grant. All of it is committed to a
public repository.

The file is hardened as far as a committed fixture can be (finding SEC-L5): the realm
sets `sslRequired: "external"` and `idm-test-client` is imported **disabled**, so an
accidental import does not by itself yield a live password-grant endpoint for
`admin@example.com`. Treat that as damage control, not as permission — the seeded user
and the `idm-sync-service` secret are still real and still public.

Use the script instead. It builds the same realm through the Admin API with a generated
secret, no seeded human user, and no test client:

```bash
cd /opt/identity-manager

KEYCLOAK_URL=https://kc.example.com \
KC_ADMIN_USER=admin KC_ADMIN_PASS=... \
CONSOLE_URL=https://idm.example.com \
bash scripts/keycloak-setup.sh
```

It is **idempotent** — re-running is safe, and it re-mints the client secret each time.
`REALM` defaults to `identity-manager`. Against a lab Keycloak with a self-signed
certificate, pass `KC_INSECURE_TLS=1`; it is deliberately not the default and warns on
every run, because that script sends an admin password and receives a client secret.

### What it creates, and why

| Client | Type | Purpose |
|---|---|---|
| `idm-api` | confidential | The **audience**. Nobody logs into it; it exists so access tokens have an `aud` the API can match against `KEYCLOAK_AUDIENCE`. |
| `idm-console` | public | Browser SSO for the web UI. Its `redirectUris`/`webOrigins` must be your real console URL. |
| `idm-sync-service` | confidential, service account | What the outbox worker authenticates as to create and update users in Keycloak. |
| `idm-sso-admin` | confidential, service account | Registers SSO application clients. Only needed if you use the Applications section. |

`idm-sync-service` gets **exactly four** `realm-management` client roles:

```
manage-users   query-users   view-users   query-groups
```

No more. The worker creates and updates users and reads groups; it never needs
`manage-realm` or `manage-clients`, which would let it alter the realm's own security
configuration.

`idm-sso-admin` gets **`manage-clients` and nothing else**, and it is a separate
credential precisely so the sync worker above does not hold it — the user and group
path structurally cannot mint or alter an OIDC client rather than merely declining to.
Its secret goes into `CONNECTOR_KEYCLOAK_SSO_CLIENT_SECRET`; the setup script prints
it alongside the sync-service secret. Note that `manage-clients` is realm-wide and
Keycloak offers nothing narrower — read
[12 — Security](12-security.md#known-open-items) before enabling this.

`idm-console` also gets an **audience protocol mapper** injecting `idm-api` into the
access token. This is the single most commonly missed step when doing the setup by
hand, and its symptom is confusing: login succeeds, then every API call returns 401,
because the token carries no audience the API accepts.

### Finish the install

Put the printed secret into `/opt/identity-manager/.env`:

```
KEYCLOAK_ADMIN_CLIENT_SECRET=<the value the script printed>
```

Then:

```bash
systemctl start idm-api
```

### Grant yourself access

**Without this, every request returns 403** — including the ones the UI would need to
fix it.

Authorization requires a local `users` row whose `username` matches your Keycloak
`preferred_username`, plus a role grant. A fresh install has neither, and there is no
path through the UI to create them, because doing so needs exactly the permission you
do not yet have.

```bash
cd /opt/identity-manager
sudo -u idm bash -c 'set -a && . .env && set +a && pnpm bootstrap:admin you@example.com'
```

That username must already exist in the Keycloak realm — it is how you log in.
Everyone *after* you gets created in this system and pushed out to Keycloak by the sync
worker; you are the one exception, because you have to be able to sign in before you can
create anybody.

`bootstrap:admin` is idempotent. Re-run it as often as you like.

Now open your console URL.

## TLS — required, not optional

> **The console cannot sign in over plain HTTP.** This is not a hardening
> recommendation; it is a hard requirement, and getting it wrong produces a login button
> that silently does nothing.

`oidc-client-ts` computes the PKCE S256 challenge with `crypto.subtle`, and browsers
only expose that API in a **secure context** — HTTPS, or `localhost`. Served over
`http://` on any other host, `crypto.subtle` is `undefined`, `signinRedirect()` rejects,
and clicking **Sign in** produces no navigation, no error dialog, and nothing but a
console message most people never open.

**Both sides need TLS**, not just the console. Once the console is HTTPS, its `fetch`
calls to an HTTP Keycloak are blocked as mixed content, so Keycloak needs a certificate
too.

### With a real certificate

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d idm.example.com
```

Then rebuild the bundle with the `https://` URLs — the API base URL and issuer are
compiled in, so editing `.env` alone changes nothing.

### With a self-signed certificate (lab / LAN address)

Certbot cannot issue for a bare IP, so a lab deployment needs self-signed certs on
**both** hosts. Include the IP as a SAN — browsers ignore CN for IP-addressed hosts:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -subj "/CN=192.168.88.60" \
  -addext "subjectAltName=IP:192.168.88.60" \
  -keyout /etc/nginx/tls/idm.key -out /etc/nginx/tls/idm.crt
```

Three things then have to line up, and each one bites separately:

1. **`keycloak-setup.sh` will refuse to talk to a self-signed Keycloak.** Pass
   `KC_INSECURE_TLS=1`.

2. **The API rejects every token with 401** until it trusts the Keycloak certificate —
   it fetches JWKS over TLS, and Node will not accept a self-signed chain. The token
   itself is perfectly valid, which makes this confusing to diagnose. Add the
   certificate as a trust anchor for that one process:

   ```ini
   # /etc/systemd/system/idm-api.service.d/ca.conf
   [Service]
   Environment="NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/keycloak.crt"
   ```

   Use `NODE_EXTRA_CA_CERTS`, **never** `NODE_TLS_REJECT_UNAUTHORIZED=0` — the latter
   disables certificate verification for every outbound connection the process makes,
   including to connector targets.

   (`install.sh` does this for you if you pass `KEYCLOAK_CA_CERT`.)

3. **Keycloak's own `redirectUris` must be the `https://` URL.** Re-run
   `keycloak-setup.sh` with the new `CONSOLE_URL`, or logins fail with "Invalid
   redirect_uri".

Browsers will warn once per certificate. That is expected and is not a sign anything is
misconfigured.

### nginx version note

Do not write `http2 on;` — that is nginx 1.25+ syntax, and Ubuntu 24.04 ships 1.24,
which rejects the whole config with `unknown directive "http2"`. Use `listen 443 ssl;`
and leave HTTP/2 out.

## How it is laid out

| | |
|---|---|
| Code | `/opt/identity-manager` |
| Config | `/opt/identity-manager/.env` (0640, owned by `idm`) |
| Service | `idm-api.service` — API **and** outbox worker in one process |
| Timers | `idm-backup.timer` (01:00), `idm-lifecycle.timer` (02:00) and `idm-reconcile.timer` (03:00), each firing a oneshot service of the same name. **Seven** units in `/etc/systemd/system/` after a current `install.sh` or `update.sh` run — a host installed before `idm-backup` existed and never updated since has five, and needs `update.sh`; see [11 — Operations](11-operations.md#scheduled-work) |
| Backups | `/var/backups/identity-manager` (0700, owned by `postgres`) — newest 7 scheduled and 7 pre-update dumps |
| Web bundle | `/opt/identity-manager/apps/web/dist`, served by nginx |
| nginx vhost | `/etc/nginx/sites-available/idm.conf` |
| nginx log format | `/etc/nginx/conf.d/idm-log.conf` — defines `idm_noquery`, which the vhost references |
| Database | local PostgreSQL 16, database `identity_manager` |
| Logs | `journalctl -u idm-api -f`; each timer's job logs under the oneshot **service** the timer fires, so `-u idm-backup`, `-u idm-lifecycle` and `-u idm-reconcile` — not the `.timer` units; nginx's own `/var/log/nginx/access.log` |

**Two database roles, deliberately.** `idm_owner` owns the schema and is what migrations
run as; `idm_app` is what the application runs as, and is created *by* the migration
with reduced privileges. See [02 — Architecture](02-architecture.md#the-two-database-roles).

**One process runs the sync worker.** `SYNC_WORKER_ENABLED` defaults to true and runs
the outbox drain in-process with the API. If you ever run a second instance behind a
load balancer, set `SYNC_WORKER_ENABLED=false` there so only one process drains.

**The API and console share one origin.** `main.ts` calls `enableCors` with
`http://localhost:5173` hardcoded, so a split-origin deployment would be refused by the
browser. nginx serves the bundle and proxies `/api` on the same host, which makes CORS
moot. The installer also firewalls the API's own port so it cannot be reached directly.

## Reconfiguring after install

The console's Keycloak issuer, client id and API base URL are **compiled into the
bundle**. Editing `.env` does not change them.

```bash
cd /opt/identity-manager

# 1. update the build-time values
sudo -u idm tee apps/web/.env >/dev/null <<'EOF'
VITE_KEYCLOAK_ISSUER=https://kc.example.com/realms/identity-manager
VITE_KEYCLOAK_CLIENT_ID=idm-console
VITE_API_BASE_URL=https://idm.example.com/api
EOF

# 2. update the runtime values that mirror them
sudo -u idm sed -i 's|^KEYCLOAK_ISSUER=.*|KEYCLOAK_ISSUER=https://kc.example.com/realms/identity-manager|' .env

# 3. rebuild and restart
sudo -u idm pnpm build
systemctl restart idm-api

# 4. tell Keycloak the console moved
KEYCLOAK_URL=https://kc.example.com KC_ADMIN_USER=admin KC_ADMIN_PASS=... \
  CONSOLE_URL=https://idm.example.com bash scripts/keycloak-setup.sh
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| **Clicking "Sign in" does nothing at all** — no navigation, no error | The console is served over plain `http://` on a non-localhost host, so `crypto.subtle` is undefined and PKCE cannot run. See [TLS](#tls--required-not-optional). This is the single most likely first-run problem. |
| Login redirects, then the API returns **401** with a token that looks valid | The API cannot verify the Keycloak certificate when fetching JWKS. Set `NODE_EXTRA_CA_CERTS`. |
| `keycloak-setup.sh` fails with `SSL certificate problem: self-signed certificate` | Pass `KC_INSECURE_TLS=1`, and only against a lab Keycloak. |
| nginx refuses to start: `unknown directive "http2"` | nginx 1.24 does not support `http2 on;`. Remove it. |
| Every request returns **403**, including as an admin | `bootstrap:admin` was never run. Expected, not a bug. |
| Login works, then every API call is **401** | The `idm-api` audience mapper is missing from `idm-console`. Re-run `keycloak-setup.sh`. |
| Keycloak shows **"Invalid redirect_uri"** | `idm-console`'s `redirectUris` do not match the URL you opened. Re-run `keycloak-setup.sh` with the right `CONSOLE_URL`. |
| Changed the Keycloak URL in `.env`, nothing happened | The console's copy is compiled in. See [Reconfiguring](#reconfiguring-after-install). |
| `idm-api` will not start | `KEYCLOAK_ADMIN_CLIENT_SECRET` is still the `CHANGEME…` placeholder, or a required variable is missing. Check `journalctl -u idm-api -n 50`. |
| Console loads, API unreachable | `systemctl status idm-api`, then `journalctl -u idm-api -n 50`. |

## Upgrading

```bash
sudo bash /opt/identity-manager/scripts/update.sh
```

That is the whole procedure, and it is the **only** supported one. Do not upgrade
with a bare `git pull` + `restart`: `deploy/` is a set of templates, and nothing
copies them onto a running host except `install.sh` and `update.sh`. A pull-only
upgrade therefore ships the repository's security fixes while the machine keeps
serving the old nginx config — confirmed, not hypothetical.

`update.sh` pulls, rebuilds, `pg_dump`s the database, migrates, re-renders every
template under `deploy/`, restarts `idm-api` and then verifies the result,
discovering this host's hostname, port, scheme and certificate paths from what is
already installed. Full detail, environment variables and rollback:
[11 — Operations](11-operations.md#upgrading-a-deployed-host).

It runs `db:migrate` **before** restarting, which matters: migrations apply schema
changes *and* re-assert the runtime role's grants, so a migration that adds a table
also grants the runtime role access to it.
