# User Activation Endpoint — Design

**Date:** 2026-08-08
**Status:** settled, not yet implemented
**Supersedes:** the claim in `docs/07-admin-guide.md` that status is never changed by hand

---

## Summary

A person created in the console lands on `status = 'pending'` (the column default,
`db/schema/users.ts:27`). Every connector derives its enabled flag from that status —
`sync.worker.ts:600` and `reconciliation.job.ts:203` both compute
`desiredEnabled = user.status === 'active'` — so a new joiner is asserted into Keycloak,
AD, Entra and Google as a **disabled** account and stays that way.

Today the only route out of `pending` for an ordinary user is:

1. set a `start_date` on or before today, then
2. run `pnpm --filter @idm/api run jml:lifecycle`.

`LifecycleJob.activateDueUsers` selects `status = 'pending' AND start_date IS NOT NULL AND
start_date <= today` (`users.repository.ts:696`) and transitions those users. A person
created without a start date is never selected and remains disabled indefinitely, with no
console affordance and no API to correct it.

This design adds `POST /users/:id/activate`, a new `user:activate` action, and a console
button.

## The documentation was wrong

`docs/07-admin-guide.md:104` offers two alternatives to the start-date route: "let a JML
rule or a direct status change do it." Neither exists.

- The `jml_action` enum is `add_to_group | remove_from_group | set_attribute | deactivate`
  (`db/schema/jml-rules.ts:36`). There is no activate action, and `RuleApplier` only ever
  calls `changeStatus(userId, 'deactivated')` (`rule-applier.ts:303`).
- There is no status endpoint. `createUserBodySchema` and `updateUserBodySchema`
  (`users.controller.ts:133`, `:155`) both omit `status` deliberately, and the only
  `changeStatus` callers are the deactivate handler, `LifecycleJob`, `RuleApplier` and
  `bootstrap-admin`.

Fixing that line is part of this work, not a follow-up.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Permission | new `user:activate` | `user:update` is held by `help_desk` and today cannot grant anyone access; reusing it would silently widen that role into an access-granting one. Reusing `user:deactivate` would make the action name mean "either direction", which reads wrong in an append-only audit log. |
| Transitions | `pending → active` **and** `suspended → active` | Both are already legal in `ALLOWED_TRANSITIONS` (`users.repository.ts:84`), so `changeStatus` enforces the boundary with no handler-side status check. Nothing reaches `suspended` today, so this is latent capability rather than new behaviour — but the route will not need reopening when a suspend path lands. |
| JML rules | do not fire | The deactivate handler does not fire `end_date_reached` rules either; firing trigger rules is a property of `LifecycleJob`, not of a hand-click. Keeps `RuleApplier` out of `UsersController`. |
| Keycloak call | none — outbox only | See below. |
| Route shape | dedicated verb route | See below. |

### Why no synchronous Keycloak call

`UsersController.deactivate` commits its transaction and then, inline, calls
`setEnabled(false)` and `revokeSessions` before responding. That asymmetry is deliberate
and must not be mirrored here.

Deactivation is synchronous because a deactivated user holding a live Keycloak session is
a real security exposure for as long as it persists — it cannot wait for the outbox to
drain. Activation has no equivalent urgency: the failure mode of a slow activation is a
person who cannot log in yet, which is the state they were already in. Putting Keycloak on
the request path would buy latency and a new failure mode for nothing, when the
`status_changed` outbox event and `ReconciliationJob` already converge on the same result.

This has a user-visible consequence the console copy must respect — see *Console*.

### Why a verb route rather than `POST /users/:id/status`

A generic status route would need the required permission to vary by target status, which
turns a declarative `@RequirePermission` decorator into hand-rolled branching inside the
handler. This codebase keeps authorization declarative at the route boundary. A generic
route would also either duplicate the existing deactivate route or force its removal.

## Authorization

`apps/api/src/authz/actions.ts`:

- add `'user:activate'` to the `Action` union and to `ALL_ACTIONS`
- add it to `user_admin`'s grant list

`super_admin` picks it up automatically through `[...ALL_ACTIONS]`. It is **not** granted
to `help_desk`, `auditor` or `read_only`.

`docs/08-authorization.md:54` describes `user_admin` as holding "all `user:*`", so that row
stays accurate without edit. The action table gains a row after `user:deactivate` at `:37`.

`apps/web/src/shell/permissions.ts:6` mirrors the union and takes the same line. The two
lists are hand-mirrored today; this design does not change that.

## API

`POST /users/:id/activate` on `UsersController`, `@HttpCode(HttpStatus.OK)` (it acts on an
existing resource, it does not create one), `@RequirePermission('user:activate')`.

One transaction, structurally identical to `deactivate`:

```
findById(id, tx)                                    → NotFoundError        → 404
assertCanIn(actor, 'user:activate', orgUnitId, tx)  → ForbiddenError       → 403
assertCanModifyPrincipal(actor, current.id, tx)     → rank check           → 403
changeStatus(id, 'active', tx)                      → InvalidTransitionError → 409
auditWriter.record(action: 'user:activate', before/after: snapshotUser)
outboxWriter.record(eventType: 'status_changed', payload.action: 'user:activate')
```

Then `syncStates.resolveForUser(id)` and return via `attachSyncState`.

Both checks take `tx` explicitly and the row is loaded **inside** the transaction, for the
same finding-C1 reason documented on `update` and `deactivate`.

### Error handling comes for free

No status check in the handler. `changeStatus` issues a conditional
`UPDATE ... WHERE id = $1 AND status IN (permitted)` and, on zero rows, re-reads to report
an accurate reason (`users.repository.ts:402-421`):

- deactivated target → `"deactivated is terminal; the user cannot be reactivated"`
- already active → `"cannot transition from active to active"`

`INVALID_TRANSITION` is already mapped to `409` in `domain-exception.filter.ts:13`, so
there is no new error plumbing. A missing row raises `NotFoundError` → 404 from the same
tail.

### Event type

Reuses `status_changed`. No new `outbox_event_type` enum value, and therefore no
migration. The connectors already recompute `enabled` from the payload's status on every
event; they need no change at all to honour an activation.

## Console

- `apps/web/src/people/api.ts` — `activatePerson(accessToken, id)`, beside
  `deactivatePerson`.
- `apps/web/src/people/PersonDetailPage.tsx` — a `canActivate` gate on `user:activate`, and
  an **Activate** button in `person-detail__title-actions`, rendered when
  `person.status === 'pending' || person.status === 'suspended'`. Styled `btn--secondary`,
  not `btn--danger`: this is not a destructive action.
- A `ConfirmDialog` with `tone="primary"` passed **explicitly** — the prop defaults to
  `'danger'` (`ConfirmDialog.tsx:47`) and only accepts `'danger' | 'primary'`, so omitting it
  renders a red confirm button on a non-destructive action.
- `apps/web/src/audit/api.ts:63` — `'user:activate': 'Person activated'`, so the audit view
  renders a label rather than a raw action string.

### Copy must not be cloned from deactivate

The deactivate toast states session revocation as accomplished fact, which is honest only
because that call happened inline before the response. Activation's Keycloak enable has
**not** happened when the response returns.

The confirm dialog says sign-in will be enabled once the change syncs. The success toast
reports the status transition as done and the downstream enable as pending, using the
existing `SYNC_WORD[updated.syncState]` rather than a second hand-written phrasing that
could drift from the badge rendered beside it.

## Testing

`apps/api/test/users.write.spec.ts`, following the existing deactivate block
(Testcontainers, real Postgres):

- `pending → active` happy path, asserting the returned status and sync state
- `suspended → active`
- 409 against a `deactivated` target, asserting the terminal-status message
- 409 against an already-`active` target
- 403 for an actor without `user:activate`, including one holding `user:update` — this is
  the grant decision the design turns on
- 403 for an actor whose scope does not cover the target's org unit
- 403 against a higher-ranked target
- an `audit_log` row with `action = 'user:activate'` and a before/after pair
- an `outbox_events` row with `event_type = 'status_changed'` and
  `payload.action = 'user:activate'`

`apps/api/test/actions.spec.ts` passes unchanged — every assertion there is generic over
`ALL_ROLE_KEYS`/`ALL_ACTIONS`. It gains one case pinning `user:activate` out of
`help_desk`, in the same spirit as the existing `role:assign` reservation test.

`apps/web` has no test runner (`"test"` runs a CSS-token check), so there is nothing to add
there.

## Documentation

- `docs/07-admin-guide.md:104-108` — replace the incorrect "JML rule or a direct status
  change" line and the "no activate button" note with the real walkthrough and its
  permission.
- `docs/07-admin-guide.md:372-375` — add `user:activate` to the list of audit actions.
- `docs/08-authorization.md:37` — new row in the action table, after `user:deactivate`.
- `docs/10-api-reference.md:131` — new entry above deactivate, stating explicitly that the
  Keycloak enable is asynchronous, unlike deactivate's.

## What this does not fix

**Activation alone does not enable anyone in Keycloak.** It writes a `status_changed`
event; the account flips to `enabled: true` when the sync worker drains that event. If the
worker is not running, the user stays disabled regardless of their IDM status. That is
pre-existing behaviour, visible in the console as a `pending` sync badge, and out of scope
here.

## Out of scope

- A suspend endpoint. `suspended → active` is supported because it is free, not because
  anything can reach `suspended` yet.
- An `activate` JML rule action.
- A generic status-transition route.
- Bulk activation.
- Reconciling the hand-mirrored `Action` union between API and console.

## The invariant this relaxes, deliberately

`docs/07-admin-guide.md:106` states there is no activate button and that "status is
changed by lifecycle automation and by deactivation, not by hand-editing a dropdown", and
`users.repository.ts:288` reasons that status transitions are `changeStatus`'s job alone.

This design keeps the second claim — every transition still goes through `changeStatus`,
still atomic, still validated — and narrows the first rather than deleting it: there is a
guarded activate **action**, scoped, rank-checked and audited, and still no status
dropdown on the edit form. The admin guide should say that plainly instead of quietly
dropping a claim it no longer upholds.
