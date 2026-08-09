import { Controller, Get, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DomainExceptionFilter } from '../src/common/domain-exception.filter'
import {
  ConflictError,
  CycleError,
  DataIntegrityError,
  ForbiddenError,
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
  @Get('forbidden')
  forbidden(): never {
    throw new ForbiddenError('not permitted')
  }
  @Get('data-integrity')
  dataIntegrity(): never {
    throw new DataIntegrityError('role_assignments references an unknown role_key: "ghost"')
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

  it('maps ForbiddenError to 403', async () => {
    const res = await request(app.getHttpServer()).get('/boom/forbidden').expect(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  /**
   * Finding AUTHZ-L-4. The point of the class is NOT the status — a plain
   * Error was already a 500 and already failed closed — it is that the
   * response now carries a `code` and a message an operator can act on,
   * instead of being indistinguishable from a crash. So this asserts the
   * BODY, not just the 500. It is also the one DomainError mapped to 5xx:
   * if a future edit gives it a 4xx mapping, this fails.
   */
  it('maps DataIntegrityError to a 500 that still names itself', async () => {
    const res = await request(app.getHttpServer()).get('/boom/data-integrity').expect(500)
    expect(res.body.code).toBe('DATA_INTEGRITY_FAULT')
    expect(res.body.statusCode).toBe(500)
    expect(res.body.message).toContain('ghost')
  })

  it('does not catch non-domain errors, and never leaks their message', async () => {
    const res = await request(app.getHttpServer()).get('/boom/unmapped').expect(500)
    expect(JSON.stringify(res.body)).not.toContain('some internal detail')
  })
})
