# Sync Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a `Pending` or `Sync failed` badge explain itself, and fix the two defects that make those badges stick forever.

**Architecture:** `SyncStateRepository` becomes target-aware on both halves of its derivation, aggregating over targets enabled in `connector_targets`. A new `SyncDetailRepository` serves a per-user, per-target breakdown behind `GET /users/:id/sync`, with raw connector error text gated on a global `audit:read` grant. `LifecycleJob` gains a systemd timer so joiners with a start date actually activate.

**Tech Stack:** NestJS 10, Drizzle ORM, Postgres 16, Vitest + Testcontainers, React + Vite, Playwright.

## Global Constraints

- Spec: `docs/archive/specs/2026-08-08-sync-diagnostics-design.md`. Every decision below traces to it.
- **Never reintroduce a literal list of connector targets.** `connectors/connector.ts:36`'s `ALL_CONNECTOR_TARGETS` is the single source; the union derives from it. `test/connector-target-catalog.spec.ts` asserts it matches the `outbox_target` pgEnum in both directions.
- `external_identity_system` and `outbox_target` have identical members, so `event.target` is usable directly as `system` with no mapping table (`db/schema/external-identities.ts:18`).
- Tests use real Postgres via `withTestDatabase()` (`test/support/pg.ts`). No mocked databases.
- Existing doc comments are load-bearing in this codebase. When a change makes one false, fix it in the same commit.
- Run `pnpm --filter @idm/api test` before every commit; the full suite must stay green.

---

### Task 1: Target-aware sync derivation

**Files:**
- Modify: `apps/api/src/outbox/sync-state.repository.ts`
- Test: `apps/api/test/sync-state.repository.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SyncStateRepository.resolveForUsers(userIds: readonly string[]): Promise<Map<string, SyncState>>` — signature unchanged, semantics widened. Task 3 relies on `SyncState = 'pending' | 'synced' | 'failed'` continuing to be exported from this module.

**Behaviour change to be aware of:** the ordered rule makes the latest outbox event authoritative over the `external_identities` row. Previously a `done` event with a `failed` identity row read `failed`; now it reads healthy, because the event is the more recent fact. No existing test encodes the old precedence — verified by grep before writing this plan — but if one surfaces, it is the test that is wrong, and the spec's "The not-applicable subtlety" section is the authority.

- [ ] **Step 1: Widen the two test helpers to take a target**

In `apps/api/test/sync-state.repository.spec.ts`, replace `insertOutboxEvent` and `setExternalIdentity` with target-aware versions. Both keep `'keycloak'` as the default so every one of the ~20 existing call sites compiles and behaves identically.

```ts
  async function insertOutboxEvent(
    aggregateType: 'user' | 'group' | 'membership',
    aggregateId: string,
    status: 'pending' | 'processing' | 'done' | 'failed',
    eventType: 'created' | 'updated' | 'status_changed' | 'membership_changed' = 'updated',
    payload: Record<string, unknown> = {},
    target: 'keycloak' | 'mail_server' | 'echo' = 'keycloak',
  ): Promise<number> {
    const { rows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, status, target)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       RETURNING id`,
      [aggregateType, aggregateId, eventType, JSON.stringify(payload), status, target],
    )
    return Number(rows[0]!.id)
  }

  async function setExternalIdentity(
    userId: string,
    syncState: 'pending' | 'synced' | 'failed',
    system: 'keycloak' | 'mail_server' | 'echo' = 'keycloak',
  ): Promise<void> {
    await ctx.pool.query(
      `INSERT INTO external_identities (user_id, system, external_id, sync_state, last_synced_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id, system) DO UPDATE SET sync_state = EXCLUDED.sync_state`,
      [userId, system, `${system}-${userId}`, syncState],
    )
  }
```

Add helpers to enable and clean up a second target, since the migration seeds only `keycloak`:

```ts
  /**
   * `connector_targets` seeds ONLY ('keycloak', enabled: true) — see that
   * table's own doc comment for the Postgres ALTER TYPE reason. A test that
   * needs a second enabled target inserts its own row, exactly as
   * outbox-emission.spec.ts already does for active_directory.
   */
  async function enableTarget(target: 'mail_server' | 'echo'): Promise<void> {
    await ctx.pool.query(
      `INSERT INTO connector_targets (target, enabled) VALUES ($1, true)
       ON CONFLICT (target) DO UPDATE SET enabled = true`,
      [target],
    )
  }

  async function disableTarget(target: 'mail_server' | 'echo'): Promise<void> {
    await ctx.pool.query(`DELETE FROM connector_targets WHERE target = $1`, [target])
  }
```

- [ ] **Step 2: Write the failing tests**

Append this block to `apps/api/test/sync-state.repository.spec.ts`, inside the top-level `describe`. Add `afterEach` to the `vitest` import at the top of the file.

```ts
  // =====================================================================
  // Multi-target derivation (2026-08-08 sync-diagnostics spec). Before this
  // change the external_identities half filtered system = 'keycloak' while
  // the outbox half filtered no target at all — coherent only while
  // Keycloak was the sole enabled target, which mail_server ended.
  // =====================================================================
  describe('multi-target derivation', () => {
    afterEach(async () => {
      await disableTarget('mail_server')
    })

    it('reports failed when a non-Keycloak target dead-lettered, even though Keycloak is synced', async () => {
      await enableTarget('mail_server')
      const user = await makeUser()
      await insertOutboxEvent('user', user.id, 'done', 'created')
      await setExternalIdentity(user.id, 'synced')
      await insertOutboxEvent('user', user.id, 'failed', 'created', {}, 'mail_server')

      expect(await syncStates().resolveForUser(user.id)).toBe('failed')
    })

    it('treats a not-applicable target as settled, not pending', async () => {
      // The mail connector throws NotApplicableError for a user with no
      // mailbox (mail-server.connector.ts:217), so reconcileUser returns
      // WITHOUT writing an external_identities row and the event completes
      // normally. A missing row here must NOT read as pending forever.
      await enableTarget('mail_server')
      const user = await makeUser()
      await insertOutboxEvent('user', user.id, 'done', 'created')
      await setExternalIdentity(user.id, 'synced')
      await insertOutboxEvent('user', user.id, 'done', 'created', {}, 'mail_server')

      expect(await syncStates().resolveForUser(user.id)).toBe('synced')
    })

    it('ignores a DISABLED target dead letter', async () => {
      const user = await makeUser()
      await insertOutboxEvent('user', user.id, 'done', 'created')
      await setExternalIdentity(user.id, 'synced')
      // mail_server deliberately never enabled — a target an operator turned
      // off must not keep dragging every user down forever.
      await insertOutboxEvent('user', user.id, 'failed', 'created', {}, 'mail_server')

      expect(await syncStates().resolveForUser(user.id)).toBe('synced')
    })

    it('falls back to the external_identities row when a target has no event at all', async () => {
      await enableTarget('mail_server')
      const user = await makeUser()
      await insertOutboxEvent('user', user.id, 'done', 'created')
      await setExternalIdentity(user.id, 'synced')
      await setExternalIdentity(user.id, 'failed', 'mail_server')

      expect(await syncStates().resolveForUser(user.id)).toBe('failed')
    })

    it('scopes the GROUP half by target too', async () => {
      const group = await makeGroup('Disabled Target Group')
      const user = await makeUser()
      await groupsRepo().addUser(group.id, user.id)
      await insertOutboxEvent('user', user.id, 'done', 'created')
      await setExternalIdentity(user.id, 'synced')
      await insertOutboxEvent('group', group.id, 'failed', 'updated', {}, 'mail_server')

      expect(await syncStates().resolveForUser(user.id)).toBe('synced')
    })
  })
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @idm/api test -- sync-state.repository`

Expected: three tests FAIL against the old code — `ignores a DISABLED target dead letter` (old code says `failed`), `falls back to the external_identities row...` (old code says `synced`), and `scopes the GROUP half by target too` (old code says `failed`). The other two may already pass, because the old unfiltered outbox half happens to catch those cases for the wrong reason; that is expected, and they still belong here as regression cover.

- [ ] **Step 4: Implement the target-aware derivation**

In `apps/api/src/outbox/sync-state.repository.ts`, add these imports:

```ts
import { connectorTargets } from '../db/schema/connector-targets'
import type { OutboxTarget } from './outbox.writer'
```

Replace the `LatestAggregateEventRow` and `LatestMembershipEventRow` type aliases with target-carrying versions:

```ts
type LatestAggregateEventRow = {
  aggregate_id: string
  target: OutboxTarget
  status: 'pending' | 'processing' | 'done' | 'failed'
}

type LatestMembershipEventRow = LatestAggregateEventRow & {
  payload: Record<string, unknown>
}
```

Add a composite key helper next to `raiseWorst`:

```ts
/**
 * `external_identity_system` and `outbox_target` have identical members
 * (db/schema/external-identities.ts's own doc comment), so one key shape
 * serves both maps. `:` is an unambiguous separator here because neither a
 * uuid nor any enum member can contain one — no escaping needed.
 */
function perTargetKey(userId: string, target: string): string {
  return `${userId}:${target}`
}
```

Replace the three private query methods so each takes the enabled-target list and returns `target`:

```ts
  private async enabledTargets(): Promise<OutboxTarget[]> {
    const rows = await this.db
      .select({ target: connectorTargets.target })
      .from(connectorTargets)
      .where(eq(connectorTargets.enabled, true))
    return rows.map((row) => row.target)
  }

  /**
   * Latest event per (aggregate, TARGET) — not per aggregate. That
   * distinction is the whole fix: `DISTINCT ON (aggregate_id)` alone let a
   * dead-lettered mail_server event outrank a later successful keycloak one
   * for the same user, because the newer id won regardless of which backend
   * it described.
   *
   * `target::text = ANY(...::text[])` rather than a native enum array cast:
   * `sql.param` binds a JS string[] as a text array, and Postgres will not
   * implicitly coerce text[] to outbox_target[]. Casting the COLUMN to text
   * instead keeps the comparison well-typed with no per-element cast. The
   * enabled-target list is at most six values, so the lost index usability
   * on `target` costs nothing here.
   */
  private async latestUserEvents(ids: string[], targets: OutboxTarget[]): Promise<LatestAggregateEventRow[]> {
    const { rows } = await this.db.execute<LatestAggregateEventRow>(sql`
      SELECT DISTINCT ON (aggregate_id, target) aggregate_id, target, status
        FROM outbox_events
       WHERE aggregate_type = 'user'
         AND aggregate_id = ANY(${sql.param(ids)}::uuid[])
         AND target::text = ANY(${sql.param(targets)}::text[])
       ORDER BY aggregate_id, target, id DESC
    `)
    return rows
  }

  private async latestEventsForAggregateType(
    aggregateType: 'group',
    targets: OutboxTarget[],
  ): Promise<LatestAggregateEventRow[]> {
    const { rows } = await this.db.execute<LatestAggregateEventRow>(sql`
      SELECT DISTINCT ON (aggregate_id, target) aggregate_id, target, status
        FROM outbox_events
       WHERE aggregate_type = ${aggregateType}
         AND target::text = ANY(${sql.param(targets)}::text[])
       ORDER BY aggregate_id, target, id DESC
    `)
    return rows
  }

  private async latestMembershipEvents(targets: OutboxTarget[]): Promise<LatestMembershipEventRow[]> {
    const { rows } = await this.db.execute<LatestMembershipEventRow>(sql`
      SELECT DISTINCT ON (aggregate_id, target) aggregate_id, target, status, payload
        FROM outbox_events
       WHERE aggregate_type = 'membership'
         AND target::text = ANY(${sql.param(targets)}::text[])
       ORDER BY aggregate_id, target, id DESC
    `)
    return rows
  }
```

Replace the body of `resolveForUsers`:

```ts
  async resolveForUsers(userIds: readonly string[]): Promise<Map<string, SyncState>> {
    const result = new Map<string, SyncState>()
    if (userIds.length === 0) {
      return result
    }
    const ids = [...new Set(userIds)]

    const targets = await this.enabledTargets()
    if (targets.length === 0) {
      // No target is enabled, so nothing can be asserted anywhere and no
      // claim of health would be honest. Matches the pre-existing fallback
      // for a user with no events and no identity row.
      for (const userId of ids) result.set(userId, 'pending')
      return result
    }

    const [identityRows, userEvents, groupEvents, membershipEvents] = await Promise.all([
      this.db
        .select({
          userId: externalIdentities.userId,
          system: externalIdentities.system,
          syncState: externalIdentities.syncState,
        })
        .from(externalIdentities)
        .where(and(inArray(externalIdentities.userId, ids), inArray(externalIdentities.system, targets))),
      this.latestUserEvents(ids, targets),
      this.latestEventsForAggregateType('group', targets),
      this.latestMembershipEvents(targets),
    ])

    const eventByUserTarget = new Map<string, LatestAggregateEventRow['status']>()
    for (const row of userEvents) {
      eventByUserTarget.set(perTargetKey(row.aggregate_id, row.target), row.status)
    }
    const identityByUserSystem = new Map<string, 'pending' | 'synced' | 'failed'>()
    for (const row of identityRows) {
      identityByUserSystem.set(perTargetKey(row.userId, row.system), row.syncState)
    }

    // THE ORDERED RULE (spec: "The not-applicable subtlety"). The latest
    // event for a (user, target) decides first; the external_identities row
    // is consulted ONLY when that target has no event at all. A connector
    // that threw NotApplicableError leaves a `done` event and NO identity
    // row — settled, contributing nothing — which a naive "missing row means
    // pending" reading would turn into a permanently yellow badge.
    const troubledUsers = new Map<string, 'pending' | 'failed'>()
    for (const userId of ids) {
      for (const target of targets) {
        const key = perTargetKey(userId, target)
        const eventStatus = eventByUserTarget.get(key)
        if (eventStatus !== undefined) {
          const status = unsettledStatus(eventStatus)
          if (status !== null) raiseWorst(troubledUsers, userId, status)
          continue
        }
        const identity = identityByUserSystem.get(key)
        if (identity === 'failed') raiseWorst(troubledUsers, userId, 'failed')
        else if (identity !== 'synced') raiseWorst(troubledUsers, userId, 'pending')
      }
    }

    const affectedByGroup = new Map<string, 'pending' | 'failed'>()
    for (const row of groupEvents) {
      const status = unsettledStatus(row.status)
      if (status === null) continue
      const memberIds = await this.groups.listEffectiveUserMembers(row.aggregate_id)
      for (const memberId of memberIds) {
        raiseWorst(affectedByGroup, memberId, status)
      }
    }

    for (const row of membershipEvents) {
      const status = unsettledStatus(row.status)
      if (status === null) continue

      const payload = row.payload as { userId?: unknown; childGroupId?: unknown }
      if (typeof payload.userId === 'string') {
        raiseWorst(affectedByGroup, payload.userId, status)
      }
      if (typeof payload.childGroupId === 'string') {
        const memberIds = await this.groups.listEffectiveUserMembers(payload.childGroupId)
        for (const memberId of memberIds) {
          raiseWorst(affectedByGroup, memberId, status)
        }
      }
    }

    for (const userId of ids) {
      const worst = worseOf(troubledUsers.get(userId), affectedByGroup.get(userId))
      // No `?? identityByUser.get(userId)` tail any more: the per-target loop
      // above already folded every enabled target's identity row in, so
      // "nothing troubled" now genuinely means synced.
      result.set(userId, worst ?? 'synced')
    }
    return result
  }
```

- [ ] **Step 5: Correct the class doc comment**

The class doc still says the read model "stays intentionally Keycloak-scoped… seeds no other target as enabled". That is now false and was the root of the defect. Replace that clause with:

```
 * TARGET SCOPE (2026-08-08 sync-diagnostics spec). Both halves are scoped to
 * the targets currently `enabled` in `connector_targets`. This class was
 * formerly incoherent: the `external_identities` half filtered
 * `system = 'keycloak'` while the outbox half filtered no target whatsoever
 * — invisibly consistent while Keycloak was the only enabled target, and
 * silently wrong the moment `mail_server` was enabled, at which point a
 * dead-lettered mail event outranked a healthy Keycloak sync and the badge
 * could never go green again. Widening (not narrowing) is deliberate:
 * docs/product-brief.md's second requirement is that a user must never look
 * healthy while a real sync is broken.
```

- [ ] **Step 6: Run the full API suite**

Run: `pnpm --filter @idm/api test`

Expected: PASS, including all pre-existing `sync-state.repository` tests. If `outbox-emission.spec.ts` or `users.controller.spec.ts` regress, the cause is almost certainly a leaked `connector_targets` row from a test that enabled a second target without cleaning up — check `afterEach`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/outbox/sync-state.repository.ts apps/api/test/sync-state.repository.spec.ts
git commit -m "fix(sync): scope syncState derivation to enabled targets"
```

---

### Task 2: Schedule LifecycleJob

**Files:**
- Create: `deploy/systemd/idm-lifecycle.service`
- Create: `deploy/systemd/idm-lifecycle.timer`
- Modify: `scripts/install.sh:200-222`
- Modify: `apps/api/src/jml/lifecycle.job.ts` (doc comment only)
- Modify: `apps/api/src/jml/lifecycle-cli.ts` (doc comment only)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks. Fully independent of Tasks 1, 3, 4, 5 — safe to do in any order.

There is no unit test for a systemd unit file; verification is `systemd-analyze verify` plus a real timer listing on the box. That is the honest test here, and it is a real one.

- [ ] **Step 1: Create the oneshot service unit**

`deploy/systemd/idm-lifecycle.service` — mirrors `idm-api.service`'s templating (`@REPO_ROOT@`, `@IDM_USER@`) and its full hardening block, because it runs the same code against the same database with the same credentials.

```ini
[Unit]
Description=Identity Manager joiner/mover/leaver lifecycle pass
Documentation=file://@REPO_ROOT@/docs/07-admin-guide.md
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
Type=oneshot
User=@IDM_USER@
Group=@IDM_USER@
WorkingDirectory=@REPO_ROOT@/apps/api

EnvironmentFile=@REPO_ROOT@/.env

# The compiled output, not tsx — same reasoning as idm-api.service. This CLI
# constructs its dependencies by hand rather than through Nest, so it would
# in fact survive tsx, but running the same build artifact as the API keeps
# one deployment story and one thing to get wrong.
ExecStart=/usr/bin/node dist/src/jml/lifecycle-cli.js

# --- Hardening --------------------------------------------------------------
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=false
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

StandardOutput=journal
StandardError=journal
SyslogIdentifier=idm-lifecycle
```

- [ ] **Step 2: Create the timer unit**

`deploy/systemd/idm-lifecycle.timer`:

```ini
[Unit]
Description=Daily joiner/mover/leaver lifecycle pass
Documentation=file://@REPO_ROOT@/docs/07-admin-guide.md

[Timer]
OnCalendar=*-*-* 02:00:00

# A host powered off at 02:00 runs the missed pass on next boot instead of
# silently skipping a day. Without this an intermittently powered deployment
# would leave joiners disabled indefinitely — the exact failure this timer
# exists to prevent.
Persistent=true

# The job re-derives who is due from the database on every run and is
# structurally idempotent (LifecycleJob's own doc comment), so a jittered
# start is free and avoids a thundering herd if several hosts share a
# database.
RandomizedDelaySec=300

Unit=idm-lifecycle.service

[Install]
WantedBy=timers.target
```

- [ ] **Step 3: Install both units from install.sh**

In `scripts/install.sh`, immediately after the existing `sed`/`>` for `idm-api.service` (line ~203, before the `KEYCLOAK_CA_CERT` block), add:

```bash
for unit in idm-lifecycle.service idm-lifecycle.timer; do
  sed -e "s|@REPO_ROOT@|$REPO_ROOT|g" -e "s|@IDM_USER@|$IDM_USER|g" \
    "$REPO_ROOT/deploy/systemd/$unit" >"/etc/systemd/system/$unit"
done
```

Then change the existing enable line (line ~221) from:

```bash
systemctl enable idm-api >/dev/null
```

to:

```bash
systemctl enable idm-api >/dev/null
# The timer, not the service: enabling a Type=oneshot unit directly would
# ask systemd to run it once at boot and never again.
systemctl enable --now idm-lifecycle.timer >/dev/null
```

- [ ] **Step 4: Verify the units parse**

Run: `systemd-analyze verify deploy/systemd/idm-lifecycle.service deploy/systemd/idm-lifecycle.timer`

Expected: no output (success). The `@REPO_ROOT@` placeholders produce path warnings — expected in the uninstalled template, and the same warnings `idm-api.service` produces. `systemd-analyze` does not exist on Windows or macOS; if the dev machine cannot run it, say so explicitly and defer the check to the on-box step in Final Verification rather than marking this step done.

- [ ] **Step 5: Correct the two doc comments**

In `apps/api/src/jml/lifecycle.job.ts`, the class doc says "An ON-DEMAND script… no cron, no in-process timer". Replace that clause with:

```
 * An on-demand script that is ALSO scheduled: `deploy/systemd/
 * idm-lifecycle.timer` runs it daily at 02:00 (2026-08-08 sync-diagnostics
 * spec — before that timer existed, nothing on any host ever invoked this
 * job, so joiners with a start date were never activated and every connector
 * asserted them as disabled accounts indefinitely). Still no in-process
 * timer and no scheduler inside the API: the unit invokes `lifecycle-cli.ts`
 * exactly as an operator would.
```

In `apps/api/src/jml/lifecycle-cli.ts`, the doc says "in the same on-demand style — no scheduler, no cron (see the milestone plan, decision 4)". Replace with:

```
 * in the same on-demand style — invoked by hand, and daily by
 * `deploy/systemd/idm-lifecycle.timer` (2026-08-08 sync-diagnostics spec).
```

- [ ] **Step 6: Commit**

```bash
git add deploy/systemd/idm-lifecycle.service deploy/systemd/idm-lifecycle.timer \
        scripts/install.sh apps/api/src/jml/lifecycle.job.ts apps/api/src/jml/lifecycle-cli.ts
git commit -m "feat(jml): run the lifecycle pass on a daily systemd timer"
```

---

### Task 3: `GET /users/:id/sync`

**Files:**
- Create: `apps/api/src/outbox/sync-detail.repository.ts`
- Modify: `apps/api/src/users/users.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/users.controller.spec.ts`

**Interfaces:**
- Consumes: `SyncState` and `SyncStateRepository.resolveForUser` from Task 1. `GroupsRepository.listEffectiveGroupsForUser(userId: string): Promise<string[]>` — already exists at `groups.repository.ts:553`, returns group ids; no new group traversal is needed.
- Produces: `SyncDetailRepository.describeForUser(userId: string): Promise<UserSyncDetail>`, and the exported types `UserSyncLatestEvent`, `UserSyncTargetDetail`, `BlockingGroup`, `UserSyncDetail`. Task 5's web module mirrors these shapes exactly.

A separate repository rather than more methods on `SyncStateRepository`: that file is already ~270 dense lines whose single responsibility is deriving one enum value. Reading raw event rows for display is a different job with a different shape.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/users.controller.spec.ts`. **Read the top of that file first** and reuse its existing app bootstrap, actor stubbing and token helpers — the names below (`adminToken`, `auditorToken`, `userReadOnlyToken`, `narrowlyScopedToken`, `makeUser`, `makeUserInOtherOrgUnit`, `makeGroup`, `groupsRepo`, `ctx`) describe the roles this test needs, not necessarily the identifiers that file already uses. Map them onto whatever it actually provides; if a role has no existing helper, build it the same way the file builds its neighbours.

```ts
  describe('GET /users/:id/sync', () => {
    afterEach(async () => {
      await ctx.pool.query(`DELETE FROM connector_targets WHERE target = 'mail_server'`)
    })

    it('names the failing target and its attempt count', async () => {
      const user = await makeUser()
      await insertOutboxEvent('user', user.id, 'done', 'created')
      await setExternalIdentity(user.id, 'synced')
      await enableTarget('mail_server')
      await insertOutboxEvent('user', user.id, 'failed', 'created', {}, 'mail_server', {
        attempts: 8,
        lastError: 'secret "CONNECTOR_MAIL_SERVER_TOKEN" is not set in the environment',
      })

      const response = await request(app.getHttpServer())
        .get(`/users/${user.id}/sync`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(response.body.syncState).toBe('failed')
      const mail = response.body.targets.find((t: { target: string }) => t.target === 'mail_server')
      expect(mail.state).toBe('failed')
      expect(mail.latestEvent.attempts).toBe(8)
    })

    it('redacts raw connector error text from a caller without a GLOBAL audit:read grant', async () => {
      const user = await makeUser()
      await enableTarget('mail_server')
      await insertOutboxEvent('user', user.id, 'failed', 'created', {}, 'mail_server', {
        attempts: 8,
        lastError: 'bind failed for CN=svc,DC=corp — credential rejected',
      })

      const response = await request(app.getHttpServer())
        .get(`/users/${user.id}/sync`)
        .set('Authorization', `Bearer ${userReadOnlyToken}`)
        .expect(200)

      expect(response.body.errorDetailRedacted).toBe(true)
      const mail = response.body.targets.find((t: { target: string }) => t.target === 'mail_server')
      expect(mail.latestEvent.lastError).toBeNull()
      // The structural facts still come through — that is the whole point of
      // the split: an admin can escalate without reading vendor error text.
      expect(mail.latestEvent.attempts).toBe(8)
      expect(mail.state).toBe('failed')
    })

    it('exposes raw error text to a global audit:read holder', async () => {
      const user = await makeUser()
      await enableTarget('mail_server')
      await insertOutboxEvent('user', user.id, 'failed', 'created', {}, 'mail_server', {
        attempts: 8,
        lastError: 'bind failed for CN=svc,DC=corp — credential rejected',
      })

      const response = await request(app.getHttpServer())
        .get(`/users/${user.id}/sync`)
        .set('Authorization', `Bearer ${auditorToken}`)
        .expect(200)

      expect(response.body.errorDetailRedacted).toBe(false)
      const mail = response.body.targets.find((t: { target: string }) => t.target === 'mail_server')
      expect(mail.latestEvent.lastError).toContain('credential rejected')
    })

    it('names the group dragging a user down', async () => {
      const group = await makeGroup('Blocking Group')
      const user = await makeUser()
      await groupsRepo().addUser(group.id, user.id)
      await insertOutboxEvent('user', user.id, 'done', 'created')
      await setExternalIdentity(user.id, 'synced')
      await insertOutboxEvent('group', group.id, 'failed', 'updated')

      const response = await request(app.getHttpServer())
        .get(`/users/${user.id}/sync`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200)

      expect(response.body.syncState).toBe('failed')
      expect(response.body.blockedByGroups).toHaveLength(1)
      expect(response.body.blockedByGroups[0].groupId).toBe(group.id)
      expect(response.body.blockedByGroups[0].groupName).toContain('Blocking Group')
    })

    it('403s for a user outside the caller org-unit scope', async () => {
      const user = await makeUserInOtherOrgUnit()
      await request(app.getHttpServer())
        .get(`/users/${user.id}/sync`)
        .set('Authorization', `Bearer ${narrowlyScopedToken}`)
        .expect(403)
    })

    it('404s for a user that does not exist, proving :id does not swallow :id/sync', async () => {
      await request(app.getHttpServer())
        .get('/users/00000000-0000-0000-0000-000000000000/sync')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404)
    })
  })
```

This file needs the same `insertOutboxEvent` / `setExternalIdentity` / `enableTarget` helpers Task 1 added to the sync-state spec, plus an options bag for `attempts` and `lastError`. Add them if absent:

```ts
  async function insertOutboxEvent(
    aggregateType: 'user' | 'group' | 'membership',
    aggregateId: string,
    status: 'pending' | 'processing' | 'done' | 'failed',
    eventType: 'created' | 'updated' | 'status_changed' | 'membership_changed' = 'updated',
    payload: Record<string, unknown> = {},
    target: 'keycloak' | 'mail_server' | 'echo' = 'keycloak',
    extra: { attempts?: number; lastError?: string } = {},
  ): Promise<number> {
    const { rows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO outbox_events
         (aggregate_type, aggregate_id, event_type, payload, status, target, attempts, last_error)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
       RETURNING id`,
      [
        aggregateType, aggregateId, eventType, JSON.stringify(payload), status, target,
        extra.attempts ?? 0, extra.lastError ?? null,
      ],
    )
    return Number(rows[0]!.id)
  }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @idm/api test -- users.controller`

Expected: all six new tests FAIL with 404, because the route does not exist.

- [ ] **Step 3: Create the detail repository**

`apps/api/src/outbox/sync-detail.repository.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { connectorTargets } from '../db/schema/connector-targets'
import { externalIdentities } from '../db/schema/external-identities'
import * as schema from '../db/schema/index'
import { GroupsRepository } from '../groups/groups.repository'
import type { OutboxEventType, OutboxTarget } from './outbox.writer'
import { type SyncState, SyncStateRepository } from './sync-state.repository'

/** One target's latest attempt, as the console renders it. `lastError` is populated here and REDACTED by the controller for callers without a global `audit:read` grant — see UsersController.syncDetail. */
export interface UserSyncLatestEvent {
  id: number
  eventType: OutboxEventType
  status: 'pending' | 'processing' | 'done' | 'failed'
  attempts: number
  createdAt: Date
  nextAttemptAt: Date
  lastError: string | null
}

export interface UserSyncTargetDetail {
  target: OutboxTarget
  enabled: boolean
  /** This ONE target's contribution under the ordered rule, before the worst-of aggregation. Deliberately no fourth `not_applicable` value — that is inferred from "a done event with no identity row", not a fact the database holds, and inventing a value would imply otherwise. Such a target reports `'synced'`; its null `externalId` is what distinguishes it. */
  state: SyncState
  externalId: string | null
  lastSyncedAt: Date | null
  latestEvent: UserSyncLatestEvent | null
}

export interface BlockingGroup {
  groupId: string
  groupName: string
  target: OutboxTarget
  status: 'pending' | 'processing' | 'failed'
  attempts: number
}

export interface UserSyncDetail {
  /** Identical to the badge's own value — computed by SyncStateRepository, never recomputed here, so the panel can never disagree with the badge it explains. */
  syncState: SyncState
  targets: UserSyncTargetDetail[]
  blockedByGroups: BlockingGroup[]
  errorDetailRedacted: boolean
}

type TargetEventRow = {
  target: OutboxTarget
  id: string
  event_type: OutboxEventType
  status: 'pending' | 'processing' | 'done' | 'failed'
  attempts: number
  created_at: Date
  next_attempt_at: Date
  last_error: string | null
}

type BlockingGroupRow = {
  group_id: string
  group_name: string
  target: OutboxTarget
  status: 'pending' | 'processing' | 'failed'
  attempts: number
}

/** The ordered rule from the spec, for ONE target: the latest event decides, and the identity row is consulted only when there is no event. */
function perTargetState(
  eventStatus: 'pending' | 'processing' | 'done' | 'failed' | undefined,
  identityState: 'pending' | 'synced' | 'failed' | undefined,
): SyncState {
  if (eventStatus === 'failed') return 'failed'
  if (eventStatus === 'pending' || eventStatus === 'processing') return 'pending'
  if (eventStatus === 'done') return 'synced'
  if (identityState === 'failed') return 'failed'
  if (identityState === 'synced') return 'synced'
  return 'pending'
}

/**
 * The per-user, per-target breakdown behind `GET /users/:id/sync` — the
 * explanation for whatever `SyncStateRepository` derived (2026-08-08
 * sync-diagnostics spec). Separate class, not more methods on that one:
 * deriving a single enum and listing raw rows for display are different
 * jobs, and that file is already dense.
 *
 * `syncState` is DELEGATED to `SyncStateRepository`, never recomputed, so a
 * panel can never contradict the badge it exists to explain.
 */
@Injectable()
export class SyncDetailRepository {
  constructor(
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
    @Inject(SyncStateRepository) private readonly syncStates: SyncStateRepository,
    @Inject(GroupsRepository) private readonly groups: GroupsRepository,
  ) {}

  async describeForUser(userId: string): Promise<UserSyncDetail> {
    const targetRows = await this.db
      .select({ target: connectorTargets.target })
      .from(connectorTargets)
      .where(eq(connectorTargets.enabled, true))
    const targets = targetRows.map((row) => row.target)

    const syncState = await this.syncStates.resolveForUser(userId)

    if (targets.length === 0) {
      return { syncState, targets: [], blockedByGroups: [], errorDetailRedacted: false }
    }

    const [events, identityRows, blocking] = await Promise.all([
      this.latestEventPerTarget(userId, targets),
      this.db
        .select({
          system: externalIdentities.system,
          externalId: externalIdentities.externalId,
          syncState: externalIdentities.syncState,
          lastSyncedAt: externalIdentities.lastSyncedAt,
        })
        .from(externalIdentities)
        .where(and(eq(externalIdentities.userId, userId), inArray(externalIdentities.system, targets))),
      this.blockingGroups(userId, targets),
    ])

    const eventByTarget = new Map(events.map((row) => [row.target, row]))
    const identityByTarget = new Map(identityRows.map((row) => [row.system, row]))

    const targetDetails: UserSyncTargetDetail[] = targets.map((target) => {
      const event = eventByTarget.get(target)
      const identity = identityByTarget.get(target)
      return {
        target,
        enabled: true,
        state: perTargetState(event?.status, identity?.syncState),
        externalId: identity?.externalId ?? null,
        lastSyncedAt: identity?.lastSyncedAt ?? null,
        latestEvent:
          event === undefined
            ? null
            : {
                id: Number(event.id),
                eventType: event.event_type,
                status: event.status,
                attempts: event.attempts,
                createdAt: event.created_at,
                nextAttemptAt: event.next_attempt_at,
                lastError: event.last_error,
              },
      }
    })

    return { syncState, targets: targetDetails, blockedByGroups: blocking, errorDetailRedacted: false }
  }

  private async latestEventPerTarget(userId: string, targets: OutboxTarget[]): Promise<TargetEventRow[]> {
    const { rows } = await this.db.execute<TargetEventRow>(sql`
      SELECT DISTINCT ON (target)
             target, id, event_type, status, attempts, created_at, next_attempt_at, last_error
        FROM outbox_events
       WHERE aggregate_type = 'user'
         AND aggregate_id = ${userId}::uuid
         AND target::text = ANY(${sql.param(targets)}::text[])
       ORDER BY target, id DESC
    `)
    return rows
  }

  /**
   * Groups whose own latest event is unsettled AND which this user is
   * currently an effective member of. Mirrors `SyncStateRepository`'s group
   * half so the panel names exactly what the badge reacted to. Group
   * traversal is delegated to `GroupsRepository.listEffectiveGroupsForUser`
   * — the forward direction of the walk `SyncStateRepository` runs backwards
   * — rather than inlining a second recursive CTE here.
   *
   * Deliberately covers the `group` aggregate only, not `membership`: a
   * membership event's affected user is carried in its payload rather than
   * being a property of the group, and naming "the group you were removed
   * from" as a current blocker would read as though the user were still in
   * it. The badge still reflects those events (Task 1 is unchanged); this
   * list simply does not claim a membership they no longer have.
   */
  private async blockingGroups(userId: string, targets: OutboxTarget[]): Promise<BlockingGroup[]> {
    const groupIds = await this.groups.listEffectiveGroupsForUser(userId)
    if (groupIds.length === 0) return []

    const { rows } = await this.db.execute<BlockingGroupRow>(sql`
      SELECT e.aggregate_id AS group_id, g.name AS group_name, e.target, e.status, e.attempts
        FROM (
          SELECT DISTINCT ON (aggregate_id, target) aggregate_id, target, status, attempts
            FROM outbox_events
           WHERE aggregate_type = 'group'
             AND aggregate_id = ANY(${sql.param(groupIds)}::uuid[])
             AND target::text = ANY(${sql.param(targets)}::text[])
           ORDER BY aggregate_id, target, id DESC
        ) e
        JOIN groups g ON g.id = e.aggregate_id
       WHERE e.status IN ('pending', 'processing', 'failed')
       ORDER BY g.name, e.target
    `)

    return rows.map((row) => ({
      groupId: row.group_id,
      groupName: row.group_name,
      target: row.target,
      status: row.status,
      attempts: row.attempts,
    }))
  }
}
```

- [ ] **Step 4: Add the controller route**

In `apps/api/src/users/users.controller.ts`, add the import:

```ts
import { SyncDetailRepository, type UserSyncDetail } from '../outbox/sync-detail.repository'
```

Add `@Inject(SyncDetailRepository) private readonly syncDetails: SyncDetailRepository` to the constructor, then add this route directly after `findOne`:

```ts
  /**
   * Why is this person's badge that colour (2026-08-08 sync-diagnostics
   * spec). Same `user:read` permission and the same org-unit scoping as
   * `findOne` — this is the detail behind a field that route already
   * returns, not a new category of information.
   *
   * EXCEPT for `lastError`. `OutboxController` gates dead letters behind a
   * GLOBAL `audit:read` precisely because raw target error text "should not
   * widen with a narrow grant", and that decision is not overturned here:
   * every structural fact (state, attempts, next retry, timestamps) is
   * visible under `user:read`, while the raw string is nulled unless the
   * caller ALSO holds `audit:read` globally. `errorDetailRedacted` tells the
   * console to say so explicitly rather than render a misleading blank.
   */
  @Get(':id/sync')
  @RequirePermission('user:read')
  async syncDetail(
    @Param('id') rawId: string,
    @Req() request: AuthorizedRequest,
  ): Promise<UserSyncDetail> {
    const id = parseId(rawId)
    const user = await this.users.findById(id)
    if (user === null) {
      throw new NotFoundError('user', id)
    }
    await this.engine.assertCanIn(request.actor, 'user:read', user.orgUnitId)

    const detail = await this.syncDetails.describeForUser(id)

    // `null` means at least one granting assignment has no org-unit scope,
    // i.e. a global grant. An actor with NO audit:read at all yields `[]`,
    // which correctly fails this check — see PermissionEngine.scopePathsFor.
    const hasGlobalAuditRead = (await this.engine.scopePathsFor(request.actor, 'audit:read')) === null
    if (hasGlobalAuditRead) {
      return detail
    }
    return {
      ...detail,
      errorDetailRedacted: true,
      targets: detail.targets.map((target) => ({
        ...target,
        latestEvent: target.latestEvent === null ? null : { ...target.latestEvent, lastError: null },
      })),
    }
  }
```

- [ ] **Step 5: Register the provider**

In `apps/api/src/app.module.ts`, add `SyncDetailRepository` to the `providers` array next to `SyncStateRepository`, with its import.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @idm/api test -- users.controller`

Expected: PASS, all six.

- [ ] **Step 7: Run the full API suite and typecheck**

Run: `pnpm --filter @idm/api test && pnpm --filter @idm/api typecheck`

Expected: PASS. `app.module.spec.ts` asserts DI resolves for every provider — a missing registration surfaces there. `guard-coverage.spec.ts` asserts every route carries a permission decorator — a missing `@RequirePermission` surfaces there.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/outbox/sync-detail.repository.ts apps/api/src/users/users.controller.ts \
        apps/api/src/app.module.ts apps/api/test/users.controller.spec.ts
git commit -m "feat(sync): add GET /users/:id/sync"
```

---

### Task 4: Fix the web connector-target drift

**Files:**
- Modify: `apps/web/src/connectors/api.ts:4-20`
- Modify: `apps/web/src/audit/outbox-api.ts:22`

**Interfaces:**
- Consumes: nothing.
- Produces: `ConnectorTarget` (widened to include `'mail_server'`) and `CONNECTOR_TARGET_LABEL` covering it. Task 5 imports both.

`apps/api/src/connectors/connector.ts:22-35` records that five hand-copied literal lists went stale when `mail_server` was added, and instructs that no literal list of targets be reintroduced. The **web** still has one, and it is still missing `mail_server` — so the connectors console cannot list or disable the mail target, and `CONNECTOR_TARGET_LABEL[event.target]` renders `undefined` for exactly the dead letter this whole plan is about. Fixing it is a prerequisite for Task 5 rendering correctly, not scope creep.

- [ ] **Step 1: Widen the union and the label map**

In `apps/web/src/connectors/api.ts`, add `'mail_server'` to the `ConnectorTarget` union, to `ALL_CONNECTOR_TARGETS`, and to `CONNECTOR_TARGET_LABEL` with the label `Mail server`. Read the existing entries first and match their ordering and comment style.

Add this comment above the union:

```ts
/**
 * Mirrors `ALL_CONNECTOR_TARGETS` (apps/api/src/connectors/connector.ts).
 * That module's doc comment records why a hand-copied list is dangerous —
 * five of them went stale when `mail_server` was added and the type system
 * could not see it, because a narrower literal list is assignable to a wider
 * union. This list went stale the same way and for the same reason: the
 * console could not list, configure or disable the mail target, and a
 * mail_server dead letter rendered with an undefined label. There is no
 * shared package between apps, so this copy must be updated by hand whenever
 * the API's list changes — check it whenever a target is added.
 */
```

- [ ] **Step 2: Point the dead-letter type at the shared union**

In `apps/web/src/audit/outbox-api.ts`, replace the inline `target:` union on `DeadLetterEvent` (line 22) with the imported type, deleting the third copy of the list:

```ts
import type { ConnectorTarget } from '../connectors/api'
```

```ts
  target: ConnectorTarget
```

Delete the now-inaccurate paragraph in that interface's doc comment claiming `target` "is always `'keycloak'` in practice" — `mail_server` is enabled in real deployments and this is precisely the case the view must render.

- [ ] **Step 3: Verify the console builds and its token check passes**

Run: `pnpm --filter @idm/web build && pnpm --filter @idm/web test`

Expected: PASS. A `Record<ConnectorTarget, string>` with a missing key is a compile error, so a widened union that missed the label map fails here rather than at runtime.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/connectors/api.ts apps/web/src/audit/outbox-api.ts
git commit -m "fix(web): add mail_server to the console connector target list"
```

---

### Task 5: The console Sync tab

**Files:**
- Create: `apps/web/src/people/PersonSyncTab.tsx`
- Modify: `apps/web/src/people/api.ts`
- Modify: `apps/web/src/people/PersonDetailPage.tsx`
- Modify: `apps/web/src/people/PersonDetailPage.css`
- Test: `apps/web/e2e/people.spec.ts`

**Interfaces:**
- Consumes: `GET /users/:id/sync` and the `UserSyncDetail` shape from Task 3; `ConnectorTarget` and `CONNECTOR_TARGET_LABEL` from Task 4; `SyncBadge` and `SYNC_WORD` from `./badges`; `DEFAULT_MAX_ATTEMPTS` from `../audit/outbox-api`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the API client function**

Append to `apps/web/src/people/api.ts`, mirroring the module's existing `authorizedRequest` style:

```ts
import type { ConnectorTarget } from '../connectors/api'

/** Mirrors `UserSyncLatestEvent` (apps/api/src/outbox/sync-detail.repository.ts). `lastError` is `null` when the caller lacks a GLOBAL `audit:read` grant — see `UserSyncDetail.errorDetailRedacted`. */
export interface UserSyncLatestEvent {
  id: number
  eventType: string
  status: 'pending' | 'processing' | 'done' | 'failed'
  attempts: number
  createdAt: string
  nextAttemptAt: string
  lastError: string | null
}

export interface UserSyncTargetDetail {
  target: ConnectorTarget
  enabled: boolean
  state: SyncState
  externalId: string | null
  lastSyncedAt: string | null
  latestEvent: UserSyncLatestEvent | null
}

export interface BlockingGroup {
  groupId: string
  groupName: string
  target: ConnectorTarget
  status: 'pending' | 'processing' | 'failed'
  attempts: number
}

export interface UserSyncDetail {
  syncState: SyncState
  targets: UserSyncTargetDetail[]
  blockedByGroups: BlockingGroup[]
  /** `true` when raw connector error text was withheld — the caller holds `user:read` but not a global `audit:read`. The UI must say so rather than render an empty error cell. */
  errorDetailRedacted: boolean
}

export function fetchPersonSync(accessToken: string, id: string): Promise<UserSyncDetail> {
  return authorizedRequest<UserSyncDetail>(`/users/${id}/sync`, accessToken)
}
```

- [ ] **Step 2: Build the tab component**

Create `apps/web/src/people/PersonSyncTab.tsx`. **Read `apps/web/src/audit/DeadLettersTab.tsx` first** and match its loading/error/empty-state structure, its access-token hook, and its date formatting — this tab is its per-user sibling and must not invent a second visual language. The skeleton below is the required structure and test hooks; fill the imports and the token/loading idiom from that file.

```tsx
export function PersonSyncTab({ personId }: { personId: string }) {
  const [detail, setDetail] = useState<UserSyncDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Same fetch-on-mount-and-on-id-change idiom DeadLettersTab uses; copy its
  // cancellation handling so a fast tab switch cannot set state after unmount.

  if (error !== null) return <p className="error">{error}</p>
  if (detail === null) return <p>Loading sync detail…</p>
  if (detail.targets.length === 0) return <p>No connector targets are enabled.</p>

  return (
    <>
      <div className="table-scroll">
        <table className="table" data-testid="person-sync-table">
          <thead>
            <tr>
              <th scope="col">Target</th>
              <th scope="col">State</th>
              <th scope="col">External ID</th>
              <th scope="col">Last synced</th>
              <th scope="col">Attempts</th>
              <th scope="col">Next retry</th>
              <th scope="col">Error</th>
            </tr>
          </thead>
          <tbody>
            {detail.targets.map((row) => (
              <tr key={row.target} data-testid="person-sync-row">
                <td data-testid="person-sync-target">{CONNECTOR_TARGET_LABEL[row.target]}</td>
                <td data-testid="person-sync-state">
                  <SyncBadge state={row.state} />
                </td>
                <td>{row.externalId ?? '—'}</td>
                <td>{row.lastSyncedAt === null ? '—' : formatDateTime(row.lastSyncedAt)}</td>
                <td data-testid="person-sync-attempts">
                  {row.latestEvent === null
                    ? '—'
                    : `${row.latestEvent.attempts} of ${DEFAULT_MAX_ATTEMPTS}`}
                </td>
                <td>
                  {row.latestEvent === null || row.latestEvent.status !== 'pending'
                    ? '—'
                    : formatDateTime(row.latestEvent.nextAttemptAt)}
                </td>
                <td data-testid="person-sync-error">
                  {row.latestEvent?.lastError ??
                    (detail.errorDetailRedacted && row.state === 'failed'
                      ? 'Error detail requires the auditor role'
                      : '—')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail.blockedByGroups.length > 0 && (
        <section>
          <h3>Blocked by group</h3>
          <p>
            These groups have an unsettled sync of their own. Until they settle, this person&rsquo;s
            badge reflects that, even when their own account synced cleanly.
          </p>
          <ul>
            {detail.blockedByGroups.map((group) => (
              <li key={`${group.groupId}-${group.target}`} data-testid="person-sync-blocking-group">
                {group.groupName} — {CONNECTOR_TARGET_LABEL[group.target]}, {group.status},{' '}
                {group.attempts} of {DEFAULT_MAX_ATTEMPTS} attempts
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
```

Follow `docs/design-system.md` — word plus optional shape, never colour alone. `SyncBadge` already encodes this; do not add a second colour treatment. If `.table-scroll` does not already exist in the console's CSS, add it to `PersonDetailPage.css` as `overflow-x: auto;` so a narrow viewport scrolls the table rather than the page.

- [ ] **Step 3: Wire the tab into PersonDetailPage**

In `apps/web/src/people/PersonDetailPage.tsx`:

1. Add `'sync'` to `TabKey` (line 16) and a `{ key: 'sync', label: 'Sync' }` entry to `TABS`, positioned between `roles` and `activity`.
2. Add `sync: null` to the `tabRefs` initializer (line 209) — a missing key there silently breaks arrow-key navigation.
3. Add the panel block, copying the exact shape of the neighbouring panels:

```tsx
      <div
        id="panel-sync"
        role="tabpanel"
        aria-labelledby="tab-sync"
        hidden={activeTab !== 'sync'}
        tabIndex={0}
        className="tabpanel"
      >
        <PersonSyncTab personId={person.id} />
      </div>
```

4. Make the header `SyncBadge` (line 404) activate the tab, so a red badge is one click from its reason:

```tsx
          <button
            type="button"
            className="badge-link"
            onClick={() => activateTab('sync')}
            aria-label={`${SYNC_WORD[person.syncState]} — show sync detail`}
          >
            <SyncBadge state={person.syncState} />
          </button>
```

Add a `.badge-link` rule to `PersonDetailPage.css` resetting button chrome (`background: none; border: 0; padding: 0; cursor: pointer;`) with a visible `:focus-visible` outline — it is now a keyboard-reachable control and must show focus.

- [ ] **Step 4: Add the E2E cases**

`apps/web/e2e/people.spec.ts` deliberately asserts against whatever the dev environment has seeded rather than creating dedicated fixtures (see its own comment at line 134: "regardless of how many people a given dev environment has seeded"). Match that style — do not invent a fixture id.

```ts
test('the Sync tab lists a row per enabled connector target', async ({ page }) => {
  await signIn(page)
  await page.goto('/people')
  await page.getByTestId('person-row-link').first().click()

  await page.getByRole('tab', { name: 'Sync' }).click()
  await expect(page.getByTestId('person-sync-table')).toBeVisible()

  // At least Keycloak is always enabled — connector_targets seeds exactly
  // that one row (db/schema/connector-targets.ts), so this holds in any
  // environment without depending on what else an operator turned on.
  const rows = page.getByTestId('person-sync-row')
  await expect(rows.filter({ hasText: 'Keycloak' })).toHaveCount(1)
})

test('the header sync badge opens the Sync tab', async ({ page }) => {
  await signIn(page)
  await page.goto('/people')
  await page.getByTestId('person-row-link').first().click()

  await page.getByRole('button', { name: /show sync detail/ }).click()
  await expect(page.getByRole('tab', { name: 'Sync' })).toHaveAttribute('aria-selected', 'true')
})
```

Reuse that file's actual sign-in helper and row-link selector rather than the names above if they differ — read the top of the file.

**Also check the existing tabs test at `people.spec.ts:177`** ("the Person detail tabs are keyboard operable with arrow keys"). Adding a fifth tab changes the arrow-key wrap-around. If that test hardcodes a tab count or a specific end-of-list tab, update it.

- [ ] **Step 5: Run the console build and E2E**

Run: `pnpm --filter @idm/web build && pnpm --filter @idm/web test`

Then: `pnpm --filter @idm/web test:e2e -- people`

Expected: PASS. The E2E suite needs the API, a database and Keycloak running — check `apps/web/e2e/support` for how the other specs bootstrap. If the environment cannot run them, say so explicitly rather than marking this step done.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/people/PersonSyncTab.tsx apps/web/src/people/api.ts \
        apps/web/src/people/PersonDetailPage.tsx apps/web/src/people/PersonDetailPage.css \
        apps/web/e2e/people.spec.ts
git commit -m "feat(web): explain a sync badge on the person detail page"
```

---

## Final verification

- [ ] **Run everything**

```bash
pnpm -r test && pnpm -r run typecheck && pnpm -r build
```

- [ ] **Update the docs that describe this behaviour**

`docs/09-connectors-and-sync.md` describes sync state derivation and `docs/11-operations.md` covers operational runbooks. Both predate this change. Add: what the badge now aggregates over, that a per-user Sync tab exists and what its two permission levels show, and that `idm-lifecycle.timer` runs the lifecycle pass daily.

Leave `docs/07-admin-guide.md:104` alone — the activate-endpoint spec already claims that line, and half-fixing it here would collide with that work.

- [ ] **Deploy and verify on ct:101**

The code fixes do not by themselves clear the currently stuck user. In order:

1. Deploy, then `systemctl restart idm-api` so the process finally picks up `CONNECTOR_MAIL_SERVER_TOKEN` from `.env` (added 2026-08-08 19:59, after the service last started at 18:48).
2. `systemctl list-timers idm-lifecycle.timer` — confirm it is armed, then `systemctl start idm-lifecycle.service` once by hand to activate `test` and `helpdesk` immediately rather than waiting for 02:00.
3. `pnpm --filter @idm/api run reconcile` to re-drive the dead-lettered mail_server event for `test`.
4. Open `test`'s Sync tab and confirm it shows Keycloak synced and mail_server's real state — that is the end-to-end proof this whole plan exists for.
