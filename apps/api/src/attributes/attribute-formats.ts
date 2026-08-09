import { z } from 'zod'

/**
 * THE core safety property of this module, inherited verbatim from
 * `jml/rule-engine.ts` and `business-roles/role-evaluator.ts`: a validation
 * rule is DATA, never code.
 *
 * A regular expression is a program. `attribute_definitions.validation_rules`
 * is admin-authored, database-sourced content, so the previous
 * `new RegExp(rules.pattern)` in `attribute-validator.ts` was this system
 * compiling and running an admin-supplied program against its own directory
 * — the exact construction this project has already rejected twice, on the
 * stated grounds that "an identity provider that runs admin-supplied script
 * against its own directory is a privilege-escalation vector by
 * construction" (docs/14-roadmap.md).
 *
 * It was also a measured denial of service. `^(a+)+$` against a
 * 33-character input blocked the Node event loop for **96.7 seconds**
 * (docs/archive/audits/security-audit-input.md); re-measured on this branch
 * at **12.5 seconds for 28 characters**, doubling per added character. There
 * is one Node process serving the whole API and draining the outbox
 * (docs/02-architecture.md), so that is a total outage, not a slow request.
 *
 * So this module replaces caller-supplied regex with a CLOSED VOCABULARY of
 * named formats, in exactly the sense `authz/actions.ts`'s permission
 * catalog and `connectors/connector.ts`'s target catalog are closed: the set
 * is static code, it changes only through code review, and every pattern
 * below is a literal written and reviewed here rather than a string read out
 * of a table. `new RegExp` no longer appears anywhere in `src/` at all, which
 * is asserted by a static source scan in test/attribute-validator.spec.ts —
 * the same kind of proof, in the same shape, that the JML engine and the
 * business-role evaluator already carry.
 *
 * Every pattern below is deliberately backtracking-free: each is a
 * concatenation of single character classes with at most one quantifier per
 * class, and where a quantified group appears (`slug`) the group's first
 * character class is DISJOINT from the class preceding it, so no input can
 * be split between them in more than one way. There is no nesting of
 * unbounded quantifiers, no alternation, no backreference and no lookaround
 * anywhere in this file. Adding one would reintroduce the very finding this
 * module closes, so it must not happen without re-deriving that property.
 */

export type AttributeFormat =
  | 'email'
  | 'url'
  | 'uuid'
  | 'alphanumeric'
  | 'numeric'
  | 'slug'
  | 'identifier'
  | 'phone_e164'
  | 'iso_country_code'
  | 'no_whitespace'

/**
 * The single source of truth for the vocabulary. `ALL_ATTRIBUTE_FORMATS` is
 * the array and `AttributeFormat` is asserted against it below, rather than
 * a hand-copied literal list beside a hand-written union — see
 * docs/12-security.md defect class 4 ("Catalog drift"), where exactly that
 * duplication left five consumers of the connector-target catalog stale.
 */
export const ALL_ATTRIBUTE_FORMATS = [
  'email',
  'url',
  'uuid',
  'alphanumeric',
  'numeric',
  'slug',
  'identifier',
  'phone_e164',
  'iso_country_code',
  'no_whitespace',
] as const satisfies readonly AttributeFormat[]

interface FormatSpec {
  /** Admin-facing description, surfaced in the 400 a rejected `pattern` produces. */
  readonly description: string
  /**
   * Composes onto an existing `ZodString` so a definition's own
   * `minLength`/`maxLength` still apply and still produce their own
   * messages first.
   */
  readonly apply: (schema: z.ZodString) => z.ZodString
}

/**
 * Null-prototype, indexed by `Object.hasOwn`, for the reason this project
 * has now been bitten by four times (docs/12-security.md defect class 2):
 * `format` is a value read back out of a jsonb column an admin controls, so
 * a row carrying `format: 'constructor'` or `'toString'` would resolve to a
 * real, truthy, inherited value on a plain `{}` literal and dispatch to
 * something that was never one of the formats below.
 */
const FORMAT_SPECS: Record<string, FormatSpec> = Object.assign(
  Object.create(null) as Record<string, FormatSpec>,
  {
    // Zod's own `.email()` — a static, reviewed, backtracking-free literal
    // in zod's source, not a pattern this system minted or stored.
    email: {
      description: 'an email address',
      apply: (schema) => schema.email(),
    },
    // Zod v3's `.url()` parses with the WHATWG `new URL()`; there is no
    // regular expression involved at all.
    url: {
      description: 'an absolute URL',
      apply: (schema) => schema.url(),
    },
    uuid: {
      description: 'a UUID',
      apply: (schema) => schema.uuid(),
    },
    alphanumeric: {
      description: 'ASCII letters and digits only',
      apply: (schema) => schema.regex(/^[A-Za-z0-9]+$/, 'must contain only letters and digits'),
    },
    numeric: {
      description: 'ASCII digits only',
      apply: (schema) => schema.regex(/^[0-9]+$/, 'must contain only digits'),
    },
    // `(?:-[a-z0-9]+)*` is quantified, but its first character class (`-`)
    // is disjoint from the class before it (`[a-z0-9]`), so an input can be
    // split between the two in exactly one way. No ambiguity, no
    // backtracking.
    slug: {
      description: 'lowercase words joined by single hyphens, e.g. cost-center-emea',
      apply: (schema) =>
        schema.regex(
          /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
          'must be lowercase words joined by single hyphens',
        ),
    },
    identifier: {
      description: 'a letter or underscore, then letters, digits or underscores',
      apply: (schema) =>
        schema.regex(
          /^[A-Za-z_][A-Za-z0-9_]*$/,
          'must start with a letter or underscore and contain only letters, digits and underscores',
        ),
    },
    phone_e164: {
      description: 'an E.164 phone number, e.g. +442071234567',
      apply: (schema) =>
        schema.regex(/^\+[1-9][0-9]{1,14}$/, 'must be an E.164 phone number, e.g. +442071234567'),
    },
    iso_country_code: {
      description: 'a two-letter ISO 3166-1 alpha-2 country code',
      apply: (schema) =>
        schema.regex(/^[A-Z]{2}$/, 'must be a two-letter uppercase ISO country code'),
    },
    no_whitespace: {
      description: 'any non-empty value containing no whitespace',
      apply: (schema) => schema.regex(/^\S+$/, 'must not contain whitespace'),
    },
  } satisfies Record<AttributeFormat, FormatSpec>,
)

/**
 * Three-valued in spirit, like `role-evaluator.ts`'s `ConditionMatch`: this
 * says only "is this one of the formats THIS binary knows". A caller that
 * gets `false` for a value stored by a newer migration must fail closed and
 * say so, never silently skip the constraint (which would fail OPEN, quietly
 * weakening validation on a field an admin deliberately constrained).
 */
export function isAttributeFormat(value: unknown): value is AttributeFormat {
  return typeof value === 'string' && Object.hasOwn(FORMAT_SPECS, value)
}

export function applyAttributeFormat(format: AttributeFormat, schema: z.ZodString): z.ZodString {
  return FORMAT_SPECS[format]!.apply(schema)
}

/** `email (an email address)`, … — for the admin-facing message on a rejected `pattern` or an unknown `format`. */
export function describeAttributeFormats(): string {
  return ALL_ATTRIBUTE_FORMATS.map((name) => `${name} (${FORMAT_SPECS[name]!.description})`).join(
    ', ',
  )
}
