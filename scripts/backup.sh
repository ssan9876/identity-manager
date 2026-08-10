#!/usr/bin/env bash
# ============================================================================
# identity-manager — scheduled database backup
#
# Driven by idm-backup.timer (deploy/systemd/). Also safe to run by hand on an
# installed host:
#   sudo -u postgres BACKUP_DIR=/var/backups/identity-manager \
#     bash /opt/identity-manager/scripts/backup.sh
#
# WHY THIS EXISTS. Postgres holds every durable thing this system knows: the
# people, their entitlements, and an append-only audit_log that by design
# cannot be reconstructed or corrected after the fact. Until this unit existed
# the ONLY pg_dump anywhere in the project was the pre-update one
# scripts/update.sh takes, which means a host that died between upgrades had
# no recovery story beyond "reinstall and re-enter everyone" — and the last
# dump on disk would have been whenever somebody last chose to upgrade.
#
# WHY IT PRUNES. The dumps are the reason an upgrade is survivable, so they
# accumulate in the one directory a full disk would take down with it. An
# unbounded backup directory does not fail when it fills; it fails the NEXT
# upgrade, at the moment the dump is the only thing standing between you and a
# forward-only migration you cannot undo.
#
# Optional environment variables:
#   BACKUP_DIR      default /var/backups/identity-manager
#   BACKUP_KEEP     scheduled dumps to keep (default 7 — see below)
#   DATABASE_URL    the database to dump; idm-backup.service supplies it from
#                   .env, which this script's own user cannot read
#   DB_NAME         override the database name outright
#   DEBUG=1         set -x
# ============================================================================
set -Eeuo pipefail

RED=$'\e[31m'; GRN=$'\e[32m'; YLW=$'\e[33m'; BLU=$'\e[34m'; NC=$'\e[0m'
# All status output goes to STDERR, never stdout — the same rule install.sh,
# update.sh and keycloak-setup.sh follow. These scripts capture results with
# $(...), so a human-readable line on stdout silently becomes part of a
# captured value. Only DATA belongs on stdout.
info() { echo "${BLU}==>${NC} $*" >&2; }
ok()   { echo "${GRN}✓${NC} $*" >&2; }
warn() { echo "${YLW}!${NC} $*" >&2; }
die()  { echo "${RED}✗ $*${NC}" >&2; exit 1; }
[[ "${DEBUG:-0}" == "1" ]] && set -x

BACKUP_DIR="${BACKUP_DIR:-/var/backups/identity-manager}"

# Seven, because idm-backup.timer fires daily: one week of restore points is
# enough to cover a corruption nobody noticed until Monday, and it bounds the
# directory at a size an operator can reason about (7 x one dump) instead of
# one that grows for as long as the host lives. The pre-update dumps
# scripts/update.sh takes are counted SEPARATELY, under the same setting.
BACKUP_KEEP="${BACKUP_KEEP:-7}"

# Validated rather than trusted, because this number is the only thing between
# the prune loop and an empty backup directory. BACKUP_KEEP=0 or a typo like
# BACKUP_KEEP=7d must not be read as "delete everything".
[[ "$BACKUP_KEEP" =~ ^[1-9][0-9]*$ ]] \
  || die "BACKUP_KEEP must be a positive integer, got '$BACKUP_KEEP'"

# The directory is created by scripts/install.sh and scripts/update.sh, as root
# and owned by postgres. This script cannot create it itself: it runs as
# postgres, /var/backups is root-owned, and idm-backup.service is confined by
# ProtectSystem=strict with exactly one ReadWritePaths entry. A missing
# directory therefore means the host was installed before backups existed —
# say so, rather than failing on a bare redirect.
[[ -d "$BACKUP_DIR" ]] \
  || die "$BACKUP_DIR does not exist — run scripts/update.sh on this host once to create it"

# DATABASE_URL comes from idm-backup.service's EnvironmentFile. Parsed the same
# way scripts/update.sh parses it, so both agree on which database is "the"
# database on a host whose .env names something other than the default.
if [[ -z "${DB_NAME:-}" ]]; then
  DB_NAME="$(printf '%s' "${DATABASE_URL:-}" | sed -n 's#.*/\([^/?]*\).*#\1#p' | head -1)"
  DB_NAME="${DB_NAME:-identity_manager}"
fi

# Keep the newest $BACKUP_KEEP dumps of ONE kind and delete the rest.
#
# Per kind, not per directory: the pre-update dumps and these scheduled ones
# share $BACKUP_DIR, and a single combined count would let an afternoon of
# upgrades evict every scheduled backup. The file you want when a host dies is
# precisely the one a burst of unrelated activity would delete first.
#
# Ordering comes from the shell's glob sort, not mtime: the names carry an
# ISO-8601 UTC stamp whose lexical order IS its chronological order, and that
# survives being copied off the box — mtime does not.
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

DUMP="$BACKUP_DIR/${DB_NAME}-$(date -u +%Y%m%dT%H%M%SZ)-scheduled.sql.gz"

# 0077 before the redirect, not chmod after it: a chmod leaves a window in
# which the whole directory of names, emails and entitlements is world-readable
# on a host where /var/backups is 0755.
umask 0077

# A failed or interrupted run must not leave a .part file behind to be found
# later and mistaken for a dump.
trap 'rm -f -- "$DUMP.part"' ERR

info "dumping $DB_NAME"
# Written under .part and renamed on success. pipefail makes a pg_dump failure
# fail the pipeline, but the partial output has already been written by then —
# and a truncated .sql.gz carrying the final name does not just look like a
# backup, it counts as one of the ones prune_dumps decides to keep.
pg_dump --no-owner "$DB_NAME" | gzip >"$DUMP.part"
mv "$DUMP.part" "$DUMP"
ok "dumped to $DUMP ($(du -h "$DUMP" | cut -f1))"

prune_dumps scheduled

# Deliberately not pruned here: the pre-update dumps belong to update.sh, which
# prunes its own kind on the run that creates one. See prune_dumps above.
