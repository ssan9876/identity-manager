import { z } from 'zod'

// Built via String.fromCharCode, never a literal escape sequence typed
// in-source: this is the one character a source file cannot safely contain
// as raw text (many tools, including `git diff`, treat a file containing an
// embedded NUL byte as binary), so it is constructed at runtime instead of
// written as a literal anywhere below.
const NUL = String.fromCharCode(0)

/**
 * Postgres cannot store an embedded NUL (Unicode code point 0) in ANY
 * `text`-shaped column (`varchar`, `text`, `jsonb`) — this is a hard
 * server-side limitation of the `text` type itself, independent of
 * encoding: it is not merely an invalid-UTF8 issue that a `CHECK`
 * constraint or a different client encoding would sidestep.
 *
 * A JSON-ESCAPED NUL is entirely legal JSON and sails straight through
 * `body-parser`'s `JSON.parse`, every Zod string check
 * (`.min()`/`.max()`/`.email()`/`.regex()`), and `csv-parse`. It only fails
 * once it reaches the `pg` driver, as a raw, non-`DomainError` exception —
 * `DomainExceptionFilter` (`@Catch(DomainError)`) does not touch it, so Nest
 * falls through to its default handler and returns an unmapped 500 on every
 * write (docs/archive/audits/audit-injection.md HIGH finding). A literal, raw
 * NUL *byte* embedded in JSON text is a DIFFERENT, already-safe case — that
 * is invalid JSON syntax and `JSON.parse` itself rejects it ("Bad control
 * character") before any application code runs; only the escaped form needs
 * handling here.
 *
 * `noNulChar` wraps an existing `ZodString` schema (composed at the END of
 * whatever chain of `.min()`/`.max()`/`.email()`/etc. a field already has,
 * so those checks still run and still produce their own specific messages
 * first) and rejects any value containing this character, naming the field
 * via Zod's normal per-field path reporting — a 400 `VALIDATION_FAILED`
 * raised at the validation boundary, before the value can ever reach the
 * driver.
 */
export function noNulChar<T extends z.ZodString>(schema: T) {
  return schema.refine((value) => !containsNulChar(value), 'must not contain a NUL character')
}

/**
 * The same check, for the values a `ZodString` never sees: free-form JSON
 * bound for a `jsonb` column, where the offending string can sit at any depth
 * and under any key. `noNulChar` above is the schema-level guard for named
 * string fields; this is the primitive both it and those deep scans share, so
 * the character itself is still defined in exactly one place (see the NUL
 * constant above for why it is constructed rather than typed).
 */
export function containsNulChar(value: string): boolean {
  return value.includes(NUL)
}

/**
 * Unicode general category `Cf` — "format" characters. Every one of these is
 * INVISIBLE when rendered, and several actively reorder the glyphs around
 * them: U+202A–U+202E (the bidi embeddings and overrides), U+2066–U+2069 (the
 * bidi isolates), U+200B–U+200F (zero-width space/non-joiner/joiner and the
 * left-to-right and right-to-left marks), plus U+00AD, U+2060–U+2064, U+FEFF
 * and the rest of the category.
 *
 * Why this matters HERE and not merely as tidiness — finding INJ-L-1
 * (docs/archive/audits/audit-injection.md, carried as an Item-10 residual in
 * carried-findings-verification.md). `displayName` is DERIVED from
 * `firstName`/`lastName` (UsersRepository.update) and shown directory-wide,
 * in group rosters, audit rows and every person picker. An RTL override
 * inside a name renders one account visually identical to another
 * ("ad<U+202E>nimda" reads as "admin"), and a zero-width joiner splits a
 * name into two rows that no human reviewer can tell apart. That is
 * display-layer impersonation in a directory whose entire job is telling
 * people apart. The audit's original repro created exactly these rows and got
 * a 201 for each.
 *
 * This is the second half of INJ-L-1's fix direction ("normalise to NFC and
 * reject `Cf`-category characters"). The NFC half landed already, on the one
 * site that sets `username` (UsersRepository.create). NFC alone does not help
 * here: none of these characters are removed or altered by any normalisation
 * form — NFC composes and reorders, it does not strip formatting.
 *
 * DELIBERATE COST, named so the next reader can weigh it rather than
 * rediscover it: U+200C ZWNJ and U+200D ZWJ are load-bearing orthography in
 * Persian, Hindi and several other scripts, and rejecting the whole category
 * rejects them too. The narrower alternative — bidi controls only
 * (U+202A–U+202E, U+2066–U+2069, U+200E–U+200F) — leaves the zero-width
 * characters, and those are precisely what produce two rows a reviewer reads
 * as the same person. The whole category is rejected because this is an
 * identity directory: a name that cannot be reproduced by looking at it is a
 * worse failure here than a name that has to be spelled without a joiner.
 * Changing this set is a review decision; it is one regex, in one place.
 *
 * Applied to `username`, `firstName`, `lastName` and `primaryEmail` — the
 * four fields the finding names — on both write paths (POST/PATCH /users and
 * the CSV import). NOT applied to `jobTitle`/`location`/free-text
 * descriptions: those are not identity, nobody is impersonated by a job
 * title, and the category contains characters legitimate prose may want.
 */
const FORMAT_CHAR = /\p{Cf}/u

/**
 * Wraps a string schema — a bare `ZodString` or an already-refined one such
 * as `noNulChar(...)`'s result — and rejects any value containing a `Cf`
 * character. Composed at the END of a field's chain, like `noNulChar`, so
 * `.min()`/`.max()`/`.email()` still report their own specific messages
 * first. The message deliberately does NOT echo the offending character or
 * its code point back: it is invisible, so printing it is useless to the
 * caller, and echoing a submitted value into a 4xx is the pattern finding
 * SEC-L2 exists about.
 *
 * Typed over `z.ZodType<Output extends string, ...>` rather than
 * `z.ZodString`, unlike `noNulChar`: it has to compose ON TOP of
 * `noNulChar(...)`, whose result is a `ZodEffects`, not a `ZodString`. The
 * `Output`/`Input` parameters are inferred and passed straight through, so
 * `.optional()`/`.nullable()` still chain onto the result and the field's
 * inferred type is unchanged.
 */
export function noFormatChar<Output extends string, Def extends z.ZodTypeDef, Input>(
  schema: z.ZodType<Output, Def, Input>,
) {
  return schema.refine(
    (value) => !containsFormatChar(value),
    'must not contain invisible Unicode formatting characters (bidi controls, zero-width joiners)',
  )
}

/** The primitive behind `noFormatChar`, for callers holding a plain string. */
export function containsFormatChar(value: string): boolean {
  return FORMAT_CHAR.test(value)
}
