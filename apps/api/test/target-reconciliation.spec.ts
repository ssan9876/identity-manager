import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { ConnectorRegistry } from '../src/connectors/connector-registry'
import { EchoConnector } from '../src/connectors/echo.connector'
import { GroupsRepository } from '../src/groups/groups.repository'
import { KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OutboxRepository } from '../src/outbox/outbox.repository'
import { SyncWorker } from '../src/outbox/sync.worker'
import {
  evaluateBlastRadius,
  TargetReconciliationJob,
} from '../src/outbox/target-reconciliation.job'
import { type User, UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

// ---------------------------------------------------------------------------
// Pure unit tests: the blast-radius decision is a free function with no I/O
// — same reasoning `computeBackoffDelayMs` (sync.worker.spec.ts) is tested
// standalone. Covers the full threshold/floor matrix cheaply, including
// combinations impractical to reproduce against a real population (e.g. "a
// large absolute count that is still a tiny percentage of a huge org").
// ---------------------------------------------------------------------------
describe('evaluateBlastRadius (Milestone 10, Task 4)', () => {
  it('does not trip when NEITHER the percentage nor the floor is exceeded', () => {
    const result = evaluateBlastRadius(1, 100, 20, 5)
    expect(result.tripped).toBe(false)
  })

  it('does not trip when the percentage is exceeded but the floor is NOT — the worked example from the design brief', () => {
    // "Without [the floor] a ten-person directory trips at three routine
    // changes; with it, small real changes proceed."
    const result = evaluateBlastRadius(3, 10, 20, 5)
    expect(result.tripped).toBe(false) // 3/10 = 30% > 20%, but 3 is not > floor 5
  })

  it('does not trip when the floor is exceeded but the percentage is NOT — large absolute count, tiny slice of a huge population', () => {
    const result = evaluateBlastRadius(50, 100_000, 20, 5) // 50 > floor 5, but 0.05% << 20%
    expect(result.tripped).toBe(false)
  })

  it('trips only once BOTH are exceeded — large and real', () => {
    const result = evaluateBlastRadius(5_000, 10_000, 20, 50) // 50% > 20%, and 5000 > 50
    expect(result.tripped).toBe(true)
  })

  it('is a STRICT "more than" on the percentage — exactly at the threshold does not trip', () => {
    const result = evaluateBlastRadius(20, 100, 20, 1) // exactly 20% of 100, floor easily exceeded
    expect(result.tripped).toBe(false)
    expect(evaluateBlastRadius(21, 100, 20, 1).tripped).toBe(true)
  })

  it('is a STRICT "more than" on the floor — exactly at the floor does not trip', () => {
    const result = evaluateBlastRadius(5, 10, 1, 5) // 5/10=50%>>1%, but 5 is not > floor 5
    expect(result.tripped).toBe(false)
    expect(evaluateBlastRadius(6, 10, 1, 5).tripped).toBe(true)
  })

  it('never trips against a zero population', () => {
    expect(evaluateBlastRadius(0, 0, 1, 0).tripped).toBe(false)
  })

  it('reports the inputs back verbatim alongside the verdict, for the caller to render', () => {
    const result = evaluateBlastRadius(15, 50, 20, 5) // 15/50 = 30% > 20%, and 15 > floor 5 — trips
    expect(result).toEqual({ tripped: true, changedCount: 15, populationSize: 50, thresholdPercent: 20, floor: 5 })
  })
})

// A definitely-closed local port: connecting fails fast with ECONNREFUSED
// rather than a network timeout — same trick sync.worker.spec.ts's own
// UNREACHABLE_ISSUER already uses. Every test below targets 'echo' only, so
// `KeycloakAdminClient` must exist (SyncWorker's constructor requires one,
// and so does ConnectorRegistry's) but is never actually called — no real
// Keycloak Testcontainer is needed for this file, keeping it fast.
const UNREACHABLE_ISSUER = 'http://127.0.0.1:1/realms/unreachable'
const ECHO_SECRET_NAME = 'TARGET_RECONCILE_TEST_SECRET'

/**
 * MILESTONE 10, TASK 4: per-target reconciliation, the blast-radius guard,
 * and dry run — against a REAL Postgres Testcontainer and the REAL,
 * registered `EchoConnector` (never a mock — it is a genuine
 * `DirectoryConnector` implementation, the same one Milestone 14's console
 * will drive). No Keycloak container: every test here targets `'echo'`.
 *
 * ONE `EchoConnector` instance for the WHOLE file, deliberately — it is
 * this suite's stand-in for "the real external directory," and a real
 * directory's state persists across reconcile runs. Reusing the SAME
 * instance (rather than a fresh one per test) is what makes "a second run
 * is a no-op" and the blast-radius/floor arithmetic meaningful across
 * successive tests: `plan()` diffs against what this connector actually
 * has on record (see echo.connector.ts's own `lastAppliedByUsername` doc
 * comment), exactly like a real target would.
 *
 * No table reset between tests (this file's `users`/`connector_targets`
 * population is cumulative, matching every other Testcontainer-backed spec
 * in this suite — see sync.worker.spec.ts's own doc comment for why).
 * Every test that would otherwise leave un-converged residue behind
 * (dry run; a halted blast-radius run) explicitly converges its own users
 * before finishing, specifically so a LATER test's population/changedCount
 * arithmetic stays exact and does not depend on execution order beyond
 * "earlier tests ran first." Tests that assert a blast-radius VERDICT
 * additionally use deliberately extreme threshold/floor values (either
 * lenient enough to structurally never trip, or strict enough to trip on
 * any handful of genuine changes) precisely so accumulated population from
 * earlier tests can never flip the verdict either way.
 */
describe('TargetReconciliationJob (Milestone 10, Task 4)', () => {
  const ctx = withTestDatabase()
  let orgUnitId: string
  let echoConnector: EchoConnector
  let job: TargetReconciliationJob

  const usersRepo = () => new UsersRepository(ctx.db)

  beforeAll(async () => {
    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`Target Reconcile Root ${Date.now()}`)).id
    process.env[ECHO_SECRET_NAME] = 'target-reconcile-test-secret'

    const client = new KeycloakAdminClient({
      issuer: UNREACHABLE_ISSUER,
      clientId: 'irrelevant',
      clientSecret: 'irrelevant',
    })
    echoConnector = new EchoConnector()
    const registry = new ConnectorRegistry(client, echoConnector)
    const syncWorker = new SyncWorker(
      ctx.db,
      new OutboxRepository(),
      usersRepo(),
      new GroupsRepository(ctx.db),
      client,
      undefined,
      registry,
    )
    job = new TargetReconciliationJob(usersRepo(), registry, syncWorker, new AuditWriter(), ctx.db)

    // Lenient default: never trips unless a test explicitly tightens it.
    await configureEchoTarget(100, 1_000_000)
  })

  afterAll(() => {
    delete process.env[ECHO_SECRET_NAME]
  })

  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `${fixtureSeq}`
  }

  async function makeActiveUser(): Promise<User> {
    const tag = nextTag()
    const username = `tr-user-${tag}@example.com`.toLowerCase()
    const user = await usersRepo().create({
      primaryEmail: username,
      username,
      firstName: 'Target',
      lastName: `Reconcile${tag}`,
      orgUnitId,
    })
    await usersRepo().changeStatus(user.id, 'active')
    return user
  }

  async function makeActiveUsers(count: number): Promise<User[]> {
    const users: User[] = []
    for (let i = 0; i < count; i++) {
      users.push(await makeActiveUser())
    }
    return users
  }

  /** Upserts the echo `connector_targets` row with EXPLICIT blast-radius config — every test controls its own threshold/floor rather than relying on schema defaults, since this file's population accumulates across tests (see this file's own doc comment). */
  async function configureEchoTarget(thresholdPercent: number, floor: number): Promise<void> {
    await ctx.pool.query(
      `INSERT INTO connector_targets (target, enabled, config, blast_radius_threshold, blast_radius_floor)
       VALUES ('echo', true, $1, $2, $3)
       ON CONFLICT (target) DO UPDATE SET enabled = true, config = $1, blast_radius_threshold = $2, blast_radius_floor = $3`,
      [JSON.stringify({ credentialSecretName: ECHO_SECRET_NAME }), thresholdPercent, floor],
    )
  }

  async function totalCount(table: string): Promise<number> {
    const { rows } = await ctx.pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`)
    return rows[0]?.count ?? 0
  }

  async function externalIdentityCountForEcho(): Promise<number> {
    const { rows } = await ctx.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM external_identities WHERE system = 'echo'",
    )
    return rows[0]?.count ?? 0
  }

  function applyCallCount(): number {
    return echoConnector.calls.filter((call) => call.method === 'apply').length
  }

  function appliedUsernames(): Set<string> {
    return new Set(
      echoConnector.calls
        .filter((call) => call.method === 'apply')
        .map((call) => call.desired?.username)
        .filter((username): username is string => username !== undefined),
    )
  }

  // =====================================================================
  // Per-target reconcile: asserts desired state for every in-scope
  // principal, via the connector interface, idempotently.
  // =====================================================================
  describe('per-target reconcile — asserts desired state, idempotently', () => {
    it('reconciles a fresh active user to echo with exactly the desired state, and a second run is a no-op', async () => {
      const user = await makeActiveUser()
      const callsBefore = applyCallCount()

      const first = await job.reconcile('echo', {})

      expect(first.toMutate.some((p) => p.userId === user.id)).toBe(true)
      expect(applyCallCount()).toBe(callsBefore + 1)
      expect(appliedUsernames().has(user.username)).toBe(true)

      const applyCall = echoConnector.calls.find(
        (call) => call.method === 'apply' && call.desired?.username === user.username,
      )
      expect(applyCall?.desired).toEqual({
        username: user.username,
        email: user.primaryEmail,
        firstName: user.firstName,
        lastName: user.lastName,
        enabled: true,
        attributes: {},
        groups: [],
      })

      // Correlated under system='echo' with echo's own synthetic id.
      const { rows } = await ctx.pool.query<{ external_id: string; sync_state: string }>(
        "SELECT external_id, sync_state FROM external_identities WHERE user_id = $1 AND system = 'echo'",
        [user.id],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.external_id).toMatch(/^echo-/)
      expect(rows[0]?.sync_state).toBe('synced')

      // Second run: THIS user is fully converged — no new apply call for
      // them, and the report no longer flags them.
      const callsAfterFirst = applyCallCount()
      const second = await job.reconcile('echo', {})
      expect(second.toMutate.some((p) => p.userId === user.id)).toBe(false)
      expect(applyCallCount()).toBe(callsAfterFirst)
    })

    it('reconciles a DEACTIVATED user with enabled:false — never a disable() call, never removed from the target', async () => {
      const user = await makeActiveUser()
      await usersRepo().changeStatus(user.id, 'deactivated')
      const disableCallsBefore = echoConnector.calls.filter((call) => call.method === 'disable').length

      await job.reconcile('echo', {})

      const applyCall = echoConnector.calls.find(
        (call) => call.method === 'apply' && call.desired?.username === user.username,
      )
      expect(applyCall?.desired?.enabled).toBe(false)
      // Non-negotiable: disable-only means asserting enabled:false via
      // apply(), never a removal-shaped disable() call from this job.
      expect(echoConnector.calls.filter((call) => call.method === 'disable').length).toBe(disableCallsBefore)
    })
  })

  // =====================================================================
  // Dry run — writes nothing anywhere, matching how the import preview is
  // already tested (imports.write.spec.ts: user/audit/outbox counts
  // unchanged). A fourth count is checked here that import preview has no
  // analogue for: zero TARGET mutations reached the connector.
  // =====================================================================
  describe('dry run writes nothing anywhere (Milestone 10, Task 4)', () => {
    it('computes a real plan but leaves all four counts unchanged: target mutations, user rows, audit rows, outbox events', async () => {
      const users = await makeActiveUsers(2)

      const usersBefore = await totalCount('users')
      const auditBefore = await totalCount('audit_log')
      const outboxBefore = await totalCount('outbox_events')
      const externalBefore = await externalIdentityCountForEcho()
      const applyCallsBefore = applyCallCount()

      const report = await job.reconcile('echo', { dryRun: true })

      expect(report.dryRun).toBe(true)
      expect(report.appliedCount).toBe(0)
      // The plan found REAL work — this is not a vacuous "nothing to do" run.
      expect(users.every((u) => report.toMutate.some((p) => p.userId === u.id))).toBe(true)

      expect(await totalCount('users')).toBe(usersBefore)
      expect(await totalCount('audit_log')).toBe(auditBefore)
      expect(await totalCount('outbox_events')).toBe(outboxBefore)
      expect(await externalIdentityCountForEcho()).toBe(externalBefore)
      expect(applyCallCount()).toBe(applyCallsBefore)
      expect(echoConnector.calls.some((call) => call.method === 'disable')).toBe(false)

      // Cleanup + bonus proof: a REAL run afterward still converges these
      // users normally — dry run left no corrupted/partial state behind —
      // and this keeps later tests' population arithmetic exact.
      const real = await job.reconcile('echo', { dryRun: false })
      expect(users.every((u) => real.toMutate.some((p) => p.userId === u.id))).toBe(true)
      expect(real.appliedCount).toBeGreaterThanOrEqual(2)
    })
  })

  // =====================================================================
  // The blast-radius guard — the reason this task exists. Proven against
  // what the target actually received, not against a logged warning.
  // =====================================================================
  describe('blast-radius guard (Milestone 10, Task 4)', () => {
    it('a run exceeding BOTH the threshold and the floor halts and applies ZERO mutations — reports what it would have done', async () => {
      await configureEchoTarget(1, 1) // trips on virtually any handful of genuine changes
      const users = await makeActiveUsers(6)
      const applyCallsBefore = applyCallCount()
      const externalBefore = await externalIdentityCountForEcho()

      const report = await job.reconcile('echo', {})

      expect(report.blastRadius.tripped).toBe(true)
      expect(report.blastRadius.changedCount).toBe(6)
      expect(report.halted).toBe(true)
      expect(report.overridden).toBe(false)
      expect(report.appliedCount).toBe(0)
      // It still REPORTS what it would have done.
      expect(users.every((u) => report.toMutate.some((p) => p.userId === u.id))).toBe(true)

      // THE assertion that matters: nothing arrived at the target. Not "a
      // warning was logged" — the echo connector's own call log is untouched.
      expect(applyCallCount()).toBe(applyCallsBefore)
      expect(await externalIdentityCountForEcho()).toBe(externalBefore)
      for (const user of users) {
        expect(appliedUsernames().has(user.username)).toBe(false)
      }

      // Cleanup: converge these 6 under a lenient config so they do not
      // pollute later tests' population/changedCount arithmetic.
      await configureEchoTarget(100, 1_000_000)
      const cleanup = await job.reconcile('echo', {})
      expect(users.every((u) => cleanup.toMutate.some((p) => p.userId === u.id))).toBe(true)
      expect(applyCallCount()).toBe(applyCallsBefore + 6)
    })

    it('a small number of changes below the floor proceeds even though the percentage alone would exceed the threshold', async () => {
      // Task 4's own worked example: a ten-person directory, 20% threshold,
      // three routine changes — 30% > 20%, but 3 is not > floor 5, so this
      // must proceed. Earlier tests already converged their own users (see
      // each one's own cleanup step), so these 3 are the only genuine
      // change in scope right now — the assertions below are exact.
      await configureEchoTarget(20, 5)
      const users = await makeActiveUsers(3)
      const applyCallsBefore = applyCallCount()

      const report = await job.reconcile('echo', {})

      expect(report.blastRadius.changedCount).toBe(3)
      expect(report.blastRadius.tripped).toBe(false)
      expect(report.halted).toBe(false)
      expect(report.appliedCount).toBe(3)
      expect(applyCallCount()).toBe(applyCallsBefore + 3)
      for (const user of users) {
        expect(appliedUsernames().has(user.username)).toBe(true)
      }
    })

    it('overriding a tripped guard with force applies the changes and writes exactly one audited override row', async () => {
      await configureEchoTarget(1, 1)
      const users = await makeActiveUsers(6)
      const applyCallsBefore = applyCallCount()
      const auditBefore = await totalCount('audit_log')

      const report = await job.reconcile('echo', { force: true })

      expect(report.blastRadius.tripped).toBe(true)
      expect(report.halted).toBe(false)
      expect(report.overridden).toBe(true)
      expect(report.appliedCount).toBe(6)
      expect(applyCallCount()).toBe(applyCallsBefore + 6)
      for (const user of users) {
        expect(appliedUsernames().has(user.username)).toBe(true)
      }

      expect(await totalCount('audit_log')).toBe(auditBefore + 1)
      const { rows } = await ctx.pool.query<{
        actor_user_id: string | null
        action: string
        resource_type: string
        resource_id: string | null
        after: { target: string; changedCount: number; populationSize: number; thresholdPercent: number; floor: number }
      }>(
        "SELECT actor_user_id, action, resource_type, resource_id, after FROM audit_log WHERE action = 'connector:reconcile-override' ORDER BY id DESC LIMIT 1",
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.actor_user_id).toBeNull()
      expect(rows[0]?.resource_type).toBe('connector_target')
      expect(rows[0]?.resource_id).toBeNull()
      expect(rows[0]?.after.target).toBe('echo')
      expect(rows[0]?.after.changedCount).toBe(6)
      expect(rows[0]?.after.thresholdPercent).toBe(1)
      expect(rows[0]?.after.floor).toBe(1)
    })

    it('fails cleanly when the target has no connector_targets row configured, rather than guessing a default', async () => {
      await ctx.pool.query("DELETE FROM connector_targets WHERE target = 'active_directory'")
      await expect(job.reconcile('active_directory', {})).rejects.toThrow(
        /no connector_targets row configured for target "active_directory"/,
      )
    })
  })

  // =====================================================================
  // Per-principal failure isolation — Milestone 10 Task 4 concern 3,
  // explicitly in scope for Milestone 11 Task 5 to close: one principal's
  // OWN `reconcileUser` throwing must not abort the batch, and must not
  // leave ANOTHER principal (before or after it) unattempted or partially
  // applied. Fast, echo-based proof using `EchoConnector.forcedFailureUsernames`
  // (no AD container needed for the GENERIC fix) — the AD-SPECIFIC version
  // of this same guarantee, against a REAL dropped LDAP connection mid-batch,
  // lives in test/active-directory.connector.spec.ts ("a connection failure
  // mid-batch leaves no partially-applied user").
  // =====================================================================
  describe('per-principal failure isolation (Milestone 10 Task 4 concern 3)', () => {
    it('one principal failing does not abort the batch, and does not affect any other principal', async () => {
      await configureEchoTarget(100, 1_000_000) // lenient — this test is about isolation, not the guard
      const [a, b, c] = await makeActiveUsers(3)
      echoConnector.forcedFailureUsernames.add(b!.username)
      const applyCallsBefore = applyCallCount()

      try {
        const report = await job.reconcile('echo', {})

        expect(report.halted).toBe(false)
        expect(report.toMutate.map((p) => p.userId).sort()).toEqual([a!.id, b!.id, c!.id].sort())
        // THE isolation claim: b's failure did not stop a (before it) or c
        // (after it, in insertion order) from being attempted and applied.
        expect(report.appliedCount).toBe(2)
        expect(report.failed).toHaveLength(1)
        expect(report.failed[0]).toEqual({
          userId: b!.id,
          username: b!.username,
          error: expect.stringMatching(/forced failure/),
        })
        expect(appliedUsernames().has(a!.username)).toBe(true)
        expect(appliedUsernames().has(c!.username)).toBe(true)
        expect(appliedUsernames().has(b!.username)).toBe(false)
        expect(applyCallCount()).toBe(applyCallsBefore + 2)
      } finally {
        echoConnector.forcedFailureUsernames.delete(b!.username)
      }

      // Self-heals: b converges on the VERY NEXT run once its transient
      // error clears — the failure was recorded (report.failed), never
      // silently dropped, and never left the user permanently stuck either.
      const followUp = await job.reconcile('echo', {})
      expect(followUp.failed).toHaveLength(0)
      expect(appliedUsernames().has(b!.username)).toBe(true)
    })
  })

  // =====================================================================
  // The floor/threshold columns are settled, structural invariants now —
  // belt-and-braces proof that an out-of-range value is rejected at the
  // database level, not merely by convention.
  // =====================================================================
  describe('blast-radius config is a structural invariant (connector_targets CHECK constraints)', () => {
    it('rejects a threshold outside 1-100', async () => {
      await expect(
        ctx.pool.query(
          `UPDATE connector_targets SET blast_radius_threshold = 0 WHERE target = 'echo'`,
        ),
      ).rejects.toThrow(/connector_targets_threshold_range/)
      await expect(
        ctx.pool.query(
          `UPDATE connector_targets SET blast_radius_threshold = 101 WHERE target = 'echo'`,
        ),
      ).rejects.toThrow(/connector_targets_threshold_range/)
    })

    it('rejects a negative floor', async () => {
      await expect(
        ctx.pool.query(`UPDATE connector_targets SET blast_radius_floor = -1 WHERE target = 'echo'`),
      ).rejects.toThrow(/connector_targets_floor_non_negative/)
    })
  })
})
