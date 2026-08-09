# Mail Server Connector — Design

**Date:** 2026-08-06
**Status:** Approved for planning
**Scope:** Sub-project 4 — a second outbox target
**Counterpart system:** `D:\mail-server` — see its
`docs/archive/specs/2026-08-06-idm-sync-design.md`

## Summary

The mail server becomes a second consumer of the outbox, provisioning mailboxes
and mail-admin records from this directory. Most of the work is not the
connector itself: it is making the outbox genuinely multi-target, which today it
is not.

That refactor is not mail-specific overhead. The core design already names
`active_directory` and `google_workspace` as future consumers, and both need
exactly this work. Doing it now, against a second target whose payload is a
closed schema and a single HTTP call, is considerably cheaper than doing it for
the first time against LDAPS or Microsoft Graph.

## The problem with adding a target today

**`claimNext` cannot route.** `OutboxRepository.claimNext`
(`outbox/outbox.repository.ts:92-108`) selects any `pending` event and
`SyncWorker.applyEvent` unconditionally reconciles it into Keycloak. The first
`mail_server` event written would be pushed to Keycloak.

**Ordering couples the targets, and this is the dangerous one.** The claim
query's `NOT EXISTS` subquery blocks a candidate behind any older
`pending`/`processing` row for the same `(aggregate_type, aggregate_id)` — with
no `target` predicate. It also deliberately does not filter the blocking row by
`next_attempt_at`, which is correct for a single target (an event mid-backoff
must still block a newer one, or a fast-failing queue reorders itself) but
becomes harmful with two: **an older mail event merely backing off would block a
newer Keycloak event for the same user.**

With `maxAttempts: 8`, `baseDelayMs: 2000` and `maxDelayMs: 10min`, a mail-server
outage would stall Keycloak sync for every affected user for a long time —
including a `status_changed` carrying `deactivated`. A mail outage would become
a Keycloak offboarding delay, which is precisely the failure the core design
calls the worst this product can produce: an administrator believing access was
revoked when it was not.

Ordering must therefore be per `(aggregate_type, aggregate_id, target)`.

**Keycloak is hardcoded in four more places:** `SyncWorker.markUserSyncFailed`
(`system: 'keycloak'`), `SyncStateRepository:159`, the whole of
`ReconciliationJob`, and `revoke-access.ts`.

## Part 1 — Multi-target outbox

### Schema

- `outboxTarget` pgEnum gains `'mail_server'`.
- `externalIdentitySystem` pgEnum gains `'mail_server'`.
- `outbox_events_aggregate_idx` becomes
  `(aggregate_type, aggregate_id, target, id)`, serving the widened ordering
  subquery directly and keeping `id` trailing for the lowest-id-per-stream scan.

### Claiming

`claimNext(tx, target)` filters `WHERE target = $target`, and its `NOT EXISTS`
subquery gains `AND e2.target = e1.target`. Every other property of that query —
`FOR UPDATE SKIP LOCKED`, the `next_attempt_at <= now()` evaluated in Postgres,
the claim living inside the caller's transaction so a crash reverts it — is
unchanged and its existing doc comment stays accurate once scoped per target.

### Emission

`OutboxWriter.record` fans out **one row per interested target**. Per-target
retry state (`status`, `attempts`, `nextAttemptAt`, `lastError`) is per-row, so
per-target rows are what the existing schema already implies.

Each connector declares the aggregate types it consumes; the writer emits only
for connectors interested in that aggregate. Keycloak declares all four; the
mail connector declares `user` only, so no mail row is written for an `org_unit`
event nothing would read.

**Emission is never conditional on a user's eligibility.** If the writer only
emitted mail events for users with `mail_enabled = true`, then flipping that
flag to `false` would emit nothing at all, and the mailbox would stay live
forever. Eligibility is decided by the connector at apply time. This is the one
place where an obvious-looking optimisation is a correctness bug.

### Bookkeeping

`markUserSyncFailed` takes the `system` rather than hardcoding `'keycloak'`.
`SyncStateRepository` reports sync state per system, so a user can be synced to
Keycloak and failed to mail without either masking the other.
`OutboxRepository.listFailed` returns `target` so an operator can see which
integration dead-lettered.

## Part 2 — The connector interface

`SyncWorker` splits along a seam already implicit in it. Generic, staying in the
worker: claiming, fanning an event out to affected user ids, the per-user
advisory lock, the `external_identities` upsert, and retry/dead-letter
bookkeeping. Connector-specific, moving out: asserting one user's desired state
into a downstream system.

```ts
interface SyncConnector {
  readonly target: OutboxTarget
  readonly system: ExternalIdentitySystem
  readonly lockNamespace: number
  readonly aggregateTypes: readonly OutboxAggregateType[]
  pushUser(tx, user, definitions): Promise<string | null>
  pushGroup?(tx, group): Promise<void>
}
```

`pushUser` returns the downstream external id, or `null` meaning this connector
has nothing to represent for this user. `null` skips the `external_identities`
upsert entirely — which is required, because `externalId` is `NOT NULL` and
there is no id to store for a user the connector deliberately did not create.

`lockNamespace` is per-target: Keycloak keeps `0x1d3a_0002`, mail takes
`0x1d3a_0003`. Two workers on the same target still serialise per user; two
workers on different targets no longer block each other. The existing
namespacing argument against `GroupsRepository.GROUP_GRAPH_LOCK_ID` holds
unchanged for the new value.

`AppModule` registers one `SyncWorker` instance per connector, each with its own
poll loop and backoff config, so a slow mail server cannot reduce Keycloak drain
throughput. `main.ts` gates each on its own env flag.

### The Keycloak connector is a pure move

`KeycloakConnector.pushUser` is the current `reconcileUser` body minus the
advisory lock and the `external_identities` upsert, and `pushGroup` is
`reconcileGroup`'s `ensureGroup` call. No behaviour changes. The existing suite
is the check that it stayed a pure move: it must pass unmodified apart from
construction sites.

## Part 3 — The mail connector

### Eligibility and the entitlement-removal path

`pushUser` reads the `mail_enabled` attribute:

- **False, and no `external_identities` row for `mail_server`:** return `null`.
  Nothing was created; nothing to do.
- **False, and a row exists:** push `status: "deactivated"` and return the
  existing external id. This is entitlement removal — someone's mail access
  being revoked without their directory record changing status.
- **True:** build the payload and `PUT`, returning the mail server's identity id.

### Payload

A closed schema, matching the mail server's contract exactly:

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

`status` is the user's own status, passed through unchanged — this system's four
lifecycle values are the mail server's four. The one exception is the
entitlement-removal path above, which forces `deactivated` regardless.

**No `sync_to_mail` attribute flag is needed, and none should be added.** The
mail payload has no free-form attribute bag, so default-deny is satisfied
structurally rather than by a flag: no HR field can reach the mail server
because there is nowhere in the schema to put one. This is a stronger property
than the Keycloak path has, where `buildSyncedAttributes` must actively filter,
and it is worth preserving — a future field added to this payload is a
deliberate act, not a checkbox someone ticks on an attribute definition.

**No credential is ever sent.** The mail server's schema rejects any credential
field outright, and this connector has none to send. Asserted by test on both
sides.

### Attribute definitions consumed

Four well-known keys, seeded as `attribute_definitions`:

| Key | Type | Meaning |
|---|---|---|
| `mail_enabled` | boolean | Whether this user gets a mailbox |
| `mail_quota_mb` | number | Mailbox quota; omitted falls back to the mail server's default |
| `mail_aliases` | multi-value string | Additional addresses; omitted leaves existing aliases untouched |
| `mail_admin_role` | string | `none` \| `domain_admin` \| `superadmin` |

For `domain_admin`, the administered domain is derived from the user's own
`primary_email` domain. A settled simplification: it covers someone
administering the domain they are in, and avoids a list-valued attribute that is
awkward to edit in the console. An admin managing several domains they are not a
member of is not supported and would need a `mail_admin_domains` list attribute.

### Configuration

`MAIL_SERVER_BASE_URL`, `CONNECTOR_MAIL_SERVER_TOKEN`, `MAIL_SERVER_SYNC_ENABLED`,
loaded through `loadEnv` alongside the existing Keycloak settings. The token is
issued by the mail server's superadmin UI and shown once.

## Part 4 — Error taxonomy

Today every failure retries eight times. The mail server returns permanent
failures that will never resolve on their own, and burning 40 minutes of backoff
before an operator sees them is wasted time.

| Mail server response | Treatment |
|---|---|
| `409` collision | `PermanentSyncError` — dead-letter immediately |
| `422` unhosted domain, bad payload, credential field present | `PermanentSyncError` — dead-letter immediately |
| `403` bad or revoked token | Retriable — a rotated token does fix itself |
| `5xx`, timeout, connection refused | Retriable — existing backoff |

`SyncWorker.recordFailure` recognises `PermanentSyncError` and calls `markFailed`
directly rather than `markForRetry`, recording the response body in `lastError`
so the dead letter is self-explanatory.

## Part 5 — Synchronous revocation

Suspend and deactivate call the mail server inline before returning, best-effort,
falling back to the outbox — mirroring `revoke-access.ts`'s existing Keycloak
behaviour and extending it to both targets.

The justification is the same one the core design already accepted for Keycloak,
and slightly stronger here: an offboarded employee holding an open IMAP
connection continues reading mail until the queue drains. Everything else stays
eventually consistent.

The mutation must never fail because the mail server is down, and must never
report success for access that is still live without also enqueuing the retry.

## Part 6 — Reconciliation, deliberately deferred

`ReconciliationJob` is Keycloak-typed throughout — `KeycloakUser`,
`missing_in_keycloak`, direct client calls. Generalising it is a larger job than
this connector and is not attempted here.

This is a real gap, recorded rather than hidden: drift between this directory and
the mail server — a mailbox disabled by hand in the mail dashboard, say — is not
detected. The mail server exposes `GET /identities/{external_id}` specifically so
this can be built later without an API change on either side.

## Testing

Per the standing constraint: Testcontainers, never mocks. A faked mail server
would only validate assumptions about the mail server, which is the same
reasoning that put a real Keycloak container in the existing contract tests.

Contract tests run the mail server's FastAPI backend plus its Postgres as
containers. Postfix, Dovecot, Rspamd and Nginx are not needed — the provisioning
API touches only the database.

**This carries a cross-repo dependency that must be settled before
implementation:** the test environment needs to build or pull the mail-server
backend image. Building from a sibling checkout is fragile in CI; publishing a
tagged image is more work up front. This is an ops decision, not a design one,
and it blocks the contract tests rather than the connector itself.

Tests that matter:

**Multi-target isolation** — the regression tests for the finding that motivated
this design:

- A mail event mid-backoff does not block a Keycloak event for the same user.
  Construct it deliberately: fail the mail push, then assert the Keycloak event
  for that user still drains.
- A Keycloak worker never claims a `mail_server` event, and vice versa.
- Per-aggregate ordering still holds *within* a target under an out-of-order
  backlog — the existing test, re-run per target.
- Two workers on different targets do not serialise on the per-user advisory
  lock; two on the same target still do.

**Emission:**

- One row per interested target per mutation; an `org_unit` mutation writes a
  Keycloak row and no mail row.
- A mail event is emitted for a user with `mail_enabled = false` — the
  correctness property, not an oversight.
- A rejected mutation still writes zero events, for every target.

**Connector behaviour:**

- `mail_enabled` false with no prior sync returns `null` and writes no
  `external_identities` row.
- `mail_enabled` flipped true → false disables the existing mailbox.
- Applying the same event twice leaves identical mail-server state — the
  idempotence property, asserted against the real container.
- No credential field appears in any request body, asserted on the wire.
- `409`/`422` dead-letter on the first attempt; `5xx` retries with backoff.

**Keycloak regression:** the existing suite passes unmodified apart from
construction sites, proving the connector extraction was a pure move.

**Revocation:** deactivating a user disables the mailbox before the HTTP response
returns; with the mail server down, the mutation still succeeds and an event is
enqueued.

## Sequencing

This spec should be implemented before the mail server's phase 1, or at least
planned alongside it. It defines the calling side of the contract, and the error
taxonomy above is a shared agreement — the mail server's choice of `409` versus
`422` versus `5xx` directly determines whether this connector retries or
dead-letters.

## Out of scope

- Mail reconciliation job (see Part 6).
- Groups to distribution lists — the mail server's phase 3. It will add
  `'group'` and `'membership'` to the mail connector's declared aggregate types,
  which this design accommodates without further change.
- Active Directory and Google Workspace connectors, which become substantially
  cheaper once this refactor lands.
- Anything inside the mail server itself.
