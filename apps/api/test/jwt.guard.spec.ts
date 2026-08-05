import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JwtGuard } from '../src/auth/jwt.guard'
import { MeController } from '../src/auth/me.controller'
import { startKeycloak, type TestKeycloak } from './support/keycloak'

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
