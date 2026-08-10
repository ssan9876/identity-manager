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
 */
export const DEFAULT_HR_FETCH_MAX_BYTES = 10 * 1024 * 1024

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
 * Fetches a CSV feed over HTTPS with a hard byte ceiling. This is the ONE
 * place HR sync performs network I/O, and the one place a feed credential
 * exists in memory — resolved via `resolveSecret` (CONNECTOR_* namespace
 * guard included, so a source row can never name `DATABASE_URL`), attached
 * to the request, and NEVER logged, thrown, or returned: every error below
 * names the URL or a status code, never a header value.
 *
 * `redirect: 'error'` — a feed URL is admin-configured and stable; following
 * a redirect would let a compromised or misconfigured upstream bounce the
 * credential to a different host (or downgrade https to http) silently.
 *
 * The body is STREAMED and aborted the moment it exceeds `maxBytes` —
 * checking Content-Length alone is not enough (it is optional and
 * unauthenticated upstream), and buffering-then-checking would allocate the
 * exact unbounded body the cap exists to refuse. A Content-Length that
 * already exceeds the cap short-circuits before any body bytes are read.
 */
export async function fetchFeedCsv(url: string, options: HrFetchOptions): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_HR_FETCH_MAX_BYTES

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ValidationError([`url: not a valid URL`])
  }
  if (parsed.protocol !== 'https:') {
    throw new ValidationError(['url: feed URLs must use https'])
  }

  const headers: Record<string, string> = { accept: 'text/csv, text/plain' }
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
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new ValidationError([
      `feed: response body too large (${declaredLength} bytes; the maximum is ${maxBytes})`,
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
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new ValidationError([
        `feed: response body too large (exceeded ${maxBytes} bytes mid-stream)`,
      ])
    }
    chunks.push(value)
  }

  return Buffer.concat(chunks).toString('utf8')
}
