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

const pageSchema = z.object({
  limit: z.coerce.number().int().positive().default(DEFAULT_LIMIT),
  // Number.isInteger(1e21) is true — huge values like this are still
  // "integers" in float terms, so .int() alone lets them through. Without an
  // upper bound, a value like "1e21" used to pass validation and only fail
  // once it reached Postgres as a raw bigint parameter (an unmapped 500).
  // MAX_SAFE_INTEGER is the ceiling below which a JS number is guaranteed to
  // round-trip through Postgres's bigint offset exactly.
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
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
