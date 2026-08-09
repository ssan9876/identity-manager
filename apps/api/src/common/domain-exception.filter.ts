import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
} from '@nestjs/common'
import type { Response } from 'express'
import { DomainError, ValidationError } from './errors'

const STATUS_BY_CODE: Record<string, HttpStatus> = {
  NOT_FOUND: HttpStatus.NOT_FOUND,
  CONFLICT: HttpStatus.CONFLICT,
  INVALID_TRANSITION: HttpStatus.CONFLICT,
  CYCLE_DETECTED: HttpStatus.CONFLICT,
  VALIDATION_FAILED: HttpStatus.BAD_REQUEST,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  // Deliberately 500, and deliberately EXPLICIT rather than left to the
  // `??` fallback below: a data-integrity fault is not the caller's fault
  // and must never become a 4xx, but it is also not an anonymous crash —
  // mapping it here is what gives the response a `code` and a message an
  // operator can act on. See DataIntegrityError's doc comment (AUTHZ-L-4).
  DATA_INTEGRITY_FAULT: HttpStatus.INTERNAL_SERVER_ERROR,
  // Organizations, Task 12. 503, not 500 and not a 4xx — see
  // NotConfiguredError's own doc comment: the request is well-formed and the
  // actor entitled, but the deployment is not equipped to serve it yet, and
  // only an operator can change that.
  NOT_CONFIGURED: HttpStatus.SERVICE_UNAVAILABLE,
}

/**
 * Catches DomainError ONLY. Unmapped throwables fall through to Nest's default
 * handler and become a 500 with no body detail — a bug must look like a bug.
 */
@Catch(DomainError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(error: DomainError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>()
    const statusCode =
      STATUS_BY_CODE[error.code] ?? HttpStatus.INTERNAL_SERVER_ERROR

    const body: Record<string, unknown> = {
      statusCode,
      code: error.code,
      message: error.message,
    }

    if (error instanceof ValidationError) {
      body.issues = error.issues
    }

    response.status(statusCode).json(body)
  }
}
