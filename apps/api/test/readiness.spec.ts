import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DB_CLIENT } from '../src/common/db.token'
import * as schema from '../src/db/schema/index'
import { HealthController } from '../src/health/health.controller'
import { ReadinessController } from '../src/health/readiness.controller'
import { swallowShutdownErrors, withTestDatabase } from './support/pg'
import { assertNoLeak } from './support/secret-leak'

/**
 * Readiness (`GET /health/ready`) against a REAL Postgres, connected as the
 * REAL runtime role — not the owner. That distinction is the whole point of
 * running this file against a container rather than a mocked handle: the
 * runtime role (db/roles.ts, finding H1) is deliberately granted almost
 * nothing, so a readiness probe that reads the migration ledger only works
 * if that read was explicitly granted. A mock would have proved the
 * controller's branching and nothing about whether the endpoint can actually
 * answer in production.
 */
describe('GET /health/ready', () => {
  const ctx = withTestDatabase()
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController, ReadinessController],
      providers: [{ provide: DB_CLIENT, useFactory: () => drizzle(ctx.pool, { schema }) }],
    }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
  })

  it('reports ready against a fully migrated database', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready').expect(200)
    expect(res.body).toEqual({
      status: 'ready',
      checks: { database: 'ok', migrations: 'ok' },
    })
  })

  /**
   * The check that makes this endpoint worth having: an instance whose
   * process is up, whose database answers, and whose schema is BEHIND the
   * code it is running. `systemctl is-active` calls that healthy and so does
   * `GET /health`; it must not receive traffic.
   *
   * Reproduced the way drizzle itself decides what is outstanding — it
   * applies every journal entry whose `when` exceeds MAX(created_at) in
   * `drizzle.__drizzle_migrations` (see migrate.spec.ts's 0027 rewind, which
   * relies on the same rule). Deleting the newest ledger row therefore puts
   * the database in exactly the state it would be in mid-deploy, between the
   * new code starting and `db:migrate` finishing.
   *
   * The rows are captured and re-inserted rather than recovered by re-running
   * migrations: re-running would re-execute that migration's SQL, which is a
   * property of the migration, not of this test, and a failure there would
   * be reported as a readiness failure.
   */
  it('reports not ready, with 503, when the ledger is behind the journal', async () => {
    const removed = await ctx.ownerPool.query<{ id: number; hash: string; created_at: string }>(
      `DELETE FROM drizzle.__drizzle_migrations
       WHERE created_at = (SELECT max(created_at) FROM drizzle.__drizzle_migrations)
       RETURNING id, hash, created_at`,
    )
    expect(removed.rows.length).toBeGreaterThan(0)

    try {
      const res = await request(app.getHttpServer()).get('/health/ready').expect(503)
      expect(res.body).toEqual({
        status: 'not_ready',
        checks: { database: 'ok', migrations: 'pending' },
      })
    } finally {
      for (const row of removed.rows) {
        await ctx.ownerPool.query(
          `INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES ($1, $2, $3)`,
          [row.id, row.hash, row.created_at],
        )
      }
    }

    // The restore is asserted, not assumed: a silently unrestored ledger
    // would make every later assertion in this file meaningless.
    await request(app.getHttpServer()).get('/health/ready').expect(200)
  })

  /**
   * Liveness and readiness must answer DIFFERENT questions. Asserted on one
   * app instance whose database is unreachable: the process is alive and
   * `/health` says so, while `/health/ready` refuses traffic. If a future
   * change made readiness a second liveness probe (or vice versa) exactly
   * one of these two expectations would break.
   */
  describe('with an unreachable database', () => {
    let brokenApp: INestApplication
    let deadPool: Pool

    beforeAll(async () => {
      // Port 1 refuses immediately (ECONNREFUSED) rather than hanging, so
      // this asserts the failure path without leaning on a timeout.
      deadPool = new Pool({
        connectionString: 'postgres://idm_app_test:idm_app_test_password@127.0.0.1:1/idm',
        connectionTimeoutMillis: 2_000,
      })
      swallowShutdownErrors(deadPool)
      deadPool.on('error', () => {})

      const moduleRef = await Test.createTestingModule({
        controllers: [HealthController, ReadinessController],
        providers: [{ provide: DB_CLIENT, useFactory: () => drizzle(deadPool, { schema }) }],
      }).compile()
      brokenApp = moduleRef.createNestApplication()
      await brokenApp.init()
    })

    afterAll(async () => {
      await brokenApp?.close()
      await deadPool?.end().catch(() => undefined)
    })

    it('still reports the process alive on /health', async () => {
      const res = await request(brokenApp.getHttpServer()).get('/health').expect(200)
      expect(res.body).toEqual({ status: 'ok' })
    })

    it('reports not ready, with 503, on /health/ready', async () => {
      const res = await request(brokenApp.getHttpServer()).get('/health/ready').expect(503)
      expect(res.body).toEqual({
        status: 'not_ready',
        checks: { database: 'unreachable', migrations: 'unknown' },
      })
    })

    /**
     * The endpoint is unauthenticated by design (guard-coverage.spec.ts
     * exempts it alongside the liveness probe), so its failure body is read
     * by anyone who can reach the port. It must therefore carry a fixed,
     * closed vocabulary and nothing else — no driver message, no host, no
     * connection string, no credentials. pg's own error for this case
     * ("connect ECONNREFUSED 127.0.0.1:1") is exactly the kind of text that
     * ends up in a probe body when a handler stringifies the caught error.
     */
    it('leaks nothing about the failure into the unauthenticated body', async () => {
      const res = await request(brokenApp.getHttpServer()).get('/health/ready').expect(503)
      const body = JSON.stringify(res.body)

      expect(Object.keys(res.body).sort()).toEqual(['checks', 'status'])
      expect(Object.keys(res.body.checks).sort()).toEqual(['database', 'migrations'])
      assertNoLeak(body, 'idm_app_test_password', 'readiness failure body')
      assertNoLeak(body, 'ECONNREFUSED', 'readiness failure body')
      assertNoLeak(body, '127.0.0.1', 'readiness failure body')
      assertNoLeak(body, 'postgres://', 'readiness failure body')
      // Nest's default exception handler adds `message`/`statusCode` to a
      // string-bodied HttpException; an object body is passed through
      // verbatim. Asserting the absence of those keys pins that choice.
      expect(res.body.message).toBeUndefined()
    })
  })
})
