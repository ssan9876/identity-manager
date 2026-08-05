import { describe, expect, it } from 'vitest'
import {
  AttributeValidationError,
  type AttributeDefinition,
  validateAttributes,
} from '../src/attributes/attribute-validator'

const def = (
  overrides: Partial<AttributeDefinition> & Pick<AttributeDefinition, 'key' | 'dataType'>,
): AttributeDefinition => ({
  label: overrides.key,
  required: false,
  validationRules: {},
  appliesTo: 'user',
  isActive: true,
  syncToKeycloak: false,
  selfEditable: false,
  ...overrides,
})

describe('validateAttributes', () => {
  it('accepts a valid payload and returns it', () => {
    const defs = [
      def({ key: 'cost_center', dataType: 'string' }),
      def({ key: 'headcount', dataType: 'number' }),
    ]
    expect(validateAttributes(defs, { cost_center: 'CC-1', headcount: 4 })).toEqual({
      cost_center: 'CC-1',
      headcount: 4,
    })
  })

  it('rejects a missing required attribute', () => {
    const defs = [def({ key: 'cost_center', dataType: 'string', required: true })]
    expect(() => validateAttributes(defs, {})).toThrow(AttributeValidationError)
  })

  it('rejects a wrong data type', () => {
    const defs = [def({ key: 'headcount', dataType: 'number' })]
    expect(() => validateAttributes(defs, { headcount: 'four' })).toThrow(
      /headcount/,
    )
  })

  it('rejects an unknown attribute key', () => {
    const defs = [def({ key: 'cost_center', dataType: 'string' })]
    expect(() => validateAttributes(defs, { salary: 100 })).toThrow(/salary/)
  })

  it('enforces string pattern and length rules', () => {
    const defs = [
      def({
        key: 'cost_center',
        dataType: 'string',
        validationRules: { pattern: '^CC-\\d{4}$', maxLength: 7 },
      }),
    ]
    expect(() => validateAttributes(defs, { cost_center: 'XX-1' })).toThrow(
      /cost_center/,
    )
    expect(validateAttributes(defs, { cost_center: 'CC-1024' })).toEqual({
      cost_center: 'CC-1024',
    })
  })

  it('enforces numeric bounds', () => {
    const defs = [
      def({ key: 'headcount', dataType: 'number', validationRules: { min: 1, max: 10 } }),
    ]
    expect(() => validateAttributes(defs, { headcount: 0 })).toThrow(/headcount/)
  })

  it('enforces enum options', () => {
    const defs = [
      def({
        key: 'contract',
        dataType: 'enum',
        validationRules: { options: ['permanent', 'contractor'] },
      }),
    ]
    expect(validateAttributes(defs, { contract: 'contractor' })).toEqual({
      contract: 'contractor',
    })
    expect(() => validateAttributes(defs, { contract: 'intern' })).toThrow(
      /contract/,
    )
  })

  it('validates dates as ISO calendar dates', () => {
    const defs = [def({ key: 'badge_issued', dataType: 'date' })]
    expect(validateAttributes(defs, { badge_issued: '2026-08-04' })).toEqual({
      badge_issued: '2026-08-04',
    })
    expect(() => validateAttributes(defs, { badge_issued: '04/08/2026' })).toThrow(
      /badge_issued/,
    )
  })

  it('ignores inactive definitions, treating their keys as unknown', () => {
    const defs = [def({ key: 'legacy_code', dataType: 'string', isActive: false })]
    expect(() => validateAttributes(defs, { legacy_code: 'x' })).toThrow(
      /legacy_code/,
    )
  })

  it('only applies definitions scoped to the matching entity', () => {
    const defs = [def({ key: 'group_owner', dataType: 'string', appliesTo: 'group' })]
    expect(() => validateAttributes(defs, { group_owner: 'x' })).toThrow(
      /group_owner/,
    )
  })

  it('collects every issue rather than stopping at the first', () => {
    const defs = [
      def({ key: 'a', dataType: 'string', required: true }),
      def({ key: 'b', dataType: 'number', required: true }),
    ]
    try {
      validateAttributes(defs, {})
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as AttributeValidationError).issues).toHaveLength(2)
    }
  })
})
