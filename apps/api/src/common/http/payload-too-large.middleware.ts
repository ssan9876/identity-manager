import type { NextFunction, Request, Response } from 'express'

/**
 * A body over the configured limit throws from INSIDE express's
 * `body-parser` middleware, before the request ever reaches Nest's
 * routing/controller layer — `DomainExceptionFilter` (`@Catch(DomainError)`,
 * common/domain-exception.filter.ts) never sees it, because it is not a
 * `DomainError`; it falls through to Nest's own default exception handling
 * instead. Finding M6 (docs/archive/audits/audit-integrity.md) names the
 * observable effect: the response status is already the correct 413, but it
 * is logged as an "unhandled ExceptionsHandler ERROR" — noisy, and shaped
 * differently from every other rejected request this API returns.
 *
 * Registered in `main.ts`, immediately after the explicit `useBodyParser`
 * calls it exists to complement (see that file's own doc comment for why
 * `BODY_LIMIT_BYTES` needs `bodyParser: false` to actually take effect).
 * Recognizes ONLY the shape express's `body-parser` gives a too-large
 * payload — `type: 'entity.too.large'`, `status`/`statusCode: 413` (from
 * the `http-errors` package it is built on) — and answers with the same
 * quiet, structured JSON shape `DomainExceptionFilter` gives every OTHER
 * rejected request. Anything else is passed through via `next(err)`
 * completely unchanged: a genuine bug must still look like a bug (unmapped,
 * loud, a 500) — this function is deliberately narrow, not a second
 * catch-all sitting beside `DomainExceptionFilter`.
 *
 * A plain function returning Express 4-arg error-handling middleware
 * (recognized by its arity, not a type), rather than inline in `main.ts` —
 * `main.ts` is never imported by `vitest run` (no spec file references it;
 * see SyncWorker's own file-level doc comment on why bootstrap() must stay
 * unreachable from tests), so anything declared only there is untestable in
 * isolation. This file has no such side effect and is safe to unit test
 * directly.
 */
export function payloadTooLargeMiddleware(bodyLimitBytes: number) {
  return (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    const candidate = err as { type?: string; status?: number; statusCode?: number } | null
    const isPayloadTooLarge =
      candidate?.type === 'entity.too.large' || candidate?.status === 413 || candidate?.statusCode === 413
    if (!isPayloadTooLarge) {
      next(err)
      return
    }
    res.status(413).json({
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: `request body exceeds the configured limit of ${bodyLimitBytes} bytes`,
    })
  }
}
