import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'

/**
 * A CONTRACT FAKE for the subset of the Microsoft identity platform token
 * endpoint and Microsoft Graph that `EntraIdConnector` calls — per the design
 * doc's own "Testing" section: "no container exists for Entra ID... these use
 * a contract fake: a real local HTTP server... whose responses are pinned to
 * recorded real API payloads" — and per this task's own explicit instruction,
 * since no live tenant is available to actually record from: every response
 * shape here is instead pinned to Microsoft's OFFICIAL PUBLISHED Graph
 * documentation, checked directly against Microsoft Learn on 2026-08-07 (not
 * recalled from general familiarity) — see the doc comment on each handler
 * below for the exact page.
 *
 * READ THIS PLAINLY, PER THE TASK'S OWN INSTRUCTION: this is a REAL, genuine
 * `node:http` server — `EntraIdConnector` makes REAL HTTP requests to REAL
 * TCP sockets bound on `127.0.0.1`, gets REAL responses, waits REAL
 * milliseconds for a REAL `Retry-After`. That proves the connector's OWN
 * request shapes, its OWN token/retry/throttle state machine, and its OWN
 * error handling — genuinely, not vacuously. It does NOT and CANNOT prove
 * that Microsoft's real Graph service behaves as documented, that these
 * documented shapes remain accurate over time, or that a real tenant's
 * authorization/consent/replication quirks (several of which Microsoft's own
 * docs mention — e.g. new-group member-add replication delay) behave this
 * simply. Mirrors `test/support/samba-ad.ts`'s own honesty about what a
 * fixture proves and does not.
 */

export interface EntraGraphFakeRequest {
  method: string
  /** pathname + search, e.g. `/v1.0/users/abc-123?$select=id,displayName`. */
  path: string
  hasAuthorization: boolean
  bodyText: string
  at: Date
}

interface ThrottleInstruction {
  status: 429 | 503
  retryAfterSeconds: number | null
}

export interface EntraGraphFake {
  tenantId: string
  clientId: string
  /** Mutable (a live accessor, not a snapshot) — a test can reassign this to prove the sentinel/secret-leak proof with a value IT controls, and the token endpoint's own validation picks up the change on the very next request. */
  clientSecret: string
  /** Points `EntraIdConnectorConfig.authorityBaseUrl` here in a test. */
  authorityBaseUrl: string
  /** Points `EntraIdConnectorConfig.graphBaseUrl` here in a test (already includes `/v1.0`). */
  graphBaseUrl: string
  /** Every request this server received, in order — the ONE thing every "prove it against what the fake actually received" assertion in `test/entra-id.connector.spec.ts` reads. */
  readonly requests: EntraGraphFakeRequest[]
  /** How many times `POST {authorityBaseUrl}/{tenantId}/oauth2/v2.0/token` was called — the direct proof for "a 401 refreshes the token exactly once". Mutable so a test can zero it as a clean baseline immediately before its own scenario, without needing a fresh fake per test. */
  tokenRequestCount: number
  /** Every user this fake currently holds, keyed by its Graph `id` — read directly by tests, the same "expose state directly" convention `EchoConnector.calls` already established. */
  readonly users: Map<string, Record<string, unknown>>
  /** Every group this fake currently holds, keyed by its Graph `id`. */
  readonly groups: Map<string, Record<string, unknown>>
  /** The next `count` non-token requests receive `status` (429 or 503) with a `Retry-After` header (seconds; omit `retryAfterSeconds` to send NO header, proving the connector's documented fallback). Real elapsed time is what `EntraIdConnector` actually waits — this fake does not simulate time, it just tells the truth about what Microsoft's own docs say a throttled response looks like. */
  throttleNextGraphRequests(count: number, options?: { status?: 429 | 503; retryAfterSeconds?: number | null }): void
  /** The next `count` non-token requests receive `401 Unauthorized` regardless of the bearer token presented — simulates "the token expired server-side / was invalidated", the exact scenario `EntraIdConnector.graphRequest`'s own doc comment names. */
  rejectNextGraphRequestsWithUnauthorized(count: number): void
  /** The next `count` non-token requests receive an arbitrary `status`/`body` — a generic one-shot failure injector for proving per-principal isolation (one principal's Graph call fails with an ordinary error, unrelated to auth/throttling) without needing a second, bespoke fake variant. */
  failNextGraphRequestsWith(count: number, status: number, body: unknown): void
  /** Simulates a dropped connection: every request (Graph OR token) has its raw socket destroyed immediately, before any response — a genuine TCP-level failure `fetch()` surfaces as a real thrown network error, not a mocked rejection. Mirrors `test/support/samba-ad.ts`'s own `interruptLdap`/`restoreLdap`, adapted to HTTP: the SAME port keeps listening (so a test's already-configured `graphBaseUrl`/`authorityBaseUrl` stay valid), only in-flight/new requests start failing. */
  interrupt(): void
  restore(): void
  stop(): Promise<void>
}

/** https://learn.microsoft.com/en-us/graph/errors — the standard Graph error envelope. */
function graphError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } }
}

/** https://learn.microsoft.com/en-us/graph/throttling, "Sample response" — code/innerError/message shape, reproduced verbatim for the `code` Microsoft's own example uses. */
function throttledBody(): unknown {
  return {
    error: {
      code: 'TooManyRequests',
      innerError: { code: '429', message: 'Please retry after' },
      message: 'Please retry again later.',
    },
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// https://learn.microsoft.com/en-us/graph/api/user-post-users — the required-properties table.
const REQUIRED_USER_CREATE_FIELDS = ['accountEnabled', 'displayName', 'mailNickname', 'userPrincipalName'] as const

function odataIdToDirectoryObjectId(odataId: unknown): string | null {
  if (typeof odataId !== 'string' || odataId.length === 0) return null
  const segments = odataId.split('/')
  return segments[segments.length - 1] ?? null
}

interface FailureInstruction {
  status: number
  body: unknown
}

export async function startEntraGraphFake(): Promise<EntraGraphFake> {
  const tenantId = `tenant-${randomUUID()}`
  const clientId = `client-${randomUUID()}`
  let clientSecret = `secret-${randomUUID()}`

  const requests: EntraGraphFakeRequest[] = []
  const users = new Map<string, Record<string, unknown>>()
  const groups = new Map<string, Record<string, unknown>>()
  let tokenRequestCount = 0
  let pendingThrottle: ThrottleInstruction[] = []
  let pendingUnauthorized = 0
  let pendingFailures: FailureInstruction[] = []
  let interrupted = false

  function recordRequest(req: IncomingMessage, bodyText: string): void {
    requests.push({
      method: req.method ?? 'GET',
      path: req.url ?? '',
      hasAuthorization: typeof req.headers.authorization === 'string' && req.headers.authorization.length > 0,
      bodyText,
      at: new Date(),
    })
  }

  function selectFields(stored: Record<string, unknown>, select: string | null): Record<string, unknown> {
    if (select === null) {
      return { ...stored }
    }
    const fields = new Set(['id', ...select.split(',').map((f) => f.trim()).filter((f) => f.length > 0)])
    const result: Record<string, unknown> = {}
    for (const field of fields) {
      if (Object.hasOwn(stored, field)) {
        result[field] = stored[field]
      }
    }
    return result
  }

  const server: Server = createServer((req, res) => {
    if (interrupted) {
      // A genuine TCP-level failure — no HTTP response is ever written, the
      // raw socket is torn down — so `fetch()` on the connector side
      // surfaces a real thrown network error, not a mocked rejection. See
      // `interrupt`/`restore`'s own doc comment (the `EntraGraphFake`
      // interface, above) for why this simulates a dropped connection
      // without actually closing the listening port.
      req.socket.destroy()
      return
    }
    void (async () => {
      const bodyText = await readBody(req)
      recordRequest(req, bodyText)
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const method = req.method ?? 'GET'

      function send(status: number, body?: unknown): void {
        if (body === undefined) {
          res.writeHead(status)
          res.end()
          return
        }
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }

      // -----------------------------------------------------------------
      // Token endpoint — https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow
      // -----------------------------------------------------------------
      if (method === 'POST' && url.pathname === `/${tenantId}/oauth2/v2.0/token`) {
        tokenRequestCount += 1
        const form = new URLSearchParams(bodyText)
        if (form.get('grant_type') !== 'client_credentials' || form.get('client_id') !== clientId || form.get('client_secret') !== clientSecret) {
          // https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow — "Error response".
          send(401, {
            error: 'invalid_client',
            error_description: 'AADSTS7000215: Invalid client secret is provided (fake, illustrative shape).',
            error_codes: [7000215],
            timestamp: new Date().toISOString(),
            trace_id: randomUUID(),
            correlation_id: randomUUID(),
          })
          return
        }
        // https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow — "Successful response".
        send(200, { token_type: 'Bearer', expires_in: 3599, access_token: `token-${randomUUID()}` })
        return
      }

      // Everything else is Graph — must be authenticated and, per this
      // fake's own test hooks, may be deliberately throttled/unauthorized.
      if (!url.pathname.startsWith('/v1.0/')) {
        send(404, graphError('NotFound', `no route for ${method} ${url.pathname}`))
        return
      }
      const path = url.pathname.slice('/v1.0'.length)
      const authorization = req.headers.authorization
      if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
        send(401, graphError('InvalidAuthenticationToken', 'Access token is missing or malformed.'))
        return
      }
      if (pendingUnauthorized > 0) {
        pendingUnauthorized -= 1
        send(401, graphError('InvalidAuthenticationToken', 'Access token has expired or is not yet valid (fake, injected).'))
        return
      }
      const failure = pendingFailures.shift()
      if (failure !== undefined) {
        send(failure.status, failure.body)
        return
      }
      const throttle = pendingThrottle.shift()
      if (throttle !== undefined) {
        if (throttle.retryAfterSeconds !== null) {
          res.setHeader('Retry-After', String(throttle.retryAfterSeconds))
        }
        send(throttle.status, throttledBody())
        return
      }

      let jsonBody: Record<string, unknown> | undefined
      if (bodyText.length > 0) {
        try {
          jsonBody = JSON.parse(bodyText) as Record<string, unknown>
        } catch {
          send(400, graphError('BadRequest', 'request body is not valid JSON'))
          return
        }
      }

      // ---- GET /users/{id|upn} ------------------------------------------
      const getUserMatch = /^\/users\/([^/]+)$/.exec(path)
      if (method === 'GET' && getUserMatch) {
        const key = decodeURIComponent(getUserMatch[1]!)
        const stored = users.get(key) ?? [...users.values()].find((u) => u.userPrincipalName === key)
        if (stored === undefined) {
          // https://learn.microsoft.com/en-us/graph/errors — 404 row.
          send(404, graphError('Request_ResourceNotFound', `Resource '${key}' does not exist.`))
          return
        }
        send(200, selectFields(stored, url.searchParams.get('$select')))
        return
      }

      // ---- POST /users — https://learn.microsoft.com/en-us/graph/api/user-post-users
      if (method === 'POST' && path === '/users') {
        const body = jsonBody ?? {}
        const missing: string[] = REQUIRED_USER_CREATE_FIELDS.filter((field) => !Object.hasOwn(body, field))
        const passwordProfile = body.passwordProfile as { password?: unknown } | undefined
        if (passwordProfile === undefined || typeof passwordProfile.password !== 'string' || passwordProfile.password.length === 0) {
          missing.push('passwordProfile.password')
        }
        if (missing.length > 0) {
          send(400, graphError('BadRequest', `Missing required propert${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')}`))
          return
        }
        const upn = body.userPrincipalName
        if (typeof upn === 'string' && [...users.values()].some((u) => u.userPrincipalName === upn)) {
          send(400, graphError('Request_BadRequest', `Another object with the same value for property userPrincipalName already exists.`))
          return
        }
        const id = randomUUID()
        const stored: Record<string, unknown> = { ...body, id }
        delete stored.passwordProfile // Graph never echoes this back — see user-post-users's own example response, which never includes it.
        users.set(id, stored)
        // https://learn.microsoft.com/en-us/graph/api/user-post-users — "Response": 201 + the user object.
        send(201, { ...stored })
        return
      }

      // ---- PATCH /users/{id} — https://learn.microsoft.com/en-us/graph/api/user-update
      const patchUserMatch = /^\/users\/([^/]+)$/.exec(path)
      if (method === 'PATCH' && patchUserMatch) {
        const id = decodeURIComponent(patchUserMatch[1]!)
        const stored = users.get(id)
        if (stored === undefined) {
          send(404, graphError('Request_ResourceNotFound', `Resource '${id}' does not exist.`))
          return
        }
        for (const [key, value] of Object.entries(jsonBody ?? {})) {
          if (value === null) {
            delete stored[key] // explicit null clears — see user-update's own "remove any stored data by setting... to null".
          } else {
            stored[key] = value
          }
        }
        // https://learn.microsoft.com/en-us/graph/api/user-update — "Response": 204 No Content, no body.
        send(204)
        return
      }

      // ---- GET /users/{id}/memberOf — https://learn.microsoft.com/en-us/graph/api/user-list-memberof
      const memberOfMatch = /^\/users\/([^/]+)\/memberOf$/.exec(path)
      if (method === 'GET' && memberOfMatch) {
        const id = decodeURIComponent(memberOfMatch[1]!)
        const select = url.searchParams.get('$select')
        const memberships = [...groups.values()]
          .filter((g) => Array.isArray(g.memberIds) && (g.memberIds as string[]).includes(id))
          .map((g) => ({ ...selectFields(g, select), '@odata.type': '#microsoft.graph.group' }))
        send(200, { value: memberships })
        return
      }

      // ---- GET /groups?$filter=displayName eq '...' — https://learn.microsoft.com/en-us/graph/api/group-list
      if (method === 'GET' && path === '/groups') {
        const filter = url.searchParams.get('$filter') ?? ''
        const match = /^displayName eq '(.*)'$/.exec(filter)
        const wanted = match ? match[1]!.replace(/''/g, "'") : null
        const select = url.searchParams.get('$select')
        const matched = [...groups.values()].filter((g) => wanted === null || g.displayName === wanted)
        send(200, { value: matched.map((g) => selectFields(g, select)) })
        return
      }

      // ---- POST /groups — https://learn.microsoft.com/en-us/graph/api/group-post-groups
      if (method === 'POST' && path === '/groups') {
        const body = jsonBody ?? {}
        for (const field of ['displayName', 'mailEnabled', 'mailNickname', 'securityEnabled']) {
          if (!Object.hasOwn(body, field)) {
            send(400, graphError('BadRequest', `Missing required property: ${field}`))
            return
          }
        }
        const id = randomUUID()
        const stored: Record<string, unknown> = { ...body, id, memberIds: [] }
        groups.set(id, stored)
        send(201, { ...stored, memberIds: undefined })
        return
      }

      // ---- POST /groups/{id}/members/$ref — https://learn.microsoft.com/en-us/graph/api/group-post-members
      const addMemberMatch = /^\/groups\/([^/]+)\/members\/\$ref$/.exec(path)
      if (method === 'POST' && addMemberMatch) {
        const groupId = decodeURIComponent(addMemberMatch[1]!)
        const group = groups.get(groupId)
        if (group === undefined) {
          send(404, graphError('Request_ResourceNotFound', `Resource '${groupId}' does not exist.`))
          return
        }
        const memberId = odataIdToDirectoryObjectId(jsonBody?.['@odata.id'])
        if (memberId === null || !users.has(memberId)) {
          send(400, graphError('Request_BadRequest', 'The source resource object or one of the objects being referenced don\'t exist.'))
          return
        }
        const memberIds = group.memberIds as string[]
        if (!memberIds.includes(memberId)) {
          memberIds.push(memberId)
        }
        // https://learn.microsoft.com/en-us/graph/api/group-post-members — "Response": 204 No Content.
        send(204)
        return
      }

      // ---- DELETE /groups/{id}/members/{id}/$ref — https://learn.microsoft.com/en-us/graph/api/group-delete-members
      const removeMemberMatch = /^\/groups\/([^/]+)\/members\/([^/]+)\/\$ref$/.exec(path)
      if (method === 'DELETE' && removeMemberMatch) {
        const groupId = decodeURIComponent(removeMemberMatch[1]!)
        const memberId = decodeURIComponent(removeMemberMatch[2]!)
        const group = groups.get(groupId)
        if (group === undefined) {
          send(404, graphError('Request_ResourceNotFound', `Resource '${groupId}' does not exist.`))
          return
        }
        group.memberIds = (group.memberIds as string[]).filter((id) => id !== memberId)
        send(204)
        return
      }

      // Anything else this connector should NEVER send (a bare
      // `/users/{id}` DELETE, a `/groups/{id}/members/{id}` DELETE with no
      // `/$ref`, ...) is still answered — deliberately, so a RED run (this
      // guarantee's protection temporarily removed in source, per this
      // task's own "confirm each guarantee test goes red" instruction) has
      // somewhere real to land and be observed, rather than the fake itself
      // masking the regression by refusing the call. The actual guarantee is
      // the REQUEST LOG assertion ("the fake received no DELETE request
      // targeting /users/"), never this fake declining to serve the route.
      if (method === 'DELETE' && /^\/users\/[^/]+$/.exec(path)) {
        const id = path.slice('/users/'.length)
        users.delete(id)
        send(204)
        return
      }

      send(404, graphError('NotFound', `no route for ${method} ${url.pathname}`))
    })().catch((error: unknown) => {
      // A bug in this fake itself, not a scenario under test — fail loudly
      // rather than hanging the request.
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'FakeInternalError', message: error instanceof Error ? error.message : String(error) } }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('entra graph fake failed to bind to a port')
  }
  const origin = `http://127.0.0.1:${address.port}`

  return {
    tenantId,
    clientId,
    get clientSecret() {
      return clientSecret
    },
    set clientSecret(value: string) {
      clientSecret = value
    },
    authorityBaseUrl: origin,
    graphBaseUrl: `${origin}/v1.0`,
    requests,
    get tokenRequestCount() {
      return tokenRequestCount
    },
    set tokenRequestCount(value: number) {
      tokenRequestCount = value
    },
    users,
    groups,
    throttleNextGraphRequests(count, options = {}) {
      const status = options.status ?? 429
      // `null` explicitly means "omit the Retry-After header" (proving the
      // documented fallback — a real, if less common, shape per
      // https://learn.microsoft.com/en-us/graph/errors' own 503 row: a retry
      // delay "can be specified", not "is always"); absent/undefined means
      // "use a small sensible default" so most call sites need not think
      // about it.
      const retryAfterSeconds = options.retryAfterSeconds === null ? null : (options.retryAfterSeconds ?? 1)
      pendingThrottle = [...pendingThrottle, ...Array.from({ length: count }, () => ({ status, retryAfterSeconds }))]
    },
    rejectNextGraphRequestsWithUnauthorized(count) {
      pendingUnauthorized += count
    },
    failNextGraphRequestsWith(count, status, body) {
      pendingFailures = [...pendingFailures, ...Array.from({ length: count }, () => ({ status, body }))]
    },
    interrupt() {
      interrupted = true
    },
    restore() {
      interrupted = false
    },
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
