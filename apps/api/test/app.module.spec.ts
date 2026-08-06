import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'
import { SyncWorker } from '../src/outbox/sync.worker'

/**
 * Smoke test for AppModule's real DI provider graph.
 *
 * jwt.guard.spec.ts never exercises this: it bypasses Nest DI entirely via
 * `overrideGuard().useValue(new JwtGuard(...))`, so a regression that breaks
 * JwtGuard's *construction* through the container (e.g. reverting its
 * constructor to a bare interface parameter, or losing the JWT_GUARD_OPTIONS
 * registration) would pass all other tests and only surface as a crash on
 * real boot — exactly the bug this test caught during review.
 *
 * Requires no container and no network: `createRemoteJWKSet` (used inside
 * JwtGuard's constructor) only does synchronous setup — the only network
 * fetch it ever performs is inside a `reload()` reached from `getKey()`,
 * which is invoked only when the returned resolver function is actually
 * called during a real `jwtVerify` — i.e. only when a request reaches the
 * guard. `app.init()` never issues a request, so nothing here ever needs to
 * resolve `KEYCLOAK_ISSUER`. The issuer stub below deliberately points at
 * the reserved, non-resolvable `.invalid` TLD (RFC 2606) so that if a future
 * change ever made construction eager, this test would fail fast and loudly
 * instead of silently passing by accident against a real, reachable host.
 */
const REQUIRED_ENV = {
  DATABASE_URL: 'postgres://idm:pw@localhost:5432/identity_manager',
  // Finding H1 (docs/superpowers/audit-integrity.md): AppModule's DB_CLIENT
  // now reads RUNTIME_DATABASE_URL, not DATABASE_URL (app.module.ts) — like
  // DATABASE_URL, this is never actually dialled here (`pg.Pool`'s
  // constructor does no I/O — see db-client.spec.ts's doc comment), so a
  // fake, never-reachable value is fine.
  RUNTIME_DATABASE_URL: 'postgres://idm_app:pw@localhost:5432/identity_manager',
  KEYCLOAK_ISSUER: 'http://keycloak.invalid/realms/identity-manager',
  KEYCLOAK_AUDIENCE: 'idm-api',
  // Milestone 4, Task 2: loadEnv now requires these unconditionally (see
  // config/env.ts), even though AppModule itself does not yet wire up
  // KeycloakAdminClient (Task 3 does) — both AppModule factories below call
  // the SAME loadEnv(process.env), which validates the whole Env shape
  // regardless of which fields a given provider actually reads.
  KEYCLOAK_ADMIN_CLIENT_ID: 'idm-sync-service',
  KEYCLOAK_ADMIN_CLIENT_SECRET: 'idm_sync_dev_secret_change_me',
  PORT: '3000',
} as const

type RequiredEnvKey = keyof typeof REQUIRED_ENV

describe('AppModule', () => {
  const original: Partial<Record<RequiredEnvKey, string | undefined>> = {}

  beforeAll(() => {
    for (const key of Object.keys(REQUIRED_ENV) as RequiredEnvKey[]) {
      original[key] = process.env[key]
      process.env[key] = REQUIRED_ENV[key]
    }
  })

  afterAll(() => {
    for (const key of Object.keys(REQUIRED_ENV) as RequiredEnvKey[]) {
      if (original[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = original[key]
      }
    }
  })

  it(
    'compiles and initialises the real DI provider graph with no container and no network',
    async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile()

      const app: INestApplication = moduleRef.createNestApplication()
      await app.init()

      expect(app.getHttpServer()).toBeDefined()

      await app.close()
    },
    15_000,
  )

  // Milestone 4, Task 4: SyncWorker is a registered AppModule provider (so
  // `main.ts` can resolve and start a real one), but only `main.ts`'s own
  // bootstrap() ever calls `.start()` — never a DI/Nest lifecycle hook. This
  // is the regression pin for that: constructing AND initialising the whole
  // real app graph — exactly what every other test in this file already
  // does — must never leave the worker polling.
  it('constructs SyncWorker through the real DI graph without ever starting it', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()

    const app: INestApplication = moduleRef.createNestApplication()
    await app.init()

    const worker = app.get(SyncWorker)
    expect(worker.isRunning).toBe(false)

    // onApplicationShutdown must also be a harmless no-op here, since the
    // worker was never started — proves app.close() (which every test in
    // this suite calls) never throws or hangs because of it.
    await app.close()
    expect(worker.isRunning).toBe(false)
  })
})
