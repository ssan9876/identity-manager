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

  it('rejects a misconfigured enum (zero options) as AttributeValidationError, even when the payload never mentions that key', () => {
    const defs = [
      def({ key: 'broken_enum', dataType: 'enum', validationRules: { options: [] } }),
      def({ key: 'other_field', dataType: 'string' }),
    ]

    try {
      validateAttributes(defs, { other_field: 'valid value' })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(AttributeValidationError)
      expect((error as AttributeValidationError).issues.join('; ')).toMatch(/broken_enum/)
    }
  })

  it('validates calendar correctness, not just ISO shape, for dates', () => {
    const defs = [def({ key: 'badge_issued', dataType: 'date' })]

    // Shape-valid but nonexistent calendar dates must be rejected.
    expect(() => validateAttributes(defs, { badge_issued: '2026-02-30' })).toThrow(
      /badge_issued/,
    )
    expect(() => validateAttributes(defs, { badge_issued: '2026-13-40' })).toThrow(
      /badge_issued/,
    )

    // Leap-day handling: valid in a leap year, invalid otherwise.
    expect(validateAttributes(defs, { badge_issued: '2024-02-29' })).toEqual({
      badge_issued: '2024-02-29',
    })
    expect(() => validateAttributes(defs, { badge_issued: '2025-02-29' })).toThrow(
      /badge_issued/,
    )

    // Pre-existing behaviour must be unaffected.
    expect(validateAttributes(defs, { badge_issued: '2026-08-04' })).toEqual({
      badge_issued: '2026-08-04',
    })
    expect(() => validateAttributes(defs, { badge_issued: '04/08/2026' })).toThrow(
      /badge_issued/,
    )
  })

  it('genuinely enforces a definition keyed "__proto__", including its required flag', () => {
    const defs = [def({ key: '__proto__', dataType: 'string', required: true })]

    expect(() => validateAttributes(defs, {})).toThrow(AttributeValidationError)

    // Object.fromEntries creates a genuine *own* "__proto__" data property
    // on the payload. Writing the object literal `{ '__proto__': 'CC-1' }`
    // directly would instead hit the object-literal __proto__ special case
    // (attempting to set the new object's prototype, a no-op for a
    // non-object value) and silently produce a plain empty object — which
    // would not exercise this scenario at all.
    const payloadWithProtoKey = Object.fromEntries([['__proto__', 'CC-1']])
    expect(Object.prototype.hasOwnProperty.call(payloadWithProtoKey, '__proto__')).toBe(
      true,
    )
    expect(() => validateAttributes(defs, payloadWithProtoKey)).not.toThrow()
  })

  it('never pollutes the global Object prototype while validating a "__proto__"-keyed definition', () => {
    const defs = [def({ key: '__proto__', dataType: 'string', required: true })]
    const payloadWithProtoKey = Object.fromEntries([['__proto__', 'CC-1']])

    expect(() => validateAttributes(defs, payloadWithProtoKey)).not.toThrow()
    expect(() => validateAttributes(defs, {})).toThrow()

    const freshProbe: Record<string, unknown> = {}
    expect(Object.keys(freshProbe)).toEqual([])
    expect(Object.getPrototypeOf(freshProbe)).toBe(Object.prototype)
  })
})
