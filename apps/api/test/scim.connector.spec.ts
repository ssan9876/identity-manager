import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DesiredUser } from '../src/connectors/connector'
import {
  escapeFilterValue,
  parseScimConfig,
  ScimConnector,
  setScimPath,
  type ScimWriteMode,
} from '../src/connectors/scim.connector'
import { ForbiddenSecretNameError } from '../src/connectors/secrets'
import { startScimFake, type ScimFake } from './support/scim-fake'

/**
 * `ScimConnector` against a REAL local `node:http` SCIM service (see
 * test/support/scim-fake.ts for exactly what that does and does not prove).
 * Real sockets, real request bodies, real `Retry-After` waits.
 *
 * The connector is ONE class serving six target slots, so these tests
 * exercise it the way `ConnectorRegistry` does — `configure(config)` with a
 * different slot's config, against the same instance.
 */

const SECRET_NAME = 'CONNECTOR_SCIM_TEST_TOKEN'

describe('ScimConnector', () => {
  let fake: ScimFake
  let connector: ScimConnector

  beforeAll(async () => {
    fake = await startScimFake()
    process.env[SECRET_NAME] = fake.bearerToken
  })

  afterAll(async () => {
    await fake.stop()
    delete process.env[SECRET_NAME]
  })

  beforeEach(() => {
    fake.users.clear()
    fake.groups.clear()
    fake.requests.length = 0
    fake.throttleQueue.length = 0
    fake.forceStatus = null
    fake.bearerToken = 'scim-fake-token'
    process.env[SECRET_NAME] = fake.bearerToken
    connector = new ScimConnector()
  })

  function configure(overrides: Record<string, unknown> = {}, writeMode: ScimWriteMode = 'patch'): ScimConnector {
    return connector.configure({
      baseUrl: fake.baseUrl,
      tokenSecretName: SECRET_NAME,
      writeMode,
      ...overrides,
    })
  }

  function desiredUser(overrides: Partial<DesiredUser> = {}): DesiredUser {
    return {
      userId: '11111111-1111-4111-8111-111111111111',
      username: 'ada',
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      enabled: true,
      attributes: {},
      groups: [],
      ...overrides,
    }
  }

  // ------------------------------------------------------------------ config

  describe('parseScimConfig', () => {
    it('requires a base URL', () => {
      expect(() => parseScimConfig({ tokenSecretName: SECRET_NAME })).toThrow(/baseUrl is required/)
    })

    it('trims a trailing slash so paths concatenate cleanly', () => {
      const config = parseScimConfig({ baseUrl: 'https://x.example/scim/v2/', tokenSecretName: SECRET_NAME })
      expect(config.baseUrl).toBe('https://x.example/scim/v2')
    })

    it('requires exactly one authentication mode', () => {
      expect(() => parseScimConfig({ baseUrl: 'https://x.example' })).toThrow(/either tokenSecretName/)
      expect(() =>
        parseScimConfig({
          baseUrl: 'https://x.example',
          tokenSecretName: SECRET_NAME,
          tokenUrl: 'https://x.example/token',
          clientId: 'c',
          clientSecretName: 'CONNECTOR_X',
        }),
      ).toThrow(/exactly one authentication mode/)
    })

    it('requires the full OAuth2 trio when a token URL is set', () => {
      expect(() => parseScimConfig({ baseUrl: 'https://x.example', tokenUrl: 'https://x.example/token' })).toThrow(
        /requires clientId and clientSecretName/,
      )
    })

    it('rejects an unknown write mode rather than silently defaulting', () => {
      expect(() =>
        parseScimConfig({ baseUrl: 'https://x.example', tokenSecretName: SECRET_NAME, writeMode: 'upsert' }),
      ).toThrow(/must be "patch" or "put"/)
    })
  })

  describe('setScimPath', () => {
    it('builds nested objects from a dotted path', () => {
      const target: Record<string, unknown> = {}
      setScimPath(target, 'name.givenName', 'Ada')
      expect(target).toEqual({ name: { givenName: 'Ada' } })
    })

    /**
     * REGRESSION. The standard enterprise URN contains `2.0`, so a naive
     * dot-split shears it into `...enterprise:2` and `0:User` and the
     * attribute lands under two nonsense keys. The URN must be taken whole,
     * up to its last colon.
     */
    it('keeps an extension URN whole and dot-splits only the attribute after it', () => {
      const target: Record<string, unknown> = {}
      setScimPath(target, 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department', 'R&D')
      expect(Object.keys(target)).toEqual(['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'])
      expect(target['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User']).toEqual({ department: 'R&D' })
    })

    it('dot-splits a sub-attribute under an extension URN', () => {
      const target: Record<string, unknown> = {}
      setScimPath(target, 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:manager.value', 'm-1')
      expect(target['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User']).toEqual({
        manager: { value: 'm-1' },
      })
    })

    it('refuses a prototype-polluting segment', () => {
      for (const bad of ['__proto__.polluted', 'constructor.x', 'a.prototype.b']) {
        expect(() => setScimPath({}, bad, 'x')).toThrow(/refusing attribute path segment/)
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    })
  })

  describe('escapeFilterValue', () => {
    it('escapes quotes and backslashes so a crafted username cannot alter the filter', () => {
      expect(escapeFilterValue('ada"or 1 eq 1')).toBe('ada\\"or 1 eq 1')
      expect(escapeFilterValue('back\\slash')).toBe('back\\\\slash')
    })
  })

  // ------------------------------------------------------------------ health

  describe('health', () => {
    it('reports reachable when /ServiceProviderConfig answers', async () => {
      const health = await configure().health()
      expect(health.ok).toBe(true)
      expect(health.detail).toContain(fake.baseUrl)
    })

    it('never throws for a missing secret, and never names its value', async () => {
      delete process.env[SECRET_NAME]
      const health = await configure().health()
      expect(health.ok).toBe(false)
      expect(health.detail).toContain(SECRET_NAME)
      process.env[SECRET_NAME] = fake.bearerToken
    })

    it('never throws for an unconfigured target', async () => {
      const health = await connector.configure({}).health()
      expect(health.ok).toBe(false)
      expect(health.detail).toContain('baseUrl is required')
    })

    it('reports not-ok when the service rejects the credential', async () => {
      fake.bearerToken = 'rotated-elsewhere'
      const health = await configure().health()
      expect(health.ok).toBe(false)
      expect(health.detail).toContain('401')
    })
  })

  // ------------------------------------------------------------------ create

  describe('apply — create', () => {
    it('creates a user and returns the service-assigned immutable id', async () => {
      const result = await configure().apply(desiredUser())

      expect(result.externalId).toMatch(/[0-9a-f-]{36}/)
      const stored = fake.users.get(result.externalId)
      expect(stored).toMatchObject({ userName: 'ada', active: true })
      expect(stored?.name).toEqual({ givenName: 'Ada', familyName: 'Lovelace' })
      expect(stored?.emails).toEqual([{ value: 'ada@example.com', type: 'work', primary: true }])
    })

    /**
     * The interface-wide guarantee, and the one place SCIM is cleaner than
     * Graph: RFC 7643 §4.1.1 makes `password` optional, so unlike
     * `EntraIdConnector` there is no exception to flag — this connector has no
     * code path that can send one.
     */
    it('never sends a password, in any form', async () => {
      await configure().apply(desiredUser())
      const created = fake.requests.filter((request) => request.method === 'POST')
      expect(created).toHaveLength(1)
      const body = JSON.parse(created[0]!.bodyText) as Record<string, unknown>
      expect(body).not.toHaveProperty('password')
      expect(created[0]!.bodyText.toLowerCase()).not.toContain('password')
    })

    it('writes mapped attributes at their remote paths, including the enterprise extension', async () => {
      const id = (
        await configure().apply(
          desiredUser({
            attributes: {
              'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department': ['R&D'],
              'name.middleName': ['Byron'],
            },
          }),
        )
      ).externalId

      const stored = fake.users.get(id) as Record<string, unknown>
      expect((stored['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'] as Record<string, unknown>).department).toBe('R&D')
      expect((stored.name as Record<string, unknown>).middleName).toBe('Byron')
    })

    it('creates a disabled user as active:false rather than skipping it', async () => {
      const id = (await configure().apply(desiredUser({ enabled: false }))).externalId
      expect(fake.users.get(id)?.active).toBe(false)
    })
  })

  // ------------------------------------------------------------------ update

  describe('apply — update', () => {
    it('correlates by immutable id, so a rename updates rather than duplicating', async () => {
      const seeded = fake.seedUser({ userName: 'ada' })

      const result = await configure().apply(desiredUser({ username: 'ada.lovelace', existingExternalId: seeded.id }))

      expect(result.externalId).toBe(seeded.id)
      expect(fake.users.size).toBe(1)
      expect(fake.users.get(seeded.id)?.userName).toBe('ada.lovelace')
    })

    it('falls back to a userName filter when no correlation exists yet', async () => {
      const seeded = fake.seedUser({ userName: 'ada' })
      const result = await configure().apply(desiredUser())
      expect(result.externalId).toBe(seeded.id)
      expect(fake.users.size).toBe(1)
    })

    /** A stored id the service no longer recognises must self-heal via the filter, not fail the sync. */
    it('falls back to the filter when the stored id 404s', async () => {
      const seeded = fake.seedUser({ userName: 'ada' })
      const result = await configure().apply(
        desiredUser({ existingExternalId: '00000000-0000-4000-8000-000000000000' }),
      )
      expect(result.externalId).toBe(seeded.id)
    })

    /**
     * The partial-update clearing gap. PATCH touches only the paths it names,
     * so a remote name that used to be mapped must be actively REMOVED —
     * omitting it would leave the target's stale value in place forever.
     */
    it('actively clears a remote name that is managed but no longer carries a value', async () => {
      const seeded = fake.seedUser({ userName: 'ada', title: 'Analyst' })

      await configure().apply(
        desiredUser({
          existingExternalId: seeded.id,
          attributes: {},
          managedAttributeRemoteNames: ['title'],
        }),
      )

      expect(fake.users.get(seeded.id)).not.toHaveProperty('title')
      const patch = fake.requests.find((request) => request.method === 'PATCH')
      expect(patch?.bodyText).toContain('"op":"remove"')
    })

    it('does not clear a remote name that still carries a value', async () => {
      const seeded = fake.seedUser({ userName: 'ada', title: 'Analyst' })

      await configure().apply(
        desiredUser({
          existingExternalId: seeded.id,
          attributes: { title: ['Engineer'] },
          managedAttributeRemoteNames: ['title'],
        }),
      )

      expect(fake.users.get(seeded.id)?.title).toBe('Engineer')
    })

    /** A target outside TARGETS_NEEDING_MANAGED_ATTRIBUTE_NAMES must degrade to "never clears", not "clears everything". */
    /**
     * RFC 7644 §3.5.2.2 lets a service answer `noTarget` (400) to a `remove`
     * whose path matches nothing. Emitting one for an attribute the user
     * never had would fail the whole sync for that person, so a clear is only
     * sent for a path the target actually holds.
     */
    it('does not emit a remove for a managed name the target never held', async () => {
      const seeded = fake.seedUser({ userName: 'ada' })

      await configure().apply(
        desiredUser({
          existingExternalId: seeded.id,
          attributes: {},
          managedAttributeRemoteNames: ['title', 'department'],
        }),
      )

      const patch = fake.requests.find((request) => request.method === 'PATCH')
      expect(patch?.bodyText).not.toContain('"op":"remove"')
    })

    it('emits a remove only for the managed names actually present', async () => {
      const seeded = fake.seedUser({ userName: 'ada', title: 'Analyst' })

      await configure().apply(
        desiredUser({
          existingExternalId: seeded.id,
          attributes: {},
          managedAttributeRemoteNames: ['title', 'department'],
        }),
      )

      const patch = fake.requests.find((request) => request.method === 'PATCH')
      const body = JSON.parse(patch!.bodyText) as { Operations: Array<{ op: string; path: string }> }
      const removes = body.Operations.filter((operation) => operation.op === 'remove').map((o) => o.path)
      expect(removes).toEqual(['title'])
      expect(fake.users.get(seeded.id)).not.toHaveProperty('title')
    })

    it('clears nothing when the worker supplied no managed names', async () => {
      const seeded = fake.seedUser({ userName: 'ada', title: 'Analyst' })
      await configure().apply(desiredUser({ existingExternalId: seeded.id, attributes: {} }))
      expect(fake.users.get(seeded.id)?.title).toBe('Analyst')
    })

    it('replaces the whole resource in put mode, which self-clears', async () => {
      const seeded = fake.seedUser({ userName: 'ada', title: 'Analyst' })

      await configure({}, 'put').apply(
        desiredUser({ existingExternalId: seeded.id, attributes: {}, managedAttributeRemoteNames: ['title'] }),
      )

      expect(fake.requests.some((request) => request.method === 'PUT')).toBe(true)
      expect(fake.requests.some((request) => request.method === 'PATCH')).toBe(false)
      expect(fake.users.get(seeded.id)).not.toHaveProperty('title')
    })
  })

  // ------------------------------------------------------------------ groups

  describe('groups', () => {
    it('creates a missing group and adds the user to it', async () => {
      const result = await configure().apply(desiredUser({ groups: ['engineering'] }))

      const group = [...fake.groups.values()].find((candidate) => candidate.displayName === 'engineering')
      expect(group).toBeDefined()
      expect(group?.members.map((member) => member.value)).toEqual([result.externalId])
    })

    it('reuses an existing group rather than creating a duplicate', async () => {
      fake.seedGroup('engineering')
      await configure().apply(desiredUser({ groups: ['engineering'] }))
      expect(fake.groups.size).toBe(1)
    })

    /** Reconcile to desired state, never a one-way add — membership this system no longer asserts is removed. */
    it('removes membership this system no longer asserts', async () => {
      const seeded = fake.seedUser({ userName: 'ada' })
      const group = fake.seedGroup('engineering', [seeded.id])

      await configure().apply(desiredUser({ existingExternalId: seeded.id, groups: [] }))

      expect(fake.groups.get(group.id)?.members).toEqual([])
    })

    it('moves a user between groups in one apply', async () => {
      const seeded = fake.seedUser({ userName: 'ada' })
      const from = fake.seedGroup('engineering', [seeded.id])
      const to = fake.seedGroup('research')

      await configure().apply(desiredUser({ existingExternalId: seeded.id, groups: ['research'] }))

      expect(fake.groups.get(from.id)?.members).toEqual([])
      expect(fake.groups.get(to.id)?.members.map((member) => member.value)).toEqual([seeded.id])
    })
  })

  // ----------------------------------------------------------------- disable

  describe('disable', () => {
    it('sets active:false and never issues a DELETE', async () => {
      const seeded = fake.seedUser({ userName: 'ada', active: true })

      await configure().disable(seeded.id)

      expect(fake.users.get(seeded.id)?.active).toBe(false)
      expect(fake.users.has(seeded.id)).toBe(true)
      expect(fake.requests.every((request) => request.method !== 'DELETE')).toBe(true)
    })

    it('works in put mode too, still without a DELETE', async () => {
      const seeded = fake.seedUser({ userName: 'ada', active: true })
      await configure({}, 'put').disable(seeded.id)
      expect(fake.users.get(seeded.id)?.active).toBe(false)
      expect(fake.requests.every((request) => request.method !== 'DELETE')).toBe(true)
    })

    /** The post-condition already holds; failing here would dead-letter an offboarding that has in fact completed. */
    it('treats an unknown id as already satisfied', async () => {
      await expect(configure().disable('00000000-0000-4000-8000-000000000000')).resolves.toBeUndefined()
    })
  })

  // -------------------------------------------------------------------- plan

  describe('plan', () => {
    it('describes a create without writing anything', async () => {
      const operations = await configure().plan(desiredUser())
      expect(operations[0]).toMatchObject({ kind: 'create' })
      expect(fake.users.size).toBe(0)
      expect(fake.requests.every((request) => request.method === 'GET')).toBe(true)
    })

    it('describes an update and any clearing without writing anything', async () => {
      const seeded = fake.seedUser({ userName: 'ada', title: 'Analyst' })
      const operations = await configure().plan(
        desiredUser({ existingExternalId: seeded.id, managedAttributeRemoteNames: ['title'] }),
      )
      expect(operations.some((operation) => operation.description.includes('clear no-longer-mapped'))).toBe(true)
      expect(fake.users.get(seeded.id)?.title).toBe('Analyst')
      expect(fake.requests.every((request) => request.method === 'GET')).toBe(true)
    })
  })

  // ---------------------------------------------------------------- throttle

  describe('throttling and errors', () => {
    it('honours Retry-After and succeeds on the retry', async () => {
      fake.throttleQueue.push({ status: 429, retryAfterSeconds: 0 })
      const result = await configure().apply(desiredUser())
      expect(result.externalId).toBeTruthy()
    })

    it('gives up after the configured retry limit rather than retrying forever', async () => {
      for (let index = 0; index < 5; index += 1) fake.throttleQueue.push({ status: 429, retryAfterSeconds: 0 })
      await expect(configure({ maxThrottleRetries: 2 }).apply(desiredUser())).rejects.toThrow(/throttled this request/)
    })

    it('surfaces a SCIM error detail without echoing anything it sent', async () => {
      fake.forceStatus = 500
      await expect(configure().apply(desiredUser())).rejects.toThrow(/500/)
    })

    it('refuses a secret name outside the CONNECTOR_* namespace', async () => {
      await expect(configure({ tokenSecretName: 'DATABASE_URL' }).apply(desiredUser())).rejects.toBeInstanceOf(
        ForbiddenSecretNameError,
      )
    })
  })

  // ------------------------------------------------------------------- slots

  describe('slot rebinding', () => {
    /**
     * The property the six-slots-one-instance design depends on: rebinding
     * the shared instance to another slot's config must not leak the previous
     * slot's credential or base URL.
     */
    it('rebinds cleanly between two slots', async () => {
      const second = await startScimFake()
      const secondSecret = 'CONNECTOR_SCIM_SECOND_TOKEN'
      process.env[secondSecret] = second.bearerToken

      try {
        await configure().apply(desiredUser({ username: 'first-slot' }))
        expect(fake.users.size).toBe(1)

        connector.configure({ baseUrl: second.baseUrl, tokenSecretName: secondSecret, writeMode: 'patch' })
        await connector.apply(desiredUser({ username: 'second-slot' }))

        expect(second.users.size).toBe(1)
        expect([...second.users.values()][0]!.userName).toBe('second-slot')
        // The first slot saw nothing new.
        expect(fake.users.size).toBe(1)
      } finally {
        delete process.env[secondSecret]
        await second.stop()
      }
    })
  })
})
