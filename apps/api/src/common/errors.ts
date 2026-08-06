/**
 * Every error the domain raises deliberately extends DomainError, so the HTTP
 * layer can map it to a status code. Anything that is NOT a DomainError is a
 * genuine bug and must surface as a 500 — never rewrite one into a 4xx.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string

  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND'

  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`)
  }
}

export class ConflictError extends DomainError {
  readonly code = 'CONFLICT'
}

export class InvalidTransitionError extends DomainError {
  readonly code = 'INVALID_TRANSITION'
}

export class CycleError extends DomainError {
  readonly code = 'CYCLE_DETECTED'
}

export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_FAILED'

  constructor(
    public readonly issues: string[],
    message = `validation failed: ${issues.join('; ')}`,
  ) {
    super(message)
  }
}

export class ForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN'
}
