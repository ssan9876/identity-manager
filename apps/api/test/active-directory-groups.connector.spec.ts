import { randomUUID } from 'node:crypto'
import { Client, EqualityFilter } from 'ldapts'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ActiveDirectoryConnector,
  type ActiveDirectoryConnectorConfig,
} from '../src/connectors/active-directory.connector'
import { guidStringToBuffer } from '../src/connectors/ad-guid'
import type { DesiredGroup, DesiredUser } from '../src/connectors/connector'
import { ConnectorRegistry } from '../src/connectors/connector-registry'
import { type Group, GroupsRepository } from '../src/groups/groups.repository'
import { KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OutboxRepository } from '../src/outbox/outbox.repository'
import { OutboxWriter } from '../src/outbox/outbox.writer'
import { SyncWorker } from '../src/outbox/sync.worker'
import { type User, UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'
import { startSambaAd, type TestSambaAd } from './support/samba-ad'

const UNREACHABLE_ISSUER = 'http://127.0.0.1:1/realms/unreachable'
const AD_SECRET_NAME = 'AD_GROUP_TEST_SECRET'
// MS-ADTS 2.2.13 — Global Security group, signed-int32 encoding. Mirrors the
// connector's own `GROUP_TYPE_GLOBAL_SECURITY` constant; re-derived here
// rather than imported, matching this test suite's own established
// "assert against the wire, not against the implementation's own constant"
// discipline (active-directory.connector.spec.ts does the same for the UAC
// bits).
const GROUP_TYPE_GLOBAL_SECURITY = -2147483646
// LDAP_MATCHING_RULE_IN_CHAIN — AD's transitive-closure matching rule,
// usable on any DN-valued linked attribute. Applied to `memberOf` (the
// automatic back-link of `member`), it finds every object transitively
// reachable DOWN from a group, at any depth — confirmed empirically against
// the real Samba container this suite runs against before this file was
// written (see task-6-report.md).
const MATCHING_RULE_IN_CHAIN = '1.2.840.113556.1.4.1941'

function unreachableKeycloak(): KeycloakAdminClient {
  return new KeycloakAdminClient({
    issuer: UNREACHABLE_ISSUER,
    clientId: 'irrelevant',
    clientSecret: 'irrelevant',
  })
}

/** Same shape/reasoning as active-directory.connector.spec.ts's own `assertNoLeak`. */
function assertNoLeak(haystack: string, sentinel: string, where: string): void {
  if (haystack.includes(sentinel)) {
    throw new Error(`SECRET LEAK in ${where}: sentinel value found — "${haystack}"`)
  }
}

function toStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value.map(String) : [String(value)]
}

/**
 * MILESTONE 11, TASK 6 — AD groups and membership, against the REAL Samba AD
 * container (test/support/samba-ad.ts) and a REAL Postgres Testcontainer.
 * Two tiers, mirroring active-directory.connector.spec.ts's own split:
 *
 *  - CONNECTOR-LEVEL tests construct `ActiveDirectoryConnector` directly and
 *    call `planGroup`/`applyGroup` with hand-built `DesiredGroup` values —
 *    the fastest, most precise way to prove the CONNECTOR's own mechanics
 *    (create/rename/membership-diff, atomicity, secret hygiene). These
 *    never touch `GroupsRepository`/`SyncWorker` at all.
 *  - SYNCWORKER-LEVEL tests go through real `groups`/`users` Postgres rows
 *    and `SyncWorker.reconcileGroup`, because the NATIVE-nesting-vs-
 *    FLATTEN decision itself (`ActiveDirectoryConnector`'s own "THE NESTING
 *    DECISION" doc comment) is that class's computation, not the
 *    connector's — the connector only ever sees an already-decided
 *    `memberExternalIds` list.
 */
describe('ActiveDirectoryConnector groups and membership (Milestone 11, Task 6)', () => {
  const ctx = withTestDatabase()
  let ad: TestSambaAd
  let orgUnitId: string

  beforeAll(async () => {
    ad = await startSambaAd()
    process.env[AD_SECRET_NAME] = ad.adminPassword
    orgUnitId = (await new OrgUnitsRepository(ctx.db).createRoot(`AD Groups Root ${randomUUID()}`)).id
    await ctx.pool.query(
      `INSERT INTO connector_targets (target, enabled, config) VALUES ('active_directory', true, $1)
       ON CONFLICT (target) DO UPDATE SET enabled = true, config = $1`,
      [JSON.stringify(baseConfig())],
    )
  }, 300_000)

  afterAll(async () => {
    delete process.env[AD_SECRET_NAME]
    await ad?.stop()
  }, 60_000)

  // -----------------------------------------------------------------------
  // Shared fixtures
  // -----------------------------------------------------------------------

  function baseConfig(overrides: Partial<ActiveDirectoryConnectorConfig> = {}): Record<string, unknown> {
    const config: Record<string, unknown> = {
      url: ad.url,
      baseDN: ad.baseDN,
      bindDN: ad.adminDN,
      credentialSecretName: AD_SECRET_NAME,
      caCertificate: ad.caCertificatePem,
      tlsServerName: ad.tlsServerName,
      createMissingOrgUnits: true,
      ...overrides,
    }
    for (const key of Object.keys(config)) {
      if (config[key] === undefined) delete config[key]
    }
    return config
  }

  function makeConnector(): ActiveDirectoryConnector {
    const connector = new ActiveDirectoryConnector()
    connector.configure(baseConfig())
    return connector
  }

  function usersRepo(): UsersRepository {
    return new UsersRepository(ctx.db)
  }
  function groupsRepo(): GroupsRepository {
    return new GroupsRepository(ctx.db)
  }
  function outboxRepo(): OutboxRepository {
    return new OutboxRepository()
  }

  function makeWorker(): SyncWorker {
    const registry = new ConnectorRegistry(unreachableKeycloak())
    return new SyncWorker(ctx.db, outboxRepo(), usersRepo(), groupsRepo(), unreachableKeycloak(), undefined, registry)
  }

  async function syncUserToAd(userId: string): Promise<void> {
    await ctx.db.transaction((tx) => makeWorker().reconcileUser(tx, userId, 'active_directory'))
  }

  async function syncGroupToAd(groupId: string): Promise<void> {
    await ctx.db.transaction((tx) => makeWorker().reconcileGroup(tx, groupId, 'active_directory'))
  }

  let userSeq = 0
  function nextUsername(): string {
    userSeq += 1
    return `adgu${userSeq}`
  }

  async function makeActiveUser(): Promise<User> {
    const username = nextUsername()
    const user = await usersRepo().create({
      primaryEmail: `${username}@example.com`,
      username,
      firstName: 'Grp',
      lastName: 'Member',
      orgUnitId,
    })
    await usersRepo().changeStatus(user.id, 'active')
    return user
  }

  function baseDesiredUser(overrides: Partial<DesiredUser> = {}): DesiredUser {
    const username = nextUsername()
    return {
      userId: '00000000-0000-4000-8000-000000000001',
      username,
      email: `${username}@example.com`,
      firstName: 'Test',
      lastName: 'User',
      enabled: true,
      attributes: {},
      groups: [],
      orgUnitPath: [],
      ...overrides,
    }
  }

  let groupSeq = 0
  function nextGroupName(): string {
    groupSeq += 1
    return `adgrp${groupSeq}`
  }

  async function makeGroup(): Promise<Group> {
    return groupsRepo().create({ name: nextGroupName() })
  }

  function groupDn(name: string): string {
    return `CN=${name},${ad.baseDN}`
  }

  function freshClient(): Client {
    return new Client({ url: ad.url, tlsOptions: { ca: ad.caCertificatePem, servername: ad.tlsServerName } })
  }

  async function searchGroupBySam(name: string, attributes: string[] = ['*']) {
    const client = freshClient()
    await client.bind(ad.adminDN, ad.adminPassword)
    try {
      return await client.search(ad.baseDN, {
        scope: 'sub',
        filter: `(&(objectClass=group)(sAMAccountName=${name}))`,
        attributes,
        explicitBufferAttributes: ['objectGUID'],
      })
    } finally {
      await client.unbind()
    }
  }

  async function readMemberDns(dn: string): Promise<string[]> {
    const client = freshClient()
    await client.bind(ad.adminDN, ad.adminPassword)
    try {
      const { searchEntries } = await client.search(dn, {
        scope: 'base',
        filter: '(objectClass=*)',
        attributes: ['member'],
      })
      return toStringArray((searchEntries[0] as unknown as Record<string, unknown>)?.member)
    } finally {
      await client.unbind()
    }
  }

  /** Resolves an objectGUID to its CURRENT dn, over a FRESH bind — independent of the connector under test, the same "prove it, do not trust the implementation's own bookkeeping" discipline this whole suite follows. */
  async function findDnByGuidFresh(externalId: string): Promise<string> {
    const client = freshClient()
    await client.bind(ad.adminDN, ad.adminPassword)
    try {
      const { searchEntries } = await client.search(ad.baseDN, {
        scope: 'sub',
        filter: new EqualityFilter({ attribute: 'objectGUID', value: guidStringToBuffer(externalId) }),
        attributes: ['distinguishedName'],
      })
      return String((searchEntries[0] as unknown as Record<string, unknown>).dn)
    } finally {
      await client.unbind()
    }
  }

  /** AD's OWN transitive membership computation — every user reachable DOWN from `dn`, at any depth, via the LDAP_MATCHING_RULE_IN_CHAIN OID against `memberOf`. This is what "the app's effective membership and AD's, compared directly" actually queries. */
  async function adEffectiveUsernames(dn: string): Promise<string[]> {
    const client = freshClient()
    await client.bind(ad.adminDN, ad.adminPassword)
    try {
      const { searchEntries } = await client.search(ad.baseDN, {
        scope: 'sub',
        filter: `(&(objectClass=user)(memberOf:${MATCHING_RULE_IN_CHAIN}:=${dn}))`,
        attributes: ['sAMAccountName'],
      })
      return searchEntries.map((e) => String((e as unknown as Record<string, unknown>).sAMAccountName)).sort()
    } finally {
      await client.unbind()
    }
  }

  function lower(dns: string[]): string[] {
    return dns.map((d) => d.toLowerCase()).sort()
  }

  /**
   * `ldapts` returns an EMPTY ARRAY (`[]`), not `undefined`, for an
   * attribute EXPLICITLY requested by name on an entry with no value for
   * it — same empirically-confirmed normalisation
   * active-directory.connector.spec.ts's own `expectAbsent` already
   * documents, re-derived here since this is a separate spec file.
   */
  function expectAbsent(value: unknown): void {
    if (Array.isArray(value)) {
      expect(value).toEqual([])
    } else {
      expect(value).toBeUndefined()
    }
  }

  // =========================================================================
  // CONNECTOR-LEVEL: create, then read back over a fresh LDAP bind
  // =========================================================================
  describe('applyGroup — create, then read back over a fresh LDAP bind', () => {
    it('creates an empty group as a Global Security group, correlated by a real objectGUID', async () => {
      const connector = makeConnector()
      const desired: DesiredGroup = { name: nextGroupName(), memberExternalIds: [] }

      const { externalId } = await connector.applyGroup(desired)
      expect(externalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

      const { searchEntries } = await searchGroupBySam(desired.name, ['sAMAccountName', 'groupType', 'member', 'objectGUID'])
      expect(searchEntries).toHaveLength(1)
      const entry = searchEntries[0] as unknown as Record<string, unknown>
      expect(entry.sAMAccountName).toBe(desired.name)
      expect(Number(entry.groupType)).toBe(GROUP_TYPE_GLOBAL_SECURITY)
      expectAbsent(entry.member)
    })

    it('creates a group carrying its initial member list in ONE atomic add() — no separate modify needed', async () => {
      const connector = makeConnector()
      const { externalId: userExtId } = await connector.apply(baseDesiredUser())
      const desired: DesiredGroup = { name: nextGroupName(), memberExternalIds: [userExtId] }

      await connector.applyGroup(desired)

      const { searchEntries } = await searchGroupBySam(desired.name, ['member'])
      const members = toStringArray((searchEntries[0] as unknown as Record<string, unknown>).member)
      expect(members).toHaveLength(1)
    })

    it('a member id AD no longer recognises is skipped rather than failing the whole group', async () => {
      const connector = makeConnector()
      const fakeGuid = '00000000-0000-0000-0000-000000000000'
      const desired: DesiredGroup = { name: nextGroupName(), memberExternalIds: [fakeGuid] }

      await expect(connector.applyGroup(desired)).resolves.toEqual({ externalId: expect.any(String) })
      const { searchEntries } = await searchGroupBySam(desired.name, ['member'])
      expectAbsent((searchEntries[0] as unknown as Record<string, unknown>).member)
    })
  })

  // =========================================================================
  // CONNECTOR-LEVEL: update — reconciles membership to desired state
  // =========================================================================
  describe('applyGroup — reconciles membership to desired state, idempotently', () => {
    it('adds and removes members across repeated applyGroup calls; a second identical apply is a genuine no-op per planGroup', async () => {
      const connector = makeConnector()
      const { externalId: u1 } = await connector.apply(baseDesiredUser())
      const { externalId: u2 } = await connector.apply(baseDesiredUser())
      const name = nextGroupName()

      await connector.applyGroup({ name, memberExternalIds: [u1] })
      let members = await readMemberDns(groupDn(name))
      expect(members).toHaveLength(1)

      await connector.applyGroup({ name, memberExternalIds: [u1, u2] })
      members = await readMemberDns(groupDn(name))
      expect(members).toHaveLength(2)

      expect(await connector.planGroup({ name, memberExternalIds: [u1, u2] })).toEqual([])

      // A third, unchanged apply is a no-op — no duplicate entry, no error.
      await connector.applyGroup({ name, memberExternalIds: [u1, u2] })
      const { searchEntries } = await searchGroupBySam(name)
      expect(searchEntries).toHaveLength(1)
    })

    it('removing one member removes EXACTLY that edge and leaves the rest intact', async () => {
      const connector = makeConnector()
      const { externalId: keep1 } = await connector.apply(baseDesiredUser())
      const { externalId: keep2 } = await connector.apply(baseDesiredUser())
      const { externalId: removeMe } = await connector.apply(baseDesiredUser())
      const name = nextGroupName()

      await connector.applyGroup({ name, memberExternalIds: [keep1, keep2, removeMe] })
      expect(await readMemberDns(groupDn(name))).toHaveLength(3)

      await connector.applyGroup({ name, memberExternalIds: [keep1, keep2] })
      const members = await readMemberDns(groupDn(name))
      expect(members).toHaveLength(2)
      const removedDn = await findDnByGuidFresh(removeMe)
      expect(lower(members)).not.toContain(removedDn.toLowerCase())
    })
  })

  // =========================================================================
  // CONNECTOR-LEVEL: rename preserves membership — the central Task 6
  // guarantee for groups.
  // =========================================================================
  describe('group rename preserves membership — verified over a fresh bind', () => {
    it('renaming a group with existing members carries every member over to the new DN, with no member re-write from this connector', async () => {
      const connector = makeConnector()
      const { externalId: memberId } = await connector.apply(baseDesiredUser())
      const oldName = nextGroupName()
      const { externalId: groupId } = await connector.applyGroup({ name: oldName, memberExternalIds: [memberId] })

      const newName = `${oldName}ren`
      const { externalId: groupId2 } = await connector.applyGroup({
        name: newName,
        memberExternalIds: [memberId],
        existingExternalId: groupId,
      })
      expect(groupId2).toBe(groupId) // same AD object, not a duplicate

      const byNewName = await searchGroupBySam(newName, ['distinguishedName', 'member'])
      expect(byNewName.searchEntries).toHaveLength(1)
      const entry = byNewName.searchEntries[0] as unknown as Record<string, unknown>
      expect(String(entry.dn).toLowerCase()).toBe(groupDn(newName).toLowerCase())
      expect(toStringArray(entry.member)).toHaveLength(1)

      const byOldName = await searchGroupBySam(oldName)
      expect(byOldName.searchEntries).toHaveLength(0) // no duplicate left under the old name
    })
  })

  // =========================================================================
  // CONNECTOR-LEVEL: secret resolution never leaks — extends Milestone 10
  // Task 2 / Milestone 11 Task 5's proof to planGroup/applyGroup.
  // =========================================================================
  describe('secret resolution never leaks (extends Task 5 to planGroup/applyGroup)', () => {
    it('the bind password never appears in planGroup/applyGroup responses, thrown errors, or console output', async () => {
      const secretName = `AD_GROUP_LEAK_TEST_${randomUUID().replace(/-/g, '_')}`
      process.env[secretName] = ad.adminPassword
      const sentinel = ad.adminPassword

      const loggedArgs: string[] = []
      const capture = (...args: unknown[]) => {
        loggedArgs.push(
          args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : String(a))).join(' '),
        )
      }
      const spies = [
        vi.spyOn(console, 'log').mockImplementation(capture),
        vi.spyOn(console, 'error').mockImplementation(capture),
        vi.spyOn(console, 'warn').mockImplementation(capture),
      ]

      try {
        const connector = new ActiveDirectoryConnector()
        connector.configure(baseConfig({ credentialSecretName: secretName }))
        const desired: DesiredGroup = { name: nextGroupName(), memberExternalIds: [] }

        const planResult = await connector.planGroup(desired)
        assertNoLeak(JSON.stringify(planResult), sentinel, 'planGroup() response body')

        const applyResult = await connector.applyGroup(desired)
        assertNoLeak(JSON.stringify(applyResult), sentinel, 'applyGroup() response body')

        const badConnector = new ActiveDirectoryConnector()
        badConnector.configure(baseConfig({ credentialSecretName: `${secretName}_TYPO` }))
        try {
          await badConnector.applyGroup({ name: nextGroupName(), memberExternalIds: [] })
          throw new Error('expected applyGroup to fail for a bad secret name')
        } catch (error) {
          assertNoLeak(
            error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
            sentinel,
            'applyGroup() thrown error (missing-secret path)',
          )
        }

        assertNoLeak(loggedArgs.join('\n'), sentinel, 'console.log/warn/error output')
      } finally {
        delete process.env[secretName]
        for (const spy of spies) spy.mockRestore()
      }
    })
  })

  // =========================================================================
  // SYNCWORKER-LEVEL: the nesting decision — native AD nesting vs flattened
  // effective membership. THE central Task 6 proof: "nested membership
  // resolves to the same effective set on both sides."
  // =========================================================================
  describe('the nesting decision: native AD nesting vs flattened effective membership', () => {
    it('a deep chain + a diamond, fully correlated, converge to NATIVE AD nesting whose own transitive membership matches this app\'s effective membership exactly', async () => {
      // grandchild -- contains --> leafUser
      // child      -- contains --> grandchild
      // parent     -- contains --> child, AND a direct user (directUser)
      const grandchild = await makeGroup()
      const child = await makeGroup()
      const parent = await makeGroup()
      const leafUser = await makeActiveUser()
      const directUser = await makeActiveUser()

      await syncUserToAd(leafUser.id)
      await syncUserToAd(directUser.id)

      await groupsRepo().addUser(grandchild.id, leafUser.id)
      await syncGroupToAd(grandchild.id) // correlate grandchild FIRST

      await groupsRepo().addChildGroup(child.id, grandchild.id)
      await syncGroupToAd(child.id) // child natively nests grandchild

      await groupsRepo().addChildGroup(parent.id, child.id)
      await groupsRepo().addUser(parent.id, directUser.id)
      await syncGroupToAd(parent.id) // parent natively nests child + direct user

      // STRUCTURAL proof: each group's OWN direct `member` list is exactly
      // its local direct edges, expressed as NATIVE nested DNs — not a
      // flattened stand-in anywhere in this chain (every link was already
      // correlated before its parent synced).
      const grandchildMembers = await readMemberDns(groupDn(grandchild.name))
      expect(grandchildMembers).toHaveLength(1)
      const childMembers = await readMemberDns(groupDn(child.name))
      expect(childMembers).toHaveLength(1)
      expect(lower(childMembers)).toContain(groupDn(grandchild.name).toLowerCase())
      const parentMembers = await readMemberDns(groupDn(parent.name))
      expect(parentMembers).toHaveLength(2)
      expect(lower(parentMembers)).toContain(groupDn(child.name).toLowerCase())

      // THE central proof: AD's OWN transitive computation (matching-rule-
      // in-chain over memberOf) and this app's OWN recursive computation
      // (listEffectiveUserMembers) name the SAME set of users under parent.
      const adSide = await adEffectiveUsernames(groupDn(parent.name))
      const effectiveUserIds = await groupsRepo().listEffectiveUserMembers(parent.id)
      const effectiveUsers = await Promise.all(effectiveUserIds.map((id) => usersRepo().findById(id)))
      const appSide = effectiveUsers.map((u) => u?.username).filter((u): u is string => !!u).sort()

      expect(adSide).toEqual([leafUser.username, directUser.username].sort())
      expect(adSide).toEqual(appSide)
    })

    it('a child group not yet synced to AD is FLATTENED into its parent directly; the next reconcile UPGRADES it to a native nested edge once the child itself has synced', async () => {
      const child = await makeGroup()
      const parent = await makeGroup()
      const user = await makeActiveUser()
      await syncUserToAd(user.id)

      await groupsRepo().addUser(child.id, user.id)
      // Deliberately DO NOT sync the child yet — it has no AD presence, no
      // external_group_identities row.
      await groupsRepo().addChildGroup(parent.id, child.id)

      await syncGroupToAd(parent.id)

      // FLATTENED: parent's direct member is the USER's DN, never a
      // reference to the (not-yet-existing) child group.
      const flattenedMembers = await readMemberDns(groupDn(parent.name))
      expect(flattenedMembers).toHaveLength(1)
      expect(lower(flattenedMembers)).not.toContain(groupDn(child.name).toLowerCase())
      // Still correct: AD's own transitive view already shows the right
      // effective user, even in the flattened shape.
      expect(await adEffectiveUsernames(groupDn(parent.name))).toEqual([user.username])

      // Now the child itself syncs ...
      await syncGroupToAd(child.id)
      // ... and a later parent reconcile self-heals into NATIVE nesting —
      // no special "upgrade" step, just desired state recomputed fresh.
      await syncGroupToAd(parent.id)

      const nativeMembers = await readMemberDns(groupDn(parent.name))
      expect(nativeMembers).toHaveLength(1)
      expect(lower(nativeMembers)).toContain(groupDn(child.name).toLowerCase())
      expect(await adEffectiveUsernames(groupDn(parent.name))).toEqual([user.username])
    })
  })

  // =========================================================================
  // SYNCWORKER-LEVEL: a group whose membership sync fails does not corrupt
  // the membership of another group.
  // =========================================================================
  describe('a group whose membership sync fails does not corrupt another group\'s membership', () => {
    it('group A succeeds; LDAP goes down; group B fails cleanly with NOTHING partially created; A is unaffected; B self-heals once LDAP is restored', async () => {
      const userA = await makeActiveUser()
      const userB = await makeActiveUser()
      await syncUserToAd(userA.id)
      await syncUserToAd(userB.id)

      const groupA = await makeGroup()
      await groupsRepo().addUser(groupA.id, userA.id)
      await syncGroupToAd(groupA.id)
      const aAfterFirst = await searchGroupBySam(groupA.name, ['member'])
      expect(aAfterFirst.searchEntries).toHaveLength(1)

      const groupB = await makeGroup()
      await groupsRepo().addUser(groupB.id, userB.id)

      await ad.interruptLdap()
      let groupBError: unknown
      try {
        await syncGroupToAd(groupB.id)
      } catch (error) {
        groupBError = error
      }
      expect(groupBError).toBeDefined()

      await ad.restoreLdap()

      // A: completely unaffected by B's failure — still present, still
      // correct.
      const aResult = await searchGroupBySam(groupA.name, ['member'])
      expect(aResult.searchEntries).toHaveLength(1)
      expect(toStringArray((aResult.searchEntries[0] as unknown as Record<string, unknown>).member)).toHaveLength(1)

      // B: NOTHING partially created — the group itself never reached AD.
      const bResult = await searchGroupBySam(groupB.name)
      expect(bResult.searchEntries).toHaveLength(0)

      // Self-heals: the very next reconcile for B succeeds now that LDAP is
      // back.
      await syncGroupToAd(groupB.id)
      const bAfterHeal = await searchGroupBySam(groupB.name, ['member'])
      expect(bAfterHeal.searchEntries).toHaveLength(1)
    }, 60_000)
  })

  // =========================================================================
  // END TO END: through the REAL outbox (GroupsController-shaped writes,
  // drained by the real worker) — proves the wiring, and that repeated
  // membership events converge to CURRENT desired state rather than
  // replaying a delta.
  // =========================================================================
  describe('end to end through the real outbox', () => {
    function outboxWriter(): OutboxWriter {
      return new OutboxWriter()
    }

    it('group + membership_changed events converge to current desired state, not a replayed delta', async () => {
      const parent = await makeGroup()
      const child = await makeGroup()
      const user1 = await makeActiveUser()
      const user2 = await makeActiveUser()
      await syncUserToAd(user1.id)
      await syncUserToAd(user2.id)
      await syncGroupToAd(child.id) // correlate the child up front

      await ctx.db.transaction(async (tx) => {
        await groupsRepo().addChildGroup(parent.id, child.id, tx)
        await outboxWriter().record(tx, {
          aggregateType: 'membership',
          aggregateId: parent.id,
          eventType: 'membership_changed',
          payload: { parentGroupId: parent.id, childGroupId: child.id, action: 'group:add_child_group' },
        })
      })
      await ctx.db.transaction(async (tx) => {
        await groupsRepo().addUser(parent.id, user1.id, tx)
        await outboxWriter().record(tx, {
          aggregateType: 'membership',
          aggregateId: parent.id,
          eventType: 'membership_changed',
          payload: { groupId: parent.id, userId: user1.id, action: 'group:add_member' },
        })
      })
      // Add THEN remove the same user before the worker ever drains —
      // "reconcile to desired state, never replay a delta" means the END
      // RESULT (user2 never a member) is what matters, not the two events
      // fired.
      await ctx.db.transaction(async (tx) => {
        await groupsRepo().addUser(parent.id, user2.id, tx)
        await outboxWriter().record(tx, {
          aggregateType: 'membership',
          aggregateId: parent.id,
          eventType: 'membership_changed',
          payload: { groupId: parent.id, userId: user2.id, action: 'group:add_member' },
        })
      })
      await ctx.db.transaction(async (tx) => {
        await groupsRepo().removeUser(parent.id, user2.id, tx)
        await outboxWriter().record(tx, {
          aggregateType: 'membership',
          aggregateId: parent.id,
          eventType: 'membership_changed',
          payload: { groupId: parent.id, userId: user2.id, action: 'group:remove_member' },
        })
      })

      const worker = makeWorker()
      const processed = await worker.drain()
      expect(processed).toBeGreaterThanOrEqual(4)

      const members = await readMemberDns(groupDn(parent.name))
      expect(members).toHaveLength(2) // child (native) + user1 — never user2
      expect(lower(members)).toContain(groupDn(child.name).toLowerCase())
      expect(await adEffectiveUsernames(groupDn(parent.name))).toEqual([user1.username])
    })
  })
})
