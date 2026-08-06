import { z } from 'zod'
import { ValidationError } from '../errors'

/**
 * Parses an HTTP body against `bodySchema`, translating a Zod failure into
 * the same ValidationError -> 400 VALIDATION_FAILED shape every other input
 * check (parseId, parsePageQuery, validateAttributes) already produces.
 *
 * Originally private to users.controller.ts (Milestone 3b, Task 2). Moved
 * here, unchanged, when org-units.controller.ts and groups.controller.ts
 * needed the identical logic (Task 3) — the same reason parseId and
 * parsePageQuery already live in common/http/common rather than being
 * copied per controller.
 */
export function parseBody<T>(bodySchema: z.ZodType<T>, body: unknown): T {
  const result = bodySchema.safeParse(body)
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`),
    )
  }
  return result.data
}
