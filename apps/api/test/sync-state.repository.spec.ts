import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard, type AuthorizedRequest } from '../src/authz/permission.guard'
import { PrivilegeGuards } from '../src/authz/privilege.guards'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { GroupsRepository } from '../src/groups/groups.repository'
import { KEYCLOAK_ADMIN_CONFIG, KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { SyncStateRepository } from '../src/outbox/sync-state.repository'
import { UsersController } from '../src/users/users.controller'
import { type User, UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

// Postgres-only — SyncStateRepository never talks to Keycloak, only
// `outbox_events`/`external_identities`/effective group membership. The
// HTTP-level block below needs a well-formed KeycloakAdminClient purely for
// UsersController's own DI (never actually called by a GET route).
const UNREACHABLE_KEYCLOAK_CONFIG = {
  issuer: 'http://127.0.0.1:1/realms/unreachable',
  clientId: 'irrelevant',
  clientSecret: 'irrelevant',
}

/**
 * MILESTONE 4, TASK 4: `syncState` derivation. Proves the specific hole
 * task-3-report.md flagged and task-4-brief.md requires closing — a
 * dead-lettered `membership`/`group` FAN-OUT event does not regress any
 * single affected user's `external_identities` row (see
 * SyncWorker.markUserSyncFailed's doc comment, decision 5), so deriving
 * `syncState` from `external_identities` ALONE would show that user as
 * healthy. Every test in the "group/membership fan-out" block below is
 * constructed so that `external_identities.sync_state` reads `'synced'`
 * throughout — if `SyncStateRepository` were simplified to a bare
 * `external_identities` passthrough, those specific tests would fail.
 *
 * Outbox rows are constructed directly via raw SQL (status included) —
 * out of this task's controller file scope, and it lets each test pin an
 * EXACT status (`pending`/`failed`/`done`) rather than driving a whole
 * worker run just to reach one.
 */
describe('SyncStateRepository (Milestone 4, Task 4)', () => {
  const ctx = withTestDatabase()
  let orgUnitId: string

  beforeAll(async () => {
    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`Sync State Root ${Date.now()}`)).id
  })

  const usersRepo = () => new UsersRepository(ctx.db)
  const groupsRepo = () => new GroupsRepository(ctx.db)
  const syncStates = () => new SyncStateRepository(ctx.db, groupsRepo())

  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `${fixtureSeq}`
  }

  async function makeUser(): Promise<User> {
    const tag = nextTag()
    const username = `sync-state-user-${tag}@example.com`.toLowerCase()
    return usersRepo().create({
      primaryEmail: username,
      username,
      firstName: 'Sync',
      lastName: `State${tag}`,
      orgUnitId,
    })
  }

  async function makeGroup(label: string) {
    return groupsRepo().create({ name: `${label} ${nextTag()}` })
  }

  /**
   * Inserts one outbox row with an EXPLICIT status — bypassing the worker
   * entirely, to pin exact scenarios. `payload` defaults to `{}` (fine for
   * `user`/`group` rows, which resolveForUsers never reads); a `membership`
   * row exercising finding H3's fix (docs/superpowers/audit-integrity.md)
   * needs a REALISTIC payload — every real emitter always populates
   * `userId` or `childGroupId` (see GroupsController's/RuleApplier's own
   * membership-event call sites) — passed explicitly by the caller.
   */
  async function insertOutboxEvent(
    aggregateType: 'user' | 'group' | 'membership',
    aggregateId: string,
    status: 'pending' | 'processing' | 'done' | 'failed',
    eventType: 'created' | 'updated' | 'status_changed' | 'membership_changed' = 'updated',
    payload: Record<string, unknown> = {},
  ): Promise<number> {
    const { rows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, status)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id`,
      [aggregateType, aggregateId, eventType, JSON.stringify(payload), status],
    )
    return Number(rows[0]!.id)
  }

  async function setExternalIdentity(
    userId: string,
    syncState: 'pending' | 'synced' | 'failed',
  ): Promise<void> {
    await ctx.pool.query(
      `INSERT INTO external_identities (user_id, system, external_id, sync_state, last_synced_at)
       VALUES ($1, 'keycloak', $2, $3, now())
       ON CONFLICT (user_id, system) DO UPDATE SET sync_state = EXCLUDED.sync_state`,
      [userId, `kc-${userId}`, syncState],
    )
  }

  // =====================================================================
  // Baseline behaviour: user-aggregate events, external_identities.
  // =====================================================================
  describe('direct user-aggregate derivation', () => {
    it('reads pending for a brand-new user with only a pending "created" event', async () => {
      const user = await makeUser()
      await insertOutboxEvent('user', user.id, 'pending', 'created')
      expect(await syncStates().resolveForUser(user.id)).toBe('pending')
    })

    it('reads synced once the user event is done and external_identities agrees', async () => {
      const user = await makeUser()
      await insertOutboxEvent('user', user.id, 'done', 'created')
      await setExternalIdentity(user.id, 'synced')
      expect(await syncStates().resolveForUser(user.id)).toBe('synced')
    })

    it('reads failed when the latest user event is a dead letter', async () => {
      const user = await makeUser()
      await insertOutboxEvent('user', user.id, 'done', 'created')
      await setExternalIdentity(user.id, 'synced')
      await insertOutboxEvent('user', user.id, 'failed', 'updated')
      expect(await syncStates().resolveForUser(user.id)).toBe('failed')
    })

    // Dead letters are never deleted (they "stay visible... forever"), but
    // that must not make syncState STICK at 'failed' forever once the
    // aggregate genuinely recovers — only the LATEST event should count.
    // A later mutation enqueuing a NEW event (which IS reachable: the
    // claim query only blocks on older pending/processing rows, never on
    // older FAILED ones — see OutboxRepository.claimNext) that succeeds
    // must read as healthy again.
    it('does not stay stuck at failed once a LATER event for the same aggregate succeeds', async () => {
      const user = await makeUser()
      await insertOutboxEvent('user', user.id, 'failed', 'created') // an old, permanent dead letter
      await insertOutboxEvent('user', user.id, 'done', 'updated') // a later, successful attempt
      await setExternalIdentity(user.id, 'synced')

      expect(await syncStates().resolveForUser(user.id)).toBe('synced')
    })

    it('falls back to pending when neither an event nor an external_identities row exists', async () => {
      const user = await makeUser()
      expect(await syncStates().resolveForUser(user.id)).toBe('pending')
    })
  })

  // =====================================================================
  // THE gap this task exists to close.
  // =====================================================================
  describe('group/membership fan-out — the gap task-3-report.md flagged', () => {
    it('surfaces a user as failed via a dead-lettered GROUP event, even though external_identities still says synced', async () => {
      const group = await makeGroup('Failing Group')
      const user = await makeUser()
      await groupsRepo().addUser(group.id, user.id)

      // Simulates a user who already synced successfully once (as
      // SyncWorker.reconcileUser would leave them) and whose
      // external_identities row a LATER group-level failure never touches
      // — see SyncWorker.markUserSyncFailed's doc comment (decision 5): a
      // membership/group dead-letter never regresses any single affected
      // user's external_identities row.
      await insertOutboxEvent('user', user.id, 'done', 'created')
      await setExternalIdentity(user.id, 'synced')

      // The group's own rename/attribute-update event dead-letters.
      await insertOutboxEvent('group', group.id, 'failed', 'updated')

      // If syncState were derived from external_identities ALONE, this
      // would read 'synced' — silently healthy despite this user's actual
      // group sync having failed. This is exactly the hole
      // task-3-report.md flagged and task-4-brief.md requires closing.
      expect(await syncStates().resolveForUser(user.id)).toBe('failed')
    })

    it('also surfaces via a dead-lettered MEMBERSHIP event, not just a group rename', async () => {
      const group = await makeGroup('Failing Membership Group')
      const user = await makeUser()
      await groupsRepo().addUser(group.id, user.id)

      await insertOutboxEvent('user', user.id, 'done', 'created')
      await setExternalIdentity(user.id, 'synced')

      // Realistic payload — every real emitter always names either userId
      // or childGroupId (see GroupsController's/RuleApplier's own
      // membership-event call sites).
      await insertOutboxEvent('membership', group.id, 'failed', 'membership_changed', {
        groupId: group.id,
        userId: user.id,
      })

      expect(await syncStates().resolveForUser(user.id)).toBe('failed')
    })

    // THE gap finding H3 (docs/superpowers/audit-integrity.md) exists to
    // close: the complementary cases above (a CURRENT member of a
    // dead-lettered group/membership event reads 'failed') all worked
    // pre-fix, which is what made this one so easy to miss — a member who
    // was REMOVED is, by definition, no longer in `listEffectiveUserMembers`
    // by the time this query runs, so deriving the affected set from
    // CURRENT membership alone means the removal's own dead letter surfaces
    // against nobody. This is the security-relevant direction: "looks
    // synced" here means "the removal was never actually applied to
    // Keycloak."
    it('surfaces a REMOVED member as failed via a dead-lettered membership REMOVAL event naming them in payload.userId', async () => {
      const group = await makeGroup('Removal Group')
      const user = await makeUser()
      await groupsRepo().addUser(group.id, user.id)

      await insertOutboxEvent('user', user.id, 'done', 'created')
      await setExternalIdentity(user.id, 'synced')

      // The admin's removal actually happened at the Postgres level —
      // group_user_members no longer names this user.
      await groupsRepo().removeUser(group.id, user.id)
      expect(await groupsRepo().listEffectiveUserMembers(group.id)).not.toContain(user.id)

      // ...but the removal's OWN outbox event dead-lettered before it ever
      // reached Keycloak. payload.userId is what the controller recorded
      // BEFORE deleting the edge (see GroupsController.removeMember) — the
      // only way to still name this user now that the edge is gone.
      await insertOutboxEvent('membership', group.id, 'failed', 'membership_changed', {
        groupId: group.id,
        userId: user.id,
      })

      // Pre-fix this read 'synced' — external_identities still says
      // synced (a dead-lettered membership/group event never regresses it,
      // by design — see SyncWorker.markUserSyncFailed), and walking CURRENT
      // effective membership never reaches a user who was just removed.
      expect(await syncStates().resolveForUser(user.id)).toBe('failed')
    })

    it('surfaces a REMOVED nested member via payload.childGroupId, walking that child\'s CURRENT membership', async () => {
      const parent = await makeGroup('Removal Parent')
      const child = await makeGroup('Removal Child')
      await groupsRepo().addChildGroup(parent.id, child.id)
      const user = await makeUser()
      await groupsRepo().addUser(child.id, user.id)

      await insertOutboxEvent('user', user.id, 'done', 'created')
      await setExternalIdentity(user.id, 'synced')

      // A child-group UNLINK from the parent dead-letters. The user is
      // still a member of the CHILD (only the parent<->child edge changed),
      // so this direction is reachable via CURRENT membership under the
      // child named in payload.childGroupId — see
      // SyncWorker.reconcileMembership's own doc comment for why the child
      // side, unlike a direct userId removal, is never itself deleted by
      // this edge change.
      await insertOutboxEvent('membership', parent.id, 'failed', 'membership_changed', {
        parentGroupId: parent.id,
        childGroupId: child.id,
      })

      expect(await syncStates().resolveForUser(user.id)).toBe('failed')
    })

    it('surfaces via a NESTED ancestor group (effective, not just direct, membership)', async () => {
      const parent = await makeGroup('Parent')
      const child = await makeGroup('Child')
      await groupsRepo().addChildGroup(parent.id, child.id)
      const user = await makeUser()
      await groupsRepo().addUser(child.id, user.id)

      await insertOutboxEvent('user', user.id, 'done', 'created')
      await setExternalIdentity(user.id, 'synced')

      // The PARENT's own event dead-letters — the user is only a DIRECT
      // member of the child, reaching the parent only via effective
      // (ancestor) membership.
      await insertOutboxEvent('group', parent.id, 'failed', 'updated')

      expect(await syncStates().resolveForUser(user.id)).toBe('failed')
    })

    it('does not affect an unrelated user in a different, healthy group', async () => {
      const troubledGroup = await makeGroup('Troubled')
      const healthyGroup = await makeGroup('Healthy')
      const troubledUser = await makeUser()
      const healthyUser = await makeUser()
      await groupsRepo().addUser(troubledGroup.id, troubledUser.id)
      await groupsRepo().addUser(healthyGroup.id, healthyUser.id)

      for (const user of [troubledUser, healthyUser]) {
        await insertOutboxEvent('user', user.id, 'done', 'created')
        await setExternalIdentity(user.id, 'synced')
      }
      await insertOutboxEvent('group', troubledGroup.id, 'failed', 'updated')

      const resolved = await syncStates().resolveForUsers([troubledUser.id, healthyUser.id])
      expect(resolved.get(troubledUser.id)).toBe('failed')
      expect(resolved.get(healthyUser.id)).toBe('synced')
    })

    it('reports pending (not failed) for a group event that is merely still pending, not dead-lettered', async () => {
      const group = await makeGroup('Pending Group')
      const user = await makeUser()
      await groupsRepo().addUser(group.id, user.id)

      await insertOutboxEvent('user', user.id, 'done', 'created')
      await setExternalIdentity(user.id, 'synced')
      await insertOutboxEvent('group', group.id, 'pending', 'updated')

      expect(await syncStates().resolveForUser(user.id)).toBe('pending')
    })
  })

  // =====================================================================
  // Batching.
  // =====================================================================
  describe('resolveForUsers', () => {
    it('batches multiple users in one call, matching per-user resolveForUser results', async () => {
      const synced = await makeUser()
      await insertOutboxEvent('user', synced.id, 'done', 'created')
      await setExternalIdentity(synced.id, 'synced')

      const pending = await makeUser()
      await insertOutboxEvent('user', pending.id, 'pending', 'created')

      const failed = await makeUser()
      await insertOutboxEvent('user', failed.id, 'failed', 'created')

      const resolved = await syncStates().resolveForUsers([synced.id, pending.id, failed.id])
      expect(resolved.get(synced.id)).toBe('synced')
      expect(resolved.get(pending.id)).toBe('pending')
      expect(resolved.get(failed.id)).toBe('failed')
    })

    it('returns an empty map for empty input, without querying anything', async () => {
      expect((await syncStates().resolveForUsers([])).size).toBe(0)
    })
  })
})

/**
 * HTTP-level proof that the controller wiring surfaces `syncState` — not
 * just that the repository computes it correctly in isolation. Mirrors
 * users.controller.spec.ts's minimal-module style. No Keycloak container:
 * these are GET routes, which never call KeycloakAdminClient.
 */
describe('GET /users and GET /users/:id expose syncState (Milestone 4, Task 4)', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let orgUnitId: string

  const UNRESTRICTED_ACTOR: AuthorizedRequest['actor'] = {
    userId: '00000000-0000-0000-0000-0000000000b1',
    username: 'sync-state-http-actor',
    orgUnitId: '00000000-0000-0000-0000-0000000000b1',
    assignments: [{ roleKey: 'super_admin', scopeOrgUnitId: null, scopePath: null }],
  }

  const stubPermissionGuard: CanActivate = {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<AuthorizedRequest>().actor = UNRESTRICTED_ACTOR
      return true
    },
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        UsersRepository,
        PermissionEngine,
        PrivilegeGuards,
        AuditWriter,
        OutboxWriter,
        { provide: KEYCLOAK_ADMIN_CONFIG, useValue: UNREACHABLE_KEYCLOAK_CONFIG },
        KeycloakAdminClient,
        GroupsRepository,
        SyncStateRepository,
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionGuard)
      .useValue(stubPermissionGuard)
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()

    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`Sync State HTTP Root ${Date.now()}`)).id
  })

  afterAll(async () => {
    await app?.close()
  })

  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `${fixtureSeq}`
  }

  async function makeUser(): Promise<User> {
    const tag = nextTag()
    const username = `sync-state-http-${tag}@example.com`.toLowerCase()
    return new UsersRepository(ctx.db).create({
      primaryEmail: username,
      username,
      firstName: 'Sync',
      lastName: `Http${tag}`,
      orgUnitId,
    })
  }

  async function insertOutboxEvent(
    aggregateType: string,
    aggregateId: string,
    status: string,
  ): Promise<void> {
    await ctx.pool.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, status)
       VALUES ($1, $2, 'updated', '{}'::jsonb, $3)`,
      [aggregateType, aggregateId, status],
    )
  }

  it('GET /users/:id includes syncState: failed for a user with a dead-lettered event — not silently healthy', async () => {
    const user = await makeUser()
    await insertOutboxEvent('user', user.id, 'failed')

    const res = await request(app.getHttpServer()).get(`/users/${user.id}`).expect(200)
    expect(res.body.syncState).toBe('failed')
  })

  it('GET /users/:id includes syncState: pending for a freshly created, not-yet-processed user', async () => {
    const user = await makeUser()
    await insertOutboxEvent('user', user.id, 'pending')

    const res = await request(app.getHttpServer()).get(`/users/${user.id}`).expect(200)
    expect(res.body.syncState).toBe('pending')
  })

  it('GET /users includes syncState on every item in the page', async () => {
    const healthy = await makeUser()
    await insertOutboxEvent('user', healthy.id, 'done')
    await ctx.pool.query(
      `INSERT INTO external_identities (user_id, system, external_id, sync_state, last_synced_at)
       VALUES ($1, 'keycloak', $2, 'synced', now())`,
      [healthy.id, `kc-${healthy.id}`],
    )

    const failing = await makeUser()
    await insertOutboxEvent('user', failing.id, 'failed')

    const res = await request(app.getHttpServer()).get('/users?limit=100').expect(200)
    const byId = new Map(res.body.items.map((item: { id: string; syncState: string }) => [item.id, item.syncState]))
    expect(byId.get(healthy.id)).toBe('synced')
    expect(byId.get(failing.id)).toBe('failed')
  })
})
