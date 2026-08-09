# Sync Diagnostics — Design

**Date:** 2026-08-08
**Status:** settled, not yet implemented
**Related:** `2026-08-08-user-activate-endpoint-design.md` (complementary — see "Scheduling" below)

---

## Summary

A person synced into Keycloak shows `Sync failed` or `Pending` on the console
indefinitely, with no way to learn why. Investigation against the running
deployment (LXC `ct:101`) found **two unrelated defects** presenting as one
symptom, plus the observability gap that made them expensive to find.

This design fixes both defects and adds a per-user sync panel that explains a
badge's state without database access.

## What was actually wrong

Verified against the live database, not inferred.

### Defect 1 — `Pending` account status never clears

`test` (start date 2026-08-07) and `helpdesk` (2026-08-08) are both past due for
activation. `LifecycleJob.activateDueUsers` would transition them, but the job is
an on-demand CLI (`pnpm --filter @idm/api run jml:lifecycle`) and **nothing on the
host ever invokes it** — `/etc/cron.d` holds only `e2scrub_all` and `sysstat`, and
`systemctl list-timers` shows no unit for it. Joiners with a start date are
therefore never activated, and every connector derives `desiredEnabled` from
`status === 'active'` (`sync.worker.ts:600`), so they stay disabled in every target.

### Defect 2 — `Sync failed` never clears

Three compounding causes:

1. Outbox event 2 (`test` → `mail_server`) dead-lettered after 8 attempts with
   `secret "CONNECTOR_MAIL_SERVER_TOKEN" is not set in the environment`.
2. The token *is* present in `/opt/identity-manager/.env` (mtime 19:59:28), but
   `idm-api.service` has run since 18:48:59 and its process environment
   (`/proc/12099/environ`) does not contain it. systemd reads `EnvironmentFile`
   only at start. **The service was never restarted after the connector was
   configured.** This is an operational error, not a code defect, but nothing
   surfaced it.
3. Even after a restart the badge would not clear. Dead letters are never retried
   automatically, and `SyncStateRepository.latestUserEvents`
   (`sync-state.repository.ts:220`) selects the latest event per aggregate with
   **no `target` predicate**, so the failed `mail_server` event outranks the
   successful `keycloak` one.

Keycloak itself was healthy throughout: both users hold `external_identities` rows
with real external IDs and `sync_state = 'synced'`.

Only one of the two users is red because `helpdesk`'s `mail_server` event is `done`
with 0 attempts — the connector threw `NotApplicableError` ("user is not
mail-enabled and has no mailbox here", `mail-server.connector.ts:217`), which
short-circuits *before* the token is resolved at line 420.

### The observability gap

`grep "new Logger"` across the API returns **0 hits**. The sole window into sync
health is `GET /outbox/dead-letters`, which requires a global `audit:read` grant,
lists only `status = 'failed'` rows, and is not per-user. An event stuck in
`pending`/`processing` — mid-backoff, or head-of-line blocked — is visible nowhere
at all.

## The root incoherence

`SyncStateRepository.resolveForUsers` mixes two scopes. The `external_identities`
half filters `system = 'keycloak'`; the outbox half filters no target whatsoever.
That was invisibly consistent while Keycloak was the only enabled target — the
class doc says so directly ("stays intentionally Keycloak-scoped… seeds no other
target as enabled"). `mail_server` is now enabled, and the assumption expired
silently.

Resolved by making **both halves target-aware**, aggregating over targets marked
`enabled` in `connector_targets`. Deliberately *not* resolved by narrowing the
outbox half to Keycloak: `docs/product-brief.md`'s second requirement is that "a
user who looks healthy while their group sync dead-lettered is the worst outcome
this product can produce". A real mail-provisioning failure must stay visible.

### The not-applicable subtlety

A naive "worst across enabled targets" reads `helpdesk`'s missing `mail_server`
identity row as `pending` and paints them permanently yellow. The rule is
therefore **ordered**, per (user, target):

1. The latest outbox event for that `(user, target)` decides first — `failed` →
   failed, `pending`/`processing` → pending, `done` → healthy, contributing
   nothing.
2. **Only if no event exists at all** does it fall back to the
   `external_identities` row for that system — `failed`/`pending` as-is, `synced`
   → healthy, missing → pending.

A `done`-but-not-applicable target is thus settled and silent, which is what it
genuinely is. Badge = worst across all enabled targets, reusing the existing
`raiseWorst`/`worseOf` helpers.

The group/membership half receives the same target scoping. Today
`latestEventsForAggregateType('group')` and `latestMembershipEvents()` scan the
whole table unfiltered, so a disabled or removed target's stale dead letter drags
down every effective member forever.

**Cost:** one additional read of `connector_targets` per `resolveForUsers` call.
A tiny table already read by `ConnectorRegistry`, alongside the 4 queries the
method already issues — not a new N+1.

## Scheduling `LifecycleJob`

No change to `LifecycleJob` or `lifecycle-cli.ts`: the CLI already sets a non-zero
exit code on failure and already reports unactioned users via `report.skipped`
(finding M5). It needs only an invoker.

- `deploy/systemd/idm-lifecycle.service` — `Type=oneshot`, same `User=idm`,
  `WorkingDirectory`, `EnvironmentFile` and hardening block as `idm-api.service`;
  `ExecStart=/usr/bin/node dist/src/jml/lifecycle-cli.js`;
  `SyslogIdentifier=idm-lifecycle`.
- `deploy/systemd/idm-lifecycle.timer` — `OnCalendar=*-*-* 02:00:00`,
  `Persistent=true` so a host powered off at 02:00 runs it on next boot rather
  than silently skipping a day.
- `scripts/install.sh` installs and enables both alongside the API unit.

`LifecycleJob`'s and `lifecycle-cli.ts`'s doc comments both assert "no cron, no
in-process timer". Both become false and are corrected in the same commit.

**Relationship to the activate-endpoint spec.** The two are complementary and
neither supersedes the other. This timer activates joiners who *have* a
`start_date`; `POST /users/:id/activate` (implemented 2026-08-08, commit 803bcf9) covers those created *without* one, whom
`activateDueUsers`' `start_date IS NOT NULL` predicate can never select. Shipping
only one leaves half the population stuck.

## The sync panel

### `GET /users/:id/sync`

On `UsersController`, org-unit scoped exactly as `GET /users/:id` is.

**Permissions are split by grant.** `OutboxController` gates dead letters behind a
*global* `audit:read` specifically because `lastError` is "raw error text from the
target — exactly the kind of operational detail that should not widen with a
narrow grant". Exposing it under `user:read` would overturn that decision
silently, so instead:

- Structural detail — per-target state, attempts, `nextAttemptAt`, event type,
  timestamps, external ID, last synced — requires `user:read`.
- Raw `lastError` is populated only when the caller *also* holds global
  `audit:read`; otherwise `null`, with `errorDetailRedacted: true` so the console
  can say "error detail requires the auditor role" rather than render a
  misleading blank.

An ordinary admin learns *`mail_server` failed, 8 attempts, no retry scheduled*
and knows to escalate. Only an auditor reads the vendor's text.

```ts
{
  syncState: SyncState,              // identical to the badge's own value
  targets: [{
    target, enabled, state,
    externalId, lastSyncedAt,
    latestEvent: { id, eventType, status, attempts,
                   createdAt, nextAttemptAt, lastError } | null
  }],
  blockedByGroups: [{ groupId, groupName, target, status, attempts }],
  errorDetailRedacted: boolean
}
```

`targets[].state` is `'synced' | 'pending' | 'failed'` — the same three values as
`SyncState`, carrying that one target's contribution under the ordered rule above,
before the worst-of aggregation. It deliberately has no fourth `'not_applicable'`
value: not-applicable is not a state the connector persists anywhere, it is
inferred from "a `done` event with no identity row", and inventing a value for it
here would imply a durable fact the database does not hold. Such a target reports
`'synced'` — settled, nothing outstanding — and its `latestEvent.eventType` plus
null `externalId` are what distinguish it in the table for anyone who looks.

`targets[]` lists only targets currently `enabled` in `connector_targets`; the
`enabled` field is carried anyway so the shape stays honest if that filter is ever
relaxed, and so the console never has to infer it.

`blockedByGroups` is load-bearing, not polish: group/membership fan-out is the
most confusing source of a red badge, and it is precisely the case
`SyncStateRepository` exists to catch. Without it the panel cannot explain the
class of failure the class was written for.

### Console

A `Sync` tab on `PersonDetailPage`, `TabKey` gaining `'sync'` between `roles` and
`activity`, following the established tab pattern including arrow-key handling.
One table row per enabled target: target, state badge, external ID, last synced,
attempts, next retry, error. A "Blocked by group" section when non-empty. The
`SyncBadge` in the page header becomes a link to the tab, putting a red badge one
click from its reason.

## Found while planning: the console's own target list is stale

`apps/web/src/connectors/api.ts:4` hard-codes a five-value `ConnectorTarget`
union that is missing `mail_server`, and `apps/web/src/audit/outbox-api.ts:22`
carries a second copy of the same stale list. This is the identical defect the
API already fixed and left a standing instruction about
(`connectors/connector.ts:22-35`: five hand-copied lists went stale when
`mail_server` was added, "do not reintroduce a literal list of targets
anywhere") — the web simply never got the same treatment, because there is no
shared package between the two apps to enforce it.

Consequences today: the connectors console cannot list, configure, enable or
**disable** the mail target at all, and `CONNECTOR_TARGET_LABEL[event.target]`
resolves to `undefined` for a `mail_server` dead letter — which is exactly the
dead letter this whole document is about. Fixing it is a prerequisite for the
sync panel rendering the real incident correctly, so it is in scope here rather
than deferred.

## Out of scope

- **No retry action.** Unsticking a dead letter remains `ReconciliationJob`'s job
  via the reconcile CLI, per `OutboxController`'s existing reasoning.
- **No structured logging framework.** Worth doing, but it is a separate concern
  from this user-facing panel and would widen this spec past one plan.
- **No global health dashboard.** The per-user view answers the reported
  complaint; a fleet-wide view is its own design.

## Testing

| Area | File | Cases |
|---|---|---|
| Derivation | `apps/api/test/sync-state.repository.spec.ts` | mail_server failed + keycloak synced → `failed`; not-applicable `done` with no identity row → healthy, not pending; a *disabled* target's failed event ignored; group event scoped by target |
| Endpoint | `apps/api/test/users.controller.spec.ts` | route shape, org-unit scoping, `lastError` redaction with and without global `audit:read` |
| Console | `apps/web/e2e/people.spec.ts` | the Sync tab renders a failed target with its reason and its blocking group |

## Operational note

Fixing the code does not by itself clear the current deployment. `ct:101` needs
`systemctl restart idm-api` so the running process picks up
`CONNECTOR_MAIL_SERVER_TOKEN`, then a reconcile run to re-drive the dead-lettered
event for `test`.
