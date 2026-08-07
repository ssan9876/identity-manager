import { describe, expect, it, vi } from 'vitest'
import type { DesiredUser } from '../src/connectors/connector'
import { NotApplicableError } from '../src/connectors/connector'
import { MailServerConnector } from '../src/connectors/mail-server.connector'

const CONFIG = {
  baseUrl: 'http://mail.internal/api/v1',
  tokenSecretName: 'MAIL_SERVER_SERVICE_TOKEN',
}

const ENV = { MAIL_SERVER_SERVICE_TOKEN: 'tok' }
const USER_ID = '11111111-1111-1111-1111-111111111111'

function buildDesired(overrides: Partial<DesiredUser> = {}): DesiredUser {
  return {
    userId: USER_ID,
    username: 'jdoe',
    email: 'jane@acme.com',
    firstName: 'Jane',
    lastName: 'Doe',
    enabled: true,
    status: 'active',
    attributes: { mail_enabled: ['true'] },
    groups: [],
    ...overrides,
  }
}

const okResponse = () =>
  new Response(JSON.stringify({ external_id: USER_ID, status: 'active', aliases: [] }), { status: 200 })

/** The JSON body of the Nth fetch call this stub recorded. */
const sentBody = (stub: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> =>
  JSON.parse((stub.mock.calls[index][1] as RequestInit).body as string)

describe('MailServerConnector.health', () => {
  it('reports ok when the provisioning health endpoint answers', async () => {
    const fetchStub = vi.fn(async () => new Response('{"status":"ok"}', { status: 200 }))
    const connector = new MailServerConnector(fetchStub).configure(CONFIG)

    const health = await connector.health({ MAIL_SERVER_SERVICE_TOKEN: 'tok_abc' })

    expect(health.ok).toBe(true)
    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://mail.internal/api/v1/provisioning/health')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok_abc')
  })

  it('reports not-ok, never throws, when the secret is unset', async () => {
    const connector = new MailServerConnector(vi.fn()).configure(CONFIG)

    const health = await connector.health({})

    expect(health.ok).toBe(false)
    expect(health.detail).toContain('MAIL_SERVER_SERVICE_TOKEN')
  })

  it('never puts the secret VALUE in its health detail', async () => {
    const fetchStub = vi.fn(async () => new Response('nope', { status: 403 }))
    const connector = new MailServerConnector(fetchStub).configure(CONFIG)

    const health = await connector.health({ MAIL_SERVER_SERVICE_TOKEN: 'tok_sentinel_value' })

    expect(health.ok).toBe(false)
    expect(health.detail).not.toContain('tok_sentinel_value')
  })

  it('rejects a config that never named a base url', async () => {
    const connector = new MailServerConnector(vi.fn()).configure({ tokenSecretName: 'X' })

    const health = await connector.health({ X: 'tok' })

    expect(health.ok).toBe(false)
    expect(health.detail).toContain('baseUrl')
  })

  it('tolerates a trailing slash on the configured base url', async () => {
    const fetchStub = vi.fn(async () => new Response('{"status":"ok"}', { status: 200 }))
    const connector = new MailServerConnector(fetchStub).configure({
      ...CONFIG,
      baseUrl: 'http://mail.internal/api/v1/',
    })

    await connector.health({ MAIL_SERVER_SERVICE_TOKEN: 'tok' })

    expect(fetchStub.mock.calls[0][0]).toBe('http://mail.internal/api/v1/provisioning/health')
  })
})

describe('MailServerConnector.apply', () => {
  it('PUTs to the identity keyed by our own user id, and returns it', async () => {
    const fetchStub = vi.fn(async () => okResponse())
    const connector = new MailServerConnector(fetchStub).configure(CONFIG)

    const result = await connector.apply(buildDesired(), ENV)

    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`http://mail.internal/api/v1/provisioning/identities/${USER_ID}`)
    expect(init.method).toBe('PUT')
    expect(result.externalId).toBe(USER_ID)
  })

  it('passes the full four-value status straight through', async () => {
    for (const status of ['pending', 'active', 'suspended', 'deactivated'] as const) {
      const fetchStub = vi.fn(async () => okResponse())
      const connector = new MailServerConnector(fetchStub).configure(CONFIG)

      await connector.apply(buildDesired({ status }), ENV)

      expect(sentBody(fetchStub).status).toBe(status)
    }
  })

  it('throws NotApplicable for a user with no mail and no existing identity', async () => {
    const fetchStub = vi.fn()
    const connector = new MailServerConnector(fetchStub).configure(CONFIG)

    await expect(
      connector.apply(buildDesired({ attributes: { mail_enabled: ['false'] } }), ENV),
    ).rejects.toBeInstanceOf(NotApplicableError)

    // The load-bearing half: it must not PUT, or the counterpart's upsert
    // would CREATE a mailbox for someone who should never have had one.
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('deactivates a user who had mail and no longer does — entitlement removal', async () => {
    const fetchStub = vi.fn(async () => okResponse())
    const connector = new MailServerConnector(fetchStub).configure(CONFIG)

    await connector.apply(
      buildDesired({
        status: 'active',
        attributes: { mail_enabled: ['false'] },
        existingExternalId: USER_ID,
      }),
      ENV,
    )

    // Forced to deactivated even though the directory record is still active.
    expect(sentBody(fetchStub).status).toBe('deactivated')
  })

  it('omits absent optional fields rather than sending null', async () => {
    const fetchStub = vi.fn(async () => okResponse())
    const connector = new MailServerConnector(fetchStub).configure(CONFIG)

    await connector.apply(buildDesired(), ENV)

    // The counterpart rejects an explicit null for quota_mb and aliases, and
    // gives absent-vs-null different meanings for every scalar.
    const body = sentBody(fetchStub)
    expect('quota_mb' in body).toBe(false)
    expect('aliases' in body).toBe(false)
    expect(body.email).toBe('jane@acme.com')
  })

  it('maps quota, aliases and admin role from attributes', async () => {
    const fetchStub = vi.fn(async () => okResponse())
    const connector = new MailServerConnector(fetchStub).configure(CONFIG)

    await connector.apply(
      buildDesired({
        attributes: {
          mail_enabled: ['true'],
          mail_quota_mb: ['4096'],
          mail_aliases: ['j.doe@acme.com', 'jd@acme.com'],
          mail_admin_role: ['domain_admin'],
        },
      }),
      ENV,
    )

    const body = sentBody(fetchStub)
    expect(body.quota_mb).toBe(4096)
    expect(body.aliases).toEqual(['j.doe@acme.com', 'jd@acme.com'])
    // domain_admin's domain derives from the user's own primary address.
    expect(body.admin).toEqual({ role: 'domain_admin', domains: ['acme.com'] })
  })

  it('sends an empty aliases array as the explicit "remove them all" signal', async () => {
    const fetchStub = vi.fn(async () => okResponse())
    const connector = new MailServerConnector(fetchStub).configure(CONFIG)

    await connector.apply(
      buildDesired({ attributes: { mail_enabled: ['true'], mail_aliases: [] } }),
      ENV,
    )

    expect(sentBody(fetchStub).aliases).toEqual([])
  })

  it('never builds a payload containing a credential field', async () => {
    const fetchStub = vi.fn(async () => okResponse())
    const connector = new MailServerConnector(fetchStub).configure(CONFIG)

    await connector.apply(
      buildDesired({
        attributes: { mail_enabled: ['true'], password: ['hunter2'], password_hash: ['$2b$x'] },
      }),
      ENV,
    )

    // The schema is closed: an attribute reaches the counterpart only if this
    // connector names it explicitly, so a credential has nowhere to go.
    const body = sentBody(fetchStub)
    expect(Object.keys(body).sort()).toEqual(['display_name', 'email', 'status', 'username'])
    expect(JSON.stringify(body)).not.toContain('hunter2')
  })

  it.each([
    [409, true],
    [422, true],
    [403, false],
    [500, false],
    [503, false],
  ])('maps %i to permanent=%s', async (status, permanent) => {
    const fetchStub = vi.fn(async () => new Response('{"detail":"nope"}', { status: status as number }))
    const connector = new MailServerConnector(fetchStub).configure(CONFIG)

    const error = await connector.apply(buildDesired(), ENV).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(String(status))
    expect((error as { permanent?: boolean }).permanent).toBe(permanent)
  })
})

describe('MailServerConnector.plan', () => {
  it('describes the upsert without writing anything', async () => {
    const fetchStub = vi.fn()
    const connector = new MailServerConnector(fetchStub).configure(CONFIG)

    const ops = await connector.plan(buildDesired(), ENV)

    expect(ops).toHaveLength(1)
    expect(ops[0].kind).toBe('create')
    expect(ops[0].description).toContain('jane@acme.com')
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('reports nothing for a user with no mail and no identity', async () => {
    const connector = new MailServerConnector(vi.fn()).configure(CONFIG)

    const ops = await connector.plan(buildDesired({ attributes: { mail_enabled: ['false'] } }), ENV)

    expect(ops).toEqual([])
  })

  it('reports a disable when an existing identity loses its entitlement', async () => {
    const connector = new MailServerConnector(vi.fn()).configure(CONFIG)

    const ops = await connector.plan(
      buildDesired({ attributes: { mail_enabled: ['false'] }, existingExternalId: USER_ID }),
      ENV,
    )

    expect(ops[0].kind).toBe('disable')
  })
})

describe('MailServerConnector.disable', () => {
  it('reads the current address, then deactivates', async () => {
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ external_id: USER_ID, email: 'jane@acme.com', status: 'active', aliases: [] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(okResponse())

    await new MailServerConnector(fetchStub).configure(CONFIG).disable(USER_ID, ENV)

    expect((fetchStub.mock.calls[0][1] as RequestInit).method).toBe('GET')
    const [url, init] = fetchStub.mock.calls[1] as [string, RequestInit]
    expect(init.method).toBe('PUT')
    expect(url).toBe(`http://mail.internal/api/v1/provisioning/identities/${USER_ID}`)
    expect(sentBody(fetchStub, 1)).toEqual({ email: 'jane@acme.com', status: 'deactivated' })
  })

  it('is a no-op for an unknown identity', async () => {
    const fetchStub = vi.fn(async () => new Response('{"detail":"not found"}', { status: 404 }))

    await new MailServerConnector(fetchStub).configure(CONFIG).disable(USER_ID, ENV)

    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it('is a no-op for an identity with no mailbox to deactivate', async () => {
    const fetchStub = vi.fn(
      async () =>
        new Response(JSON.stringify({ external_id: USER_ID, email: null, status: 'active', aliases: [] }), {
          status: 200,
        }),
    )

    await new MailServerConnector(fetchStub).configure(CONFIG).disable(USER_ID, ENV)

    expect(fetchStub).toHaveBeenCalledTimes(1)
  })
})
