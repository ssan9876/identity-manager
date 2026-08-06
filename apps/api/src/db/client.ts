import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema/index'

export interface DbClient {
  db: NodePgDatabase<typeof schema>
  pool: Pool
}

export interface DbClientOptions {
  /**
   * Ceiling on physical connections `pool` will ever open. Omitted ->
   * pg's own default (10; see the installed `pg-pool`'s constructor:
   * `this.options.max = this.options.max || this.options.poolSize || 10`).
   * Exposed so a deployment can tune it via `loadEnv`'s `DB_POOL_MAX`
   * (app.module.ts's `DB_CLIENT` factory) rather than a code change.
   */
  max?: number
  /**
   * Milliseconds a caller may wait — queued for a free pool slot, or for the
   * initial TCP/startup handshake on a brand-new one — before pg rejects the
   * attempt with "timeout exceeded when trying to connect" instead of
   * queuing forever.
   *
   * THIS IS THE FIX for docs/superpowers/audit-integrity.md finding C1's
   * second half. pg's own default is `undefined`, and the installed
   * `pg-pool` treats that as "wait forever, no error, ever" (see its
   * `connect()`: the pending-queue push only gets a `setTimeout` guard
   * `if (this.options.connectionTimeoutMillis)`). Combined with a pool that
   * is genuinely exhausted, that is not a slow response — it is a permanent
   * hang, and enough exhausted requests wedge the whole process (every
   * connection sits `idle in transaction`, forever, and nothing ever frees
   * one). A finite value here turns that failure mode into a bounded-time
   * error that surfaces as a 500 (uncaught -> Nest's default handler; see
   * common/domain-exception.filter.ts's doc comment: "a bug must look like a
   * bug") instead of an outage with no error at all. Defaulted, not
   * required, so every existing single-argument `createDbClient(url)` call
   * site (app.module.ts, the three CLI scripts) gets this for free.
   */
  connectionTimeoutMillis?: number
}

/**
 * A few seconds: long enough that a briefly busy pool (a legitimate burst)
 * is not penalized, short enough that a genuinely exhausted one fails fast
 * rather than tying up an HTTP request (and its caller) indefinitely.
 */
const DEFAULT_CONNECTION_TIMEOUT_MILLIS = 5_000

export function createDbClient(databaseUrl: string, options: DbClientOptions = {}): DbClient {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: options.max,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MILLIS,
  })
  return { db: drizzle(pool, { schema }), pool }
}
