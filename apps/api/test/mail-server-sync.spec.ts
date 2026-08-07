import { beforeAll, describe, expect, it } from 'vitest'
import { ConnectorRegistry } from '../src/connectors/connector-registry'
import { externalIdentitySystem } from '../src/db/schema/external-identities'
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
})
