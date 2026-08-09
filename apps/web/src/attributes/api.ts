import { authorizedRequest, buildQuery } from '../api/client'

export type AttributeDataType = 'string' | 'number' | 'boolean' | 'date' | 'enum'

/**
 * Mirrors `ValidationRules` in
 * apps/api/src/attributes/attribute-validator.ts.
 *
 * `pattern` is deliberately absent, not merely unused: it was an
 * admin-supplied regular expression the API compiled with `new RegExp(...)`
 * and executed against user input — a measured 96.7-second event-loop stall
 * (docs/12-security.md). It is replaced by `format`, a closed vocabulary of
 * named validators the API owns (apps/api/src/attributes/attribute-formats.ts).
 * Nothing in this console has ever evaluated a pattern client-side, and
 * nothing should start: authorization and validation are enforced in the
 * API, never the UI.
 */
export interface AttributeValidationRules {
  minLength?: number
  maxLength?: number
  format?: string
  min?: number
  max?: number
  options?: string[]
}

/**
 * Mirrors `AttributeDefinition` from
 * apps/api/src/attributes/attribute-validator.ts. Originally declared only
 * in self-service/api.ts (Milestone 6), which saw exclusively the CALLER's
 * own active+self_editable subset via `GET /self`. Moved here, unchanged,
 * as the one shared shape both self-service (Milestone 6) and the admin
 * create/edit user form (Milestone 8, Task 3, via `GET
 * /attribute-definitions` — see `fetchAttributeDefinitions` below) build
 * their fields from — self-service/api.ts re-exports this type rather than
 * declaring a second, divergent copy.
 */
export interface AttributeDefinition {
  /** Milestone 14, Task 9 — the stable id the connector console's attribute mapping editor references (attribute_target_mappings.attribute_definition_id), never the mutable `key`. */
  id: string
  key: string
  label: string
  dataType: AttributeDataType
  required: boolean
  validationRules: AttributeValidationRules
  appliesTo: 'user' | 'group'
  isActive: boolean
  selfEditable: boolean
}

/**
 * `GET /attribute-definitions?appliesTo=...` — Milestone 8, Task 3's one new
 * endpoint. Unlike `GET /self`'s `editable.attributes` (already filtered to
 * what the CALLER may edit about themselves), this returns the FULL active
 * catalog for the given entity type: an admin creating or editing someone
 * else is not bound by `selfEditable` (that flag constrains self-service
 * only — see the API controller's own doc comment), so the create/edit user
 * form renders every active, user-scoped definition, not just the
 * self-editable ones.
 */
export function fetchAttributeDefinitions(
  accessToken: string,
  appliesTo: 'user' | 'group',
): Promise<AttributeDefinition[]> {
  return authorizedRequest<AttributeDefinition[]>(
    `/attribute-definitions${buildQuery({ appliesTo })}`,
    accessToken,
  )
}
