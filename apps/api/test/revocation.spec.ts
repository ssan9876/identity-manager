import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
import { OutboxRepository } from '../src/outbox/outbox.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { SyncStateRepository } from '../src/outbox/sync-state.repository'
import { SyncWorker } from '../src/outbox/sync.worker'
import { UsersController } from '../src/users/users.controller'
import { type User, UsersRepository } from '../src/users/users.repository'
import { startKeycloak, type TestKeycloak } from './support/keycloak'
import { withTestDatabase } from './support/pg'

const SYNC_CLIENT_ID = 'idm-sync-service'
const SYNC_CLIENT_SECRET = 'idm_sync_dev_secret_change_me'

// A definitely-closed local port: connecting to it fails FAST with
// ECONNREFUSED rather than hanging — same fixture sync.worker.spec.ts uses.
const UNREACHABLE_ISSUER = 'http://127.0.0.1:1/realms/unreachable'

// Assigned inside beforeAll, to a REAL seeded user — never a fabricated id.
// deactivate() writes an audit_log row carrying `actor_user_id`, and that
// column is a `restrict` foreign key into `users` (see db/schema/audit-log.ts):
// unlike the GET-only suites this stub pattern is borrowed from
// (users.controller.spec.ts, scope-narrowing.spec.ts), a WRITE route here
// actually needs the actor to exist for real.
let UNRESTRICTED_ACTOR: AuthorizedRequest['actor']

const stubPermissionGuard: CanActivate = {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest<AuthorizedRequest>().actor = UNRESTRICTED_ACTOR
    return true
  },
}

interface OutboxEventRow {
  event_type: string
  status: string
}

/**
 * MILESTONE 4, TASK 4: synchronous revocation on deactivate. Against REAL
 * Postgres AND REAL Keycloak Testcontainers (never mocks, per the milestone
 * plan's global constraints) — the core claim ("a live session cannot be
 * used after the response returns") is meaningless against a mock.
 *
 * ONE shared Postgres container and ONE shared Keycloak container serve
 * TWO separate Nest apps below: `app` (a genuinely reachable
 * KeycloakAdminClient, for the "live session actually dies" proof) and
 * `unreachableApp` (an unreachable one, for the "Keycloak down" proof) —
 * avoiding a second expensive container just to vary one config value,
 * the same sharing pattern sync.worker.spec.ts already uses for its own
 * `unreachableClient()`.
 */
describe('synchronous revocation on deactivate (Milestone 4, Task 4)', () => {
  const ctx = withTestDatabase()
  let keycloak: TestKeycloak
  let client: KeycloakAdminClient
  let app: INestApplication
  let unreachableApp: INestApplication
  let orgUnitId: string

  async function buildApp(keycloakConfig: {
    issuer: string
    clientId: string
    clientSecret: string
  }): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        UsersRepository,
        PermissionEngine,
        PrivilegeGuards,
        AuditWriter,
        OutboxWriter,
        GroupsRepository,
        SyncStateRepository,
        { provide: KEYCLOAK_ADMIN_CONFIG, useValue: keycloakConfig },
        KeycloakAdminClient,
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionGuard)
      .useValue(stubPermissionGuard)
      .compile()

    const built = moduleRef.createNestApplication()
    built.useGlobalFilters(new DomainExceptionFilter())
    await built.init()
    return built
  }

  beforeAll(async () => {
    keycloak = await startKeycloak()
    client = new KeycloakAdminClient({
      issuer: keycloak.issuer,
      clientId: SYNC_CLIENT_ID,
      clientSecret: SYNC_CLIENT_SECRET,
    })

    app = await buildApp({ issuer: keycloak.issuer, clientId: SYNC_CLIENT_ID, clientSecret: SYNC_CLIENT_SECRET })
    unreachableApp = await buildApp({
      issuer: UNREACHABLE_ISSUER,
      clientId: 'irrelevant',
      clientSecret: 'irrelevant',
    })

    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`Revocation Root ${Date.now()}`)).id

    // The audit actor for every mutation below — a REAL row in `users`
    // (see UNRESTRICTED_ACTOR's own comment). Its `assignments` are supplied
    // directly by the stub, never read from `role_assignments`, so this
    // user needs no actual role grant in the database.
    const actorUser = await new UsersRepository(ctx.db).create({
      primaryEmail: 'revocation-actor@example.com',
      username: 'revocation-test-actor',
      firstName: 'Revocation',
      lastName: 'Actor',
      orgUnitId,
    })
    UNRESTRICTED_ACTOR = {
      userId: actorUser.id,
      username: actorUser.username,
      orgUnitId,
      assignments: [{ roleKey: 'super_admin', scopeOrgUnitId: null, scopePath: null }],
    }
  })

  afterAll(async () => {
    await app?.close()
    await unreachableApp?.close()
    await keycloak?.stop()
  })

  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `${fixtureSeq}`
  }

  async function makeActiveUser(): Promise<User> {
    const tag = nextTag()
    const username = `revoke-user-${tag}@example.com`.toLowerCase()
    const created = await new UsersRepository(ctx.db).create({
      primaryEmail: username,
      username,
      firstName: 'Revoke',
      lastName: `Target${tag}`,
      orgUnitId,
    })
    return new UsersRepository(ctx.db).changeStatus(created.id, 'active')
  }

  async function outboxEventsFor(userId: string): Promise<OutboxEventRow[]> {
    const { rows } = await ctx.pool.query<OutboxEventRow>(
      "SELECT event_type, status FROM outbox_events WHERE aggregate_type = 'user' AND aggregate_id = $1 ORDER BY id ASC",
      [userId],
    )
    return rows
  }

  // =====================================================================
  // THE core proof: a live session genuinely dies before the response returns.
  // =====================================================================
  describe('a live session', () => {
    it('cannot be used after the deactivate response returns', async () => {
      const user = await makeActiveUser()
      const password = 'fixture-password-never-sent-by-our-system'

      // A REAL Keycloak counterpart, WITH a password — created via the
      // container's own bootstrap admin, never via the code under test
      // (KeycloakAdminClient.createUser can never set one — see its doc
      // comment). Same username as the local user: KeycloakAdminClient
      // locates the Keycloak-side counterpart BY username (decision 1).
      await keycloak.createFixtureUserWithPassword({
        username: user.username,
        email: user.username,
        password,
      })

      const { refreshToken } = await keycloak.tokenPairFor(user.username, password)

      // Sanity check: the session is genuinely live BEFORE we touch it —
      // otherwise a failing refresh below would prove nothing.
      const before = await keycloak.attemptRefresh(refreshToken)
      expect(before.ok).toBe(true)

      const res = await request(app.getHttpServer())
        .post(`/users/${user.id}/deactivate`)
        .expect(200)
      expect(res.body.status).toBe('deactivated')

      // The HTTP response has ALREADY come back at this point in the test —
      // proving the session died BEFORE the response, not merely
      // "eventually" once some background worker gets around to it (none is
      // running in this test at all).
      const after = await keycloak.attemptRefresh(refreshToken)
      expect(after.ok).toBe(false)

      const kcUser = await client.findUserByUsername(user.username)
      expect(kcUser?.enabled).toBe(false)
    })
  })

  // =====================================================================
  // Keycloak down: mutation still succeeds, event enqueued, response is honest.
  // =====================================================================
  describe('Keycloak unreachable during deactivate', () => {
    it('the mutation still succeeds, an event is enqueued, and the response shows the sync as pending — never synced', async () => {
      const user = await makeActiveUser()

      const res = await request(unreachableApp.getHttpServer())
        .post(`/users/${user.id}/deactivate`)
        .expect(200)

      expect(res.body.status).toBe('deactivated')
      expect(res.body.deactivatedAt).not.toBeNull()
      // THE contract: never imply access is already revoked/synced when the
      // synchronous attempt just failed.
      expect(res.body.syncState).toBe('pending')

      const events = await outboxEventsFor(user.id)
      expect(events).toHaveLength(1)
      expect(events[0]!.event_type).toBe('status_changed')
      // Still pending — the durability fallback, ready for the worker (or a
      // reconciliation run) to drain once Keycloak is reachable again.
      expect(events[0]!.status).toBe('pending')
    })

    it('logs the failure rather than throwing or losing it silently', async () => {
      const user = await makeActiveUser()
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

      try {
        await request(unreachableApp.getHttpServer())
          .post(`/users/${user.id}/deactivate`)
          .expect(200)

        expect(spy).toHaveBeenCalled()
        const loggedSomethingUseful = spy.mock.calls.some((call) =>
          call.some((arg) => String(arg).includes(user.username)),
        )
        expect(loggedSomethingUseful).toBe(true)
      } finally {
        spy.mockRestore()
      }
    })

    // Closes the loop: the outbox event this describe block's first test
    // left `pending` is exactly what makes the earlier "not yet synced"
    // response honest rather than a dead end — draining it with a WORKING
    // client (simulating "Keycloak comes back") must converge normally,
    // the same durability guarantee Task 3 already proved for every other
    // mutation.
    it('the queued event still converges normally once Keycloak recovers', async () => {
      const user = await makeActiveUser()
      await request(unreachableApp.getHttpServer()).post(`/users/${user.id}/deactivate`).expect(200)

      const worker = new SyncWorker(
        ctx.db,
        new OutboxRepository(),
        new UsersRepository(ctx.db),
        new GroupsRepository(ctx.db),
        client, // the REAL, reachable client
      )
      await worker.drain()

      const events = await outboxEventsFor(user.id)
      expect(events.at(-1)?.status).toBe('done')

      const kcUser = await client.findUserByUsername(user.username)
      expect(kcUser).not.toBeNull()
      expect(kcUser?.enabled).toBe(false)

      // Read through the (still-unreachable-configured) app — GET routes
      // never call Keycloak, so this proves syncState is read fresh from
      // Postgres, independent of which KeycloakAdminClient the app holds.
      const res = await request(unreachableApp.getHttpServer()).get(`/users/${user.id}`).expect(200)
      expect(res.body.syncState).toBe('synced')
    })
  })
})
