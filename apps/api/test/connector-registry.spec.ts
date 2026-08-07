import { describe, expect, it } from 'vitest'
import type { ConnectorTarget } from '../src/connectors/connector'
import { ConnectorRegistry } from '../src/connectors/connector-registry'
import { EchoConnector } from '../src/connectors/echo.connector'
import { KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { withTestDatabase } from './support/pg'

// A KeycloakAdminClient pointed at an unreachable port — this file never
// needs a REAL Keycloak (it proves REGISTRY dispatch/config-resolution
// behaviour, not Keycloak REST call shapes, which sync.worker.spec.ts and
// keycloak-admin.client.spec.ts already prove against real containers), so
// constructing one just needs to succeed, never actually connect.
function unreachableKeycloak(): KeycloakAdminClient {
  return new KeycloakAdminClient({
    issuer: 'http://127.0.0.1:1/realms/unreachable',
    clientId: 'irrelevant',
    clientSecret: 'irrelevant',
  })
}

/**
 * MILESTONE 10, TASK 2 — the target -> connector registry. `Object.create
 * (null)` + `Object.hasOwn` safety (this project's fourth time defending
 * against the exact prototype-chain-bypass hazard `ROLE_PERMISSIONS`/
 * `ROLE_RANK` (authz/actions.ts) and `KNOWN_TRIGGERS`/`CONDITION_FIELD_
 * EXTRACTORS`/`OPERATOR_EVALUATORS` (jml/rule-engine.ts) were each hardened
 * against before it), compile-time exhaustiveness, and config-driven
 * resolution via `connector_targets`.
 */
describe('ConnectorRegistry (Milestone 10, Task 2)', () => {
  const ctx = withTestDatabase()

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

  // =========================================================================
  // Prototype-chain-bypass safety — this project's fourth guard of this
  // exact shape. `'constructor' in {}` is `true` and resolves to a real,
  // INHERITED, non-nullish value (`Object.prototype.constructor`, the
  // `Object` function) on an ordinary object — defeating both an `in` check
  // and a bare `?? fallback`. `target` here is cast past the compile-time
  // `ConnectorTarget` union specifically to exercise the RUNTIME guard
  // regardless of what TypeScript would otherwise reject — the same
  // technique privilege.guards.spec.ts/rule-engine tests use to prove their
  // own `Object.hasOwn` guards.
  // =========================================================================
  describe('prototype-chain-bypass safety', () => {
    it("resolve() rejects 'constructor' with a clear error, never an inherited Object.prototype value", async () => {
      const registry = new ConnectorRegistry(unreachableKeycloak())

      await ctx.db.transaction(async (tx) => {
        await expect(registry.resolve('constructor' as ConnectorTarget, tx)).rejects.toThrow(
          /no connector registered for target "constructor"/,
        )
      })
    })

    it.each(['toString', '__proto__', 'hasOwnProperty', 'valueOf'] as const)(
      'resolve() rejects the colliding key %s the same way',
      async (key) => {
        const registry = new ConnectorRegistry(unreachableKeycloak())
        await ctx.db.transaction(async (tx) => {
          await expect(registry.resolve(key as ConnectorTarget, tx)).rejects.toThrow(
            `no connector registered for target "${key}"`,
          )
        })
      },
    )
  })

  // =========================================================================
  // Exhaustiveness / known-implemented-targets.
  // =========================================================================
  describe('implemented vs. not-yet-implemented targets', () => {
    it('resolves keycloak, echo, and entra_id', async () => {
      const registry = new ConnectorRegistry(unreachableKeycloak())
      await insertConnectorTarget('echo', { credentialSecretName: 'IRRELEVANT_FOR_THIS_TEST' })

      try {
        await ctx.db.transaction(async (tx) => {
          const keycloakConnector = await registry.resolve('keycloak', tx)
          expect(keycloakConnector).toBeDefined()
          expect(typeof keycloakConnector.apply).toBe('function')

          const echoConnector = await registry.resolve('echo', tx)
          expect(echoConnector).toBeDefined()
          expect(typeof echoConnector.apply).toBe('function')

          // Milestone 12, Task 7 — a dedicated `EntraIdConnector`
          // request/response proof lives in entra-id.connector.spec.ts; this
          // only proves the REGISTRY resolves it at all, mirroring how
          // `active_directory`'s own registration is proven here too.
          const entraConnector = await registry.resolve('entra_id', tx)
          expect(entraConnector).toBeDefined()
          expect(typeof entraConnector.apply).toBe('function')
        })
      } finally {
        await deleteConnectorTarget('echo')
      }
    })

    // Milestone 13 has not shipped an adapter yet — a claimed event for it
    // must fail LOUDLY (dead-lettered, visible) rather than being silently
    // misprocessed by whichever connector happens to be first in the map.
    // This is exactly the failure mode Task 1's own report flagged as the
    // risk of leaving dispatch unwired. `active_directory` moved OUT of this
    // list in Milestone 11, Task 5, and `entra_id` moves out in Milestone 12,
    // Task 7 — see the sibling `resolves keycloak, echo, and entra_id` test's
    // own shape; dedicated per-connector resolution proofs live in
    // active-directory.connector.spec.ts / entra-id.connector.spec.ts.
    it.each(['google_workspace'] as const)(
      'resolve() rejects the not-yet-implemented target %s with a clear error',
      async (target) => {
        const registry = new ConnectorRegistry(unreachableKeycloak())
        await ctx.db.transaction(async (tx) => {
          await expect(registry.resolve(target, tx)).rejects.toThrow(
            `no connector registered for target "${target}"`,
          )
        })
      },
    )
  })

  // =========================================================================
  // Config-driven resolution — connector_targets.config, read via the
  // CALLER's own tx (connection discipline), reaches the returned connector.
  // =========================================================================
  describe('binds the freshly-read connector_targets.config into the echo connector', () => {
    it('a target with NO connector_targets row resolves to a connector with EMPTY config (fails secret resolution cleanly, not a crash)', async () => {
      const registry = new ConnectorRegistry(unreachableKeycloak())
      await deleteConnectorTarget('echo') // ensure no row

      const connector = await ctx.db.transaction((tx) => registry.resolve('echo', tx))
      const health = await connector.health()

      expect(health.ok).toBe(false)
      expect(health.detail).toContain('credentialSecretName')
    })

    it('a target WITH a row binds that config — health() reflects the configured (missing) secret name', async () => {
      const registry = new ConnectorRegistry(unreachableKeycloak())
      const secretName = 'CONNECTOR_REGISTRY_TEST_SECRET_UNSET'
      delete process.env[secretName]
      await insertConnectorTarget('echo', { credentialSecretName: secretName })

      try {
        const connector = await ctx.db.transaction((tx) => registry.resolve('echo', tx))
        const health = await connector.health()
        expect(health.ok).toBe(false)
        expect(health.detail).toContain(secretName)
      } finally {
        await deleteConnectorTarget('echo')
      }
    })

    it('re-resolving after the row is updated picks up the NEW config — never a stale, cached binding', async () => {
      const registry = new ConnectorRegistry(unreachableKeycloak())
      const firstSecretName = 'CONNECTOR_REGISTRY_TEST_SECRET_FIRST'
      const secondSecretName = 'CONNECTOR_REGISTRY_TEST_SECRET_SECOND'
      process.env[secondSecretName] = 'present'
      delete process.env[firstSecretName]

      await insertConnectorTarget('echo', { credentialSecretName: firstSecretName })
      try {
        const first = await ctx.db.transaction((tx) => registry.resolve('echo', tx))
        expect((await first.health()).ok).toBe(false)

        await insertConnectorTarget('echo', { credentialSecretName: secondSecretName })
        const second = await ctx.db.transaction((tx) => registry.resolve('echo', tx))
        expect((await second.health()).ok).toBe(true)
      } finally {
        await deleteConnectorTarget('echo')
        delete process.env[secondSecretName]
      }
    })

    it('the SAME echo connector instance persists across resolve() calls, so a caller holding a reference sees every call made through ANY resolution', async () => {
      const echoConnector = new EchoConnector()
      const registry = new ConnectorRegistry(unreachableKeycloak(), echoConnector)
      const secretName = 'CONNECTOR_REGISTRY_TEST_SECRET_PERSIST'
      process.env[secretName] = 'present'
      await insertConnectorTarget('echo', { credentialSecretName: secretName })

      try {
        const resolvedA = await ctx.db.transaction((tx) => registry.resolve('echo', tx))
        const resolvedB = await ctx.db.transaction((tx) => registry.resolve('echo', tx))
        expect(resolvedA).toBe(echoConnector)
        expect(resolvedB).toBe(echoConnector)
      } finally {
        await deleteConnectorTarget('echo')
        delete process.env[secretName]
      }
    })
  })
})
