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
  return schema.refine((value) => !value.includes(NUL), 'must not contain a NUL character')
}
