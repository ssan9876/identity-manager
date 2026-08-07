import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ConnectorRegistry } from '../src/connectors/connector-registry'
import { EchoConnector } from '../src/connectors/echo.connector'
import { GroupsRepository } from '../src/groups/groups.repository'
import {
  KeycloakAdminClient,
  type KeycloakAdminClientConfig,
} from '../src/keycloak/keycloak-admin.client'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OutboxRepository } from '../src/outbox/outbox.repository'
import { computeBackoffDelayMs, SyncWorker, type SyncWorkerConfig } from '../src/outbox/sync.worker'
import { type User, UsersRepository } from '../src/users/users.repository'
import { startKeycloak, type TestKeycloak } from './support/keycloak'
import { withTestDatabase } from './support/pg'

const SYNC_CLIENT_ID = 'idm-sync-service'
const SYNC_CLIENT_SECRET = 'idm_sync_dev_secret_change_me'

// A definitely-closed local port: connecting to it fails FAST with
// ECONNREFUSED rather than hanging on a network timeout, which is what
// every "Keycloak unreachable" test below needs to stay quick and
// deterministic.
const UNREACHABLE_ISSUER = 'http://127.0.0.1:1/realms/unreachable'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function unreachableClient(): KeycloakAdminClient {
  return new KeycloakAdminClient({
    issuer: UNREACHABLE_ISSUER,
    clientId: 'irrelevant',
    clientSecret: 'irrelevant',
  })
}

/**
 * A REAL `KeycloakAdminClient` (a subclass, not a hand-rolled double — a
 * separate class implementing the same shape would not be assignable where
 * `KeycloakAdminClient` is required, since the real class carries private
 * fields) whose group-related calls can be paused deterministically from a
 * test. Built for finding H2's own regression coverage below: the auditor's
 * reproduction needed one worker "inside ensureGroup" — i.e. past its
 * effective-group READ but not yet through its Keycloak WRITE — while a
 * second, unthrottled worker fully drains a conflicting change for the same
 * user. A `setTimeout`-based sleep alone cannot GUARANTEE the read already
 * happened before the test acts; a `reached` signal fired at the top of the
 * gated call, awaited before the test proceeds, can.
 */
class GatedKeycloakAdminClient extends KeycloakAdminClient {
  private gate: Promise<void> = Promise.resolve()
  private releaseGate: () => void = () => {}
  private reachedResolve: (() => void) | null = null
  /** Resolves once a gated call has fired AND is blocked on the current gate — i.e. its caller's own reads have already completed. */
  reached: Promise<void> = Promise.resolve()

  constructor(config: KeycloakAdminClientConfig) {
    super(config)
  }

  /** Arms a fresh gate + reached-signal for the next controlled call. */
  arm(): void {
    this.gate = new Promise((resolve) => {
      this.releaseGate = resolve
    })
    this.reached = new Promise((resolve) => {
      this.reachedResolve = resolve
    })
  }

  /** Lets every call currently blocked on the armed gate proceed. */
  release(): void {
    this.releaseGate()
  }

  /**
   * Signals "reached" on the first gated call after `arm()`, then blocks
   * until `release()`. Once released, adds a small FIXED handicap before
   * letting the real call through — the same "slow, not down" shape the
   * auditor's own reproduction used (Keycloak at 120 ms/call), just applied
   * surgically from the point of interleaving onward instead of uniformly:
   * it gives a concurrent, un-gated worker processing a DIFFERENT event for
   * the SAME user room to complete its own full read-then-write cycle
   * first, so a stale write landing after it is a genuine, reliably
   * reproduced race rather than a coin flip decided by incidental
   * call-count/scheduling asymmetry between the two workers.
   */
  private async passGate(): Promise<void> {
    this.reachedResolve?.()
    this.reachedResolve = null
    await this.gate
    await new Promise((resolve) => setTimeout(resolve, 75))
  }

  override async ensureGroup(name: string): ReturnType<KeycloakAdminClient['ensureGroup']> {
    await this.passGate()
    return super.ensureGroup(name)
  }

  override async setUserGroups(
    username: string,
    groupIds: readonly string[],
  ): ReturnType<KeycloakAdminClient['setUserGroups']> {
    await this.passGate()
    return super.setUserGroups(username, groupIds)
  }
}

interface OutboxRow {
  id: string
  status: string
  attempts: number
  next_attempt_at: string
  last_error: string | null
}

interface ExternalIdentityRow {
  external_id: string
  sync_state: string
  last_synced_at: string | null
}

// ---------------------------------------------------------------------------
// Pure unit tests: the backoff calculation is a free function with no I/O.
// ---------------------------------------------------------------------------
describe('computeBackoffDelayMs', () => {
  const config = { baseDelayMs: 1000, maxDelayMs: 1_000_000 }

  it('grows exponentially with attempts (checked at the bottom of the jitter range, random() = 0)', () => {
    expect(computeBackoffDelayMs(1, config, () => 0)).toBe(500) // exp=1000, half=500
    expect(computeBackoffDelayMs(2, config, () => 0)).toBe(1000) // exp=2000, half=1000
    expect(computeBackoffDelayMs(3, config, () => 0)).toBe(2000) // exp=4000, half=2000
  })

  it('jitters within [half, full] of the exponential value', () => {
    expect(computeBackoffDelayMs(1, config, () => 0)).toBe(500)
    expect(computeBackoffDelayMs(1, config, () => 1)).toBe(1000)
    expect(computeBackoffDelayMs(1, config, () => 0.5)).toBe(750)
  })

  it('never exceeds maxDelayMs, even at a high attempt count', () => {
    const capped = { baseDelayMs: 1000, maxDelayMs: 5000 }
    expect(computeBackoffDelayMs(20, capped, () => 1)).toBe(5000)
    expect(computeBackoffDelayMs(20, capped, () => 0)).toBe(2500)
  })

  it('treats attempts <= 1 the same as attempts = 1 (no negative exponent)', () => {
    expect(computeBackoffDelayMs(0, config, () => 0)).toBe(computeBackoffDelayMs(1, config, () => 0))
  })
})

/**
 * MILESTONE 4, TASK 3: the sync worker that drains `outbox_events` into
 * Keycloak. Against a REAL Postgres Testcontainer (`withTestDatabase`) AND a
 * REAL Keycloak Testcontainer (`startKeycloak`) — never mocks, per the
 * milestone plan's global constraints.
 *
 * One Postgres container and one Keycloak container are shared across every
 * test below (both are expensive to start), so — exactly like
 * outbox-emission.spec.ts and users.write.spec.ts before it — this file does
 * NOT reset tables between tests; every fixture is uniquely tagged
 * (`nextTag`) instead. The `afterEach` below additionally drains the ENTIRE
 * backlog after every single test, which matters more here than in those
 * files: `SyncWorker.runOnce`/`drain` always claim the globally
 * lowest-id CLAIMABLE row across every aggregate (see
 * OutboxRepository.claimNext), so a row left `pending` and due at the end of
 * one test would otherwise be silently picked up by an unrelated LATER
 * test's own `runOnce()` call instead of the row that test just inserted.
 */
describe('SyncWorker (Milestone 4, Task 3)', () => {
  const ctx = withTestDatabase()
  let keycloak: TestKeycloak
  let client: KeycloakAdminClient
  let cleanupWorker: SyncWorker
  let orgUnitId: string

  const usersRepo = () => new UsersRepository(ctx.db)
  const groupsRepo = () => new GroupsRepository(ctx.db)
  const outboxRepo = () => new OutboxRepository()
  // `registry` (Milestone 10, Task 2) is a new, OPTIONAL, trailing parameter
  // — every pre-existing call below (`makeWorker()`, `makeWorker(kc)`,
  // `makeWorker(kc, config)`) is unaffected and keeps getting SyncWorker's
  // own default (a registry wrapping `kc`); only the new "connector registry
  // dispatch" block passes one explicitly, so it can hold onto a specific
  // EchoConnector and inspect what it recorded afterward.
  const makeWorker = (
    kc: KeycloakAdminClient = client,
    config?: Partial<SyncWorkerConfig>,
    registry?: ConnectorRegistry,
  ) => new SyncWorker(ctx.db, outboxRepo(), usersRepo(), groupsRepo(), kc, config, registry)

  beforeAll(async () => {
    keycloak = await startKeycloak()
    client = new KeycloakAdminClient({
      issuer: keycloak.issuer,
      clientId: SYNC_CLIENT_ID,
      clientSecret: SYNC_CLIENT_SECRET,
    })

    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`Sync Worker Root ${Date.now()}`)).id

    // 'department' has an ENABLED attribute_target_mappings row for
    // 'keycloak' (remote_name = its own key, mirroring exactly what
    // migration 0014 does for a pre-existing `sync_to_keycloak = true`
    // row); 'internalNotes' has NO mapping row at all — default-deny by
    // absence, Milestone 10 Task 3's own structural guarantee. Shared by
    // every test that needs a real row here — there is no write path for
    // `attribute_definitions`/`attribute_target_mappings` yet (see
    // AttributeTargetMappingsRepository's own doc comment), so a direct
    // insert is the only way to seed one.
    await ctx.pool.query(`
      WITH inserted AS (
        INSERT INTO attribute_definitions (key, label, data_type, applies_to, is_active)
        VALUES ('department', 'Department', 'string', 'user', true),
               ('internalNotes', 'Internal Notes', 'string', 'user', true)
        RETURNING id, key
      )
      INSERT INTO attribute_target_mappings (attribute_definition_id, target, remote_name, enabled)
      SELECT id, 'keycloak', key, true FROM inserted WHERE key = 'department'
    `)

    cleanupWorker = makeWorker()
  })

  afterAll(async () => {
    await keycloak?.stop()
  })

  afterEach(async () => {
    // See this file's own doc comment for why this matters more here than
    // in a Postgres-only spec file. Uses the REAL, working client so
    // anything left mid-retry converges instead of dead-lettering here.
    await cleanupWorker.drain()
  })

  // -------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------
  let fixtureSeq = 0
  function nextTag(): string {
    fixtureSeq += 1
    return `${fixtureSeq}`
  }

  async function makeUser(attributes?: Record<string, unknown>): Promise<User> {
    const tag = nextTag()
    const username = `sw-user-${tag}@example.com`.toLowerCase()
    return usersRepo().create({
      primaryEmail: username,
      username,
      firstName: 'Sync',
      lastName: `Worker${tag}`,
      orgUnitId,
      attributes,
    })
  }

  async function makeGroup(label: string) {
    return groupsRepo().create({ name: `${label} ${nextTag()}` })
  }

  async function insertOutboxEvent(
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: Record<string, unknown>,
    nextAttemptAt?: Date,
    // Milestone 10, Task 1 — optional and trailing so every PRE-EXISTING
    // call site (all of them implicitly wanting the column default) needs
    // no change; only the multi-target ordering tests below pass one.
    target?: string,
  ): Promise<number> {
    const { rows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, next_attempt_at, target)
       VALUES ($1, $2, $3, $4, COALESCE($5, now()), COALESCE($6, 'keycloak')::outbox_target)
       RETURNING id`,
      [aggregateType, aggregateId, eventType, JSON.stringify(payload), nextAttemptAt ?? null, target ?? null],
    )
    return Number(rows[0]!.id)
  }

  async function outboxRow(id: number): Promise<OutboxRow> {
    const { rows } = await ctx.pool.query<OutboxRow>('SELECT * FROM outbox_events WHERE id = $1', [id])
    const row = rows[0]
    if (!row) throw new Error(`no outbox row ${id}`)
    return row
  }

  async function externalIdentityRow(userId: string): Promise<ExternalIdentityRow | null> {
    const { rows } = await ctx.pool.query<ExternalIdentityRow>(
      "SELECT * FROM external_identities WHERE user_id = $1 AND system = 'keycloak'",
      [userId],
    )
    return rows[0] ?? null
  }

  async function setNextAttemptAt(id: number, when: Date): Promise<void> {
    await ctx.pool.query('UPDATE outbox_events SET next_attempt_at = $1 WHERE id = $2', [when, id])
  }

  async function resetToPending(id: number): Promise<void> {
    await ctx.pool.query("UPDATE outbox_events SET status = 'pending' WHERE id = $1", [id])
  }

  /** The full observable Keycloak-side state for one user, for before/after equality checks. */
  async function captureKeycloakState(username: string) {
    return {
      user: await client.findUserByUsername(username),
      groups: await keycloak.getUserGroupNames(username),
      credentials: await client.listCredentials(username),
    }
  }

  // =====================================================================
  // Idempotence — the property the whole design rests on.
  // =====================================================================
  describe('idempotence', () => {
    it('applying the same event twice produces identical Keycloak state', async () => {
      const user = await makeUser({ department: 'Engineering', internalNotes: 'secret' })
      await usersRepo().changeStatus(user.id, 'active')
      const eventId = await insertOutboxEvent('user', user.id, 'created', {})

      const worker = makeWorker()

      expect(await worker.runOnce()).toBe('processed')
      expect((await outboxRow(eventId)).status).toBe('done')

      const first = await captureKeycloakState(user.username)
      expect(first.user?.enabled).toBe(true)
      expect(first.user?.attributes).toEqual({ department: ['Engineering'] })
      expect(first.credentials).toEqual([])

      const firstIdentity = await externalIdentityRow(user.id)
      expect(firstIdentity?.sync_state).toBe('synced')
      expect(firstIdentity?.external_id).toBe(first.user?.id)

      // Force reprocessing of the SAME event — never happens automatically
      // (a 'done' row is never reclaimed), so this simulates a replay.
      await resetToPending(eventId)
      expect(await worker.runOnce()).toBe('processed')
      expect((await outboxRow(eventId)).status).toBe('done')

      const second = await captureKeycloakState(user.username)
      expect(second).toEqual(first)

      const secondIdentity = await externalIdentityRow(user.id)
      expect(secondIdentity?.external_id).toBe(firstIdentity?.external_id)
      expect(secondIdentity?.sync_state).toBe('synced')
    })
  })

  // =====================================================================
  // Strict per-aggregate ordering — deliberately constructed.
  // =====================================================================
  describe('ordering', () => {
    it('never applies a newer event before an older pending one for the same aggregate', async () => {
      const user = await makeUser()
      const otherUser = await makeUser() // a DIFFERENT aggregate — proves the worker isn't just globally stalled

      // Event #1: older (lower id), but not yet due — simulates an event
      // still backing off from an earlier failure.
      const future = new Date(Date.now() + 60_000)
      const eventOne = await insertOutboxEvent('user', user.id, 'created', {}, future)
      // Event #2: newer (higher id), SAME aggregate, due right now.
      const eventTwo = await insertOutboxEvent('user', user.id, 'updated', {})
      // An unrelated aggregate's event, also due right now.
      const eventOther = await insertOutboxEvent('user', otherUser.id, 'created', {})

      const worker = makeWorker()

      // Only the unrelated aggregate is claimable: #2 is due but BLOCKED by
      // #1 (older, still pending) even though #1 itself isn't due yet.
      expect(await worker.runOnce()).toBe('processed')
      expect((await outboxRow(eventOther)).status).toBe('done')
      expect((await outboxRow(eventTwo)).status).toBe('pending')
      expect((await outboxRow(eventTwo)).attempts).toBe(0)
      expect((await outboxRow(eventOne)).status).toBe('pending')

      // Asking again and again must never reach past #1 to #2.
      expect(await worker.runOnce()).toBe('idle')
      expect(await worker.runOnce()).toBe('idle')
      expect((await outboxRow(eventTwo)).status).toBe('pending')

      // #1's backoff "elapses" — now IT, and only it, becomes claimable.
      await setNextAttemptAt(eventOne, new Date(Date.now() - 1_000))
      expect(await worker.runOnce()).toBe('processed')
      expect((await outboxRow(eventOne)).status).toBe('done')
      expect((await outboxRow(eventTwo)).status).toBe('pending') // still not yet — this call only did #1

      // NOW #2 is unblocked.
      expect(await worker.runOnce()).toBe('processed')
      expect((await outboxRow(eventTwo)).status).toBe('done')
    })
  })

  // =====================================================================
  // Multi-target ordering (Milestone 10, Task 1) — THE head-of-line fix,
  // proven end to end through the real claim-apply-finalize cycle
  // (`runOnce`), not just at the raw SQL level (see
  // outbox-multi-target.spec.ts for that lower-level, container-lighter
  // proof of the identical property).
  // =====================================================================
  describe('multi-target ordering (Milestone 10, Task 1)', () => {
    it('a stalled active_directory event for a user does not block a keycloak event for that SAME user', async () => {
      const user = await makeUser()

      // Older (lower id), STALLED: an active_directory delivery mid-backoff
      // for this user — not due for another minute, so it can never be
      // claimed itself, but (pre-fix) still silently blocked EVERY later
      // event for this aggregate regardless of which target it was for.
      const future = new Date(Date.now() + 60_000)
      const staleAdEvent = await insertOutboxEvent('user', user.id, 'updated', {}, future, 'active_directory')

      // Newer (higher id), due right now, a keycloak event for the SAME
      // user — the one that must still ship on time.
      const dueKeycloakEvent = await insertOutboxEvent('user', user.id, 'created', {}, undefined, 'keycloak')

      const worker = makeWorker()

      expect(await worker.runOnce()).toBe('processed')
      expect((await outboxRow(dueKeycloakEvent)).status).toBe('done')

      // Not just "the row flipped to done" — the user genuinely reached
      // Keycloak. This is the exact gap the design doc calls out: "the user
      // would look synced, be stale, and nothing would report it."
      const kcUser = await client.findUserByUsername(user.username)
      expect(kcUser).not.toBeNull()

      // The stalled AD event is untouched by the keycloak claim above —
      // still pending, still backing off, zero attempts. Its own eventual
      // delivery (once due) is a separate concern from this test.
      const adRow = await outboxRow(staleAdEvent)
      expect(adRow.status).toBe('pending')
      expect(adRow.attempts).toBe(0)

      // Nothing else is claimable right now — the AD event genuinely isn't
      // due yet, confirming the worker did not somehow also process it.
      expect(await worker.runOnce()).toBe('idle')
    })
  })

  // =====================================================================
  // Connector registry dispatch (Milestone 10, Task 2) — `event.target` now
  // genuinely SELECTS a connector via `ConnectorRegistry`, closing the gap
  // Task 1's own report flagged ("claimed non-Keycloak events would be
  // silently misprocessed as Keycloak ones"). Proven end to end through the
  // real claim-apply-finalize cycle, against the SAME real Keycloak
  // container this whole file already runs against: an echo-targeted event
  // reaches `EchoConnector` and — the actual isolation proof — never
  // touches Keycloak at all; enabling BOTH targets for one user fans out to
  // two INDEPENDENT, correctly-routed applications.
  // =====================================================================
  describe('connector registry dispatch (Milestone 10, Task 2)', () => {
    const ECHO_SECRET_NAME = 'SYNC_WORKER_ECHO_TEST_SECRET'

    async function enableEchoTarget(): Promise<void> {
      process.env[ECHO_SECRET_NAME] = 'echo-dispatch-test-secret'
      await ctx.pool.query(
        `INSERT INTO connector_targets (target, enabled, config) VALUES ('echo', true, $1)
         ON CONFLICT (target) DO UPDATE SET enabled = true, config = $1`,
        [JSON.stringify({ credentialSecretName: ECHO_SECRET_NAME })],
      )
    }

    async function disableEchoTarget(): Promise<void> {
      await ctx.pool.query(`DELETE FROM connector_targets WHERE target = 'echo'`)
      delete process.env[ECHO_SECRET_NAME]
    }

    it('an echo-targeted event reaches EchoConnector with the correct desired state and NEVER reaches the real Keycloak', async () => {
      await enableEchoTarget()
      try {
        const user = await makeUser({ department: 'Engineering', internalNotes: 'do not sync me' })
        await usersRepo().changeStatus(user.id, 'active')
        const eventId = await insertOutboxEvent('user', user.id, 'created', {}, undefined, 'echo')

        const echoConnector = new EchoConnector()
        const registry = new ConnectorRegistry(client, echoConnector)
        const worker = makeWorker(client, undefined, registry)

        expect(await worker.runOnce()).toBe('processed')
        expect((await outboxRow(eventId)).status).toBe('done')

        // Reached the ECHO connector, with exactly the desired state —
        // default-deny already applied, and applied PER TARGET (Milestone
        // 10, Task 3): `department` has an enabled mapping row for
        // 'keycloak' only (this file's own `beforeAll` seed) — attributes
        // is EMPTY here, not `{ department: [...] }`, because echo has no
        // mapping row for it at all. See
        // "default-deny per target (Milestone 10, Task 3)" below for the
        // dedicated proof that this is a REAL per-target gate, not
        // coincidental absence.
        const applyCall = echoConnector.calls.find((call) => call.method === 'apply')
        expect(applyCall?.desired).toEqual({
          username: user.username,
          email: user.primaryEmail,
          firstName: user.firstName,
          lastName: user.lastName,
          enabled: true,
          attributes: {},
          groups: [],
        })

        // Correlated under system='echo', with ECHO's own synthetic id —
        // never Keycloak's.
        const { rows } = await ctx.pool.query<{
          external_id: string
          system: string
          sync_state: string
        }>(
          "SELECT external_id, system, sync_state FROM external_identities WHERE user_id = $1 AND system = 'echo'",
          [user.id],
        )
        expect(rows).toHaveLength(1)
        expect(rows[0]?.external_id).toBe(applyCall?.externalId)
        expect(rows[0]?.external_id).toMatch(/^echo-/)
        expect(rows[0]?.sync_state).toBe('synced')

        // THE isolation proof: this user never reached the real Keycloak.
        expect(await client.findUserByUsername(user.username)).toBeNull()
      } finally {
        await disableEchoTarget()
      }
    })

    it('enabling BOTH keycloak and echo fans out one event per target, and each converges independently and correctly', async () => {
      await enableEchoTarget()
      try {
        const user = await makeUser()
        await usersRepo().changeStatus(user.id, 'active')

        const kcEventId = await insertOutboxEvent('user', user.id, 'created', {}, undefined, 'keycloak')
        const echoEventId = await insertOutboxEvent('user', user.id, 'created', {}, undefined, 'echo')

        const echoConnector = new EchoConnector()
        const registry = new ConnectorRegistry(client, echoConnector)
        const worker = makeWorker(client, undefined, registry)

        expect(await worker.drain()).toBe(2)
        expect((await outboxRow(kcEventId)).status).toBe('done')
        expect((await outboxRow(echoEventId)).status).toBe('done')

        // Keycloak side genuinely converged.
        expect(await client.findUserByUsername(user.username)).not.toBeNull()
        // Echo side genuinely converged, independently.
        expect(
          echoConnector.calls.some(
            (call) => call.method === 'apply' && call.desired?.username === user.username,
          ),
        ).toBe(true)

        const { rows } = await ctx.pool.query<{ system: string }>(
          'SELECT system FROM external_identities WHERE user_id = $1',
          [user.id],
        )
        // Sorted in JS, not SQL: `ORDER BY system` sorts by the Postgres
        // ENUM's declaration ordinal (keycloak, then ... then echo — see
        // outbox-events.ts's `outboxTarget`), not lexicographically — same
        // reasoning outbox-emission.spec.ts's own multi-target fan-out test
        // already documents for `target.sort()`.
        expect(rows.map((row) => row.system).sort()).toEqual(['echo', 'keycloak'])
      } finally {
        await disableEchoTarget()
      }
    })

    it('a target with no registered connector (google_workspace) dead-letters cleanly instead of silently reaching Keycloak', async () => {
      // No `connector_targets` row needed to CLAIM this event — inserted
      // directly, bypassing OutboxWriter's enabled-only fan-out, exactly
      // like outbox-multi-target.spec.ts already does for active_directory.
      // The point here is purely SyncWorker's OWN dispatch: does a claimed
      // event for a target with NO implementation ever silently reach
      // Keycloak instead? It must not — it must fail loudly and visibly.
      // `google_workspace` (not `active_directory`/`entra_id`, which
      // Milestones 11/12 gave a real connector each) is the still-
      // unimplemented target for this proof as of this milestone — see
      // connector-registry.spec.ts's own `it.each` for the equivalent,
      // target-agnostic version of this. Milestone 12, Task 7 moved this
      // test OFF `entra_id` for the identical reason Milestone 11, Task 5's
      // own report already documents doing for `active_directory`: true
      // before that task, false after.
      const user = await makeUser()
      const eventId = await insertOutboxEvent('user', user.id, 'created', {}, undefined, 'google_workspace')

      const worker = makeWorker(client, { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 20 })
      expect(await worker.runOnce()).toBe('processed')

      const row = await outboxRow(eventId)
      expect(row.status).toBe('failed')
      expect(row.last_error).toMatch(/no connector registered for target "google_workspace"/)

      // Never reached Keycloak — the exact failure mode Task 1's report
      // flagged as the risk of leaving dispatch unwired.
      expect(await client.findUserByUsername(user.username)).toBeNull()
    })
  })

  // =====================================================================
  // Default-deny per target (Milestone 10, Task 3) —
  // `attribute_target_mappings` replaces the single, target-uniform
  // `sync_to_keycloak` boolean. THE non-negotiable this whole block re-
  // proves: "for every target, an attribute (custom OR core) with no
  // mapping row must not leave the system" — asserted against what EACH
  // target actually received via the REAL send path (`SyncWorker.runOnce`
  // -> `ConnectorRegistry` -> `EchoConnector`/a real Keycloak container),
  // never against `buildTargetAttributes` called in isolation (see
  // attribute-mapping.spec.ts for that separate, purely-algorithmic proof,
  // which by itself CANNOT show the filter is actually wired into the send
  // path — precisely the "vacuous test" failure class this project has
  // already shipped three times).
  //
  // 'department' (this file's own `beforeAll` seed) has an enabled mapping
  // to 'keycloak' only; 'internalNotes' has no mapping row at all. Both are
  // reused below alongside fixtures created per-test.
  // =====================================================================
  describe('default-deny per target (Milestone 10, Task 3)', () => {
    const ECHO_SECRET_NAME = 'SYNC_WORKER_DEFAULT_DENY_ECHO_SECRET'

    async function enableEchoTarget(): Promise<void> {
      process.env[ECHO_SECRET_NAME] = 'default-deny-test-secret'
      await ctx.pool.query(
        `INSERT INTO connector_targets (target, enabled, config) VALUES ('echo', true, $1)
         ON CONFLICT (target) DO UPDATE SET enabled = true, config = $1`,
        [JSON.stringify({ credentialSecretName: ECHO_SECRET_NAME })],
      )
    }

    async function disableEchoTarget(): Promise<void> {
      await ctx.pool.query(`DELETE FROM connector_targets WHERE target = 'echo'`)
      delete process.env[ECHO_SECRET_NAME]
    }

    /** A fresh, uniquely-keyed custom attribute definition — never collides with 'department'/'internalNotes' or another test's own fixture. */
    async function makeCustomAttributeDefinition(): Promise<{ id: string; key: string }> {
      const key = `dd_custom_${nextTag()}`
      const { rows } = await ctx.pool.query<{ id: string }>(
        `INSERT INTO attribute_definitions (key, label, data_type, applies_to, is_active)
         VALUES ($1, $1, 'string', 'user', true) RETURNING id`,
        [key],
      )
      return { id: rows[0]!.id, key }
    }

    /** Upserts one custom-attribute mapping row — the ONLY way to configure one in this milestone (no write endpoint yet; mirrors how connector_targets rows are seeded directly in outbox-multi-target.spec.ts). */
    async function mapAttribute(
      attributeDefinitionId: string,
      target: string,
      remoteName: string,
      enabled = true,
    ): Promise<void> {
      await ctx.pool.query(
        `INSERT INTO attribute_target_mappings (attribute_definition_id, target, remote_name, enabled)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (attribute_definition_id, target) WHERE attribute_definition_id IS NOT NULL
         DO UPDATE SET remote_name = $3, enabled = $4`,
        [attributeDefinitionId, target, remoteName, enabled],
      )
    }

    /** Same as `mapAttribute`, for a CORE field row instead of a custom-attribute one. */
    async function mapCoreField(
      coreField: string,
      target: string,
      remoteName: string,
      enabled = true,
    ): Promise<void> {
      await ctx.pool.query(
        `INSERT INTO attribute_target_mappings (core_field, target, remote_name, enabled)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (core_field, target) WHERE core_field IS NOT NULL
         DO UPDATE SET remote_name = $3, enabled = $4`,
        [coreField, target, remoteName, enabled],
      )
    }

    async function deleteAttributeMappings(attributeDefinitionId: string): Promise<void> {
      await ctx.pool.query(`DELETE FROM attribute_target_mappings WHERE attribute_definition_id = $1`, [
        attributeDefinitionId,
      ])
    }

    async function deleteCoreFieldMappings(coreField: string): Promise<void> {
      await ctx.pool.query(`DELETE FROM attribute_target_mappings WHERE core_field = $1`, [coreField])
    }

    it('a custom attribute mapped to echo ONLY reaches echo under its remote name, and never reaches keycloak', async () => {
      await enableEchoTarget()
      const def = await makeCustomAttributeDefinition()
      await mapAttribute(def.id, 'echo', 'echoRemoteName')
      try {
        const user = await makeUser({ [def.key]: 'echo-only-value' })
        await usersRepo().changeStatus(user.id, 'active')

        const echoConnector = new EchoConnector()
        const registry = new ConnectorRegistry(client, echoConnector)
        const worker = makeWorker(client, undefined, registry)

        await insertOutboxEvent('user', user.id, 'created', {}, undefined, 'echo')
        await insertOutboxEvent('user', user.id, 'created', {}, undefined, 'keycloak')
        expect(await worker.drain()).toBe(2)

        const applyCall = echoConnector.calls.find((call) => call.method === 'apply')
        expect(applyCall?.desired?.attributes).toEqual({ echoRemoteName: ['echo-only-value'] })

        // The SAME attribute has NO mapping row for 'keycloak' — it must
        // not reach Keycloak under either its local key or its echo remote
        // name.
        const kcUser = await client.findUserByUsername(user.username)
        expect(kcUser?.attributes[def.key]).toBeUndefined()
        expect(kcUser?.attributes.echoRemoteName).toBeUndefined()
      } finally {
        await deleteAttributeMappings(def.id)
        await disableEchoTarget()
      }
    })

    it('an attribute mapped to keycloak does not automatically reach echo — each target is gated independently', async () => {
      // 'department' (this file's own beforeAll seed) is mapped to
      // 'keycloak' only, never 'echo'.
      await enableEchoTarget()
      try {
        const user = await makeUser({ department: 'Engineering' })
        await usersRepo().changeStatus(user.id, 'active')

        const echoConnector = new EchoConnector()
        const registry = new ConnectorRegistry(client, echoConnector)
        const worker = makeWorker(client, undefined, registry)

        await insertOutboxEvent('user', user.id, 'created', {}, undefined, 'echo')
        expect(await worker.drain()).toBe(1)

        const applyCall = echoConnector.calls.find((call) => call.method === 'apply')
        expect(applyCall?.desired?.attributes).toEqual({})
        expect(applyCall?.desired?.attributes.department).toBeUndefined()
      } finally {
        await disableEchoTarget()
      }
    })

    it('an attribute with NO mapping row for ANY target reaches neither echo nor keycloak', async () => {
      // 'internalNotes' (this file's own beforeAll seed) has no mapping row
      // at all, for any target.
      await enableEchoTarget()
      try {
        const user = await makeUser({ internalNotes: 'must never propagate anywhere' })
        await usersRepo().changeStatus(user.id, 'active')

        const echoConnector = new EchoConnector()
        const registry = new ConnectorRegistry(client, echoConnector)
        const worker = makeWorker(client, undefined, registry)

        await insertOutboxEvent('user', user.id, 'created', {}, undefined, 'echo')
        await insertOutboxEvent('user', user.id, 'created', {}, undefined, 'keycloak')
        expect(await worker.drain()).toBe(2)

        const applyCall = echoConnector.calls.find((call) => call.method === 'apply')
        expect(applyCall?.desired?.attributes.internalNotes).toBeUndefined()
        expect(applyCall?.desired?.attributes).toEqual({})

        const kcUser = await client.findUserByUsername(user.username)
        expect(kcUser?.attributes.internalNotes).toBeUndefined()
      } finally {
        await disableEchoTarget()
      }
    })

    it('a mapping DISABLED after being enabled stops propagating, without deleting the row', async () => {
      await enableEchoTarget()
      const def = await makeCustomAttributeDefinition()
      await mapAttribute(def.id, 'echo', 'toggle')
      try {
        const user = await makeUser({ [def.key]: 'toggle-value' })
        await usersRepo().changeStatus(user.id, 'active')

        const echoConnector = new EchoConnector()
        const registry = new ConnectorRegistry(client, echoConnector)
        const worker = makeWorker(client, undefined, registry)

        await insertOutboxEvent('user', user.id, 'created', {}, undefined, 'echo')
        expect(await worker.runOnce()).toBe('processed')
        expect(echoConnector.calls.find((call) => call.method === 'apply')?.desired?.attributes).toEqual(
          { toggle: ['toggle-value'] },
        )

        // Disable — the row is UPDATED, not deleted.
        await mapAttribute(def.id, 'echo', 'toggle', false)

        await insertOutboxEvent('user', user.id, 'updated', {}, undefined, 'echo')
        expect(await worker.runOnce()).toBe('processed')
        const secondApply = echoConnector.calls.filter((call) => call.method === 'apply').at(-1)
        expect(secondApply?.desired?.attributes).toEqual({})

        const { rows } = await ctx.pool.query<{ enabled: boolean }>(
          `SELECT enabled FROM attribute_target_mappings WHERE attribute_definition_id = $1 AND target = 'echo'`,
          [def.id],
        )
        expect(rows).toHaveLength(1) // still exists — disabled, not removed
        expect(rows[0]?.enabled).toBe(false)
      } finally {
        await deleteAttributeMappings(def.id)
        await disableEchoTarget()
      }
    })

    it('core fields (title, department-from-org-path) map per target: a mapped one reaches echo under its remote name; an unmapped one reaches neither target', async () => {
      await enableEchoTarget()
      await mapCoreField('title', 'echo', 'jobTitleForEcho')
      // Deliberately do NOT map the 'department' CORE field anywhere — the
      // custom attribute of the same name (seeded in beforeAll) is a
      // DIFFERENT row and must not be confused with it (see attribute-
      // mapping.spec.ts's own "share the same LOCAL key without colliding"
      // test for the pure-function half of this proof).
      try {
        const orgUnit = await new OrgUnitsRepository(ctx.db).createRoot(`Core Field Dept ${nextTag()}`)
        const tag = nextTag()
        const username = `core-field-${tag}@example.com`.toLowerCase()
        const user = await usersRepo().create({
          primaryEmail: username,
          username,
          firstName: 'Core',
          lastName: 'Field',
          orgUnitId: orgUnit.id,
          jobTitle: 'Staff Engineer',
        })
        await usersRepo().changeStatus(user.id, 'active')

        const echoConnector = new EchoConnector()
        const registry = new ConnectorRegistry(client, echoConnector)
        const worker = makeWorker(client, undefined, registry)

        await insertOutboxEvent('user', user.id, 'created', {}, undefined, 'echo')
        await insertOutboxEvent('user', user.id, 'created', {}, undefined, 'keycloak')
        expect(await worker.drain()).toBe(2)

        const applyCall = echoConnector.calls.find((call) => call.method === 'apply')
        expect(applyCall?.desired?.attributes).toEqual({ jobTitleForEcho: ['Staff Engineer'] })
        expect(applyCall?.desired?.attributes.department).toBeUndefined()

        // No core-field mapping exists for 'keycloak' AT ALL (by design —
        // see db/schema/attribute-target-mappings.ts's own doc comment):
        // title and department never appear in Keycloak's attributes bag
        // either, under ANY name.
        const kcUser = await client.findUserByUsername(user.username)
        expect(kcUser?.attributes.jobTitleForEcho).toBeUndefined()
        expect(kcUser?.attributes.title).toBeUndefined()
        expect(kcUser?.attributes.department).toBeUndefined()
      } finally {
        await deleteCoreFieldMappings('title')
        await disableEchoTarget()
      }
    })
  })

  // =====================================================================
  // Concurrency — two workers racing one backlog.
  // =====================================================================
  describe('concurrency', () => {
    it('two workers racing the same backlog process each event exactly once', async () => {
      const workerA = makeWorker()
      const workerB = makeWorker()

      const soloUsers = await Promise.all(Array.from({ length: 6 }, () => makeUser()))
      const soloEventIds = await Promise.all(
        soloUsers.map((user) => insertOutboxEvent('user', user.id, 'created', {})),
      )

      // One aggregate with THREE sequential events, so the race also
      // exercises ordering, not just "no double-processing".
      const sequencedUser = await makeUser()
      const seqEvent1 = await insertOutboxEvent('user', sequencedUser.id, 'created', {})
      const seqEvent2 = await insertOutboxEvent('user', sequencedUser.id, 'updated', {})
      const seqEvent3 = await insertOutboxEvent('user', sequencedUser.id, 'updated', {})

      const [countA, countB] = await Promise.all([workerA.drain(), workerB.drain()])
      expect(countA + countB).toBe(9)

      for (const id of [...soloEventIds, seqEvent1, seqEvent2, seqEvent3]) {
        const row = await outboxRow(id)
        expect(row.status).toBe('done')
        // The "exactly once" proof: a double-claim would have collided with
        // itself on Keycloak's own username uniqueness (a second concurrent
        // createUser for the same user 409s), which this worker would have
        // caught and turned into a retry — bumping attempts above zero. Zero
        // attempts across every event means no collision ever happened.
        expect(row.attempts).toBe(0)
      }

      for (const user of [...soloUsers, sequencedUser]) {
        const state = await client.findUserByUsername(user.username)
        expect(state).not.toBeNull()
      }
    })
  })

  // =====================================================================
  // Resilience — Keycloak unreachable, then recovers.
  // =====================================================================
  describe('resilience', () => {
    it('stays pending with attempts/nextAttemptAt advancing while unreachable, then drains once Keycloak returns', async () => {
      const user = await makeUser()
      const eventId = await insertOutboxEvent('user', user.id, 'created', {})

      const badWorker = makeWorker(unreachableClient(), { maxAttempts: 10, baseDelayMs: 300, maxDelayMs: 600 })

      expect(await badWorker.runOnce()).toBe('processed') // claimed + attempted, not necessarily succeeded
      const afterFirst = await outboxRow(eventId)
      expect(afterFirst.status).toBe('pending')
      expect(afterFirst.attempts).toBe(1)
      expect(afterFirst.last_error).toBeTruthy()
      expect(new Date(afterFirst.next_attempt_at).getTime()).toBeGreaterThan(Date.now())

      // The backoff window has not elapsed — retrying immediately is a no-op.
      expect(await badWorker.runOnce()).toBe('idle')

      await sleep(350)
      expect(await badWorker.runOnce()).toBe('processed')
      const afterSecond = await outboxRow(eventId)
      expect(afterSecond.status).toBe('pending')
      expect(afterSecond.attempts).toBe(2)
      expect(new Date(afterSecond.next_attempt_at).getTime()).toBeGreaterThan(
        new Date(afterFirst.next_attempt_at).getTime(),
      )

      // Keycloak "returns": a worker with a WORKING client drains the same
      // row once it is due.
      await setNextAttemptAt(eventId, new Date(Date.now() - 1_000))
      const goodWorker = makeWorker()
      expect(await goodWorker.runOnce()).toBe('processed')
      expect((await outboxRow(eventId)).status).toBe('done')

      expect(await client.findUserByUsername(user.username)).not.toBeNull()
    })
  })

  // =====================================================================
  // Dead-lettering — the attempt cap, and visibility after it.
  // =====================================================================
  describe('dead-lettering', () => {
    it('exceeding the attempt cap marks the event failed with lastError populated, and it stays queryable', async () => {
      const user = await makeUser()
      const eventId = await insertOutboxEvent('user', user.id, 'created', {})
      const worker = makeWorker(unreachableClient(), { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 20 })

      for (let i = 0; i < 3; i++) {
        expect(await worker.runOnce()).toBe('processed')
        const row = await outboxRow(eventId)
        if (row.status === 'pending') {
          await setNextAttemptAt(eventId, new Date(Date.now() - 1_000))
        }
      }

      const final = await outboxRow(eventId)
      expect(final.status).toBe('failed')
      expect(final.attempts).toBe(3)
      expect(final.last_error).toBeTruthy()

      // Still queryable — a dead letter is visible, never silently dropped.
      const { rows } = await ctx.pool.query("SELECT id FROM outbox_events WHERE id = $1 AND status = 'failed'", [
        eventId,
      ])
      expect(rows).toHaveLength(1)

      // Never synced even once, so there is no external_identities row at
      // all — externalId is NOT NULL and there is nothing real to put there
      // (see SyncWorker.markUserSyncFailed's doc comment).
      expect(await externalIdentityRow(user.id)).toBeNull()
    })

    it('regresses an ALREADY-synced user to failed while preserving the last known-good externalId', async () => {
      const user = await makeUser()
      const firstEventId = await insertOutboxEvent('user', user.id, 'created', {})
      expect(await makeWorker().runOnce()).toBe('processed')
      expect((await outboxRow(firstEventId)).status).toBe('done')

      const synced = await externalIdentityRow(user.id)
      expect(synced?.sync_state).toBe('synced')
      const knownGoodExternalId = synced?.external_id

      const secondEventId = await insertOutboxEvent('user', user.id, 'updated', {})
      const badWorker = makeWorker(unreachableClient(), { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 20 })

      for (let i = 0; i < 2; i++) {
        await badWorker.runOnce()
        const row = await outboxRow(secondEventId)
        if (row.status === 'pending') {
          await setNextAttemptAt(secondEventId, new Date(Date.now() - 1_000))
        }
      }

      expect((await outboxRow(secondEventId)).status).toBe('failed')

      const regressed = await externalIdentityRow(user.id)
      expect(regressed?.sync_state).toBe('failed')
      expect(regressed?.external_id).toBe(knownGoodExternalId) // last known-good value, untouched
    })
  })

  // =====================================================================
  // User creation — no credential, default-deny attributes, enabled mapping.
  // =====================================================================
  describe('user creation', () => {
    it('a created user reaches Keycloak with no credential and only sync_to_keycloak attributes', async () => {
      const user = await makeUser({ department: 'Engineering', internalNotes: 'do not sync me' })
      await usersRepo().changeStatus(user.id, 'active')
      const eventId = await insertOutboxEvent('user', user.id, 'created', {})

      expect(await makeWorker().runOnce()).toBe('processed')
      expect((await outboxRow(eventId)).status).toBe('done')

      const kcUser = await client.findUserByUsername(user.username)
      expect(kcUser).not.toBeNull()
      expect(kcUser?.enabled).toBe(true)
      expect(kcUser?.attributes).toEqual({ department: ['Engineering'] })

      expect(await client.listCredentials(user.username)).toEqual([])
    })

    it('a pending (not-yet-active) user is created disabled in Keycloak', async () => {
      const user = await makeUser() // default status: 'pending'
      const eventId = await insertOutboxEvent('user', user.id, 'created', {})

      expect(await makeWorker().runOnce()).toBe('processed')
      expect((await outboxRow(eventId)).status).toBe('done')

      const kcUser = await client.findUserByUsername(user.username)
      expect(kcUser?.enabled).toBe(false)
    })
  })

  // =====================================================================
  // Group membership propagation (bonus coverage beyond the enumerated
  // list): flattened effective membership, and reacting to a bare
  // membership_changed event with no accompanying user event.
  // =====================================================================
  describe('group membership propagation', () => {
    it('pushes flattened effective membership and reacts to membership_changed events', async () => {
      const parent = await makeGroup('Parent')
      const child = await makeGroup('Child')
      await groupsRepo().addChildGroup(parent.id, child.id)

      const directUser = await makeUser()
      const nestedUser = await makeUser()

      // Mirrors GroupsController's own emission shape (see
      // groups.controller.ts's addMember handler) — constructed directly
      // here since this task's file scope does not include the controller.
      await groupsRepo().addUser(parent.id, directUser.id)
      const addDirectEvent = await insertOutboxEvent('membership', parent.id, 'membership_changed', {
        groupId: parent.id,
        userId: directUser.id,
      })

      await groupsRepo().addUser(child.id, nestedUser.id)
      const addNestedEvent = await insertOutboxEvent('membership', child.id, 'membership_changed', {
        groupId: child.id,
        userId: nestedUser.id,
      })

      const worker = makeWorker()
      expect(await worker.drain()).toBe(2)
      expect((await outboxRow(addDirectEvent)).status).toBe('done')
      expect((await outboxRow(addNestedEvent)).status).toBe('done')

      expect(await keycloak.getUserGroupNames(directUser.username)).toContain(parent.name)

      // Flattened: a member of the CHILD group is pushed into the child AND
      // every ancestor (the parent) — settled decision, see
      // SyncWorker.syncEffectiveGroups' doc comment.
      const nestedGroups = await keycloak.getUserGroupNames(nestedUser.username)
      expect(nestedGroups).toEqual(expect.arrayContaining([child.name, parent.name]))

      // Removal: the affected user is identified via payload.userId, which
      // stays discoverable even though the edge itself is now gone (see
      // SyncWorker.reconcileMembership's doc comment on why this differs
      // from the child-group case above).
      await groupsRepo().removeUser(parent.id, directUser.id)
      const removeDirectEvent = await insertOutboxEvent('membership', parent.id, 'membership_changed', {
        groupId: parent.id,
        userId: directUser.id,
      })
      expect(await worker.runOnce()).toBe('processed')
      expect((await outboxRow(removeDirectEvent)).status).toBe('done')
      expect(await keycloak.getUserGroupNames(directUser.username)).not.toContain(parent.name)
    })
  })

  // =====================================================================
  // Cross-aggregate races on the SAME user (finding H2, docs/superpowers/
  // audit-integrity.md): `OutboxRepository.claimNext` enforces strict
  // ordering only per `(aggregate_type, aggregate_id)`. A `user` event and a
  // `membership` event for the SAME user are two DIFFERENT aggregates, so
  // `claimNext` happily hands them to two workers in parallel — but both
  // fan into `reconcileUser` for the same entity. Pre-fix, whichever worker
  // called `setUserGroups` LAST won regardless of who read fresher data;
  // reproduced 20/20 in both directions by the auditor. The fix takes a
  // per-user `pg_advisory_xact_lock` as the very first thing `reconcileUser`
  // does (see its own doc comment), so these tests double as a lock
  // regression AND as the proof that `syncEffectiveGroups`'s reads (already
  // on `tx`, not the pool, since the C1 fix) are re-taken AFTER the lock,
  // not reused stale from before it.
  // =====================================================================
  describe('cross-aggregate races on the same user (finding H2)', () => {
    /** Creates an active user, seeds their DIRECT membership, and drains one 'created' event to converge Postgres and Keycloak before the race begins. */
    async function setupConvergedUser(groups: Awaited<ReturnType<typeof makeGroup>>[]): Promise<User> {
      const user = await makeUser()
      await usersRepo().changeStatus(user.id, 'active')
      for (const group of groups) {
        await groupsRepo().addUser(group.id, user.id)
      }
      await insertOutboxEvent('user', user.id, 'created', {})
      const processed = await makeWorker(client).drain()
      expect(processed).toBeGreaterThan(0)
      return user
    }

    it(
      'ADD direction: a stale worker must never silently drop a group an admin just added (20/20)',
      async () => {
        for (let i = 0; i < 20; i++) {
          const g1 = await makeGroup('H2 Add G1')
          const g2 = await makeGroup('H2 Add G2')
          const user = await setupConvergedUser([g1])

          const gated = new GatedKeycloakAdminClient({
            issuer: keycloak.issuer,
            clientId: SYNC_CLIENT_ID,
            clientSecret: SYNC_CLIENT_SECRET,
          })
          const workerSlow = makeWorker(gated)
          const workerFast = makeWorker(client)

          gated.arm()
          // Worker A: an unrelated 'user' event forces a full reconcile,
          // whose group read (still {g1} — the admin hasn't acted yet) is
          // what goes stale.
          const updateEventId = await insertOutboxEvent('user', user.id, 'updated', {})
          const slowPromise = workerSlow.runOnce()
          await gated.reached // A has read {g1} and is paused before its first group-related Keycloak call

          // The admin adds g2 WHILE A is mid-flight.
          await groupsRepo().addUser(g2.id, user.id)
          const membershipEventId = await insertOutboxEvent('membership', g2.id, 'membership_changed', {
            groupId: g2.id,
            userId: user.id,
          })
          // Worker B: claims the resulting membership event. Pre-fix, races
          // A freely. Post-fix, blocks on the per-user lock A already holds
          // until A's whole transaction commits.
          const fastPromise = workerFast.runOnce()

          gated.release()
          await slowPromise
          await fastPromise

          expect((await outboxRow(updateEventId)).status).toBe('done')
          expect((await outboxRow(membershipEventId)).status).toBe('done')

          // The headline regression assertion: Postgres and Keycloak must
          // agree. Pre-fix this was 20/20 postgres={g1,g2} keycloak={g1} —
          // A's stale write, landing last, silently dropped the add.
          const kcGroups = new Set(await keycloak.getUserGroupNames(user.username))
          expect(kcGroups).toEqual(new Set([g1.name, g2.name]))
        }
      },
      120_000,
    )

    it(
      'REMOVE direction: a stale worker must never silently restore a group an admin just removed (20/20)',
      async () => {
        for (let i = 0; i < 20; i++) {
          const g1 = await makeGroup('H2 Remove G1')
          const g2 = await makeGroup('H2 Remove G2')
          const user = await setupConvergedUser([g1, g2])

          const gated = new GatedKeycloakAdminClient({
            issuer: keycloak.issuer,
            clientId: SYNC_CLIENT_ID,
            clientSecret: SYNC_CLIENT_SECRET,
          })
          const workerSlow = makeWorker(gated)
          const workerFast = makeWorker(client)

          gated.arm()
          const updateEventId = await insertOutboxEvent('user', user.id, 'updated', {})
          const slowPromise = workerSlow.runOnce()
          await gated.reached // A has read {g1,g2} and is paused before its first group-related Keycloak call

          // The admin removes g2 WHILE A is mid-flight — the
          // security-relevant direction: access must actually be revoked.
          await groupsRepo().removeUser(g2.id, user.id)
          const membershipEventId = await insertOutboxEvent('membership', g2.id, 'membership_changed', {
            groupId: g2.id,
            userId: user.id,
          })
          const fastPromise = workerFast.runOnce()

          gated.release()
          await slowPromise
          await fastPromise

          expect((await outboxRow(updateEventId)).status).toBe('done')
          expect((await outboxRow(membershipEventId)).status).toBe('done')

          // Pre-fix this was 20/20 postgres={g1} keycloak={g1,g2} — the
          // admin's removal was applied, then a stale concurrent worker put
          // it back. Every outbox event still ends 'done' either way, which
          // is exactly what makes this the worst kind of divergence: nothing
          // about the bookkeeping looks wrong.
          const kcGroups = new Set(await keycloak.getUserGroupNames(user.username))
          expect(kcGroups).toEqual(new Set([g1.name]))
        }
      },
      120_000,
    )
  })

  // =====================================================================
  // start()/stop() — explicitly startable/stoppable, per the contract.
  // =====================================================================
  describe('start/stop lifecycle', () => {
    it('processes events while started and genuinely stops once stopped', async () => {
      const user = await makeUser()
      const eventId = await insertOutboxEvent('user', user.id, 'created', {})

      const worker = makeWorker(client, { pollIntervalMs: 20 })

      worker.start()
      const deadline = Date.now() + 10_000
      while ((await outboxRow(eventId)).status === 'pending' && Date.now() < deadline) {
        await sleep(25)
      }
      await worker.stop()
      expect((await outboxRow(eventId)).status).toBe('done')

      const secondUser = await makeUser()
      const secondEventId = await insertOutboxEvent('user', secondUser.id, 'created', {})
      // Long enough for several poll intervals, if the worker were still running.
      await sleep(150)
      expect((await outboxRow(secondEventId)).status).toBe('pending')

      // Starting again picks the second event back up — proves stop() was a
      // genuine pause, not a one-shot/permanent shutdown.
      worker.start()
      const deadline2 = Date.now() + 10_000
      while ((await outboxRow(secondEventId)).status === 'pending' && Date.now() < deadline2) {
        await sleep(25)
      }
      await worker.stop()
      expect((await outboxRow(secondEventId)).status).toBe('done')
    })
  })
})
