import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import type { Pool } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { JwtGuard } from '../src/auth/jwt.guard'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import { PrivilegeGuards } from '../src/authz/privilege.guards'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { createDbClient } from '../src/db/client'
import { GroupsRepository } from '../src/groups/groups.repository'
import { KEYCLOAK_ADMIN_CONFIG, KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { OrgUnitsRepository, type OrgUnit } from '../src/org-units/org-units.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { SyncDetailRepository } from '../src/outbox/sync-detail.repository'
import { SyncStateRepository } from '../src/outbox/sync-state.repository'
import { UsersController } from '../src/users/users.controller'
import { UsersRepository, type User } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

// Same reasoning as users.write.spec.ts: point synchronous Keycloak
// revocation at an unreachable port so it fails fast (ECONNREFUSED, caught
// and logged — see UsersController.revokeKeycloakAccess) rather than
// depending on a real Keycloak. Irrelevant to this file's own concern
// (pool exhaustion on PATCH, not DELETE/deactivate's Keycloak call).
const UNREACHABLE_KEYCLOAK_CONFIG = {
  issuer: 'http://127.0.0.1:1/realms/unreachable',
  clientId: 'irrelevant',
  clientSecret: 'irrelevant',
}

/** Same technique as users.write.spec.ts's stubJwtGuard — see its comment. */
function stubJwtGuard(getUsername: () => string): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
        subject: 'kc-pool-test',
        username: getUsername(),
        email: null,
      }
      return true
    },
  }
}

/**
 * Tracks how many physical connections `pool` has checked out AT ONCE, at
 * any given moment. `pg-pool` emits `'acquire'`/`'release'` on every
 * checkout/return of a client (see the installed pg-pool's
 * `_acquireClient`/`_release`) — and EVERY logical query goes through
 * exactly one of these pairs, whether it is a single `pool.query()` call
 * (connect -> query -> release, all inside `Pool.prototype.query`) or a
 * whole `db.transaction(...)` (Drizzle's node-postgres `NodePgSession.
 * transaction`: one `pool.connect()` up front, held for the callback's
 * entire duration, released once in a `finally`  — confirmed directly
 * against the installed drizzle-orm's node-postgres/session.js). Listening
 * to these two events is therefore an exact, deterministic measure of
 * concurrent checkouts — no polling, no race with `pg_stat_activity`.
 */
function instrumentPoolCheckouts(pool: Pool) {
  let current = 0
  let peak = 0
  pool.on('acquire', () => {
    current += 1
    peak = Math.max(peak, current)
  })
  pool.on('release', () => {
    current -= 1
  })
  return {
    /**
     * Runs `fn`, returning its result alongside the PEAK number of
     * connections concurrently checked out while it ran, measured as a
     * delta against whatever baseline was already outstanding the instant
     * `fn` started — robust against any pre-existing checkout rather than
     * assuming the pool is perfectly quiescent beforehand.
     */
    async peakDuring<T>(fn: () => Promise<T>): Promise<{ result: T; peakConcurrent: number }> {
      const baseline = current
      peak = current
      const result = await fn()
      return { result, peakConcurrent: peak - baseline }
    },
  }
}

/**
 * Regression coverage for docs/archive/audits/audit-integrity.md finding C1
 * (CRITICAL): 11+ concurrent `PATCH /users/:id` used to permanently deadlock
 * the API process. `UsersController.update` opens `db.transaction(...)`
 * (one pooled connection for the whole callback) and then, inside it, called
 * `PermissionEngine.assertCanIn`/`PrivilegeGuards.assertCanModifyPrincipal`
 * on the POOL rather than the open `tx` — a second connection per in-flight
 * write. Ten such requests exhausted a default `max: 10` pool entirely; an
 * eleventh's second connection (and `connectionTimeoutMillis` being unset)
 * meant it, and every later request, waited forever — see that file for the
 * full measured reproduction (`pool: total=10 idle=0 waiting=11`, hung with
 * no response after 8s).
 *
 * Deliberately builds its OWN `DB_CLIENT` via the REAL `createDbClient`
 * (db/client.ts) — never `test/support/pg.ts`'s own ad-hoc `ctx.pool`, which
 * carries none of `createDbClient`'s configured `max`/
 * `connectionTimeoutMillis` — bound to the SAME throwaway Postgres
 * (`ctx.connectionUri`) so the app under test experiences the exact pool
 * shape a real deployment does. `connectionTimeoutMillis` is set shorter
 * than production's default (3s vs 5s) purely so the COUNTERFACTUAL run
 * (Part 1 reverted — see docs/archive/audits/fix-wave-a-report.md) fails
 * within this file's own per-test timeout instead of needing a longer one;
 * it is still a genuinely finite value, exercising the same code path.
 */
describe('pool exhaustion (finding C1, docs/archive/audits/audit-integrity.md)', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let appPool: Pool
  let appDb: ReturnType<typeof createDbClient>['db']
  let checkouts: ReturnType<typeof instrumentPoolCheckouts>
  let currentUsername = ''

  beforeAll(async () => {
    const appClient = createDbClient(ctx.connectionUri, { connectionTimeoutMillis: 3_000 })
    appPool = appClient.pool
    // This pool outlives some teardown orderings, and a pg.Pool with no
    // 'error' listener turns the container's shutdown (57P01) into an
    // UNHANDLED error that fails the whole run with every test green — see
    // test/support/pg.ts's `swallowShutdownErrors`.
    appPool.on('error', (error: NodeJS.ErrnoException & { code?: string }) => {
      if (error?.code === '57P01' || error?.code === 'ECONNRESET' || error?.code === 'EPIPE') return
      throw error
    })
    appDb = appClient.db
    checkouts = instrumentPoolCheckouts(appPool)

    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => appClient.db },
        UsersRepository,
        PermissionEngine,
        PermissionGuard,
        PrivilegeGuards,
        AuditWriter,
        OutboxWriter,
        Reflector,
        { provide: KEYCLOAK_ADMIN_CONFIG, useValue: UNREACHABLE_KEYCLOAK_CONFIG },
        KeycloakAdminClient,
        GroupsRepository,
        SyncStateRepository,
      SyncDetailRepository,
        SyncDetailRepository,
      ],
    })
      .overrideGuard(JwtGuard)
      .useValue(stubJwtGuard(() => currentUsername))
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
    await appPool?.end()
  })

  // Fixture setup below deliberately uses `ctx.db`/`ctx.pool` (the test
  // harness's own separate pool), never `appPool` — so creating org
  // units/users never shows up in `checkouts`, which measures only the app
  // pool the HTTP requests under test actually run against.
  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `px${fixtureSeq}`
  }

  const orgUnitsRepo = () => new OrgUnitsRepository(ctx.db)
  const usersRepo = () => new UsersRepository(ctx.db)
  const rolesRepo = () => new RoleAssignmentsRepository(ctx.db)

  async function makeOrgUnit(): Promise<OrgUnit> {
    return orgUnitsRepo().createRoot(`Pool Test Org ${nextTag()}`)
  }

  async function makeActiveUser(role: string, orgUnitId: string): Promise<User> {
    const tag = nextTag()
    const created = await usersRepo().create({
      primaryEmail: `${role}-${tag}@example.com`,
      username: `${role}-${tag}`,
      firstName: 'Test',
      lastName: 'User',
      orgUnitId,
    })
    return usersRepo().changeStatus(created.id, 'active')
  }

  it(
    '20 concurrent PATCH /users/:id all complete against a pool of 10 (none hang, none 5xx)',
    async () => {
      const org = await makeOrgUnit()
      const actor = await makeActiveUser('admin', org.id)
      await rolesRepo().assign({ userId: actor.id, roleKey: 'user_admin', scopeOrgUnitId: org.id })
      currentUsername = actor.username

      const targets = await Promise.all(
        Array.from({ length: 20 }, () => makeActiveUser('target', org.id)),
      )

      const { result: responses, peakConcurrent } = await checkouts.peakDuring(() =>
        Promise.all(
          targets.map((target, i) =>
            request(app.getHttpServer())
              .patch(`/users/${target.id}`)
              .send({ jobTitle: `Concurrent Role ${i}` }),
          ),
        ),
      )

      // The headline regression assertion: on the pre-fix code this never
      // resolves at all within the test timeout below (see the
      // counterfactual run recorded in
      // docs/archive/audits/fix-wave-a-report.md) — 10 requests deadlock
      // holding their transaction's one connection while starved of a
      // second, and the other 10 never even get their first.
      expect(responses.map((r) => r.status)).toEqual(Array(20).fill(200))

      // Structurally guaranteed by pg-pool itself (`_isFull()` gates ever
      // creating an 11th client) regardless of this fix, but asserted
      // directly anyway, per the brief: even 20 logically concurrent writes
      // against a pool of 10 never check out more than the pool's own max.
      expect(peakConcurrent).toBeLessThanOrEqual(10)
    },
    30_000,
  )

  /**
   * Isolates the exact mechanism finding C1 describes, deliberately BELOW
   * the HTTP layer: replicates `UsersController.update`'s own transaction
   * body (load -> assertCanIn -> assertCanModifyPrincipal -> update) against
   * the same instrumented `appDb`/`appPool` the tests above use, but WITHOUT
   * going through `request(...)`. That matters because a full
   * `PATCH /users/:id` also calls `SyncStateRepository.resolveForUser`
   * AFTER the transaction commits — which correctly, deliberately, and
   * SAFELY fires four concurrent reads against the pool (see its own doc
   * comment: batched via `Promise.all`, nothing else holds a connection at
   * that point since the transaction already released its own) — so
   * measuring a whole HTTP request's peak checkout would conflate that
   * unrelated, benign concurrency with the transaction itself and could
   * never assert a clean "1". This test's measurement window is exactly,
   * and only, the transaction.
   */
  it(
    'a single in-transaction write (load, assertCanIn, assertCanModifyPrincipal, update) checks out exactly ONE connection, never two',
    async () => {
      const org = await makeOrgUnit()
      const actorUser = await makeActiveUser('admin', org.id)
      await rolesRepo().assign({ userId: actorUser.id, roleKey: 'user_admin', scopeOrgUnitId: org.id })
      const target = await makeActiveUser('target', org.id)

      // Bound to the SAME instrumented `appDb` the HTTP-level tests above
      // exercise. `resolveActor` deliberately runs OUTSIDE the transaction
      // below — correct, per PermissionEngine.resolveActor's own doc
      // comment, and exactly how the real `PermissionGuard` calls it on
      // every request — so it is not part of the measured window either.
      const engine = new PermissionEngine(appDb)
      const privileges = new PrivilegeGuards(appDb)
      const usersRepository = new UsersRepository(appDb)
      const actor = await engine.resolveActor({
        subject: 'kc-pool-solo-test',
        username: actorUser.username,
        email: null,
      })

      const { peakConcurrent } = await checkouts.peakDuring(() =>
        appDb.transaction(async (tx) => {
          const current = await usersRepository.findById(target.id, tx)
          if (current === null) throw new Error('fixture user vanished mid-test')

          await engine.assertCanIn(actor, 'user:update', current.orgUnitId, tx)
          await privileges.assertCanModifyPrincipal(actor, current.id, tx)

          return usersRepository.update(target.id, { jobTitle: 'Solo Request' }, tx)
        }),
      )

      // Direct measurement, not inference: before this fix, this was 2 —
      // `db.transaction(...)` checks out connection #1 for the whole
      // callback, then `assertCanIn`/`assertCanModifyPrincipal` queried
      // `this.db` (the POOL, not `tx`), checking out a second, concurrently
      // -held connection for that query's duration, before releasing it and
      // continuing on connection #1.
      expect(peakConcurrent).toBe(1)
    },
    15_000,
  )
})
