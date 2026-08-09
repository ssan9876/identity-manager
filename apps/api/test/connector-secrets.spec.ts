import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectorRegistry } from '../src/connectors/connector-registry'
import { MissingSecretError, ForbiddenSecretNameError, resolveSecret } from '../src/connectors/secrets'
import { KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { SyncWorker } from '../src/outbox/sync.worker'
import { UsersRepository } from '../src/users/users.repository'
import { GroupsRepository } from '../src/groups/groups.repository'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OutboxRepository } from '../src/outbox/outbox.repository'
import { assertNoLeak } from './support/secret-leak'
import { withTestDatabase } from './support/pg'

function unreachableKeycloak(): KeycloakAdminClient {
  return new KeycloakAdminClient({
    issuer: 'http://127.0.0.1:1/realms/unreachable',
    clientId: 'irrelevant',
    clientSecret: 'irrelevant',
  })
}

/**
 * MILESTONE 10, TASK 2 — "No secret value is ever stored in a table,
 * returned by any endpoint, written to a log, or included in an error
 * message or stack trace." "Prove it, do not assert intent."
 *
 * Seeds a recognisable, single-use SENTINEL value into the environment,
 * exercises config read, health, apply and a deliberately failing path
 * through the REAL `ConnectorRegistry` -> `EchoConnector` -> Postgres
 * plumbing (never a mock of the code under test), and greps every response
 * body, every captured log line and every thrown error's message AND stack
 * for the sentinel. A console spy runs for the ENTIRE describe block so no
 * code path gets a free pass just because this file didn't think to call
 * `assertNoLeak` on it directly.
 *
 * RED-THEN-GREEN, done for real during development (not just asserted): the
 * meta-test in the nested `assertNoLeak is not a vacuous check` describe
 * block below is the PERMANENT, in-suite proof that `assertNoLeak` itself
 * actually detects a leak rather than being a vacuous pass — it
 * deliberately constructs a leaking string and asserts the helper throws
 * on it.
 *
 * There was additionally a one-off manual proof during development: this
 * suite was run once against a deliberately reintroduced leak in
 * `EchoConnector.health()` (interpolating the resolved secret value into its
 * `detail` string), observed to fail red, then run again against the real
 * implementation and observed to pass green. That run is not reproducible
 * from this repository and nothing here depends on it — the in-suite
 * meta-test below is the coverage that actually holds. This paragraph used
 * to end with "see task-2-report.md for both captured runs", a bare
 * reference to a file that exists at no path relative to this one; it is
 * removed rather than repointed, because a citation a reader cannot follow
 * is worse than no citation — it reads as evidence while being unavailable
 * for checking. (Ledger references in this tree that DO resolve carry their
 * full `.superpowers/...` path; see apps/web/src/styles/tokens.css for that
 * form.)
 */
describe('secret resolution never leaks the resolved value (Milestone 10, Task 2)', () => {
  const ctx = withTestDatabase()
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

  async function insertConnectorTarget(target: string, config: Record<string, unknown>): Promise<void> {
    await ctx.pool.query(
      `INSERT INTO connector_targets (target, enabled, config) VALUES ($1, true, $2)
       ON CONFLICT (target) DO UPDATE SET config = $2`,
      [target, JSON.stringify(config)],
    )
  }

  async function deleteConnectorTarget(target: string): Promise<void> {
    await ctx.pool.query('DELETE FROM connector_targets WHERE target = $1', [target])
  }

  // ===========================================================================
  // The main sentinel walk: config read -> health -> apply -> a deliberately
  // failing path, all against the REAL registry/connector/Postgres plumbing.
  // ===========================================================================
  it('the sentinel value never appears in config reads, health results, apply results, connector call logs, thrown errors, or anything logged to the console', async () => {
    const secretName = `CONNECTOR_SENTINEL_SECRET_${randomUUID().replace(/-/g, '_')}`
    const sentinelValue = `sentinel-${randomUUID()}`
    process.env[secretName] = sentinelValue

    const registry = new ConnectorRegistry(unreachableKeycloak())
    await insertConnectorTarget('echo', { credentialSecretName: secretName })

    try {
      // ---- 1. CONFIG READ — the admin-editable half `connector_targets`
      // stores. Simulates "reading a target through any API": the API never
      // stores the resolved value here in the first place (decision 4), so
      // a plain SELECT is the most direct proof there is nothing TO leak.
      const { rows: configRows } = await ctx.pool.query<{ config: Record<string, unknown> }>(
        `SELECT config FROM connector_targets WHERE target = 'echo'`,
      )
      assertNoLeak(JSON.stringify(configRows), sentinelValue, 'connector_targets.config read')

      // ---- 2. HEALTH — the resolved value is used only to prove resolution
      // succeeds; `detail` must describe success without repeating it.
      const connector = await ctx.db.transaction((tx) => registry.resolve('echo', tx))
      const health = await connector.health()
      expect(health.ok).toBe(true) // sanity: this run really did resolve the real secret
      assertNoLeak(JSON.stringify(health), sentinelValue, 'health() response body')

      // ---- 3. APPLY (success path) — the response body AND the echo
      // connector's own internal call log (a real place a careless
      // implementation could stash it, e.g. "for debugging").
      const desired = {
        userId: '00000000-0000-4000-8000-000000000001',
        username: 'sentinel-user@example.com',
        email: 'sentinel-user@example.com',
        firstName: 'Sentinel',
        lastName: 'User',
        enabled: true,
        attributes: {},
        groups: [],
      }
      const applyResult = await connector.apply(desired)
      assertNoLeak(JSON.stringify(applyResult), sentinelValue, 'apply() response body')
      assertNoLeak(
        JSON.stringify((connector as unknown as { calls: unknown[] }).calls),
        sentinelValue,
        "the echo connector's own recorded call log",
      )

      // ---- 4. A DELIBERATELY FAILING PATH — resolveSecret's own thrown
      // error, directly, for the exact value that IS present but should
      // never be echoed back even in a "wrong name" style failure.
      let caught: unknown
      try {
        resolveSecret(`${secretName}_TYPO_NEVER_SET`)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(MissingSecretError)
      const err = caught as MissingSecretError
      assertNoLeak(err.message, sentinelValue, 'MissingSecretError.message')
      assertNoLeak(err.stack ?? '', sentinelValue, 'MissingSecretError.stack')

      // ---- 5. The failing path through the REAL SyncWorker/outbox
      // machinery — a missing-secret failure dead-letters exactly like a
      // Keycloak failure would, and its `last_error` column is PERSISTED,
      // queryable Postgres data forever. If a leak ever reached here it
      // would be the worst version of this bug: a permanent record.
      const orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`Sentinel Root ${randomUUID()}`)).id
      const user = await new UsersRepository(ctx.db).create({
        primaryEmail: `sentinel-fail-${randomUUID()}@example.com`,
        username: `sentinel-fail-${randomUUID()}@example.com`,
        firstName: 'Sentinel',
        lastName: 'Fail',
        orgUnitId,
      })
      const { rows: eventRows } = await ctx.pool.query<{ id: string }>(
        `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, target)
         VALUES ('user', $1, 'created', '{}'::jsonb, 'echo') RETURNING id`,
        [user.id],
      )
      const eventId = eventRows[0]!.id

      // Break resolution for JUST this attempt: point the config at a name
      // with no env value, so the worker's own apply() call fails.
      await insertConnectorTarget('echo', { credentialSecretName: `${secretName}_MISSING` })

      const worker = new SyncWorker(
        ctx.db,
        new OutboxRepository(),
        new UsersRepository(ctx.db),
        new GroupsRepository(ctx.db),
        unreachableKeycloak(),
        undefined,
        registry,
      )
      expect(await worker.runOnce()).toBe('processed')

      const { rows: outboxRows } = await ctx.pool.query<{ status: string; last_error: string | null }>(
        'SELECT status, last_error FROM outbox_events WHERE id = $1',
        [eventId],
      )
      expect(outboxRows[0]?.status).toBe('pending') // retried, not yet dead-lettered — either way lastError is populated
      assertNoLeak(outboxRows[0]?.last_error ?? '', sentinelValue, 'outbox_events.last_error (persisted dead-letter reason)')

      // ---- 6. Everything logged to the console during this ENTIRE test.
      assertNoLeak(loggedArgs.join('\n'), sentinelValue, 'console.log/warn/error output')
    } finally {
      delete process.env[secretName]
      await deleteConnectorTarget('echo')
    }
  })

  // ===========================================================================
  // "confirm this one goes red if you leak the value on purpose" — the
  // PERMANENT, in-suite half of that proof: assertNoLeak is not vacuous.
  // ===========================================================================
  describe('assertNoLeak is not a vacuous check', () => {
    it('throws when the sentinel genuinely appears in the haystack', () => {
      const sentinel = `sentinel-${randomUUID()}`
      const leaked = `connector error: could not authenticate with secret "${sentinel}"`
      expect(() => assertNoLeak(leaked, sentinel, 'deliberately leaking test string')).toThrow(
        /SECRET LEAK/,
      )
    })

    it('passes when the sentinel is genuinely absent', () => {
      const sentinel = `sentinel-${randomUUID()}`
      expect(() => assertNoLeak('connector error: secret not set', sentinel, 'clean test string')).not.toThrow()
    })
  })
})

describe('connector secret names are namespaced (security audit, critical)', () => {
  // `connector_targets.config` is admin-editable and names BOTH the
  // environment variable to read AND the destination host. With no constraint
  // on the name, a holder of connector:manage could point a target at a host
  // they control, set credentialSecretName to DATABASE_URL, and receive the
  // database password in an Authorization header. `healthDetail` surfaced the
  // response, making it a convenient oracle too.
  it.each([
    'DATABASE_URL',
    'RUNTIME_DATABASE_URL',
    'KEYCLOAK_ADMIN_CLIENT_SECRET',
    'PATH',
  ])('refuses to resolve %s — not connector-scoped', (name) => {
    expect(() => resolveSecret(name, { [name]: 'sentinel-value' })).toThrow(ForbiddenSecretNameError)
  })

  it('never includes the value in the refusal, even though it has it', () => {
    const error = (() => {
      try {
        resolveSecret('DATABASE_URL', { DATABASE_URL: 'postgres://u:hunter2@db/x' })
      } catch (e) {
        return e as Error
      }
    })()
    expect(error?.message).not.toContain('hunter2')
  })

  // Prototype-chain fail-open, closed by the same rule: `env[name]` walks the
  // chain, so these resolved to inherited FUNCTIONS — truthy, non-empty, and
  // duly sent as a credential. This project has been bitten by prototype-chain
  // lookups three times before.
  it.each(['hasOwnProperty', '__proto__', 'isPrototypeOf', 'toString'])(
    'refuses the inherited property %s',
    (name) => {
      expect(() => resolveSecret(name, {})).toThrow(ForbiddenSecretNameError)
    },
  )

  it('still resolves a properly namespaced secret', () => {
    expect(resolveSecret('CONNECTOR_THING', { CONNECTOR_THING: 'ok' })).toBe('ok')
  })
})
