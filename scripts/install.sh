#!/usr/bin/env bash
# ============================================================================
# identity-manager — installer for Ubuntu 24.04 (LXC container, VM, or metal)
#
# Installs Node 20, PostgreSQL 16 and nginx; builds the API and web console;
# provisions the database roles; and registers a systemd service.
#
# Run as root, INSIDE the target machine:
#   IDM_HOSTNAME=idm.lan \
#   KEYCLOAK_ISSUER=https://kc.example.com/realms/identity-manager \
#   bash scripts/install.sh
#
# Optional environment variables:
#   IDM_SCHEME          http|https for the console URL (default HTTPS).
#                       http is only viable for a localhost-only install: the
#                       console needs a secure context to sign in at all.
#   KEYCLOAK_CA_CERT    path to a CA/self-signed cert for Keycloak. Required
#                       when Keycloak uses a self-signed certificate, or the
#                       API cannot fetch JWKS and every token 401s.
#   KEYCLOAK_AUDIENCE   default idm-api
#   KEYCLOAK_ADMIN_CLIENT_ID      default idm-sync-service
#   KEYCLOAK_ADMIN_CLIENT_SECRET  the sync client's secret; if omitted a
#                                 placeholder is written and the service is
#                                 left stopped until you set it
#   IDM_USER            service account to run as (default idm)
#   IDM_PORT            API listen port (default 3000, loopback-only via ufw)
#   SKIP_UFW=1          do not touch the firewall
#
# WHY THE KEYCLOAK VALUES ARE REQUIRED UP FRONT: Vite inlines
# VITE_KEYCLOAK_ISSUER / VITE_KEYCLOAK_CLIENT_ID / VITE_API_BASE_URL at BUILD
# time, so they are compiled into the web bundle rather than read at runtime.
# Changing them later requires a rebuild — see `reconfigure` in
# docs/05-installation.md.
# ============================================================================
set -Eeuo pipefail

RED=$'\e[31m'; GRN=$'\e[32m'; YLW=$'\e[33m'; BLU=$'\e[34m'; NC=$'\e[0m'
# All status output goes to STDERR, never stdout. These scripts capture
# function results with $(...), so a human-readable line printed to stdout
# silently becomes part of the captured value: keycloak-setup.sh's
# `upsert_client` returned its success message AND the uuid, producing a
# mangled Admin API URL. Only DATA belongs on stdout.
info() { echo "${BLU}==>${NC} $*" >&2; }
ok()   { echo "${GRN}✓${NC} $*" >&2; }
warn() { echo "${YLW}!${NC} $*" >&2; }
die()  { echo "${RED}✗ $*${NC}" >&2; exit 1; }
trap 'rc=$?; echo "${RED}✗ install failed (exit $rc) at line ${BASH_LINENO[0]}: ${BASH_COMMAND}${NC}" >&2' ERR

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

IDM_USER="${IDM_USER:-idm}"
IDM_PORT="${IDM_PORT:-3000}"
# HTTPS by default, and that is a functional requirement rather than a
# hardening preference: the console signs in with oidc-client-ts, which needs
# `crypto.subtle` for the PKCE challenge, and browsers only expose that in a
# SECURE CONTEXT (https, or localhost). Install over plain http on a LAN
# address and the Sign in button silently does nothing at all.
#
# IDM_SCHEME=http is still accepted for a localhost-only install, and warns.
IDM_SCHEME="${IDM_SCHEME:-https}"
KEYCLOAK_AUDIENCE="${KEYCLOAK_AUDIENCE:-idm-api}"
KEYCLOAK_ADMIN_CLIENT_ID="${KEYCLOAK_ADMIN_CLIENT_ID:-idm-sync-service}"
DB_NAME="identity_manager"
DB_OWNER="idm_owner"
DB_RUNTIME="idm_app"

# --- Preflight --------------------------------------------------------------
[[ $EUID -eq 0 ]] || die "run as root"
[[ -n "${IDM_HOSTNAME:-}" ]] || die "IDM_HOSTNAME is required (the console's hostname, e.g. idm.lan)"
[[ -n "${KEYCLOAK_ISSUER:-}" ]] || die "KEYCLOAK_ISSUER is required (e.g. https://kc.example.com/realms/identity-manager)"
[[ -f "$REPO_ROOT/pnpm-workspace.yaml" ]] || die "run this from inside the identity-manager repo"

case "$KEYCLOAK_ISSUER" in
  */realms/*) : ;;
  *) die "KEYCLOAK_ISSUER must include /realms/<name> — got: $KEYCLOAK_ISSUER" ;;
esac

CONSOLE_URL="${IDM_SCHEME}://${IDM_HOSTNAME}"
if [[ "$IDM_SCHEME" == "http" && "$IDM_HOSTNAME" != "localhost" && "$IDM_HOSTNAME" != "127.0.0.1" ]]; then
  warn "IDM_SCHEME=http on a non-localhost host: the console will load, but"
  warn "  signing in CANNOT work — crypto.subtle (needed for PKCE) is undefined"
  warn "  outside a secure context, so the Sign in button will do nothing."
  warn "  See docs/05-installation.md, \"TLS — required, not optional\"."
fi
info "installing identity-manager"
echo "    console : $CONSOLE_URL"
echo "    keycloak: $KEYCLOAK_ISSUER"
echo "    repo    : $REPO_ROOT"

# --- Packages ---------------------------------------------------------------
info "installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git nginx postgresql postgresql-contrib openssl >/dev/null

if ! command -v node >/dev/null || [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]]; then
  info "installing Node 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
corepack enable >/dev/null 2>&1 || npm install -g corepack >/dev/null
corepack prepare pnpm@9 --activate >/dev/null
ok "node $(node -v), pnpm $(pnpm -v)"

# --- Service account --------------------------------------------------------
if ! id -u "$IDM_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$IDM_USER"
  ok "created service user $IDM_USER"
fi

# --- Database ---------------------------------------------------------------
# Two roles, deliberately. The OWNER owns the schema and is what db:migrate
# connects as; the RUNTIME role is what the application connects as and is
# created BY the migration with reduced privileges (no CREATE on the schema, no
# UPDATE/DELETE/TRUNCATE on audit_log). See the README's "Database roles".
info "provisioning postgres"
systemctl enable --now postgresql >/dev/null 2>&1 || true

psql_su() { su - postgres -c "psql -tAc \"$1\""; }

if [[ -z "$(psql_su "SELECT 1 FROM pg_roles WHERE rolname='${DB_OWNER}'")" ]]; then
  DB_OWNER_PASS="$(openssl rand -hex 24)"
  psql_su "CREATE ROLE ${DB_OWNER} LOGIN PASSWORD '${DB_OWNER_PASS}' CREATEROLE"
  ok "created role ${DB_OWNER}"
else
  # Re-assert a known password so a re-run stays idempotent and the .env we
  # write below is guaranteed to match what Postgres will accept.
  DB_OWNER_PASS="$(openssl rand -hex 24)"
  psql_su "ALTER ROLE ${DB_OWNER} PASSWORD '${DB_OWNER_PASS}'"
  ok "rotated password for existing role ${DB_OWNER}"
fi

if [[ -z "$(psql_su "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'")" ]]; then
  su - postgres -c "createdb -O ${DB_OWNER} ${DB_NAME}"
  ok "created database ${DB_NAME}"
fi

# The runtime role does not need to exist yet — db:migrate creates it from
# RUNTIME_DATABASE_URL — but its password must be decided here so both the
# connection string and the role agree.
DB_RUNTIME_PASS="$(openssl rand -hex 24)"

# --- Application env --------------------------------------------------------
# Written 0640 and owned by the service user: it holds two database passwords
# and the Keycloak sync client secret.
info "writing configuration"
ENV_FILE="$REPO_ROOT/.env"
KC_SECRET="${KEYCLOAK_ADMIN_CLIENT_SECRET:-CHANGEME_RUN_keycloak-setup.sh}"

cat >"$ENV_FILE" <<EOF
# Generated by scripts/install.sh — do not commit.
# systemd reads this file directly (EnvironmentFile), so keep it to plain
# KEY=value lines with no shell quoting.
DATABASE_URL=postgres://${DB_OWNER}:${DB_OWNER_PASS}@localhost:5432/${DB_NAME}
RUNTIME_DATABASE_URL=postgres://${DB_RUNTIME}:${DB_RUNTIME_PASS}@localhost:5432/${DB_NAME}
KEYCLOAK_ISSUER=${KEYCLOAK_ISSUER}
KEYCLOAK_AUDIENCE=${KEYCLOAK_AUDIENCE}
KEYCLOAK_ADMIN_CLIENT_ID=${KEYCLOAK_ADMIN_CLIENT_ID}
KEYCLOAK_ADMIN_CLIENT_SECRET=${KC_SECRET}
PORT=${IDM_PORT}
SYNC_WORKER_ENABLED=true
DB_POOL_MAX=10
EOF
chown "$IDM_USER":"$IDM_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

# Vite reads .env from its OWN project directory, never the repo root, and
# inlines these at build time.
cat >"$REPO_ROOT/apps/web/.env" <<EOF
VITE_KEYCLOAK_ISSUER=${KEYCLOAK_ISSUER}
VITE_KEYCLOAK_CLIENT_ID=idm-console
# MUST include /api: nginx proxies the API at `location /api/`, and the console
# appends bare resource paths to this base. Without it every request goes to
# e.g. https://host/users, which the SPA fallback answers with index.html at
# HTTP 200 text/html — so the app parses HTML as JSON and every screen fails.
# Worse, /self/permissions fails the same way, the permission set parses as
# empty, and the console falsely reports that the user lacks every permission
# and renders no navigation at all. Nothing looks wrong in the network log
# because the status is 200; only the content type gives it away.
VITE_API_BASE_URL=${CONSOLE_URL}/api
EOF
ok "wrote .env and apps/web/.env"

# --- Build ------------------------------------------------------------------
info "installing dependencies (this takes a few minutes)"
chown -R "$IDM_USER":"$IDM_USER" "$REPO_ROOT"
su -s /bin/bash "$IDM_USER" -c "cd '$REPO_ROOT' && pnpm install --frozen-lockfile" >/dev/null
info "building"
su -s /bin/bash "$IDM_USER" -c "cd '$REPO_ROOT' && pnpm build" >/dev/null
[[ -f "$REPO_ROOT/apps/api/dist/src/main.js" ]] || die "API build produced no dist/src/main.js"
[[ -f "$REPO_ROOT/apps/web/dist/index.html" ]] || die "web build produced no dist/index.html"
ok "built API and web console"

# --- Migrate ----------------------------------------------------------------
# Also creates/asserts the runtime role and its grants, every run.
info "running migrations"
su -s /bin/bash "$IDM_USER" -c "cd '$REPO_ROOT' && set -a && . '$ENV_FILE' && set +a && pnpm --filter @idm/api db:migrate" >/dev/null
ok "database migrated, runtime role provisioned"

# --- systemd ----------------------------------------------------------------
info "installing systemd unit"
sed -e "s|@REPO_ROOT@|$REPO_ROOT|g" -e "s|@IDM_USER@|$IDM_USER|g" \
  "$REPO_ROOT/deploy/systemd/idm-api.service" >/etc/systemd/system/idm-api.service

# The lifecycle pass (joiner activation on start_date, leaver deactivation on
# end_date) is a oneshot script driven by a timer, not a daemon. Before this
# existed nothing on any host ever invoked it, so a joiner with a start date
# was never activated and every connector asserted them as a disabled
# account indefinitely.
for unit in idm-lifecycle.service idm-lifecycle.timer; do
  sed -e "s|@REPO_ROOT@|$REPO_ROOT|g" -e "s|@IDM_USER@|$IDM_USER|g" \
    "$REPO_ROOT/deploy/systemd/$unit" >"/etc/systemd/system/$unit"
done
# A self-signed Keycloak certificate makes Node refuse the JWKS fetch, and
# every token then fails verification with 401 despite being perfectly valid.
# NODE_EXTRA_CA_CERTS trusts THAT ONE certificate; NODE_TLS_REJECT_UNAUTHORIZED=0
# would disable verification for every outbound connection this process makes.
if [[ -n "${KEYCLOAK_CA_CERT:-}" ]]; then
  [[ -f "$KEYCLOAK_CA_CERT" ]] || die "KEYCLOAK_CA_CERT does not exist: $KEYCLOAK_CA_CERT"
  install -m 644 "$KEYCLOAK_CA_CERT" /usr/local/share/ca-certificates/keycloak.crt
  update-ca-certificates >/dev/null 2>&1 || true
  mkdir -p /etc/systemd/system/idm-api.service.d
  cat >/etc/systemd/system/idm-api.service.d/ca.conf <<EOF
[Service]
Environment="NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/keycloak.crt"
EOF
  ok "trusting the supplied Keycloak certificate for JWKS verification"
fi

systemctl daemon-reload
systemctl enable idm-api >/dev/null
# The TIMER, not the service: `systemctl enable` on a Type=oneshot unit asks
# systemd to run it once at boot and never again.
systemctl enable --now idm-lifecycle.timer >/dev/null

# --- nginx ------------------------------------------------------------------
# Console and API are served from ONE origin. That is deliberate: the API calls
# enableCors with a hardcoded http://localhost:5173 origin, so a split-origin
# deployment would be refused by the browser. Same-origin means CORS never
# applies at all.
# Generate a self-signed certificate when running https and none was supplied.
# Certbot cannot issue for a bare IP, and a lab install addressed by IP still
# needs TLS for the console to be able to sign in at all.
if [[ "$IDM_SCHEME" == "https" ]]; then
  TLS_DIR=/etc/nginx/tls
  mkdir -p "$TLS_DIR"
  if [[ ! -f "$TLS_DIR/idm.crt" ]]; then
    # IP in subjectAltName as well as CN — browsers ignore CN for
    # IP-addressed hosts, so a CN-only certificate is rejected outright.
    SAN="DNS:${IDM_HOSTNAME}"
    [[ "$IDM_HOSTNAME" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && SAN="IP:${IDM_HOSTNAME}"
    openssl req -x509 -newkey rsa:2048 -nodes -days 825       -subj "/CN=${IDM_HOSTNAME}" -addext "subjectAltName=${SAN}"       -keyout "$TLS_DIR/idm.key" -out "$TLS_DIR/idm.crt" 2>/dev/null
    chmod 600 "$TLS_DIR/idm.key"
    ok "generated a self-signed certificate for ${IDM_HOSTNAME}"
    warn "self-signed: browsers will warn once. Replace with certbot for a real hostname."
  fi
fi

info "configuring nginx"
# http-context snippet first: it defines the `idm_noquery` access-log format
# (query strings and referrer query strings stripped, so people's names and
# email addresses stop being written to /var/log/nginx in plaintext — finding
# CS-L3). Both vhosts reference that format, and `log_format`/`map` are only
# valid at http level, so it goes in conf.d, which nginx.conf includes before
# sites-enabled. Without it `nginx -t` below fails outright rather than
# quietly falling back to logging the query strings.
cp "$REPO_ROOT/deploy/nginx/idm-log.conf" /etc/nginx/conf.d/idm-log.conf
if [[ "$IDM_SCHEME" == "https" ]]; then
  sed -e "s|@REPO_ROOT@|$REPO_ROOT|g" -e "s|@IDM_HOSTNAME@|$IDM_HOSTNAME|g" \
      -e "s|@IDM_PORT@|$IDM_PORT|g" -e "s|@TLS_CERT@|${TLS_DIR}/idm.crt|g" \
      -e "s|@TLS_KEY@|${TLS_DIR}/idm.key|g" \
      "$REPO_ROOT/deploy/nginx/idm-tls.conf" >/etc/nginx/sites-available/idm.conf
else
  sed -e "s|@REPO_ROOT@|$REPO_ROOT|g" -e "s|@IDM_HOSTNAME@|$IDM_HOSTNAME|g" -e "s|@IDM_PORT@|$IDM_PORT|g" \
    "$REPO_ROOT/deploy/nginx/idm.conf" >/etc/nginx/sites-available/idm.conf
fi
ln -sf /etc/nginx/sites-available/idm.conf /etc/nginx/sites-enabled/idm.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t >/dev/null || die "nginx config rejected"
systemctl reload nginx
ok "nginx serving $CONSOLE_URL"

# --- Firewall ---------------------------------------------------------------
# The API binds 0.0.0.0 (Nest's default), so without this it is reachable
# directly on :$IDM_PORT, bypassing nginx entirely.
if [[ "${SKIP_UFW:-0}" != "1" ]] && command -v ufw >/dev/null; then
  ufw allow 22/tcp >/dev/null 2>&1 || true
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw deny "${IDM_PORT}/tcp" >/dev/null 2>&1 || true
  yes | ufw enable >/dev/null 2>&1 || true
  ok "firewall: 22/80/443 open, ${IDM_PORT} blocked from the network"
else
  warn "firewall not configured — port ${IDM_PORT} exposes the API directly, bypassing nginx"
fi

# --- Done -------------------------------------------------------------------
echo
if [[ "$KC_SECRET" == CHANGEME* ]]; then
  systemctl stop idm-api >/dev/null 2>&1 || true
  warn "service left STOPPED: no Keycloak client secret yet."
  echo
  echo "Next:"
  echo "  1. Wire up Keycloak (creates the realm + 3 clients, mints a secret):"
  echo "       bash scripts/keycloak-setup.sh"
  echo "  2. Put the printed secret into KEYCLOAK_ADMIN_CLIENT_SECRET in $ENV_FILE"
  echo "  3. systemctl start idm-api"
  echo "  4. sudo -u $IDM_USER bash -c 'cd $REPO_ROOT && set -a && . .env && set +a && pnpm bootstrap:admin <your-keycloak-username>'"
  echo "  5. Open $CONSOLE_URL"
else
  systemctl restart idm-api
  ok "idm-api started"
  echo
  echo "Next:"
  echo "  1. Grant yourself access — WITHOUT THIS EVERY REQUEST IS 403:"
  echo "       sudo -u $IDM_USER bash -c 'cd $REPO_ROOT && set -a && . .env && set +a && pnpm bootstrap:admin <your-keycloak-username>'"
  echo "  2. Open $CONSOLE_URL"
fi
echo
warn "SECURITY: the adversarial audit for this build is incomplete — see"
warn "docs/05-installation.md. Do not expose this to untrusted users."
