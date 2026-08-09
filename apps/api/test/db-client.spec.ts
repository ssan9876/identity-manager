import { afterEach, describe, expect, it } from 'vitest'
import { createDbClient } from '../src/db/client'

// A syntactically valid connection string that is never actually dialled:
// `pg.Pool`'s constructor does no I/O — see the installed pg-pool's
// constructor (just option bookkeeping) — so these tests exercise only
// `createDbClient`'s own option wiring, no real/throwaway Postgres needed.
const FAKE_DATABASE_URL = 'postgres://user:pw@127.0.0.1:1/db'

/**
 * Pins Part 2 of finding C1's fix (docs/archive/audits/audit-integrity.md):
 * `createDbClient` used to be `new Pool({ connectionString })` — pg's own
 * defaults, `connectionTimeoutMillis` unset, meaning a caller queued behind
 * an exhausted pool waited FOREVER with no error, ever (see the installed
 * pg-pool's `connect()`: the pending-queue push only gets a `setTimeout`
 * guard `if (this.options.connectionTimeoutMillis)`). These tests inspect
 * the constructed `pool.options` directly rather than re-proving pool
 * behaviour end to end — test/pool-exhaustion.spec.ts already does that,
 * against a real Postgres — this file just pins that the VALUES reaching
 * `pg.Pool` are the ones this fix intends, including the untouched-call-site
 * default every existing `createDbClient(url)` caller (app.module.ts, the
 * three CLI scripts) now gets for free.
 */
describe('createDbClient', () => {
  const pools: Array<{ end: () => Promise<void> }> = []
  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()))
  })

  it('defaults connectionTimeoutMillis to a finite value (a few seconds), not pg\'s unset-forever default', () => {
    const { pool } = createDbClient(FAKE_DATABASE_URL)
    pools.push(pool)

    expect(pool.options.connectionTimeoutMillis).toBeTypeOf('number')
    expect(pool.options.connectionTimeoutMillis).toBeGreaterThan(0)
    // "a few seconds" per the fix's own brief — not milliseconds, not minutes.
    expect(pool.options.connectionTimeoutMillis).toBeGreaterThanOrEqual(1_000)
    expect(pool.options.connectionTimeoutMillis).toBeLessThanOrEqual(10_000)
  })

  it('honors an explicit connectionTimeoutMillis override', () => {
    const { pool } = createDbClient(FAKE_DATABASE_URL, { connectionTimeoutMillis: 1_234 })
    pools.push(pool)

    expect(pool.options.connectionTimeoutMillis).toBe(1_234)
  })

  it('leaves max unset by default, so pg-pool applies its own default (10)', () => {
    const { pool } = createDbClient(FAKE_DATABASE_URL)
    pools.push(pool)

    // pg-pool's constructor resolves an unset `max` to 10 immediately (see
    // `this.options.max = this.options.max || this.options.poolSize || 10`
    // in the installed pg-pool) — asserted here as the concrete behaviour
    // this fix relies on: DB_POOL_MAX defaulting to 10 (config/env.ts) is a
    // no-op against an unconfigured deployment precisely because this is
    // already what happens with no `max` supplied at all.
    expect(pool.options.max).toBe(10)
  })

  it('honors an explicit max override (config/env.ts DB_POOL_MAX)', () => {
    const { pool } = createDbClient(FAKE_DATABASE_URL, { max: 25 })
    pools.push(pool)

    expect(pool.options.max).toBe(25)
  })
})
