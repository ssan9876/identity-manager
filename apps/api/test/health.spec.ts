import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HealthController } from '../src/health/health.controller'

describe('GET /health', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('returns ok', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200)
    expect(res.body).toEqual({ status: 'ok' })
  })
})
