import { ApiError } from '../api/client'

export interface FieldErrorResult {
  /** Field key -> message, for every issue this could attribute to a field this form actually renders. */
  fieldErrors: Record<string, string>
  /** A single message for anything that could NOT be attributed to a known field — never populated at the same time as a matched fieldError for that same issue. */
  formError: string | null
}

/**
 * Maps a failed create/update request onto the form's OWN fields —
 * task-3-brief.md: "surfacing the API's field-named 400s against the right
 * inputs rather than as a banner" — DESIGN.md: "error text under the field
 * naming the field." `knownFields` is every field key this specific form
 * renders an input for (core fields the caller lists, unioned with whatever
 * attribute keys it fetched) — the create and edit forms pass DIFFERENT
 * sets here (edit has no primaryEmail/username/orgUnitId input to blame,
 * since PATCH /users/:id does not accept them), so the same mapping logic
 * naturally falls back to `formError` for a mismatch rather than crediting
 * the wrong input.
 *
 * Two error shapes reach this function, and only the first is structured:
 *  1. `ValidationError`/`AttributeValidationError` (400) — `issues` is
 *     always `"key: message"` (or a bare message with no key at all) — see
 *     `parseBody`/`validateAttributes` on the API side. This is the common,
 *     fully-reliable case.
 *  2. `ConflictError` (409, a duplicate email/username/employee id) and a
 *     bad-reference `NotFoundError` (404, an org unit or manager id that
 *     does not exist) carry no `issues` array at all — only a prose
 *     `message` naming the offending resource. These are matched by a
 *     best-effort keyword search, so the single most common real-world
 *     create-user failure (a duplicate email or username) still lands on
 *     its own input instead of a generic banner. Anything that matches
 *     nothing — including a genuinely unattributable error, e.g. "user not
 *     found" for a target deleted between page load and submit — still
 *     falls back to `formError`, never silently disappears.
 */
export function mapApiErrorToFields(error: ApiError, knownFields: ReadonlySet<string>): FieldErrorResult {
  if (error.issues !== undefined && error.issues.length > 0) {
    const fieldErrors: Record<string, string> = {}
    const unmatched: string[] = []

    for (const issue of error.issues) {
      const separatorIndex = issue.indexOf(': ')
      const key = separatorIndex === -1 ? '' : issue.slice(0, separatorIndex)
      const message = separatorIndex === -1 ? issue : issue.slice(separatorIndex + 2)

      if (knownFields.has(key)) {
        fieldErrors[key] = message
      } else {
        unmatched.push(issue)
      }
    }

    return { fieldErrors, formError: unmatched.length > 0 ? unmatched.join('; ') : null }
  }

  const message = error.message.toLowerCase()
  const referenceFieldByKeyword: [field: string, needle: string][] = [
    ['primaryEmail', 'email'],
    ['username', 'username'],
    ['employeeId', 'employee id'],
    ['orgUnitId', 'org unit'],
    ['managerId', 'manager'],
  ]
  for (const [field, needle] of referenceFieldByKeyword) {
    if (knownFields.has(field) && message.includes(needle)) {
      return { fieldErrors: { [field]: error.message }, formError: null }
    }
  }

  return { fieldErrors: {}, formError: error.message }
}

/** True for any error condition worth re-checking field-by-field — narrows `unknown` from a catch block to `ApiError` in one place, rather than each form repeating `cause instanceof ApiError`. */
export function isApiError(cause: unknown): cause is ApiError {
  return cause instanceof ApiError
}
