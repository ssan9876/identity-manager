import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALL_ATTRIBUTE_FORMATS } from '../src/attributes/attribute-formats'
import {
  AttributeValidationError,
  type AttributeDefinition,
  validateAttributes,
} from '../src/attributes/attribute-validator'

const def = (
  overrides: Partial<AttributeDefinition> & Pick<AttributeDefinition, 'key' | 'dataType'>,
): AttributeDefinition => ({
  // Milestone 14, Task 9 widened AttributeDefinition with `id` — irrelevant
  // to what this pure-function suite exercises (validateAttributes never
  // reads it), so a synthetic id derived from `key` is sufficient here.
  id: `def-${overrides.key}`,
  label: overrides.key,
  required: false,
  validationRules: {},
  appliesTo: 'user',
  isActive: true,
  selfEditable: false,
  sensitive: false,
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

  it('enforces string length rules', () => {
    const defs = [
      def({
        key: 'cost_center',
        dataType: 'string',
        validationRules: { minLength: 4, maxLength: 7 },
      }),
    ]
    expect(() => validateAttributes(defs, { cost_center: 'XX' })).toThrow(/cost_center/)
    expect(() => validateAttributes(defs, { cost_center: 'CC-102400' })).toThrow(/cost_center/)
    expect(validateAttributes(defs, { cost_center: 'CC-1024' })).toEqual({
      cost_center: 'CC-1024',
    })
  })

  it('enforces a named format alongside length rules', () => {
    const defs = [
      def({
        key: 'cost_center',
        dataType: 'string',
        validationRules: { format: 'slug', maxLength: 20 },
      }),
    ]
    expect(() => validateAttributes(defs, { cost_center: 'Cost Center' })).toThrow(/cost_center/)
    expect(validateAttributes(defs, { cost_center: 'cost-center-emea' })).toEqual({
      cost_center: 'cost-center-emea',
    })
  })

  // docs/archive/audits/audit-injection.md HIGH finding: a JSON-escaped NUL is
  // legal JSON and passed every check that existed pre-fix, only failing
  // once it reached Postgres (a jsonb-stored attribute value) as a raw,
  // unmapped 500.
  it('rejects a NUL character embedded in a string attribute value', () => {
    const defs = [def({ key: 'notes', dataType: 'string' })]
    const nul = String.fromCharCode(0)
    expect(() => validateAttributes(defs, { notes: `a${nul}b` })).toThrow(AttributeValidationError)
    expect(() => validateAttributes(defs, { notes: `a${nul}b` })).toThrow(/NUL/)
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

/**
 * docs/12-security.md, "Known open items" -> ReDoS in the attribute
 * validator. `new RegExp(rules.pattern)` compiled an unvalidated,
 * database-sourced pattern and executed it against user input.
 *
 * Measured on this branch, against the code as it stood BEFORE the fix,
 * with the pattern `^(a+)+$`:
 *
 *   28-character input -> 12,537.5 ms of fully blocked event loop
 *
 * Cost doubles per added character, so the audit's own 33-character
 * measurement (96.7 s) is the same phenomenon further along the same curve.
 * There is ONE Node process serving the whole API and draining the outbox
 * (docs/02-architecture.md), so this is a total outage, not a slow request.
 *
 * The elapsed-time bound below is the assertion that matters. A test that
 * only checked "it throws" would pass just as happily 96 seconds late.
 */
describe('ReDoS: validationRules.pattern is refused, never compiled', () => {
  const CATASTROPHIC = '^(a+)+$'
  // Deliberately far longer than the 28 characters measured above: at ~2^n
  // this input would not complete in any meaningful timeframe, so if the
  // pattern were ever compiled and run again this test cannot pass slowly —
  // it can only hang, which the suite reports as a failure too.
  const LONG_INPUT = 'a'.repeat(40) + '!'

  it('rejects the exact ^(a+)+$ case against a long input in bounded time', () => {
    const defs = [
      def({ key: 'cost_center', dataType: 'string', validationRules: { pattern: CATASTROPHIC } }),
    ]

    const started = process.hrtime.bigint()
    let thrown: unknown
    try {
      validateAttributes(defs, { cost_center: LONG_INPUT })
    } catch (error) {
      thrown = error
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

    expect(thrown).toBeInstanceOf(AttributeValidationError)
    expect(elapsedMs).toBeLessThan(250)
  })

  it('fails CLOSED — a definition still carrying `pattern` rejects even a value that pattern would have allowed', () => {
    // Fail-open is the tempting shape of this fix: drop `pattern`, accept
    // everything. That silently removes a constraint an admin set.
    const defs = [
      def({
        key: 'cost_center',
        dataType: 'string',
        validationRules: { pattern: '^CC-[0-9]{4}$' },
      }),
    ]
    expect(() => validateAttributes(defs, { cost_center: 'CC-1024' })).toThrow(
      AttributeValidationError,
    )
  })

  it('names the definition and the replacement vocabulary in the rejection', () => {
    const defs = [
      def({ key: 'cost_center', dataType: 'string', validationRules: { pattern: CATASTROPHIC } }),
    ]
    expect(() => validateAttributes(defs, { cost_center: 'x' })).toThrow(/cost_center/)
    expect(() => validateAttributes(defs, { cost_center: 'x' })).toThrow(/validationRules\.format/)
    expect(() => validateAttributes(defs, { cost_center: 'x' })).toThrow(/iso_country_code/)
  })

  it('fails CLOSED on a `format` this binary does not know, rather than skipping the constraint', () => {
    // The role-evaluator's three-valued rule, applied here: a value written
    // by a migration newer than the running binary must not silently become
    // "no constraint at all".
    const defs = [
      def({ key: 'cost_center', dataType: 'string', validationRules: { format: 'postcode_uk' } }),
    ]
    expect(() => validateAttributes(defs, { cost_center: 'SW1A 1AA' })).toThrow(
      AttributeValidationError,
    )
    expect(() => validateAttributes(defs, { cost_center: 'SW1A 1AA' })).toThrow(/unknown/)
  })

  it('fails CLOSED on a prototype-chain `format` name', () => {
    // `format` is a jsonb value an admin controls. On a plain `{}` catalog,
    // `FORMAT_SPECS['constructor']` is a truthy inherited function — the
    // defect class this project has hit four times (docs/12-security.md).
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const defs = [
        def({ key: 'cost_center', dataType: 'string', validationRules: { format: name } }),
      ]
      expect(() => validateAttributes(defs, { cost_center: 'anything' })).toThrow(
        AttributeValidationError,
      )
    }
  })
})

describe('the closed format vocabulary', () => {
  const accepts: Record<string, string> = {
    email: 'a.person@example.com',
    url: 'https://example.com/x',
    uuid: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    alphanumeric: 'CC1024',
    numeric: '1024',
    slug: 'cost-center-emea',
    identifier: '_cost_center1',
    phone_e164: '+442071234567',
    iso_country_code: 'GB',
    no_whitespace: 'CC-1024',
  }
  const rejects: Record<string, string> = {
    email: 'not-an-email',
    url: 'not a url',
    uuid: 'not-a-uuid',
    alphanumeric: 'CC-1024',
    numeric: '10.24',
    slug: 'Cost Center',
    identifier: '1cost',
    phone_e164: '0044 20 7123 4567',
    iso_country_code: 'gbr',
    no_whitespace: 'CC 1024',
  }

  it('covers every format in ALL_ATTRIBUTE_FORMATS, so a new one cannot land untested', () => {
    expect(Object.keys(accepts).sort()).toEqual([...ALL_ATTRIBUTE_FORMATS].sort())
    expect(Object.keys(rejects).sort()).toEqual([...ALL_ATTRIBUTE_FORMATS].sort())
  })

  for (const format of ALL_ATTRIBUTE_FORMATS) {
    it(`accepts and rejects correctly for format "${format}"`, () => {
      const defs = [def({ key: 'field', dataType: 'string', validationRules: { format } })]
      expect(validateAttributes(defs, { field: accepts[format] })).toEqual({
        field: accepts[format],
      })
      expect(() => validateAttributes(defs, { field: rejects[format] })).toThrow(
        AttributeValidationError,
      )
    })
  }

  /**
   * Every format is applied to long adversarial inputs and must complete
   * promptly. This is what makes "closed vocabulary" a real guarantee rather
   * than a relabelling: it would be entirely possible to write a
   * catastrophically-backtracking literal in attribute-formats.ts and be no
   * better off than before.
   */
  it('every format resolves in bounded time on long adversarial inputs', () => {
    const adversarial = [
      'a'.repeat(4000),
      'a'.repeat(2000) + '!',
      '-'.repeat(2000) + '!',
      'a-'.repeat(1000) + '!',
      '+' + '1'.repeat(2000) + '!',
      ' '.repeat(2000) + 'x',
      'a@' + 'b'.repeat(2000),
    ]

    const started = process.hrtime.bigint()
    for (const format of ALL_ATTRIBUTE_FORMATS) {
      const defs = [def({ key: 'field', dataType: 'string', validationRules: { format } })]
      for (const value of adversarial) {
        try {
          validateAttributes(defs, { field: value })
        } catch {
          // rejection is expected for most of these; timing is the assertion
        }
      }
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

    expect(elapsedMs).toBeLessThan(1000)
  })
})

/**
 * Static source scan, in the same shape and for the same reason as
 * test/jml-rule-engine.spec.ts's and test/business-role-evaluator.spec.ts's:
 * the guarantee is about what the source CANNOT do, so asserting it against
 * the source is stronger than asserting behaviour at one call site that a
 * future call site is free to bypass.
 *
 * Scoped to the whole of `src/`, not just `src/attributes/`, because the
 * brief for this fix was explicitly to apply the same scrutiny to any other
 * dynamic regex construction in the tree. Regex LITERALS (`/^[a-z]+$/`) are
 * fine and plentiful — they are reviewed source, not database content. It is
 * dynamic CONSTRUCTION from a runtime value that is banned, so the ban is on
 * the `RegExp` constructor itself.
 */
describe('no dynamic code or regex construction anywhere in src/', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return sourceFiles(full)
      return entry.isFile() && full.endsWith('.ts') ? [full] : []
    })
  }

  /**
   * Comments are stripped before scanning. Without this the scan is unusable
   * in exactly the files that matter most: attribute-formats.ts and
   * attribute-validator.ts both DISCUSS `new RegExp` at length in their doc
   * comments, explaining why it is gone. A scan that cannot tell an
   * explanation from a call would force those explanations to be deleted,
   * which is the opposite of what this project wants.
   */
  function stripComments(text: string): string {
    return text.replace(/\/\*[^]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ')
  }

  it('constructs no RegExp from a runtime value, and contains no eval or Function construction', () => {
    const offenders: string[] = []

    for (const file of sourceFiles(path.resolve(process.cwd(), 'src'))) {
      const text = stripComments(readFileSync(file, 'utf8'))
      if (
        /\bnew\s+RegExp\s*\(/.test(text) ||
        /(?<!\w|\.)RegExp\s*\(/.test(text) ||
        /\beval\s*\(/.test(text) ||
        /\bnew\s+Function\s*\(/.test(text) ||
        /(?<!\w)Function\s*\(/.test(text)
      ) {
        offenders.push(path.relative(process.cwd(), file))
      }
    }

    expect(offenders).toEqual([])
  })
})
