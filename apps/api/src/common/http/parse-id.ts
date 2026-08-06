import { z } from 'zod'
import { ValidationError } from '../errors'

const uuidSchema = z.string().uuid()

/**
 * Parses a path or query parameter as a UUID.
 * Rejects non-strings rather than coercing — a caller passing an array or a
 * number is a malformed request, not something to guess at.
 */
export function parseId(raw: unknown, field = 'id'): string {
  const parsed = uuidSchema.safeParse(raw)

  if (!parsed.success) {
    throw new ValidationError([`${field}: must be a UUID`])
  }

  return parsed.data
}
