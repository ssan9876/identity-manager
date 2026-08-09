import { describe, expect, it, vi } from 'vitest'
import { payloadTooLargeMiddleware } from '../src/common/http/payload-too-large.middleware'

/** A minimal fake Express Response — just enough for this middleware's own two calls. */
function fakeResponse() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(body: unknown) {
      res.body = body
      return res
    },
  }
  return res
}

/**
 * Finding M6 (docs/archive/audits/audit-integrity.md): "the 413 is also logged
 * as an unhandled ExceptionsHandler ERROR rather than a clean domain error."
 * Unit-tested in isolation (not through a booted app) — see this
 * middleware's own file-level doc comment for why `main.ts` itself cannot
 * be imported by a test.
 */
describe('payloadTooLargeMiddleware', () => {
  it('answers a body-parser "entity.too.large" error with a clean, quiet 413', () => {
    const middleware = payloadTooLargeMiddleware(2048)
    const res = fakeResponse()
    const next = vi.fn()

    const bodyParserError = { type: 'entity.too.large', status: 413, message: 'request entity too large' }
    middleware(bodyParserError, {} as never, res as never, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(413)
    expect(res.body).toEqual({
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'request body exceeds the configured limit of 2048 bytes',
    })
  })

  it('also recognizes a bare statusCode: 413 shape, not only "type"', () => {
    const middleware = payloadTooLargeMiddleware(2048)
    const res = fakeResponse()
    const next = vi.fn()

    middleware({ statusCode: 413 }, {} as never, res as never, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(413)
  })

  it('passes ANY other error straight through to next(), untouched — never becomes a silent catch-all', () => {
    const middleware = payloadTooLargeMiddleware(2048)
    const res = fakeResponse()
    const next = vi.fn()

    const genuineBug = new Error('something else broke')
    middleware(genuineBug, {} as never, res as never, next)

    expect(next).toHaveBeenCalledWith(genuineBug)
    expect(res.statusCode).toBe(0)
    expect(res.body).toBeUndefined()
  })

  it('passes a null/undefined error through to next() rather than throwing', () => {
    const middleware = payloadTooLargeMiddleware(2048)
    const res = fakeResponse()
    const next = vi.fn()

    middleware(null, {} as never, res as never, next)

    expect(next).toHaveBeenCalledWith(null)
  })
})
