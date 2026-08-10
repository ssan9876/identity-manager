import { ValidationError } from '../common/errors'
import { resolveSecret } from '../connectors/secrets'

/**
 * Byte ceiling on a fetched feed body. Mirrors env.ts's BODY_LIMIT_BYTES
 * default (10 MiB) — the deliberate half of the import size cap: a PUSHED
 * import is bounded by the HTTP body limit `main.ts` configures, but a
 * PULLED feed never passes through our own body parser, so this module must
 * self-bound or an upstream (or a typo'd URL pointing at a huge file) makes
 * this process allocate without limit. The ROW cap (IMPORT_MAX_ROWS,
 * finding M6) is then enforced by the import pipeline itself, unchanged —
 * `ImportsController.parseAndPrepare` sees the mapped CSV exactly as it
 * sees a pushed one.
 *
 * For a PAGINATED source (`fetchFeedJson`) this is the budget for the WHOLE
 * RUN, not per page — see `ByteBudget`.
 */
export const DEFAULT_HR_FETCH_MAX_BYTES = 10 * 1024 * 1024

/**
 * Hard ceiling on how many pages one paginated run will request, regardless
 * of what a source's own `maxPages` says. The byte budget alone is not a
 * sufficient bound: an upstream that returns an empty page with a
 * self-referential next-link costs almost no bytes and would otherwise spin
 * forever. Pagination stops at whichever limit is reached first.
 */
export const HR_MAX_PAGES_CEILING = 1000

/** Default page cap when a source names none — generous enough for a real HR directory at typical page sizes, low enough that a misconfigured feed fails fast. */
export const DEFAULT_HR_MAX_PAGES = 100

export interface HrFetchAuth {
  /** Header NAME to send the credential in (e.g. `Authorization`). */
  headerName: string
  /** NAME of the CONNECTOR_* environment variable holding the value — resolved through `resolveSecret`, the codebase's single audited secret-resolution site. */
  secretName: string
}

export interface HrFetchOptions {
  auth: HrFetchAuth | null
  maxBytes?: number
  /** Test seam, same shape as `resolveSecret`'s own `env` parameter. */
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
}

/**
 * The remaining byte allowance for a run, decremented in place as each page
 * is read. A mutable object rather than a returned count because
 * `fetchFeedBody` must abort MID-STREAM the moment the budget is exceeded —
 * a per-page cap that reset each page would let an N-page feed allocate N
 * times the ceiling, which is exactly the unbounded allocation the ceiling
 * exists to refuse.
 */
interface ByteBudget {
  remaining: number
}

/**
 * The shared transport core: one HTTPS request, credential attached, body
 * streamed under a hard ceiling. Both `fetchFeedCsv` and `fetchFeedJson` go
 * through this and nothing else performs network I/O for HR sync — the
 * https-only check, `redirect: 'error'`, the streaming abort and the
 * never-log-the-credential discipline are written ONCE so a second feed kind
 * cannot quietly ship without them.
 *
 * `redirect: 'error'` — a feed URL is admin-configured and stable; following
 * a redirect would let a compromised or misconfigured upstream bounce the
 * credential to a different host (or downgrade https to http) silently.
 *
 * The body is STREAMED and aborted the moment it exceeds the budget —
 * checking Content-Length alone is not enough (it is optional and
 * unauthenticated upstream), and buffering-then-checking would allocate the
 * exact unbounded body the cap exists to refuse. A Content-Length that
 * already exceeds the budget short-circuits before any body bytes are read.
 */
async function fetchFeedBody(
  url: string,
  options: HrFetchOptions,
  accept: string,
  budget: ByteBudget,
): Promise<string> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ValidationError([`url: not a valid URL`])
  }
  if (parsed.protocol !== 'https:') {
    throw new ValidationError(['url: feed URLs must use https'])
  }

  const headers: Record<string, string> = { accept }
  if (options.auth !== null) {
    headers[options.auth.headerName] = resolveSecret(options.auth.secretName, options.env)
  }

  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(parsed.toString(), { headers, redirect: 'error' })
  } catch (error) {
    // fetch failures wrap the cause; never rethrow the raw error object —
    // it can carry the request (and therefore the credential header).
    const message = error instanceof Error ? error.message : String(error)
    throw new ValidationError([`feed: fetch failed — ${message}`])
  }

  if (!response.ok) {
    // Drain/cancel so the socket is released; the body of an error response
    // is upstream-controlled and is deliberately not echoed anywhere.
    await response.body?.cancel().catch(() => undefined)
    throw new ValidationError([`feed: upstream responded ${response.status}`])
  }

  const declaredLength = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declaredLength) && declaredLength > budget.remaining) {
    await response.body?.cancel().catch(() => undefined)
    throw new ValidationError([
      `feed: response body too large (${declaredLength} bytes; the maximum is ${budget.remaining})`,
    ])
  }

  if (response.body === null) {
    return ''
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > budget.remaining) {
      await reader.cancel().catch(() => undefined)
      throw new ValidationError([
        `feed: response body too large (exceeded ${budget.remaining} bytes mid-stream)`,
      ])
    }
    chunks.push(value)
  }

  budget.remaining -= received
  return Buffer.concat(chunks).toString('utf8')
}

/** Fetches a CSV feed over HTTPS with a hard byte ceiling — the `csv_url` source kind. See `fetchFeedBody` for the transport discipline this inherits. */
export async function fetchFeedCsv(url: string, options: HrFetchOptions): Promise<string> {
  const budget: ByteBudget = { remaining: options.maxBytes ?? DEFAULT_HR_FETCH_MAX_BYTES }
  return fetchFeedBody(url, options, 'text/csv, text/plain', budget)
}

/**
 * How a `rest_json` source walks a multi-page result. A CLOSED set —
 * `parseJsonFeedConfig` (hr-feed.ts) rejects anything else, so a value read
 * back out of `hr_sources.config` is never dispatched on blindly.
 *
 * - `none`: one request; whatever it returns is the whole feed.
 * - `page`: a monotonically increasing page NUMBER in a query parameter.
 *   Stops on the first page that yields zero records.
 * - `cursor`: the response itself names the next request. Stops when that
 *   field is absent, null or empty.
 */
export type HrJsonPagination =
  | { mode: 'none' }
  | {
      mode: 'page'
      pageParam: string
      startPage: number
      sizeParam: string | null
      pageSize: number | null
      maxPages: number
    }
  | { mode: 'cursor'; nextPath: string; cursorParam: string | null; maxPages: number }

export interface HrJsonFetchOptions extends HrFetchOptions {
  /** Dot-path to the record ARRAY inside each response body; the empty string means the body IS the array. */
  recordsPath: string
  pagination: HrJsonPagination
}

/**
 * Reads a value at a dot-path, refusing to traverse anything but a plain
 * object's OWN properties (and array indices). `Object.hasOwn`, never `in`
 * and never a bare index: a path segment named `__proto__`, `constructor` or
 * `toString` must resolve to "absent", not to an inherited member — the same
 * prototype-chain-bypass defence this codebase applies in
 * connector-registry.ts and jml/rule-engine.ts. Returns `undefined` for any
 * segment that is absent or not traversable.
 */
export function readPath(source: unknown, path: string): unknown {
  if (path === '') return source
  let current: unknown = source
  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      // Array indices only — a named property on an array (`length`, or
      // anything inherited) is never a feed field.
      if (!/^\d+$/.test(segment)) return undefined
      current = current[Number(segment)]
      continue
    }
    if (typeof current !== 'object' || current === null) return undefined
    if (!Object.hasOwn(current, segment)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/**
 * Extracts the record array at `recordsPath`, failing loudly rather than
 * treating a non-array as an empty feed — a mistyped path must not read as
 * "the HR system has no people", which downstream is indistinguishable from
 * a real, catastrophic emptying.
 */
function extractRecords(body: unknown, recordsPath: string, page: number): unknown[] {
  const found = readPath(body, recordsPath)
  if (Array.isArray(found)) return found
  const where = recordsPath === '' ? 'the response body' : `"${recordsPath}"`
  const got = found === null ? 'null' : found === undefined ? 'nothing' : typeof found
  throw new ValidationError([
    `feed: expected an array of records at ${where}${page > 1 ? ` on page ${page}` : ''}, got ${got}`,
  ])
}

/**
 * Fetches a JSON feed over HTTPS, following pagination, and returns the
 * concatenated records — the `rest_json` source kind. This is what makes
 * Workday RaaS, BambooHR, HiBob, SuccessFactors and Personio reachable
 * through CONFIGURATION rather than a connector each.
 *
 * Every page goes through `fetchFeedBody`, so the https-only rule, the
 * no-redirect rule and the credential discipline are identical to the CSV
 * path by construction. The byte budget spans the WHOLE run (see
 * `ByteBudget`), and `HR_MAX_PAGES_CEILING` bounds the page count
 * independently — an upstream returning a cheap self-referential next-link
 * cannot spin forever.
 */
export async function fetchFeedJson(url: string, options: HrJsonFetchOptions): Promise<unknown[]> {
  const budget: ByteBudget = { remaining: options.maxBytes ?? DEFAULT_HR_FETCH_MAX_BYTES }
  const accept = 'application/json'
  const records: unknown[] = []

  const parseBody = (text: string, page: number): unknown => {
    try {
      return JSON.parse(text) as unknown
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new ValidationError([
        `feed: response was not valid JSON${page > 1 ? ` on page ${page}` : ''} — ${message}`,
      ])
    }
  }

  if (options.pagination.mode === 'none') {
    const body = parseBody(await fetchFeedBody(url, options, accept, budget), 1)
    records.push(...extractRecords(body, options.recordsPath, 1))
    return records
  }

  const maxPages = Math.min(options.pagination.maxPages, HR_MAX_PAGES_CEILING)

  if (options.pagination.mode === 'page') {
    const { pageParam, startPage, sizeParam, pageSize } = options.pagination
    for (let page = 0; page < maxPages; page += 1) {
      const target = new URL(url)
      target.searchParams.set(pageParam, String(startPage + page))
      if (sizeParam !== null && pageSize !== null) {
        target.searchParams.set(sizeParam, String(pageSize))
      }
      const body = parseBody(await fetchFeedBody(target.toString(), options, accept, budget), page + 1)
      const batch = extractRecords(body, options.recordsPath, page + 1)
      // An empty page is the end of the feed. Checked BEFORE appending so a
      // trailing empty page costs one request and nothing else.
      if (batch.length === 0) return records
      records.push(...batch)
    }
    return records
  }

  const { nextPath, cursorParam } = options.pagination
  let nextUrl: string = url
  for (let page = 0; page < maxPages; page += 1) {
    const body = parseBody(await fetchFeedBody(nextUrl, options, accept, budget), page + 1)
    records.push(...extractRecords(body, options.recordsPath, page + 1))

    const next = readPath(body, nextPath)
    if (next === undefined || next === null || next === '') return records
    if (typeof next !== 'string') {
      throw new ValidationError([
        `feed: pagination cursor at "${nextPath}" must be a string, got ${typeof next}`,
      ])
    }
    if (cursorParam === null) {
      // The upstream hands back a whole URL. `fetchFeedBody` re-validates
      // https-ness, so an upstream cannot downgrade the scheme or bounce the
      // credential to another host by way of this field.
      nextUrl = next
    } else {
      const target = new URL(url)
      target.searchParams.set(cursorParam, next)
      nextUrl = target.toString()
    }
  }
  return records
}
