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
