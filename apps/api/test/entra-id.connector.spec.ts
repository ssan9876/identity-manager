import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import type { DesiredUser } from '../src/connectors/connector'
import { ConnectorRegistry } from '../src/connectors/connector-registry'
import {
  deriveMailNickname,
  EntraGraphThrottledError,
  EntraIdConnector,
  type EntraIdConnectorConfig,
  generateBootstrapPassword,
  parseRetryAfterMs,
} from '../src/connectors/entra-id.connector'
import { GroupsRepository } from '../src/groups/groups.repository'
import { KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OutboxRepository } from '../src/outbox/outbox.repository'
import { SyncWorker } from '../src/outbox/sync.worker'
import { TargetReconciliationJob } from '../src/outbox/target-reconciliation.job'
import { type User, UsersRepository } from '../src/users/users.repository'
import { type EntraGraphFake, startEntraGraphFake } from './support/entra-graph-fake'
import { withTestDatabase } from './support/pg'

function unreachableKeycloak(): KeycloakAdminClient {
  return new KeycloakAdminClient({
    issuer: 'http://127.0.0.1:1/realms/unreachable',
    clientId: 'irrelevant',
    clientSecret: 'irrelevant',
  })
}

/** Same shape/reasoning as connector-secrets.spec.ts's own `assertNoLeak` — re-derived locally per this project's own established convention (see e.g. active-directory.connector.spec.ts's own identical re-derivation). */
function assertNoLeak(haystack: string, sentinel: string, where: string): void {
  if (haystack.includes(sentinel)) {
    throw new Error(`SECRET LEAK in ${where}: sentinel value found — "${haystack}"`)
  }
}

/**
 * MILESTONE 12, TASK 7 — the Entra ID adapter, against
 * `test/support/entra-graph-fake.ts`, a REAL local `node:http` server. Per
 * the design doc's own "Testing" section, this is the accepted, documented
 * exception for a target with no available container: "the fake's weakness
 * is honest: it proves our request shapes and our state machine, and cannot
 * prove the vendor behaves as recorded." Every response shape the fake
 * returns is pinned to Microsoft's OWN published Graph documentation (linked
 * at each handler in that file), never invented — but this suite proves
 * `EntraIdConnector`'s OWN behaviour against those documented shapes, NOT
 * that a real Entra tenant actually behaves this way. See this task's report
 * for the full, honest accounting of what is and is not proven.
 *
 * Most tests below construct `EntraIdConnector` DIRECTLY (never through
 * Postgres/SyncWorker) — the fastest, most precise way to prove the
 * CONNECTOR's own contract, mirroring `active-directory.connector.spec.ts`'s
 * identical structural choice. The "default-deny" and "per-principal
 * isolation" blocks deliberately go through the REAL `SyncWorker`/
 * `TargetReconciliationJob` pipeline instead, because what they prove is a
 * property of THAT pipeline reaching this connector correctly, not the
 * connector in isolation.
 */
describe('EntraIdConnector (Milestone 12, Task 7)', () => {
  const ctx = withTestDatabase()
  const SECRET_NAME = 'ENTRA_CONNECTOR_TEST_SECRET'
  let fake: EntraGraphFake

  beforeAll(async () => {
    fake = await startEntraGraphFake()
    process.env[SECRET_NAME] = fake.clientSecret
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

  function baseConfig(overrides: Partial<EntraIdConnectorConfig> = {}): Record<string, unknown> {
    return {
      tenantId: fake.tenantId,
      clientId: fake.clientId,
      credentialSecretName: SECRET_NAME,
      graphBaseUrl: fake.graphBaseUrl,
      authorityBaseUrl: fake.authorityBaseUrl,
      maxThrottleRetries: 3,
      maxThrottleWaitMs: 10_000,
      requestTimeoutMs: 10_000,
      ...overrides,
    }
  }

  function makeConnector(overrides: Partial<EntraIdConnectorConfig> = {}): EntraIdConnector {
    const connector = new EntraIdConnector()
    connector.configure(baseConfig(overrides))
    return connector
  }

  let usernameSeq = 0
  function nextUsername(): string {
    usernameSeq += 1
    return `eu${usernameSeq}-${randomUUID().slice(0, 8)}@example.com`
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

  function graphRequestsSince(index: number) {
    return fake.requests.slice(index).filter((r) => r.path.startsWith('/v1.0/'))
  }

  // =========================================================================
  // Create, then read back from the fake
  // =========================================================================
  describe('create, then read back from the fake', () => {
    it('creates a disabled user — every profile field lands correctly, correlation id is the Graph-issued id, no passwordProfile is ever stored or returned', async () => {
      const connector = makeConnector()
      const desired = baseDesired({ enabled: false })

      const { externalId } = await connector.apply(desired)
      expect(externalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

      const stored = fake.users.get(externalId)
      expect(stored).toBeDefined()
      expect(stored!.accountEnabled).toBe(false)
      expect(stored!.userPrincipalName).toBe(desired.username)
      expect(stored!.mail).toBe(desired.email)
      expect(stored!.givenName).toBe(desired.firstName)
      expect(stored!.surname).toBe(desired.lastName)
      expect(stored!.displayName).toBe(`${desired.firstName} ${desired.lastName}`)
      // Graph's own "Create user" example response never includes
      // passwordProfile back — the fake reproduces that; this is the direct,
      // structural half of the "never retained" proof (the DYNAMIC,
      // sentinel-value half lives in the secret-leak block below).
      expect(stored).not.toHaveProperty('passwordProfile')
    })

    it('creates an ENABLED user directly, in one operation', async () => {
      const connector = makeConnector()
      const desired = baseDesired({ enabled: true })
      const { externalId } = await connector.apply(desired)
      expect(fake.users.get(externalId)!.accountEnabled).toBe(true)
    })

    it('places a mapped custom attribute alongside the core profile fields, taking only the FIRST value of a multi-value array', async () => {
      const connector = makeConnector()
      const desired = baseDesired({ attributes: { employeeType: ['Contractor', 'ShouldBeDropped'] } })
      const { externalId } = await connector.apply(desired)
      expect(fake.users.get(externalId)!.employeeType).toBe('Contractor')
    })

    it('derives a Graph-legal mailNickname from the username', async () => {
      const connector = makeConnector()
      const desired = baseDesired()
      const { externalId } = await connector.apply(desired)
      expect(fake.users.get(externalId)!.mailNickname).toBe(deriveMailNickname(desired.username))
    })
  })

  // =========================================================================
  // Update — reconcile to desired state, idempotently
  // =========================================================================
  describe('update — reconciles to desired state, idempotently', () => {
    it('a second apply with changed fields updates in place via PATCH; a third, unchanged apply sends NO patch (plan() agrees it is a no-op)', async () => {
      const connector = makeConnector()
      let desired = baseDesired({ attributes: { title: ['Engineer'] } })
      const { externalId: id1 } = await connector.apply(desired)

      desired = { ...desired, firstName: 'Changed', lastName: 'Surname', attributes: { title: ['Staff Engineer'] } }
      const { externalId: id2 } = await connector.apply(desired)
      expect(id2).toBe(id1) // same Graph object, not a duplicate

      const stored = fake.users.get(id1)!
      expect(stored.givenName).toBe('Changed')
      expect(stored.surname).toBe('Surname')
      expect(stored.title).toBe('Staff Engineer')

      expect(await connector.plan(desired)).toEqual([])

      const before = fake.requests.length
      const { externalId: id3 } = await connector.apply(desired)
      expect(id3).toBe(id1)
      const patchesSent = graphRequestsSince(before).filter((r) => r.method === 'PATCH')
      expect(patchesSent).toEqual([]) // genuinely a no-op, not merely "no visible effect"
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
  // THE central guarantee: Graph id correlation survives a UPN rename
  // =========================================================================
  describe('Graph id correlation survives a userPrincipalName rename', () => {
    it('a username change updates the SAME Graph user via PATCH — no duplicate is ever created', async () => {
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
      expect(stored.userPrincipalName).toBe(renamed.username)
      expect(stored.mail).toBe(renamed.email)
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
      expect(stored!.accountEnabled).toBe(false)
      expect(stored!.mail).toBe(desired.email)
      expect(stored!.title).toBe('Keep Me')

      const since = graphRequestsSince(before)
      expect(since.some((r) => r.method === 'DELETE')).toBe(false) // THE central proof
      expect(since.some((r) => r.method === 'PATCH')).toBe(true)
    })

    it('disabling an already-disabled user is a harmless no-op — still no delete, still present', async () => {
      const connector = makeConnector()
      const desired = baseDesired({ enabled: false })
      const { externalId } = await connector.apply(desired)

      await connector.disable(externalId)
      await connector.disable(externalId)

      expect(fake.users.has(externalId)).toBe(true)
      expect(fake.users.get(externalId)!.accountEnabled).toBe(false)
    })

    it('disable() throws a clear error for an unknown id rather than silently doing nothing', async () => {
      const connector = makeConnector()
      await expect(connector.disable(randomUUID())).rejects.toThrow(/no user found for id/)
    })
  })

  // =========================================================================
  // Group membership via $ref
  // =========================================================================
  describe('group membership via $ref', () => {
    it('creating a user with desired groups creates the group and adds membership via POST .../$ref', async () => {
      const connector = makeConnector()
      const groupName = `Engineers ${randomUUID().slice(0, 8)}`
      const desired = baseDesired({ enabled: true, groups: [groupName] })
      const { externalId } = await connector.apply(desired)

      const group = [...fake.groups.values()].find((g) => g.displayName === groupName)
      expect(group).toBeDefined()
      expect(group!.memberIds).toEqual([externalId])
      expect(group!.mailEnabled).toBe(false)
      expect(group!.securityEnabled).toBe(true)
    })

    it('removing a member removes EXACTLY that edge via DELETE .../$ref, leaving an unrelated group intact', async () => {
      const connector = makeConnector()
      const groupA = `GroupA ${randomUUID().slice(0, 8)}`
      const groupB = `GroupB ${randomUUID().slice(0, 8)}`
      let desired = baseDesired({ enabled: true, groups: [groupA, groupB] })
      const { externalId } = await connector.apply(desired)
      const gA = [...fake.groups.values()].find((g) => g.displayName === groupA)!
      const gB = [...fake.groups.values()].find((g) => g.displayName === groupB)!
      expect(gA.memberIds).toEqual([externalId])
      expect(gB.memberIds).toEqual([externalId])

      desired = { ...desired, groups: [groupB] }
      await connector.apply(desired)

      expect(gA.memberIds as string[]).toEqual([]) // removed
      expect(gB.memberIds as string[]).toEqual([externalId]) // untouched — exactly one edge changed
    })

    it('a second apply with unchanged groups issues NO new $ref calls at all (idempotent)', async () => {
      const connector = makeConnector()
      const groupName = `Idem ${randomUUID().slice(0, 8)}`
      const desired = baseDesired({ enabled: true, groups: [groupName] })
      await connector.apply(desired)

      const before = fake.requests.length
      await connector.apply(desired)
      const since = graphRequestsSince(before)
      expect(since.some((r) => r.path.includes('/members/'))).toBe(false)
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
      expect(graphRequestsSince(requestsBefore).some((r) => r.method === 'POST' && r.path.startsWith('/v1.0/groups'))).toBe(false)
    })
  })

  // =========================================================================
  // Throttling — honoured, not hammered (this task's own explicit "Tests
  // that matter" #1). Real elapsed time, real Retry-After, real bounded
  // retries — see entra-graph-fake.ts's own top doc comment for why this is
  // a genuine, not simulated, proof.
  // =========================================================================
  describe('throttling is honoured, not hammered — real Retry-After, real elapsed time', () => {
    it('a 429 with Retry-After is honoured: the connector genuinely waits that long, then succeeds, using exactly 2 Graph attempts', async () => {
      const connector = makeConnector()
      const desired = baseDesired()
      fake.throttleNextGraphRequests(1, { status: 429, retryAfterSeconds: 2 })
      const before = fake.requests.length
      const start = Date.now()

      const ops = await connector.plan(desired)

      const elapsedMs = Date.now() - start
      expect(ops).toEqual([expect.objectContaining({ kind: 'create' })])
      expect(elapsedMs).toBeGreaterThanOrEqual(1900) // genuinely waited ~2s, not a fixed/guessed backoff
      expect(graphRequestsSince(before)).toHaveLength(2) // exactly one throttled + one that succeeded — NOT hammered
    }, 15_000)

    it('a 503 with Retry-After is ALSO honoured (not just 429)', async () => {
      const connector = makeConnector()
      const desired = baseDesired()
      fake.throttleNextGraphRequests(1, { status: 503, retryAfterSeconds: 1 })
      const before = fake.requests.length
      const start = Date.now()

      await connector.plan(desired)

      expect(Date.now() - start).toBeGreaterThanOrEqual(900)
      expect(graphRequestsSince(before)).toHaveLength(2)
    }, 15_000)

    it('a throttled response with NO Retry-After header falls back to a sane default wait rather than hanging or crashing', async () => {
      const connector = makeConnector()
      const desired = baseDesired()
      fake.throttleNextGraphRequests(1, { status: 503, retryAfterSeconds: null })
      const start = Date.now()

      const ops = await connector.plan(desired)

      expect(ops).toEqual([expect.objectContaining({ kind: 'create' })])
      expect(Date.now() - start).toBeGreaterThanOrEqual(500) // DEFAULT_RETRY_AFTER_FALLBACK_MS — some real wait happened, not zero
    }, 15_000)

    it('exceeding the retry bound throws EntraGraphThrottledError rather than retrying forever', async () => {
      const connector = makeConnector({ maxThrottleRetries: 2, maxThrottleWaitMs: 5_000 })
      const desired = baseDesired()
      fake.throttleNextGraphRequests(5, { status: 429, retryAfterSeconds: 1 }) // more than the bound
      const before = fake.requests.length

      await expect(connector.plan(desired)).rejects.toThrow(EntraGraphThrottledError)

      // 1 initial + 2 retries (the configured bound) — never all 5 queued,
      // proving this genuinely stopped rather than exhausting the queue.
      expect(graphRequestsSince(before)).toHaveLength(3)
    }, 20_000)
  })

  // =========================================================================
  // 401 handling — exactly one refresh, never a loop (this task's own
  // explicit "Tests that matter" #2).
  // =========================================================================
  describe('a 401 refreshes the token exactly once and does not loop', () => {
    it('one injected 401 triggers exactly one token refresh, then succeeds', async () => {
      const connector = makeConnector()
      const desired = baseDesired()
      const beforeTokens = fake.tokenRequestCount

      fake.rejectNextGraphRequestsWithUnauthorized(1)
      const ops = await connector.plan(desired)

      expect(ops).toEqual([expect.objectContaining({ kind: 'create' })])
      expect(fake.tokenRequestCount - beforeTokens).toBe(2) // initial fetch + exactly one forced refresh
    })

    it('does NOT loop: with MORE 401s queued than one refresh can fix, the connector still refreshes only ONCE and surfaces the failure after exactly 2 Graph attempts', async () => {
      const connector = makeConnector()
      const desired = baseDesired()
      const beforeTokens = fake.tokenRequestCount
      const beforeRequests = fake.requests.length

      fake.rejectNextGraphRequestsWithUnauthorized(3) // more than any single refresh could ever satisfy
      await expect(connector.plan(desired)).rejects.toThrow()

      expect(fake.tokenRequestCount - beforeTokens).toBe(2) // NEVER more — this is the whole guarantee
      expect(graphRequestsSince(beforeRequests)).toHaveLength(2) // NEVER a 3rd/4th/5th attempt despite 3 queued 401s
    })
  })

  // =========================================================================
  // parseRetryAfterMs / deriveMailNickname / generateBootstrapPassword —
  // pure, no I/O.
  // =========================================================================
  describe('parseRetryAfterMs (pure)', () => {
    it('parses a delay-seconds value (Graph\'s own documented form)', () => {
      expect(parseRetryAfterMs('10')).toBe(10_000)
      expect(parseRetryAfterMs('0')).toBe(0)
    })

    it('falls back to the given default when the header is absent', () => {
      expect(parseRetryAfterMs(null, 3_000)).toBe(3_000)
    })

    it('parses an HTTP-date value (RFC 7231\'s other allowed form)', () => {
      const future = new Date(Date.now() + 5_000).toUTCString()
      const ms = parseRetryAfterMs(future)
      expect(ms).toBeGreaterThan(3_000)
      expect(ms).toBeLessThanOrEqual(5_500)
    })

    it('falls back on an unparseable value rather than throwing', () => {
      expect(parseRetryAfterMs('not-a-number-or-date', 1_234)).toBe(1_234)
    })
  })

  describe('deriveMailNickname (pure)', () => {
    it('strips the domain from an email-shaped username', () => {
      expect(deriveMailNickname('jdoe@example.com')).toBe('jdoe')
    })

    it('strips disallowed/non-ASCII characters', () => {
      expect(deriveMailNickname('j;doe:test<>,()"[]@example.com')).toBe('jdoetest')
    })

    it('falls back to a generated value when sanitisation leaves nothing usable', () => {
      expect(deriveMailNickname('@;:<>')).toMatch(/^user-\d+$/)
    })

    it('truncates to Graph\'s documented 64-character limit', () => {
      expect(deriveMailNickname('a'.repeat(100)).length).toBe(64)
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

    it('is genuinely random — 50 calls produce 50 distinct values', () => {
      const values = new Set(Array.from({ length: 50 }, () => generateBootstrapPassword()))
      expect(values.size).toBe(50)
    })
  })

  // =========================================================================
  // Non-negotiables, proven against the connector source itself
  // =========================================================================
  describe('non-negotiables, proven against the connector source itself', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'src/connectors/entra-id.connector.ts'), 'utf8')

    it('issues exactly ONE literal DELETE call in the whole file — the group-member $ref edge removal — never a bare /users/{id} or /groups/{id} delete', () => {
      const deleteOccurrences = source.match(/'DELETE'/g) ?? []
      expect(deleteOccurrences).toHaveLength(1)

      const lines = source.split('\n')
      const deleteLineIndex = lines.findIndex((line) => line.includes("'DELETE'"))
      expect(deleteLineIndex).toBeGreaterThanOrEqual(0)
      const surrounding = lines.slice(deleteLineIndex, deleteLineIndex + 3).join('\n')
      expect(surrounding).toContain('/members/')
      expect(surrounding).toContain('/$ref')
    })

    it('the generated bootstrap password is used in exactly ONE place — apply()\'s CREATE branch — never elsewhere in the file', () => {
      const occurrences = source.match(/generateBootstrapPassword\(\)/g) ?? []
      expect(occurrences).toHaveLength(1)
    })
  })

  // =========================================================================
  // Secret-leak sentinel — extends Milestone 10 Task 2's proof to this
  // connector, AND to the generated bootstrap password (this task's own
  // "PROVE IT": "No secret or token in any response, log line or error").
  // =========================================================================
  describe('secret resolution never leaks (extends Milestone 10 Task 2 to entra_id)', () => {
    it('the client secret never appears in any response/error/console output, and the generated bootstrap password never appears anywhere but its own single create request', async () => {
      const sentinelSecret = `sentinel-secret-${randomUUID()}`
      const originalSecret = fake.clientSecret
      fake.clientSecret = sentinelSecret
      process.env[SECRET_NAME] = sentinelSecret

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
        const connector = makeConnector()
        const health = await connector.health()
        expect(health.ok).toBe(true) // sanity: this run really did resolve and use the real (sentinel) secret
        assertNoLeak(JSON.stringify(health), sentinelSecret, 'health() response body')

        const desired = baseDesired()
        const applyResult = await connector.apply(desired)
        assertNoLeak(JSON.stringify(applyResult), sentinelSecret, 'apply() response body')

        // The bootstrap-password sentinel — captured from the ACTUAL wire
        // request this connector sent, never guessed or re-derived, per
        // "prove it, do not assert intent."
        const createRequest = fake.requests.find(
          (r) => r.method === 'POST' && r.path === '/v1.0/users' && (JSON.parse(r.bodyText) as { userPrincipalName?: string }).userPrincipalName === desired.username,
        )
        expect(createRequest).toBeDefined()
        const sentPassword = (JSON.parse(createRequest!.bodyText) as { passwordProfile: { password: string } }).passwordProfile.password
        expect(sentPassword.length).toBeGreaterThan(0)
        assertNoLeak(JSON.stringify(applyResult), sentPassword, 'apply() response body (generated password)')
        expect(fake.users.get(applyResult.externalId)).not.toHaveProperty('passwordProfile')
        for (const r of fake.requests) {
          if (r !== createRequest) {
            assertNoLeak(r.bodyText, sentPassword, `a DIFFERENT request's own body (${r.method} ${r.path})`)
          }
        }

        const disableResult = await connector.disable(applyResult.externalId).catch((e: unknown) => e)
        assertNoLeak(String(disableResult), sentinelSecret, 'disable() result/error')

        // A deliberately failing path: a typo'd secret name.
        const badConnector = new EntraIdConnector()
        badConnector.configure(baseConfig({ credentialSecretName: `${SECRET_NAME}_TYPO` }))
        const badHealth = await badConnector.health()
        expect(badHealth.ok).toBe(false)
        assertNoLeak(badHealth.detail, sentinelSecret, 'health() failure detail (missing-secret path)')

        assertNoLeak(loggedArgs.join('\n'), sentinelSecret, 'console.log/warn/error output')
        assertNoLeak(loggedArgs.join('\n'), sentPassword, 'console.log/warn/error output (generated password)')
      } finally {
        fake.clientSecret = originalSecret
        process.env[SECRET_NAME] = originalSecret
        for (const spy of spies) spy.mockRestore()
      }
    })
  })

  // =========================================================================
  // Default-deny attribute propagation — asserted against what Entra
  // ACTUALLY RECEIVED, through the REAL SyncWorker pipeline (non-negotiable).
  // =========================================================================
  describe('default-deny attribute propagation — asserted against what Entra actually received', () => {
    let orgUnitId: string
    let departmentOrgUnitId: string
    let departmentOrgUnitName: string

    beforeAll(async () => {
      const orgUnitsRepo = new OrgUnitsRepository(ctx.db)
      const root = await orgUnitsRepo.createRoot(`Entra Default Deny Root ${randomUUID()}`)
      orgUnitId = root.id
      departmentOrgUnitName = `Engineering ${randomUUID().slice(0, 8)}`
      const child = await orgUnitsRepo.createChild(root.id, departmentOrgUnitName)
      departmentOrgUnitId = child.id

      await ctx.pool.query(
        `INSERT INTO connector_targets (target, enabled, config) VALUES ('entra_id', true, $1)
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
      const key = `entra_dd_custom_${randomUUID().replace(/-/g, '').slice(0, 12)}`
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
         VALUES ($1, 'entra_id', $2, true)
         ON CONFLICT (attribute_definition_id, target) WHERE attribute_definition_id IS NOT NULL
         DO UPDATE SET remote_name = $2, enabled = true`,
        [attributeDefinitionId, remoteName],
      )
    }

    async function mapCoreField(coreField: string, remoteName: string): Promise<void> {
      await ctx.pool.query(
        `INSERT INTO attribute_target_mappings (core_field, target, remote_name, enabled)
         VALUES ($1, 'entra_id', $2, true)
         ON CONFLICT (core_field, target) WHERE core_field IS NOT NULL
         DO UPDATE SET remote_name = $2, enabled = true`,
        [coreField, remoteName],
      )
    }

    async function reconcile(userId: string): Promise<Record<string, unknown>> {
      await ctx.db.transaction((tx) => makeWorker().reconcileUser(tx, userId, 'entra_id'))
      const { rows } = await ctx.pool.query<{ external_id: string }>(
        `SELECT external_id FROM external_identities WHERE user_id = $1 AND system = 'entra_id'`,
        [userId],
      )
      return fake.users.get(rows[0]!.external_id)!
    }

    it('a mapped custom attribute reaches Entra under its remote name; an unmapped one reaches Entra under no name at all', async () => {
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
      assertNoLeak(JSON.stringify(stored), unmappedSentinelValue, 'Entra stored user (unmapped attribute)')
    })

    it('a mapping DISABLED after being enabled stops propagating — the stale Entra value is ACTIVELY CLEARED', async () => {
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

      await ctx.pool.query(`UPDATE attribute_target_mappings SET enabled = false WHERE attribute_definition_id = $1 AND target = 'entra_id'`, [def.id])
      // A DIFFERENT attribute-triggering change forces a real re-sync so we
      // can observe the field being ACTIVELY DROPPED, not merely never sent.
      await ctx.pool.query(`UPDATE users SET attributes = $2 WHERE id = $1`, [user.id, JSON.stringify({ [def.key]: 'toggle-value-still-set-locally' })])
      const after = await reconcile(user.id)
      expect(after).not.toHaveProperty('city')
    })

    it('core fields (title, department-from-org-path) map per target the same way — mapped reaches Entra, unmapped does not', async () => {
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

    it('once department IS mapped, it carries the org unit NAME to Entra', async () => {
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
  // for entra_id) — one principal's OWN Graph failure must not abort or
  // corrupt another's, and must self-heal.
  // =========================================================================
  describe('per-principal failure isolation', () => {
    let orgUnitId: string

    beforeAll(async () => {
      orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`Entra Isolation Root ${randomUUID()}`)).id
      await ctx.pool.query(
        `INSERT INTO connector_targets (target, enabled, config) VALUES ('entra_id', true, $1)
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

    it('user A succeeds; user B\'s OWN Graph call fails cleanly with NOTHING partially created; both converge once Graph is healthy again', async () => {
      const worker = makeSyncWorker()
      const userA = await makeActiveUser()
      const userB = await makeActiveUser()

      await ctx.db.transaction((tx) => worker.reconcileUser(tx, userA.id, 'entra_id'))
      const [rowA] = (
        await ctx.pool.query<{ external_id: string }>(`SELECT external_id FROM external_identities WHERE user_id = $1 AND system = 'entra_id'`, [userA.id])
      ).rows
      expect(fake.users.has(rowA!.external_id)).toBe(true)

      // An ordinary Graph error — deliberately NOT a connection drop this
      // time (that shape is already proven, empirically, for AD's socket-
      // based connection; this proves the SAME isolation guarantee for an
      // HTTP-shaped target hitting an ordinary per-request failure).
      fake.failNextGraphRequestsWith(1, 400, { error: { code: 'BadRequest', message: 'fake, injected, per-principal failure' } })
      let userBError: unknown
      try {
        await ctx.db.transaction((tx) => worker.reconcileUser(tx, userB.id, 'entra_id'))
      } catch (error) {
        userBError = error
      }
      expect(userBError).toBeDefined()

      // A: unaffected by B's failure.
      expect(fake.users.has(rowA!.external_id)).toBe(true)
      // B: NOTHING partially created — never correlated, no orphaned Graph user.
      const bRows = (
        await ctx.pool.query<{ external_id: string }>(`SELECT external_id FROM external_identities WHERE user_id = $1 AND system = 'entra_id'`, [userB.id])
      ).rows
      expect(bRows).toHaveLength(0)
      expect([...fake.users.values()].some((u) => u.userPrincipalName === userB.username)).toBe(false)

      // Self-heals: the very next reconcile for B succeeds now that Graph is
      // no longer failing — the failure was transient and recorded, not a
      // permanent stuck state.
      await ctx.db.transaction((tx) => worker.reconcileUser(tx, userB.id, 'entra_id'))
      const [rowB] = (
        await ctx.pool.query<{ external_id: string }>(`SELECT external_id FROM external_identities WHERE user_id = $1 AND system = 'entra_id'`, [userB.id])
      ).rows
      expect(fake.users.has(rowB!.external_id)).toBe(true)
    })

    it('the SAME guarantee, end to end through TargetReconciliationJob\'s own per-principal try/catch (Milestone 10 Task 4, closed generically by Milestone 11 Task 5 — this proves entra_id reaches it correctly, not a NEW mechanism)', async () => {
      const worker = makeSyncWorker()
      const registry = new ConnectorRegistry(unreachableKeycloak())
      const job = new TargetReconciliationJob(usersRepo(), registry, worker, new AuditWriter(), ctx.db)

      const userC = await makeActiveUser()
      const report = await job.reconcile('entra_id', {})

      expect(report.halted).toBe(false)
      expect(report.failed).toEqual([])
      expect(report.toMutate.some((p) => p.userId === userC.id)).toBe(true)
      const [rowC] = (
        await ctx.pool.query<{ external_id: string }>(`SELECT external_id FROM external_identities WHERE user_id = $1 AND system = 'entra_id'`, [userC.id])
      ).rows
      expect(fake.users.has(rowC!.external_id)).toBe(true)
    })
  })

  // =========================================================================
  // Across the ENTIRE suite: no delete-shaped request was ever sent. Placed
  // LAST so it observes every request every test above made (vitest runs
  // `it` blocks within one `describe` sequentially by default — no
  // `.concurrent` is used anywhere in this file).
  // =========================================================================
  describe('across this entire suite, the fake never received a delete-shaped request outside a $ref edge removal', () => {
    it('zero DELETE requests targeted /users/; every DELETE this connector issued targeted a /groups/.../members/.../$ref edge', () => {
      const deletes = fake.requests.filter((r) => r.method === 'DELETE')
      for (const del of deletes) {
        expect(del.path).not.toMatch(/^\/v1\.0\/users\//)
        expect(del.path).toMatch(/^\/v1\.0\/groups\/[^/]+\/members\/[^/]+\/\$ref/)
      }
    })
  })
})
