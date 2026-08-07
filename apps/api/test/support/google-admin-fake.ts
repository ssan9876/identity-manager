import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { importSPKI, jwtVerify } from 'jose'

/**
 * A CONTRACT FAKE for the subset of Google's OAuth2 service-account token
 * endpoint and the Admin SDK Directory API that `GoogleWorkspaceConnector`
 * calls — per the design doc's own "Testing" section: "no container exists
 * for... Google Workspace... these use a contract fake: a real local HTTP
 * server... whose responses are pinned to recorded real API payloads" — and
 * per this task's own explicit instruction, since no live Workspace tenant
 * is available to actually record from: every response shape here is
 * instead pinned to Google's OFFICIALLY PUBLISHED Admin SDK / identity
 * documentation, checked directly against developers.google.com on
 * 2026-08-07 (not recalled from general familiarity) — see the doc comment
 * on each handler below for the exact page it was checked against, and this
 * task's report for the one page (the Directory API's own dedicated error
 * reference) that returned 404 when fetched directly, corroborated instead
 * from Google's broader, consistently-documented API error convention.
 *
 * READ THIS PLAINLY, PER THE TASK'S OWN INSTRUCTION: this is a REAL,
 * genuine `node:http` server — `GoogleWorkspaceConnector` makes REAL HTTP
 * requests to REAL TCP sockets bound on `127.0.0.1`, gets REAL responses.
 * That proves the connector's OWN request shapes, its OWN token/retry/
 * throttle state machine, and its OWN error handling — genuinely, not
 * vacuously. It does NOT and CANNOT prove that Google's real Workspace
 * service behaves as documented, that these documented shapes remain
 * accurate over time, or that a real tenant's domain-wide-delegation
 * authorization/consent nuances (Google's own docs name several — admin
 * console authorization, scope grants, `admin_policy_enforced`) behave this
 * simply. Mirrors `test/support/entra-graph-fake.ts`'s own honesty about
 * what a fixture proves and does not.
 *
 * ONE DELIBERATE FIDELITY IMPROVEMENT OVER THE ENTRA FAKE, WORTH STATING
 * PLAINLY: Entra's fake validates the OAuth client secret via a simple
 * STRING COMPARISON — that fake's own report explicitly flags this as a
 * limitation ("not real certificate/JWT-bearer/token-signature semantics").
 * Google's OWN flow is genuinely JWT-bearer-shaped from the start (a
 * service account signs an assertion; there is no shared-secret grant to
 * fall back to), so THIS fake generates a REAL RSA keypair at startup and
 * performs REAL RS256 SIGNATURE VERIFICATION (`jose`'s own `jwtVerify` —
 * the SAME library, and the SAME verification call shape, this project's
 * `auth/jwt.guard.ts` already uses for real production JWT verification)
 * against the connector's ACTUAL signed assertion, including `iss`/`aud`/
 * expiry checks. This is a genuine, not merely claimed, step up in fidelity
 * in exactly the dimension Entra's own fake named as a gap — though it is
 * still a fake's OWN verification, standing in for Google's real service,
 * not proof that Google's real token endpoint behaves identically.
 */

export interface GoogleAdminFakeRequest {
  method: string
  /** pathname + search, e.g. `/admin/directory/v1/users/abc-123`. */
  path: string
  hasAuthorization: boolean
  bodyText: string
  at: Date
}

interface ThrottleInstruction {
  status: 429 | 403
  /** Only meaningful for a 403 — the `error.errors[0].reason` this connector's own `isQuotaThrottleReason` inspects. Defaults to `'quotaExceeded'`. */
  reason?: string
  retryAfterSeconds: number | null
}

interface FailureInstruction {
  status: number
  body: unknown
}

export interface GoogleAdminFake {
  /** The service account email THIS fake trusts (the JWT `iss` this fake's token endpoint verifies against). */
  serviceAccountEmail: string
  /** The FULL service-account key JSON blob — `{"client_email": ..., "private_key": ...}` — matching what a real downloaded Google service-account key file contains. Point `GoogleWorkspaceConnectorConfig`'s resolved `credentialSecretName` env var at THIS value in a test. */
  readonly serviceAccountKeyJson: string
  /** The admin subject THIS fake requires the JWT `sub` claim to match (domain-wide delegation) — a mismatch is rejected with `admin_policy_enforced`, mirroring Google's own documented error code for exactly this failure. */
  impersonatedAdminEmail: string
  /** Points `GoogleWorkspaceConnectorConfig.domain` here in a test. */
  domain: string
  /** Points `GoogleWorkspaceConnectorConfig.tokenUrl` here in a test (the fake's own token endpoint — also the JWT `aud` this fake's verification requires). */
  tokenUrl: string
  /** Points `GoogleWorkspaceConnectorConfig.adminBaseUrl` here in a test. */
  adminBaseUrl: string
  /** Every request this server received, in order — the ONE thing every "prove it against what the fake actually received" assertion in `test/google-workspace.connector.spec.ts` reads. */
  readonly requests: GoogleAdminFakeRequest[]
  /** How many times the token endpoint was called. Mutable so a test can zero it as a clean baseline immediately before its own scenario, without needing a fresh fake per test. */
  tokenRequestCount: number
  /** Every user this fake currently holds, keyed by its Google `id` — read directly by tests, the same "expose state directly" convention `EchoConnector.calls`/`EntraGraphFake.users` already establish. */
  readonly users: Map<string, Record<string, unknown>>
  /** Every group this fake currently holds, keyed by its Google `id` — each entry additionally carries a `memberIds: string[]` the fake itself manages. */
  readonly groups: Map<string, Record<string, unknown>>
  /** The next `count` non-token requests receive `status` (429 or 403) with a throttle-shaped body — a 429 needs no `reason`; a 403 defaults to `reason: 'quotaExceeded'` unless overridden (e.g. `'userRateLimitExceeded'`/`'rateLimitExceeded'`, or an unrelated reason to prove a 403 is NOT always retried). `retryAfterSeconds: null` omits the `Retry-After` header entirely, proving this connector's own documented fallback (Google's real Directory API sends none — see `computeThrottleWaitMs`'s own doc comment); omitted/`undefined` sends a small sensible default. */
  throttleNextAdminRequests(count: number, options?: { status?: 429 | 403; reason?: string; retryAfterSeconds?: number | null }): void
  /** The next `count` non-token requests receive `401` regardless of the bearer token presented — simulates "the token expired server-side / was invalidated". */
  rejectNextAdminRequestsWithUnauthorized(count: number): void
  /** The next `count` non-token requests receive an arbitrary `status`/`body` — a generic one-shot failure injector, e.g. for per-principal isolation proofs. */
  failNextAdminRequestsWith(count: number, status: number, body: unknown): void
  /** Simulates a dropped connection: every request (Admin SDK OR token) has its raw socket destroyed immediately, before any response. Mirrors `entra-graph-fake.ts`'s own `interrupt`/`restore`. */
  interrupt(): void
  restore(): void
  stop(): Promise<void>
}

/** The standard Google API JSON error envelope — see this file's own top doc comment for the corroboration path (the Admin SDK's own dedicated error-reference page 404'd when fetched directly during this task; this shape is corroborated from Google's broader, consistently-documented API error convention instead). */
function googleError(code: number, message: string, reason = 'invalid'): unknown {
  return { error: { errors: [{ domain: 'global', reason, message }], code, message } }
}

/** https://developers.google.com/admin-sdk/directory/v1/limits — the Directory API's own documented quota-error reasons, reproduced as the `error.errors[0].reason` this connector's `isQuotaThrottleReason` inspects. */
function throttledBody(reason: string): unknown {
  return googleError(reason === 'rateLimitExceeded' ? 429 : 403, 'Rate Limit Exceeded (fake, illustrative shape).', reason)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// https://developers.google.com/admin-sdk/directory/v1/guides/manage-users — "A password is required for new user accounts" — plus primaryEmail/name.givenName/name.familyName, confirmed directly against https://developers.google.com/admin-sdk/directory/reference/rest/v1/users's own field descriptions.
function missingRequiredCreateFields(body: Record<string, unknown>): string[] {
  const missing: string[] = []
  if (typeof body.primaryEmail !== 'string' || body.primaryEmail.length === 0) {
    missing.push('primaryEmail')
  }
  const name = body.name as { givenName?: unknown; familyName?: unknown } | undefined
  if (typeof name?.givenName !== 'string' || name.givenName.length === 0) {
    missing.push('name.givenName')
  }
  if (typeof name?.familyName !== 'string' || name.familyName.length === 0) {
    missing.push('name.familyName')
  }
  if (typeof body.password !== 'string' || body.password.length < 8) {
    missing.push('password')
  }
  return missing
}

const ADMIN_PATH_PREFIX = '/admin/directory/v1'

export async function startGoogleAdminFake(): Promise<GoogleAdminFake> {
  const serviceAccountEmail = `fake-connector-${randomUUID()}@fake-project.iam.gserviceaccount.com`
  const { publicKey: publicKeyPem, privateKey: privateKeyPem } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const serviceAccountKeyJson = JSON.stringify({ client_email: serviceAccountEmail, private_key: privateKeyPem })
  const trustedPublicKey = await importSPKI(publicKeyPem, 'RS256')

  let impersonatedAdminEmail = `fake-admin-${randomUUID()}@example.com`
  let domain = 'example.com'

  const requests: GoogleAdminFakeRequest[] = []
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

  // Set once the server is actually listening (below) — the JWT `aud` this
  // fake's own token endpoint requires (Google's real endpoint requires
  // `aud` to equal ITSELF; this fake, standing in for it, requires the
  // identical thing against its OWN real, bound address rather than a
  // hardcoded production URL — see `buildAssertion`'s own doc comment in
  // google-workspace.connector.ts for why `config.tokenUrl` generalises
  // correctly for both).
  let tokenAudience = ''

  const server: Server = createServer((req, res) => {
    if (interrupted) {
      // A genuine TCP-level failure — see `entra-graph-fake.ts`'s own
      // `interrupt`/`restore` doc comment for the identical reasoning,
      // adapted to this fake.
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
      // Token endpoint — https://developers.google.com/identity/protocols/oauth2/service-account
      // -----------------------------------------------------------------
      if (method === 'POST' && url.pathname === '/token') {
        tokenRequestCount += 1
        const form = new URLSearchParams(bodyText)
        const assertion = form.get('assertion')
        if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || assertion === null) {
          send(400, { error: 'invalid_request', error_description: 'fake: missing or invalid grant_type/assertion' })
          return
        }

        let sub: string | undefined
        try {
          const { payload } = await jwtVerify(assertion, trustedPublicKey, {
            issuer: serviceAccountEmail,
            audience: tokenAudience,
            algorithms: ['RS256'],
          })
          sub = payload.sub
        } catch {
          // https://developers.google.com/identity/protocols/oauth2/service-account — documented token-endpoint error codes include "invalid_grant" (bad signature, issuer, audience, or expired assertion).
          send(400, { error: 'invalid_grant', error_description: 'fake: JWT assertion failed verification' })
          return
        }
        if (sub !== impersonatedAdminEmail) {
          // Same page — "admin_policy_enforced" is Google's own documented
          // error code for a domain-wide-delegation authorization failure;
          // a `sub` this fake was not told to trust is exactly that shape.
          send(400, { error: 'admin_policy_enforced', error_description: 'fake: domain-wide delegation not authorized for this subject' })
          return
        }
        // "Successful response" — {access_token, scope, token_type, expires_in}.
        send(200, { access_token: `token-${randomUUID()}`, token_type: 'Bearer', expires_in: 3599 })
        return
      }

      // Everything else is the Admin SDK — must be authenticated and, per
      // this fake's own test hooks, may be deliberately throttled/
      // unauthorized/failed.
      if (!url.pathname.startsWith(ADMIN_PATH_PREFIX)) {
        send(404, googleError(404, `no route for ${method} ${url.pathname}`, 'notFound'))
        return
      }
      const path = url.pathname.slice(ADMIN_PATH_PREFIX.length)
      const authorization = req.headers.authorization
      if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
        send(401, googleError(401, 'Invalid Credentials', 'authError'))
        return
      }
      if (pendingUnauthorized > 0) {
        pendingUnauthorized -= 1
        send(401, googleError(401, 'Invalid Credentials (fake, injected)', 'authError'))
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
        send(throttle.status, throttledBody(throttle.reason ?? 'quotaExceeded'))
        return
      }

      let jsonBody: Record<string, unknown> | undefined
      if (bodyText.length > 0) {
        try {
          jsonBody = JSON.parse(bodyText) as Record<string, unknown>
        } catch {
          send(400, googleError(400, 'request body is not valid JSON', 'parseError'))
          return
        }
      }

      // ---- GET /groups?userKey=... — https://developers.google.com/admin-sdk/directory/reference/rest/v1/groups/list
      // Checked BEFORE the generic /groups/{groupKey} route below — both
      // match `path === '/groups'`, but this branch only fires when a
      // `userKey` query parameter is actually present.
      if (method === 'GET' && path === '/groups' && url.searchParams.has('userKey')) {
        const userKeyRaw = url.searchParams.get('userKey')!
        // `userKey` accepts id OR email (https://developers.google.com/admin-sdk/directory/reference/rest/v1/groups/list) — `memberIds` (this fake's own internal bookkeeping) always stores the CANONICAL user id (see `addMember`'s own resolution below), so an email-shaped `userKey` is resolved to that same canonical id before filtering.
        const resolvedUser = users.get(userKeyRaw) ?? [...users.values()].find((u) => u.primaryEmail === userKeyRaw)
        const canonicalId = resolvedUser === undefined ? userKeyRaw : String(resolvedUser.id)
        const memberships = [...groups.values()].filter((g) => (g.memberIds as string[]).includes(canonicalId))
        send(200, { kind: 'admin#directory#groups', groups: memberships.map((g) => ({ ...g, memberIds: undefined })) })
        return
      }

      // ---- GET /users/{userKey} — id OR primaryEmail — https://developers.google.com/admin-sdk/directory/reference/rest/v1/users/get
      const getUserMatch = /^\/users\/([^/]+)$/.exec(path)
      if (method === 'GET' && getUserMatch) {
        const key = decodeURIComponent(getUserMatch[1]!)
        const stored = users.get(key) ?? [...users.values()].find((u) => u.primaryEmail === key)
        if (stored === undefined) {
          send(404, googleError(404, `Resource Not Found: userKey`, 'notFound'))
          return
        }
        send(200, { ...stored })
        return
      }

      // ---- POST /users — https://developers.google.com/admin-sdk/directory/reference/rest/v1/users/insert
      // Success status 200 (NOT 201) — confirmed directly against
      // https://developers.google.com/admin-sdk/directory/v1/guides/manage-users,
      // "A successful response returns HTTP 200 status code".
      if (method === 'POST' && path === '/users') {
        const body = jsonBody ?? {}
        const missing = missingRequiredCreateFields(body)
        if (missing.length > 0) {
          send(400, googleError(400, `Missing or invalid required field(s): ${missing.join(', ')}`, 'required'))
          return
        }
        const primaryEmail = body.primaryEmail
        if (typeof primaryEmail === 'string' && [...users.values()].some((u) => u.primaryEmail === primaryEmail)) {
          send(409, googleError(409, 'Entity already exists.', 'duplicate'))
          return
        }
        const id = randomUUID()
        const stored: Record<string, unknown> = { ...body, id, kind: 'admin#directory#user' }
        delete stored.password // "the password value is never returned in the API's response body" — confirmed directly against the User resource's own `password` field description.
        users.set(id, stored)
        send(200, { ...stored })
        return
      }

      // ---- PUT /users/{id} — https://developers.google.com/admin-sdk/directory/reference/rest/v1/users/update
      // "patch semantics": omitted fields preserved, fields set to `null` are cleared.
      const putUserMatch = /^\/users\/([^/]+)$/.exec(path)
      if (method === 'PUT' && putUserMatch) {
        const id = decodeURIComponent(putUserMatch[1]!)
        const stored = users.get(id)
        if (stored === undefined) {
          send(404, googleError(404, `Resource Not Found: userKey`, 'notFound'))
          return
        }
        for (const [key, value] of Object.entries(jsonBody ?? {})) {
          if (value === null) {
            delete stored[key] // explicit null clears — "fields set to null will be cleared".
          } else if (key === 'password') {
            // Same "never returned" rule as create — a password sent on
            // UPDATE (this connector never sends one, but the fake stays
            // honest regardless) is likewise never echoed back or stored
            // under a key any later GET could ever return.
            continue
          } else {
            stored[key] = value
          }
        }
        send(200, { ...stored })
        return
      }

      // ---- GET /groups/{groupKey} — email OR id — https://developers.google.com/admin-sdk/directory/reference/rest/v1/groups/get
      const getGroupMatch = /^\/groups\/([^/]+)$/.exec(path)
      if (method === 'GET' && getGroupMatch) {
        const key = decodeURIComponent(getGroupMatch[1]!)
        const stored = groups.get(key) ?? [...groups.values()].find((g) => g.email === key)
        if (stored === undefined) {
          send(404, googleError(404, 'Resource Not Found: groupKey', 'notFound'))
          return
        }
        send(200, { ...stored, memberIds: undefined })
        return
      }

      // ---- POST /groups — https://developers.google.com/admin-sdk/directory/reference/rest/v1/groups/insert
      // Status code inferred from users.insert's own confirmed "200, not
      // 201" convention (the groups.insert page itself did not show a
      // worked example with an explicit status) — a reasonable, flagged
      // generalisation across the SAME API family, not an independently
      // confirmed-for-groups source.
      if (method === 'POST' && path === '/groups') {
        const body = jsonBody ?? {}
        if (typeof body.email !== 'string' || body.email.length === 0) {
          send(400, googleError(400, 'Missing required field: email', 'required'))
          return
        }
        if ([...groups.values()].some((g) => g.email === body.email)) {
          send(409, googleError(409, 'Entity already exists.', 'duplicate'))
          return
        }
        const id = randomUUID()
        const stored: Record<string, unknown> = { ...body, id, kind: 'admin#directory#group', memberIds: [] }
        groups.set(id, stored)
        send(200, { ...stored, memberIds: undefined })
        return
      }

      // ---- POST /groups/{groupId}/members — https://developers.google.com/admin-sdk/directory/v1/guides/manage-group-members
      // Documented EXAMPLE request body uses "email" (not "id") — this
      // fake resolves the given member reference against EITHER a known
      // user id OR primaryEmail, matching Google's own general
      // id-or-email-interchangeable convention elsewhere in this API.
      const addMemberMatch = /^\/groups\/([^/]+)\/members$/.exec(path)
      if (method === 'POST' && addMemberMatch) {
        const groupId = decodeURIComponent(addMemberMatch[1]!)
        const group = groups.get(groupId)
        if (group === undefined) {
          send(404, googleError(404, 'Resource Not Found: groupKey', 'notFound'))
          return
        }
        const memberRef = (jsonBody?.email as string | undefined) ?? (jsonBody?.id as string | undefined)
        const resolvedUser = memberRef === undefined ? undefined : (users.get(memberRef) ?? [...users.values()].find((u) => u.primaryEmail === memberRef))
        if (resolvedUser === undefined) {
          send(404, googleError(404, 'Resource Not Found: memberKey', 'notFound'))
          return
        }
        const memberId = String(resolvedUser.id)
        const memberIds = group.memberIds as string[]
        if (!memberIds.includes(memberId)) {
          memberIds.push(memberId)
        }
        send(200, { kind: 'admin#directory#member', id: memberId, email: resolvedUser.primaryEmail, role: (jsonBody?.role as string | undefined) ?? 'MEMBER', type: 'USER' })
        return
      }

      // ---- DELETE /groups/{groupId}/members/{memberKey} — id OR email — https://developers.google.com/admin-sdk/directory/v1/guides/manage-group-members
      // Empty response body (204) — the Directory API's own reference page
      // for this method describes only "a generic HTTP response", with no
      // explicit status code stated; 204 follows ordinary REST DELETE
      // convention and is flagged here as such, not independently
      // confirmed the way `users.insert`'s "200, not 201" text is.
      const removeMemberMatch = /^\/groups\/([^/]+)\/members\/([^/]+)$/.exec(path)
      if (method === 'DELETE' && removeMemberMatch) {
        const groupId = decodeURIComponent(removeMemberMatch[1]!)
        const memberKey = decodeURIComponent(removeMemberMatch[2]!)
        const group = groups.get(groupId)
        if (group === undefined) {
          send(404, googleError(404, 'Resource Not Found: groupKey', 'notFound'))
          return
        }
        const resolvedUser = users.get(memberKey) ?? [...users.values()].find((u) => u.primaryEmail === memberKey)
        const memberId = resolvedUser === undefined ? memberKey : String(resolvedUser.id)
        group.memberIds = (group.memberIds as string[]).filter((id) => id !== memberId)
        send(204)
        return
      }

      // Anything else this connector should NEVER send (a bare
      // `/users/{id}` DELETE, a `/groups/{id}` DELETE, ...) is still
      // answered — deliberately, so a RED run (this guarantee's
      // protection temporarily removed in source, per this task's own
      // "confirm each guarantee test goes red" instruction) has somewhere
      // real to land and be observed, rather than the fake itself masking
      // the regression by refusing the call. The actual guarantee is the
      // REQUEST LOG assertion ("the fake received no DELETE request
      // targeting /users/ or a bare /groups/{id}"), never this fake
      // declining to serve the route. Mirrors `entra-graph-fake.ts`'s own
      // identical, deliberate choice.
      if (method === 'DELETE' && /^\/users\/[^/]+$/.exec(path)) {
        const id = path.slice('/users/'.length)
        users.delete(id)
        send(204)
        return
      }
      if (method === 'DELETE' && /^\/groups\/[^/]+$/.exec(path)) {
        const id = path.slice('/groups/'.length)
        groups.delete(id)
        send(204)
        return
      }

      send(404, googleError(404, `no route for ${method} ${url.pathname}`, 'notFound'))
    })().catch((error: unknown) => {
      // A bug in this fake itself, not a scenario under test — fail loudly
      // rather than hanging the request.
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 500, message: error instanceof Error ? error.message : String(error) } }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('google admin fake failed to bind to a port')
  }
  const origin = `http://127.0.0.1:${address.port}`
  tokenAudience = `${origin}/token`

  return {
    serviceAccountEmail,
    serviceAccountKeyJson,
    get impersonatedAdminEmail() {
      return impersonatedAdminEmail
    },
    set impersonatedAdminEmail(value: string) {
      impersonatedAdminEmail = value
    },
    get domain() {
      return domain
    },
    set domain(value: string) {
      domain = value
    },
    tokenUrl: `${origin}/token`,
    adminBaseUrl: `${origin}${ADMIN_PATH_PREFIX}`,
    requests,
    get tokenRequestCount() {
      return tokenRequestCount
    },
    set tokenRequestCount(value: number) {
      tokenRequestCount = value
    },
    users,
    groups,
    throttleNextAdminRequests(count, options = {}) {
      const status = options.status ?? 429
      const retryAfterSeconds = options.retryAfterSeconds === null ? null : (options.retryAfterSeconds ?? 1)
      pendingThrottle = [
        ...pendingThrottle,
        ...Array.from({ length: count }, () => ({ status, reason: options.reason, retryAfterSeconds })),
      ]
    },
    rejectNextAdminRequestsWithUnauthorized(count) {
      pendingUnauthorized += count
    },
    failNextAdminRequestsWith(count, status, body) {
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
