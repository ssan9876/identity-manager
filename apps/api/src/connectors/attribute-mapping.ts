/**
 * Milestone 10, Task 3 — the per-target, default-deny attribute filter that
 * replaces `buildSyncedAttributes`'s single, Keycloak-only `sync_to_keycloak`
 * flag (keycloak-admin.client.ts). `buildSyncedAttributes` itself is
 * UNTOUCHED by this task (still used, unmodified, inside
 * `KeycloakAdminClient.createUser`/`updateUser` via `KeycloakConnector`'s own
 * "already-filtered, so pass a synthetic all-true list" trick — see that
 * connector's doc comment) — this module is the new computation that decides
 * WHAT populates `DesiredUser.attributes` before any connector ever sees it,
 * generalised to read `attribute_target_mappings` per target instead of one
 * global boolean.
 *
 * Two field families flow through the SAME mechanism here, deliberately:
 *  - CUSTOM attributes (`attribute_definitions`, admin-configured, key is a
 *    free-form string chosen at definition time).
 *  - CORE fields (`CoreProfileField` below — a fixed, closed set built into
 *    every user: given name, surname, title, and department derived from the
 *    org path).
 * Both are looked up by an `AttributeTargetMappingsRepository.listForTarget`
 * row's `source` discriminant, never by colliding on a shared string
 * namespace — an admin's custom attribute happens to be named "department"
 * in this project's own long-standing test fixtures (sync.worker.spec.ts),
 * and must never be confused with the CORE "department" (org-unit-derived)
 * field just because the two strings match.
 */

import type { OrgUnit } from '../org-units/org-units.repository'
import type { User } from '../users/users.repository'

/**
 * The fixed, closed set of profile fields every target may represent under
 * its own name. Hand-rolled to mirror `attributeCoreField`
 * (db/schema/attribute-target-mappings.ts) — same convention
 * `connectors/connector.ts`'s `ConnectorTarget` doc comment records for
 * mirroring `outboxTarget` by hand rather than deriving
 * `(typeof enum.enumValues)[number]`: the schema file is the source of
 * truth for the closed set; this module depends on it only through that
 * hand-kept agreement, never a runtime import, so pure logic here stays
 * decoupled from the schema/DB layer and unit-testable with no container.
 */
export type CoreProfileField = 'given_name' | 'surname' | 'title' | 'department'

/** One resolved, already-enabled-filtered mapping row for a single target — `AttributeTargetMappingsRepository.listForTarget`'s return shape. */
export interface ResolvedTargetMapping {
  /** Which raw-value dictionary `localKey` is looked up in, in `buildTargetAttributes` below. */
  source: 'custom' | 'core'
  /** `attribute_definitions.key` (source: 'custom') or a `CoreProfileField` (source: 'core'). */
  localKey: string
  /** What this target calls the field — the output key in `buildTargetAttributes`'s result. */
  remoteName: string
}

/**
 * Derives the four core-field RAW values for one user — pure, no I/O. Only
 * `department` is non-trivial: "derived from the org path" (Milestone 10,
 * Task 3 contract) means the name of the org unit this user currently
 * belongs to, i.e. `orgUnit.name` for `user.orgUnitId` — docs/product-brief.md's own
 * "moving someone between departments" already uses "department" as the
 * colloquial name for "which org unit," so this is not a new concept, only
 * the first place it becomes a propagatable value. `orgUnit` is the caller's
 * own fresh read (`OrgUnitsRepository.findById(user.orgUnitId, tx)`) — this
 * function does no lookup of its own (no connection discipline concerns:
 * it's pure). `orgUnit === null` (an org unit somehow not found — should not
 * happen; `users.org_unit_id` is `NOT NULL` and no org unit is ever deleted,
 * `onDelete: 'restrict'` on both FKs referencing it) degrades to `null`
 * rather than throwing: a missing/unmappable value is exactly what
 * `buildTargetAttributes` already drops silently for any field, custom or
 * core alike.
 *
 * `given_name`/`surname` mirror `user.firstName`/`user.lastName` exactly —
 * the SAME values `DesiredUser.firstName`/`lastName` already carry
 * unconditionally (see connector.ts's `DesiredUser` doc comment for why
 * those top-level fields are untouched by this task). Computing them again
 * here is what lets a NON-Keycloak target opt in to receiving them through
 * the generic per-target `attributes` bag too (e.g. under AD's `givenName`),
 * independent of Keycloak's own always-on top-level mechanism.
 */
export function computeCoreFieldValues(
  user: Pick<User, 'firstName' | 'lastName' | 'jobTitle'>,
  orgUnit: Pick<OrgUnit, 'name'> | null,
): Record<CoreProfileField, string | null> {
  return {
    given_name: user.firstName,
    surname: user.lastName,
    title: user.jobTitle,
    department: orgUnit?.name ?? null,
  }
}

/**
 * The default-deny merge: for every ENABLED mapping row already resolved for
 * ONE target (`mappings` — the caller, `SyncWorker.reconcileUser`, fetches
 * these via `AttributeTargetMappingsRepository.listForTarget(target, tx)`),
 * look up its raw value in the matching source dictionary and — if present —
 * emit it under the mapping's OWN `remoteName`. A local field with NO
 * mapping row for this target never appears in `mappings` at all, so it is
 * structurally impossible for this loop to ever emit it: default-deny is a
 * property of what this function ITERATES OVER, not a condition it checks
 * per key. This is the load-bearing difference from the boolean this
 * replaces — see db/schema/attribute-target-mappings.ts's own doc comment.
 *
 * Null/array/stringify semantics are IDENTICAL to the pre-existing
 * `buildSyncedAttributes` (keycloak-admin.client.ts) on purpose — same
 * "Keycloak represents every attribute as string[]" contract, now shared by
 * every target rather than assumed Keycloak-specific: `null`/`undefined`
 * values are dropped (nothing meaningful to send, not `[""]`/`["null"]`); an
 * array value is stringified element-wise; any other value becomes a
 * single-element array.
 *
 * `Object.create(null)`, not `{}` — same sweep as `buildSyncedAttributes`
 * and `buildAttributeSchema` (attribute-validator.ts): `remoteName` is
 * admin-configured data (destined to become a write path in Milestone 14),
 * so a value keyed `"__proto__"` must land as a genuine own property, not
 * silently reassign this object's own prototype.
 */
export function buildTargetAttributes(
  mappings: readonly ResolvedTargetMapping[],
  customAttributeValues: Readonly<Record<string, unknown>>,
  coreFieldValues: Readonly<Record<string, unknown>>,
): Record<string, string[]> {
  const result: Record<string, string[]> = Object.create(null)

  for (const mapping of mappings) {
    const raw =
      mapping.source === 'custom' ? customAttributeValues[mapping.localKey] : coreFieldValues[mapping.localKey]
    if (raw === null || raw === undefined) continue
    result[mapping.remoteName] = Array.isArray(raw) ? raw.map(String) : [String(raw)]
  }

  return result
}
