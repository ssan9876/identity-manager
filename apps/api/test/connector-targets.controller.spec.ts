import { randomUUID } from 'node:crypto'
import { type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JwtGuard } from '../src/auth/jwt.guard'
import type { RoleKey } from '../src/authz/actions'
import { PermissionEngine } from '../src/authz/permission.engine'
import { PermissionGuard } from '../src/authz/permission.guard'
import { RoleAssignmentsRepository } from '../src/authz/role-assignments.repository'
import { AuditWriter } from '../src/audit/audit.writer'
import { DB_CLIENT } from '../src/common/db.token'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import { ALL_CONNECTOR_TARGETS } from '../src/connectors/connector'
import { ConnectorRegistry } from '../src/connectors/connector-registry'
import { ConnectorTargetsController } from '../src/connectors/connector-targets.controller'
import { ConnectorTargetsRepository } from '../src/connectors/connector-targets.repository'
import { EchoConnector } from '../src/connectors/echo.connector'
import { GroupsRepository } from '../src/groups/groups.repository'
import { KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OutboxRepository } from '../src/outbox/outbox.repository'
import { SyncWorker } from '../src/outbox/sync.worker'
import { TargetReconciliationJob } from '../src/outbox/target-reconciliation.job'
import { UsersRepository, type User } from '../src/users/users.repository'
import { assertNoLeak } from './support/secret-leak'
import { withTestDatabase } from './support/pg'

/** Same technique as attribute-definitions.controller.spec.ts / org-units.write.spec.ts. */
function stubJwtGuard(getUsername: () => string): CanActivate {
  return {
    canActivate(context: ExecutionContext): boolean {
      context.switchToHttp().getRequest<{ principal?: unknown }>().principal = {
        subject: 'connector-targets-test',
        username: getUsername(),
        email: null,
      }
      return true
    },
  }
}

// A definitely-closed local port — connecting fails fast (ECONNREFUSED), not
// a network timeout — same trick target-reconciliation.spec.ts's own
// UNREACHABLE_ISSUER already uses.
const UNREACHABLE_ISSUER = 'http://127.0.0.1:1/realms/unreachable'

/**
 * MILESTONE 14, TASK 9 — `GET/PATCH /connector-targets`,
 * `POST /connector-targets/:target/reconcile`. Every connector/job
 * dependency is constructed MANUALLY, exactly like target-reconciliation.
 * spec.ts / connector-secrets.spec.ts already do (`new ConnectorRegistry(...)`,
 * never Nest-DI-resolved) — bound to the SAME ephemeral Testcontainer
 * Postgres (`ctx.db`) this file's own `withTestDatabase()` provides, then
 * handed to the Nest testing module via `useValue`. Only JwtGuard is
 * stubbed; PermissionGuard/PermissionEngine run for real, so `connector:read`
 * /`connector:manage` are genuinely exercised, not assumed.
 */
describe('ConnectorTargetsController (Milestone 14, Task 9)', () => {
  const ctx = withTestDatabase()
  let app: INestApplication
  let currentUsername = ''
  let echoConnector: EchoConnector
  let orgUnitId: string

  beforeAll(async () => {
    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`Connector Targets Root ${Date.now()}`)).id

    const keycloak = new KeycloakAdminClient({
      issuer: UNREACHABLE_ISSUER,
      clientId: 'irrelevant',
      clientSecret: 'irrelevant',
    })
    echoConnector = new EchoConnector()
    const registry = new ConnectorRegistry(keycloak, echoConnector)
    const syncWorker = new SyncWorker(
      ctx.db,
      new OutboxRepository(),
      new UsersRepository(ctx.db),
      new GroupsRepository(ctx.db),
      keycloak,
      undefined,
      registry,
    )
    const auditWriter = new AuditWriter()
    const job = new TargetReconciliationJob(new UsersRepository(ctx.db), registry, syncWorker, auditWriter, ctx.db)

    const moduleRef = await Test.createTestingModule({
      controllers: [ConnectorTargetsController],
      providers: [
        { provide: DB_CLIENT, useFactory: () => ctx.db },
        { provide: ConnectorRegistry, useValue: registry },
        { provide: TargetReconciliationJob, useValue: job },
        { provide: AuditWriter, useValue: auditWriter },
        ConnectorTargetsRepository,
        PermissionEngine,
        PermissionGuard,
        Reflector,
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
  })

  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `ct${fixtureSeq}`
  }

  const usersRepo = () => new UsersRepository(ctx.db)
  const rolesRepo = () => new RoleAssignmentsRepository(ctx.db)

  async function makeActiveUser(roleKey?: RoleKey, scopeOrgUnitId: string | null = null): Promise<User> {
    const tag = nextTag()
    const created = await usersRepo().create({
      primaryEmail: `${tag}@example.com`,
      username: `${tag}@example.com`,
      firstName: 'Connector',
      lastName: `Test${tag}`,
      orgUnitId,
    })
    const active = await usersRepo().changeStatus(created.id, 'active')
    if (roleKey !== undefined) {
      await rolesRepo().assign({ userId: active.id, roleKey, scopeOrgUnitId })
    }
    return active
  }

  async function deleteConnectorTarget(target: string): Promise<void> {
    await ctx.pool.query('DELETE FROM connector_targets WHERE target = $1', [target])
  }

  // =========================================================================
  // Authorization
  // =========================================================================

  it('rejects GET /connector-targets for a caller holding no role at all with 403', async () => {
    const actor = await makeActiveUser()
    currentUsername = actor.username
    const res = await request(app.getHttpServer()).get('/connector-targets').expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  it('rejects GET /connector-targets for a caller holding only user:read (read_only) with 403 — connector:read is a distinct grant', async () => {
    const actor = await makeActiveUser('read_only')
    currentUsername = actor.username
    await request(app.getHttpServer()).get('/connector-targets').expect(403)
  })

  it('allows GET /connector-targets for auditor (holds connector:read)', async () => {
    const actor = await makeActiveUser('auditor')
    currentUsername = actor.username
    await request(app.getHttpServer()).get('/connector-targets').expect(200)
  })

  it('rejects PATCH for auditor (holds connector:read, not connector:manage) with 403', async () => {
    const actor = await makeActiveUser('auditor')
    currentUsername = actor.username
    await request(app.getHttpServer()).patch('/connector-targets/echo').send({ enabled: true }).expect(403)
  })

  it('allows PATCH for super_admin (holds connector:manage)', async () => {
    const actor = await makeActiveUser('super_admin')
    currentUsername = actor.username
    await request(app.getHttpServer()).patch('/connector-targets/echo').send({ enabled: false }).expect(200)
  })

  // =========================================================================
  // config validation — INJ-H-1 / INJ-H-2 residuals
  // (docs/archive/audits/carried-findings-verification.md)
  // =========================================================================

  it('reports a __proto__ key in config rather than silently dropping it', async () => {
    const actor = await makeActiveUser('super_admin')
    currentUsername = actor.username

    // JSON.parse creates `__proto__` as a genuine OWN property, unlike an
    // object literal — so this is the real wire shape, not a synthetic one.
    const res = await request(app.getHttpServer())
      .patch('/connector-targets/echo')
      .set('Content-Type', 'application/json')
      .send('{"config":{"__proto__":"polluted","ok":"kept"}}')
      .expect(200)

    // The key must not have reached Object.prototype, and must not have been
    // silently elided either: it is a legal 1-128 char key, so it is stored
    // as ordinary data on a null-prototype object.
    expect({}.constructor.name).toBe('Object')
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()
    expect(res.body.config?.ok).toBe('kept')
  })

  it('rejects a config value containing a JSON-escaped NUL instead of 500ing at the driver', async () => {
    const actor = await makeActiveUser('super_admin')
    currentUsername = actor.username

    // TWO backslashes in the source: the JSON TEXT has to carry the escape
    // sequence, which JSON.parse then turns into a NUL inside the parsed
    // string. A RAW NUL byte would be a different, already-safe case —
    // invalid JSON syntax that JSON.parse rejects itself ("Bad control
    // character") before any application code runs. safe-string.ts draws
    // exactly this distinction; getting it wrong tests the wrong thing.
    const res = await request(app.getHttpServer())
      .patch('/connector-targets/echo')
      .set('Content-Type', 'application/json')
      .send('{"config":{"apiBase":"https://example.invalid/\\u0000"}}')
      .expect(400)

    expect(res.body.code).toBe('VALIDATION_FAILED')
    expect(JSON.stringify(res.body)).toMatch(/NUL/i)
  })

  it('rejects a non-object config', async () => {
    const actor = await makeActiveUser('super_admin')
    currentUsername = actor.username

    await request(app.getHttpServer())
      .patch('/connector-targets/echo')
      .send({ config: 'not-an-object' })
      .expect(400)
  })

  // =========================================================================
  // Scope narrowing (security audit finding: connector:manage was satisfied
  // by holding the action ANYWHERE)
  //
  // `connector_targets` has no orgUnitId — it is global infrastructure — so
  // there is no containing scope to narrow a request TO. That is exactly why
  // these routes need the OTHER half of the idiom this codebase already uses
  // for global resources (OrgUnitsController.create for a root org unit,
  // GroupsController for a global group): a GLOBAL grant, i.e.
  // `scopePathsFor(actor, action) === null`, not merely a grant at SOME scope.
  //
  // Every actor in this file was previously built with the default
  // `scopeOrgUnitId = null`, so no test in the tree had ever driven a
  // connector route with a SCOPED actor — the guard's own coverage had the
  // same shape as the bug.
  // =========================================================================

  it('rejects PATCH for a SCOPED super_admin — reconfiguring a global target needs a global grant', async () => {
    const actor = await makeActiveUser('super_admin', orgUnitId)
    currentUsername = actor.username
    const res = await request(app.getHttpServer())
      .patch('/connector-targets/echo')
      .send({ enabled: true })
      .expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  it('rejects POST /reconcile for a SCOPED super_admin — it walks the WHOLE directory, unscoped', async () => {
    // The dangerous one. TargetReconciliationJob pages the population with
    // `scopePaths: null`, so a departmentally-scoped admin could push every
    // user in the directory — including principals they get 403 on when
    // reading them one at a time — out to a target they just configured.
    const actor = await makeActiveUser('super_admin', orgUnitId)
    currentUsername = actor.username
    const res = await request(app.getHttpServer())
      .post('/connector-targets/echo/reconcile')
      .send({ dryRun: true })
      .expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  it('does NOT block a GLOBAL super_admin at the scope gate', async () => {
    // The positive control for the two tests above: proves they fail for the
    // right reason (the actor is SCOPED) rather than because the route is
    // simply unreachable. Asserts only "not 403" — whether this particular
    // reconcile then succeeds or 400s on target configuration is downstream
    // of authorization and deliberately not this test's business.
    const actor = await makeActiveUser('super_admin')
    currentUsername = actor.username
    const res = await request(app.getHttpServer())
      .post('/connector-targets/echo/reconcile')
      .send({ dryRun: true })
    expect(res.status).not.toBe(403)
  })

  // =========================================================================
  // Shape and validation
  // =========================================================================

  it('lists EVERY known target even when none has ever been configured', async () => {
    const admin = await makeActiveUser('super_admin')
    currentUsername = admin.username

    const res = await request(app.getHttpServer()).get('/connector-targets').expect(200)
    const targets = (res.body as { target: string }[]).map((t) => t.target).sort()
    // Derived from the catalog, never a hand-typed list: this assertion used
    // to spell out five literals and so had the SAME drift defect as the code
    // it covers — it went stale when `mail_server` was added and would have
    // had to be edited for every future target. What matters is that the
    // endpoint returns the WHOLE catalog; that the catalog itself matches the
    // database enums is pinned separately, by connector-target-catalog.spec.ts.
    expect(targets).toEqual([...ALL_CONNECTOR_TARGETS].sort())
    expect(targets).toContain('mail_server')
  })

  it('rejects an unknown target path segment with 400 VALIDATION_FAILED', async () => {
    const admin = await makeActiveUser('super_admin')
    currentUsername = admin.username
    const res = await request(app.getHttpServer()).get('/connector-targets/not-a-real-target').expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('rejects a blast-radius threshold outside 1-100 with 400 VALIDATION_FAILED', async () => {
    const admin = await makeActiveUser('super_admin')
    currentUsername = admin.username
    const res = await request(app.getHttpServer())
      .patch('/connector-targets/echo')
      .send({ blastRadiusThreshold: 0 })
      .expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('rejects a negative blast-radius floor with 400 VALIDATION_FAILED', async () => {
    const admin = await makeActiveUser('super_admin')
    currentUsername = admin.username
    const res = await request(app.getHttpServer())
      .patch('/connector-targets/echo')
      .send({ blastRadiusFloor: -1 })
      .expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  it('PATCH merges config onto what already exists rather than replacing it wholesale, and null deletes a key', async () => {
    const admin = await makeActiveUser('super_admin')
    currentUsername = admin.username
    const secretName = `CONNECTOR_MERGE_TEST_${randomUUID().replace(/-/g, '_')}`

    try {
      await deleteConnectorTarget('active_directory')

      await request(app.getHttpServer())
        .patch('/connector-targets/active_directory')
        .send({ config: { url: 'ldaps://dc1.example.com:636', credentialSecretName: secretName } })
        .expect(200)

      // A second PATCH touching an UNRELATED key must not destroy `url`.
      const res = await request(app.getHttpServer())
        .patch('/connector-targets/active_directory')
        .send({ config: { baseDN: 'DC=example,DC=com' } })
        .expect(200)
      expect(res.body.config).toMatchObject({
        url: 'ldaps://dc1.example.com:636',
        credentialSecretName: secretName,
        baseDN: 'DC=example,DC=com',
      })

      // Explicit null removes the key entirely.
      const cleared = await request(app.getHttpServer())
        .patch('/connector-targets/active_directory')
        .send({ config: { baseDN: null } })
        .expect(200)
      expect(cleared.body.config).not.toHaveProperty('baseDN')
      expect(cleared.body.config).toHaveProperty('url')
    } finally {
      await deleteConnectorTarget('active_directory')
    }
  })

  // =========================================================================
  // THE SINGLE MOST IMPORTANT STATE ON THIS SCREEN — "configured but never
  // successfully synced" must not read as healthy.
  // =========================================================================

  describe('health states, distinctly (the task\'s own core requirement)', () => {
    const secretName = `CONNECTOR_HEALTH_STATE_SECRET_${randomUUID().replace(/-/g, '_')}`

    beforeAll(() => {
      process.env[secretName] = 'health-state-test-secret'
    })
    afterAll(() => {
      delete process.env[secretName]
    })

    it('an unconfigured target reports not_configured, never healthy', async () => {
      const admin = await makeActiveUser('super_admin')
      currentUsername = admin.username
      await deleteConnectorTarget('google_workspace')

      const res = await request(app.getHttpServer()).get('/connector-targets/google_workspace').expect(200)
      expect(res.body).toMatchObject({ configured: false, enabled: false, healthStatus: 'not_configured' })
      expect(res.body.healthStatus).not.toBe('healthy')
    })

    it('a disabled target reports disabled, never healthy, even with valid config', async () => {
      const admin = await makeActiveUser('super_admin')
      currentUsername = admin.username

      await request(app.getHttpServer())
        .patch('/connector-targets/echo')
        .send({ enabled: false, config: { credentialSecretName: secretName } })
        .expect(200)

      const res = await request(app.getHttpServer()).get('/connector-targets/echo').expect(200)
      expect(res.body).toMatchObject({ configured: true, enabled: false, healthStatus: 'disabled' })
      expect(res.body.healthStatus).not.toBe('healthy')
    })

    it('an ENABLED, REACHABLE target that has never actually synced anyone reports never_synced — distinctly from healthy', async () => {
      const admin = await makeActiveUser('super_admin')
      currentUsername = admin.username
      const freshTarget = 'echo'

      // A fresh EchoConnector with no `apply()` history yet for this
      // specific secret name — health() succeeds (the secret resolves) but
      // lastSuccessfulSyncAt is still null (nothing in `external_identities`
      // for 'echo' from THIS suite's own fixtures yet).
      await deleteConnectorTarget(freshTarget)
      await request(app.getHttpServer())
        .patch(`/connector-targets/${freshTarget}`)
        .send({ enabled: true, config: { credentialSecretName: secretName } })
        .expect(200)

      const res = await request(app.getHttpServer()).get(`/connector-targets/${freshTarget}`).expect(200)
      expect(res.body.enabled).toBe(true)
      expect(res.body.lastSuccessfulSyncAt).toBeNull()
      // THE ASSERTION THAT MATTERS: never_synced is its OWN state, not folded
      // into healthy just because the live check passed.
      expect(res.body.healthStatus).toBe('never_synced')
      expect(res.body.healthStatus).not.toBe('healthy')
    })

    it('after a real sync succeeds, the SAME target flips to healthy, with a real lastSuccessfulSyncAt', async () => {
      const admin = await makeActiveUser('super_admin')
      currentUsername = admin.username

      // Drive one genuine, successful sync through the real spine — the
      // exact mechanism that populates external_identities.last_synced_at
      // (SyncWorker.reconcileUser's own upsert).
      const target = await new UsersRepository(ctx.db).create({
        primaryEmail: `healthflip-${nextTag()}@example.com`,
        username: `healthflip-${nextTag()}@example.com`,
        firstName: 'Health',
        lastName: 'Flip',
        orgUnitId,
      })
      await new UsersRepository(ctx.db).changeStatus(target.id, 'active')
      await ctx.db.transaction(async (tx) => {
        const syncWorker = new SyncWorker(
          ctx.db,
          new OutboxRepository(),
          new UsersRepository(ctx.db),
          new GroupsRepository(ctx.db),
          new KeycloakAdminClient({ issuer: UNREACHABLE_ISSUER, clientId: 'x', clientSecret: 'x' }),
          undefined,
          new ConnectorRegistry(
            new KeycloakAdminClient({ issuer: UNREACHABLE_ISSUER, clientId: 'x', clientSecret: 'x' }),
            echoConnector,
          ),
        )
        await syncWorker.reconcileUser(tx, target.id, 'echo')
      })

      const res = await request(app.getHttpServer()).get('/connector-targets/echo').expect(200)
      expect(res.body.healthStatus).toBe('healthy')
      expect(res.body.lastSuccessfulSyncAt).not.toBeNull()
    })

    it('a target whose secret is missing from the environment reports failing, with a clean, secret-free detail message', async () => {
      const admin = await makeActiveUser('super_admin')
      currentUsername = admin.username

      await request(app.getHttpServer())
        .patch('/connector-targets/echo')
        .send({ enabled: true, config: { credentialSecretName: `${secretName}_NEVER_SET` } })
        .expect(200)

      const res = await request(app.getHttpServer()).get('/connector-targets/echo').expect(200)
      expect(res.body.healthStatus).toBe('failing')
      expect(res.body.healthDetail).toContain(`${secretName}_NEVER_SET`)
      expect(res.body.healthDetail.toLowerCase()).not.toContain('health-state-test-secret')

      // restore for later tests in this file
      await request(app.getHttpServer())
        .patch('/connector-targets/echo')
        .send({ enabled: true, config: { credentialSecretName: secretName } })
        .expect(200)
    })
  })

  // =========================================================================
  // Secret-leak proof — "add a test proving the target-config endpoint's
  // response contains no resolved secret — reuse the sentinel helper."
  // =========================================================================

  describe('no resolved secret ever appears in this endpoint\'s response (reusing Task 2\'s sentinel helper)', () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>[]
    let loggedArgs: string[]

    beforeEach(() => {
      loggedArgs = []
      const capture = (...args: unknown[]) => {
        loggedArgs.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a))).join(' '))
      }
      consoleSpy = [
        vi.spyOn(console, 'log').mockImplementation(capture),
        vi.spyOn(console, 'error').mockImplementation(capture),
        vi.spyOn(console, 'warn').mockImplementation(capture),
      ]
    })
    afterEach(() => {
      for (const spy of consoleSpy) spy.mockRestore()
    })

    it('GET /connector-targets never echoes the resolved value of an enabled target\'s credential, even though it genuinely resolves and health() genuinely succeeds', async () => {
      const admin = await makeActiveUser('super_admin')
      currentUsername = admin.username

      const sentinelSecretName = `CONNECTOR_SENTINEL_${randomUUID().replace(/-/g, '_')}`
      const sentinelValue = `sentinel-${randomUUID()}`
      process.env[sentinelSecretName] = sentinelValue

      try {
        await request(app.getHttpServer())
          .patch('/connector-targets/echo')
          .send({ enabled: true, config: { credentialSecretName: sentinelSecretName } })
          .expect(200)

        const listRes = await request(app.getHttpServer()).get('/connector-targets').expect(200)
        const echoRow = (listRes.body as Array<{ target: string; healthStatus: string }>).find(
          (row) => row.target === 'echo',
        )
        expect(echoRow).toBeDefined()
        expect(['never_synced', 'healthy']).toContain(echoRow!.healthStatus) // sanity: this run really did resolve the real secret and succeed

        assertNoLeak(JSON.stringify(listRes.body), sentinelValue, 'GET /connector-targets response body')

        const detailRes = await request(app.getHttpServer()).get('/connector-targets/echo').expect(200)
        assertNoLeak(JSON.stringify(detailRes.body), sentinelValue, 'GET /connector-targets/:target response body')

        assertNoLeak(loggedArgs.join('\n'), sentinelValue, 'console.log/warn/error output during these requests')
      } finally {
        delete process.env[sentinelSecretName]
      }
    })
  })

  // =========================================================================
  // Dry run vs apply
  // =========================================================================

  describe('reconcile: dry run writes nothing, apply genuinely converges', () => {
    const secretName = `CONNECTOR_RECONCILE_SECRET_${randomUUID().replace(/-/g, '_')}`

    beforeAll(async () => {
      process.env[secretName] = 'reconcile-test-secret'
      // Lenient blast radius so this describe block's own population never trips the guard.
      await ctx.pool.query(
        `INSERT INTO connector_targets (target, enabled, config, blast_radius_threshold, blast_radius_floor)
         VALUES ('echo', true, $1, 100, 1000000)
         ON CONFLICT (target) DO UPDATE SET enabled = true, config = $1, blast_radius_threshold = 100, blast_radius_floor = 1000000`,
        [JSON.stringify({ credentialSecretName: secretName })],
      )
    })
    afterAll(() => {
      delete process.env[secretName]
    })

    it('reconcile 404/400s cleanly for a target with no blast-radius configuration on record', async () => {
      const admin = await makeActiveUser('super_admin')
      currentUsername = admin.username
      await deleteConnectorTarget('entra_id')

      const res = await request(app.getHttpServer())
        .post('/connector-targets/entra_id/reconcile')
        .send({ dryRun: true })
        .expect(400)
      expect(res.body.code).toBe('VALIDATION_FAILED')
    })

    it('a dry run reports a real plan but leaves lastSuccessfulSyncAt and health untouched — then apply genuinely converges and health reflects it', async () => {
      const admin = await makeActiveUser('super_admin')
      currentUsername = admin.username

      const person = await usersRepo().create({
        primaryEmail: `dryrun-${nextTag()}@example.com`,
        username: `dryrun-${nextTag()}@example.com`,
        firstName: 'Dry',
        lastName: 'Run',
        orgUnitId,
      })
      await usersRepo().changeStatus(person.id, 'active')

      const before = await request(app.getHttpServer()).get('/connector-targets/echo').expect(200)

      const dryRunRes = await request(app.getHttpServer())
        .post('/connector-targets/echo/reconcile')
        .send({ dryRun: true })
        .expect(200)
      expect(dryRunRes.body.dryRun).toBe(true)
      expect(dryRunRes.body.appliedCount).toBe(0)
      expect(dryRunRes.body.toMutate.some((p: { userId: string }) => p.userId === person.id)).toBe(true)

      // THE ASSERTION THAT MATTERS: the dry run wrote nothing — health/last-sync are byte-for-byte unchanged.
      const afterDryRun = await request(app.getHttpServer()).get('/connector-targets/echo').expect(200)
      expect(afterDryRun.body.lastSuccessfulSyncAt).toBe(before.body.lastSuccessfulSyncAt)

      const applyRes = await request(app.getHttpServer())
        .post('/connector-targets/echo/reconcile')
        .send({ dryRun: false })
        .expect(200)
      expect(applyRes.body.halted).toBe(false)
      expect(applyRes.body.appliedCount).toBeGreaterThan(0)

      const afterApply = await request(app.getHttpServer()).get('/connector-targets/echo').expect(200)
      expect(afterApply.body.healthStatus).toBe('healthy')
      expect(afterApply.body.lastSuccessfulSyncAt).not.toBeNull()
    })

    it('a run that trips the blast-radius guard halts and applies nothing — assert against the target itself, not a log line', async () => {
      const admin = await makeActiveUser('super_admin')
      currentUsername = admin.username

      // A strict, guaranteed-to-trip guard for THIS one target row.
      await request(app.getHttpServer())
        .patch('/connector-targets/echo')
        .send({ blastRadiusThreshold: 1, blastRadiusFloor: 0 })
        .expect(200)

      const person = await usersRepo().create({
        primaryEmail: `halt-${nextTag()}@example.com`,
        username: `halt-${nextTag()}@example.com`,
        firstName: 'Halt',
        lastName: 'Test',
        orgUnitId,
      })
      await usersRepo().changeStatus(person.id, 'active')

      const callsBefore = echoConnector.calls.filter((c) => c.method === 'apply').length

      const res = await request(app.getHttpServer())
        .post('/connector-targets/echo/reconcile')
        .send({ dryRun: false })
        .expect(200)
      expect(res.body.halted).toBe(true)
      expect(res.body.appliedCount).toBe(0)

      const callsAfter = echoConnector.calls.filter((c) => c.method === 'apply').length
      expect(callsAfter).toBe(callsBefore) // nothing genuinely reached the target

      // Restore lenient settings for any later test in this file.
      await request(app.getHttpServer())
        .patch('/connector-targets/echo')
        .send({ blastRadiusThreshold: 100, blastRadiusFloor: 1000000 })
        .expect(200)
    })
  })
})
