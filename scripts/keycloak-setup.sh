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
# Optional: SETUP_PROVISIONER=1 — also create the master-realm `idm-provisioner`
#   service account that the Organizations feature needs in order to create a
#   realm per tenant. Off by default: it is a server-wide credential, and a
#   single-tenant install has no use for it.
#
# ---------------------------------------------------------------------------
# WHY THIS DOES NOT IMPORT keycloak/realm-import/identity-manager-realm.dev.json
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

# TLS verification is ON by default and must stay that way: this script sends
# an admin password and receives a client secret, so a MITM here hands over
# control of the realm. `KC_INSECURE_TLS=1` exists only for a lab Keycloak
# behind a self-signed certificate, and says so loudly every run rather than
# being a quiet flag someone forgets is set.
CURL_TLS=()
if [[ "${KC_INSECURE_TLS:-0}" == "1" ]]; then
  CURL_TLS=(-k)
  warn "KC_INSECURE_TLS=1 — TLS certificate verification is DISABLED."
  warn "  Acceptable against a lab Keycloak with a self-signed certificate."
  warn "  Never use this against one that matters: an admin password goes out"
  warn "  over this connection and a client secret comes back."
fi

# --- Admin token ------------------------------------------------------------
info "authenticating to $KEYCLOAK_URL"
TOKEN="$(curl "${CURL_TLS[@]}" -fsS -X POST "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=admin-cli \
  --data-urlencode "username=$KC_ADMIN_USER" \
  --data-urlencode "password=$KC_ADMIN_PASS" | jq -r .access_token)"
[[ -n "$TOKEN" && "$TOKEN" != "null" ]] || die "could not obtain an admin token — check KEYCLOAK_URL and credentials"
ok "authenticated"

api() { # api <METHOD> <PATH> [body]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl "${CURL_TLS[@]}" -fsS -X "$method" "$KEYCLOAK_URL/admin$path" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body"
  else
    curl "${CURL_TLS[@]}" -fsS -X "$method" "$KEYCLOAK_URL/admin$path" -H "Authorization: Bearer $TOKEN"
  fi
}
api_status() { curl "${CURL_TLS[@]}" -s -o /dev/null -w '%{http_code}' -X "$1" "$KEYCLOAK_URL/admin$2" -H "Authorization: Bearer $TOKEN"; }

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

# --- idm-sso-admin: the credential that registers SSO application clients ---
# A SEPARATE service account from idm-sync-service, deliberately. The sync
# worker keeps exactly its four realm-management roles above and therefore
# structurally CANNOT mint or alter an OIDC client; only this one holds
# manage-clients. Same process, different credential -- the shape of the
# two-database-role split, applied to Keycloak.
#
# manage-clients is realm-wide. Keycloak offers nothing finer-grained: it does
# not scope to "clients this principal created", so a compromise of this
# credential could rewrite idm-console's own redirectUris and harvest
# authorization codes for the admin console itself. The mitigation is ours --
# the reserved-client denylist in apps/api/src/sso-apps/sso-app-validation.ts,
# asserted by a source scan against THIS script. That is an application-level
# guard on an application-level credential and is strictly weaker than a
# structural boundary. See docs/12-security.md.
SSO_UUID="$(upsert_client idm-sso-admin "$(jq -n '{
  clientId:"idm-sso-admin", enabled:true, protocol:"openid-connect",
  publicClient:false, serviceAccountsEnabled:true,
  standardFlowEnabled:false, directAccessGrantsEnabled:false,
  description:"Service account that registers SSO application clients. Holds manage-clients and nothing else."
}')")"

info "granting manage-clients to the SSO admin service account"
SSO_SA_USER_ID="$(api GET "/realms/$REALM/clients/$SSO_UUID/service-account-user" | jq -r .id)"
SSO_WANTED='["manage-clients"]'
SSO_AVAILABLE="$(api GET "/realms/$REALM/users/$SSO_SA_USER_ID/role-mappings/clients/$RM_UUID/available")"
SSO_TO_ADD="$(jq -c --argjson want "$SSO_WANTED" '[.[] | select(.name as $n | $want | index($n))]' <<<"$SSO_AVAILABLE")"

if [[ "$(jq 'length' <<<"$SSO_TO_ADD")" -gt 0 ]]; then
  api POST "/realms/$REALM/users/$SSO_SA_USER_ID/role-mappings/clients/$RM_UUID" "$SSO_TO_ADD" >/dev/null
  ok "granted: $(jq -r 'map(.name)|join(", ")' <<<"$SSO_TO_ADD")"
else
  ok "manage-clients already granted"
fi

info "generating a new idm-sso-admin client secret"
SSO_SECRET="$(api POST "/realms/$REALM/clients/$SSO_UUID/client-secret" | jq -r .value)"
[[ -n "$SSO_SECRET" && "$SSO_SECRET" != "null" ]] || die "failed to generate an idm-sso-admin client secret"

# --- idm-provisioner: the credential that creates per-organization realms ----
# Lives in the MASTER realm, not in "$REALM": creating a realm is a server-level
# operation, so no role inside a single realm can authorize it. This is the one
# credential in the system whose blast radius is the whole Keycloak server, and
# it is therefore OPT-IN. A single-tenant install never creates organizations
# and should never hold it; set SETUP_PROVISIONER=1 only when you intend to use
# multi-tenancy.
#
# It gets `create-realm` and nothing else. Measured against Keycloak 26 on
# 2026-08-09, that means: it can create a realm, and administer the realms it
# created (Keycloak assigns the creator the `<realm>-realm` client roles at
# creation time). Against a realm it did NOT create it can perform a bare
# `GET /admin/realms/<name>` and nothing more — users, clients and realm updates
# all return 403. That is why this is not simply master-realm `admin`.
#
# One non-obvious consequence: the creator roles are granted to the service
# account, not retro-fitted into tokens already issued to it. A token minted
# BEFORE the realm existed gets 403 on that realm's own `users/count`; one
# minted after gets 200. KeycloakAdminClient.invalidateCachedToken() exists for
# exactly this, and removing it fails 7 tests.
if [[ "${SETUP_PROVISIONER:-0}" == "1" ]]; then
  info "creating the master-realm provisioning client idm-provisioner"
  master_client_uuid() { api GET "/realms/master/clients?clientId=$1" | jq -r '.[0].id // empty'; }

  PROV_BODY="$(jq -n '{
    clientId:"idm-provisioner", enabled:true, protocol:"openid-connect",
    publicClient:false, serviceAccountsEnabled:true,
    standardFlowEnabled:false, directAccessGrantsEnabled:false,
    description:"Service account that creates and administers per-organization realms. Holds create-realm and nothing else."
  }')"
  PROV_UUID="$(master_client_uuid idm-provisioner)"
  if [[ -n "$PROV_UUID" ]]; then
    api PUT "/realms/master/clients/$PROV_UUID" "$PROV_BODY" >/dev/null
    ok "updated client idm-provisioner"
  else
    api POST /realms/master/clients "$PROV_BODY" >/dev/null
    PROV_UUID="$(master_client_uuid idm-provisioner)"
    [[ -n "$PROV_UUID" ]] || die "created idm-provisioner but could not read it back"
    ok "created client idm-provisioner"
  fi

  # create-realm is a REALM role of master, not a client role, so it is assigned
  # through role-mappings/realm rather than role-mappings/clients/<uuid>.
  PROV_SA_USER_ID="$(api GET "/realms/master/clients/$PROV_UUID/service-account-user" | jq -r .id)"
  PROV_AVAILABLE="$(api GET "/realms/master/users/$PROV_SA_USER_ID/role-mappings/realm/available")"
  PROV_TO_ADD="$(jq -c '[.[] | select(.name=="create-realm")]' <<<"$PROV_AVAILABLE")"
  if [[ "$(jq 'length' <<<"$PROV_TO_ADD")" -gt 0 ]]; then
    api POST "/realms/master/users/$PROV_SA_USER_ID/role-mappings/realm" "$PROV_TO_ADD" >/dev/null
    ok "granted: create-realm"
  else
    ok "create-realm already granted"
  fi

  info "generating a new idm-provisioner client secret"
  PROV_SECRET="$(api POST "/realms/master/clients/$PROV_UUID/client-secret" | jq -r .value)"
  [[ -n "$PROV_SECRET" && "$PROV_SECRET" != "null" ]] || die "failed to generate an idm-provisioner client secret"
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
echo "  CONNECTOR_KEYCLOAK_SSO_CLIENT_SECRET=$SSO_SECRET"
echo
echo "The second secret is only needed if you register SSO applications. It is"
echo "resolved ONLY by the sso_app code path (connectors/secrets.ts enforces the"
echo "CONNECTOR_ prefix); the user and group sync path never reads it."
echo
if [[ "${SETUP_PROVISIONER:-0}" == "1" ]]; then
  echo "  KEYCLOAK_PROVISION_CLIENT_ID=idm-provisioner"
  echo "  KEYCLOAK_PROVISION_CLIENT_SECRET=$PROV_SECRET"
  echo
  echo "That last pair is the provisioning credential: a MASTER-realm service"
  echo "account holding create-realm, read only when creating or administering"
  echo "an organization's realm. Set both or neither — a half-configured pair is"
  echo "treated as unconfigured (Organizations answers 503 NOT_CONFIGURED); it"
  echo "does not fail startup."
  echo
else
  echo "No provisioning client was created, so the Organizations feature will"
  echo "answer 503 NOT_CONFIGURED. If you want multi-tenancy, re-run this script"
  echo "with SETUP_PROVISIONER=1 and set the two KEYCLOAK_PROVISION_* variables"
  echo "it prints. See docs/06-configuration.md."
  echo
fi
warn "Put that secret into .env, then: systemctl restart idm-api"
echo
echo "Users still need to exist in realm '$REALM' to sign in. This system is a"
echo "system of record that PUSHES users into Keycloak, so the usual path is to"
echo "create them here and let the outbox sync them — not to create them by hand"
echo "in Keycloak. The one exception is your first admin: it must already exist"
echo "in Keycloak for you to log in at all, and bootstrap:admin then grants that"
echo "same username super_admin locally."
