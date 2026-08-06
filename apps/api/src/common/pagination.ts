import { z } from 'zod'
import { ValidationError } from './errors'

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 100

export interface PageQuery {
  limit: number
  offset: number
}

export interface Page<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}

/**
 * `z.coerce.number()` alone accepts a single-element ARRAY too, not just a
 * scalar: Express's query parser (`qs`) turns `?limit[]=5` into
 * `{ limit: ['5'] }`, and `Number(['5'])` is `5` — `Array.prototype.toString`
 * joins a one-element array with no separator before the numeric coercion
 * ever runs, so `z.coerce.number()` never sees anything array-shaped in the
 * first place. (A two-element array correctly 400s: `Number(['5','6'])` is
 * `NaN`, since `['5','6'].toString()` is `"5,6"`.) No security impact on its
 * own — the resulting value is still an integer, still clamped to
 * MAX_LIMIT, still bound as a parameter — but it is silent type coercion
 * that should be a 400. `scalarOnly` rejects anything that isn't ALREADY a
 * bare string or number (arrays included) before coercion ever runs, via a
 * `z.union` that has no array member — exactly the "`.pipe()` through a
 * plain string/number union first" fix direction the audit calls for.
 */
function scalarOnly<T extends z.ZodTypeAny>(target: T) {
  return z.union([z.string(), z.number()]).pipe(target)
}

const pageSchema = z.object({
  limit: scalarOnly(z.coerce.number().int().positive()).default(DEFAULT_LIMIT),
  // Number.isInteger(1e21) is true — huge values like this are still
  // "integers" in float terms, so .int() alone lets them through. Without an
  // upper bound, a value like "1e21" used to pass validation and only fail
  // once it reached Postgres as a raw bigint parameter (an unmapped 500).
  // MAX_SAFE_INTEGER is the ceiling below which a JS number is guaranteed to
  // round-trip through Postgres's bigint offset exactly.
  offset: scalarOnly(z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER)).default(0),
})

/**
 * An oversized limit is clamped rather than rejected — a caller asking for
 * "everything" gets a page, not a 400. Malformed input is still an error.
 */
export function parsePageQuery(raw: unknown): PageQuery {
  const parsed = pageSchema.safeParse(raw ?? {})

  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || 'query'}: ${issue.message}`,
      ),
    )
  }

  return {
    limit: Math.min(parsed.data.limit, MAX_LIMIT),
    offset: parsed.data.offset,
  }
}
