import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import { ConnectorRegistry } from '../src/connectors/connector-registry'
import type { DesiredUser } from '../src/connectors/connector'
import {
  computeThrottleWaitMs,
  deriveGroupEmail,
  generateBootstrapPassword,
  GoogleAdminThrottledError,
  type GoogleWorkspaceConnectorConfig,
  GoogleWorkspaceConnector,
} from '../src/connectors/google-workspace.connector'
import { GroupsRepository } from '../src/groups/groups.repository'
import { KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OutboxRepository } from '../src/outbox/outbox.repository'
import { SyncWorker } from '../src/outbox/sync.worker'
import { TargetReconciliationJob } from '../src/outbox/target-reconciliation.job'
import { type User, UsersRepository } from '../src/users/users.repository'
import { type GoogleAdminFake, startGoogleAdminFake } from './support/google-admin-fake'
import { withTestDatabase } from './support/pg'

function unreachableKeycloak(): KeycloakAdminClient {
  return new KeycloakAdminClient({
    issuer: 'http://127.0.0.1:1/realms/unreachable',
    clientId: 'irrelevant',
    clientSecret: 'irrelevant',
  })
}

/** Same shape/reasoning as connector-secrets.spec.ts's own `assertNoLeak` — re-derived locally per this project's own established convention (see e.g. entra-id.connector.spec.ts's own identical re-derivation). */
function assertNoLeak(haystack: string, sentinel: string, where: string): void {
  if (haystack.includes(sentinel)) {
    throw new Error(`SECRET LEAK in ${where}: sentinel value found — "${haystack}"`)
  }
}

/**
 * MILESTONE 13, TASK 8 — the Google Workspace adapter, against
 * `test/support/google-admin-fake.ts`, a REAL local `node:http` server. Per
 * the design doc's own "Testing" section, this is the accepted, documented
 * exception for a target with no available container: "the fake's weakness
 * is honest: it proves our request shapes and our state machine, and cannot
 * prove the vendor behaves as recorded." Every response shape the fake
 * returns is pinned to Google's OWN published Admin SDK documentation
 * (linked at each handler in that file), never invented — but this suite
 * proves `GoogleWorkspaceConnector`'s OWN behaviour against those documented
 * shapes, NOT that a real Workspace tenant actually behaves this way. See
 * this task's report for the full, honest accounting of what is and is not
 * proven.
 *
 * Most tests below construct `GoogleWorkspaceConnector` DIRECTLY (never
 * through Postgres/SyncWorker) — the fastest, most precise way to prove the
 * CONNECTOR's own contract, mirroring `entra-id.connector.spec.ts`'s
 * identical structural choice (this task's own explicit structural model).
 * The "default-deny" and "per-principal isolation" blocks deliberately go
 * through the REAL `SyncWorker`/`TargetReconciliationJob` pipeline instead,
 * because what they prove is a property of THAT pipeline reaching this
 * connector correctly, not the connector in isolation.
 */
describe('GoogleWorkspaceConnector (Milestone 13, Task 8)', () => {
  const ctx = withTestDatabase()
  const SECRET_NAME = 'GOOGLE_WORKSPACE_CONNECTOR_TEST_SECRET'
  let fake: GoogleAdminFake

  beforeAll(async () => {
    fake = await startGoogleAdminFake()
    process.env[SECRET_NAME] = fake.serviceAccountKeyJson
  })

  afterAll(async () => {
    delete process.env[SECRET_NAME]
    await fake.stop()
  })

  afterEach(() => {
    // Belt-and-braces: a test that throws partway through `interrupt()`
    // (never happens today — every interrupting test wraps its own
    // try/finally — but cheap insurance against a future one that forgets).
    fake.restore()
  })

  // -----------------------------------------------------------------------
  // Shared fixtures
  // -----------------------------------------------------------------------

  function baseConfig(overrides: Partial<GoogleWorkspaceConnectorConfig> = {}): Record<string, unknown> {
    return {
      impersonatedAdminEmail: fake.impersonatedAdminEmail,
      domain: fake.domain,
      credentialSecretName: SECRET_NAME,
      adminBaseUrl: fake.adminBaseUrl,
      tokenUrl: fake.tokenUrl,
      maxThrottleRetries: 3,
      maxThrottleWaitMs: 10_000,
      requestTimeoutMs: 10_000,
      ...overrides,
    }
  }

  function makeConnector(overrides: Partial<GoogleWorkspaceConnectorConfig> = {}): GoogleWorkspaceConnector {
    const connector = new GoogleWorkspaceConnector()
    connector.configure(baseConfig(overrides))
    return connector
  }

  let usernameSeq = 0
  function nextUsername(): string {
    usernameSeq += 1
    return `gu${usernameSeq}-${randomUUID().slice(0, 8)}@example.com`
  }

  function baseDesired(overrides: Partial<DesiredUser> = {}): DesiredUser {
    const username = nextUsername()
    return {
      username,
      email: username,
      firstName: 'Test',
      lastName: 'User',
      enabled: false,
      attributes: {},
      groups: [],
      ...overrides,
    }
  }

  function adminRequestsSince(index: number) {
    return fake.requests.slice(index).filter((r) => r.path.startsWith('/admin/directory/v1/'))
  }

  // =========================================================================
  // Create, then read back from the fake
  // =========================================================================
  describe('create, then read back from the fake', () => {
    it('creates a suspended (disabled) user — every profile field lands correctly, correlation id is the Google-issued id, no password is ever stored or returned', async () => {
      const connector = makeConnector()
      const desired = baseDesired({ enabled: false })

      const { externalId } = await connector.apply(desired)
      expect(externalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

      const stored = fake.users.get(externalId)
      expect(stored).toBeDefined()
      expect(stored!.suspended).toBe(true)
      expect(stored!.primaryEmail).toBe(desired.username)
      expect(stored!.name).toEqual({ givenName: desired.firstName, familyName: desired.lastName })
      expect(stored!.changePasswordAtNextLogin).toBe(true)
      // Google's own "Create user" doc: "the password value is never
      // returned in the API's response body" — the fake reproduces that;
      // this is the direct, structural half of the "never retained" proof
      // (the DYNAMIC, sentinel-value half lives in the secret-leak block
      // below).
      expect(stored).not.toHaveProperty('password')
    })

    it('creates an ENABLED (not suspended) user directly, in one operation', async () => {
      const connector = makeConnector()
      const desired = baseDesired({ enabled: true })
      const { externalId } = await connector.apply(desired)
      expect(fake.users.get(externalId)!.suspended).toBe(false)
    })

    it('places a mapped custom attribute, taking only the FIRST value of a multi-value array', async () => {
      const connector = makeConnector()
      const desired = baseDesired({ attributes: { employeeType: ['Contractor', 'ShouldBeDropped'] } })
      const { externalId } = await connector.apply(desired)
      expect(fake.users.get(externalId)!.employeeType).toBe('Contractor')
    })
  })

  // =========================================================================
  // Update — reconcile to desired state, idempotently
  // =========================================================================
  describe('update — reconciles to desired state, idempotently', () => {
    it('a second apply with changed fields updates in place via PUT; a third, unchanged apply sends NO update (plan() agrees it is a no-op)', async () => {
      const connector = makeConnector()
      let desired = baseDesired({ attributes: { title: ['Engineer'] } })
      const { externalId: id1 } = await connector.apply(desired)

      desired = { ...desired, firstName: 'Changed', lastName: 'Surname', attributes: { title: ['Staff Engineer'] } }
      const { externalId: id2 } = await connector.apply(desired)
      expect(id2).toBe(id1) // same Google object, not a duplicate

      const stored = fake.users.get(id1)!
      expect(stored.name).toEqual({ givenName: 'Changed', familyName: 'Surname' })
      expect(stored.title).toBe('Staff Engineer')

      expect(await connector.plan(desired)).toEqual([])

      const before = fake.requests.length
      const { externalId: id3 } = await connector.apply(desired)
      expect(id3).toBe(id1)
      const putsSent = adminRequestsSince(before).filter((r) => r.method === 'PUT')
      expect(putsSent).toEqual([]) // genuinely a no-op, not merely "no visible effect"
    })

    it('plan() reports create/update/disable operations that mirror what apply() would actually do', async () => {
      const connector = makeConnector()
      const desired = baseDesired({ enabled: true })

      expect(await connector.plan(desired)).toEqual([expect.objectContaining({ kind: 'create' })])
      await connector.apply(desired)
      expect(await connector.plan(desired)).toEqual([])

      const disabled = { ...desired, enabled: false }
      expect(await connector.plan(disabled)).toEqual([expect.objectContaining({ kind: 'disable' })])
    })
  })

  // =========================================================================
  // THE central guarantee: Google id correlation survives a primaryEmail rename
  // =========================================================================
  describe('Google id correlation survives a primaryEmail rename', () => {
    it('a username change updates the SAME Google user via PUT — no duplicate is ever created', async () => {
      const connector = makeConnector()
      const original = baseDesired({ enabled: true })
      const { externalId } = await connector.apply(original)
      const sizeBefore = fake.users.size

      const renamed: DesiredUser = {
        ...original,
        username: `renamed-${original.username}`,
        email: `renamed-${original.email}`,
        existingExternalId: externalId,
      }
      const { externalId: externalId2 } = await connector.apply(renamed)
      expect(externalId2).toBe(externalId)
      expect(fake.users.size).toBe(sizeBefore) // no duplicate — same population size

      const stored = fake.users.get(externalId)!
      expect(stored.primaryEmail).toBe(renamed.username)
    })
  })

  // =========================================================================
  // Disable — the decision-3 guarantee: disabled AND still present, no delete
  // =========================================================================
  describe('disable — decision-3 guarantee (disabled AND still present, no delete)', () => {
    it('disables an enabled user; the entry remains present; unrelated fields survive untouched; issues NO DELETE request at all', async () => {
      const connector = makeConnector()
      const desired = baseDesired({ enabled: true, attributes: { title: ['Keep Me'] } })
      const { externalId } = await connector.apply(desired)
      const before = fake.requests.length

      await connector.disable(externalId)

      const stored = fake.users.get(externalId)
      expect(stored).toBeDefined() // PRESENCE, asserted explicitly — decision 3
      expect(stored!.suspended).toBe(true)
      expect(stored!.primaryEmail).toBe(desired.username)
      expect(stored!.title).toBe('Keep Me')

      const since = adminRequestsSince(before)
      expect(since.some((r) => r.method === 'DELETE')).toBe(false) // THE central proof
      expect(since.some((r) => r.method === 'PUT')).toBe(true)
    })

    it('disabling an already-disabled user is a harmless no-op — still no delete, still present', async () => {
      const connector = makeConnector()
      const desired = baseDesired({ enabled: false })
      const { externalId } = await connector.apply(desired)

      await connector.disable(externalId)
      await connector.disable(externalId)

      expect(fake.users.has(externalId)).toBe(true)
      expect(fake.users.get(externalId)!.suspended).toBe(true)
    })

    it('disable() throws a clear error for an unknown id rather than silently doing nothing', async () => {
      const connector = makeConnector()
      await expect(connector.disable(randomUUID())).rejects.toThrow(/no user found for id/)
    })
  })

  // =========================================================================
  // Group membership via the Members API
  // =========================================================================
  describe('group membership via the Members API', () => {
    it('creating a user with desired groups creates the group and adds membership via POST .../members', async () => {
      const connector = makeConnector()
      const groupName = `Engineers ${randomUUID().slice(0, 8)}`
      const desired = baseDesired({ enabled: true, groups: [groupName] })
      const { externalId } = await connector.apply(desired)

      const group = [...fake.groups.values()].find((g) => g.name === groupName)
      expect(group).toBeDefined()
      expect(group!.memberIds).toEqual([externalId])
      expect(group!.email).toBe(deriveGroupEmail(groupName, fake.domain))
    })

    it('removing a member removes EXACTLY that edge via DELETE .../members/{id}, leaving an unrelated group intact', async () => {
      const connector = makeConnector()
      const groupA = `GroupA ${randomUUID().slice(0, 8)}`
      const groupB = `GroupB ${randomUUID().slice(0, 8)}`
      let desired = baseDesired({ enabled: true, groups: [groupA, groupB] })
      const { externalId } = await connector.apply(desired)
      const gA = [...fake.groups.values()].find((g) => g.name === groupA)!
      const gB = [...fake.groups.values()].find((g) => g.name === groupB)!
      expect(gA.memberIds).toEqual([externalId])
      expect(gB.memberIds).toEqual([externalId])

      desired = { ...desired, groups: [groupB] }
      await connector.apply(desired)

      expect(gA.memberIds as string[]).toEqual([]) // removed
      expect(gB.memberIds as string[]).toEqual([externalId]) // untouched — exactly one edge changed
    })

    it('a second apply with unchanged groups issues NO new member calls at all (idempotent)', async () => {
      const connector = makeConnector()
      const groupName = `Idem ${randomUUID().slice(0, 8)}`
      const desired = baseDesired({ enabled: true, groups: [groupName] })
      await connector.apply(desired)

      const before = fake.requests.length
      await connector.apply(desired)
      const since = adminRequestsSince(before)
      expect(since.some((r) => r.path.includes('/members'))).toBe(false)
    })

    it('plan() reports a pending group-membership change WITHOUT writing anything (no group created, no membership call made)', async () => {
      const connector = makeConnector()
      const groupName = `Plan ${randomUUID().slice(0, 8)}`
      const desired = baseDesired({ enabled: true })
      await connector.apply(desired)
      const groupCountBefore = fake.groups.size
      const requestsBefore = fake.requests.length

      const withGroup = { ...desired, groups: [groupName] }
      const ops = await connector.plan(withGroup)
      expect(ops.some((o) => o.description.includes('group membership'))).toBe(true)
      expect(fake.groups.size).toBe(groupCountBefore) // plan() created NOTHING
      expect(adminRequestsSince(requestsBefore).some((r) => r.method === 'POST' && r.path.includes('/groups'))).toBe(false)
    })
  })

  // =========================================================================
  // Throttling AND the Admin SDK's quota errors — honoured, not hammered
  // (this task's own explicit "Respect Retry-After and the Admin SDK's
  // quota errors"). Real elapsed time, real bounded retries — see
  // google-admin-fake.ts's own top doc comment for why this is a genuine,
  // not simulated, proof.
  // =========================================================================
  describe('throttling and quota errors are honoured, not hammered — real elapsed time', () => {
    it('a bare 429 is honoured: the connector genuinely waits, then succeeds, using exactly 2 requests', async () => {
      const connector = makeConnector()
      const desired = baseDesired()
      fake.throttleNextAdminRequests(1, { status: 429, retryAfterSeconds: 2 })
      const before = fake.requests.length
      const start = Date.now()

      const ops = await connector.plan(desired)

      const elapsedMs = Date.now() - start
      expect(ops).toEqual([expect.objectContaining({ kind: 'create' })])
      expect(elapsedMs).toBeGreaterThanOrEqual(1900) // genuinely waited ~2s, not a fixed/guessed backoff
      expect(adminRequestsSince(before)).toHaveLength(2) // exactly one throttled + one that succeeded — NOT hammered
    }, 15_000)

    it('a 403 whose body names a genuine QUOTA reason ("quotaExceeded") is ALSO honoured — not just a bare 429', async () => {
      const connector = makeConnector()
      const desired = baseDesired()
      fake.throttleNextAdminRequests(1, { status: 403, reason: 'quotaExceeded', retryAfterSeconds: 1 })
      const before = fake.requests.length

      await connector.plan(desired)

      expect(adminRequestsSince(before)).toHaveLength(2)
    }, 15_000)

    it('a 403 whose body names "userRateLimitExceeded" is honoured too — every documented quota reason, not just one', async () => {
      const connector = makeConnector()
      const desired = baseDesired()
      fake.throttleNextAdminRequests(1, { status: 403, reason: 'userRateLimitExceeded', retryAfterSeconds: 1 })
      const before = fake.requests.length

      await connector.plan(desired)

      expect(adminRequestsSince(before)).toHaveLength(2)
    }, 15_000)

    it('a GENUINE 403 (not a quota reason) is NEVER retried — it fails immediately, distinct from a throttle', async () => {
      const connector = makeConnector()
      const desired = baseDesired()
      fake.failNextAdminRequestsWith(1, 403, {
        error: { errors: [{ domain: 'global', reason: 'forbidden', message: 'fake, injected, genuine permission failure' }], code: 403, message: 'fake, injected, genuine permission failure' },
      })
      const before = fake.requests.length

      await expect(connector.plan(desired)).rejects.toThrow(/forbidden|permission failure/)

      expect(adminRequestsSince(before)).toHaveLength(1) // NEVER retried — a real 403 is not a throttle
    })

    it('a throttled response with NO Retry-After header falls back to a sane default wait rather than hanging or crashing — the COMMON case for this API', async () => {
      const connector = makeConnector()
      const desired = baseDesired()
      fake.throttleNextAdminRequests(1, { status: 429, retryAfterSeconds: null })
      const start = Date.now()

      const ops = await connector.plan(desired)

      expect(ops).toEqual([expect.objectContaining({ kind: 'create' })])
      // computeThrottleWaitMs's own documented fallback: (2^1) + jitter seconds — some real wait happened, not zero.
      expect(Date.now() - start).toBeGreaterThanOrEqual(1900)
    }, 15_000)

    it('exceeding the retry bound throws GoogleAdminThrottledError rather than retrying forever', async () => {
      const connector = makeConnector({ maxThrottleRetries: 2, maxThrottleWaitMs: 5_000 })
      const desired = baseDesired()
      fake.throttleNextAdminRequests(5, { status: 429, retryAfterSeconds: 1 }) // more than the bound
      const before = fake.requests.length

      await expect(connector.plan(desired)).rejects.toThrow(GoogleAdminThrottledError)

      // 1 initial + 2 retries (the configured bound) — never all 5 queued,
      // proving this genuinely stopped rather than exhausting the queue.
      expect(adminRequestsSince(before)).toHaveLength(3)
    }, 20_000)
  })

  // =========================================================================
  // 401 handling — exactly one refresh, never a loop.
  // =========================================================================
  describe('a 401 refreshes the token exactly once and does not loop', () => {
    it('one injected 401 triggers exactly one token refresh, then succeeds', async () => {
      const connector = makeConnector()
      const desired = baseDesired()
      const beforeTokens = fake.tokenRequestCount

      fake.rejectNextAdminRequestsWithUnauthorized(1)
      const ops = await connector.plan(desired)

      expect(ops).toEqual([expect.objectContaining({ kind: 'create' })])
      expect(fake.tokenRequestCount - beforeTokens).toBe(2) // initial fetch + exactly one forced refresh
    })

    it('does NOT loop: with MORE 401s queued than one refresh can fix, the connector still refreshes only ONCE and surfaces the failure after exactly 2 requests', async () => {
      const connector = makeConnector()
      const desired = baseDesired()
      const beforeTokens = fake.tokenRequestCount
      const beforeRequests = fake.requests.length

      fake.rejectNextAdminRequestsWithUnauthorized(3) // more than any single refresh could ever satisfy
      await expect(connector.plan(desired)).rejects.toThrow()

      expect(fake.tokenRequestCount - beforeTokens).toBe(2) // NEVER more — this is the whole guarantee
      expect(adminRequestsSince(beforeRequests)).toHaveLength(2) // NEVER a 3rd/4th/5th attempt despite 3 queued 401s
    })
  })

  // =========================================================================
  // Domain-wide delegation failures — the fake's own REAL signature
  // verification (see google-admin-fake.ts's top doc comment) — must fail
  // CLEANLY, never throw an unhandled error out of health().
  // =========================================================================
  describe('domain-wide delegation failures fail cleanly via health()', () => {
    it('a subject the fake was never authorised for fails with a clear, non-throwing health() result', async () => {
      const connector = makeConnector({ impersonatedAdminEmail: `not-authorised-${randomUUID()}@example.com` })
      const health = await connector.health()
      expect(health.ok).toBe(false)
      expect(health.detail.length).toBeGreaterThan(0)
    })

    it('a credential signed by a DIFFERENT keypair (not the one this fake trusts) fails with a clear, non-throwing health() result', async () => {
      const wrongSecretName = `${SECRET_NAME}_WRONG_KEYPAIR`
      // A syntactically-valid, but UNTRUSTED, service-account key — a
      // genuine RSA keypair the fake never learned the public half of.
      const otherFake = await startGoogleAdminFake()
      try {
        process.env[wrongSecretName] = otherFake.serviceAccountKeyJson
        const connector = makeConnector({ credentialSecretName: wrongSecretName })
        const health = await connector.health()
        expect(health.ok).toBe(false)
      } finally {
        delete process.env[wrongSecretName]
        await otherFake.stop()
      }
    })
  })

  // =========================================================================
  // computeThrottleWaitMs / deriveGroupEmail / generateBootstrapPassword —
  // pure, no I/O.
  // =========================================================================
  describe('computeThrottleWaitMs (pure)', () => {
    it('parses a delay-seconds Retry-After header when present', () => {
      expect(computeThrottleWaitMs('10', 1)).toBe(10_000)
      expect(computeThrottleWaitMs('0', 1)).toBe(0)
    })

    it('falls back to Google\'s own documented exponential-backoff-with-jitter formula when the header is absent', () => {
      const ms = computeThrottleWaitMs(null, 1)
      // (2^1) + [0,1) seconds, in ms.
      expect(ms).toBeGreaterThanOrEqual(2_000)
      expect(ms).toBeLessThan(3_000)
    })

    it('the fallback grows with the attempt number, matching the documented (2^n) shape', () => {
      expect(computeThrottleWaitMs(null, 3)).toBeGreaterThanOrEqual(8_000)
    })

    it('parses an HTTP-date value (RFC 7231\'s other allowed form)', () => {
      const future = new Date(Date.now() + 5_000).toUTCString()
      const ms = computeThrottleWaitMs(future, 1)
      expect(ms).toBeGreaterThan(3_000)
      expect(ms).toBeLessThanOrEqual(5_500)
    })
  })

  describe('deriveGroupEmail (pure)', () => {
    it('lowercases and hyphenates a spaced group name', () => {
      expect(deriveGroupEmail('Engineering Team', 'corp.example.com')).toBe('engineering-team@corp.example.com')
    })

    it('strips disallowed characters', () => {
      expect(deriveGroupEmail('R&D / "Special" <Team>', 'corp.example.com')).toMatch(/^[a-z0-9._-]+@corp\.example\.com$/)
    })

    it('falls back to a generated value when sanitisation leaves nothing usable', () => {
      expect(deriveGroupEmail('!!!', 'corp.example.com')).toMatch(/^group-\d+@corp\.example\.com$/)
    })

    it('truncates the local part to 64 characters', () => {
      const email = deriveGroupEmail('a'.repeat(100), 'corp.example.com')
      const localPart = email.split('@')[0]!
      expect(localPart.length).toBe(64)
    })
  })

  describe('generateBootstrapPassword (pure)', () => {
    it('always contains at least one of each required character class', () => {
      for (let i = 0; i < 20; i++) {
        const pw = generateBootstrapPassword()
        expect(pw).toMatch(/[a-z]/)
        expect(pw).toMatch(/[A-Z]/)
        expect(pw).toMatch(/[0-9]/)
        expect(pw).toMatch(/[!@#$%^&*\-_=+]/)
      }
    })

    it('satisfies Google\'s own documented 8-100 ASCII character length rule', () => {
      const pw = generateBootstrapPassword()
      expect(pw.length).toBeGreaterThanOrEqual(8)
      expect(pw.length).toBeLessThanOrEqual(100)
    })

    it('is genuinely random — 50 calls produce 50 distinct values', () => {
      const values = new Set(Array.from({ length: 50 }, () => generateBootstrapPassword()))
      expect(values.size).toBe(50)
    })
  })

  // =========================================================================
  // Non-negotiables, proven against the connector source itself
  // =========================================================================
  describe('non-negotiables, proven against the connector source itself', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'src/connectors/google-workspace.connector.ts'), 'utf8')

    it('issues exactly ONE literal DELETE call in the whole file — the group-member edge removal — never a bare /users/{id} or /groups/{id} delete', () => {
      const deleteOccurrences = source.match(/'DELETE'/g) ?? []
      expect(deleteOccurrences).toHaveLength(1)

      const lines = source.split('\n')
      const deleteLineIndex = lines.findIndex((line) => line.includes("'DELETE'"))
      expect(deleteLineIndex).toBeGreaterThanOrEqual(0)
      const surrounding = lines.slice(deleteLineIndex, deleteLineIndex + 3).join('\n')
      expect(surrounding).toContain('/members/')
    })

    it('the generated bootstrap password is used in exactly ONE place — apply()\'s CREATE branch — never elsewhere in the file', () => {
      const occurrences = source.match(/generateBootstrapPassword\(\)/g) ?? []
      expect(occurrences).toHaveLength(1)
    })
  })

  // =========================================================================
  // Secret-leak sentinel — extends Milestone 10 Task 2's proof to this
  // connector, AND to the generated bootstrap password (this task's own
  // "PROVE IT": "No secret, key or token in any response, log line or
  // error"). Checks BOTH the sentinel-bearing client_email AND the real
  // private-key PEM material — see google-admin-fake.ts's own top doc
  // comment for why this fake can prove leak-freedom against genuine
  // cryptographic material, not just an artificial placeholder string.
  // =========================================================================
  describe('secret resolution never leaks (extends Milestone 10 Task 2 to google_workspace)', () => {
    it('the service-account private key never appears in any response/error/console output, and the generated bootstrap password never appears anywhere but its own single create request', async () => {
      const loggedArgs: string[] = []
      const capture = (...args: unknown[]) => {
        loggedArgs.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a))).join(' '))
      }
      const spies = [
        vi.spyOn(console, 'log').mockImplementation(capture),
        vi.spyOn(console, 'error').mockImplementation(capture),
        vi.spyOn(console, 'warn').mockImplementation(capture),
      ]

      try {
        const privateKeySentinel = (JSON.parse(fake.serviceAccountKeyJson) as { private_key: string }).private_key
        const emailSentinel = fake.serviceAccountEmail

        const connector = makeConnector()
        const health = await connector.health()
        expect(health.ok).toBe(true) // sanity: this run really did resolve and use the real secret
        assertNoLeak(JSON.stringify(health), privateKeySentinel, 'health() response body')
        assertNoLeak(JSON.stringify(health), emailSentinel, 'health() response body (service account email)')

        const desired = baseDesired()
        const applyResult = await connector.apply(desired)
        assertNoLeak(JSON.stringify(applyResult), privateKeySentinel, 'apply() response body')

        // The bootstrap-password sentinel — captured from the ACTUAL wire
        // request this connector sent, never guessed or re-derived, per
        // "prove it, do not assert intent."
        const createRequest = fake.requests.find(
          (r) => r.method === 'POST' && r.path === '/admin/directory/v1/users' && (JSON.parse(r.bodyText) as { primaryEmail?: string }).primaryEmail === desired.username,
        )
        expect(createRequest).toBeDefined()
        const sentPassword = (JSON.parse(createRequest!.bodyText) as { password: string }).password
        expect(sentPassword.length).toBeGreaterThan(0)
        assertNoLeak(JSON.stringify(applyResult), sentPassword, 'apply() response body (generated password)')
        expect(fake.users.get(applyResult.externalId)).not.toHaveProperty('password')
        for (const r of fake.requests) {
          if (r !== createRequest) {
            assertNoLeak(r.bodyText, sentPassword, `a DIFFERENT request's own body (${r.method} ${r.path})`)
          }
        }

        const disableResult = await connector.disable(applyResult.externalId).catch((e: unknown) => e)
        assertNoLeak(String(disableResult), privateKeySentinel, 'disable() result/error')

        // A deliberately failing path: a typo'd secret name.
        const badConnector = new GoogleWorkspaceConnector()
        badConnector.configure(baseConfig({ credentialSecretName: `${SECRET_NAME}_TYPO` }))
        const badHealth = await badConnector.health()
        expect(badHealth.ok).toBe(false)
        assertNoLeak(badHealth.detail, privateKeySentinel, 'health() failure detail (missing-secret path)')

        assertNoLeak(loggedArgs.join('\n'), privateKeySentinel, 'console.log/warn/error output')
        assertNoLeak(loggedArgs.join('\n'), sentPassword, 'console.log/warn/error output (generated password)')
      } finally {
        for (const spy of spies) spy.mockRestore()
      }
    })
  })

  // =========================================================================
  // Default-deny attribute propagation — asserted against what Google
  // ACTUALLY RECEIVED, through the REAL SyncWorker pipeline (non-negotiable).
  // =========================================================================
  describe('default-deny attribute propagation — asserted against what Google actually received', () => {
    let orgUnitId: string
    let departmentOrgUnitId: string
    let departmentOrgUnitName: string

    beforeAll(async () => {
      const orgUnitsRepo = new OrgUnitsRepository(ctx.db)
      const root = await orgUnitsRepo.createRoot(`Google Default Deny Root ${randomUUID()}`)
      orgUnitId = root.id
      departmentOrgUnitName = `Engineering ${randomUUID().slice(0, 8)}`
      const child = await orgUnitsRepo.createChild(root.id, departmentOrgUnitName)
      departmentOrgUnitId = child.id

      await ctx.pool.query(
        `INSERT INTO connector_targets (target, enabled, config) VALUES ('google_workspace', true, $1)
         ON CONFLICT (target) DO UPDATE SET enabled = true, config = $1`,
        [JSON.stringify(baseConfig())],
      )
    })

    function usersRepo(): UsersRepository {
      return new UsersRepository(ctx.db)
    }

    function makeWorker(): SyncWorker {
      const registry = new ConnectorRegistry(unreachableKeycloak())
      return new SyncWorker(ctx.db, new OutboxRepository(), usersRepo(), new GroupsRepository(ctx.db), unreachableKeycloak(), undefined, registry)
    }

    async function makeCustomAttributeDefinition(): Promise<{ id: string; key: string }> {
      const key = `gws_dd_custom_${randomUUID().replace(/-/g, '').slice(0, 12)}`
      const { rows } = await ctx.pool.query<{ id: string }>(
        `INSERT INTO attribute_definitions (key, label, data_type, applies_to, is_active)
         VALUES ($1, $1, 'string', 'user', true) RETURNING id`,
        [key],
      )
      return { id: rows[0]!.id, key }
    }

    async function mapAttribute(attributeDefinitionId: string, remoteName: string): Promise<void> {
      await ctx.pool.query(
        `INSERT INTO attribute_target_mappings (attribute_definition_id, target, remote_name, enabled)
         VALUES ($1, 'google_workspace', $2, true)
         ON CONFLICT (attribute_definition_id, target) WHERE attribute_definition_id IS NOT NULL
         DO UPDATE SET remote_name = $2, enabled = true`,
        [attributeDefinitionId, remoteName],
      )
    }

    async function mapCoreField(coreField: string, remoteName: string): Promise<void> {
      await ctx.pool.query(
        `INSERT INTO attribute_target_mappings (core_field, target, remote_name, enabled)
         VALUES ($1, 'google_workspace', $2, true)
         ON CONFLICT (core_field, target) WHERE core_field IS NOT NULL
         DO UPDATE SET remote_name = $2, enabled = true`,
        [coreField, remoteName],
      )
    }

    async function reconcile(userId: string): Promise<Record<string, unknown>> {
      await ctx.db.transaction((tx) => makeWorker().reconcileUser(tx, userId, 'google_workspace'))
      const { rows } = await ctx.pool.query<{ external_id: string }>(
        `SELECT external_id FROM external_identities WHERE user_id = $1 AND system = 'google_workspace'`,
        [userId],
      )
      return fake.users.get(rows[0]!.external_id)!
    }

    it('a mapped custom attribute reaches Google under its remote name; an unmapped one reaches Google under no name at all', async () => {
      const mapped = await makeCustomAttributeDefinition()
      const unmapped = await makeCustomAttributeDefinition()
      await mapAttribute(mapped.id, 'employeeType')
      const unmappedSentinelValue = `must-never-propagate-${randomUUID()}`

      const username = nextUsername()
      const user = await usersRepo().create({
        primaryEmail: username,
        username,
        firstName: 'DD',
        lastName: 'Test',
        orgUnitId,
        attributes: { [mapped.key]: 'Contractor', [unmapped.key]: unmappedSentinelValue },
      })
      await usersRepo().changeStatus(user.id, 'active')

      const stored = await reconcile(user.id)
      expect(stored.employeeType).toBe('Contractor')
      assertNoLeak(JSON.stringify(stored), unmappedSentinelValue, 'Google stored user (unmapped attribute)')
    })

    it('a mapping DISABLED after being enabled stops propagating — the stale Google value is ACTIVELY CLEARED', async () => {
      const def = await makeCustomAttributeDefinition()
      await mapAttribute(def.id, 'city')

      const username = nextUsername()
      const user = await usersRepo().create({
        primaryEmail: username,
        username,
        firstName: 'Toggle',
        lastName: 'Test',
        orgUnitId,
        attributes: { [def.key]: 'toggle-value' },
      })
      await usersRepo().changeStatus(user.id, 'active')
      const before = await reconcile(user.id)
      expect(before.city).toBe('toggle-value')

      await ctx.pool.query(`UPDATE attribute_target_mappings SET enabled = false WHERE attribute_definition_id = $1 AND target = 'google_workspace'`, [def.id])
      // A DIFFERENT attribute-triggering change forces a real re-sync so we
      // can observe the field being ACTIVELY DROPPED, not merely never sent.
      await ctx.pool.query(`UPDATE users SET attributes = $2 WHERE id = $1`, [user.id, JSON.stringify({ [def.key]: 'toggle-value-still-set-locally' })])
      const after = await reconcile(user.id)
      expect(after).not.toHaveProperty('city')
    })

    it('core fields (title, department-from-org-path) map per target the same way — mapped reaches Google, unmapped does not', async () => {
      await mapCoreField('title', 'jobTitle')
      // department deliberately left UNMAPPED for this user.

      const username = nextUsername()
      const user = await usersRepo().create({
        primaryEmail: username,
        username,
        firstName: 'Core',
        lastName: 'Fields',
        orgUnitId: departmentOrgUnitId,
        jobTitle: 'Staff Engineer',
      })
      await usersRepo().changeStatus(user.id, 'active')
      const stored = await reconcile(user.id)
      expect(stored.jobTitle).toBe('Staff Engineer')
      expect(stored).not.toHaveProperty('department')
    })

    it('once department IS mapped, it carries the org unit NAME to Google', async () => {
      await mapCoreField('department', 'department')

      const username = nextUsername()
      const user = await usersRepo().create({
        primaryEmail: username,
        username,
        firstName: 'Dept',
        lastName: 'Mapped',
        orgUnitId: departmentOrgUnitId,
      })
      await usersRepo().changeStatus(user.id, 'active')
      const stored = await reconcile(user.id)
      expect(stored.department).toBe(departmentOrgUnitName)
    })
  })

  // =========================================================================
  // Per-principal failure isolation (Milestone 10 Task 4 concern 3, reached
  // for google_workspace) — one principal's OWN Google failure must not
  // abort or corrupt another's, and must self-heal.
  // =========================================================================
  describe('per-principal failure isolation', () => {
    let orgUnitId: string

    beforeAll(async () => {
      orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`Google Isolation Root ${randomUUID()}`)).id
      await ctx.pool.query(
        `INSERT INTO connector_targets (target, enabled, config) VALUES ('google_workspace', true, $1)
         ON CONFLICT (target) DO UPDATE SET enabled = true, config = $1`,
        [JSON.stringify(baseConfig())],
      )
    })

    function usersRepo(): UsersRepository {
      return new UsersRepository(ctx.db)
    }

    function makeSyncWorker(): SyncWorker {
      const registry = new ConnectorRegistry(unreachableKeycloak())
      return new SyncWorker(ctx.db, new OutboxRepository(), usersRepo(), new GroupsRepository(ctx.db), unreachableKeycloak(), undefined, registry)
    }

    async function makeActiveUser(): Promise<User> {
      const username = nextUsername()
      const user = await usersRepo().create({ primaryEmail: username, username, firstName: 'Iso', lastName: 'Test', orgUnitId })
      await usersRepo().changeStatus(user.id, 'active')
      return user
    }

    it('user A succeeds; user B\'s OWN Google call fails cleanly with NOTHING partially created; both converge once Google is healthy again', async () => {
      const worker = makeSyncWorker()
      const userA = await makeActiveUser()
      const userB = await makeActiveUser()

      await ctx.db.transaction((tx) => worker.reconcileUser(tx, userA.id, 'google_workspace'))
      const [rowA] = (
        await ctx.pool.query<{ external_id: string }>(`SELECT external_id FROM external_identities WHERE user_id = $1 AND system = 'google_workspace'`, [userA.id])
      ).rows
      expect(fake.users.has(rowA!.external_id)).toBe(true)

      // An ordinary Admin SDK error — deliberately NOT a connection drop
      // this time (that shape is already proven, empirically, for AD's
      // socket-based connection; this proves the SAME isolation guarantee
      // for an HTTP-shaped target hitting an ordinary per-request failure).
      fake.failNextAdminRequestsWith(1, 400, { error: { errors: [{ domain: 'global', reason: 'invalid', message: 'fake, injected, per-principal failure' }], code: 400, message: 'fake, injected, per-principal failure' } })
      let userBError: unknown
      try {
        await ctx.db.transaction((tx) => worker.reconcileUser(tx, userB.id, 'google_workspace'))
      } catch (error) {
        userBError = error
      }
      expect(userBError).toBeDefined()

      // A: unaffected by B's failure.
      expect(fake.users.has(rowA!.external_id)).toBe(true)
      // B: NOTHING partially created — never correlated, no orphaned Google user.
      const bRows = (
        await ctx.pool.query<{ external_id: string }>(`SELECT external_id FROM external_identities WHERE user_id = $1 AND system = 'google_workspace'`, [userB.id])
      ).rows
      expect(bRows).toHaveLength(0)
      expect([...fake.users.values()].some((u) => u.primaryEmail === userB.username)).toBe(false)

      // Self-heals: the very next reconcile for B succeeds now that Google
      // is no longer failing — the failure was transient and recorded, not
      // a permanent stuck state.
      await ctx.db.transaction((tx) => worker.reconcileUser(tx, userB.id, 'google_workspace'))
      const [rowB] = (
        await ctx.pool.query<{ external_id: string }>(`SELECT external_id FROM external_identities WHERE user_id = $1 AND system = 'google_workspace'`, [userB.id])
      ).rows
      expect(fake.users.has(rowB!.external_id)).toBe(true)
    })

    it('the SAME guarantee, end to end through TargetReconciliationJob\'s own per-principal try/catch (Milestone 10 Task 4, closed generically by Milestone 11 Task 5 — this proves google_workspace reaches it correctly, not a NEW mechanism)', async () => {
      const worker = makeSyncWorker()
      const registry = new ConnectorRegistry(unreachableKeycloak())
      const job = new TargetReconciliationJob(usersRepo(), registry, worker, new AuditWriter(), ctx.db)

      const userC = await makeActiveUser()
      const report = await job.reconcile('google_workspace', {})

      expect(report.halted).toBe(false)
      expect(report.failed).toEqual([])
      expect(report.toMutate.some((p) => p.userId === userC.id)).toBe(true)
      const [rowC] = (
        await ctx.pool.query<{ external_id: string }>(`SELECT external_id FROM external_identities WHERE user_id = $1 AND system = 'google_workspace'`, [userC.id])
      ).rows
      expect(fake.users.has(rowC!.external_id)).toBe(true)
    })
  })

  // =========================================================================
  // Across the ENTIRE suite: no delete-shaped request was ever sent to a
  // /users/ or bare /groups/ path. Placed LAST so it observes every request
  // every test above made (vitest runs `it` blocks within one `describe`
  // sequentially by default — no `.concurrent` is used anywhere in this
  // file).
  // =========================================================================
  describe('across this entire suite, the fake never received a delete-shaped request outside a member edge removal', () => {
    it('zero DELETE requests targeted /users/ or a bare /groups/{id}; every DELETE this connector issued targeted /groups/.../members/...', () => {
      const deletes = fake.requests.filter((r) => r.method === 'DELETE')
      for (const del of deletes) {
        expect(del.path).not.toMatch(/^\/admin\/directory\/v1\/users\//)
        expect(del.path).not.toMatch(/^\/admin\/directory\/v1\/groups\/[^/]+$/)
        expect(del.path).toMatch(/^\/admin\/directory\/v1\/groups\/[^/]+\/members\/[^/]+$/)
      }
    })
  })
})
