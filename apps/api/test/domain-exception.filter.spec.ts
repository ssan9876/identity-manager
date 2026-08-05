import { Controller, Get, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import {
  ConflictError,
  CycleError,
  InvalidTransitionError,
  NotFoundError,
  ValidationError,
} from '../src/common/errors'

@Controller('boom')
class BoomController {
  @Get('not-found')
  notFound(): never {
    throw new NotFoundError('user', 'u-1')
  }
  @Get('conflict')
  conflict(): never {
    throw new ConflictError('username already taken')
  }
  @Get('transition')
  transition(): never {
    throw new InvalidTransitionError('cannot transition from pending to suspended')
  }
  @Get('cycle')
  cycle(): never {
    throw new CycleError('adding this edge would create a cycle')
  }
  @Get('validation')
  validation(): never {
    throw new ValidationError(['name: Required'])
  }
  @Get('unmapped')
  unmapped(): never {
    throw new Error('some internal detail that must not leak')
  }
}

describe('DomainExceptionFilter', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BoomController],
    }).compile()
    app = moduleRef.createNestApplication()
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('maps NotFoundError to 404', async () => {
    const res = await request(app.getHttpServer()).get('/boom/not-found').expect(404)
    expect(res.body).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'user not found: u-1',
    })
  })

  it('maps ConflictError to 409', async () => {
    const res = await request(app.getHttpServer()).get('/boom/conflict').expect(409)
    expect(res.body.code).toBe('CONFLICT')
  })

  it('maps InvalidTransitionError to 409', async () => {
    const res = await request(app.getHttpServer()).get('/boom/transition').expect(409)
    expect(res.body.code).toBe('INVALID_TRANSITION')
  })

  it('maps CycleError to 409', async () => {
    const res = await request(app.getHttpServer()).get('/boom/cycle').expect(409)
    expect(res.body.code).toBe('CYCLE_DETECTED')
  })

  it('maps ValidationError to 400 and includes its issues', async () => {
    const res = await request(app.getHttpServer()).get('/boom/validation').expect(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
    expect(res.body.issues).toEqual(['name: Required'])
  })

  it('does not catch non-domain errors, and never leaks their message', async () => {
    const res = await request(app.getHttpServer()).get('/boom/unmapped').expect(500)
    expect(JSON.stringify(res.body)).not.toContain('some internal detail')
  })
})
