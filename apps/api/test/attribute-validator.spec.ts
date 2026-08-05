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

  it('treats an optional "__proto__" definition as absent when the payload never sets it, validating the rest of the payload normally', () => {
    const defs = [
      def({ key: '__proto__', dataType: 'string', required: false }),
      def({ key: 'ordinary_field', dataType: 'string' }),
    ]

    // The payload is an ordinary object literal: it has no *own* "__proto__"
    // property. Reading payload['__proto__'] off it inherits
    // Object.prototype's accessor, returning the payload's own prototype
    // object rather than undefined — which, unless the payload is
    // sanitized first, defeats `.optional()` and fails validation for a
    // key this payload never mentioned.
    expect(validateAttributes(defs, { ordinary_field: 'hello' })).toEqual({
      ordinary_field: 'hello',
    })
  })

  it('treats optional "constructor", "toString", "hasOwnProperty", "valueOf", and "isPrototypeOf" definitions as absent when the payload never sets them', () => {
    for (const key of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
      const defs = [
        def({ key, dataType: 'string', required: false }),
        def({ key: 'ordinary_field', dataType: 'string' }),
      ]
      expect(validateAttributes(defs, { ordinary_field: 'hello' })).toEqual({
        ordinary_field: 'hello',
      })
    }
  })

  it('still enforces a required "__proto__" definition after payload sanitization: {} throws, an own-keyed payload succeeds', () => {
    const defs = [def({ key: '__proto__', dataType: 'string', required: true })]

    expect(() => validateAttributes(defs, {})).toThrow(AttributeValidationError)

    // Object.fromEntries creates a genuine *own* "__proto__" data property,
    // which sanitizePayload must preserve (not just discard as if absent).
    const payloadWithProtoKey = Object.fromEntries([['__proto__', 'CC-1']])
    expect(Object.prototype.hasOwnProperty.call(payloadWithProtoKey, '__proto__')).toBe(
      true,
    )
    expect(() => validateAttributes(defs, payloadWithProtoKey)).not.toThrow()
  })

  it('causes no global Object prototype pollution when validating optional or required "dangerous key" definitions', () => {
    const beforeProtoKeys = Object.getOwnPropertyNames(Object.prototype)

    const ordinaryOnly = { ordinary_field: 'hello' }
    validateAttributes(
      [
        def({ key: '__proto__', dataType: 'string', required: false }),
        def({ key: 'ordinary_field', dataType: 'string' }),
      ],
      ordinaryOnly,
    )
    validateAttributes(
      [
        def({ key: 'constructor', dataType: 'string', required: false }),
        def({ key: 'ordinary_field', dataType: 'string' }),
      ],
      ordinaryOnly,
    )
    const payloadWithProtoKey = Object.fromEntries([['__proto__', 'CC-1']])
    validateAttributes(
      [def({ key: '__proto__', dataType: 'string', required: true })],
      payloadWithProtoKey,
    )

    expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(beforeProtoKeys)

    const freshProbe: Record<string, unknown> = {}
    expect(Object.keys(freshProbe)).toEqual([])
    expect(Object.getPrototypeOf(freshProbe)).toBe(Object.prototype)
  })

  it('rejects an unmodeled key with a throwing getter cleanly, without ever invoking the getter', () => {
    const defs = [def({ key: 'other_field', dataType: 'string' })]

    let getterCalls = 0
    const payload: Record<string, unknown> = { other_field: 'valid value' }
    Object.defineProperty(payload, 'evil_unmodeled', {
      get() {
        getterCalls++
        throw new Error('getter boom')
      },
      enumerable: true,
      configurable: true,
    })

    try {
      validateAttributes(defs, payload)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(AttributeValidationError)
      expect((error as AttributeValidationError).issues.join('; ')).toMatch(
        /evil_unmodeled/,
      )
    }
    // The whole point of copying by descriptor rather than by value: an
    // unmodeled key's getter is carried across as a function reference and
    // is never called, because Zod's strict-mode "is this key known"
    // check (for...in) only ever reads key *names*, not values.
    expect(getterCalls).toBe(0)
  })

  it('documents the behaviour for a DECLARED key whose getter throws: it is not a silent success', () => {
    const defs = [def({ key: 'declared_throwing', dataType: 'string', required: true })]

    const payload: Record<string, unknown> = {}
    Object.defineProperty(payload, 'declared_throwing', {
      get() {
        throw new Error('declared getter boom')
      },
      enumerable: true,
      configurable: true,
    })

    // Unlike the unmodeled-key case above, Zod *must* read a declared
    // field's value to validate it (buildAttributeSchema's shape says this
    // key matters), so the getter necessarily runs, and its throw is not
    // something payload sanitization can intercept or convert — Zod's own
    // per-field read (`ctx.data[key]`) is not wrapped in a try/catch, so
    // this propagates as the getter's own raw Error, not an
    // AttributeValidationError. The requirement here is only that it is
    // not a silent success: the caller must see *some* failure rather than
    // an incomplete or wrong result passed off as valid.
    expect(() => validateAttributes(defs, payload)).toThrow('declared getter boom')
  })

  it('validates a non-enumerable own property for a required declared attribute, and includes it in the result', () => {
    const defs = [def({ key: 'cost_center', dataType: 'string', required: true })]

    const payload: Record<string, unknown> = {}
    Object.defineProperty(payload, 'cost_center', {
      value: 'CC-9999',
      enumerable: false,
      writable: true,
      configurable: true,
    })

    expect(validateAttributes(defs, payload)).toEqual({ cost_center: 'CC-9999' })
  })

  it('validates a non-enumerable own property for an optional declared attribute, without silently dropping it', () => {
    const defs = [def({ key: 'cost_center', dataType: 'string', required: false })]

    const payload: Record<string, unknown> = {}
    Object.defineProperty(payload, 'cost_center', {
      value: 'CC-9999',
      enumerable: false,
      writable: true,
      configurable: true,
    })

    expect(validateAttributes(defs, payload)).toEqual({ cost_center: 'CC-9999' })
  })
})
