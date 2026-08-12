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
  /**
   * Milestone 8, Task 7. Withhold this attribute's value from audit-log
   * snapshots — finding SEC-M1. Returned by BOTH endpoints this type serves
   * (`GET /attribute-definitions` and `GET /self`'s `editable.attributes`,
   * which hand back the identical API-side shape), so it is required here
   * rather than optional.
   */
  sensitive: boolean
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

/**
 * The write half of the attribute-definition catalogue — Milestone 8,
 * Tasks 7 and 10.
 *
 * Every shape below MIRRORS a `.strict()` zod schema in
 * apps/api/src/attributes/attribute-definitions.controller.ts. Strict means a
 * field this console invents is a 400 naming it, never a silent no-op, so
 * these types are deliberately narrower than "whatever the server might
 * accept": they are the contract, and drifting from it fails loudly at the
 * one place that can still explain itself.
 *
 * NOTHING here re-implements a refusal. The API decides whether a default
 * fits its own definition, whether a migration's blast radius is tolerable,
 * and whether a preview still authorises a commit; the console renders what
 * it is told. A rule restated in TypeScript is a rule free to disagree with
 * the one that actually runs — and the one that actually runs is the one
 * holding the transaction.
 */
export interface CreateAttributeDefinitionInput {
  key: string
  label: string
  dataType: AttributeDataType
  appliesTo: 'user' | 'group'
  required?: boolean
  defaultValue?: string | number | boolean | null
  validationRules?: AttributeValidationRules
  selfEditable?: boolean
  sensitive?: boolean
}

/**
 * Mirrors `patchBodySchema`. `key`, `dataType` and `appliesTo` are absent BY
 * CONSTRUCTION rather than merely unused: all three rewrite or orphan values
 * already stored in `users.attributes`, and the API refuses each with a
 * message naming the migration route instead. `dataType` changes go through
 * `previewAttributeMigration` / `commitAttributeMigration` below.
 *
 * `defaultValue: null` CLEARS a default and is a meaningful value to send;
 * omitting the field entirely leaves it alone. The two are not the same
 * request, which is why this is not `Partial<...>` over a nullable field.
 */
export interface AttributeDefinitionPatch {
  label?: string
  required?: boolean
  defaultValue?: string | number | boolean | null
  validationRules?: AttributeValidationRules
  selfEditable?: boolean
  sensitive?: boolean
}

/** Mirrors `AttributeMigrationChange`. `appliesTo` is previewable but REFUSED at commit — see `AttributeMigrationPanel`. */
export interface AttributeMigrationChange {
  dataType?: AttributeDataType
  appliesTo?: 'user' | 'group'
}

/** One holder whose stored value would not survive the conversion. For a `sensitive` definition the API redacts `value` AND `reason` before either leaves the server. */
export interface UnconvertibleValue {
  userId: string
  value: unknown
  reason: string
}

/** Mirrors `BlastRadiusEvaluation` — the same evaluation connector reconciliation uses, over this attribute's holders rather than the directory. */
export interface BlastRadiusEvaluation {
  tripped: boolean
  changedCount: number
  populationSize: number
  thresholdPercent: number
  floor: number
}

export interface AttributeMigrationReport {
  /** Every user HOLDING this attribute, not every user in the directory — the denominator that makes the percentage mean anything. */
  populationSize: number
  changedCount: number
  /** A BOUNDED sample, not the total. Empty means every held value survives. */
  unconvertible: UnconvertibleValue[]
  blastRadius: BlastRadiusEvaluation
  /**
   * The authorisation a commit must present. It covers the definition, the
   * exact change AND its base, and every holder's id and CURRENT VALUE — so
   * it stops being valid the moment anything it promised stops being true.
   * Treat it as opaque: the console never parses, compares or re-derives it,
   * it only hands back the one the preview issued.
   */
  previewHash: string
}

export function createAttributeDefinition(
  accessToken: string,
  input: CreateAttributeDefinitionInput,
): Promise<AttributeDefinition> {
  return authorizedRequest<AttributeDefinition>('/attribute-definitions', accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function updateAttributeDefinition(
  accessToken: string,
  id: string,
  patch: AttributeDefinitionPatch,
): Promise<AttributeDefinition> {
  return authorizedRequest<AttributeDefinition>(`/attribute-definitions/${id}`, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/**
 * `POST /attribute-definitions/:id/preview` — writes NOTHING. Reports what a
 * `dataType` change would do to every stored value under this key.
 *
 * POST rather than GET on purpose, and the reason is worth knowing here too:
 * a GET is the shape of a thing browsers prefetch, proxies retry and logs
 * record whole. None of that should happen to a directory-wide walk over
 * stored attribute values.
 *
 * Gated on `attribute:manage`, NOT `attribute:read` — it returns a sample of
 * real values and is the first half of a write. A console that offered this
 * to a holder of `attribute:read` would be offering something the API will
 * refuse, which is worse than not offering it.
 */
export function previewAttributeMigration(
  accessToken: string,
  id: string,
  change: AttributeMigrationChange,
): Promise<AttributeMigrationReport> {
  return authorizedRequest<AttributeMigrationReport>(
    `/attribute-definitions/${id}/preview`,
    accessToken,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(change),
    },
  )
}

/**
 * `POST /attribute-definitions/:id/commit` — applies exactly the migration a
 * preview reported, or none of it.
 *
 * `previewHash` is REQUIRED by the API's DTO, so it is required here: a
 * commit carrying no hash is a migration nobody read. `force` overrides the
 * blast-radius refusal ONLY — never an unconvertible value, and never the
 * hash — which is why this console disables the commit button on
 * unconvertible values but merely gates `force` behind a deliberate tick.
 */
export function commitAttributeMigration(
  accessToken: string,
  id: string,
  change: AttributeMigrationChange,
  previewHash: string,
  options: { force?: boolean } = {},
): Promise<AttributeMigrationReport> {
  return authorizedRequest<AttributeMigrationReport>(
    `/attribute-definitions/${id}/commit`,
    accessToken,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...change, previewHash, ...options }),
    },
  )
}
