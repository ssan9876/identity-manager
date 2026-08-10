import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'

/**
 * A CONTRACT FAKE for the subset of SCIM 2.0 that `ScimConnector` calls,
 * following the same pattern and the same honesty as
 * `test/support/entra-graph-fake.ts`.
 *
 * READ THIS PLAINLY. This is a REAL `node:http` server: the connector makes
 * REAL HTTP requests to REAL TCP sockets on `127.0.0.1`, gets REAL responses,
 * and waits REAL milliseconds for a REAL `Retry-After`. That proves the
 * connector's OWN request shapes, its OWN filter/PATCH/PUT construction, its
 * OWN throttle and token state machine, and its OWN error handling —
 * genuinely, not vacuously.
 *
 * It does NOT and CANNOT prove that Slack, Zoom, Atlassian, Box or Snowflake
 * behave this way. Response shapes here are pinned to the RFCs directly —
 * RFC 7643 (schema: `id` is immutable and service-assigned §3.1; `password`
 * is an ordinary optional attribute §4.1.1; Group §4.2) and RFC 7644
 * (protocol: filter §3.4.2.2, PATCH `Operations` §3.5.2, PUT §3.5.1, DELETE
 * §3.6, ListResponse §3.4.2, error response §3.12) — not to any one vendor's
 * deviations from them, of which real services have many.
 */

export interface ScimFakeRequest {
  method: string
  /** pathname + search, e.g. `/Users?filter=userName%20eq%20%22ada%22`. */
  path: string
  hasAuthorization: boolean
  authorization: string | null
  bodyText: string
  at: Date
}

interface ThrottleInstruction {
  status: 429 | 503
  retryAfterSeconds: number | null
}

interface StoredUser {
  id: string
  userName: string
  active: boolean
  [key: string]: unknown
}

interface StoredGroup {
  id: string
  displayName: string
  members: Array<{ value: string }>
}

export interface ScimFake {
  baseUrl: string
  /** Mutable so a test can prove a secret-leak sentinel with a value IT controls. */
  bearerToken: string
  users: Map<string, StoredUser>
  groups: Map<string, StoredGroup>
  requests: ScimFakeRequest[]
  /** Queued throttle responses, consumed one per matching request. */
  throttleQueue: ThrottleInstruction[]
  /** When set, every request gets this status until cleared. */
  forceStatus: number | null
  seedUser(user: Partial<StoredUser> & { userName: string }): StoredUser
  seedGroup(displayName: string, memberIds?: string[]): StoredGroup
  stop(): Promise<void>
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/** RFC 7644 §3.4.2.2 — this fake understands exactly the three filters the connector emits. */
function matchFilter(filter: string, users: Map<string, StoredUser>, groups: Map<string, StoredGroup>): unknown[] {
  const userName = /^userName eq "(.*)"$/.exec(filter)
  if (userName !== null) {
    const wanted = unescapeFilterValue(userName[1]!)
    return [...users.values()].filter((user) => user.userName === wanted)
  }
  const displayName = /^displayName eq "(.*)"$/.exec(filter)
  if (displayName !== null) {
    const wanted = unescapeFilterValue(displayName[1]!)
    return [...groups.values()].filter((group) => group.displayName === wanted)
  }
  const member = /^members\.value eq "(.*)"$/.exec(filter)
  if (member !== null) {
    const wanted = unescapeFilterValue(member[1]!)
    return [...groups.values()].filter((group) => group.members.some((entry) => entry.value === wanted))
  }
  return []
}

function unescapeFilterValue(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

function listResponse(resources: unknown[]): string {
  return JSON.stringify({
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults: resources.length,
    itemsPerPage: resources.length,
    startIndex: 1,
    Resources: resources,
  })
}

/** RFC 7644 §3.12. */
function errorResponse(status: number, detail: string, scimType?: string): string {
  return JSON.stringify({
    schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
    status: String(status),
    ...(scimType !== undefined ? { scimType } : {}),
    detail,
  })
}

/** Mirrors the connector's own `splitScimPath`: an extension URN is one key, and only the attribute after its last colon is dot-split. */
function splitPath(path: string): string[] {
  const extension = /^(urn:.+):([^:]+)$/.exec(path)
  if (extension !== null) return [extension[1]!, ...extension[2]!.split('.')]
  return path.split('.')
}

/** Applies one PATCH operation's path onto a stored resource — enough to prove what the connector actually sent. */
function applyPatchPath(target: Record<string, unknown>, path: string, value: unknown): void {
  // `emails[type eq "work"].value` — the one valued-filter path the connector emits.
  if (path === 'emails[type eq "work"].value') {
    target.emails = [{ value, type: 'work', primary: true }]
    return
  }
  const segments = splitPath(path)
  let current = target
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!
    const next = current[segment]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      const created: Record<string, unknown> = {}
      current[segment] = created
      current = created
    } else {
      current = next as Record<string, unknown>
    }
  }
  current[segments[segments.length - 1]!] = value
}

function removePatchPath(target: Record<string, unknown>, path: string): void {
  const segments = splitPath(path)
  let current: Record<string, unknown> = target
  for (let index = 0; index < segments.length - 1; index += 1) {
    const next = current[segments[index]!]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return
    current = next as Record<string, unknown>
  }
  delete current[segments[segments.length - 1]!]
}

export async function startScimFake(): Promise<ScimFake> {
  const users = new Map<string, StoredUser>()
  const groups = new Map<string, StoredGroup>()
  const requests: ScimFakeRequest[] = []
  const throttleQueue: ThrottleInstruction[] = []

  const state = {
    bearerToken: 'scim-fake-token',
    forceStatus: null as number | null,
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      const path = request.url ?? '/'
      const bodyText = await readBody(request)
      const authorization = request.headers.authorization ?? null
      requests.push({
        method: request.method ?? 'GET',
        path,
        hasAuthorization: authorization !== null,
        authorization,
        bodyText,
        at: new Date(),
      })

      const send = (status: number, payload: string, headers: Record<string, string> = {}) => {
        response.writeHead(status, { 'content-type': 'application/scim+json', ...headers })
        response.end(payload)
      }

      const throttle = throttleQueue.shift()
      if (throttle !== undefined) {
        send(
          throttle.status,
          errorResponse(throttle.status, 'too many requests'),
          throttle.retryAfterSeconds === null ? {} : { 'retry-after': String(throttle.retryAfterSeconds) },
        )
        return
      }

      if (state.forceStatus !== null) {
        send(state.forceStatus, errorResponse(state.forceStatus, 'forced failure'))
        return
      }

      if (authorization !== `Bearer ${state.bearerToken}`) {
        send(401, errorResponse(401, 'invalid token'))
        return
      }

      const url = new URL(path, 'http://127.0.0.1')
      const segments = url.pathname.split('/').filter((segment) => segment !== '')
      const method = request.method ?? 'GET'

      // ---- /ServiceProviderConfig (RFC 7644 §4)
      if (segments[0] === 'ServiceProviderConfig') {
        send(
          200,
          JSON.stringify({
            schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
            patch: { supported: true },
            filter: { supported: true, maxResults: 200 },
          }),
        )
        return
      }

      // ---- /Users
      if (segments[0] === 'Users') {
        const id = segments[1]
        if (method === 'GET' && id === undefined) {
          const filter = url.searchParams.get('filter')
          send(200, listResponse(filter === null ? [...users.values()] : matchFilter(filter, users, groups)))
          return
        }
        if (method === 'GET' && id !== undefined) {
          const user = users.get(id)
          if (user === undefined) {
            send(404, errorResponse(404, `user ${id} not found`))
            return
          }
          send(200, JSON.stringify(user))
          return
        }
        if (method === 'POST') {
          const body = JSON.parse(bodyText) as Record<string, unknown>
          const created: StoredUser = {
            ...body,
            id: randomUUID(),
            userName: String(body.userName ?? ''),
            active: body.active !== false,
          }
          users.set(created.id, created)
          send(201, JSON.stringify(created))
          return
        }
        if (method === 'PATCH' && id !== undefined) {
          const user = users.get(id)
          if (user === undefined) {
            send(404, errorResponse(404, `user ${id} not found`))
            return
          }
          const body = JSON.parse(bodyText) as { Operations?: Array<{ op: string; path: string; value?: unknown }> }
          for (const operation of body.Operations ?? []) {
            if (operation.op === 'remove') removePatchPath(user, operation.path)
            else applyPatchPath(user, operation.path, operation.value)
          }
          user.active = user.active !== false
          send(200, JSON.stringify(user))
          return
        }
        if (method === 'PUT' && id !== undefined) {
          const user = users.get(id)
          if (user === undefined) {
            send(404, errorResponse(404, `user ${id} not found`))
            return
          }
          const body = JSON.parse(bodyText) as Record<string, unknown>
          const replaced: StoredUser = { ...body, id, userName: String(body.userName ?? ''), active: body.active !== false }
          users.set(id, replaced)
          send(200, JSON.stringify(replaced))
          return
        }
        // Notably including DELETE, which RFC 7644 §3.6 defines and this
        // connector must never emit — the fake answers it so a test can prove
        // the request was never made, rather than the route simply not
        // existing.
        send(405, errorResponse(405, `method ${method} not allowed on /Users`))
        return
      }

      // ---- /Groups
      if (segments[0] === 'Groups') {
        const id = segments[1]
        if (method === 'GET' && id === undefined) {
          const filter = url.searchParams.get('filter')
          send(200, listResponse(filter === null ? [...groups.values()] : matchFilter(filter, users, groups)))
          return
        }
        if (method === 'POST') {
          const body = JSON.parse(bodyText) as { displayName?: unknown }
          const created: StoredGroup = { id: randomUUID(), displayName: String(body.displayName ?? ''), members: [] }
          groups.set(created.id, created)
          send(201, JSON.stringify(created))
          return
        }
        if (method === 'PATCH' && id !== undefined) {
          const group = groups.get(id)
          if (group === undefined) {
            send(404, errorResponse(404, `group ${id} not found`))
            return
          }
          const body = JSON.parse(bodyText) as { Operations?: Array<{ op: string; path: string; value?: unknown }> }
          for (const operation of body.Operations ?? []) {
            if (operation.op === 'add' && operation.path === 'members') {
              for (const entry of (operation.value as Array<{ value: string }>) ?? []) {
                if (!group.members.some((member) => member.value === entry.value)) group.members.push(entry)
              }
            }
            const removal = /^members\[value eq "(.*)"\]$/.exec(operation.path)
            if (operation.op === 'remove' && removal !== null) {
              const wanted = unescapeFilterValue(removal[1]!)
              group.members = group.members.filter((member) => member.value !== wanted)
            }
          }
          send(200, JSON.stringify(group))
          return
        }
        send(405, errorResponse(405, `method ${method} not allowed on /Groups`))
        return
      }

      send(404, errorResponse(404, `no route for ${path}`))
    })().catch(() => {
      response.writeHead(500, { 'content-type': 'application/scim+json' })
      response.end(errorResponse(500, 'fake server error'))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('scim fake: no address')
  const baseUrl = `http://127.0.0.1:${address.port}`

  return {
    baseUrl,
    get bearerToken() {
      return state.bearerToken
    },
    set bearerToken(value: string) {
      state.bearerToken = value
    },
    users,
    groups,
    requests,
    throttleQueue,
    get forceStatus() {
      return state.forceStatus
    },
    set forceStatus(value: number | null) {
      state.forceStatus = value
    },
    seedUser(user) {
      const stored: StoredUser = { active: true, ...user, id: user.id ?? randomUUID() }
      users.set(stored.id, stored)
      return stored
    },
    seedGroup(displayName, memberIds = []) {
      const stored: StoredGroup = {
        id: randomUUID(),
        displayName,
        members: memberIds.map((value) => ({ value })),
      }
      groups.set(stored.id, stored)
      return stored
    },
    async stop() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}
