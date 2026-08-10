import { beforeEach, describe, expect, it } from 'vitest'
import type { ConnectorRegistry } from '../src/connectors/connector-registry'
import type { DesiredSsoApp, SsoConnector } from '../src/connectors/connector'
import { GroupsRepository } from '../src/groups/groups.repository'
import { KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { OutboxRepository } from '../src/outbox/outbox.repository'
import { SyncWorker } from '../src/outbox/sync.worker'
import { SsoAppsRepository, type SsoAppInput } from '../src/sso-apps/sso-apps.repository'
import { UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

/**
 * Deliberately NOT appended to sync.worker.spec.ts, which starts a real
 * Keycloak container and is already the most round-trip-dense spec in the
 * suite. The `sso_app` path never touches Keycloak's user or group API — it
 * goes through `resolveSsoConnector`, which this file fakes — so requiring a
 * Keycloak container here would buy nothing and cost a container per run.
 *
 * A definitely-closed local port: the worker's constructor requires a
 * KeycloakAdminClient, and nothing on this path may ever call it. Pointing it
 * at a dead port means an accidental call fails FAST and loudly rather than
 * quietly succeeding against a real server.
 */
const UNREACHABLE_ISSUER = 'http://127.0.0.1:1/realms/unreachable'

const BASE_INPUT: SsoAppInput = {
  clientId: 'billing-portal',
  name: 'Billing Portal',
  description: 'Customer billing',
  protocol: 'openid-connect',
  publicClient: false,
  redirectUris: ['https://billing.example.com/cb'],
  webOrigins: ['https://billing.example.com'],
  groupsClaim: true,
}

describe('SyncWorker — sso_app aggregate', () => {
  const ctx = withTestDatabase()
  let apps: SsoAppsRepository
  let lastDesired: DesiredSsoApp | null
  let applyCalls: number
  let worker: SyncWorker

  function fakeSsoConnector(externalId = 'uuid-billing-portal'): SsoConnector {
    return {
      async planApp() {
        return []
      },
      async applyApp(desired) {
        lastDesired = desired
        applyCalls += 1
        return { externalId }
      },
      async health() {
        return { ok: true, detail: 'fake' }
      },
    }
  }

  function buildWorker(connector: SsoConnector | null): SyncWorker {
    const registry = {
      // Only the SSO path is exercised here; `resolve` throwing makes an
      // accidental fall-through to the directory family loud.
      resolve() {
        throw new Error('sso_app reconciliation must not resolve a DirectoryConnector')
      },
      async resolveSsoConnector() {
        return connector
      },
    } as unknown as ConnectorRegistry

    return new SyncWorker(
      ctx.db,
      new OutboxRepository(),
      new UsersRepository(ctx.db),
      new GroupsRepository(ctx.db),
      new KeycloakAdminClient({
        issuer: UNREACHABLE_ISSUER,
        clientId: 'unused',
        clientSecret: 'unused',
      }),
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, pollIntervalMs: 1_000 },
      registry,
    )
  }

  async function enqueue(aggregateId: string, target = 'keycloak_sso'): Promise<void> {
    await ctx.pool.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, target)
       VALUES ('sso_app', $1, 'created', '{}'::jsonb, $2::outbox_target)`,
      [aggregateId, target],
    )
  }

  async function seedApp(overrides: Partial<SsoAppInput> = {}) {
    return ctx.db.transaction((tx) => apps.create({ ...BASE_INPUT, ...overrides }, tx))
  }

  beforeEach(async () => {
    await ctx.pool.query('DELETE FROM outbox_events')
    await ctx.pool.query('DELETE FROM external_sso_app_identities')
    await ctx.pool.query('DELETE FROM sso_apps')
    apps = new SsoAppsRepository(ctx.db)
    lastDesired = null
    applyCalls = 0
    worker = buildWorker(fakeSsoConnector())
  })

  it('reconciles an sso_app event and records the Keycloak UUID', async () => {
    const app = await seedApp()
    await enqueue(app.id)

    await expect(worker.runOnce()).resolves.toBe('processed')

    const { rows } = await ctx.pool.query(
      'SELECT external_id, sync_state, system FROM external_sso_app_identities WHERE app_id = $1',
      [app.id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].external_id).toBe('uuid-billing-portal')
    expect(rows[0].sync_state).toBe('synced')
    expect(rows[0].system).toBe('keycloak_sso')
  })

  it('marks the event done', async () => {
    const app = await seedApp()
    await enqueue(app.id)

    await worker.runOnce()

    const { rows } = await ctx.pool.query('SELECT status FROM outbox_events')
    expect(rows[0].status).toBe('done')
  })

  it('builds the desired state from the local row, which is the system of record', async () => {
    const app = await seedApp({ publicClient: true, groupsClaim: false })
    await enqueue(app.id)

    await worker.runOnce()

    expect(lastDesired).toMatchObject({
      clientId: 'billing-portal',
      name: 'Billing Portal',
      publicClient: true,
      groupsClaim: false,
      enabled: true,
      redirectUris: ['https://billing.example.com/cb'],
    })
  })

  it('carries the SAML columns into the desired state', async () => {
    const app = await seedApp({
      clientId: 'https://hr.example.com/saml/metadata',
      protocol: 'saml',
      redirectUris: [],
      webOrigins: [],
      samlAcsUrls: ['https://hr.example.com/saml/acs'],
      samlSpCertificate: null,
      samlSignAssertions: true,
      samlNameIdFormat: 'email',
    })
    await enqueue(app.id)

    await worker.runOnce()

    expect(lastDesired).toMatchObject({
      clientId: 'https://hr.example.com/saml/metadata',
      protocol: 'saml',
      samlAcsUrls: ['https://hr.example.com/saml/acs'],
      samlSignAssertions: true,
      samlNameIdFormat: 'email',
    })
    // null -> undefined at the worker boundary: DesiredSsoApp spells "no
    // certificate" as undefined-or-null, and the row's null passes through.
    expect(lastDesired?.samlSpCertificate ?? null).toBeNull()
  })

  it('passes the stored external id back so a renamed clientId still correlates', async () => {
    // Without this the connector would fall back to looking the client up by
    // clientId, and an admin who renamed it in Keycloak would get an orphan
    // plus a second, empty client on this very sync.
    const app = await seedApp()
    await ctx.pool.query(
      `INSERT INTO external_sso_app_identities (app_id, system, external_id, sync_state)
       VALUES ($1, 'keycloak_sso', 'uuid-from-a-previous-sync', 'synced')`,
      [app.id],
    )
    await enqueue(app.id)

    await worker.runOnce()

    expect(lastDesired?.existingExternalId).toBe('uuid-from-a-previous-sync')
  })

  it('omits existingExternalId before the first sync', async () => {
    const app = await seedApp()
    await enqueue(app.id)

    await worker.runOnce()

    expect(lastDesired?.existingExternalId).toBeUndefined()
  })

  it('carries a disabled application through as enabled: false rather than deleting it', async () => {
    const app = await seedApp()
    await ctx.db.transaction((tx) => apps.setEnabled(app.id, false, tx))
    await enqueue(app.id)

    await worker.runOnce()

    expect(lastDesired?.enabled).toBe(false)
  })

  it('updates the correlation row in place on a re-sync rather than inserting a second', async () => {
    const app = await seedApp()
    await enqueue(app.id)
    await worker.runOnce()
    await enqueue(app.id)
    await worker.runOnce()

    expect(applyCalls).toBe(2)
    const { rows } = await ctx.pool.query(
      'SELECT count(*)::int AS n FROM external_sso_app_identities WHERE app_id = $1',
      [app.id],
    )
    expect(rows[0].n).toBe(1)
  })

  it('fails the event when the target implements no SSO connector', async () => {
    const app = await seedApp()
    await enqueue(app.id)
    worker = buildWorker(null)

    await worker.runOnce()

    const { rows } = await ctx.pool.query('SELECT status, last_error FROM outbox_events')
    expect(rows[0].status).toBe('pending')
    expect(rows[0].last_error).toMatch(/implements no SSO connector/)
  })

  it('fails the event when the application row is gone', async () => {
    // Not silently done: an event whose aggregate cannot be loaded is a real
    // inconsistency, and draining it quietly would hide that.
    await enqueue('00000000-0000-0000-0000-000000000000')

    await worker.runOnce()

    const { rows } = await ctx.pool.query('SELECT status, last_error FROM outbox_events')
    expect(rows[0].last_error).toMatch(/no SSO application found/)
  })
})
