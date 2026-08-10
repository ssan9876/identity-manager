import { type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { eq } from 'drizzle-orm'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import { PrivilegeGuards } from '../src/authz/privilege.guards'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { BusinessRolesRepository } from '../src/business-roles/business-roles.repository'
import { hashDefinition, parseDefinition } from '../src/business-roles/draft'
import { RoleReconciler } from '../src/business-roles/role-reconciler'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import type { ConnectorTarget } from '../src/connectors/connector'
import { ConnectorRegistry } from '../src/connectors/connector-registry'
import { EchoConnector } from '../src/connectors/echo.connector'
import { businessRoleConditions } from '../src/db/schema/business-roles'
import { groups } from '../src/db/schema/groups'
import { orgUnits } from '../src/db/schema/org-units'
import { userTargetAccounts } from '../src/db/schema/user-target-accounts'
import { users } from '../src/db/schema/users'
import { GroupsRepository } from '../src/groups/groups.repository'
import { KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { OrganizationsRepository } from '../src/organizations/organizations.repository'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OutboxRepository } from '../src/outbox/outbox.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { SyncDetailRepository } from '../src/outbox/sync-detail.repository'
import { SyncStateRepository } from '../src/outbox/sync-state.repository'
import { SyncWorker } from '../src/outbox/sync.worker'
import {
  type PlannedPrincipal,
  TargetReconciliationJob,
  type TargetReconciliationReport,
} from '../src/outbox/target-reconciliation.job'
import { UsersController } from '../src/users/users.controller'
import { UsersRepository } from '../src/users/users.repository'
import { type TestDatabase, withTestDatabase } from './support/pg'

/**
 * A definitely-closed local port: every Keycloak call fails fast with
 * ECONNREFUSED rather than hanging, so no Keycloak container is needed here
 * — the same trick target-reconciliation.spec.ts and outbox-emission.spec.ts
 * already use. The offboarding tests below substitute the client entirely,
 * because they need to OBSERVE the synchronous revocation, not merely
 * survive it.
 */
const UNREACHABLE_KEYCLOAK = {
  issuer: 'http://127.0.0.1:1/realms/unreachable',
  clientId: 'irrelevant',
  clientSecret: 'irrelevant',
}

/**
 * MILESTONE 18 — the sync half of business roles: what an ENTITLEMENT
 * actually causes to happen in a target.
 *
 * Task 13 (fan-out), Task 14 (losing an entitlement disables) and Task 15
 * (target reconciliation respects the mode) are three views of one property:
 * a target in `entitled_only` mode provisions exactly the people some
 * business role granted it to, and actively DISABLES everyone else it has an
 * account for — never silently drops them, which is how orphaned accounts
 * are made.
 *
 * The safety property this whole file exists around: `all_users` is the
 * DEFAULT mode and reproduces the pre-business-roles behaviour exactly.
 * test/outbox-emission.spec.ts is the pre-existing regression net for that
 * claim and passes UNMODIFIED alongside this file.
 */

const ctx = withTestDatabase()

function writer(): OutboxWriter {
  return new OutboxWriter()
}

/**
 * A real `SyncWorker`, purely for `buildDesiredUser` — the one method that
 * decides whether a target should have this person enabled, and therefore
 * the place Task 14's disable either means something or does not. No
 * connector is resolved by that method, so the unreachable Keycloak client
 * below is never called.
 */
function syncWorker(): SyncWorker {
  return new SyncWorker(
    ctx.db,
    new OutboxRepository(),
    new UsersRepository(ctx.db),
    new GroupsRepository(ctx.db),
    new KeycloakAdminClient(UNREACHABLE_KEYCLOAK),
  )
}

/**
 * The `master` organization the organizations backfill migration creates.
 * `organization_id` is NOT NULL on org_units/users/groups and the fixtures
 * below seed through raw inserts rather than the repositories that resolve it
 * themselves, so they have to supply it — same note as business-roles.spec.ts's
 * own `masterOrgId`.
 */
async function masterOrgId(ctx: TestDatabase): Promise<string> {
  const master = await new OrganizationsRepository(ctx.db).findMaster()
  return master.id
}

/**
 * `withTestDatabase()` starts ONE container per test FILE and never truncates
 * between `it` blocks, so every fixture below carries a per-call `seq`
 * discriminator. Without one, a user seeded by an earlier test satisfies a
 * later test's role condition (or vice versa) and the counts silently stop
 * meaning what they say — the same trap business-roles.spec.ts's own fixtures
 * document at length.
 */
let seq = 0

async function insertUser(options: { jobTitle?: string; status?: 'active' | 'deactivated' } = {}): Promise<string> {
  seq += 1
  const n = seq
  const organizationId = await masterOrgId(ctx)
  const [unit] = await ctx.db
    .insert(orgUnits)
    .values({ name: `BR Sync Unit ${n}`, path: `br_sync_root_${n}`, organizationId })
    .returning()
  const [user] = await ctx.db
    .insert(users)
    .values({
      status: options.status ?? 'active',
      organizationId,
      primaryEmail: `br-sync-${n}@example.com`,
      username: `br-sync-${n}`,
      firstName: 'Sync',
      lastName: `User ${n}`,
      displayName: `Sync User ${n}`,
      jobTitle: options.jobTitle ?? null,
      orgUnitId: unit!.id,
    })
    .returning()
  return user!.id
}

async function insertGroup(): Promise<string> {
  seq += 1
  const organizationId = await masterOrgId(ctx)
  const [group] = await ctx.db.insert(groups).values({ name: `BR Sync Group ${seq}`, organizationId }).returning()
  return group!.id
}

type ProvisioningMode = 'all_users' | 'entitled_only'

/**
 * `connector_targets` is a GLOBAL, single-row-per-target catalog that the
 * migrations seed (`keycloak`, enabled, `all_users`) and that nothing
 * truncates between `it` blocks. So every test declares the WHOLE catalog it
 * wants rather than only the row it cares about: everything is disabled
 * first, then exactly the listed targets are enabled in the listed mode. A
 * test that only enabled its own target would still see whatever the
 * previous test left behind.
 */
async function configureTargets(spec: Partial<Record<ConnectorTarget, ProvisioningMode>>): Promise<void> {
  await ctx.pool.query('UPDATE connector_targets SET enabled = false')
  for (const [target, mode] of Object.entries(spec)) {
    await ctx.pool.query(
      `INSERT INTO connector_targets (target, enabled, provisioning_mode, config)
         VALUES ($1, true, $2, $3::jsonb)
       ON CONFLICT (organization_id, target) DO UPDATE
         SET enabled = true, provisioning_mode = EXCLUDED.provisioning_mode, config = EXCLUDED.config`,
      [target, mode, JSON.stringify(target === 'echo' ? { credentialSecretName: 'CONNECTOR_BR_SYNC_ECHO_SECRET' } : {})],
    )
  }
}

/** Every target an outbox row was written for, for this aggregate, in insertion order. */
async function outboxTargetsForAggregate(aggregateId: string): Promise<string[]> {
  const { rows } = await ctx.pool.query<{ target: string }>(
    'SELECT target FROM outbox_events WHERE aggregate_id = $1 ORDER BY id',
    [aggregateId],
  )
  return rows.map((row) => row.target)
}

const outboxTargetsFor = outboxTargetsForAggregate

async function outboxEventsFor(aggregateId: string): Promise<{ eventType: string; target: string }[]> {
  const { rows } = await ctx.pool.query<{ event_type: string; target: string }>(
    'SELECT event_type, target FROM outbox_events WHERE aggregate_id = $1 ORDER BY id',
    [aggregateId],
  )
  return rows.map((row) => ({ eventType: row.event_type, target: row.target }))
}

// ---------------------------------------------------------------------------
// Task 13 — fan out by entitlement, per target, opt-in
// ---------------------------------------------------------------------------

describe('entitlement-driven fan-out (Milestone 18, Task 13)', () => {
  const userEvent = (userId: string) =>
    ({ aggregateType: 'user', aggregateId: userId, eventType: 'updated', payload: {} }) as const

  it('an all_users target still receives a row for every user — behaviour is unchanged by default', async () => {
    const userId = await insertUser()
    await configureTargets({ keycloak: 'all_users' })

    await ctx.db.transaction((tx) => writer().record(tx, userEvent(userId)))

    expect(await outboxTargetsFor(userId)).toEqual(['keycloak'])
  })

  it('an entitled_only target receives NOTHING for a user with no account entitlement', async () => {
    const userId = await insertUser()
    await configureTargets({ keycloak: 'entitled_only' })

    await ctx.db.transaction((tx) => writer().record(tx, userEvent(userId)))

    expect(await outboxTargetsFor(userId)).toEqual([])
  })

  it('an entitled_only target receives a row once the user holds the entitlement', async () => {
    const userId = await insertUser()
    await configureTargets({ keycloak: 'entitled_only' })
    await ctx.db.insert(userTargetAccounts).values({ userId, target: 'keycloak', grantSource: 'business_role' })

    await ctx.db.transaction((tx) => writer().record(tx, userEvent(userId)))

    expect(await outboxTargetsFor(userId)).toEqual(['keycloak'])
  })

  it('mixes modes correctly across targets in one write', async () => {
    const userId = await insertUser()
    await configureTargets({ keycloak: 'all_users', echo: 'entitled_only' })

    await ctx.db.transaction((tx) => writer().record(tx, userEvent(userId)))

    // `echo` is enabled and would have received a row before this task; it is
    // dropped purely because this user holds no entitlement for it, while the
    // `all_users` target beside it is untouched by the filter.
    expect(await outboxTargetsFor(userId)).toEqual(['keycloak'])
  })

  it('an entitlement for one target does not leak to another entitled_only target', async () => {
    const userId = await insertUser()
    await configureTargets({ keycloak: 'entitled_only', echo: 'entitled_only' })
    await ctx.db.insert(userTargetAccounts).values({ userId, target: 'echo', grantSource: 'business_role' })

    await ctx.db.transaction((tx) => writer().record(tx, userEvent(userId)))

    expect(await outboxTargetsFor(userId)).toEqual(['echo'])
  })

  it('a non-user aggregate is unaffected by entitlement state', async () => {
    // Group events have no user to look up; an entitled_only target must not
    // silently stop receiving group syncs just because a group can never hold
    // a `user_target_accounts` row.
    const groupId = await insertGroup()
    await configureTargets({ keycloak: 'entitled_only' })

    await ctx.db.transaction((tx) =>
      writer().record(tx, {
        aggregateType: 'group',
        aggregateId: groupId,
        eventType: 'updated',
        payload: {},
      }),
    )

    expect(await outboxTargetsForAggregate(groupId)).toEqual(['keycloak'])
  })
})

// ---------------------------------------------------------------------------
// Task 14 — losing an entitlement disables the account
// ---------------------------------------------------------------------------

function roleRepo(): BusinessRolesRepository {
  return new BusinessRolesRepository(ctx.db)
}

function reconciler(): RoleReconciler {
  return new RoleReconciler(roleRepo(), new AuditWriter(), new OutboxWriter())
}

/**
 * A published, enabled role whose ONLY grant is a target account on
 * `target`, keyed on a `jobTitle` unique to this call.
 *
 * The unique condition value is not decoration: `withTestDatabase()` never
 * truncates between `it` blocks, so a role left enabled by an earlier test is
 * still enabled and still evaluated for every later test's user. A shared
 * literal would let one test's role grant another test's user an account —
 * the exact mistake that once produced a bogus "5 of 19 failing" run in this
 * codebase. `options.jobTitle === 'Account Executive'` is the caller-facing
 * sentinel for "seed a user this role matches", exactly as
 * business-roles.spec.ts's own fixtures use it.
 */
async function seedRoleGrantingTargetAccount(
  target: ConnectorTarget,
  options: { jobTitle: string },
): Promise<{ userId: string; roleId: string; matchingJobTitle: string }> {
  seq += 1
  const n = seq
  const matchingJobTitle = `Account Executive #${n}`
  const userId = await insertUser({
    jobTitle: options.jobTitle === 'Account Executive' ? matchingJobTitle : options.jobTitle,
  })

  const role = await roleRepo().create({ name: `BR Sync Role ${n}`, description: null })
  const definition = {
    conditions: [{ field: 'jobTitle', operator: 'equals', value: matchingJobTitle }],
    grants: [{ kind: 'target_account', groupId: null, target }],
  }
  await roleRepo().saveDraft(role.id, definition)
  await roleRepo().recordSimulation(role.id, hashDefinition(parseDefinition(definition)), 0)
  await roleRepo().publish(role.id)
  await roleRepo().setEnabled(role.id, true)

  return { userId, roleId: role.id, matchingJobTitle }
}

/**
 * An enabled, published role carrying a condition on a field the running
 * binary does not know — the shape a migration newer than this build leaves
 * behind. Inserted straight into `business_role_conditions` AFTER publish,
 * because `parseDefinition` would (correctly) reject it on the way in.
 *
 * A LANDMINE for every later test in this file: ONE unevaluable enabled role
 * makes `evaluateRoles` refuse for EVERY user, not just one. Any test using
 * it must disable the role before it returns — which is also, in the
 * offboarding tests below, precisely the point being proven: deactivation
 * must not care.
 */
async function seedUnevaluableRole(): Promise<{ roleId: string }> {
  seq += 1
  const n = seq
  const role = await roleRepo().create({ name: `BR Sync Unevaluable Role ${n}`, description: null })
  const definition = {
    conditions: [{ field: 'jobTitle', operator: 'equals', value: `Nobody At All #${n}` }],
    grants: [],
  }
  await roleRepo().saveDraft(role.id, definition)
  await roleRepo().recordSimulation(role.id, hashDefinition(parseDefinition(definition)), 0)
  await roleRepo().publish(role.id)
  await roleRepo().setEnabled(role.id, true)

  await ctx.db.insert(businessRoleConditions).values({
    businessRoleId: role.id,
    field: 'managerId',
    operator: 'equals',
    value: 'anyone',
  })

  return { roleId: role.id }
}

describe('entitlement loss disables (Milestone 18, Task 14)', () => {
  /**
   * Grant, then break the condition, then reconcile again — the two-pass
   * shape every test in this block needs. Returns the user whose entitlement
   * has just been revoked.
   */
  async function grantThenRevoke(target: ConnectorTarget): Promise<string> {
    const { userId, roleId } = await seedRoleGrantingTargetAccount(target, { jobTitle: 'Account Executive' })
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))
    expect(await ctx.db.select().from(userTargetAccounts).where(eq(userTargetAccounts.userId, userId))).toHaveLength(1)

    await ctx.db.update(users).set({ jobTitle: `Manager #${seq}` }).where(eq(users.id, userId))
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    // The role stays enabled but can no longer match anybody else's unique
    // jobTitle, so it is not a landmine for later tests. `roleId` is returned
    // only for symmetry with the fixture; nothing here needs to disable it.
    void roleId
    return userId
  }

  it('revoking a target-account entitlement enqueues a disable, not silence', async () => {
    // An account silently dropped from management stays ENABLED in the
    // target forever — precisely the orphaned account the governance
    // sub-project would later have to go and find. Commit 92055ee
    // established this for the mail connector's aliases; this generalises it.
    await configureTargets({ keycloak: 'entitled_only' })
    const userId = await grantThenRevoke('keycloak')

    const events = await outboxEventsFor(userId)
    expect(events.map((event) => event.eventType)).toContain('status_changed')
    expect(events.at(-1)).toMatchObject({ target: 'keycloak' })
    // And the entitlement really is gone — the disable is not a duplicate of
    // some grant-time event.
    expect(await ctx.db.select().from(userTargetAccounts).where(eq(userTargetAccounts.userId, userId))).toEqual([])
  })

  it('the disable is emitted even though the user no longer passes the fan-out filter', async () => {
    // The ordering trap: by the time the disable is written, the
    // `user_target_accounts` row is already gone, so a naive
    // `OutboxWriter.record()` would emit nothing at all for that target.
    await configureTargets({ keycloak: 'entitled_only' })
    const userId = await grantThenRevoke('keycloak')

    expect(await outboxTargetsFor(userId)).toContain('keycloak')

    // The control that makes the assertion above mean something: the generic
    // writer, asked about this same user a moment later, correctly emits
    // NOTHING for the same target. The disable exists only because the
    // reconciler wrote it directly.
    const before = (await outboxTargetsFor(userId)).length
    await ctx.db.transaction((tx) =>
      writer().record(tx, { aggregateType: 'user', aggregateId: userId, eventType: 'updated', payload: {} }),
    )
    expect(await outboxTargetsFor(userId)).toHaveLength(before)
  })

  it('emits one disable per revoked target, and none when nothing was revoked', async () => {
    await configureTargets({ keycloak: 'entitled_only' })
    const { userId } = await seedRoleGrantingTargetAccount('keycloak', { jobTitle: 'Account Executive' })

    // Pass 1 grants; pass 2 changes nothing at all.
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))
    expect(await outboxEventsFor(userId)).toEqual([])

    await ctx.db.update(users).set({ jobTitle: `Manager #${seq}` }).where(eq(users.id, userId))
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))
    await ctx.db.transaction((tx) => reconciler().reconcileUser(tx, userId, null, new Date()))

    // Exactly one — the second revoke pass has nothing left to revoke, so it
    // must not re-emit. Disables are idempotent in effect, but a reconciler
    // that emitted one on every pass would flood the outbox forever.
    expect(await outboxEventsFor(userId)).toEqual([{ eventType: 'status_changed', target: 'keycloak' }])
  })

  it('the disable actually DISABLES: desired state for the revoked user is enabled=false', async () => {
    // Without this, Task 14 would be theatre — the event would land in
    // SyncWorker, which would recompute `enabled` from status alone and
    // cheerfully re-assert `enabled: true` for a still-active user, leaving
    // exactly the live account the disable existed to close.
    await configureTargets({ keycloak: 'entitled_only' })
    const userId = await grantThenRevoke('keycloak')

    const user = await new UsersRepository(ctx.db).findById(userId)
    expect(user?.status).toBe('active')

    const desired = await ctx.db.transaction((tx) => syncWorker().buildDesiredUser(tx, user!, 'keycloak'))
    expect(desired.enabled).toBe(false)
  })

  it('an all_users target keeps an active user enabled regardless of any entitlement', async () => {
    // The default mode never consults entitlement — this is the same
    // property outbox-emission.spec.ts guards one layer up, asserted here
    // against desired state itself.
    await configureTargets({ keycloak: 'all_users' })
    const userId = await grantThenRevoke('keycloak')

    const user = await new UsersRepository(ctx.db).findById(userId)
    const desired = await ctx.db.transaction((tx) => syncWorker().buildDesiredUser(tx, user!, 'keycloak'))
    expect(desired.enabled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Task 14, step 4 — offboarding is independent of role evaluation
// ---------------------------------------------------------------------------

/**
 * SETTLED DECISION 8, asserted rather than assumed. Offboarding must never
 * acquire a dependency on the role engine: a directory whose rules this
 * binary cannot understand must still be able to get somebody out.
 *
 * `UsersController.deactivate` is driven through the real HTTP stack with the
 * real `PermissionGuard`/`PermissionEngine`; only `JwtGuard` and
 * `KeycloakAdminClient` are substituted (the latter so the synchronous
 * revocation attempt is observable, and so no Keycloak container is needed).
 */
describe('offboarding is independent of role evaluation (settled decision 8)', () => {
  let app: INestApplication
  let currentUsername = ''
  let adminUserId = ''
  const keycloakCalls: { method: 'setEnabled' | 'revokeSessions'; username: string; enabled?: boolean }[] = []

  const keycloakSpy = {
    async setEnabled(username: string, enabled: boolean): Promise<void> {
      keycloakCalls.push({ method: 'setEnabled', username, enabled })
    },
    async revokeSessions(username: string): Promise<void> {
      keycloakCalls.push({ method: 'revokeSessions', username })
    },
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        BusinessRolesRepository,
        RoleReconciler,
        UsersRepository,
        GroupsRepository,
        OrgUnitsRepository,
        RoleAssignmentsRepository,
        PermissionEngine,
        PermissionGuard,
        PrivilegeGuards,
        AuditWriter,
        OutboxWriter,
        Reflector,
        { provide: KeycloakAdminClient, useValue: keycloakSpy },
        SyncStateRepository,
        SyncDetailRepository,
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({
        canActivate(context: ExecutionContext): boolean {
          context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
            subject: 'br-sync-test',
            username: currentUsername,
            email: null,
          }
          return true
        },
      })
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()

    // A global super_admin to act as — `user:deactivate` needs a real grant;
    // the permission stack is NOT stubbed here.
    adminUserId = await insertUser()
    const admin = await new UsersRepository(ctx.db).findById(adminUserId)
    currentUsername = admin!.username
    await new RoleAssignmentsRepository(ctx.db).assign({
      userId: adminUserId,
      roleKey: 'super_admin',
      scopeOrgUnitId: null,
    })
  })

  afterAll(async () => {
    await app?.close()
  })

  async function deactivateUserViaController(userId: string): Promise<void> {
    await request(app.getHttpServer()).post(`/users/${userId}/deactivate`).expect(200)
  }

  it('deactivation disables every target even when NO role grants an account entitlement', async () => {
    await configureTargets({ keycloak: 'all_users' })
    const userId = await insertUser({ jobTitle: 'Account Executive' })
    // Deliberately no business role, and therefore no user_target_accounts row.

    await deactivateUserViaController(userId)

    const events = await outboxEventsFor(userId)
    expect(events).toContainEqual({ eventType: 'status_changed', target: 'keycloak' })
  })

  it('deactivation disables even when an enabled role is UNEVALUABLE', async () => {
    // The role engine refuses to compute a desired set here. Offboarding must
    // proceed anyway: rule correctness is the second belt, never the braces.
    await configureTargets({ keycloak: 'all_users' })
    const userId = await insertUser({ jobTitle: 'Account Executive' })
    const { roleId } = await seedUnevaluableRole()

    try {
      // Proof the landmine is live: an ordinary user WRITE refuses while this
      // role is enabled (Task 9 wiring), so the deactivate below is genuinely
      // running against an engine that cannot answer.
      await request(app.getHttpServer()).patch(`/users/${userId}`).send({ jobTitle: 'Manager' }).expect(409)

      await deactivateUserViaController(userId)

      const events = await outboxEventsFor(userId)
      expect(events).toContainEqual({ eventType: 'status_changed', target: 'keycloak' })
      const [row] = await ctx.db.select().from(users).where(eq(users.id, userId))
      expect(row!.status).toBe('deactivated')
    } finally {
      // Defuse before yielding to whatever runs next in this FILE — one
      // unevaluable enabled role makes every later reconcile refuse, for
      // every user.
      await roleRepo().setEnabled(roleId, false)
    }
  })

  it('revoke-access still runs synchronously on deactivation', async () => {
    // Guards the Friday-afternoon scene in PRODUCT.md: sessions die before
    // the request returns, not whenever a sweep next runs.
    await configureTargets({ keycloak: 'all_users' })
    const userId = await insertUser()
    const user = await new UsersRepository(ctx.db).findById(userId)
    keycloakCalls.length = 0

    await deactivateUserViaController(userId)

    expect(keycloakCalls).toEqual([
      { method: 'setEnabled', username: user!.username, enabled: false },
      { method: 'revokeSessions', username: user!.username },
    ])
  })

  it('deactivation still revokes synchronously with an UNEVALUABLE role enabled', async () => {
    // The two halves of decision 8 together: the engine cannot answer, and
    // the session still dies on the request path.
    await configureTargets({ keycloak: 'all_users' })
    const userId = await insertUser()
    const user = await new UsersRepository(ctx.db).findById(userId)
    const { roleId } = await seedUnevaluableRole()
    keycloakCalls.length = 0

    try {
      await deactivateUserViaController(userId)
      expect(keycloakCalls.map((call) => call.method)).toEqual(['setEnabled', 'revokeSessions'])
      expect(keycloakCalls[0]).toMatchObject({ username: user!.username, enabled: false })
    } finally {
      await roleRepo().setEnabled(roleId, false)
    }
  })
})

// ---------------------------------------------------------------------------
// Task 15 — target reconciliation respects the mode
// ---------------------------------------------------------------------------

/**
 * MILESTONE 18, TASK 15 — `TargetReconciliationJob` against the REAL
 * `EchoConnector` (never a mock: it is a genuine `DirectoryConnector`, the
 * same one target-reconciliation.spec.ts drives) and a real Postgres.
 *
 * ONE `EchoConnector` for the whole block, deliberately — it stands in for
 * "the external directory", whose state persists across runs. That is what
 * makes "this user already has an account there" a real precondition rather
 * than a mocked one: `plan()` diffs against what `apply()` genuinely
 * recorded (see echo.connector.ts's own `lastAppliedByUsername` doc
 * comment).
 *
 * `reconcile()` walks EVERY user in the database, and this file's earlier
 * tests leave plenty behind. So every assertion here is scoped to the user
 * this test seeded (`planFor`), and the blast-radius config is set
 * deliberately extreme per test — lenient enough to structurally never trip,
 * or strict enough to trip on anything — so accumulated population can never
 * flip a verdict either way.
 */
describe('target reconciliation and provisioning mode (Milestone 18, Task 15)', () => {
  const ECHO_SECRET_NAME = 'CONNECTOR_BR_SYNC_ECHO_SECRET'
  let echo: EchoConnector
  let job: TargetReconciliationJob

  beforeAll(() => {
    process.env[ECHO_SECRET_NAME] = 'br-sync-echo-secret'
    const keycloak = new KeycloakAdminClient(UNREACHABLE_KEYCLOAK)
    echo = new EchoConnector()
    const registry = new ConnectorRegistry(keycloak, echo)
    const worker = new SyncWorker(
      ctx.db,
      new OutboxRepository(),
      new UsersRepository(ctx.db),
      new GroupsRepository(ctx.db),
      keycloak,
      undefined,
      registry,
    )
    job = new TargetReconciliationJob(new UsersRepository(ctx.db), registry, worker, new AuditWriter(), ctx.db)
  })

  afterAll(() => {
    delete process.env[ECHO_SECRET_NAME]
  })

  /**
   * The echo `connector_targets` row, with EXPLICIT blast-radius config and
   * an explicit provisioning mode — nothing here relies on schema defaults,
   * since this file's population accumulates across tests. `credentialSecretName`
   * is required by `EchoConnector` exactly as a real vendor connector requires
   * a bind password.
   */
  async function configureEcho(
    mode: ProvisioningMode,
    blastRadius: { thresholdPercent: number; floor: number } = { thresholdPercent: 100, floor: 1_000_000 },
  ): Promise<void> {
    await ctx.pool.query(
      `INSERT INTO connector_targets (target, enabled, provisioning_mode, config, blast_radius_threshold, blast_radius_floor)
         VALUES ('echo', true, $1, $2::jsonb, $3, $4)
       ON CONFLICT (organization_id, target) DO UPDATE
         SET enabled = true, provisioning_mode = $1, config = $2::jsonb,
             blast_radius_threshold = $3, blast_radius_floor = $4`,
      [
        mode,
        JSON.stringify({ credentialSecretName: ECHO_SECRET_NAME }),
        blastRadius.thresholdPercent,
        blastRadius.floor,
      ],
    )
  }

  function planFor(report: TargetReconciliationReport, userId: string): PlannedPrincipal | undefined {
    return report.toMutate.find((planned) => planned.userId === userId)
  }

  function applyCallsFor(username: string): number {
    return echo.calls.filter((call) => call.method === 'apply' && call.desired?.username === username).length
  }

  async function usernameOf(userId: string): Promise<string> {
    const user = await new UsersRepository(ctx.db).findById(userId)
    return user!.username
  }

  it('on an all_users target the job behaves exactly as today', async () => {
    await configureEcho('all_users')
    const userId = await insertUser()

    const result = await job.reconcile('echo', { dryRun: true })

    // A user the target has never seen is planned for a create — unchanged
    // from before this task, and the whole point of `all_users` being the
    // default.
    expect(planFor(result, userId)?.operations.map((operation) => operation.kind)).toEqual(['create'])
  })

  it('on an entitled_only target, an unentitled user WITH an account is planned for DISABLE, not skipped', async () => {
    // Skipping would leave a live account nobody manages. "Should this
    // account exist at all" is part of the desired state the job corrects
    // toward, so an unentitled user's desired state is disabled.
    await configureEcho('all_users')
    const userId = await insertUser()
    const username = await usernameOf(userId)

    // Give them a real, enabled account in the target first — this is the
    // "populated target an operator is about to migrate" case.
    await job.reconcile('echo')
    expect(applyCallsFor(username)).toBe(1)

    await configureEcho('entitled_only')
    const result = await job.reconcile('echo', { dryRun: true })

    expect(planFor(result, userId)?.operations.map((operation) => operation.kind)).toContain('disable')
  })

  it('an unentitled user the target has NEVER provisioned is planned for nothing — never a create', async () => {
    // The other half of "not skipped": there is genuinely nothing to correct
    // for someone who has no account, and bringing one into existence — even
    // a disabled one — is the one thing an unentitled user's desired state
    // definitively does not include. They are still WALKED (they count
    // toward populationSize), just found to be already converged.
    await configureEcho('entitled_only')
    const userId = await insertUser()

    const result = await job.reconcile('echo', { dryRun: true })

    expect(planFor(result, userId)).toBeUndefined()
    expect(result.populationSize).toBeGreaterThan(0)
  })

  it('an entitled user on an entitled_only target is planned normally', async () => {
    await configureEcho('entitled_only')
    const userId = await insertUser()
    await ctx.db.insert(userTargetAccounts).values({ userId, target: 'echo', grantSource: 'business_role' })

    const result = await job.reconcile('echo', { dryRun: true })

    const kinds = planFor(result, userId)?.operations.map((operation) => operation.kind)
    expect(kinds).toEqual(['create'])
    expect(kinds).not.toContain('disable')
  })

  it('the entitled user is enabled and the unentitled one disabled in the SAME run', async () => {
    // Plan and apply agree because both go through the one
    // `buildDesiredUser` — the property that stops "what the dry run showed"
    // and "what the sync asserted" from drifting apart.
    await configureEcho('entitled_only')
    const entitledId = await insertUser()
    const unentitledId = await insertUser()
    await ctx.db.insert(userTargetAccounts).values({ userId: entitledId, target: 'echo', grantSource: 'business_role' })

    await job.reconcile('echo')

    const entitledName = await usernameOf(entitledId)
    const entitledApply = echo.calls.find(
      (call) => call.method === 'apply' && call.desired?.username === entitledName,
    )
    expect(entitledApply?.desired?.enabled).toBe(true)
    // The unentitled user has no account here at all, so nothing was applied
    // for them — no account was created just to disable it.
    expect(applyCallsFor(await usernameOf(unentitledId))).toBe(0)
  })

  it('the blast-radius guard HALTS a mode flip made before any entitlement was granted', async () => {
    // This is exactly why the guard exists. Flipping a populated target to
    // entitled_only before any role grants accounts makes the whole
    // directory's desired state "disabled"; the run must halt and report,
    // never execute.
    await configureEcho('all_users')
    const userIds = [await insertUser(), await insertUser(), await insertUser()]
    await job.reconcile('echo')
    const usernames = await Promise.all(userIds.map(usernameOf))
    const appliesBefore = usernames.map(applyCallsFor)

    // Strict enough that any handful of genuine changes trips it.
    await configureEcho('entitled_only', { thresholdPercent: 1, floor: 0 })
    const result = await job.reconcile('echo')

    expect(result.halted).toBe(true)
    expect(result.overridden).toBe(false)
    expect(result.blastRadius.tripped).toBe(true)
    expect(result.appliedCount).toBe(0)
    // The plan is still reported, so an operator can see exactly what would
    // have happened...
    expect(result.toMutate.length).toBeGreaterThan(0)
    for (const userId of userIds) {
      expect(planFor(result, userId)?.operations.map((operation) => operation.kind)).toContain('disable')
    }
    // ...and ZERO operations reached the target.
    expect(usernames.map(applyCallsFor)).toEqual(appliesBefore)

    // Leave the catalog lenient again for anything that runs after this.
    await configureEcho('all_users')
  })
})
