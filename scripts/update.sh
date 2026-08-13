#!/usr/bin/env bash
# ============================================================================
# identity-manager — in-place updater for an installed host
#
# Run as root, INSIDE the machine scripts/install.sh installed:
#   bash /opt/identity-manager/scripts/update.sh
#
# It pulls, rebuilds, migrates, RE-RENDERS deploy/ onto the machine, restarts
# the service and verifies the result.
#
# WHY THIS EXISTS RATHER THAN A DOCUMENTED git pull. The obvious upgrade —
# pull, install, build, migrate, restart — is incomplete in a way that fails
# SILENTLY (docs/11-operations.md, "Upgrading a deployed host"). `deploy/` is a
# set of TEMPLATES; nothing copies them onto a running host except install.sh.
# So an upgrade that pulls the CS-M1 security-header fix and the CS-L3
# log-format fix, then only restarts idm-api, leaves the console serving no
# X-Frame-Options / X-Content-Type-Options / Referrer-Policy and still writing
# people's names and email addresses into /var/log/nginx/access.log. Both were
# confirmed absent after a pull-only upgrade. Everything below deploy/ is
# re-rendered here, every run.
#
# WHY IT DISCOVERS ITS PARAMETERS INSTEAD OF TAKING THEM. The manual re-render
# in the docs asks the operator to substitute the hostname, port and
# certificate paths this host was installed with. Getting one wrong rewrites
# the vhost to serve a DIFFERENT server_name, at which point requests fall
# through to another server block and the console appears to break with no
# error anywhere. They are read back off the installed unit and vhost instead.
#
# Optional environment variables:
#   SKIP_PULL=1        do not touch git — rebuild and re-render what is on disk
#   REPO_BRANCH        branch to pull (default: the checked-out branch)
#   SKIP_DB_BACKUP=1   do not pg_dump before migrating
#   BACKUP_DIR         default /var/backups/identity-manager
#   BACKUP_KEEP        pre-update dumps to keep (default 7)
#   DEBUG=1            set -x
# ============================================================================
set -Eeuo pipefail

RED=$'\e[31m'; GRN=$'\e[32m'; YLW=$'\e[33m'; BLU=$'\e[34m'; NC=$'\e[0m'
# All status output goes to STDERR, never stdout — the same rule install.sh and
# keycloak-setup.sh follow. These scripts capture results with $(...), so a
# human-readable line on stdout silently becomes part of a captured value.
info() { echo "${BLU}==>${NC} $*" >&2; }
ok()   { echo "${GRN}✓${NC} $*" >&2; }
warn() { echo "${YLW}!${NC} $*" >&2; }
die()  { echo "${RED}✗ $*${NC}" >&2; exit 1; }
[[ "${DEBUG:-0}" == "1" ]] && set -x

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
NGINX_VHOST=/etc/nginx/sites-available/idm.conf
UNIT_FILE=/etc/systemd/system/idm-api.service
BACKUP_DIR="${BACKUP_DIR:-/var/backups/identity-manager}"

# Nothing used to remove these, so every upgrade this host ever ran left a dump
# behind for good. That does not fail when the disk fills; it fails the NEXT
# upgrade, at the exact moment the dump is the only way back from a
# forward-only migration. Seven matches scripts/backup.sh — see there for why.
BACKUP_KEEP="${BACKUP_KEEP:-7}"
# Validated rather than trusted: this number is the only thing standing between
# the prune loop and an empty backup directory, so BACKUP_KEEP=0 or a typo like
# BACKUP_KEEP=7d must not be read as "delete every dump".
[[ "$BACKUP_KEEP" =~ ^[1-9][0-9]*$ ]] \
  || die "BACKUP_KEEP must be a positive integer, got '$BACKUP_KEEP'"

# Set as soon as the pull has happened, so the ERR trap can print an accurate
# rollback. Empty before that, which is exactly when there is nothing to undo.
PREV_COMMIT=""

on_err() {
  local rc=$? line=${BASH_LINENO[0]} cmd=$BASH_COMMAND
  echo >&2
  echo "${RED}✗ update failed (exit $rc) at line ${line}: ${cmd}${NC}" >&2
  echo >&2
  if [[ -n "$PREV_COMMIT" ]]; then
    warn "the checkout has already moved. To put this host back:"
    echo "    cd $REPO_ROOT" >&2
    echo "    sudo -u ${IDM_USER:-idm} git checkout $PREV_COMMIT" >&2
    echo "    sudo SKIP_PULL=1 bash scripts/update.sh" >&2
    echo >&2
    warn "APPLIED MIGRATIONS ARE NOT ROLLED BACK. Migrations are forward-only;"
    warn "  there are no down-migrations in this repository. If the failure was"
    warn "  in db:migrate, restore the dump this run took (path printed above)"
    warn "  before running an older build against the database."
  fi
}
trap on_err ERR

# --- Preflight --------------------------------------------------------------
[[ $EUID -eq 0 ]] || die "run as root"
[[ -f "$REPO_ROOT/pnpm-workspace.yaml" ]] || die "run this from inside the identity-manager repo"
[[ -f "$ENV_FILE" ]] || die "no .env at $ENV_FILE — this host has not been installed; run scripts/install.sh"
[[ -f "$UNIT_FILE" ]] || die "no $UNIT_FILE — this host has not been installed; run scripts/install.sh"
[[ -f "$NGINX_VHOST" ]] || die "no $NGINX_VHOST — this host has not been installed; run scripts/install.sh"

# --- Discover what this host was installed with -----------------------------
# Read back rather than asked for: see the header. Every one of these is fatal
# if missing, because guessing a default here rewrites a working vhost or unit
# into one that points somewhere else.
IDM_USER="$(sed -n 's/^User=//p' "$UNIT_FILE" | head -1)"
[[ -n "$IDM_USER" ]] || die "could not read User= from $UNIT_FILE"
id -u "$IDM_USER" >/dev/null 2>&1 || die "service user '$IDM_USER' from $UNIT_FILE does not exist"

IDM_PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" | head -1)"
IDM_PORT="${IDM_PORT:-3000}"

IDM_HOSTNAME="$(sed -n 's/^[[:space:]]*server_name[[:space:]]\+\([^;]*\);.*/\1/p' "$NGINX_VHOST" | head -1)"
[[ -n "$IDM_HOSTNAME" ]] || die "could not read server_name from $NGINX_VHOST"

# The scheme is a property of the INSTALLED vhost, not a preference: picking
# the wrong template swaps a TLS vhost for a plaintext one, and the console
# then cannot sign in at all (crypto.subtle, needed for PKCE, is undefined
# outside a secure context).
if grep -q '^[[:space:]]*ssl_certificate[[:space:]]' "$NGINX_VHOST"; then
  IDM_SCHEME=https
  TLS_CERT="$(sed -n 's/^[[:space:]]*ssl_certificate[[:space:]]\+\([^;]*\);.*/\1/p' "$NGINX_VHOST" | head -1)"
  TLS_KEY="$(sed -n 's/^[[:space:]]*ssl_certificate_key[[:space:]]\+\([^;]*\);.*/\1/p' "$NGINX_VHOST" | head -1)"
  [[ -f "$TLS_CERT" ]] || die "vhost references a certificate that does not exist: $TLS_CERT"
  [[ -f "$TLS_KEY"  ]] || die "vhost references a key that does not exist: $TLS_KEY"
else
  IDM_SCHEME=http
  TLS_CERT=""; TLS_KEY=""
fi
CONSOLE_URL="${IDM_SCHEME}://${IDM_HOSTNAME}"

info "updating identity-manager"
echo "    repo    : $REPO_ROOT" >&2
echo "    console : $CONSOLE_URL" >&2
echo "    service : $IDM_USER, port $IDM_PORT" >&2

# --- Pull -------------------------------------------------------------------
# Run as the service user, not root. install.sh chowns the whole checkout to
# the service user, and a root-run pull writes root-owned objects into .git —
# after which every later `sudo -u idm git ...` fails on permissions, and git
# refuses the repository as dubiously owned.
git_as_idm() { su -s /bin/bash "$IDM_USER" -c "cd '$REPO_ROOT' && git $*"; }

if [[ "${SKIP_PULL:-0}" == "1" ]]; then
  # Both paths set SKIP_PULL, so distinguish them: after a hand-over the tree
  # HAS just been pulled, and saying otherwise sends someone reading the log
  # looking for why their upgrade did not fetch anything.
  if [[ -n "${IDM_UPDATE_REEXECED:-}" ]]; then
    info "continuing under the updated scripts/update.sh"
  else
    warn "SKIP_PULL=1 — rebuilding and re-rendering whatever is on disk"
  fi
  # After a re-exec this must stay the commit the host was on BEFORE the pull,
  # not the one it has now, or the rollback advice points at the broken build.
  PREV_COMMIT="${IDM_UPDATE_PREV_COMMIT:-$(git_as_idm rev-parse HEAD)}"
else
  BRANCH="${REPO_BRANCH:-$(git_as_idm rev-parse --abbrev-ref HEAD)}"
  [[ "$BRANCH" != "HEAD" ]] || die "the checkout is on a detached HEAD; pass REPO_BRANCH=<branch>"
  PREV_COMMIT="$(git_as_idm rev-parse HEAD)"

  # A dirty checkout is a hand-edit somebody made on this host. Refuse rather
  # than blow it away: --ff-only would fail anyway, and less informatively.
  if [[ -n "$(git_as_idm status --porcelain)" ]]; then
    git_as_idm status --short >&2
    die "the checkout has local modifications (above). Commit, stash or revert them first."
  fi

  info "pulling origin/$BRANCH"
  # --ff-only: never create a merge commit on a deployed host. If the branch
  # has diverged, that is a situation for a human, not for a resolver.
  git_as_idm fetch --quiet origin "$BRANCH"
  git_as_idm merge --ff-only "origin/$BRANCH" >&2
  NEW_COMMIT="$(git_as_idm rev-parse HEAD)"

  if [[ "$PREV_COMMIT" == "$NEW_COMMIT" ]]; then
    ok "already up to date at ${NEW_COMMIT:0:9} — continuing anyway to re-assert deploy/ and rebuild"
  else
    ok "$(git_as_idm rev-list --count "$PREV_COMMIT..$NEW_COMMIT") commit(s): ${PREV_COMMIT:0:9} → ${NEW_COMMIT:0:9}"
  fi
fi

# --- Re-exec if the pull changed THIS script --------------------------------
# bash reads a script incrementally, by byte offset, as it executes. The pull
# above can replace this very file mid-run, after which bash keeps reading at
# its old offset into different content — in the benign case finishing the run
# on the OLD logic, in the ugly case resuming mid-line and executing a fragment.
#
# Observed on 2026-08-10: a run pulled a fix to the verification block and then
# executed the PRE-fix verifier, reporting failures the pulled commit had been
# written to eliminate. The update had worked; the script reporting on it was a
# version that no longer existed on disk.
#
# So: if the pull moved scripts/update.sh, hand over to the new copy. SKIP_PULL
# stops the second process pulling again, and IDM_UPDATE_REEXECED makes the
# hand-over happen at most once.
if [[ -z "${IDM_UPDATE_REEXECED:-}" && -n "${NEW_COMMIT:-}" && "$PREV_COMMIT" != "$NEW_COMMIT" ]]    && ! git_as_idm diff --quiet "$PREV_COMMIT" "$NEW_COMMIT" -- scripts/update.sh; then
  info "scripts/update.sh changed in this pull — re-executing the new version"
  export IDM_UPDATE_REEXECED=1
  export IDM_UPDATE_PREV_COMMIT="$PREV_COMMIT"
  export SKIP_PULL=1
  exec bash "$REPO_ROOT/scripts/update.sh"
fi

# --- Build-time console configuration --------------------------------------
# Vite inlines these at BUILD time. The rebuild below is what bakes them into
# the bundle, so a missing apps/web/.env does not fail — it produces a console
# with an undefined issuer and API base that loads and then 401s, or parses
# index.html as JSON on every screen. Regenerate it from the values this host
# is demonstrably installed with rather than letting that through.
WEB_ENV="$REPO_ROOT/apps/web/.env"
if [[ ! -f "$WEB_ENV" ]]; then
  KC_ISSUER="$(sed -n 's/^KEYCLOAK_ISSUER=//p' "$ENV_FILE" | head -1)"
  [[ -n "$KC_ISSUER" ]] || die "apps/web/.env is missing and KEYCLOAK_ISSUER is not in $ENV_FILE — cannot rebuild the console"
  warn "apps/web/.env was missing; regenerating from $ENV_FILE and the installed vhost"
  cat >"$WEB_ENV" <<EOF
VITE_KEYCLOAK_ISSUER=${KC_ISSUER}
VITE_KEYCLOAK_CLIENT_ID=idm-console
# MUST include /api — nginx proxies the API at its own /api/ location.
VITE_API_BASE_URL=${CONSOLE_URL}/api
EOF
  chown "$IDM_USER":"$IDM_USER" "$WEB_ENV"
fi

# --- Dependencies and build -------------------------------------------------
# Ownership first: a pull can introduce files, and anything root-owned inside
# the checkout breaks the unprivileged build.
chown -R "$IDM_USER":"$IDM_USER" "$REPO_ROOT"

info "installing dependencies"
su -s /bin/bash "$IDM_USER" -c "cd '$REPO_ROOT' && pnpm install --frozen-lockfile" >/dev/null

info "building (several minutes)"
su -s /bin/bash "$IDM_USER" -c "cd '$REPO_ROOT' && pnpm build" >/dev/null
# Assert the artifacts rather than trusting the exit code: a build that emits
# nothing leaves the OLD dist in place, and the service then restarts happily
# onto the previous version while this script reports success.
[[ -f "$REPO_ROOT/apps/api/dist/src/main.js" ]] || die "API build produced no dist/src/main.js"
[[ -f "$REPO_ROOT/apps/web/dist/index.html" ]] || die "web build produced no dist/index.html"
ok "built API and console"

# --- Database ---------------------------------------------------------------
# Keep the newest $BACKUP_KEEP dumps of ONE kind and delete the rest.
#
# Per kind, not per directory: the pre-update dumps and the scheduled dailies
# idm-backup.timer takes share $BACKUP_DIR, and a single combined count would
# let an afternoon of upgrades evict every scheduled backup. The file you want
# when a host dies is exactly the one a burst of unrelated activity would
# delete first.
#
# Ordering comes from the shell's glob sort rather than mtime: the names carry
# an ISO-8601 UTC stamp whose lexical order IS its chronological order, and
# that survives being copied off the box — mtime does not.
prune_dumps() {
  local kind="$1"
  local -a dumps=()
  shopt -s nullglob
  dumps=("$BACKUP_DIR/${DB_NAME}-"*"-${kind}.sql.gz")
  shopt -u nullglob
  local excess=$(( ${#dumps[@]} - BACKUP_KEEP ))
  (( excess > 0 )) || return 0
  rm -f -- "${dumps[@]:0:excess}"
  info "pruned $excess old ${kind} dump(s), keeping the newest $BACKUP_KEEP"
}

# Before migrating, not after: migrations in this repository are forward-only
# and there are no down-migrations, so this dump is the only way back.
if [[ "${SKIP_DB_BACKUP:-0}" != "1" ]]; then
  info "backing up the database"
  # Owned by postgres, not root: idm-backup.service writes its scheduled dumps
  # into this same directory as the postgres user, under ProtectSystem=strict
  # with no way to create it itself. `install -d` re-applies owner and mode to
  # a directory that already exists, so this also migrates hosts installed
  # before the backup timer existed. 0700 keeps it to postgres and root.
  install -d -m 0700 -o postgres -g postgres "$BACKUP_DIR"
  DB_NAME="$(sed -n 's#^DATABASE_URL=.*/\([^/?]*\).*#\1#p' "$ENV_FILE" | head -1)"
  DB_NAME="${DB_NAME:-identity_manager}"
  BACKUP_FILE="$BACKUP_DIR/${DB_NAME}-$(date -u +%Y%m%dT%H%M%SZ)-pre-update.sql.gz"
  su - postgres -c "pg_dump --no-owner '$DB_NAME'" | gzip >"$BACKUP_FILE.part"
  chmod 0600 "$BACKUP_FILE.part"
  # Renamed only once pg_dump AND gzip have both exited 0 (pipefail). A dump
  # truncated by a full disk carrying the final name does not merely look like
  # a backup — retention below would count it as one of the ones worth keeping.
  mv "$BACKUP_FILE.part" "$BACKUP_FILE"
  ok "dumped to $BACKUP_FILE"
  prune_dumps pre-update
else
  warn "SKIP_DB_BACKUP=1 — no dump taken; forward-only migrations have no way back"
fi

info "running migrations"
# Also re-asserts the runtime role and its grants, every run — including the
# audit_log revocations that are half of what keeps that table append-only.
su -s /bin/bash "$IDM_USER" -c "cd '$REPO_ROOT' && set -a && . '$ENV_FILE' && set +a && pnpm --filter @idm/api db:migrate" >/dev/null
ok "database migrated, runtime role re-asserted"

# --- Re-render deploy/ ------------------------------------------------------
# The step a plain git pull does not do. See the header.
info "re-rendering systemd units"
# Every unit in the directory, not a hardcoded list: a release that adds a
# timer would otherwise land on disk in the repo and never reach systemd.
for unit_path in "$REPO_ROOT"/deploy/systemd/*; do
  unit="$(basename "$unit_path")"
  sed -e "s|@REPO_ROOT@|$REPO_ROOT|g" -e "s|@IDM_USER@|$IDM_USER|g" \
    "$unit_path" >"/etc/systemd/system/$unit"
done
systemctl daemon-reload
# Enable any timer that is not enabled yet — same reasoning as the loop above,
# and enabling an already-enabled timer is a no-op.
for timer_path in "$REPO_ROOT"/deploy/systemd/*.timer; do
  [[ -e "$timer_path" ]] || continue
  timer="$(basename "$timer_path")"
  systemctl enable --now "$timer" >/dev/null 2>&1 || warn "could not enable $timer"
done
# The CA drop-in, propagated to every Node unit that talks to Keycloak.
#
# THE SAME CLASS OF SILENT GAP THIS SCRIPT'S HEADER IS ABOUT, one level down.
# install.sh used to write this drop-in for `idm-api` alone, because the
# failure it was written for was the API's JWKS fetch — but `reconcile-cli`
# and `lifecycle-cli` call Keycloak's Admin API too, and they run from TIMERS,
# where a failure is one nobody is watching. On a real deployment
# `idm-reconcile` had been failing every scheduled run with
# `[reconcile] failed: fetch failed` (Node's DEPTH_ZERO_SELF_SIGNED_CERT),
# which meant drift correction had quietly stopped.
#
# install.sh now writes all three, but a host installed BEFORE that fix only
# ever runs this script — so the repair belongs here too, or those hosts stay
# broken forever. Keyed off the API's own drop-in, which is the record of what
# the operator supplied at install time; nothing is invented when no
# certificate was ever configured.
API_CA_DROPIN=/etc/systemd/system/idm-api.service.d/ca.conf
if [[ -f "$API_CA_DROPIN" ]]; then
  ca_repaired=0
  for unit in idm-reconcile idm-lifecycle; do
    dropin="/etc/systemd/system/${unit}.service.d/ca.conf"
    if [[ ! -f "$dropin" ]]; then
      mkdir -p "$(dirname "$dropin")"
      cp "$API_CA_DROPIN" "$dropin"
      ca_repaired=1
    fi
  done
  if (( ca_repaired )); then
    systemctl daemon-reload
    ok "propagated the Keycloak CA trust to the reconcile and lifecycle units"
  fi
fi

ok "systemd units re-rendered and reloaded"

info "re-rendering nginx"
cp "$REPO_ROOT/deploy/nginx/idm-log.conf" /etc/nginx/conf.d/idm-log.conf
if [[ "$IDM_SCHEME" == "https" ]]; then
  sed -e "s|@REPO_ROOT@|$REPO_ROOT|g" -e "s|@IDM_HOSTNAME@|$IDM_HOSTNAME|g" \
      -e "s|@IDM_PORT@|$IDM_PORT|g" -e "s|@TLS_CERT@|$TLS_CERT|g" \
      -e "s|@TLS_KEY@|$TLS_KEY|g" \
      "$REPO_ROOT/deploy/nginx/idm-tls.conf" >"$NGINX_VHOST"
else
  sed -e "s|@REPO_ROOT@|$REPO_ROOT|g" -e "s|@IDM_HOSTNAME@|$IDM_HOSTNAME|g" \
      -e "s|@IDM_PORT@|$IDM_PORT|g" \
      "$REPO_ROOT/deploy/nginx/idm.conf" >"$NGINX_VHOST"
fi
# install.sh symlinks the vhost into sites-enabled; re-assert it here. A host
# whose symlink was removed by hand re-renders sites-available happily, passes
# nginx -t, reloads, and serves none of it — the same silent no-op this whole
# script exists to close, one directory further along.
ln -sf "$NGINX_VHOST" /etc/nginx/sites-enabled/idm.conf
nginx -t >/dev/null 2>&1 || { nginx -t >&2; die "nginx rejected the re-rendered config"; }
systemctl reload nginx
ok "nginx re-rendered and reloaded"

# --- Restart ----------------------------------------------------------------
info "restarting idm-api"
systemctl restart idm-api

# --- Verify -----------------------------------------------------------------
# Evidence, not assertion. Every check below has a failure mode this project
# has actually hit.
info "verifying"
FAILED=0

for _ in $(seq 1 30); do
  systemctl is-active --quiet idm-api && break
  sleep 1
done
if systemctl is-active --quiet idm-api; then
  ok "idm-api is active"
else
  warn "idm-api is NOT active — journalctl -u idm-api -n 50 --no-pager"
  FAILED=1
fi

# Against the API directly: isolates "the app is up" from "nginx routes to it".
#
# POLLED, not sampled once. `systemctl is-active` above reports a Type=simple
# unit as active the moment the process is forked, but Nest needs several more
# seconds to bind the port. Verified on a real host 2026-08-10: the one-shot
# version printed "did NOT respond" for a service whose /health answered 200 a
# few seconds later, so a perfectly good upgrade reported failure.
API_OK=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "http://127.0.0.1:${IDM_PORT}/health" >/dev/null 2>&1; then
    API_OK=1; break
  fi
  sleep 1
done
if [[ "$API_OK" == "1" ]]; then
  ok "API health endpoint responding on :${IDM_PORT}"
else
  warn "API health endpoint did NOT respond on :${IDM_PORT} after 60s"
  warn "  journalctl -u idm-api -n 50 --no-pager"
  FAILED=1
fi

# Through nginx, with the REAL Host header. The vhost is selected by
# server_name, so a request to 127.0.0.1 without it is answered by a different
# server block — which is how a working host can appear to serve no security
# headers at all.
CURL_URL="https://127.0.0.1/"
[[ "$IDM_SCHEME" == "http" ]] && CURL_URL="http://127.0.0.1/"
# Polled for the same reason, one layer up. `systemctl reload nginx` returns as
# soon as the master accepts the signal, while workers started under the
# PREVIOUS config keep answering for a moment. On the same 2026-08-10 run a
# single probe read that stale response and reported all three headers missing
# on a host that had just been repaired correctly — the most damaging false
# alarm this script can raise, because this check exists precisely to catch a
# re-render that did NOT happen. Retry until the headers appear; a genuine
# failure still costs only the 15s it takes to give up.
HEADERS=""
for _ in $(seq 1 15); do
  HEADERS="$(curl -sIk --max-time 5 -H "Host: ${IDM_HOSTNAME}" "$CURL_URL" 2>/dev/null || true)"
  grep -qi '^X-Frame-Options:' <<<"$HEADERS" && break
  sleep 1
done
if [[ -z "$HEADERS" ]]; then
  warn "nginx did not answer on $CURL_URL with Host: ${IDM_HOSTNAME}"
  FAILED=1
else
  ok "console reachable through nginx"
  # CS-M1: these are exactly what a pull-only upgrade leaves missing.
  for header in X-Frame-Options X-Content-Type-Options Referrer-Policy; do
    if grep -qi "^${header}:" <<<"$HEADERS"; then
      ok "  $header present"
    else
      warn "  $header MISSING — deploy/nginx did not take effect"
      FAILED=1
    fi
  done
fi

# CS-L3: the access-log format that stops names and email addresses being
# written to disk in plaintext lives in the http context, and both vhosts
# reference it. If it were absent nginx -t would have failed — so this checks
# that the file is the CURRENT one, not merely that it exists.
if grep -q 'idm_noquery' /etc/nginx/conf.d/idm-log.conf 2>/dev/null; then
  ok "query-stripping access-log format installed"
else
  warn "idm_noquery log format not found in /etc/nginx/conf.d/idm-log.conf"
  FAILED=1
fi

echo >&2
if [[ "$FAILED" -eq 0 ]]; then
  ok "update complete — $CONSOLE_URL is serving $(git_as_idm rev-parse --short HEAD)"
else
  warn "update finished WITH FAILED CHECKS (above). The new build is live; it is not verified."
  echo >&2
  echo "  Roll back with:" >&2
  echo "    cd $REPO_ROOT && sudo -u $IDM_USER git checkout $PREV_COMMIT" >&2
  echo "    sudo SKIP_PULL=1 bash scripts/update.sh" >&2
  exit 1
fi
