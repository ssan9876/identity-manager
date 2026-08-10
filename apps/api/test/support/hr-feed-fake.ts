import { createServer, type Server } from 'node:http'

export interface HrFeedFakeRequest {
  method: string
  path: string
  /** Every header exactly as received (node lowercases names) — what the auth-header assertions read. */
  headers: Record<string, string | string[] | undefined>
  at: Date
}

export interface HrFeedFake {
  /** `http://127.0.0.1:<port>` — NOTE: plain http. `fetchFeedCsv` refuses non-https URLs, so tests reaching THROUGH it pass a fetchImpl seam or exercise the refusal itself; tests of `HrSyncService` point the source's https URL here via the service's fetch seam... see hr-sync.spec.ts for how each test actually wires it. */
  baseUrl: string
  /** Every request received, in order — the `EchoConnector.calls` / `EntraGraphFake.requests` convention. */
  readonly requests: HrFeedFakeRequest[]
  /** The CSV body served on the next requests (until reassigned). */
  body: string
  /** Status served (default 200). */
  status: number
  /** When set, the response repeats `body` this many times — a cheap way to serve a multi-megabyte body without holding a giant string in the test file. */
  bodyRepeat: number
  /** When false, the Content-Length header is omitted (chunked transfer) — proving the mid-stream byte cap, not just the header short-circuit. */
  sendContentLength: boolean
  stop(): Promise<void>
}

/**
 * A minimal REAL `node:http` server standing in for an HR system's CSV
 * export endpoint — same honesty contract as test/support/entra-graph-fake.ts:
 * real TCP sockets, real responses, so `fetchFeedCsv`'s streaming byte cap,
 * header handling and error paths are proven genuinely, not vacuously. It
 * does not and cannot prove anything about any real HR vendor's API — the
 * `csv_url` source kind deliberately assumes nothing beyond "an HTTPS URL
 * that returns CSV".
 *
 * Serves whatever `body`/`status` are currently assigned, records every
 * request (method, path, headers) for assertions — in particular "the
 * configured auth header arrived with the resolved CONNECTOR_* value" and
 * its dual, "the secret VALUE appears nowhere except that header".
 */
export async function startHrFeedFake(): Promise<HrFeedFake> {
  const requests: HrFeedFakeRequest[] = []

  const fake: Omit<HrFeedFake, 'baseUrl' | 'stop'> & { baseUrl: string; stop(): Promise<void> } = {
    baseUrl: '',
    requests,
    body: '',
    status: 200,
    bodyRepeat: 1,
    sendContentLength: true,
    stop: async () => undefined,
  }

  const server: Server = createServer((req, res) => {
    requests.push({
      method: req.method ?? '',
      path: req.url ?? '',
      headers: { ...req.headers },
      at: new Date(),
    })

    const chunk = Buffer.from(fake.body, 'utf8')
    const total = chunk.byteLength * fake.bodyRepeat

    res.statusCode = fake.status
    res.setHeader('content-type', 'text/csv')
    if (fake.sendContentLength) {
      res.setHeader('content-length', String(total))
    }
    for (let i = 0; i < fake.bodyRepeat; i += 1) {
      res.write(chunk)
    }
    res.end()
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('hr-feed-fake: could not determine listen address')
  }
  fake.baseUrl = `http://127.0.0.1:${address.port}`

  fake.stop = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })

  return fake
}
