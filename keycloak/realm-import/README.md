# `keycloak/realm-import/` — the DEVELOPMENT realm

`identity-manager-realm.dev.json` exists for one purpose: to make
`docker compose up -d` produce a Keycloak a developer can immediately log into,
and to give the Testcontainers-backed API suite a real Keycloak to mint real
tokens from.

**It is not a template for a real deployment, and it must never be imported
into one.** Everything secret in it is committed to a public repository:

| Fixture | Value |
|---|---|
| Seeded human user | `admin@example.com` / `dev_password_change_me` |
| `idm-sync-service` client secret | `idm_sync_dev_secret_change_me` |
| `idm-test-client` | public client with the password grant (`directAccessGrantsEnabled`) |

To wire up a real Keycloak, run `scripts/keycloak-setup.sh` instead. It builds
the same realm — same clients, same audience mapper, same four
`realm-management` roles — through the Admin API, with generated secrets, no
seeded human user, and no test client at all.

## What was hardened here, and why (finding SEC-L5)

`docs/archive/audits/audit-secrets.md` and open item 8 of
`docs/archive/audits/carried-findings-verification.md` found that this fixture
was not merely *documented* as dev-only, it was a working, importable
credential set with TLS switched off. Three changes followed:

1. **The filename says `.dev.json`.** Keycloak's `--import-realm` picks up any
   `*.json` in this directory, so the suffix costs nothing and removes the
   "which realm file is this?" ambiguity at the moment someone is about to copy
   it onto a server.
2. **`sslRequired` is `"external"`, not `"none"`.** `"none"` means the realm
   accepts plain HTTP from anywhere, which is exactly wrong if this file ever
   does reach a public host. `"external"` still permits HTTP from loopback and
   private addresses, which is all local development and CI ever use.
3. **`idm-test-client` ships `"enabled": false`.** An accidental import no
   longer yields a live password-grant endpoint for the seeded account.

## Consequence: the test client must be switched on at runtime

`idm-test-client` is genuinely needed by two paths, because its `idm-api`
audience mapper is what makes a direct-grant token acceptable to the API —
Keycloak's built-in `admin-cli` has no such mapper, so tokens minted through it
are correctly rejected with 401:

- `apps/api/test/support/keycloak.ts` (the API suite, and therefore CI's
  `pnpm verify`), against a disposable container;
- `apps/api/scripts/smoke-dev.ts` (`pnpm --filter @idm/api smoke:dev`), against
  the Compose stack.

Both call `setDevTestClientEnabled` from `apps/api/scripts/dev-test-client.ts`,
which authenticates as the stack's own bootstrap admin (`admin` /
`admin_dev_password`, set in `docker-compose.yml`). The smoke script restores
the flag afterwards; the test harness does not need to, because it destroys the
container.

Splitting the test client into a second import file is not an option: each file
in this directory defines a whole realm, and a second file naming an existing
realm is skipped rather than merged.
