import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ConflictError, NotFoundError } from '../src/common/errors'
import {
  buildSyncedAttributes,
  KeycloakAdminClient,
  type SyncableAttributeDefinition,
} from '../src/keycloak/keycloak-admin.client'
import { startKeycloak, type TestKeycloak } from './support/keycloak'

const SYNC_CLIENT_ID = 'idm-sync-service'
const SYNC_CLIENT_SECRET = 'idm_sync_dev_secret_change_me'

// ---------------------------------------------------------------------------
// Pure unit tests: the default-deny attribute payload builder is a free
// function with no I/O — no Keycloak, no container, milliseconds per case.
// ---------------------------------------------------------------------------
describe('buildSyncedAttributes (default-deny payload builder)', () => {
  const definitions: SyncableAttributeDefinition[] = [
    { key: 'department', syncToKeycloak: true },
    { key: 'costCenter', syncToKeycloak: false },
  ]

  it('includes only keys whose definition has sync_to_keycloak = true', () => {
    expect(
      buildSyncedAttributes({ department: 'Engineering', costCenter: 'CC-42' }, definitions),
    ).toEqual({ department: ['Engineering'] })
  })

  it('drops a key with no matching definition at all (default-deny, not default-allow)', () => {
    expect(buildSyncedAttributes({ mysteryField: 'x' }, definitions)).toEqual({})
  })

  it('drops null and undefined values instead of stringifying them', () => {
    expect(buildSyncedAttributes({ department: null, costCenter: undefined }, definitions)).toEqual({})
  })

  it('stringifies a non-string scalar into a single-element array', () => {
    const numeric: SyncableAttributeDefinition[] = [{ key: 'headcount', syncToKeycloak: true }]
    expect(buildSyncedAttributes({ headcount: 42 }, numeric)).toEqual({ headcount: ['42'] })

    const boolDef: SyncableAttributeDefinition[] = [{ key: 'remote', syncToKeycloak: true }]
    expect(buildSyncedAttributes({ remote: true }, boolDef)).toEqual({ remote: ['true'] })
  })

  it('stringifies each element of an array value', () => {
    const listDef: SyncableAttributeDefinition[] = [{ key: 'tags', syncToKeycloak: true }]
    expect(buildSyncedAttributes({ tags: ['a', 1, false] }, listDef)).toEqual({
      tags: ['a', '1', 'false'],
    })
  })

  it('returns an empty object when there are no definitions at all', () => {
    expect(buildSyncedAttributes({ department: 'Engineering' }, [])).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Integration tests: a REAL Keycloak Testcontainer, never a mock — same
// requirement the milestone plan states for every sync contract test. One
// container is shared (via beforeAll) across every `it` below purely for
// startup cost; every fixture is uniquely tagged so tests never collide with
// each other within that shared realm.
// ---------------------------------------------------------------------------
describe('KeycloakAdminClient (Milestone 4, Task 2)', () => {
  let keycloak: TestKeycloak
  let client: KeycloakAdminClient

  beforeAll(async () => {
    keycloak = await startKeycloak()
    client = new KeycloakAdminClient({
      issuer: keycloak.issuer,
      clientId: SYNC_CLIENT_ID,
      clientSecret: SYNC_CLIENT_SECRET,
    })
  })

  afterAll(async () => {
    await keycloak?.stop()
  })

  let fixtureSeq = 0
  /** A globally-unique, email-shaped username — Keycloak usernames in this realm are emails. */
  function nextUsername(label: string): string {
    fixtureSeq += 1
    return `kc-client-${label}-${fixtureSeq}@example.com`.toLowerCase()
  }
  function nextTag(): string {
    fixtureSeq += 1
    return `${fixtureSeq}`
  }

  const SYNCED_DEFINITIONS: SyncableAttributeDefinition[] = [
    { key: 'department', syncToKeycloak: true },
    { key: 'internalNotes', syncToKeycloak: false },
  ]

  // =========================================================================
  // findUserByUsername
  // =========================================================================
  describe('findUserByUsername', () => {
    it('returns null when no Keycloak user matches', async () => {
      expect(await client.findUserByUsername(nextUsername('missing'))).toBeNull()
    })
  })

  // =========================================================================
  // createUser — constraint #1 (no credential) and #2 (default-deny attrs)
  // =========================================================================
  describe('createUser', () => {
    it('creates a user that fetches back enabled and WITH NO CREDENTIAL SET', async () => {
      const username = nextUsername('create')

      const { id } = await client.createUser(
        {
          username,
          email: username,
          firstName: 'New',
          lastName: 'Hire',
          enabled: true,
          attributes: {},
        },
        SYNCED_DEFINITIONS,
      )
      expect(id).toBeTruthy()

      const fetched = await client.findUserByUsername(username)
      expect(fetched).not.toBeNull()
      expect(fetched?.id).toBe(id)
      expect(fetched?.enabled).toBe(true)
      expect(fetched?.email).toBe(username)

      // THE project's foremost binding constraint, proven against Keycloak's
      // OWN credentials sub-resource (never against the request body this
      // test sent, which trivially contains no password either — see
      // listCredentials' doc comment for why that would be a vacuous check).
      expect(await client.listCredentials(username)).toEqual([])
    })

    it('includes only the sync_to_keycloak attribute — the non-synced one never reaches the fetched user', async () => {
      const username = nextUsername('attrs')

      await client.createUser(
        {
          username,
          email: username,
          firstName: 'Attr',
          lastName: 'Test',
          enabled: true,
          attributes: { department: 'Engineering', internalNotes: 'confidential salary note' },
        },
        SYNCED_DEFINITIONS,
      )

      const fetched = await client.findUserByUsername(username)
      expect(fetched?.attributes.department).toEqual(['Engineering'])
      expect(fetched?.attributes.internalNotes).toBeUndefined()
      // Not just "the key is absent" — no synced value silently leaked into
      // some OTHER key either. The full map is exactly the synced subset.
      expect(fetched?.attributes).toEqual({ department: ['Engineering'] })
    })

    it('throws ConflictError on a duplicate username', async () => {
      const username = nextUsername('dupe')
      const input = {
        username,
        email: username,
        firstName: 'Dup',
        lastName: 'Licate',
        enabled: true,
        attributes: {},
      }

      await client.createUser(input, [])
      await expect(client.createUser(input, [])).rejects.toBeInstanceOf(ConflictError)
    })
  })

  // =========================================================================
  // updateUser — constraint #3 (desired state, not delta)
  // =========================================================================
  describe('updateUser', () => {
    it('converges: applying the same desired state twice leaves identical fetched state', async () => {
      const username = nextUsername('update')
      await client.createUser(
        {
          username,
          email: username,
          firstName: 'Before',
          lastName: 'Change',
          enabled: true,
          attributes: {},
        },
        SYNCED_DEFINITIONS,
      )

      const desired = {
        email: username,
        firstName: 'After',
        lastName: 'Change',
        attributes: { department: 'Sales', internalNotes: 'should never sync' },
      }

      await client.updateUser(username, desired, SYNCED_DEFINITIONS)
      const first = await client.findUserByUsername(username)
      expect(first?.firstName).toBe('After')
      expect(first?.attributes).toEqual({ department: ['Sales'] })

      // Re-apply the IDENTICAL desired state. Converging means this is a
      // no-op in effect: the fetched result must be byte-for-byte the same.
      await client.updateUser(username, desired, SYNCED_DEFINITIONS)
      const second = await client.findUserByUsername(username)
      expect(second).toEqual(first)
    })

    it('throws NotFoundError for a username with no Keycloak user', async () => {
      await expect(
        client.updateUser(
          nextUsername('ghost'),
          { email: 'x@example.com', firstName: 'X', lastName: 'Y', attributes: {} },
          [],
        ),
      ).rejects.toBeInstanceOf(NotFoundError)
    })
  })

  // =========================================================================
  // setEnabled + revokeSessions — genuinely ends a live session
  // =========================================================================
  describe('setEnabled + revokeSessions', () => {
    it('ends an active session: a refresh token stops working after revocation', async () => {
      const username = nextUsername('revoke')
      const password = 'fixture-password-never-used-by-the-client-under-test'
      // WITH-credential fixture, created via the container's bootstrap admin
      // — NOT via client.createUser, which by design can never set one.
      await keycloak.createFixtureUserWithPassword({ username, email: username, password })

      const { refreshToken } = await keycloak.tokenPairFor(username, password)

      // Sanity check the refresh token genuinely works BEFORE revocation —
      // otherwise a failing refresh below would prove nothing.
      const before = await keycloak.attemptRefresh(refreshToken)
      expect(before.ok).toBe(true)

      await client.setEnabled(username, false)
      await client.revokeSessions(username)

      const after = await keycloak.attemptRefresh(refreshToken)
      expect(after.ok).toBe(false)

      const fetched = await client.findUserByUsername(username)
      expect(fetched?.enabled).toBe(false)
    })

    it('throws NotFoundError when the username has no Keycloak user', async () => {
      await expect(client.setEnabled(nextUsername('ghost'), false)).rejects.toBeInstanceOf(
        NotFoundError,
      )
      await expect(client.revokeSessions(nextUsername('ghost'))).rejects.toBeInstanceOf(
        NotFoundError,
      )
    })
  })

  // =========================================================================
  // ensureGroup
  // =========================================================================
  describe('ensureGroup', () => {
    it('is idempotent: ensuring the same name twice returns the same group', async () => {
      const name = `Engineering ${nextTag()}`

      const first = await client.ensureGroup(name)
      const second = await client.ensureGroup(name)

      expect(second.id).toBe(first.id)
      expect(second.name).toBe(name)
      expect(second.path).toBe(first.path)
    })

    it('two different names produce two different groups', async () => {
      const tag = nextTag()
      const a = await client.ensureGroup(`Group A ${tag}`)
      const b = await client.ensureGroup(`Group B ${tag}`)
      expect(a.id).not.toBe(b.id)
    })
  })

  // =========================================================================
  // setUserGroups — constraint #3 (desired state, not delta)
  // =========================================================================
  describe('setUserGroups', () => {
    it('converges: applying the same desired membership twice leaves identical membership', async () => {
      const username = nextUsername('groups')
      await client.createUser(
        {
          username,
          email: username,
          firstName: 'Group',
          lastName: 'Member',
          enabled: true,
          attributes: {},
        },
        [],
      )
      const tag = nextTag()
      const groupA = await client.ensureGroup(`Team A ${tag}`)
      const groupB = await client.ensureGroup(`Team B ${tag}`)

      await client.setUserGroups(username, [groupA.id])
      await client.setUserGroups(username, [groupA.id]) // repeat — must be a no-op

      // Verified independently of the client under test — see
      // getUserGroupNames' doc comment in test/support/keycloak.ts.
      expect(await keycloak.getUserGroupNames(username)).toEqual([groupA.name])

      // Change desired state, then repeat THAT twice too, proving
      // convergence holds across a real change, not just a no-op repeat.
      await client.setUserGroups(username, [groupB.id])
      await client.setUserGroups(username, [groupB.id])
      expect(await keycloak.getUserGroupNames(username)).toEqual([groupB.name])

      // Desired state of "no groups" removes the last membership too.
      await client.setUserGroups(username, [])
      await client.setUserGroups(username, [])
      expect(await keycloak.getUserGroupNames(username)).toEqual([])
    })

    it('throws NotFoundError when the username has no Keycloak user', async () => {
      await expect(client.setUserGroups(nextUsername('ghost'), [])).rejects.toBeInstanceOf(
        NotFoundError,
      )
    })
  })

  // =========================================================================
  // Token handling: client-credentials grant, cached until shortly before
  // expiry, refreshed on a 401. This is a narrow, deliberate exception to
  // "never mock" (see the milestone plan's global constraints): the spy
  // below intercepts nothing about KEYCLOAK'S semantics — every request
  // still hits the real container except the one synthetic 401 the second
  // test injects — it only observes/perturbs THIS CLIENT's own transport
  // calls, to prove ITS retry mechanics, which real Keycloak has no way to
  // provoke on demand (it never rejects a token it just issued).
  // =========================================================================
  describe('token handling', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('caches the client-credentials token across multiple admin calls', async () => {
      const scopedClient = new KeycloakAdminClient({
        issuer: keycloak.issuer,
        clientId: SYNC_CLIENT_ID,
        clientSecret: SYNC_CLIENT_SECRET,
      })

      const realFetch = globalThis.fetch
      let tokenRequests = 0
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('/protocol/openid-connect/token')) {
          tokenRequests += 1
        }
        return realFetch(input, init)
      })

      await scopedClient.findUserByUsername(nextUsername('cache-1'))
      await scopedClient.findUserByUsername(nextUsername('cache-2'))
      await scopedClient.findUserByUsername(nextUsername('cache-3'))

      expect(tokenRequests).toBe(1)
    })

    it('retries exactly once after a 401, then succeeds', async () => {
      const scopedClient = new KeycloakAdminClient({
        issuer: keycloak.issuer,
        clientId: SYNC_CLIENT_ID,
        clientSecret: SYNC_CLIENT_SECRET,
      })

      const realFetch = globalThis.fetch
      let adminCalls = 0
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('/admin/realms/')) {
          adminCalls += 1
          if (adminCalls === 1) {
            // A synthetic 401 for the FIRST admin call only — simulates the
            // cached token having gone stale server-side. The real fetch
            // never runs for this one call.
            return new Response(null, { status: 401 })
          }
        }
        return realFetch(input, init)
      })

      const result = await scopedClient.findUserByUsername(nextUsername('retry'))

      expect(result).toBeNull()
      expect(adminCalls).toBe(2)
    })
  })
})
