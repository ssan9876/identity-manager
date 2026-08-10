import { describe, expect, it } from 'vitest'
import { ValidationError } from '../src/common/errors'
import { mapJsonFeed, parseJsonFeedConfig } from '../src/hr/hr-feed'
import { fetchFeedJson, readPath, type HrJsonPagination } from '../src/hr/hr-fetch'
import { parseCsv } from '../src/imports/csv'

/**
 * The `rest_json` inbound source kind — the JSON half of hr/hr-feed.ts and
 * hr/hr-fetch.ts. `mapJsonFeed`, `parseJsonFeedConfig` and `readPath` are
 * pure and tested directly; `fetchFeedJson`'s pagination is driven through
 * the same `fetchImpl` seam `HrSyncService` uses in production, so no socket
 * and no container is involved.
 *
 * The load-bearing property throughout: a `rest_json` source rejoins the
 * import pipeline as the SAME mapped CSV a `csv_url` source produces, so
 * nothing downstream can tell the two kinds apart.
 */

describe('readPath', () => {
  it('reads nested own properties and array indices', () => {
    const record = { name: { first: 'Ada' }, emails: [{ value: 'ada@example.com' }] }
    expect(readPath(record, 'name.first')).toBe('Ada')
    expect(readPath(record, 'emails.0.value')).toBe('ada@example.com')
  })

  it('returns the whole value for the empty path', () => {
    const record = { a: 1 }
    expect(readPath(record, '')).toBe(record)
  })

  it('returns undefined for absent segments rather than throwing', () => {
    expect(readPath({ a: { b: 1 } }, 'a.c')).toBeUndefined()
    expect(readPath({ a: 1 }, 'a.b')).toBeUndefined()
    expect(readPath(null, 'a')).toBeUndefined()
  })

  /**
   * The prototype-chain-bypass defence. `'constructor' in obj` is true and
   * yields a real, truthy inherited function — the exact hazard
   * ConnectorRegistry.factories and jml/rule-engine.ts document. A feed
   * field named after an Object.prototype member must read as ABSENT.
   */
  it('never resolves an inherited member', () => {
    expect(readPath({}, 'constructor')).toBeUndefined()
    expect(readPath({}, 'toString')).toBeUndefined()
    expect(readPath({}, '__proto__')).toBeUndefined()
    expect(readPath({ a: {} }, 'a.hasOwnProperty')).toBeUndefined()
  })

  it('reads a genuine own property named __proto__', () => {
    const record = JSON.parse('{"__proto__": "literal"}') as unknown
    expect(readPath(record, '__proto__')).toBe('literal')
  })

  it('refuses a named property on an array', () => {
    expect(readPath({ xs: [1, 2] }, 'xs.length')).toBeUndefined()
  })
})

describe('mapJsonFeed', () => {
  const mapping = { employeeId: 'employeeId', 'name.first': 'firstName', 'work.email': 'primaryEmail' }

  it('maps dot-paths onto import columns and produces parseable CSV', () => {
    const csv = mapJsonFeed(
      [
        { employeeId: 'E1', name: { first: 'Ada' }, work: { email: 'ada@example.com' }, salary: 999 },
        { employeeId: 'E2', name: { first: 'Grace' }, work: { email: 'grace@example.com' } },
      ],
      mapping,
    )

    const parsed = parseCsv(csv)
    expect(parsed.headers).toEqual(['employeeId', 'firstName', 'primaryEmail'])
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.rows[0].firstName).toBe('Ada')
    expect(parsed.rows[1].primaryEmail).toBe('grace@example.com')
  })

  /** The same drop-the-unmapped rule applyColumnMapping enforces for CSV — an HR payload's payroll fields must not reach the pipeline as unknown custom attributes. */
  it('drops unmapped fields entirely', () => {
    const csv = mapJsonFeed([{ employeeId: 'E1', name: { first: 'Ada' }, work: { email: 'a@b.co' }, ssn: '123' }], mapping)
    expect(csv).not.toContain('ssn')
    expect(csv).not.toContain('123')
  })

  it('stringifies numbers and booleans as a CSV cell would have carried them', () => {
    const csv = mapJsonFeed([{ id: 42, active: true }], { id: 'employeeId', active: 'enabled' })
    const parsed = parseCsv(csv)
    expect(parsed.rows[0].employeeId).toBe('42')
    expect(parsed.rows[0].enabled).toBe('true')
  })

  it('treats null and absent as empty, not as an error', () => {
    const csv = mapJsonFeed(
      [
        { employeeId: 'E1', name: { first: 'Ada' }, work: { email: null } },
        { employeeId: 'E2', name: { first: 'Grace' }, work: { email: 'g@example.com' } },
      ],
      mapping,
    )
    const parsed = parseCsv(csv)
    expect(parsed.rows[0].primaryEmail).toBe('')
    expect(parsed.rows[1].primaryEmail).toBe('g@example.com')
  })

  it('quotes values containing commas, quotes and newlines', () => {
    const csv = mapJsonFeed([{ note: 'a,b "c"\nd' }], { note: 'displayName' })
    expect(parseCsv(csv).rows[0].displayName).toBe('a,b "c"\nd')
  })

  /** The JSON analogue of applyColumnMapping's missing-header error: the mapping does not describe this feed at all. */
  it('rejects a mapped path absent from every record', () => {
    expect(() => mapJsonFeed([{ employeeId: 'E1' }, { employeeId: 'E2' }], { 'name.first': 'firstName' })).toThrow(
      /absent from every record/,
    )
  })

  it('accepts a path present in only some records', () => {
    expect(() =>
      mapJsonFeed([{ a: 'x' }, {}], { a: 'employeeId' }),
    ).not.toThrow()
  })

  /** A subtree at a mapped path means the PATH is wrong. Coercing would write `[object Object]` into a person's record; blanking would be quiet data loss. */
  it('rejects a mapped path resolving to an object or array', () => {
    expect(() => mapJsonFeed([{ name: { first: 'Ada' } }], { name: 'firstName' })).toThrow(/not a subtree/)
    expect(() => mapJsonFeed([{ tags: ['a'] }], { tags: 'firstName' })).toThrow(/an array/)
  })

  it('reports at most five issues however large the feed', () => {
    const records = Array.from({ length: 500 }, () => ({ name: { first: 'x' } }))
    try {
      mapJsonFeed(records, { name: 'firstName' })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError)
      expect((error as ValidationError).issues.length).toBeLessThanOrEqual(5)
    }
  })

  it('produces a header-only file for an empty feed without claiming the mapping is wrong', () => {
    const csv = mapJsonFeed([], mapping)
    expect(parseCsv(csv).rows).toHaveLength(0)
  })

  it('makes a target column named __proto__ a genuine own key', () => {
    const csv = mapJsonFeed([{ a: 'v' }], { a: '__proto__' })
    expect(parseCsv(csv).headers).toContain('__proto__')
  })
})

describe('parseJsonFeedConfig', () => {
  it('defaults to the whole body and no pagination', () => {
    const config = parseJsonFeedConfig(undefined)
    expect(config.recordsPath).toBe('')
    expect(config.pagination).toEqual({ mode: 'none' })
  })

  it('accepts a page-number pagination block and fills its defaults', () => {
    const config = parseJsonFeedConfig({ recordsPath: 'data.items', pagination: { mode: 'page', pageParam: 'page' } })
    expect(config.recordsPath).toBe('data.items')
    expect(config.pagination).toMatchObject({ mode: 'page', pageParam: 'page', startPage: 1, maxPages: 100 })
  })

  it('accepts a cursor pagination block', () => {
    const config = parseJsonFeedConfig({ pagination: { mode: 'cursor', nextPath: 'meta.next' } })
    expect(config.pagination).toMatchObject({ mode: 'cursor', nextPath: 'meta.next', cursorParam: null })
  })

  it('rejects an unknown pagination mode', () => {
    expect(() => parseJsonFeedConfig({ pagination: { mode: 'infinite' } })).toThrow(ValidationError)
  })

  it('rejects unknown top-level keys rather than ignoring them', () => {
    expect(() => parseJsonFeedConfig({ nope: 1 })).toThrow(ValidationError)
  })

  it('rejects a maxPages above the hard ceiling', () => {
    expect(() => parseJsonFeedConfig({ pagination: { mode: 'page', pageParam: 'p', maxPages: 100_000 } })).toThrow(
      ValidationError,
    )
  })
})

/** Builds a `fetchImpl` seam that answers a fixed script of JSON bodies and records the URLs it was asked for. */
function scriptedFetch(bodies: readonly unknown[]) {
  const urls: string[] = []
  let call = 0
  const impl = (async (url: string) => {
    urls.push(String(url))
    const body = JSON.stringify(bodies[Math.min(call, bodies.length - 1)])
    call += 1
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, urls }
}

describe('fetchFeedJson', () => {
  const base = 'https://hr.example.com/employees'
  const noPaging: HrJsonPagination = { mode: 'none' }

  it('reads records from the body itself', async () => {
    const { impl } = scriptedFetch([[{ id: 1 }, { id: 2 }]])
    const records = await fetchFeedJson(base, { auth: null, fetchImpl: impl, recordsPath: '', pagination: noPaging })
    expect(records).toHaveLength(2)
  })

  it('reads records from a nested path', async () => {
    const { impl } = scriptedFetch([{ data: { items: [{ id: 1 }] } }])
    const records = await fetchFeedJson(base, {
      auth: null,
      fetchImpl: impl,
      recordsPath: 'data.items',
      pagination: noPaging,
    })
    expect(records).toHaveLength(1)
  })

  /**
   * A mistyped recordsPath must NOT read as "the HR system has no people" —
   * downstream that is indistinguishable from a real, catastrophic emptying.
   */
  it('fails loudly when the records path is not an array', async () => {
    const { impl } = scriptedFetch([{ data: { items: 'nope' } }])
    await expect(
      fetchFeedJson(base, { auth: null, fetchImpl: impl, recordsPath: 'data.items', pagination: noPaging }),
    ).rejects.toThrow(/expected an array of records/)
  })

  it('rejects a non-https feed URL', async () => {
    const { impl } = scriptedFetch([[]])
    await expect(
      fetchFeedJson('http://hr.example.com/x', { auth: null, fetchImpl: impl, recordsPath: '', pagination: noPaging }),
    ).rejects.toThrow(/must use https/)
  })

  it('reports malformed JSON as a feed error rather than crashing', async () => {
    const impl = (async () => new Response('{not json', { status: 200 })) as unknown as typeof fetch
    await expect(
      fetchFeedJson(base, { auth: null, fetchImpl: impl, recordsPath: '', pagination: noPaging }),
    ).rejects.toThrow(/not valid JSON/)
  })

  it('walks numbered pages and stops on the first empty one', async () => {
    const { impl, urls } = scriptedFetch([[{ id: 1 }], [{ id: 2 }], []])
    const records = await fetchFeedJson(base, {
      auth: null,
      fetchImpl: impl,
      recordsPath: '',
      pagination: { mode: 'page', pageParam: 'page', startPage: 1, sizeParam: 'size', pageSize: 50, maxPages: 100 },
    })
    expect(records).toHaveLength(2)
    expect(urls).toHaveLength(3)
    expect(urls[0]).toContain('page=1')
    expect(urls[0]).toContain('size=50')
    expect(urls[2]).toContain('page=3')
  })

  it('honours maxPages on a feed that never returns an empty page', async () => {
    const { impl, urls } = scriptedFetch([[{ id: 1 }]])
    const records = await fetchFeedJson(base, {
      auth: null,
      fetchImpl: impl,
      recordsPath: '',
      pagination: { mode: 'page', pageParam: 'page', startPage: 1, sizeParam: null, pageSize: null, maxPages: 3 },
    })
    expect(urls).toHaveLength(3)
    expect(records).toHaveLength(3)
  })

  it('follows a cursor until the next-link is absent', async () => {
    const { impl, urls } = scriptedFetch([
      { items: [{ id: 1 }], meta: { next: 'https://hr.example.com/employees?after=abc' } },
      { items: [{ id: 2 }], meta: {} },
    ])
    const records = await fetchFeedJson(base, {
      auth: null,
      fetchImpl: impl,
      recordsPath: 'items',
      pagination: { mode: 'cursor', nextPath: 'meta.next', cursorParam: null, maxPages: 100 },
    })
    expect(records).toHaveLength(2)
    expect(urls[1]).toBe('https://hr.example.com/employees?after=abc')
  })

  it('appends an opaque cursor token as a query parameter when configured', async () => {
    const { impl, urls } = scriptedFetch([{ items: [{ id: 1 }], next: 'tok' }, { items: [{ id: 2 }] }])
    await fetchFeedJson(base, {
      auth: null,
      fetchImpl: impl,
      recordsPath: 'items',
      pagination: { mode: 'cursor', nextPath: 'next', cursorParam: 'cursor', maxPages: 100 },
    })
    expect(urls[1]).toContain('cursor=tok')
  })

  /** An upstream must not be able to downgrade the scheme, or bounce the credential to another host, through the next-link. */
  it('re-validates https on a cursor-supplied URL', async () => {
    const { impl } = scriptedFetch([{ items: [], next: 'http://evil.example.com/steal' }])
    await expect(
      fetchFeedJson(base, {
        auth: null,
        fetchImpl: impl,
        recordsPath: 'items',
        pagination: { mode: 'cursor', nextPath: 'next', cursorParam: null, maxPages: 100 },
      }),
    ).rejects.toThrow(/must use https/)
  })

  it('rejects a non-string cursor', async () => {
    const { impl } = scriptedFetch([{ items: [], next: { nested: true } }])
    await expect(
      fetchFeedJson(base, {
        auth: null,
        fetchImpl: impl,
        recordsPath: 'items',
        pagination: { mode: 'cursor', nextPath: 'next', cursorParam: null, maxPages: 100 },
      }),
    ).rejects.toThrow(/must be a string/)
  })

  /**
   * The byte budget spans the WHOLE run. A per-page cap that reset each page
   * would let an N-page feed allocate N times the ceiling — the exact
   * unbounded allocation the ceiling exists to refuse.
   */
  it('applies the byte ceiling across all pages, not per page', async () => {
    const page = { items: [{ id: 'x'.repeat(200) }], next: 'https://hr.example.com/employees?p=2' }
    const { impl } = scriptedFetch([page])
    await expect(
      fetchFeedJson(base, {
        auth: null,
        fetchImpl: impl,
        maxBytes: 500,
        recordsPath: 'items',
        pagination: { mode: 'cursor', nextPath: 'next', cursorParam: null, maxPages: 100 },
      }),
    ).rejects.toThrow(/too large/)
  })
})
