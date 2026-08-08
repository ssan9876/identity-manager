# Mail Server Transport

How this system reaches the mail server's provisioning API when the two run on
**separate hosts** — this system internal, the mail server on a public VPS.

Design: `docs/superpowers/specs/2026-08-07-mail-server-connector-implementation-design.md`.
Counterpart contract: `D:\mail-server\docs\superpowers\specs\2026-08-06-idm-sync-design.md`.

## Why a tunnel, and not just HTTPS

The mail server's provisioning security argument is one sentence: **a leaked
token is useless from outside**. It holds because nginx blocks
`/api/v1/provisioning` (`docker/nginx/templates/10-https.conf.template`) and
those routes are reachable only on its `internal` Docker bridge network. Its
own spec adds that if provisioning is ever exposed beyond that network, rate
limiting stops being optional — there is no `@limiter.limit` on those routes,
and nginx's limiter never sees them because the public block returns 404 first.

Separate hosts means either recreating that private network or replacing the
argument. WireGuard recreates it: the provisioning port never touches the
public internet, so the sentence above stays literally true.

Traffic is **outbound from this system** — it pushes, the mail server never
calls back — so this host being behind NAT is fine.

## 1. WireGuard

The VPS is the server (it holds the public IP); this host is a peer that dials
out.

On both hosts:

```bash
wg genkey | tee privatekey | wg pubkey > publickey
```

On the **VPS** — `/etc/wireguard/wg0.conf`:

```ini
[Interface]
Address = 10.8.0.1/24
ListenPort = 51820
PrivateKey = <vps-private-key>

[Peer]
# The identity manager
PublicKey = <idm-public-key>
AllowedIPs = 10.8.0.2/32
```

On **this host** — `/etc/wireguard/wg0.conf`:

```ini
[Interface]
Address = 10.8.0.2/24
PrivateKey = <idm-private-key>

[Peer]
PublicKey = <vps-public-key>
Endpoint = <vps-public-ip>:51820
AllowedIPs = 10.8.0.1/32
# Holds the tunnel open through NAT, since this side always initiates.
PersistentKeepalive = 25
```

Bring it up on both (`wg-quick up wg0`, then `systemctl enable wg-quick@wg0`)
and confirm from this host:

```bash
ping -c1 10.8.0.1
```

Open `51820/udp` on the VPS firewall. Do **not** open any other port for this.

## 2. nginx server block on the VPS

Add a **second** server block bound to the tunnel address. The public block
keeps its `location ^~ /api/v1/provisioning { return 404; }` untouched — this
is a separate listener, not a hole in the first one.

`docker/nginx/templates/20-provisioning.conf.template` in the mail-server repo:

```nginx
server {
    listen ${WIREGUARD_ADDRESS}:80;
    server_name _;

    limit_req zone=provisioning burst=20 nodelay;

    location /api/v1/provisioning {
        proxy_pass http://backend:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        return 404;
    }
}
```

With the zone declared alongside the existing ones at http level:

```nginx
limit_req_zone $binary_remote_addr zone=provisioning:1m rate=30r/s;
```

The rate limit is not decoration — it closes the gap the counterpart's own spec
flags against itself, now that provisioning is reachable from beyond its
internal network.

The nginx container must be able to reach the tunnel address; publish the
proxy on the host's `10.8.0.1` rather than `0.0.0.0`.

## 3. Issue a service token

On the mail server, as a superadmin:

```bash
curl -X POST https://<mail-host>/api/v1/idm/tokens \
  -H "Authorization: Bearer <superadmin-jwt>" \
  -H 'Content-Type: application/json' \
  -d '{"name":"identity-manager"}'
```

The raw token is returned **exactly once** — that side stores only its SHA-256
hash. Put it in this repo's environment:

```bash
MAIL_SERVER_SERVICE_TOKEN=<the raw token>
```

It is referenced by NAME from `connector_targets.config`, never stored in this
database and never logged (`connectors/secrets.ts`).

## 4. Configure the target

```sql
INSERT INTO connector_targets (target, enabled, config)
VALUES (
  'mail_server',
  true,
  '{"baseUrl":"http://10.8.0.1/api/v1","tokenSecretName":"MAIL_SERVER_SERVICE_TOKEN"}'::jsonb
);
```

**This row cannot be created by a migration.** Postgres forbids using an enum
value inside the transaction that added it, and all pending migrations run in
one transaction on a fresh database — migration 0017 is what adds
`'mail_server'` to `outbox_target`. Every other non-keycloak target is
configured the same way, for the same reason.

Optional `config` keys: `requestTimeoutMs` (defaults to 10000).

## 5. Verify

```bash
pnpm --filter @idm/api target-reconcile -- --target mail_server --dry-run
```

Expect a plan, not a connection error. `MissingSecretError` means the env var
is unset; a `403` means the token is wrong or revoked.

Then the contract check — one real round trip, proving what this connector
builds is what the mail server accepts:

```bash
MAIL_SERVER_BASE_URL=http://10.8.0.1/api/v1 \
MAIL_SMOKE_EMAIL=idm-smoke@<a-domain-hosted-there> \
pnpm --filter @idm/api smoke:mail
```

Expect three lines: health ok, upsert accepted, re-push accepted. A `422`
naming a domain means `MAIL_SMOKE_EMAIL` is in a domain the mail server does
not host — it never auto-creates domains. The smoke identity is created
`suspended`, never active, so it is not a deliverable mailbox.

## Alternative considered

**Cloudflare Tunnel with an Access service token** is a close second, and
better if `cloudflared` is already running: consistent with the DNS automation
and hybrid-deployment path already in that repo, no inbound ports, a second
independent auth layer in front of the mail server's own token, and
Cloudflare's rate limiting satisfies the requirement above for free. It was
not chosen only because it puts a third party in the provisioning path for no
benefit WireGuard does not already provide between two hosts you control.

**Public HTTPS with mTLS** was rejected: it genuinely exposes provisioning to
the internet, puts the most work on the mail side, and one nginx slip means it
is open.

## What this does NOT cover

Phase 2 — Keycloak OIDC for the mail dashboard and portal, and per-device app
passwords — needs Keycloak reachable from **users' browsers**, which is a
public exposure this document deliberately does not set up. That collides with
this repo's own deployment gate (see README's SECURITY STATUS) and should be
decided deliberately when phase 2 is specced.
