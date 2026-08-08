#!/usr/bin/env bash
# ============================================================================
# identity-manager — wire up an EXISTING Keycloak instance
#
# Creates the realm and the three clients the application needs, assigns the
# sync service account exactly the realm-management roles it requires, mints a
# fresh client secret, and prints it.
#
#   KEYCLOAK_URL=https://kc.example.com \
#   KC_ADMIN_USER=admin KC_ADMIN_PASS=... \
#   CONSOLE_URL=http://idm.lan \
#   bash scripts/keycloak-setup.sh
#
# Optional: REALM (default identity-manager)
#
# ---------------------------------------------------------------------------
# WHY THIS DOES NOT IMPORT keycloak/realm-import/identity-manager-realm.json
#
# That file is the DEVELOPMENT realm. It contains a user `admin@example.com`
# with the password `dev_password_change_me`, and `idm-sync-service` with the
# secret `idm_sync_dev_secret_change_me` — both committed to a public
# repository. Importing it into a real Keycloak would create a working account
# whose password is published on the internet, and a client whose secret is
# equally public.
#
# It also carries `idm-test-client`, a public client with direct access grants
# (the password grant) enabled, which has no business existing in production.
#
# So this script builds the realm through the Admin API instead: same clients,
# same mappers, same role assignments, but with generated secrets and no
# seeded human user. Idempotent — safe to re-run.
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
trap 'rc=$?; echo "${RED}✗ failed (exit $rc) at line ${BASH_LINENO[0]}${NC}" >&2' ERR

REALM="${REALM:-identity-manager}"
[[ -n "${KEYCLOAK_URL:-}" ]] || die "KEYCLOAK_URL is required (base URL, no /realms suffix)"
[[ -n "${CONSOLE_URL:-}" ]] || die "CONSOLE_URL is required (e.g. http://idm.lan)"
[[ -n "${KC_ADMIN_USER:-}" ]] || die "KC_ADMIN_USER is required"
[[ -n "${KC_ADMIN_PASS:-}" ]] || die "KC_ADMIN_PASS is required"
KEYCLOAK_URL="${KEYCLOAK_URL%/}"
CONSOLE_URL="${CONSOLE_URL%/}"

command -v jq >/dev/null || { info "installing jq"; apt-get update -qq && apt-get install -y -qq jq >/dev/null; }
command -v curl >/dev/null || die "curl is required"

# --- Admin token ------------------------------------------------------------
info "authenticating to $KEYCLOAK_URL"
TOKEN="$(curl -fsS -X POST "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=admin-cli \
  --data-urlencode "username=$KC_ADMIN_USER" \
  --data-urlencode "password=$KC_ADMIN_PASS" | jq -r .access_token)"
[[ -n "$TOKEN" && "$TOKEN" != "null" ]] || die "could not obtain an admin token — check KEYCLOAK_URL and credentials"
ok "authenticated"

api() { # api <METHOD> <PATH> [body]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" "$KEYCLOAK_URL/admin$path" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body"
  else
    curl -fsS -X "$method" "$KEYCLOAK_URL/admin$path" -H "Authorization: Bearer $TOKEN"
  fi
}
api_status() { curl -s -o /dev/null -w '%{http_code}' -X "$1" "$KEYCLOAK_URL/admin$2" -H "Authorization: Bearer $TOKEN"; }

# --- Realm ------------------------------------------------------------------
if [[ "$(api_status GET "/realms/$REALM")" == "200" ]]; then
  ok "realm '$REALM' already exists — leaving its settings alone"
else
  info "creating realm '$REALM'"
  api POST /realms "$(jq -n --arg r "$REALM" '{realm:$r, enabled:true, displayName:"Identity Manager"}')" >/dev/null
  ok "created realm '$REALM'"
fi

client_uuid() { api GET "/realms/$REALM/clients?clientId=$1" | jq -r '.[0].id // empty'; }

upsert_client() { # upsert_client <clientId> <json>
  local cid="$1" body="$2" uuid
  uuid="$(client_uuid "$cid")"
  if [[ -n "$uuid" ]]; then
    api PUT "/realms/$REALM/clients/$uuid" "$body" >/dev/null
    ok "updated client $cid"
  else
    api POST "/realms/$REALM/clients" "$body" >/dev/null
    uuid="$(client_uuid "$cid")"
    ok "created client $cid"
  fi
  echo "$uuid"
}

# --- idm-api: the audience the API validates tokens against -----------------
# Not something anyone logs into; it exists so `aud` has a value to match.
upsert_client idm-api "$(jq -n '{
  clientId:"idm-api", enabled:true, protocol:"openid-connect",
  publicClient:false, serviceAccountsEnabled:false,
  standardFlowEnabled:false, directAccessGrantsEnabled:false,
  description:"Audience for API access tokens. Not directly used for login."
}')" >/dev/null

# --- idm-console: browser SSO for the web UI --------------------------------
# The audience mapper is the piece most often missed when doing this by hand.
# Without it, login SUCCEEDS and then every API call returns 401, because the
# access token carries no `idm-api` entry in its `aud` claim for the API to
# match against KEYCLOAK_AUDIENCE.
CONSOLE_UUID="$(upsert_client idm-console "$(jq -n --arg url "$CONSOLE_URL" '{
  clientId:"idm-console", enabled:true, protocol:"openid-connect",
  publicClient:true, standardFlowEnabled:true, directAccessGrantsEnabled:false,
  redirectUris:[($url + "/*")], webOrigins:[$url],
  attributes:{"pkce.code.challenge.method":"S256"},
  protocolMappers:[{
    name:"idm-api-audience", protocol:"openid-connect",
    protocolMapper:"oidc-audience-mapper",
    config:{"included.client.audience":"idm-api","access.token.claim":"true","id.token.claim":"false"}
  }]
}')")"

# A re-run updates the client, but protocolMappers on an update are ignored by
# Keycloak, so assert the mapper separately.
if ! api GET "/realms/$REALM/clients/$CONSOLE_UUID/protocol-mappers/models" | jq -e '.[] | select(.name=="idm-api-audience")' >/dev/null 2>&1; then
  api POST "/realms/$REALM/clients/$CONSOLE_UUID/protocol-mappers/models" "$(jq -n '{
    name:"idm-api-audience", protocol:"openid-connect",
    protocolMapper:"oidc-audience-mapper",
    config:{"included.client.audience":"idm-api","access.token.claim":"true","id.token.claim":"false"}
  }')" >/dev/null
  ok "added the idm-api audience mapper to idm-console"
fi

# --- idm-sync-service: what the outbox worker authenticates as --------------
SYNC_UUID="$(upsert_client idm-sync-service "$(jq -n '{
  clientId:"idm-sync-service", enabled:true, protocol:"openid-connect",
  publicClient:false, serviceAccountsEnabled:true,
  standardFlowEnabled:false, directAccessGrantsEnabled:false,
  description:"Service account the sync worker uses to manage users in this realm."
}')")"

# Exactly the four roles the worker needs — no more. It creates and updates
# users and reads groups; it never needs manage-realm, manage-clients, or
# anything that could alter the realm's own security configuration.
info "granting realm-management roles to the sync service account"
SA_USER_ID="$(api GET "/realms/$REALM/clients/$SYNC_UUID/service-account-user" | jq -r .id)"
RM_UUID="$(client_uuid realm-management)"
[[ -n "$RM_UUID" ]] || die "realm-management client not found in realm '$REALM'"

WANTED='["manage-users","query-users","view-users","query-groups"]'
AVAILABLE="$(api GET "/realms/$REALM/users/$SA_USER_ID/role-mappings/clients/$RM_UUID/available")"
TO_ADD="$(jq -c --argjson want "$WANTED" '[.[] | select(.name as $n | $want | index($n))]' <<<"$AVAILABLE")"

if [[ "$(jq 'length' <<<"$TO_ADD")" -gt 0 ]]; then
  api POST "/realms/$REALM/users/$SA_USER_ID/role-mappings/clients/$RM_UUID" "$TO_ADD" >/dev/null
  ok "granted: $(jq -r 'map(.name)|join(", ")' <<<"$TO_ADD")"
else
  ok "roles already granted"
fi

# --- Fresh secret -----------------------------------------------------------
# Always regenerated: the only other way to get here is the committed dev
# secret, which is public.
info "generating a new client secret"
SECRET="$(api POST "/realms/$REALM/clients/$SYNC_UUID/client-secret" | jq -r .value)"
[[ -n "$SECRET" && "$SECRET" != "null" ]] || die "failed to generate a client secret"

# --- Report -----------------------------------------------------------------
echo
ok "Keycloak is configured."
echo
echo "  KEYCLOAK_ISSUER=$KEYCLOAK_URL/realms/$REALM"
echo "  KEYCLOAK_AUDIENCE=idm-api"
echo "  KEYCLOAK_ADMIN_CLIENT_ID=idm-sync-service"
echo "  KEYCLOAK_ADMIN_CLIENT_SECRET=$SECRET"
echo
warn "Put that secret into .env, then: systemctl restart idm-api"
echo
echo "Users still need to exist in realm '$REALM' to sign in. This system is a"
echo "system of record that PUSHES users into Keycloak, so the usual path is to"
echo "create them here and let the outbox sync them — not to create them by hand"
echo "in Keycloak. The one exception is your first admin: it must already exist"
echo "in Keycloak for you to log in at all, and bootstrap:admin then grants that"
echo "same username super_admin locally."
