import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JwtGuard } from '../src/auth/jwt.guard'
import { MeController } from '../src/auth/me.controller'
import { startKeycloak, type TestKeycloak } from './support/keycloak'
import { startLocalJwks, type LocalJwks } from './support/local-jwks'

describe('JwtGuard on GET /me', () => {
  let app: INestApplication
  let keycloak: TestKeycloak
  let token: string

  beforeAll(async () => {
    keycloak = await startKeycloak()
    token = await keycloak.tokenFor('admin@example.com', 'dev_password_change_me')

    const moduleRef = await Test.createTestingModule({
      controllers: [MeController],
    })
      .overrideGuard(JwtGuard)
      .useValue(
        new JwtGuard({
          issuer: keycloak.issuer,
          audience: 'idm-api',
        }),
      )
      .compile()

    app = moduleRef.createNestApplication()
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
    await keycloak?.stop()
  })

  it('returns the principal for a valid token', async () => {
    const res = await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    expect(res.body.username).toBe('admin@example.com')
    expect(res.body.email).toBe('admin@example.com')
    expect(typeof res.body.subject).toBe('string')
  })

  it('rejects a request with no Authorization header', async () => {
    await request(app.getHttpServer()).get('/me').expect(401)
  })

  it('rejects a malformed Authorization header', async () => {
    await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', 'Basic abc123')
      .expect(401)
  })

  it('rejects a structurally valid but unsigned token', async () => {
    const forged = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'attacker' })).toString('base64url'),
      '',
    ].join('.')

    await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${forged}`)
      .expect(401)
  })

  it('rejects a token whose audience is wrong', async () => {
    const wrongAudience = new JwtGuard({
      issuer: keycloak.issuer,
      audience: 'some-other-api',
    })

    const moduleRef = await Test.createTestingModule({
      controllers: [MeController],
    })
      .overrideGuard(JwtGuard)
      .useValue(wrongAudience)
      .compile()

    const strictApp = moduleRef.createNestApplication()
    await strictApp.init()

    await request(strictApp.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401)

    await strictApp.close()
  })
})

describe('JwtGuard rejects validly-signed tokens missing required identity claims', () => {
  let app: INestApplication
  let localJwks: LocalJwks

  beforeAll(async () => {
    localJwks = await startLocalJwks()

    const moduleRef = await Test.createTestingModule({
      controllers: [MeController],
    })
      .overrideGuard(JwtGuard)
      .useValue(
        new JwtGuard({
          issuer: localJwks.issuer,
          audience: 'idm-api',
        }),
      )
      .compile()

    app = moduleRef.createNestApplication()
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
    await localJwks?.stop()
  })

  /**
   * Finding SEC-L4 (docs/archive/audits/carried-findings-verification.md).
   * jose enforces `exp` only when the claim is present, so before
   * `requiredClaims: ['exp']` a validly signed token that simply omitted it
   * was accepted and never expired. Keycloak always sets `exp`; this proves
   * the guard no longer depends on that being true.
   */
  it('rejects a validly signed token that carries no "exp" claim', async () => {
    const token = await localJwks.signToken(
      {
        aud: 'idm-api',
        sub: 'a-real-subject-id',
        preferred_username: 'someone@example.com',
      },
      { omitExpiry: true },
    )

    await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401)
  })

  it('rejects a token with no "sub" claim', async () => {
    const token = await localJwks.signToken({
      aud: 'idm-api',
      preferred_username: 'someone@example.com',
    })

    await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401)
  })

  it('rejects a token with no "preferred_username" claim', async () => {
    const token = await localJwks.signToken({
      aud: 'idm-api',
      sub: 'a-real-subject-id',
    })

    await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401)
  })

  // Finding M-3 (docs/archive/audits/audit-authz.md): `preferred_username` was
  // cast (`as string | undefined`) rather than validated, and `!username`
  // only rejects FALSY values — a non-string, truthy claim sailed straight
  // through into PermissionEngine.resolveActor's query, where Drizzle's
  // `sql` template splices a bare JS array specially. Reproduced live,
  // pre-fix, against GET /users with a real Keycloak-signed token:
  //   preferred_username = ["god"]         -> 200, authenticated AS "god"
  //   preferred_username = ["nope","god"]  -> 500 (2-element array becomes
  //                                            a SQL row constructor)
  //   preferred_username = []              -> 500 (empty array becomes
  //                                            `lower()` with no argument)
  // Every case below must now be a clean, generic 401 — the exact shape
  // every other invalid token already gets, with no new information
  // disclosure and no unhandled 500 anywhere in the codebase.
  describe('finding M-3: preferred_username is validated as a string', () => {
    it('rejects a single-element array preferred_username (pre-fix: authenticated as that value)', async () => {
      const token = await localJwks.signToken({
        aud: 'idm-api',
        sub: 'a-real-subject-id',
        preferred_username: ['god'],
      })

      await request(app.getHttpServer())
        .get('/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401)
    })

    it('rejects a nested array preferred_username', async () => {
      const token = await localJwks.signToken({
        aud: 'idm-api',
        sub: 'a-real-subject-id',
        preferred_username: [['god']],
      })

      await request(app.getHttpServer())
        .get('/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401)
    })

    it('rejects a two-element array preferred_username (pre-fix: unhandled 500)', async () => {
      const token = await localJwks.signToken({
        aud: 'idm-api',
        sub: 'a-real-subject-id',
        preferred_username: ['nope', 'god'],
      })

      await request(app.getHttpServer())
        .get('/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401)
    })

    it('rejects an empty-array preferred_username (pre-fix: unhandled 500)', async () => {
      const token = await localJwks.signToken({
        aud: 'idm-api',
        sub: 'a-real-subject-id',
        preferred_username: [],
      })

      await request(app.getHttpServer())
        .get('/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401)
    })

    it('rejects a numeric preferred_username', async () => {
      const token = await localJwks.signToken({
        aud: 'idm-api',
        sub: 'a-real-subject-id',
        preferred_username: 42,
      })

      await request(app.getHttpServer())
        .get('/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401)
    })

    it('rejects a boolean preferred_username', async () => {
      const token = await localJwks.signToken({
        aud: 'idm-api',
        sub: 'a-real-subject-id',
        preferred_username: true,
      })

      await request(app.getHttpServer())
        .get('/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401)
    })

    it('rejects an object preferred_username', async () => {
      const token = await localJwks.signToken({
        aud: 'idm-api',
        sub: 'a-real-subject-id',
        preferred_username: { nested: 'object' },
      })

      await request(app.getHttpServer())
        .get('/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401)
    })

    it('rejects an empty-string preferred_username', async () => {
      const token = await localJwks.signToken({
        aud: 'idm-api',
        sub: 'a-real-subject-id',
        preferred_username: '',
      })

      await request(app.getHttpServer())
        .get('/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401)
    })

    // Defence in depth, applied to `sub` too (see JwtGuard's own doc
    // comment): the original `!subject` caught an empty string; a bare
    // `typeof` check alone would not have, so this is checked directly.
    it('rejects an array "sub" claim', async () => {
      const token = await localJwks.signToken({
        aud: 'idm-api',
        sub: ['attacker'] as unknown as string,
        preferred_username: 'someone@example.com',
      })

      await request(app.getHttpServer())
        .get('/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401)
    })

    it('rejects an empty-string "sub" claim', async () => {
      const token = await localJwks.signToken({
        aud: 'idm-api',
        sub: '',
        preferred_username: 'someone@example.com',
      })

      await request(app.getHttpServer())
        .get('/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401)
    })

    // Positive control: a well-formed, ordinary string claim is unaffected
    // by the stricter validation.
    it('accepts an ordinary string preferred_username, unaffected by the stricter validation', async () => {
      const token = await localJwks.signToken({
        aud: 'idm-api',
        sub: 'a-real-subject-id',
        preferred_username: 'someone@example.com',
      })

      const res = await request(app.getHttpServer())
        .get('/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
      expect(res.body.username).toBe('someone@example.com')
    })
  })
})
