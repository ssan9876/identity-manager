import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../src/app.module'

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
  KEYCLOAK_ISSUER: 'http://keycloak.invalid/realms/identity-manager',
  KEYCLOAK_AUDIENCE: 'idm-api',
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
})
