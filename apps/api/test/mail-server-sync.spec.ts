import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { NotApplicableError } from '../src/connectors/connector'
import { ConnectorRegistry } from '../src/connectors/connector-registry'
import { EchoConnector } from '../src/connectors/echo.connector'
import { connectorTargets } from '../src/db/schema/connector-targets'
import { externalIdentities, externalIdentitySystem } from '../src/db/schema/external-identities'
import { outboxTarget } from '../src/db/schema/outbox-events'
import { GroupsRepository } from '../src/groups/groups.repository'
import { KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OutboxRepository } from '../src/outbox/outbox.repository'
import { SyncWorker } from '../src/outbox/sync.worker'
import { type User, UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'

describe('mail_server target registration', () => {
  it('is a member of the outbox_target enum', () => {
    expect(outboxTarget.enumValues).toContain('mail_server')
  })

  it('is a member of the external_identity_system enum', () => {
    expect(externalIdentitySystem.enumValues).toContain('mail_server')
  })

  it('keeps the two enums one-for-one, so event.target is assignable as system', () => {
    expect([...outboxTarget.enumValues].sort()).toEqual([...externalIdentitySystem.enumValues].sort())
  })
})

describe('mail server connector (DB-backed)', () => {
  const ctx = withTestDatabase()
  const usersRepo = () => new UsersRepository(ctx.db)
  const groupsRepo = () => new GroupsRepository(ctx.db)
  const outboxRepo = () => new OutboxRepository()

  let orgUnitId: string
  let tag = 0
  const nextTag = () => ++tag

  // `buildDesiredUser` never touches Keycloak, and KeycloakAdminClient does
  // no network I/O at construction — so a client pointed at an unreachable
  // issuer is enough, and this file needs no Keycloak container.
  const unusedKeycloak = () =>
    new KeycloakAdminClient({
      // Must contain /realms/<name> — KeycloakAdminClient validates its
      // issuer shape at construction (but makes no network call there).
      issuer: 'http://keycloak.invalid/realms/unused',
      clientId: 'unused',
      clientSecret: 'unused',
      requestTimeoutMs: 1_000,
    })

  const makeWorker = (registry?: ConnectorRegistry) =>
    new SyncWorker(ctx.db, outboxRepo(), usersRepo(), groupsRepo(), unusedKeycloak(), undefined, registry)

  beforeAll(async () => {
    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`Mail Connector Root ${Date.now()}`)).id
  })

  async function makeUser(attributes?: Record<string, unknown>): Promise<User> {
    const t = nextTag()
    const username = `mail-user-${t}@acme.com`.toLowerCase()
    return usersRepo().create({
      primaryEmail: username,
      username,
      firstName: 'Mail',
      lastName: `User${t}`,
      orgUnitId,
      attributes,
    })
  }

  /** A user is created `pending`, and the lifecycle forbids `pending -> suspended` — so reaching any later status goes through `active` first. */
  async function makeUserWithStatus(status: 'pending' | 'active' | 'suspended' | 'deactivated'): Promise<User> {
    const user = await makeUser()
    if (status === 'pending') {
      return user
    }
    const active = await usersRepo().changeStatus(user.id, 'active')
    return status === 'active' ? active : usersRepo().changeStatus(user.id, status)
  }

  /** `buildDesiredUser` takes a `DbHandle` (a transaction), the same way every production caller reaches it — see TargetReconciliationJob, which wraps its own call identically. */
  const desiredFor = (user: User, target: Parameters<SyncWorker['buildDesiredUser']>[2]) =>
    ctx.db.transaction((tx) => makeWorker().buildDesiredUser(tx, user, target))

  describe('DesiredUser.userId', () => {
    it("carries this system's own user id, for every target", async () => {
      const user = await makeUser()
      const desired = await desiredFor(user, 'keycloak')
      expect(desired.userId).toBe(user.id)
    })
  })

  describe('DesiredUser.status', () => {
    it('carries the full four-value status for mail_server', async () => {
      const suspended = await makeUserWithStatus('suspended')

      const desired = await desiredFor(suspended, 'mail_server')
      expect(desired.status).toBe('suspended')
    })

    it('distinguishes suspended from deactivated, which enabled cannot', async () => {
      const suspended = await makeUserWithStatus('suspended')
      const deactivated = await makeUserWithStatus('deactivated')

      const a = await desiredFor(suspended, 'mail_server')
      const b = await desiredFor(deactivated, 'mail_server')

      // The distinction `enabled` alone loses — and the one that decides
      // whether the counterpart stamps `deactivated_at` and starts its
      // retention clock. Conflating these is data loss, not lost fidelity.
      expect(a.enabled).toBe(b.enabled)
      expect(a.status).not.toBe(b.status)
    })

    it('is undefined for every other target', async () => {
      const user = await makeUser()
      for (const target of ['keycloak', 'echo', 'active_directory', 'entra_id', 'google_workspace'] as const) {
        const desired = await desiredFor(user, target)
        expect(desired.status).toBeUndefined()
      }
    })
  })

  describe('correlation gate', () => {
    it('gives mail_server its prior external id, so it can tell create from entitlement-removal', async () => {
      const user = await makeUser()
      await ctx.db.insert(externalIdentities).values({
        userId: user.id,
        system: 'mail_server',
        externalId: user.id,
        lastSyncedAt: new Date(),
        syncState: 'synced',
      })

      const desired = await desiredFor(user, 'mail_server')
      expect(desired.existingExternalId).toBe(user.id)
    })

    it('does not pay for managed attribute names mail_server never reads', async () => {
      const user = await makeUser()
      const desired = await desiredFor(user, 'mail_server')
      expect(desired.managedAttributeRemoteNames).toBeUndefined()
    })

    it('leaves both halves populated for every target already in the gate', async () => {
      const user = await makeUser()
      for (const target of ['active_directory', 'entra_id', 'google_workspace'] as const) {
        const desired = await desiredFor(user, target)
        expect(desired.managedAttributeRemoteNames).toBeDefined()
        expect(desired.existingExternalId).toBeUndefined()
      }
    })
  })

  // Exercised against `echo` rather than `mail_server`: the handling is
  // entirely generic, and testing it here keeps it independent of the mail
  // connector's own existence and registration.
  describe('NotApplicableError', () => {
    // Inserted directly rather than by a migration — Postgres forbids using
    // an enum value inside the transaction that added it, which is why every
    // non-keycloak target's tests already seed their own row this way.
    async function enableEcho(): Promise<void> {
      await ctx.db
        .insert(connectorTargets)
        .values({ target: 'echo', enabled: true, config: { credentialSecretName: 'ECHO_SECRET' } })
        .onConflictDoUpdate({ target: connectorTargets.target, set: { enabled: true } })
      process.env.ECHO_SECRET = 'test-secret'
    }

    const identityRows = (userId: string) =>
      ctx.db
        .select()
        .from(externalIdentities)
        .where(and(eq(externalIdentities.userId, userId), eq(externalIdentities.system, 'echo')))

    function workerWithEcho(applyImpl: () => Promise<never>): SyncWorker {
      const echo = new EchoConnector()
      echo.apply = applyImpl
      return makeWorker(new ConnectorRegistry(unusedKeycloak(), echo))
    }

    it('completes without writing a correlation row', async () => {
      await enableEcho()
      const user = await makeUserWithStatus('active')
      const worker = workerWithEcho(async () => {
        throw new NotApplicableError('echo', 'nothing to represent for this principal')
      })

      await expect(
        ctx.db.transaction((tx) => worker.reconcileUser(tx, user.id, 'echo')),
      ).resolves.toBeUndefined()

      expect(await identityRows(user.id)).toHaveLength(0)
    })

    it('still propagates every other error, so real failures retry', async () => {
      await enableEcho()
      const user = await makeUserWithStatus('active')
      const worker = workerWithEcho(async () => {
        throw new Error('target returned 503')
      })

      await expect(
        ctx.db.transaction((tx) => worker.reconcileUser(tx, user.id, 'echo')),
      ).rejects.toThrow('503')
    })
  })
})
