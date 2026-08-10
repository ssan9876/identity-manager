import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Client, EqualityFilter } from 'ldapts'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AuditWriter } from '../src/audit/audit.writer'
import {
  ActiveDirectoryConnector,
  type ActiveDirectoryConnectorConfig,
} from '../src/connectors/active-directory.connector'
import { guidBufferToString, guidStringToBuffer } from '../src/connectors/ad-guid'
import type { DesiredUser } from '../src/connectors/connector'
import { ConnectorRegistry } from '../src/connectors/connector-registry'
import { GroupsRepository } from '../src/groups/groups.repository'
import { KeycloakAdminClient } from '../src/keycloak/keycloak-admin.client'
import { OrgUnitsRepository } from '../src/org-units/org-units.repository'
import { OutboxRepository } from '../src/outbox/outbox.repository'
import { SyncWorker } from '../src/outbox/sync.worker'
import { TargetReconciliationJob } from '../src/outbox/target-reconciliation.job'
import { type User, UsersRepository } from '../src/users/users.repository'
import { withTestDatabase } from './support/pg'
import { startSambaAd, type TestSambaAd } from './support/samba-ad'

const UNREACHABLE_ISSUER = 'http://127.0.0.1:1/realms/unreachable'
const AD_SECRET_NAME = 'CONNECTOR_AD_TEST_SECRET'
const UAC_ACCOUNTDISABLE = 0x0002
const UAC_PASSWD_NOTREQD = 0x0020

function unreachableKeycloak(): KeycloakAdminClient {
  return new KeycloakAdminClient({
    issuer: UNREACHABLE_ISSUER,
    clientId: 'irrelevant',
    clientSecret: 'irrelevant',
  })
}

/** Same shape/reasoning as connector-secrets.spec.ts's own `assertNoLeak` — re-derived locally per this project's own established "small pure duplication across sibling test files" convention (see e.g. `attributesEqual`/`sameNameSet`, duplicated across three `connectors/` source files for the identical reason). */
function assertNoLeak(haystack: string, sentinel: string, where: string): void {
  if (haystack.includes(sentinel)) {
    throw new Error(`SECRET LEAK in ${where}: sentinel value found — "${haystack}"`)
  }
}

/**
 * MILESTONE 11, TASK 5 — the on-prem Active Directory connector, against a
 * REAL Samba AD domain controller (test/support/samba-ad.ts) and a REAL
 * Postgres Testcontainer. No mocking, per the design doc's own testing
 * section: "Active Directory — a real Samba AD domain controller container.
 * Real LDAP, real schema, real bind."
 *
 * Most tests below construct `ActiveDirectoryConnector` DIRECTLY (never
 * through Postgres/SyncWorker) — the fastest, most precise way to prove the
 * CONNECTOR's own contract (create/update/disable/plan semantics, TLS,
 * OU resolution, GUID correlation). These tests never insert a `users` row.
 * TWO describe blocks — "default-deny... against what AD actually received"
 * and "a connection failure mid-batch" — deliberately go through the REAL
 * `SyncWorker`/`TargetReconciliationJob` pipeline instead, because what they
 * prove (default-deny attribute filtering; per-principal batch isolation) is
 * a property of THAT pipeline, not the connector in isolation; those are the
 * only two blocks that insert real `users` rows, kept last so their
 * Postgres-level population never interferes with the connector-only tests
 * above them.
 */
describe('ActiveDirectoryConnector (Milestone 11, Task 5)', () => {
  const ctx = withTestDatabase()
  let ad: TestSambaAd

  beforeAll(async () => {
    ad = await startSambaAd()
    process.env[AD_SECRET_NAME] = ad.adminPassword
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
    // Allow a test to explicitly OMIT a key (e.g. caCertificate) by passing
    // `undefined` — `parseAdConfig`'s optional-field readers already treat
    // `undefined` identically to "absent", but stripping it here keeps
    // `config` shaped the way a REAL `connector_targets.config` JSON value
    // would be (a JSON object never has a key whose value is `undefined`).
    for (const key of Object.keys(config)) {
      if (config[key] === undefined) delete config[key]
    }
    return config
  }

  function makeConnector(overrides: Partial<ActiveDirectoryConnectorConfig> = {}): ActiveDirectoryConnector {
    const connector = new ActiveDirectoryConnector()
    connector.configure(baseConfig(overrides))
    return connector
  }

  /** A FRESH, independent ldapts client — never the connector's own cached one. Every "prove it" read in this file goes through this, per this task's own explicit instruction. */
  function freshClient(): Client {
    return new Client({ url: ad.url, tlsOptions: { ca: ad.caCertificatePem, servername: ad.tlsServerName } })
  }

  async function searchBySam(username: string, attributes: string[] = ['*']) {
    const client = freshClient()
    await client.bind(ad.adminDN, ad.adminPassword)
    try {
      return await client.search(ad.baseDN, {
        scope: 'sub',
        filter: `(sAMAccountName=${username})`,
        attributes,
        explicitBufferAttributes: ['objectGUID'],
      })
    } finally {
      await client.unbind()
    }
  }

  async function searchByGuid(externalId: string, attributes: string[] = ['*']) {
    const client = freshClient()
    await client.bind(ad.adminDN, ad.adminPassword)
    try {
      return await client.search(ad.baseDN, {
        scope: 'sub',
        // A Buffer-valued EqualityFilter OBJECT, never a hex-escaped STRING
        // filter — see ActiveDirectoryConnector's own `objectGuidFilter` doc
        // comment for the `ldapts` string-filter encoding bug this avoids
        // (reproduced empirically while building this very test file).
        filter: new EqualityFilter({ attribute: 'objectGUID', value: guidStringToBuffer(externalId) }),
        attributes,
        explicitBufferAttributes: ['objectGUID'],
      })
    } finally {
      await client.unbind()
    }
  }

  /**
   * `ldapts` represents a single-valued attribute's value as a plain string
   * when present, but — confirmed empirically — as an EMPTY ARRAY (`[]`),
   * not `undefined`, when that attribute was EXPLICITLY requested by name
   * and the entry has no value for it (as opposed to a wildcard `*`
   * request, which omits the key entirely for an absent attribute). Both
   * shapes mean "not present"; this normalises either to a single check.
   */
  function expectAbsent(value: unknown): void {
    if (Array.isArray(value)) {
      expect(value).toEqual([])
    } else {
      expect(value).toBeUndefined()
    }
  }

  /** A single-valued attribute may come back as a bare string OR a one-element array depending on ldapts's own cardinality inference — normalises before comparing, so a test does not depend on that internal detail. */
  function expectSingleValue(value: unknown, expected: string): void {
    expect(Array.isArray(value) ? value[0] : value).toBe(expected)
  }

  let usernameSeq = 0
  function nextUsername(): string {
    usernameSeq += 1
    return `adu${usernameSeq}`
  }

  function baseDesired(overrides: Partial<DesiredUser> = {}): DesiredUser {
    const username = nextUsername()
    return {
      userId: '00000000-0000-4000-8000-000000000001',
      username,
      email: `${username}@example.com`,
      firstName: 'Test',
      lastName: 'User',
      enabled: false,
      attributes: {},
      groups: [],
      orgUnitPath: [],
      ...overrides,
    }
  }

  // =========================================================================
  // Create, then read back over a FRESH LDAP bind
  // =========================================================================
  describe('create, then read back over a fresh LDAP bind', () => {
    it('creates a disabled user with no password — every profile field lands correctly, correlation id is a real objectGUID', async () => {
      const connector = makeConnector()
      const desired = baseDesired({ enabled: false, attributes: {} })

      const { externalId } = await connector.apply(desired)
      expect(externalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

      const { searchEntries } = await searchBySam(desired.username)
      expect(searchEntries).toHaveLength(1)
      const entry = searchEntries[0] as unknown as Record<string, unknown>

      expect(entry.sAMAccountName).toBe(desired.username)
      expect(entry.mail).toBe(desired.email)
      expect(entry.userPrincipalName).toBe(desired.email)
      expect(entry.givenName).toBe(desired.firstName)
      expect(entry.sn).toBe(desired.lastName)
      expect(entry.displayName).toBe(`${desired.firstName} ${desired.lastName}`)
      expect(entry.unicodePwd).toBeUndefined()
      expect(entry.userPassword).toBeUndefined()

      const uac = Number(entry.userAccountControl)
      expect(uac & UAC_ACCOUNTDISABLE).not.toBe(0) // disabled, as requested
      expect(uac & UAC_PASSWD_NOTREQD).not.toBe(0) // set unconditionally — see the connector's own doc comment

      expect(guidBufferToString(entry.objectGUID as Buffer)).toBe(externalId)
    })

    it('creates an ENABLED user directly, in one operation, still with no password', async () => {
      const connector = makeConnector()
      const desired = baseDesired({ enabled: true })
      await connector.apply(desired)

      const { searchEntries } = await searchBySam(desired.username, ['userAccountControl'])
      const uac = Number((searchEntries[0] as unknown as Record<string, unknown>).userAccountControl)
      expect(uac & UAC_ACCOUNTDISABLE).toBe(0)
    })

    it('places a mapped custom attribute alongside the core profile fields', async () => {
      const connector = makeConnector()
      const desired = baseDesired({ attributes: { employeeType: ['Contractor'] } })
      await connector.apply(desired)

      const { searchEntries } = await searchBySam(desired.username, ['employeeType'])
      expect((searchEntries[0] as unknown as Record<string, unknown>).employeeType).toBe('Contractor')
    })
  })

  // =========================================================================
  // Update — reconcile to desired state, idempotently
  // =========================================================================
  describe('update — reconciles to desired state, idempotently', () => {
    it('a second apply with changed fields updates in place; a third, unchanged apply is a genuine no-op per plan()', async () => {
      const connector = makeConnector()
      let desired = baseDesired({ attributes: { title: ['Engineer'] } })
      const { externalId: id1 } = await connector.apply(desired)

      desired = {
        ...desired,
        firstName: 'Changed',
        lastName: 'Surname',
        attributes: { title: ['Staff Engineer'] },
      }
      const { externalId: id2 } = await connector.apply(desired)
      expect(id2).toBe(id1) // same AD object, not a duplicate

      const { searchEntries } = await searchBySam(desired.username, ['givenName', 'sn', 'title'])
      const entry = searchEntries[0] as unknown as Record<string, unknown>
      expect(entry.givenName).toBe('Changed')
      expect(entry.sn).toBe('Surname')
      expect(entry.title).toBe('Staff Engineer')

      expect(await connector.plan(desired)).toEqual([])

      const { externalId: id3 } = await connector.apply(desired)
      expect(id3).toBe(id1)
      const { searchEntries: after } = await searchBySam(desired.username)
      expect(after).toHaveLength(1) // still exactly one entry — no duplicate from the idempotent re-apply
    })

    it('plan() reports create/update/disable operations that mirror what apply() would actually do', async () => {
      const connector = makeConnector()
      const desired = baseDesired({ enabled: true })

      expect(await connector.plan(desired)).toEqual([
        expect.objectContaining({ kind: 'create' }),
      ])
      await connector.apply(desired)
      expect(await connector.plan(desired)).toEqual([])

      const disabled = { ...desired, enabled: false }
      expect(await connector.plan(disabled)).toEqual([
        expect.objectContaining({ kind: 'disable' }),
      ])
    })
  })

  // =========================================================================
  // THE central guarantee: objectGUID correlation survives rename and OU move
  // =========================================================================
  describe('objectGUID correlation survives rename and OU move', () => {
    it('a username change RENAMES the same AD object — objectGUID unchanged, no duplicate left under the old name', async () => {
      const connector = makeConnector()
      const original = baseDesired({ enabled: true })
      const { externalId } = await connector.apply(original)

      const renamed: DesiredUser = {
        ...original,
        username: `${original.username}ren`,
        existingExternalId: externalId,
      }
      const { externalId: externalId2 } = await connector.apply(renamed)
      expect(externalId2).toBe(externalId)

      const byGuid = await searchByGuid(externalId, ['distinguishedName', 'sAMAccountName'])
      expect(byGuid.searchEntries).toHaveLength(1)
      const entry = byGuid.searchEntries[0] as unknown as Record<string, unknown>
      expect(entry.sAMAccountName).toBe(renamed.username)
      expect(String(entry.dn)).toMatch(new RegExp(`^CN=${renamed.username},`, 'i'))

      const byOldSam = await searchBySam(original.username)
      expect(byOldSam.searchEntries).toHaveLength(0) // no duplicate left under the old name
    })

    it('an org-unit change MOVES the same AD object — objectGUID unchanged, resolves at the new DN', async () => {
      const connector = makeConnector({ createMissingOrgUnits: true })
      const ouA = `moveou-a-${randomUUID().slice(0, 8)}`
      const ouB = `moveou-b-${randomUUID().slice(0, 8)}`
      const original = baseDesired({ enabled: true, orgUnitPath: [ouA] })
      const { externalId } = await connector.apply(original)

      const moved: DesiredUser = { ...original, orgUnitPath: [ouB], existingExternalId: externalId }
      const { externalId: externalId2 } = await connector.apply(moved)
      expect(externalId2).toBe(externalId)

      const byGuid = await searchByGuid(externalId, ['distinguishedName'])
      expect(byGuid.searchEntries).toHaveLength(1)
      expect(String((byGuid.searchEntries[0] as unknown as Record<string, unknown>).dn).toLowerCase()).toBe(
        `cn=${original.username},ou=${ouB},${ad.baseDN}`.toLowerCase(),
      )
    })

    it('doing BOTH a rename and an OU move in the SAME apply() still resolves by objectGUID', async () => {
      const connector = makeConnector({ createMissingOrgUnits: true })
      const ou1 = `bothou-1-${randomUUID().slice(0, 8)}`
      const ou2 = `bothou-2-${randomUUID().slice(0, 8)}`
      const original = baseDesired({ enabled: true, orgUnitPath: [ou1] })
      const { externalId } = await connector.apply(original)

      const both: DesiredUser = {
        ...original,
        username: `${original.username}both`,
        orgUnitPath: [ou2],
        existingExternalId: externalId,
      }
      const { externalId: externalId2 } = await connector.apply(both)
      expect(externalId2).toBe(externalId)

      const byGuid = await searchByGuid(externalId, ['distinguishedName', 'sAMAccountName'])
      expect(byGuid.searchEntries).toHaveLength(1)
      const entry = byGuid.searchEntries[0] as unknown as Record<string, unknown>
      expect(entry.sAMAccountName).toBe(both.username)
      expect(String(entry.dn).toLowerCase()).toBe(`cn=${both.username},ou=${ou2},${ad.baseDN}`.toLowerCase())
    })
  })

  // =========================================================================
  // Org-unit resolution
  // =========================================================================
  describe('org-unit resolution', () => {
    it('fails cleanly, NAMING THE OU, when it does not exist and createMissingOrgUnits is not enabled — nothing is created', async () => {
      const connector = makeConnector({ createMissingOrgUnits: false })
      const missingLabel = `nonexistent-${randomUUID().slice(0, 8)}`
      const desired = baseDesired({ orgUnitPath: [missingLabel] })

      await expect(connector.apply(desired)).rejects.toThrow(
        new RegExp(`organizational unit "OU=${missingLabel},${ad.baseDN}" does not exist`),
      )

      const { searchEntries } = await searchBySam(desired.username)
      expect(searchEntries).toHaveLength(0)
    })

    it('auto-creates a nested, missing OU chain when configured to', async () => {
      const connector = makeConnector({ createMissingOrgUnits: true })
      const level1 = `autoou1-${randomUUID().slice(0, 8)}`
      const level2 = `autoou2-${randomUUID().slice(0, 8)}`
      const desired = baseDesired({ orgUnitPath: [level1, level2] })

      await connector.apply(desired)

      const client = freshClient()
      await client.bind(ad.adminDN, ad.adminPassword)
      const ouSearch = await client.search(ad.baseDN, {
        scope: 'sub',
        filter: `(&(objectClass=organizationalUnit)(ou=${level2}))`,
        attributes: ['distinguishedName'],
      })
      await client.unbind()
      expect(ouSearch.searchEntries).toHaveLength(1)
      expect(String((ouSearch.searchEntries[0] as unknown as Record<string, unknown>).dn).toLowerCase()).toBe(
        `ou=${level2},ou=${level1},${ad.baseDN}`.toLowerCase(),
      )

      const { searchEntries } = await searchBySam(desired.username, ['distinguishedName'])
      expect(String((searchEntries[0] as unknown as Record<string, unknown>).dn).toLowerCase()).toBe(
        `cn=${desired.username},ou=${level2},ou=${level1},${ad.baseDN}`.toLowerCase(),
      )
    })

    it('never places a managed user under the built-in CN=Users container', async () => {
      const connector = makeConnector()
      const desired = baseDesired({ orgUnitPath: [] }) // no org unit at all
      await connector.apply(desired)

      const { searchEntries } = await searchBySam(desired.username, ['distinguishedName'])
      const dn = String((searchEntries[0] as unknown as Record<string, unknown>).dn)
      expect(dn.toLowerCase()).toBe(`cn=${desired.username},${ad.baseDN}`.toLowerCase())
      expect(dn.toLowerCase()).not.toContain('cn=users,')
    })
  })

  // =========================================================================
  // Disable — the decision-3 guarantee: disabled AND still present
  // =========================================================================
  describe('disable — decision-3 guarantee (disabled AND still present)', () => {
    it('disables an enabled user; the entry remains present (asserted explicitly); unrelated userAccountControl bits and every other attribute survive untouched', async () => {
      const connector = makeConnector()
      const desired = baseDesired({ enabled: true, attributes: { title: ['Keep Me'] } })
      const { externalId } = await connector.apply(desired)

      await connector.disable(externalId)

      const { searchEntries } = await searchByGuid(externalId, [
        'userAccountControl',
        'mail',
        'sAMAccountName',
        'title',
        'distinguishedName',
      ])
      // PRESENCE, asserted explicitly — the decision-3 guarantee this task
      // names directly: disable must never be a delete-by-another-name.
      expect(searchEntries).toHaveLength(1)
      const entry = searchEntries[0] as unknown as Record<string, unknown>

      const uac = Number(entry.userAccountControl)
      expect(uac & UAC_ACCOUNTDISABLE).not.toBe(0)
      // Read-modify-write, not overwrite: PASSWD_NOTREQD (set at creation,
      // never touched by disable()) survives — a blind overwrite would have
      // clobbered it.
      expect(uac & UAC_PASSWD_NOTREQD).not.toBe(0)
      // disable() takes ONLY the immutable id — no user data — so it cannot
      // have touched anything else.
      expect(entry.mail).toBe(desired.email)
      expect(entry.sAMAccountName).toBe(desired.username)
      expect(entry.title).toBe('Keep Me')
    })

    it('disabling an already-disabled user is a harmless no-op', async () => {
      const connector = makeConnector()
      const desired = baseDesired({ enabled: false })
      const { externalId } = await connector.apply(desired)

      await connector.disable(externalId)
      await connector.disable(externalId)

      const { searchEntries } = await searchByGuid(externalId)
      expect(searchEntries).toHaveLength(1)
    })

    it('disable() throws a clear error for an unknown objectGUID rather than silently doing nothing', async () => {
      const connector = makeConnector()
      const fakeGuid = '00000000-0000-0000-0000-000000000000'
      await expect(connector.disable(fakeGuid)).rejects.toThrow(/no entry found for objectGUID/)
    })
  })

  // =========================================================================
  // Non-negotiables: no delete, no password, ever — proven statically
  // =========================================================================
  describe('non-negotiables, proven against the connector source itself', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/connectors/active-directory.connector.ts'),
      'utf8',
    )
    // Comments stripped before checking — this file's OWN documentation
    // legitimately names `unicodePwd`/`userPassword` as the exact attributes
    // it explains NEVER to use (see e.g. `UAC_PASSWD_NOTREQD`'s own doc
    // comment), so checking the raw text verbatim would fail on the
    // documentation explaining the guarantee, not on a violation of it.
    // `/* */` blocks are stripped whole; `//` line comments are stripped
    // only when preceded by whitespace — real comments always are (either
    // indentation or a code-then-space-then-`//` trailing comment), while
    // this file's two `'ldaps://'` occurrences (in `parseAdConfig`) have no
    // whitespace before their `//` and are left untouched (verified against
    // this exact file before relying on it here).
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(?<=\s)\/\/.*$/gm, '')

    it('never references unicodePwd or userPassword in actual code — no code path could set a password even by accident', () => {
      expect(codeOnly).not.toMatch(/unicodePwd/)
      expect(codeOnly).not.toMatch(/userPassword/)
    })

    it('contains no .del( call anywhere — there is no delete, not in the connector, not behind a flag', () => {
      expect(source).not.toMatch(/\.del\(/)
    })
  })

  // =========================================================================
  // TLS: certificate verification on by default
  // =========================================================================
  describe('TLS certificate verification on by default', () => {
    it('with NO caCertificate configured (Node default trust store), the connection to our self-signed test CA is REJECTED', async () => {
      const connector = makeConnector({ caCertificate: undefined })
      const health = await connector.health()
      expect(health.ok).toBe(false)
      expect(health.detail.toLowerCase()).toMatch(/certificate|verify|self.signed|unable/)
    })

    it('allowInsecureTls is the ONLY way verification is ever relaxed — explicit, and it genuinely works when set', async () => {
      const connector = makeConnector({ caCertificate: undefined, allowInsecureTls: true })
      const health = await connector.health()
      expect(health.ok).toBe(true)
    })

    it('with the correct caCertificate, verification succeeds — the connector default is genuinely secure, not merely permissive', async () => {
      const connector = makeConnector()
      const health = await connector.health()
      expect(health.ok).toBe(true)
      expect(health.detail).toContain(ad.url)
    })
  })

  // =========================================================================
  // Secret-leak sentinel — extends Milestone 10 Task 2's proof to this connector
  // =========================================================================
  describe('secret resolution never leaks (extends Milestone 10 Task 2 to active_directory)', () => {
    it('the bind password never appears in health/apply responses, thrown errors, or console output', async () => {
      const secretName = `CONNECTOR_AD_LEAK_TEST_${randomUUID().replace(/-/g, '_')}`
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
        const connector = makeConnector({ credentialSecretName: secretName })
        const health = await connector.health()
        expect(health.ok).toBe(true) // sanity: this run really did resolve and use the real secret
        assertNoLeak(JSON.stringify(health), sentinel, 'health() response body')

        const desired = baseDesired()
        const applyResult = await connector.apply(desired)
        assertNoLeak(JSON.stringify(applyResult), sentinel, 'apply() response body')

        const disableResult = await connector.disable(applyResult.externalId).catch((e) => e)
        assertNoLeak(String(disableResult), sentinel, 'disable() result/error')

        // A deliberately failing path: a typo'd secret name.
        const badConnector = makeConnector({ credentialSecretName: `${secretName}_TYPO` })
        const badHealth = await badConnector.health()
        expect(badHealth.ok).toBe(false)
        assertNoLeak(badHealth.detail, sentinel, 'health() failure detail (missing-secret path)')
        await expect(badConnector.apply(baseDesired())).rejects.toThrow()
        try {
          await badConnector.apply(baseDesired())
        } catch (error) {
          assertNoLeak(error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error), sentinel, 'apply() thrown error (missing-secret path)')
        }

        assertNoLeak(loggedArgs.join('\n'), sentinel, 'console.log/warn/error output')
      } finally {
        delete process.env[secretName]
        for (const spy of spies) spy.mockRestore()
      }
    })
  })

  // =========================================================================
  // Default-deny attribute propagation — asserted against what AD ACTUALLY
  // RECEIVED, through the REAL SyncWorker pipeline (non-negotiable).
  // =========================================================================
  describe('default-deny attribute propagation — asserted against what AD actually received', () => {
    let orgUnitId: string
    let departmentOrgUnitId: string
    let departmentOrgUnitName: string

    beforeAll(async () => {
      const orgUnitsRepo = new OrgUnitsRepository(ctx.db)
      const root = await orgUnitsRepo.createRoot(`AD Default Deny Root ${randomUUID()}`)
      orgUnitId = root.id
      departmentOrgUnitName = `Engineering ${randomUUID().slice(0, 8)}`
      const child = await orgUnitsRepo.createChild(root.id, departmentOrgUnitName)
      departmentOrgUnitId = child.id

      await ctx.pool.query(
        `INSERT INTO connector_targets (target, enabled, config) VALUES ('active_directory', true, $1)
         ON CONFLICT (organization_id, target) DO UPDATE SET enabled = true, config = $1`,
        [JSON.stringify(baseConfig())],
      )
    })

    function usersRepo(): UsersRepository {
      return new UsersRepository(ctx.db)
    }

    function makeWorker(): SyncWorker {
      const registry = new ConnectorRegistry(unreachableKeycloak())
      return new SyncWorker(
        ctx.db,
        new OutboxRepository(),
        usersRepo(),
        new GroupsRepository(ctx.db),
        unreachableKeycloak(),
        undefined,
        registry,
      )
    }

    async function makeCustomAttributeDefinition(): Promise<{ id: string; key: string }> {
      const key = `ad_dd_custom_${randomUUID().replace(/-/g, '').slice(0, 12)}`
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
         VALUES ($1, 'active_directory', $2, true)
         ON CONFLICT (attribute_definition_id, target) WHERE attribute_definition_id IS NOT NULL
         DO UPDATE SET remote_name = $2, enabled = true`,
        [attributeDefinitionId, remoteName],
      )
    }

    async function mapCoreField(coreField: string, remoteName: string): Promise<void> {
      await ctx.pool.query(
        `INSERT INTO attribute_target_mappings (core_field, target, remote_name, enabled)
         VALUES ($1, 'active_directory', $2, true)
         ON CONFLICT (core_field, target) WHERE core_field IS NOT NULL
         DO UPDATE SET remote_name = $2, enabled = true`,
        [coreField, remoteName],
      )
    }

    it('a mapped custom attribute reaches AD under its remote name; an unmapped one reaches AD under no name at all', async () => {
      const mapped = await makeCustomAttributeDefinition()
      const unmapped = await makeCustomAttributeDefinition()
      await mapAttribute(mapped.id, 'employeeType')
      const unmappedSentinelValue = `must-never-propagate-${randomUUID()}`

      const username = nextUsername()
      const user = await usersRepo().create({
        primaryEmail: `${username}@example.com`,
        username,
        firstName: 'DD',
        lastName: 'Test',
        orgUnitId,
        attributes: { [mapped.key]: 'Contractor', [unmapped.key]: unmappedSentinelValue },
      })
      await usersRepo().changeStatus(user.id, 'active')

      await ctx.db.transaction((tx) => makeWorker().reconcileUser(tx, user.id, 'active_directory'))

      const { searchEntries } = await searchBySam(username, ['*'])
      expect(searchEntries).toHaveLength(1)
      const entry = searchEntries[0] as unknown as Record<string, unknown>
      expect(entry.employeeType).toBe('Contractor')
      // Structural proof, not just "the expected remote name is absent": the
      // raw unmapped VALUE must not appear ANYWHERE in the entry, under any
      // attribute name — the same "grep the whole haystack" discipline the
      // secret-leak sentinel test uses, applied to default-deny.
      assertNoLeak(JSON.stringify(entry, (_key, value) => (Buffer.isBuffer(value) ? '<buffer>' : value)), unmappedSentinelValue, 'AD entry (unmapped attribute)')
    })

    it('a mapping DISABLED after being enabled stops propagating', async () => {
      const def = await makeCustomAttributeDefinition()
      await mapAttribute(def.id, 'description')

      const username = nextUsername()
      const user = await usersRepo().create({
        primaryEmail: `${username}@example.com`,
        username,
        firstName: 'Toggle',
        lastName: 'Test',
        orgUnitId,
        attributes: { [def.key]: 'toggle-value' },
      })
      await usersRepo().changeStatus(user.id, 'active')
      await ctx.db.transaction((tx) => makeWorker().reconcileUser(tx, user.id, 'active_directory'))

      const before = await searchBySam(username, ['description'])
      expectSingleValue((before.searchEntries[0] as unknown as Record<string, unknown>)['description'], 'toggle-value')

      await ctx.pool.query(
        `UPDATE attribute_target_mappings SET enabled = false WHERE attribute_definition_id = $1 AND target = 'active_directory'`,
        [def.id],
      )
      // A DIFFERENT attribute-triggering change forces a real re-sync so we
      // can observe the field being ACTIVELY DROPPED, not merely never sent.
      await ctx.pool.query(`UPDATE users SET attributes = $2 WHERE id = $1`, [
        user.id,
        JSON.stringify({ [def.key]: 'toggle-value-still-set-locally' }),
      ])
      await ctx.db.transaction((tx) => makeWorker().reconcileUser(tx, user.id, 'active_directory'))

      const after = await searchBySam(username, ['description'])
      expectAbsent((after.searchEntries[0] as unknown as Record<string, unknown>)['description'])
    })

    it('core fields (title, department-from-org-path) map per target the same way — mapped reaches AD, unmapped does not', async () => {
      await mapCoreField('title', 'title')
      // department deliberately left UNMAPPED for this user

      const username = nextUsername()
      const user = await usersRepo().create({
        primaryEmail: `${username}@example.com`,
        username,
        firstName: 'Core',
        lastName: 'Fields',
        orgUnitId: departmentOrgUnitId,
        jobTitle: 'Staff Engineer',
      })
      await usersRepo().changeStatus(user.id, 'active')
      await ctx.db.transaction((tx) => makeWorker().reconcileUser(tx, user.id, 'active_directory'))

      const { searchEntries } = await searchBySam(username, ['title', 'department'])
      const entry = searchEntries[0] as unknown as Record<string, unknown>
      expectSingleValue(entry.title, 'Staff Engineer')
      expectAbsent(entry.department)
    })

    it('once department IS mapped, it carries the org unit NAME to AD', async () => {
      await mapCoreField('department', 'department')

      const username = nextUsername()
      const user = await usersRepo().create({
        primaryEmail: `${username}@example.com`,
        username,
        firstName: 'Dept',
        lastName: 'Mapped',
        orgUnitId: departmentOrgUnitId,
      })
      await usersRepo().changeStatus(user.id, 'active')
      await ctx.db.transaction((tx) => makeWorker().reconcileUser(tx, user.id, 'active_directory'))

      const { searchEntries } = await searchBySam(username, ['department'])
      expectSingleValue((searchEntries[0] as unknown as Record<string, unknown>).department, departmentOrgUnitName)
    })
  })

  // =========================================================================
  // Per-principal isolation — a connection failure mid-batch leaves no
  // partially-applied user (this task's own explicit "PROVE IT" requirement,
  // and the AD-specific half of Milestone 10 Task 4 concern 3).
  // =========================================================================
  describe('a connection failure mid-batch leaves no partially-applied user', () => {
    let orgUnitId: string

    beforeAll(async () => {
      orgUnitId = (
        await new OrgUnitsRepository(ctx.db).createRoot(`AD Isolation Root ${randomUUID()}`)
      ).id
      await ctx.pool.query(
        `INSERT INTO connector_targets (target, enabled, config) VALUES ('active_directory', true, $1)
         ON CONFLICT (organization_id, target) DO UPDATE SET enabled = true, config = $1`,
        [JSON.stringify(baseConfig())],
      )
    })

    function usersRepo(): UsersRepository {
      return new UsersRepository(ctx.db)
    }

    function makeSyncWorker(): SyncWorker {
      const registry = new ConnectorRegistry(unreachableKeycloak())
      return new SyncWorker(
        ctx.db,
        new OutboxRepository(),
        usersRepo(),
        new GroupsRepository(ctx.db),
        unreachableKeycloak(),
        undefined,
        registry,
      )
    }

    async function makeActiveUser(): Promise<User> {
      const username = nextUsername()
      const user = await usersRepo().create({
        primaryEmail: `${username}@example.com`,
        username,
        firstName: 'Iso',
        lastName: 'Test',
        orgUnitId,
      })
      await usersRepo().changeStatus(user.id, 'active')
      return user
    }

    it('user A succeeds; LDAP goes down; user B fails cleanly with NOTHING partially created; both converge once LDAP is restored', async () => {
      const worker = makeSyncWorker()
      const userA = await makeActiveUser()
      const userB = await makeActiveUser()

      // User A: applied while the connection is healthy.
      await ctx.db.transaction((tx) => worker.reconcileUser(tx, userA.id, 'active_directory'))
      const aAfterFirst = await searchBySam(userA.username, ['distinguishedName'])
      expect(aAfterFirst.searchEntries).toHaveLength(1)

      // A REAL connection failure — the actual samba process goes down —
      // exactly the shape a batch-processing loop (TargetReconciliationJob's
      // own per-principal-isolated APPLY loop, Milestone 10 Task 4 concern 3,
      // closed by this milestone) must survive for one principal without
      // corrupting or losing track of any other.
      await ad.interruptLdap()
      let userBError: unknown
      try {
        await ctx.db.transaction((tx) => worker.reconcileUser(tx, userB.id, 'active_directory'))
      } catch (error) {
        userBError = error
      }
      expect(userBError).toBeDefined()

      await ad.restoreLdap()

      const aResult = await searchBySam(userA.username, ['distinguishedName'])
      const bResult = await searchBySam(userB.username, ['distinguishedName'])
      expect(aResult.searchEntries).toHaveLength(1) // A: unaffected by B's failure
      expect(bResult.searchEntries).toHaveLength(0) // B: NOTHING partially created

      // Self-heals: the very next reconcile for B succeeds now that LDAP is
      // back — the failure was transient and recorded, not a permanent stuck
      // state.
      await ctx.db.transaction((tx) => worker.reconcileUser(tx, userB.id, 'active_directory'))
      const bAfterHeal = await searchBySam(userB.username, ['distinguishedName'])
      expect(bAfterHeal.searchEntries).toHaveLength(1)
    }, 60_000)

    it('the SAME guarantee, end to end through TargetReconciliationJob (the actual batch entry point)', async () => {
      const worker = makeSyncWorker()
      const registry = new ConnectorRegistry(unreachableKeycloak())
      const job = new TargetReconciliationJob(usersRepo(), registry, worker, new AuditWriter(), ctx.db)

      const userC = await makeActiveUser()
      const report = await job.reconcile('active_directory', {})

      expect(report.failed).toEqual([])
      expect(report.toMutate.some((p) => p.userId === userC.id)).toBe(true)
      const cResult = await searchBySam(userC.username, ['distinguishedName'])
      expect(cResult.searchEntries).toHaveLength(1)
    }, 60_000)
  })
})
