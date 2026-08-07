# Mail Server Connector — Implementation Design

**Date:** 2026-08-07
**Status:** Approved for planning
**Scope:** Phase 1 of the mail integration — the connector and its transport
**Counterpart system:** `D:\mail-server` — see its
`docs/superpowers/specs/2026-08-06-idm-sync-design.md`
**Amends:** `docs/superpowers/specs/2026-08-06-mail-server-connector-design.md`
(that document's Part 1 is already built; its Part 2 describes an interface that
never shipped — see "What changed" below)

## Summary

The mail server becomes a second real consumer of the outbox, provisioning
mailboxes and mail-admin records from this directory. Its receiving half is
already built, tested and merged (`feat/idm-sync-phase1`), so the contract is
fixed and known rather than negotiable.

The work is smaller than the 2026-08-06 spec estimated in one way and larger in
another. Smaller: that spec's Part 1 — "making the outbox genuinely
multi-target", which it called the bulk of the work — shipped in Milestones
10-14 and is a no-op now. Larger: this is not "write one connector". Five
changes land in machinery the other four targets share, and four of them are
load-bearing.

## Decisions

| Question | Decision |
|---|---|
| Milestone scope | Provisioning only. SSO and app passwords are phase 2 |
| Deployment | Separate hosts — IdM internal, mail server on a public VPS |
| Mail client auth | App passwords, minted mail-side after SSO. Phase 2. Dovecot's SQL auth path is never touched |
| Sequencing | Phase 1 complete and running before phase 2 begins |
| Transport | WireGuard, with an nginx server block bound to the tunnel address |
| `apply()`'s `externalId` | This system's own user UUID — it is the mail server's addressing key |
| Permanent-failure fast path | Optional; deferred without blocking |

## What changed since 2026-08-06

### Part 1 is already built — delete it, do not implement it

The prior spec was written to prevent one specific failure: with a single
untargeted claim query, an older mail event merely backing off would block a
newer Keycloak event for the same user, so a mail outage would become a Keycloak
offboarding delay — "precisely the failure the core design calls the worst this
product can produce". That is fixed. In current code:

- `OutboxRepository.claimNext`'s blocking subquery carries
  `AND e2.target = e1.target` (`outbox/outbox.repository.ts:139`), and
  `outbox_events_aggregate_idx` is `(aggregate_type, aggregate_id, target, id)`.
- `SyncWorker` dispatches per target through `ConnectorRegistry.resolve`
  (`outbox/sync.worker.ts:293-341`) — a claimed event reaches its own target's
  connector, never Keycloak's.
- `markUserSyncFailed` takes the target rather than hardcoding `'keycloak'`
  (`outbox/sync.worker.ts:280`).

### Part 2 describes an interface that never shipped

That spec proposed `SyncConnector { pushUser, pushGroup }`. The settled
interface — `docs/superpowers/specs/2026-08-06-directory-connectors-design.md`,
Milestone 10 Task 2, implemented by four connectors today — is
`DirectoryConnector { plan, apply, disable, health }` (`connectors/connector.ts`).

The mail connector implements that one. Most of the fit is good: `health()` maps
onto `GET /provisioning/health` and `disable()` onto a `PUT` carrying
`deactivated`. Two properties of the settled interface, however, cannot express
what the mail contract needs, and one field it depends on does not exist. Those
are shared changes 1-3 below.

## Shared changes

Four are required; the fifth is a deferrable quality improvement. All of them
touch code the other four targets depend on, which is the main risk this phase
carries — larger than the connector itself. None changes behaviour for an
existing target: 1 and 2 are additive fields, 3 and 5 are new error types
handled in one place, and 4 splits one gate into two with identical membership
for every current target.

### 1. `DesiredUser.userId: string` — required

The mail API is `PUT /provisioning/identities/{external_id}`, where the key is
this system's own user UUID. `buildDesiredUser` returns no local id at all
(`outbox/sync.worker.ts:541-549`), so the connector cannot construct the URL.

Keying on `username` instead is explicitly rejected by the counterpart spec:
"Keying on `external_id` rather than the address is what makes renames correct:
a changed email becomes a rename of an existing mailbox, not an orphan plus a
new empty one." A username is mutable here too, so it has the same defect.

Added as **required**, not optional. It is always available, it costs nothing to
populate, and an optional field that is in practice always set is a lie about
the shape of the data. `buildDesiredUser` is the only production construction
site; test fixtures are the rest.

### 2. `DesiredUser.status?: UserStatus` — required

`DesiredUser` carries `enabled: boolean`, derived at
`outbox/sync.worker.ts:539`:

```ts
const desiredEnabled = user.status === 'active'
```

All four lifecycle values collapse to a boolean. The mail server needs all four
distinctly, and conflating two of them loses data rather than merely fidelity:
only `deactivated` stamps `deactivated_at`, which starts the phase-4 retention
clock. Map `suspended` onto `deactivated` and a suspended employee's mail is
eventually purged; map `deactivated` onto `suspended` and offboarded mail never
purges at all. The counterpart spec states the rule directly — "A suspension
must never stamp `deactivated_at` — suspension is not offboarding and must not
start the retention clock."

Added as an optional, target-gated field, following the precedent `orgUnitPath`
already set: populated for `mail_server` only, `undefined` for every other
target, and structurally invisible to the connectors that ignore it. No existing
connector reads it or has to acknowledge it.

### 3. `NotApplicableError` — required

`external_identities.external_id` is `NOT NULL` and `apply()` returns
`{ externalId: string }` with no null case. A user who is not mail-eligible and
has no existing identity needs a third outcome: did nothing, correlate nothing.

The connector throws `NotApplicableError`; `SyncWorker` catches it and marks the
event `done` without an `external_identities` upsert.

Rejected alternatives, both considered and both worse:

- **Widening `apply()` to return `| null`.** The interface's own doc comment
  warns against casually widening a settled interface, and it would force all
  five connectors to acknowledge a case exactly one of them has.
- **Hoisting the eligibility check into `SyncWorker`.** That puts target-specific
  logic in the generic layer, and the counterpart spec is explicit that
  eligibility must be decided at apply time, never at emission — see
  "Emission stays unconditional" below.

### 4. Split the correlation gate — required

Before pushing `deactivated` for an ineligible user, the connector must know
whether an identity already exists there. Without that check it would `PUT`
unconditionally, and the mail server's upsert **creates** on first write — so a
user who should never have had mail gets a mailbox row created, their address
reserved against future collisions, and then deactivated.

`DesiredUser.existingExternalId` answers this exactly, but it is populated only
under `TARGETS_NEEDING_IMMUTABLE_ID_CORRELATION`, which also fetches
`managedAttributeRemoteNames` — a per-event query for data the mail connector
never reads. The two concerns are split into separate gates. All three targets
currently in that gate (`active_directory`, `entra_id`, `google_workspace`)
appear in both halves, so nothing changes for any of them; `keycloak` and `echo`
remain in neither; `mail_server` joins only the `existingExternalId` half.

The alternative — a `GET /identities/{userId}` per ineligible user, treating
`404` as "no identity" — is a network round trip to answer a question the local
database already knows, on the path taken by every user who does not have mail.

### 5. `PermanentFailureError` — optional, deferrable

The counterpart spec asks that `409` and `422` be dead-lettered rather than
retried, and `5xx` retried: "Error responses matter more than usual here: they
are consumed by the IdM's worker, which decides from them whether to retry or
dead-letter."

`SyncWorker` has one failure mode — throw, back off, retry to
`maxAttempts: 8`. Skipping this is not a correctness bug: permanent failures
still dead-letter, roughly 40 minutes and 8 futile attempts later. The cost is
that per-aggregate ordering stalls that one user's mail sync for those 40
minutes, so a single malformed alias delays every later mail change for that
person. Worth doing; not worth blocking phase 1 on.

## The connector

```ts
class MailServerConnector implements DirectoryConnector {
  // connector_targets.config: { baseUrl, tokenSecretName, requestTimeoutMs }
  // secret: resolveSecret(tokenSecretName) — see connectors/secrets.ts
}
```

The service token is referenced by environment-variable **name** in
`connector_targets.config` and resolved at point of use, never stored in the
table and never logged — decision 4 of the directory-connectors design, and the
same discipline every other connector follows.

- **`health()`** — `GET /provisioning/health`. Never throws: a missing secret
  resolves to `{ ok: false, detail }` naming the environment variable, never a
  value.
- **`plan(desired)`** — builds the payload and describes the operations, writing
  nothing.
- **`apply(desired)`** — eligibility (below), then
  `PUT /provisioning/identities/{desired.userId}`, returning `desired.userId` as
  the `externalId`.
- **`disable(externalId)`** — `GET /identities/{externalId}` to recover the
  current email, then `PUT` with `status: "deactivated"`. A `404`, or an identity
  whose `email` is null, is a no-op.

### Why `apply()` returns this system's own user UUID

The mail server never exposes `idm_identities.id`. Its `IdentityRead` schema
returns `external_id`, `email`, `status`, `mailbox_id`, `user_id`, `aliases`,
`last_synced_at` and `deactivated_at` — no primary key
(`app/schemas/provisioning.py:132-140`). The one stable handle the API hands
back is the URL key, which is our own user UUID echoed.

So this is not a local id masquerading as a remote one: `/provisioning/identities/{id}`
is genuinely how that identity is addressed on the target, which is what
`externalId` is for. It is also what makes `disable(externalId)` implementable
at all — that method takes no user data by contract, so any other choice of key
would leave it unable to build a URL.

`disable()` is currently unreachable — nothing in this codebase calls it, and
`outbox/target-reconciliation.job.ts:242` documents that it deliberately never
will, because a principal whose desired state is "not enabled" is asserted
through `apply()` like every other desired-state assertion. Implementing it
correctly anyway is a few lines and keeps the documented last-resort escape
hatch real instead of a trap for whoever first wires it up.

### Eligibility

`apply()` reads `mail_enabled` from `desired.attributes`:

| Condition | Action |
|---|---|
| False, no `existingExternalId` | Throw `NotApplicableError`. Nothing was created; correlate nothing |
| False, has `existingExternalId` | `PUT` with `status: "deactivated"` — entitlement removal |
| True | Build the payload and `PUT` |

The middle row is the case worth naming: someone's mail access being revoked
while their directory record stays active.

**Emission stays unconditional.** If `OutboxWriter` only emitted mail events for
users with `mail_enabled = true`, then flipping that attribute to `false` would
emit nothing at all and the mailbox would live forever. Eligibility is decided
at apply time. This is the one place where an obvious-looking optimisation is a
correctness bug, and it is restated here because the optimisation looks
attractive every time someone reads this code fresh.

### Payload

Closed schema, matching the counterpart contract exactly. `email` and `status`
are the only required fields; the rest are omitted rather than nulled when
absent, because the mail server's scalar-vs-collection rule gives "absent" and
"null" different meanings and rejects null for `quota_mb` and `aliases`
outright.

```json
{
  "username": "jdoe",
  "email": "jane@acme.com",
  "display_name": "Jane Doe",
  "quota_mb": 4096,
  "status": "active",
  "aliases": ["j.doe@acme.com"],
  "admin": { "role": "domain_admin", "domains": ["acme.com"] }
}
```

`status` is `desired.status` passed through unchanged — this system's four
lifecycle values are the mail server's four — except on the entitlement-removal
path, which forces `deactivated`.

**No credential is ever sent, in either direction.** This connector has none to
send, and the mail server's schema is `extra="forbid"`, so a credential field
would be rejected outright. Asserted by test on both sides rather than assumed.

**No free-form attribute bag exists, and none should be added.** The mail
payload has nowhere to put an HR field, so default-deny holds structurally
rather than by a flag — a stronger property than the Keycloak path, where
`buildSyncedAttributes` must actively filter. Adding a field here is a
deliberate edit to a closed schema, not a checkbox on an attribute definition.

### Attribute definitions consumed

Four well-known keys, seeded as `attribute_definitions`:

| Key | Type | Meaning |
|---|---|---|
| `mail_enabled` | boolean | Whether this user gets a mailbox |
| `mail_quota_mb` | number | Quota; omitted falls back to the mail server's default |
| `mail_aliases` | multi-value string | Additional addresses; omitted leaves existing aliases untouched |
| `mail_admin_role` | string | `none` \| `domain_admin` \| `superadmin` |

For `domain_admin`, the administered domain is derived from the user's own
`primary_email` domain. A settled simplification: it covers someone
administering the domain they are in and avoids a list-valued attribute that is
awkward to edit in the console. An admin managing several domains they are not a
member of is not supported and would need a `mail_admin_domains` list attribute.

Note the counterpart's carried issue here: `Domain.owner_id` is single-valued
while `admin.domains` is a list, so two identities both claiming one domain will
alternate ownership on every reconcile pass. Deriving the domain from the user's
own address does not fix that on the mail side, but it makes the collision
unlikely to arise from this connector's own output.

## Transport

The counterpart's provisioning security argument is one sentence: a leaked token
is useless from outside, because nginx blocks `/api/v1/provisioning`
(`docker/nginx/templates/10-https.conf.template:43`) and the routes are reachable
only on the `internal` bridge network. Its spec adds that if provisioning is ever
exposed beyond that network, rate limiting stops being optional — there is no
`@limiter.limit` on those routes today, and nginx's own limiter never sees them.

Separate hosts means recreating that private network or replacing the argument.

**WireGuard, chosen.** The VPS is the WireGuard server, since it holds the public
IP; the IdM host is a peer that dials out, which works behind NAT. A second nginx
server block bound to the mail server's tunnel address proxies
`/api/v1/provisioning`; the public server block keeps blocking it, unchanged. No
application code changes on either side, and the sentence above stays literally
true rather than being swapped for a different argument.

`connector_targets.config.baseUrl` points at the tunnel address. The service
token lives in the environment under the name the config references.

Considered and not chosen:

- **Cloudflare Tunnel with an Access service token.** A close second, and better
  if `cloudflared` is already running: consistent with the DNS automation and
  hybrid-deployment path already in that repo, no inbound ports, a second
  independent auth layer, and Cloudflare's rate limiting satisfies the
  requirement for free. Rejected only because it puts a third party in the
  provisioning path for no benefit the tunnel does not already provide here.
- **Public HTTPS with mTLS.** Genuinely exposes provisioning to the internet,
  puts the most work on the mail side, and one nginx slip means it is open.

Add `limit_req` to the provisioning server block regardless. It is a few lines
and closes the gap the counterpart spec flagged against itself.

## Failure mapping

| Mail server response | Connector | Why |
|---|---|---|
| `200` | Correlate `external_identities`, done | |
| `409` address collision | Permanent — dead-letter | Needs a human; retrying never resolves it |
| `422` unhosted domain, invalid alias, malformed payload | Permanent — dead-letter | Same |
| `403` unknown, revoked or expired token | Retriable | An operator fixing the token should heal it without replaying events; `health()` is what makes it legible meanwhile |
| `5xx`, timeout, connection refused | Retriable | |

Until shared change 5 lands, "permanent" means dead-lettered after the standard
8 attempts rather than on the first response.

## Testing

**Main suite, no containers.** Eligibility branches; all four status mappings;
payload construction including the absent-versus-null distinction; the assertion
that no credential field can appear in any payload this connector builds —
asserted, not assumed, mirroring the test the counterpart already has on its own
side; and every row of the failure table.

**Contract drift is the risk unit tests cannot cover.** A stub we write can be
wrong in exactly the way the connector is wrong. The cheap cover is one smoke
script that `PUT`s a real payload at a running mail server and asserts `200`,
following the `smoke:dev` pattern this repo already has. Because the counterpart
schema is closed (`extra="forbid"`) and its own seven test files already prove
its behaviour, that single round trip catches essentially all drift for a
fraction of the cost of reproducing it.

**Deferred: a containerised E2E** that builds the mail-server image in CI. The
counterpart spec flags this as an open implementation question, and it needs its
own Postgres, migrations, a seeded domain and a provisioned service token. Worth
doing; not worth blocking phase 1 on.

## Out of scope

Phase 2 and beyond, each needing its own spec — and phase 2's needs writing in
the counterpart repo, where it does not exist yet:

- **Keycloak OIDC and app passwords.** Admin dashboard SSO, mailbox portal SSO,
  per-device app passwords. This is what makes a provisioned mailbox
  independently usable; until it lands, an admin sets mailbox passwords by hand,
  which the counterpart spec anticipated ("Phase 1 does not strand users").
- **Groups as distribution lists** (counterpart phase 3).
- **The retention purge job** (counterpart phase 4).
- Any pull or reconcile direction from the mail server back into this system.

### Two decisions to carry into phase 2

**Break-glass is now mandatory, not open.** The counterpart spec left it open:
"the phase 2 spec should decide whether the bootstrap `ADMIN_EMAIL` /
`ADMIN_PASSWORD` superadmin stays password-capable as break-glass access."
Separate hosts closes it. With admin login moving to Keycloak and provisioned
admin rows holding inert placeholder hashes, an outage at the IdM's location
locks everyone out of mail administration entirely. It stays password-capable.

**Public Keycloak collides with this repo's own deployment gate.** Browser OIDC
requires users' browsers to reach Keycloak, which means exposing it publicly.
This repo's README states the build must not be deployed to a real network until
its adversarial security audit has run. Phase 1 does not conflict — it is
server-to-server over a private tunnel with no new public surface. Phase 2 does.
That ordering should be decided deliberately.
