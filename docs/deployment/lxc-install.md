# Installing on an LXC container

Runs the API, the outbox sync worker, PostgreSQL and nginx natively under
systemd. No Docker, so the container can be **unprivileged with nesting off**.

> ## Read this first
>
> The adversarial security audit for this build is **incomplete**. It has found
> and closed real issues — three authorization gaps where holding a permission
> *anywhere* satisfied a route governing the whole directory, and a catalog
> drift that made a live outbound integration impossible to disable through the
> API. But two audit dimensions never ran and roughly twenty findings are still
> unverified.
>
> Installing this on an internal or lab network is reasonable. Exposing it to
> untrusted users is not, yet. `docs/superpowers/security-audit-input.md` tracks
> what is known.

## What you need

- A Proxmox host (or any Ubuntu 24.04 machine, for the manual path)
- **An existing Keycloak** you can create a realm in, and admin credentials for it
- A hostname for the console, e.g. `idm.lan`, resolvable to the container

## Quick path — Proxmox

On the Proxmox host, as root:

```bash
git clone https://github.com/ssan9876/identity-manager.git /tmp/idm
cd /tmp/idm

IDM_HOSTNAME=idm.lan \
KEYCLOAK_ISSUER=https://kc.example.com/realms/identity-manager \
bash scripts/proxmox-create-lxc.sh
```

That creates the container, clones the repo into `/opt/identity-manager`, and
runs the installer. It stops short of starting the service, because the service
cannot work until Keycloak is wired up — which is the next section.

Useful overrides: `CTID`, `CORES`, `RAM_MB`, `DISK_GB`, `STORAGE`, `BRIDGE`,
`NET_IP` (default `dhcp`), `REPO_BRANCH`.

## Connecting to your existing Keycloak

### Do not import the bundled realm file

`keycloak/realm-import/identity-manager-realm.json` is the **development**
realm. It contains:

- a user `admin@example.com` with the password `dev_password_change_me`
- `idm-sync-service` with the secret `idm_sync_dev_secret_change_me`
- `idm-test-client`, a public client with the password grant enabled

All of that is committed to a public repository. Importing it into a real
Keycloak creates a working account whose password anyone can read on GitHub.

Use the script instead. It builds the same realm through the Admin API with a
generated secret, no seeded human user, and no test client:

```bash
cd /opt/identity-manager

KEYCLOAK_URL=https://kc.example.com \
KC_ADMIN_USER=admin KC_ADMIN_PASS=... \
CONSOLE_URL=http://idm.lan \
bash scripts/keycloak-setup.sh
```

It is idempotent — re-running is safe, and it re-mints the client secret each
time.

### What it creates, and why

| Client | Type | Purpose |
|---|---|---|
| `idm-api` | confidential | The **audience**. Nobody logs into it; it exists so access tokens have an `aud` value the API can match against `KEYCLOAK_AUDIENCE`. |
| `idm-console` | public | Browser SSO for the web UI. Its `redirectUris`/`webOrigins` must be your real console URL. |
| `idm-sync-service` | confidential, service account | What the outbox worker authenticates as to create and update users in Keycloak. |

`idm-sync-service` gets exactly four `realm-management` client roles:

`manage-users`, `query-users`, `view-users`, `query-groups`

No more. The worker creates and updates users and reads groups; it never needs
`manage-realm` or `manage-clients`, which would let it alter the realm's own
security configuration.

`idm-console` also gets an **audience protocol mapper** injecting `idm-api` into
the access token. This is the single most commonly missed step when doing the
setup by hand, and its symptom is confusing: login succeeds, then every API call
returns 401, because the token carries no audience the API accepts.

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

**Without this, every request returns 403** — including the ones the UI would
need to fix it.

Authorization requires a local `users` row whose `username` matches your
Keycloak `preferred_username`, plus a role grant. A fresh install has neither,
and there is no path through the UI to create them, because doing so needs
exactly the permission you do not yet have.

```bash
cd /opt/identity-manager
sudo -u idm bash -c 'set -a && . .env && set +a && pnpm bootstrap:admin you@example.com'
```

That username must already exist in the Keycloak realm — it is how you log in.
Everyone *after* you gets created in this system and pushed out to Keycloak by
the sync worker; you are the one exception, because you have to be able to sign
in before you can create anybody.

`bootstrap:admin` is idempotent. Re-run it as often as you like.

Now open `http://idm.lan`.

## Manual path — any Ubuntu 24.04 machine

```bash
git clone https://github.com/ssan9876/identity-manager.git /opt/identity-manager
cd /opt/identity-manager

IDM_HOSTNAME=idm.lan \
KEYCLOAK_ISSUER=https://kc.example.com/realms/identity-manager \
bash scripts/install.sh
```

Then the Keycloak and bootstrap steps above.

## Reconfiguring after install

The web console's Keycloak issuer, client id and API base URL are **compiled
into the bundle** — Vite inlines them at build time rather than reading them at
runtime. Editing `.env` does not change them.

To change the console hostname or the Keycloak URL, rebuild:

```bash
cd /opt/identity-manager

# 1. update the build-time values
sudo -u idm tee apps/web/.env >/dev/null <<'EOF'
VITE_KEYCLOAK_ISSUER=https://kc.example.com/realms/identity-manager
VITE_KEYCLOAK_CLIENT_ID=idm-console
VITE_API_BASE_URL=https://idm.example.com
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

## TLS

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d idm.example.com
```

Then rebuild the bundle with the `https://` URL (step 1 above) — otherwise the
console keeps calling the API over `http://` and the browser blocks it as mixed
content.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Every request returns **403**, including as an admin | `bootstrap:admin` was never run. See above — this is expected, not a bug. |
| Login works, then every API call is **401** | The `idm-api` audience mapper is missing from `idm-console`. Re-run `keycloak-setup.sh`. |
| Keycloak shows **"Invalid redirect_uri"** | `idm-console`'s `redirectUris` do not match the URL you opened. Re-run `keycloak-setup.sh` with the right `CONSOLE_URL`. |
| Changed the Keycloak URL in `.env`, nothing happened | The console's copy is compiled in. See "Reconfiguring" above. |
| `idm-api` will not start | `KEYCLOAK_ADMIN_CLIENT_SECRET` is still the `CHANGEME…` placeholder. |
| Console loads, API unreachable | Check `systemctl status idm-api` and `journalctl -u idm-api -n 50`. |

Logs: `journalctl -u idm-api -f`

## How it is laid out

| | |
|---|---|
| Code | `/opt/identity-manager` |
| Config | `/opt/identity-manager/.env` (0640, owned by `idm`) |
| Service | `idm-api.service` — API **and** outbox worker in one process |
| Web bundle | `/opt/identity-manager/apps/web/dist`, served by nginx |
| Database | local PostgreSQL 16, database `identity_manager` |

**Two database roles, deliberately.** `idm_owner` owns the schema and is what
migrations run as; `idm_app` is what the application runs as, and is created
*by* the migration with reduced privileges — no `CREATE` on the schema, and no
`UPDATE`/`DELETE`/`TRUNCATE` on `audit_log`. That is what makes the audit log
append-only in a way the runtime is structurally incapable of violating, rather
than merely choosing not to. The README's "Database roles" section has the full
reasoning.

**One process runs the sync worker.** `SYNC_WORKER_ENABLED` defaults to true and
runs the outbox drain in-process with the API. If you ever run a second instance
behind a load balancer, set `SYNC_WORKER_ENABLED=false` there so only one
process drains the outbox.

**The API and console share one origin.** `main.ts` calls `enableCors` with
`http://localhost:5173` hardcoded, so a split-origin deployment would be refused
by the browser. nginx serves the bundle and proxies `/api` on the same host,
which makes CORS moot. The installer also firewalls the API's own port so it
cannot be reached directly, bypassing nginx.

## Upgrading

```bash
cd /opt/identity-manager
sudo -u idm git pull
sudo -u idm pnpm install --frozen-lockfile
sudo -u idm pnpm build
sudo -u idm bash -c 'set -a && . .env && set +a && pnpm --filter @idm/api db:migrate'
systemctl restart idm-api
```

Run `db:migrate` before restarting: it applies schema changes *and* re-asserts
the runtime role's grants, so a migration that adds a table also grants the
runtime role access to it.
