# Security audit — secrets, credentials, and data exposure

Adversarial audit of `master` @ `91aa5b9`. Lens: credential handling, attribute
default-deny, audit-log content, error/response leakage, token and session
handling, secrets in repo/config, and the web app. Method was live probing
against real Postgres and real Keycloak containers wherever a source claim
could be confirmed vacuously.

All probes ran in throwaway Testcontainers (Postgres 16, Keycloak 26.0) except
the token-handling probe, which used the running dev Keycloak **read-only**
(JWKS fetch + one direct grant). The shared dev database was never written to.

**Headline: the system's foremost claim — that it never generates, transmits,
or stores a credential — survived every attempt to falsify it, verified three
independent ways.** The real findings are about *disclosure*, not credentials.

---

## HIGH

### H1. `POST /imports/preview` is an unaudited, mass, cross-scope directory-enumeration and field-confirmation oracle

**What.** `ImportsController.resolveRow` resolves every CSV row against
**globally unscoped** lookups — `users.findByEmployeeId`, `findByEmail`,
`findByUsername` — and reports the results as per-row `reasons` strings *in
addition to*, not instead of, the scope rejection. Preview writes zero audit
rows and zero outbox events by design ("preview writes nothing"), so the
probing leaves no trace at all.

An actor holding `user:create` in **one** org unit can therefore learn, about
users in org units they provably cannot read (`GET /users/:id` → 403):

| Question | Signal |
| --- | --- |
| Does this email exist anywhere in the directory? | `primaryEmail: a user with email "victim@example.com" already exists` |
| Does this username exist anywhere? | `username: a user with username "victim" already exists` |
| Does this employeeId exist anywhere? | row appears under `failures` with "cannot be changed via import" reasons instead of under `toCreate` |
| Given an employeeId, is my guessed email / username / orgUnitId **correct**? | each *mismatched* field emits its own named reason; a correct guess makes that reason vanish |

**Reproduction** (live, `apps/api/test` harness; attacker is `user_admin`
scoped to `Mine`, victim sits in `Theirs` with `employeeId = EMP-SECRET-001`):

```
GET /users/<victim>                       -> 403 FORBIDDEN   (control: cannot read)

POST /imports/preview  row: EMP-SECRET-001,guess@example.com,guessuser,A,B,<Mine>
  failures[0].reasons = [
    "primaryEmail: cannot be changed via import; does not match the existing user with this employeeId",
    "username: cannot be changed via import; does not match the existing user with this employeeId",
    "orgUnitId: cannot be changed via import; does not match the existing user with this employeeId",
    "not permitted: user:create" ]
  (row EMP-DOES-NOT-EXIST produced NO failure -> employeeId existence is directly observable)

POST /imports/preview  row: EMP-NEW-1,<victim email>,<victim username>,A,B,<Mine>
  failures[0].reasons = [
    "primaryEmail: a user with email \"victim-pa4@example.com\" already exists",
    "username: a user with username \"victim-pa4\" already exists" ]

POST /imports/preview  row: EMP-SECRET-001,<correct email>,<correct username>,<correct orgUnitId>
  failures[0].reasons = [ "not permitted: user:create" ]      <-- all three guesses confirmed

audit rows written by all three requests: 0
```

**Scale.** A single request carries ~1,500 candidate rows before Express's
default 100 kB JSON limit trips (measured: 1,500 rows → 200 OK in 2.9 s;
2,000 rows → 413). ~30,000 silent candidate checks per minute.

**Why HIGH.** It defeats org-unit scoping for the directory's most identifying
fields, it is silent (an incident review cannot see it happened), and it is a
bulk operation. The system deliberately returns 403-not-404 on `GET /users/:id`
on the stated grounds that "the directory's existence is not secret, its
contents are" — this endpoint hands over the contents.

**Fix direction.**
1. In `resolveUpdateRow`, evaluate scope **first**; on rejection return a single
   generic reason and suppress the three field-mismatch reasons — they describe
   a record the caller may not see.
2. In `resolveCreateRow`, replace the collision reasons with a non-confirming
   `primaryEmail: not available` (the value is globally unique regardless, so
   the caller still learns they cannot use it, without confirming *who* holds it).
3. Audit `POST /imports/preview` (actor, row count, batch id) so bulk probing is
   visible even though it mutates nothing.
4. Cap preview/commit row count (already a carried DoS finding; it is also the
   rate limiter for this oracle).

---

## MEDIUM

### M1. Sensitive attribute values are copied verbatim, permanently, into the append-only audit log — and no attribute has any read-visibility control

**What.** `snapshotUser` (`users/users.controller.ts`) is otherwise a careful
explicit field list, deliberately *not* `{ ...user }` — but it passes
`user.attributes` through **wholesale**. `attribute_definitions` has exactly one
"do not let this out" dimension, `sync_to_keycloak`, and it governs only
Keycloak. So an attribute marked `sync_to_keycloak = false` *because it is
sensitive* — the natural reason to mark one — is nevertheless:

- returned in full to **every** actor with `user:read` in scope, including
  `read_only`; there is no per-attribute read filter anywhere; and
- written verbatim as **both `before` and `after`** on every `user:create`,
  `user:update`, `user:self_update`, `jml:set_attribute`, `jml:deactivate` and
  bulk-import audit row — into a table whose UPDATE/DELETE/TRUNCATE are blocked
  by database trigger.

`AuditWriter`'s own doc comment states that excluding credential-shaped data
"is entirely the CALLER's responsibility" and that "there is no 'fix it in a
follow-up' for a leak into this table." No caller performs any redaction. Every
historical value is retained: an update writes the old value too.

**Reproduction.** Define `ssnLast4` (`sync_to_keycloak = false`), create a user
with `6789`, then PATCH it to `4321`:

```
read_only actor, GET /users/:id  -> attributes: {"ssnLast4":"6789"}
audit_log rows for that user:
  user:create  after.attributes  = {"ssnLast4":"6789"}
  user:update  before.attributes = {"ssnLast4":"6789"}
               after.attributes  = {"ssnLast4":"4321"}
DELETE FROM audit_log ... -> ERROR: audit_log is append-only; DELETE is not permitted
```

**Fix direction.** Add a `sensitive` / `redact_in_audit` flag to
`attribute_definitions`; have `snapshotUser` project the attribute bag through
that flag (`"[redacted]"`) rather than spreading it, and consider the same
filter on the read path. This must land **before** `attribute_definitions` gets
a write path — for rows already written there is no retrofit.

---

## LOW

### L1. PKCE `code_verifier` persists in `localStorage`, not `sessionStorage`

`apps/web/src/auth/oidc-config.ts` sets `userStore` to `sessionStorage` but
leaves `stateStore` unset. oidc-client-ts 3.5.0 defaults `stateStore` to
`window.localStorage`, and `SigninState.toStorageString()` persists
`code_verifier`, `nonce`, `client_id`, `authority`, `redirect_uri`, `scope`,
`client_secret`.

Reproduction (real Chromium against the dev stack): click **Sign in**, abandon
the Keycloak page, return to `http://localhost:5173/`:

```
localStorage["oidc.9542712833184111b35587fdaa6a9364"] =
  {"id":"...","created":1786005301,"request_type":"si:r",
   "code_verifier":"e3e7f57797e14ad498535885546d35c9566367025e90416ebdbf96b89aa756279bcc6b1a8d7f4a689bbbd6f602c13ee9",
   "authority":"http://localhost:8080/realms/identity-manager","client_id":"idm-console", ...}
```

It was **still there after a subsequent successful login** (only the completed
flow's own state is consumed); stale entries are cleared only by
`clearStaleState`, default 900 s, and only on a later sign-in/out.

Bounded impact: the access and ID tokens themselves *are* in `sessionStorage`
exactly as claimed (verified — `oidc.user:<issuer>:idm-console`), and the
verifier alone is not a credential. But it contradicts the stated storage
posture and survives browser restarts.

**Fix:** `stateStore: new WebStorageStateStore({ store: window.sessionStorage })`.

### L2. `POST /users` 409 discloses another org unit's email/username, unaudited

Same class as H1, one candidate per request:
`{"statusCode":409,"code":"CONFLICT","message":"a user with email \"cvictim@example.com\" already exists"}`
returned to an actor scoped elsewhere, with zero audit rows written (the
transaction rolls back). `translateWriteError` echoes the caller's own submitted
value, so the leak is the *existence* signal, not the value. Fix with H1's (2).

### L3. 403-vs-404 on `GET /users/:id` is a per-id existence oracle

Confirmed: out-of-scope existing user → `403 FORBIDDEN`; nonexistent id →
`404 NOT_FOUND {"message":"user not found: 00000000-..."}`. This is a documented
deliberate decision and defensible on its own; recorded because combined with H1
it upgrades from "you can confirm an id you already have" to a general read
channel. Worth re-reviewing as a pair.

### L4. JWT verification does not require an `exp` claim

`JwtGuard` passes no `requiredClaims` / `maxTokenAge` to `jwtVerify`, so a
validly-signed token carrying **no `exp` at all** is accepted (probe: → 200).
Not reachable through Keycloak, which always sets `exp` — defence in depth only.
**Fix:** `requiredClaims: ['exp']` (jose v5) or a `maxTokenAge`.

### L5. Committed dev fixtures are real, working secrets with no production warning

All are dev-marked by value or name, but the realm file is the *only* realm
artifact in the repo and has no top-level dev-only marker, so importing it into
a non-dev environment is a one-command mistake.

- `.env.example` ships the actual working `KEYCLOAK_ADMIN_CLIENT_SECRET`
  (`idm_sync_dev_secret_change_me`) — identical to the value hardcoded in
  `keycloak/realm-import/identity-manager-realm.json`. Not a placeholder.
- The realm import seeds `admin@example.com` with a plaintext
  `credentials[].value = "dev_password_change_me"`, and sets
  **`sslRequired: "none"`** — every flow, including the sync service account's
  admin-REST bearer token, permitted over plain HTTP.
- `idm-test-client` is `enabled: true`: a **public** client with
  `directAccessGrantsEnabled: true` carrying an audience mapper that mints
  `idm-api`-audience tokens — username+password → API token, no client secret.
  Its `name` says "DEV/TEST ONLY"; its `enabled` flag does not.
- `docker-compose.yml` ships `KC_BOOTSTRAP_ADMIN_PASSWORD: admin_dev_password`.
- `apps/api/scripts/smoke-dev.ts` and the Playwright specs hardcode
  `dev_password_change_me` — appropriate for their purpose.
- Both real `.env` files are correctly gitignored; only `.env.example` and the
  realm import are tracked.

Defence-in-depth note: the sync service account holds `manage-users`, which
*includes* the ability to write credentials. The never-transmit-a-credential
guarantee rests entirely on client code, not on a Keycloak-side privilege
restriction — consider fine-grained admin permissions so the service account
*cannot* set a credential even if the code tried.

**Fix:** rename to `identity-manager-realm.dev.json`, add a README warning,
`sslRequired: "external"`, and ship `idm-test-client` disabled (or omit it).

### L6. Flipping `sync_to_keycloak` false → true retroactively exports previously withheld values

Values stored while an attribute was non-syncing are pushed to Keycloak on the
next sync of each affected user, with no re-validation and no separate consent.
Proven live: `costCenter = CC-42`, stored while `sync_to_keycloak = false` and
correctly absent from Keycloak, appeared as `costCenter: ["CC-42"]` after a
single `UPDATE attribute_definitions SET sync_to_keycloak = true` plus an
unrelated `PATCH /users/:id`. Unreachable today (no write path for
`attribute_definitions` — carried finding), but when that write path lands, one
UPDATE re-classifies a "never leaves the system" field for the whole directory.
**Fix:** treat setting the flag to true as an explicit, audited, confirmed action.

### L7 (informational). Raw stack traces on stdout for unmapped 500s

`POST /users` with `startDate: "2026-02-30"` (passes the regex, fails Postgres)
returns a clean `{"statusCode":500,"message":"Internal server error"}` to the
client — **no leakage to the caller** — but Nest's default handler prints the
raw Postgres message and a full stack trace (file paths, `pg` internals,
`UsersRepository.create:131`) to stdout. There is no structured logger. Fine in
dev; log hygiene item for production.

---

## WHAT I TRIED THAT DID NOT WORK

Everything below is a real attempt that failed to find a problem. The negative
results are the point.

**1. Falsifying "never generates, transmits, or stores a credential" — three
independent ways, all clean.**
- *Wire inspection.* Wrapped `globalThis.fetch` and dumped every outbound admin
  REST body across create → sync → activate → deactivate. Full set:
  `{"username":...,"email":...,"firstName":...,"lastName":...,"enabled":true,"emailVerified":false,"requiredActions":["UPDATE_PASSWORD"],"attributes":{}}`,
  then only `{email,firstName,lastName,attributes}` and `{enabled}`. No
  `credentials` array, no `password`, no `temporary`. Zero credential-shaped bodies.
- *Keycloak's own credentials sub-resource, with a positive control.* This is
  the exact assertion that was once vacuous. Control: a fixture user created
  outside the code under test **with** a password returns
  `[{"id":"81dc6ddf...","type":"password","credentialData":"{\"algorithm\":\"argon2\",...}"}]`
  — so the probe demonstrably detects a credential. The API-created, worker-synced
  user returns `[]`, and its full `briefRepresentation=false` representation has
  **no `credentials` key at all**, `emailVerified:false`,
  `requiredActions:["UPDATE_PASSWORD"]`, `disableableCredentialTypes:[]`.
- *Behavioural.* Direct-grant token requests for the synced user with four
  guessed passwords (`""`, `password`, `dev_password_change_me`, the username) →
  400 every time. No password exists to guess.

**2. Finding a credential at rest.** Dumped all 11 tables' full column lists.
No password, hash, salt, secret, token, or key column anywhere; the only
matches on those substrings are `attribute_definitions.key`,
`attribute_definitions.sync_to_keycloak` and `role_assignments.role_key`. No
token is cached to disk (the admin token is in-memory only, in
`KeycloakAdminClient.cachedToken`), and no `console.*` call in `apps/api/src`
logs a token, secret, or Authorization header.

**3. Defeating attribute default-deny.** Every route I could reach:
- `POST /users` / `PATCH /users/:id` with undeclared keys → 400
  `Unrecognized key(s) in object: 'password', 'ssn'` (`.strict()` Zod object).
- `PATCH /self` with `firstName`, `jobTitle`, `status`, `orgUnitId`, `username`,
  `primaryEmail`, and an undeclared attribute → 400 each, naming the exact field.
  Only `location` and self-editable attributes are accepted.
- Bulk import extra CSV headers → routed through the same `validateAttributes`;
  a header with no matching active definition fails the row.
- JML `set_attribute` with `notDeclared`, `__proto__`, `constructor`, `password`
  → all four `{"applied":false,"skippedReason":"invalid_attribute"}`, resulting
  attributes `{}`.
- Definition **deactivated** (`is_active = false`) while `sync_to_keycloak`
  stayed `true` → attribute *removed* from Keycloak on the next sync. Definition
  **deleted** → same; the `attributes` key disappeared from the Keycloak
  representation entirely. Local row retained all values, correctly.
- Non-vacuity control throughout: the `sync_to_keycloak = true` attribute
  (`department: ["Engineering"]`) *did* land in Keycloak, asserted against a
  `briefRepresentation=false` fetch made with the container's **bootstrap admin**,
  not through `KeycloakAdminClient`. The realm's User Profile sets
  `unmanagedAttributePolicy: "ADMIN_EDIT"`, so undeclared attributes are *not*
  silently dropped — the trap the brief warned about does not apply here.

**4. Getting a synced attribute into a JWT claim.** Synced
`clearanceLevel: ["TOP-SECRET"]` onto a login-capable user, then decoded a real
access token: the claim is absent. No protocol mapper exposes custom attributes.

**5. Breaking token verification.** All correctly rejected:
algorithm confusion (HS256 signed with the live realm's RSA public key PEM,
original `kid`) → 401; valid signature with a foreign `iss` → 401; wrong
audience → 401; `aud: ["some-other-api"]` → 401; expired by 1 s / 30 s / 5 min →
401 each (zero clock-skew tolerance); `nbf` 5 minutes in the future → 401;
`alg: none` → 401 (already covered by the suite). `aud: ["some-other-api","idm-api"]`
correctly → 200. No `typ` check exists, but it is harmless here and I confirmed
why rather than assuming: real ID tokens carry `aud: idm-test-client` /
`idm-console` (the realm's audience mapper sets `id.token.claim: false`) and
refresh tokens are `HS512` with `aud: <realm url>` and `typ: "Refresh"` — both
are rejected by the audience pin and the RS256 allowlist.

**6. Prototype-chain attacks.** `__proto__` / `constructor` as attribute keys
(API and JML) and as a CSV header — all rejected before reaching any object
assignment. `validateAttributes` copies by property *descriptor* into an
`Object.create(null)` payload first.

**7. Finding a token in the browser where it should not be.** The access and ID
tokens are in `sessionStorage` as claimed, never `localStorage`. No token in any
URL: `onSigninCallback` strips `?code=&state=` and the post-login URL is exactly
`http://localhost:5173/`. `/self` DOM contains no `eyJ` substring. No cookies set
by the app.

**8. Finding a password or MFA UI in the web app.** Zero `input[type="password"]`
in the live rendered DOM; the only inputs are text/date/number/checkbox in the
self-service form. `apps/web/e2e/no-password-input.spec.ts` is a source scan
(it would miss a dynamically-typed input, e.g. `type={someVar}`), so I checked
the rendered page as an independent second method. Credential management is a
genuine deep link: `accountConsoleUrl()` → `${VITE_KEYCLOAK_ISSUER}/account`,
derived from the same issuer the OIDC client signs in against.

**9. Reading the audit log or the outbox over HTTP.** There is no controller for
either. `AuditRepository` is registered as a provider with no route, and the
`audit:read` action exists in the catalog with no endpoint using it. So
`outbox_events.last_error` (which does store raw Keycloak error text) and audit
`before`/`after` payloads are not reachable through the API at all.

**10. Leaking internals through error bodies.** Probed 400/403/404/409/500 across
users, imports, self-service. Every body is `{statusCode, code, message[, issues]}`
with no SQL, no constraint name, no stack, no Keycloak internals. Malformed CSV
returns the csv-parse message (`Quote Not Closed ... at line 2`) — describes the
caller's own input only. `ConflictError` carrying a raw Keycloak `errorMessage`
exists in `KeycloakAdminClient`, but every path that can raise it is either the
async sync worker or wrapped in `revokeKeycloakAccessBestEffort`'s catch, so it
never reaches an HTTP response.

**11. Inducing a spread-the-whole-row audit payload.** All four snapshot helpers
(`snapshotUser`, `snapshotGroup`, `snapshotOrgUnit`, `snapshotRoleAssignment`)
build explicitly named fields. `snapshotUser` emits exactly 15 keys and omits
`id`/`createdAt`/`updatedAt`. Caller-supplied free text (`firstName`,
`jobTitle`, …) does land in the append-only log verbatim, but that is inherent
to auditing named identity fields — the only genuinely problematic passthrough
is the attribute bag (M1).

---

## Environment integrity

- **Working tree clean.** The three `apps/api/test/zzprobe-secrets-*.spec.ts`
  probes and `apps/web/e2e/zzprobe-storage.spec.ts` were deleted after use. No
  committed file was modified; `git status` shows only this report,
  `docs/superpowers/security-audit-input.md`, and other auditors' artifacts
  (`apps/api/__probe/`, `zz-audit-injection-probe*.spec.ts`), which I left alone.
- **Compose stack untouched.** `identity-manager-postgres-1` and
  `identity-manager-keycloak-1` were never restarted or reconfigured. All
  destructive probing ran in throwaway Testcontainers. The only contact with the
  running stack was read-only: `SELECT`/`\dt` against Postgres, a JWKS fetch, and
  direct-grant token requests. The shared dev database received zero writes.
- **Ports.** 3000 was free before and after; the Playwright probe started Vite on
  5173 and Playwright tore it down. Neither is listening now.
