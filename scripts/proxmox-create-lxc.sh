#!/usr/bin/env bash
# ============================================================================
# identity-manager — Proxmox VE helper
#
# Run this ON THE PROXMOX HOST (as root). It:
#   1. creates an UNPRIVILEGED Ubuntu 24.04 LXC container
#   2. clones this repository into it
#   3. runs scripts/install.sh inside it
#
# Unprivileged, and no nesting: this deployment runs Node, PostgreSQL and nginx
# natively under systemd rather than Docker-inside-LXC, so the container needs
# no elevated features.
#
# Usage:
#   IDM_HOSTNAME=idm.lan \
#   KEYCLOAK_ISSUER=https://kc.example.com/realms/identity-manager \
#   bash proxmox-create-lxc.sh
#
# Private repo? Pass a token (and branch if needed):
#   GITHUB_TOKEN=ghp_xxx REPO_BRANCH=main ...
#
# Overrides (all optional):
#   CTID, CT_HOSTNAME, CORES, RAM_MB, SWAP_MB, DISK_GB, STORAGE, BRIDGE,
#   NET_IP (default dhcp), TEMPLATE_STORAGE, REPO_URL, REPO_BRANCH, DEBUG=1
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
trap 'rc=$?; echo "${RED}✗ failed (exit $rc) at line ${BASH_LINENO[0]}: ${BASH_COMMAND}${NC}" >&2' ERR
[[ "${DEBUG:-0}" == "1" ]] && set -x

CT_HOSTNAME="${CT_HOSTNAME:-identity-manager}"
CORES="${CORES:-2}"
RAM_MB="${RAM_MB:-2048}"
SWAP_MB="${SWAP_MB:-1024}"
DISK_GB="${DISK_GB:-12}"
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
BRIDGE="${BRIDGE:-vmbr0}"
NET_IP="${NET_IP:-dhcp}"
REPO_URL="${REPO_URL:-https://github.com/ssan9876/identity-manager.git}"
# EMPTY means "whatever the remote's default branch is" — do not hardcode a
# name. This defaulted to `main` and the repository uses `master`, so the very
# first real run died at the clone with a message blaming authentication.
REPO_BRANCH="${REPO_BRANCH:-}"
INSTALL_DIR="/opt/identity-manager"

command -v pct >/dev/null || die "pct not found — run this on the Proxmox host"
[[ $EUID -eq 0 ]] || die "run as root"
[[ -n "${IDM_HOSTNAME:-}" ]] || die "IDM_HOSTNAME is required (the console's hostname, e.g. idm.lan)"
[[ -n "${KEYCLOAK_ISSUER:-}" ]] || die "KEYCLOAK_ISSUER is required (e.g. https://kc.example.com/realms/identity-manager)"

CTID="${CTID:-$(pvesh get /cluster/nextid)}"
info "container $CTID ($CT_HOSTNAME): ${CORES} cores, ${RAM_MB}MB RAM, ${DISK_GB}GB disk"

# --- Template ---------------------------------------------------------------
TEMPLATE="ubuntu-24.04-standard_24.04-2_amd64.tar.zst"
if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then
  info "downloading the Ubuntu 24.04 template"
  pveam update >/dev/null
  # Take whatever 24.04 point release the mirror currently offers rather than
  # pinning one that may have been superseded.
  TEMPLATE="$(pveam available --section system | awk '/ubuntu-24.04-standard/ {print $2}' | sort | tail -1)"
  [[ -n "$TEMPLATE" ]] || die "no ubuntu-24.04-standard template available"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" >/dev/null
fi
ok "template $TEMPLATE"

# --- Create -----------------------------------------------------------------
info "creating container"
pct create "$CTID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
  --hostname "$CT_HOSTNAME" \
  --cores "$CORES" --memory "$RAM_MB" --swap "$SWAP_MB" \
  --rootfs "${STORAGE}:${DISK_GB}" \
  --net0 "name=eth0,bridge=${BRIDGE},ip=${NET_IP}" \
  --features nesting=0 \
  --unprivileged 1 \
  --onboot 1 \
  --start 1 >/dev/null
ok "container $CTID created and started"

info "waiting for the network"
for _ in $(seq 1 30); do
  pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break
  sleep 2
done
pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 \
  || die "container has no DNS/network — check the bridge and NET_IP"

# --- Clone + install --------------------------------------------------------
info "installing git"
# `</dev/null` as well as DEBIAN_FRONTEND: without a closed stdin, apt's
# dpkg-preconfigure emits "unable to re-open stdin" on every install inside
# `pct exec`. Harmless, but it is noise in an installer whose output an
# operator is meant to read for real problems.
pct exec "$CTID" -- bash -lc "DEBIAN_FRONTEND=noninteractive apt-get update -qq </dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git </dev/null >/dev/null"

CLONE_URL="$REPO_URL"
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  CLONE_URL="https://${GITHUB_TOKEN}@${REPO_URL#https://}"
fi

if [[ -n "$REPO_BRANCH" ]]; then
  info "cloning $REPO_URL (branch $REPO_BRANCH)"
  BRANCH_ARG="--branch '$REPO_BRANCH'"
else
  info "cloning $REPO_URL (remote default branch)"
  BRANCH_ARG=""
fi

# stderr is kept, not sent to /dev/null: the previous version discarded it and
# then guessed at the cause in its own error message, which sent the first real
# run chasing a non-existent authentication problem when the branch simply did
# not exist.
if ! CLONE_ERR="$(pct exec "$CTID" -- bash -lc "git clone $BRANCH_ARG --depth 1 '$CLONE_URL' '$INSTALL_DIR' 2>&1 >/dev/null")"; then
  echo "$CLONE_ERR" >&2
  die "clone failed (git's own error is above). Private repo? pass GITHUB_TOKEN. Branch missing? pass REPO_BRANCH."
fi
# Never leave a token embedded in the checkout's remote.
pct exec "$CTID" -- bash -lc "cd '$INSTALL_DIR' && git remote set-url origin '$REPO_URL'"
ok "cloned to $INSTALL_DIR"

info "running the installer (several minutes: apt, pnpm install, build)"
pct exec "$CTID" -- bash -lc "cd '$INSTALL_DIR' && IDM_HOSTNAME='$IDM_HOSTNAME' KEYCLOAK_ISSUER='$KEYCLOAK_ISSUER' ${IDM_SCHEME:+IDM_SCHEME=$IDM_SCHEME} bash scripts/install.sh"

CT_IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
echo
ok "container $CTID is up at ${CT_IP:-<no address>}"
echo
echo "Finish inside the container — 'pct enter $CTID', then:"
echo
echo "  1. Configure your Keycloak (creates realm + clients, prints a secret):"
echo "       cd $INSTALL_DIR && KEYCLOAK_URL=https://<your-keycloak> \\"
echo "         KC_ADMIN_USER=admin KC_ADMIN_PASS=... \\"
echo "         CONSOLE_URL=${IDM_SCHEME:-http}://$IDM_HOSTNAME \\"
echo "         bash scripts/keycloak-setup.sh"
echo
echo "  2. Put the printed secret into KEYCLOAK_ADMIN_CLIENT_SECRET in $INSTALL_DIR/.env"
echo "  3. systemctl start idm-api"
echo "  4. Grant yourself access (without this every request is 403):"
echo "       cd $INSTALL_DIR && sudo -u idm bash -c 'set -a && . .env && set +a && pnpm bootstrap:admin <your-keycloak-username>'"
echo
echo "Point $IDM_HOSTNAME at ${CT_IP:-the container} in DNS or /etc/hosts, then open it."
