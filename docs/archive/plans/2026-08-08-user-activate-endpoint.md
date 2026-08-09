# User Activation Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /users/:id/activate` so an administrator can move a person from `pending` (or `suspended`) to `active`, which is what makes every connector assert the account as enabled.

**Architecture:** A new `user:activate` action in the static authz catalog, a controller handler structurally identical to the existing `deactivate` handler (one transaction: load → scope check → rank check → `changeStatus` → audit → outbox), and a console button on the person detail page. No new database migration, no new outbox event type, and no synchronous Keycloak call.

**Tech Stack:** NestJS 10, Drizzle ORM, Postgres, Zod, Vitest + Testcontainers, React 18 + React Router.

**Design spec:** `docs/archive/specs/2026-08-08-user-activate-endpoint-design.md`

## Global Constraints

- **Branch:** `feat/user-activate`. Already created off `feat/business-roles-entitlements`.
- **No migration.** Reuses the existing `status_changed` value of the `outbox_event_type` enum. Do not add an enum value.
- **No Keycloak call in the handler.** Unlike `deactivate`, activation must not call `KeycloakAdminClient`. The outbox event is the only propagation mechanism.
- **No `RuleApplier` import in `UsersController`.** Manual activation does not fire `start_date_reached` JML rules.
- **No handler-side status check.** `UsersRepository.changeStatus` is the single authority on which transitions are legal; let it throw.
- **`user:activate` is granted to `super_admin` and `user_admin` only.** Never `help_desk`, `auditor` or `read_only`.
- **Run commands from the repo root** (`D:\identity-manager`), which is a pnpm workspace.
- **API tests use Testcontainers** and need Docker running. A single spec file takes 30–90s to start.
- Every commit message ends with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `apps/api/src/authz/actions.ts` | Modify | Declares `user:activate` and which roles hold it |
| `apps/web/src/shell/permissions.ts` | Modify | Hand-mirrored copy of the `Action` union for the console |
| `apps/api/test/actions.spec.ts` | Modify | Pins the grant decision as a regression test |
| `apps/api/src/users/users.controller.ts` | Modify | The `activate` handler |
| `apps/api/test/users.write.spec.ts` | Modify | Endpoint behaviour + audit rows |
| `apps/api/test/outbox-emission.spec.ts` | Modify | Outbox event emitted by the endpoint |
| `apps/web/src/people/api.ts` | Modify | `activatePerson` client call |
| `apps/web/src/people/PersonDetailPage.tsx` | Modify | Activate button, confirm dialog, toast |
| `apps/web/src/audit/api.ts` | Modify | Human label for the new audit action |
| `docs/07-admin-guide.md` | Modify | Corrects the false claim; documents the button |
| `docs/08-authorization.md` | Modify | Action catalog table |
| `docs/10-api-reference.md` | Modify | Endpoint reference |

---

## Task 1: The `user:activate` action

**Files:**
- Modify: `apps/api/src/authz/actions.ts:8-46` (the `Action` union and `ALL_ACTIONS`), `:101-111` (`user_admin`'s grants)
- Modify: `apps/web/src/shell/permissions.ts:6-19`
- Test: `apps/api/test/actions.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the string literal `'user:activate'`, valid as an `Action` in both `apps/api/src/authz/actions.ts` and `apps/web/src/shell/permissions.ts`. Task 2 uses it in `@RequirePermission` and `assertCanIn`. Task 3 uses it in `permissions.actions.has(...)`.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/actions.spec.ts`, inside the existing `describe('role catalog', ...)` block, immediately after the `reserves role:assign to super_admin alone` case:

```ts
  // user:activate is the one action that turns a directory record into a
  // principal that can actually sign in. help_desk holds user:update and
  // must NOT be able to reach it that way — see
  // docs/archive/specs/2026-08-08-user-activate-endpoint-design.md.
  it('grants user:activate to super_admin and user_admin only', () => {
    expect(ROLE_PERMISSIONS.super_admin).toContain('user:activate')
    expect(ROLE_PERMISSIONS.user_admin).toContain('user:activate')
    for (const role of ['help_desk', 'auditor', 'read_only'] satisfies RoleKey[]) {
      expect(ROLE_PERMISSIONS[role]).not.toContain('user:activate')
    }
  })
```

This needs `RoleKey` in the import list. Change the import at the top of the file from:

```ts
import {
  ALL_ACTIONS,
  ALL_ROLE_KEYS,
  ROLE_PERMISSIONS,
  ROLE_RANK,
  type Action,
} from '../src/authz/actions'
```

to:

```ts
import {
  ALL_ACTIONS,
  ALL_ROLE_KEYS,
  ROLE_PERMISSIONS,
  ROLE_RANK,
  type Action,
  type RoleKey,
} from '../src/authz/actions'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @idm/api exec vitest run test/actions.spec.ts -t "grants user:activate"`

Expected: FAIL. This spec has no Testcontainer, so it runs in about a second. The failure is a TypeScript error — `'user:activate'` is not assignable to the `Action` union — surfacing as a transform error rather than a clean assertion failure. Either form counts as red.

- [ ] **Step 3: Add the action to the API catalog**

In `apps/api/src/authz/actions.ts`, add `'user:activate'` to the `Action` union, immediately after `'user:update'`:

```ts
export type Action =
  | 'user:read'
  | 'user:create'
  | 'user:update'
  | 'user:activate'
  | 'user:deactivate'
  | 'group:read'
```

Add the same string to `ALL_ACTIONS`, in the same position:

```ts
export const ALL_ACTIONS: readonly Action[] = [
  'user:read',
  'user:create',
  'user:update',
  'user:activate',
  'user:deactivate',
  'group:read',
```

Add it to `user_admin`'s grant list, in the same position:

```ts
    user_admin: [
      'user:read',
      'user:create',
      'user:update',
      'user:activate',
      'user:deactivate',
      'group:read',
      'group:create',
      'group:update',
      'group:manage_members',
      'org_unit:read',
    ],
```

Do not touch `help_desk`, `auditor` or `read_only`. `super_admin` is `[...ALL_ACTIONS]` and picks it up automatically.

- [ ] **Step 4: Mirror the union in the console**

In `apps/web/src/shell/permissions.ts`, add the same line to its copy of the union:

```ts
/** Mirrors `Action` from apps/api/src/authz/actions.ts. */
export type Action =
  | 'user:read'
  | 'user:create'
  | 'user:update'
  | 'user:activate'
  | 'user:deactivate'
  | 'group:read'
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @idm/api exec vitest run test/actions.spec.ts`

Expected: PASS, all cases in the file. The pre-existing generic cases (`grants super_admin every action`, `references no action outside the declared union`) must also stay green — they are what prove the three lists did not drift.

- [ ] **Step 6: Typecheck both packages**

Run: `pnpm typecheck`

Expected: clean. This is what catches the console mirror being forgotten or misspelled.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/authz/actions.ts apps/web/src/shell/permissions.ts apps/api/test/actions.spec.ts
git commit -m "feat(user-activate): add the user:activate action

Granted to super_admin and user_admin only. Deliberately not help_desk:
that role holds user:update, and reusing an existing action would have
silently turned the low-privilege edit role into one that can grant
someone working access.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: The `POST /users/:id/activate` endpoint

**Files:**
- Modify: `apps/api/src/users/users.controller.ts` — insert after the `update` handler's closing brace (currently line 442) and before the `deactivate` doc comment (currently line 444)
- Test: `apps/api/test/users.write.spec.ts` — new `describe` block after the `POST /users/:id/deactivate` block (currently ends line 692)
- Test: `apps/api/test/outbox-emission.spec.ts` — new `describe` block after the `POST /users/:id/deactivate` block

**Interfaces:**
- Consumes: `'user:activate'` from Task 1.
- Produces: `POST /users/:id/activate` → `200` with a `UserWithSyncState` body (`{ ...user, syncState: 'pending' | 'synced' | 'failed' }`). `404` `NOT_FOUND` for an unknown id, `403` `FORBIDDEN` for scope/rank failures, `409` `INVALID_TRANSITION` for a `deactivated` or already-`active` target. Task 3 calls this.

- [ ] **Step 1: Add a pending-user fixture to the audit spec**

`makeActiveUser` creates and then activates. Activation tests need a user left at `pending`. In `apps/api/test/users.write.spec.ts`, add this immediately after the existing `makeActiveUser` helper (currently ends line 180):

```ts
  /**
   * Left at the `pending` the column defaults to — deliberately NOT run
   * through `changeStatus`, unlike `makeActiveUser` above. This is the
   * state every newly created person is really in, and the one
   * POST /users/:id/activate exists to move them out of.
   */
  async function makePendingUser(role: string, orgUnitId: string): Promise<User> {
    const tag = nextTag()
    return usersRepo().create({
      primaryEmail: `${role}-${tag}@example.com`,
      username: `${role}-${tag}`,
      firstName: 'Test',
      lastName: 'User',
      orgUnitId,
    })
  }
```

- [ ] **Step 2: Write the failing tests**

In `apps/api/test/users.write.spec.ts`, add this block immediately after the closing `})` of the `describe('POST /users/:id/deactivate', ...)` block:

```ts
  // =======================================================================
  // POST /users/:id/activate
  // =======================================================================
  describe('POST /users/:id/activate', () => {
    it('activates a pending user and writes exactly one audit row', async () => {
      const org = await makeOrgUnit('Activate Root')
      const actor = await makeActiveUser('activator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const target = await makePendingUser('target', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/activate`)
        .expect(200)
      expect(res.body.status).toBe('active')

      const rows = await auditRowsFor(ctx, target.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].action).toBe('user:activate')
      expect(rows[0].before?.status).toBe('pending')
      expect(rows[0].after?.status).toBe('active')
    })

    it('activates a suspended user', async () => {
      const org = await makeOrgUnit('Activate Suspended Root')
      const actor = await makeActiveUser('activator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const target = await makeActiveUser('target', org.id)
      await usersRepo().changeStatus(target.id, 'suspended')
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/activate`)
        .expect(200)
      expect(res.body.status).toBe('active')

      const rows = await auditRowsFor(ctx, target.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].before?.status).toBe('suspended')
    })

    it('returns 409 INVALID_TRANSITION for a deactivated user and writes no audit row', async () => {
      const org = await makeOrgUnit('Activate Terminal Root')
      const actor = await makeActiveUser('activator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      await request(app.getHttpServer()).post(`/users/${target.id}/deactivate`).expect(200)
      expect(await auditRowsFor(ctx, target.id)).toHaveLength(1)

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/activate`)
        .expect(409)
      expect(res.body.code).toBe('INVALID_TRANSITION')
      expect(res.body.message).toContain('terminal')

      // Still exactly the one deactivate row — the reactivation attempt
      // rolled back cleanly and left no trace.
      expect(await auditRowsFor(ctx, target.id)).toHaveLength(1)
    })

    it('returns 409 INVALID_TRANSITION for an already-active user', async () => {
      const org = await makeOrgUnit('Activate Idempotent Root')
      const actor = await makeActiveUser('activator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/activate`)
        .expect(409)
      expect(res.body.code).toBe('INVALID_TRANSITION')

      expect(await auditRowsFor(ctx, target.id)).toHaveLength(0)
    })

    it('rejects an actor holding only user:update with 403 and writes no audit row', async () => {
      const org = await makeOrgUnit('Activate Permission Root')
      const actor = await makeActiveUser('helper', org.id)
      await grant(actor.id, 'help_desk', org.id) // user:update, NOT user:activate
      const target = await makePendingUser('target', org.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/activate`)
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await auditRowsFor(ctx, target.id)).toHaveLength(0)
    })

    it('rejects activating an out-of-scope user with 403 and writes no audit row', async () => {
      const root = await makeOrgUnit('Activate Scope Root')
      const scopeOrg = await makeChildOrgUnit(root.id, 'In Scope')
      const otherOrg = await makeChildOrgUnit(root.id, 'Out Of Scope')
      const actor = await makeActiveUser('scoped-activator', scopeOrg.id)
      await grant(actor.id, 'user_admin', scopeOrg.id)
      const target = await makePendingUser('target', otherOrg.id)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/users/${target.id}/activate`)
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await auditRowsFor(ctx, target.id)).toHaveLength(0)
    })

    it('blocks a user_admin from activating a super_admin even in scope (privilege guard)', async () => {
      const org = await makeOrgUnit('Activate Privilege Root')
      const admin = await makeActiveUser('admin', org.id)
      await grant(admin.id, 'user_admin', org.id)
      const boss = await makePendingUser('boss', org.id)
      await grant(boss.id, 'super_admin', null)
      currentUsername = admin.username

      const res = await request(app.getHttpServer())
        .post(`/users/${boss.id}/activate`)
        .expect(403)
      expect(res.body.code).toBe('FORBIDDEN')

      expect(await auditRowsFor(ctx, boss.id)).toHaveLength(0)
    })

    it('returns 404 for a well-formed but nonexistent user id', async () => {
      const org = await makeOrgUnit('Activate Missing Root')
      const actor = await makeActiveUser('activator', org.id)
      await grant(actor.id, 'super_admin', null)
      currentUsername = actor.username

      const res = await request(app.getHttpServer())
        .post(`/users/${BOGUS_ID}/activate`)
        .expect(404)
      expect(res.body.code).toBe('NOT_FOUND')
    })
  })
```

- [ ] **Step 3: Write the failing outbox test**

`apps/api/test/outbox-emission.spec.ts` has its own copies of `makeOrgUnit` / `makeActiveUser` / `grant` and its own `outboxEventsFor` helper. Add the pending fixture there too, immediately after that file's `makeActiveUser` (currently ends line 195):

```ts
  /** Left at the `pending` the column defaults to — see the identical helper in users.write.spec.ts. */
  async function makePendingUser(role: string, orgUnitId: string): Promise<User> {
    const tag = nextTag()
    return usersRepo().create({
      primaryEmail: `${role}-${tag}@example.com`,
      username: `${role}-${tag}`,
      firstName: 'Test',
      lastName: 'User',
      orgUnitId,
    })
  }
```

Then add this block immediately after the closing `})` of that file's `describe('POST /users/:id/deactivate', ...)`:

```ts
  // =======================================================================
  // POST /users/:id/activate -> user/status_changed (same type as deactivate)
  // =======================================================================
  describe('POST /users/:id/activate', () => {
    it('emits exactly one user/status_changed outbox event carrying active', async () => {
      const org = await makeOrgUnit('Activate Root')
      const actor = await makeActiveUser('activator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const target = await makePendingUser('target', org.id)
      currentUsername = actor.username

      await request(app.getHttpServer()).post(`/users/${target.id}/activate`).expect(200)

      const events = await outboxEventsFor(ctx, 'user', target.id)
      expect(events).toHaveLength(1)
      expect(events[0].event_type).toBe('status_changed')
      expect(events[0].payload.action).toBe('user:activate')
      expect(events[0].payload.status).toBe('active')
    })

    it('emits no outbox event when the transition is rejected', async () => {
      const org = await makeOrgUnit('Activate Reject Root')
      const actor = await makeActiveUser('activator', org.id)
      await grant(actor.id, 'user_admin', org.id)
      const target = await makeActiveUser('target', org.id)
      currentUsername = actor.username

      await request(app.getHttpServer()).post(`/users/${target.id}/activate`).expect(409)

      expect(await outboxEventsFor(ctx, 'user', target.id)).toHaveLength(0)
    })
  })
```

No import changes are needed: that file already imports `type User` from `../src/users/users.repository` (line 26) and already defines `nextTag()` (line 167) and `usersRepo` (line 173).

- [ ] **Step 4: Run both specs to verify they fail**

Run: `pnpm --filter @idm/api exec vitest run test/users.write.spec.ts test/outbox-emission.spec.ts`

Expected: FAIL. Every new case returns 404 (no route registered), so `.expect(200)` and `.expect(409)` both fail on the status code. Docker must be running; these two files each start a Postgres container.

- [ ] **Step 5: Write the handler**

In `apps/api/src/users/users.controller.ts`, insert this between the `update` handler's closing `}` and the `deactivate` doc comment:

```ts
  /**
   * The only path to `active` from an administrator's hands. `LifecycleJob`
   * reaches the same status automatically for a `pending` user whose
   * `start_date` has arrived; this exists for the person created without
   * one, who would otherwise sit disabled in every connected directory
   * forever with no console affordance to fix it (see
   * docs/archive/specs/2026-08-08-user-activate-endpoint-design.md).
   *
   * Same load-inside-the-transaction, pair-both-checks shape as `update`
   * and `deactivate` — including passing `tx` explicitly into both checks,
   * for the same finding-C1 reason (see `update`'s doc comment). 200, not
   * the POST-default 201: this acts on an existing resource.
   *
   * Deliberately does NOT check `current.status` first. `changeStatus`
   * decides transition legality in ONE atomic conditional UPDATE and
   * reports an accurate reason on zero rows (`deactivated is terminal ...`
   * / `cannot transition from active to active`), both of which already
   * map to 409 via INVALID_TRANSITION. A pre-check here would be a second,
   * racy authority on the same question — exactly what changeStatus's own
   * doc comment exists to prevent.
   *
   * Deliberately does NOT call Keycloak inline, unlike `deactivate`. That
   * handler is synchronous because a deactivated user holding a live
   * session is a security exposure that cannot wait for the outbox; the
   * failure mode of a slow activation is a person who cannot sign in yet,
   * which is the state they were already in. The `status_changed` event
   * below is the whole propagation mechanism, and `ReconciliationJob`
   * converges on the same result independently.
   *
   * Deliberately does NOT fire `start_date_reached` JML rules. Firing
   * trigger rules is `LifecycleJob`'s job, not a hand-click's — the same
   * reason `deactivate` does not fire `end_date_reached` rules.
   */
  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('user:activate')
  async activate(
    @Param('id') rawId: string,
    @Req() request: AuthorizedRequest,
  ): Promise<UserWithSyncState> {
    const id = parseId(rawId)

    const updated = await this.db.transaction(async (tx) => {
      const current = await this.users.findById(id, tx)
      if (current === null) {
        throw new NotFoundError('user', id)
      }

      await this.engine.assertCanIn(request.actor, 'user:activate', current.orgUnitId, tx)
      await this.privileges.assertCanModifyPrincipal(request.actor, current.id, tx)

      const updated = await this.users.changeStatus(id, 'active', tx)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'user:activate',
        resourceType: 'user',
        resourceId: id,
        before: snapshotUser(current),
        after: snapshotUser(updated),
      })

      // Same 'status_changed' type deactivate emits — the connectors read
      // `enabled` off the payload's status either way, so no new event type
      // and no migration. See DesiredUser's own doc comment.
      await this.outboxWriter.record(tx, {
        aggregateType: 'user',
        aggregateId: id,
        eventType: 'status_changed',
        payload: { ...snapshotUser(updated), action: 'user:activate' },
      })

      return updated
    })

    // Always 'pending' the instant after this commits (no worker runs
    // inline), but resolved rather than assumed — same contract as every
    // other user-returning route in this controller.
    const syncState = await this.syncStates.resolveForUser(id)
    return this.attachSyncState(updated, syncState)
  }
```

- [ ] **Step 6: Run both specs to verify they pass**

Run: `pnpm --filter @idm/api exec vitest run test/users.write.spec.ts test/outbox-emission.spec.ts`

Expected: PASS, including every pre-existing case in both files.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/users/users.controller.ts apps/api/test/users.write.spec.ts apps/api/test/outbox-emission.spec.ts
git commit -m "feat(user-activate): POST /users/:id/activate

One transaction: scope check, rank check, changeStatus, audit row,
status_changed outbox event. Accepts pending -> active and
suspended -> active, both of which ALLOWED_TRANSITIONS already permits;
changeStatus stays the single authority on legality, so a deactivated or
already-active target comes back 409 with no pre-check in the handler.

No inline Keycloak call, unlike deactivate: that one is synchronous
because a live session on a deactivated account is a security exposure
that cannot wait for the outbox. This one has no equivalent urgency.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: The console Activate button

**Files:**
- Modify: `apps/web/src/people/api.ts` — append after `deactivatePerson` (currently ends line 162)
- Modify: `apps/web/src/people/PersonDetailPage.tsx`
- Modify: `apps/web/src/audit/api.ts:60-62` (the `ACTION_LABEL` map)

**Interfaces:**
- Consumes: `'user:activate'` from Task 1; `POST /users/:id/activate` from Task 2.
- Produces: `activatePerson(accessToken: string, id: string): Promise<Person>`.

`apps/web` has no test runner — its `"test"` script runs `scripts/check-css-tokens.mjs`. Verification for this task is `pnpm typecheck`, the CSS token check, and a manual pass in the running app.

- [ ] **Step 1: Add the API client call**

In `apps/web/src/people/api.ts`, append after `deactivatePerson`:

```ts
/**
 * Moves a `pending` or `suspended` person to `active`, which is what makes
 * every connector assert their account as enabled. Returns the updated
 * record WITH its freshly-resolved `syncState`, same as `deactivatePerson`
 * above — but note the two are NOT symmetric: deactivation disables the
 * Keycloak account before it responds, activation only enqueues the change.
 * The caller's toast has to say so.
 */
export function activatePerson(accessToken: string, id: string): Promise<Person> {
  return authorizedRequest<Person>(`/users/${id}/activate`, accessToken, { method: 'POST' })
}
```

- [ ] **Step 2: Add the audit label**

In `apps/web/src/audit/api.ts`, add one line to `ACTION_LABEL`, between `'user:update'` and `'user:deactivate'`:

```ts
const ACTION_LABEL: Record<string, string> = {
  'user:create': 'Person created',
  'user:update': 'Person updated',
  'user:activate': 'Person activated',
  'user:deactivate': 'Person deactivated',
```

- [ ] **Step 3: Wire the detail page**

In `apps/web/src/people/PersonDetailPage.tsx`, make four edits.

**3a.** Extend the import from `./api` (currently line 11) to include `activatePerson`:

```ts
import { activatePerson, deactivatePerson, fetchGroupsForUser, fetchPeopleByIds, fetchPerson, type Group, type Person } from './api'
```

**3b.** Add dialog state beside `deactivateOpen` (currently line 208):

```ts
  const [activateOpen, setActivateOpen] = useState(false)
```

**3c.** Add the permission gate beside `canDeactivate` (currently line 217):

```ts
  const canActivate = permissions.status === 'ready' && permissions.actions.has('user:activate')
```

**3d.** Add the handler immediately after `handleConfirmDeactivate` (currently ends line 246):

```ts
  /**
   * Deliberately NOT worded like handleConfirmDeactivate above. That one
   * states session revocation as accomplished fact, which is honest only
   * because POST /users/:id/deactivate performs it inline before
   * responding. Activation does not: the Keycloak account is still
   * disabled when this promise resolves, and stays that way until the sync
   * worker drains the queued event. Saying "they can sign in now" here
   * would be a lie roughly as often as the worker is behind.
   */
  async function handleConfirmActivate() {
    if (accessToken === undefined || person === null) return
    const updated = await activatePerson(accessToken, person.id)
    setPerson(updated)
    setActivateOpen(false)
    showToast(
      `Activated ${updated.displayName}. Sign-in is enabled once the change reaches each connected directory. ${SYNC_WORD[updated.syncState]}.`,
      updated.syncState === 'failed' ? 'danger' : updated.syncState === 'pending' ? 'warn' : 'neutral',
    )
  }
```

- [ ] **Step 4: Add the button and the dialog**

In the same file, add the button inside `person-detail__title-actions`, immediately BEFORE the existing `canDeactivate &&` block (currently line 390) so Activate sits between Edit and Deactivate:

```tsx
            {canActivate && (person.status === 'pending' || person.status === 'suspended') && (
              <button
                type="button"
                className="btn btn--secondary"
                data-testid="activate-button"
                onClick={() => setActivateOpen(true)}
              >
                Activate
              </button>
            )}
```

Add the dialog immediately BEFORE the existing `<ConfirmDialog open={deactivateOpen} ...>` (currently line 414):

```tsx
      <ConfirmDialog
        open={activateOpen}
        title={`Activate ${person.displayName}?`}
        confirmLabel="Activate"
        tone="primary"
        onConfirm={handleConfirmActivate}
        onDismiss={() => setActivateOpen(false)}
        testId="activate-dialog"
      >
        <p data-testid="activate-consequence">
          This makes <strong>{person.displayName}</strong> an active account. Their sign-in is
          enabled in Keycloak, and their account is enabled in every connected directory, once
          the change syncs — not instantly.
        </p>
        <p>You can deactivate them afterwards, but deactivation is permanent.</p>
      </ConfirmDialog>
```

`tone="primary"` is passed explicitly and must not be omitted: `ConfirmDialog`'s `tone` prop defaults to `'danger'` (`ConfirmDialog.tsx:47`), which would render a red confirm button on a non-destructive action.

- [ ] **Step 5: Typecheck and run the CSS token check**

Run: `pnpm typecheck && pnpm --filter @idm/web test`

Expected: both clean. `btn--secondary` and `tone="primary"` (which renders `btn--primary`) are both existing classes in `apps/web/src/styles/components.css`, so the token check has nothing new to complain about.

- [ ] **Step 6: Verify manually in the running app**

Run: `pnpm dev`

Then, at `http://localhost:5173`, signed in as the bootstrapped admin:

1. Create a person with **no start date**. Land on their detail page.
2. Confirm the status badge reads **Pending** and an **Activate** button is present between Edit and Deactivate.
3. Click Activate. Confirm the dialog's confirm button is blue, not red.
4. Confirm. The badge flips to **Active** and the toast reads `Activated <name>. Sign-in is enabled once the change reaches each connected directory. Sync pending.`
5. Reload. The Activate button is gone (status is no longer `pending`/`suspended`); Deactivate remains.
6. Open the **Activity** tab and confirm the new row reads **Person activated**, not a raw `user:activate`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/people/api.ts apps/web/src/people/PersonDetailPage.tsx apps/web/src/audit/api.ts
git commit -m "feat(user-activate): Activate button on the person detail page

Shown for pending and suspended people to an actor holding user:activate.
The confirm dialog takes tone=\"primary\" explicitly — the prop defaults to
'danger', which would paint a non-destructive action red.

The toast deliberately does not borrow deactivate's phrasing. Deactivate
can state its Keycloak effect as fact because it happens inline; this one
only enqueues, so the copy says the enable lands when the change syncs and
reuses SYNC_WORD rather than a second hand-written vocabulary.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Documentation

**Files:**
- Modify: `docs/07-admin-guide.md:100-108` and `:372-375`
- Modify: `docs/08-authorization.md:37`
- Modify: `docs/10-api-reference.md:131`

**Interfaces:**
- Consumes: everything from Tasks 1–3. Nothing consumes this.

- [ ] **Step 1: Fix the admin guide's false claim**

In `docs/07-admin-guide.md`, replace the `### Activating them` section (currently lines 100–108) in full. The existing text offers "a JML rule or a direct status change" as alternatives; neither exists, and the note claiming there is no activate button is now wrong.

Replace from `### Activating them` through the end of the block quote (`> dropdown.`) with:

```markdown
### Activating them

A pending person exists in the directory but is **disabled everywhere downstream** —
every connector derives its enabled flag from `status = 'active'`. Two ways to move them:

- **Activate them directly.** On the person's detail page, click **Activate**. This is the
  right move for someone who is already here, or who was created without a start date.
- **Set a start date.** When `jml:lifecycle` next runs on or after that date, the user
  transitions `pending → active` automatically, and any `start_date_reached` rules fire
  once. This is the right move for a future joiner.

**Needs:** `user:activate` covering the person's org unit, and you must outrank them.
`help_desk` does not hold it — enabling an account is a different kind of act from
editing one.

> **Activation is not instant downstream.** Unlike deactivation, which disables the
> Keycloak account before the request returns, activation only queues the change. The
> account is enabled when the sync worker drains the event; the sync badge tells you when
> that has happened.

> **There is still no status field on the edit form.** Activation and deactivation are
> discrete, audited, permission-gated actions — not a dropdown you can set to anything.
> Only `jml:lifecycle` reaches `active` any other way.
```

- [ ] **Step 2: Add the action to the audit actions list**

In `docs/07-admin-guide.md`, in the paragraph beginning `Actions you will see include` (currently line 372), add `user:activate` between `user:self_update` and `user:deactivate`:

```markdown
Actions you will see include `user:create`, `user:update`, `user:self_update`,
`user:activate`, `user:deactivate`, `group:*`, `org_unit:create`, `role:assign`,
`import:preview`, `connector_target:configure`, `connector_target:reconcile`,
`attribute_target_mapping:*`.
```

- [ ] **Step 3: Add the action to the authorization catalog**

In `docs/08-authorization.md`, add one row to the Actions table, immediately after the `user:update` row (currently line 36):

```markdown
| `user:activate` | Activating a person — `pending`/`suspended` → `active` |
```

The Roles table needs no change: `user_admin`'s cell already reads "all `user:*`", which stays true.

- [ ] **Step 4: Document the endpoint**

In `docs/10-api-reference.md`, insert immediately BEFORE the `### POST /users/:id/deactivate` heading (currently line 131):

```markdown
### `POST /users/:id/activate` — `user:activate`

No body. → **200** with the updated user.

Accepts `pending → active` and `suspended → active`. A `deactivated` target is **409**
`INVALID_TRANSITION` — that status is terminal. An already-`active` target is **409** too,
not a silent no-op.

Also requires that the target does not outrank you.

> Unlike deactivate, this does **not** call Keycloak inline. It writes a `status_changed`
> outbox event, and the account is enabled downstream when the sync worker drains it.
> Expect `syncState: "pending"` in the response.
```

- [ ] **Step 5: Verify the docs are internally consistent**

Run:

```bash
grep -rn "user:activate" docs/ | grep -v archive/
grep -rn "no \"activate\" button\|direct status change" docs/ | grep -v archive/
```

Expected: the first command lists exactly the four places touched above (`07` twice, `08` once, `10` once). The second returns nothing — the false claim is gone.

- [ ] **Step 6: Commit**

```bash
git add docs/07-admin-guide.md docs/08-authorization.md docs/10-api-reference.md
git commit -m "docs(user-activate): document activation, and correct what was wrong

The admin guide offered 'a JML rule or a direct status change' as ways to
activate someone. Neither existed: jml_action has no activate value, and
no status endpoint existed at all. It also asserted there is no activate
button, which this branch makes false.

Records the asymmetry with deactivate in both the guide and the API
reference — activation queues, deactivation acts inline — because a reader
who assumes symmetry will assume sign-in works the instant the badge flips.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Run the full API suite**

Run: `pnpm --filter @idm/api test`

Expected: green. Watch for `permission.engine.spec.ts`, `self-service.spec.ts` and `role-assignments.write.spec.ts` in particular — they exercise the action catalog most heavily and are where an accidental grant to the wrong role would surface.

- [ ] **Run the workspace checks**

Run: `pnpm typecheck && pnpm build`

Expected: both clean.

- [ ] **Confirm the original problem is solved end to end**

With `pnpm dev` running and a real Keycloak (from `pnpm setup:all`):

1. Create a person. Confirm they appear in Keycloak as **disabled** — this is the reported symptom, and it is correct behaviour for a pending user.
2. Click **Activate** in the console.
3. Wait for the sync badge to reach **Synced**, or run `pnpm --filter @idm/api run reconcile`.
4. Confirm the Keycloak user is now **enabled**.

Step 4 is the one that matters. If the badge reaches Synced and Keycloak still shows disabled, the bug is in `sync.worker.ts`/`KeycloakConnector`, not in this branch.
