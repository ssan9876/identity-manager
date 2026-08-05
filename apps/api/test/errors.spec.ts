import { describe, expect, it } from 'vitest'
import {
  ConflictError,
  CycleError,
  DomainError,
  InvalidTransitionError,
  NotFoundError,
  ValidationError,
} from '../src/common/errors'
import { AttributeValidationError } from '../src/attributes/attribute-validator'

describe('domain error taxonomy', () => {
  it('gives every error a stable machine-readable code', () => {
    expect(new NotFoundError('user', 'abc').code).toBe('NOT_FOUND')
    expect(new ConflictError('duplicate').code).toBe('CONFLICT')
    expect(new InvalidTransitionError('bad').code).toBe('INVALID_TRANSITION')
    expect(new CycleError('loop').code).toBe('CYCLE_DETECTED')
    expect(new ValidationError(['a']).code).toBe('VALIDATION_FAILED')
  })

  it('makes every domain error an instanceof DomainError and Error', () => {
    for (const error of [
      new NotFoundError('user', 'abc'),
      new ConflictError('duplicate'),
      new InvalidTransitionError('bad'),
      new CycleError('loop'),
      new ValidationError(['a']),
    ]) {
      expect(error).toBeInstanceOf(DomainError)
      expect(error).toBeInstanceOf(Error)
    }
  })

  it('sets name to the concrete subclass, not "Error"', () => {
    expect(new NotFoundError('user', 'abc').name).toBe('NotFoundError')
    expect(new CycleError('loop').name).toBe('CycleError')
  })

  it('formats NotFoundError with resource and id', () => {
    expect(new NotFoundError('org unit', 'xyz').message).toBe('org unit not found: xyz')
  })

  it('carries issues on ValidationError', () => {
    expect(new ValidationError(['a: bad', 'b: worse']).issues).toEqual([
      'a: bad',
      'b: worse',
    ])
  })

  it('keeps AttributeValidationError in the taxonomy without changing its shape', () => {
    const error = new AttributeValidationError(['cost_center: Required'])
    expect(error).toBeInstanceOf(ValidationError)
    expect(error).toBeInstanceOf(DomainError)
    expect(error.issues).toEqual(['cost_center: Required'])
    expect(error.message).toBe('attribute validation failed: cost_center: Required')
    expect(error.name).toBe('AttributeValidationError')
  })
})
