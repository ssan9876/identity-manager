import { authorizedRequest, buildQuery } from '../api/client'

/**
 * Mirrors `ALL_CONNECTOR_TARGETS` (apps/api/src/connectors/connector.ts).
 *
 * That module's doc comment records why a hand-copied list is dangerous:
 * five of them went stale when `mail_server` was added and the type system
 * could not see it, because a narrower literal list is perfectly assignable
 * to a wider union. THIS list went stale the same way and for the same
 * reason, and was fixed on 2026-08-08 — the observable damage was that the
 * console could not list, configure, enable or DISABLE the live mail target
 * at all, and `CONNECTOR_TARGET_LABEL[event.target]` rendered `undefined`
 * for a mail_server dead letter.
 *
 * There is no shared package between the two apps, so unlike the API side
 * this copy cannot derive from the source and must be updated BY HAND
 * whenever a target is added.
 *
 * You are no longer expected to REMEMBER that.
 * apps/web/scripts/check-connector-targets.mjs — run by this package's `test`
 * script, i.e. by `pnpm verify`'s "web checks" stage and by CI's Verify step —
 * parses the API's `ALL_CONNECTOR_TARGETS` and fails if the union below, the
 * `ALL_CONNECTOR_TARGETS` below it, or `CONNECTOR_TARGET_LABEL` has drifted
 * from it in either direction. All three are checked separately: a target
 * present in the union but unlabelled is the `undefined`-in-the-UI half of
 * the same bug, and `Record<ConnectorTarget, string>` cannot catch it while
 * the union is stale too. If that script fails, its output names the exact
 * edits to make here.
 */
export type ConnectorTarget =
  | 'keycloak'
  | 'active_directory'
  | 'entra_id'
  | 'google_workspace'
  | 'echo'
  | 'mail_server'
  | 'scim_slack'
  | 'scim_zoom'
  | 'scim_atlassian'
  | 'scim_box'
  | 'scim_snowflake'
  | 'scim_generic'
  | 'keycloak_sso'

export const ALL_CONNECTOR_TARGETS: readonly ConnectorTarget[] = [
  'keycloak',
  'active_directory',
  'entra_id',
  'google_workspace',
  'echo',
  'mail_server',
  'scim_slack',
  'scim_zoom',
  'scim_atlassian',
  'scim_box',
  'scim_snowflake',
  'scim_generic',
  'keycloak_sso',
]

/**
 * Mirrors `DIRECTORY_TARGETS` (apps/api/src/connectors/connector.ts) — the
 * targets that carry USERS. `keycloak_sso` registers OIDC applications, so
 * it has no user attributes to map; the attribute mapping editor iterates
 * this list while the target list and dead-letter filter keep the full
 * catalog.
 */
export const DIRECTORY_TARGETS: readonly ConnectorTarget[] = ALL_CONNECTOR_TARGETS.filter(
  (target) => target !== 'keycloak_sso',
)

export const CONNECTOR_TARGET_LABEL: Record<ConnectorTarget, string> = {
  keycloak: 'Keycloak',
  active_directory: 'Active Directory',
  entra_id: 'Entra ID',
  google_workspace: 'Google Workspace',
  echo: 'Echo (in-repo test target)',
  mail_server: 'Mail server',
  // Six SCIM 2.0 slots, one adapter class. The label names the APPLICATION,
  // not the protocol — an operator configures "Slack", not "SCIM slot 1".
  scim_slack: 'Slack (SCIM)',
  scim_zoom: 'Zoom (SCIM)',
  scim_atlassian: 'Atlassian (SCIM)',
  scim_box: 'Box (SCIM)',
  scim_snowflake: 'Snowflake (SCIM)',
  scim_generic: 'Generic SCIM 2.0',
  keycloak_sso: 'Keycloak (SSO applications)',
}

/** Mirrors `CoreProfileField` (apps/api/src/connectors/attribute-mapping.ts). */
export type CoreProfileField = 'given_name' | 'surname' | 'title' | 'department'

export const ALL_CORE_FIELDS: readonly CoreProfileField[] = ['given_name', 'surname', 'title', 'department']

export const CORE_FIELD_LABEL: Record<CoreProfileField, string> = {
  given_name: 'Given name',
  surname: 'Surname',
  title: 'Title',
  department: 'Department (current org unit)',
}

/** Mirrors `ConnectorHealthStatus` (apps/api/src/connectors/connector-targets.controller.ts) — five distinct states, not a boolean. See that type's own doc comment for why `never_synced` is neither `healthy` nor an error. */
export type ConnectorHealthStatus = 'not_configured' | 'disabled' | 'failing' | 'never_synced' | 'healthy'

/** Mirrors `ConnectorTargetSummary`. */
export interface ConnectorTargetSummary {
  /** Per-organization connector targets: which organization's row this summary describes — (organization_id, target) is the table's identity. */
  organizationId: string
  target: ConnectorTarget
  /** Whether a `connector_targets` row exists at all — distinct from `enabled`: a target can be configured and deliberately switched off. */
  configured: boolean
  enabled: boolean
  /** Non-secret only — a secret's NAME may appear here (e.g. `credentialSecretName`), never a value. See docs/product-brief.md and docs/design-system.md's own instruction: state plainly where a value comes from, never imply it is stored here. */
  config: Record<string, unknown>
  blastRadiusThreshold: number
  blastRadiusFloor: number
  healthStatus: ConnectorHealthStatus
  healthDetail: string | null
  lastSuccessfulSyncAt: string | null
}

/**
 * `organizationId` omitted means MASTER — the platform operator's own
 * catalog, exactly what every call here meant before organizations owned
 * their own rows (per-organization connector targets: `connector_targets`'
 * identity is (organization_id, target)).
 */
export function fetchConnectorTargets(
  accessToken: string,
  organizationId?: string,
): Promise<ConnectorTargetSummary[]> {
  return authorizedRequest<ConnectorTargetSummary[]>(
    `/connector-targets${buildQuery({ organizationId })}`,
    accessToken,
  )
}

export function fetchConnectorTarget(
  accessToken: string,
  target: ConnectorTarget,
  organizationId?: string,
): Promise<ConnectorTargetSummary> {
  return authorizedRequest<ConnectorTargetSummary>(
    `/connector-targets/${target}${buildQuery({ organizationId })}`,
    accessToken,
  )
}

/** A `config` patch value: a present scalar SETS that key; `null` DELETES it from the stored config (a merge, never a wholesale replace — see ConnectorTargetsRepository.upsert's own doc comment). */
export type ConfigPatchValue = string | boolean | null

export interface ConnectorTargetPatch {
  enabled?: boolean
  config?: Record<string, ConfigPatchValue>
  blastRadiusThreshold?: number
  blastRadiusFloor?: number
}

export function updateConnectorTarget(
  accessToken: string,
  target: ConnectorTarget,
  patch: ConnectorTargetPatch,
  organizationId?: string,
): Promise<ConnectorTargetSummary> {
  return authorizedRequest<ConnectorTargetSummary>(
    `/connector-targets/${target}${buildQuery({ organizationId })}`,
    accessToken,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
  )
}

/** Mirrors `ConnectorOperationKind`/`ConnectorOperation` (connectors/connector.ts). */
export interface ConnectorOperation {
  kind: 'create' | 'update' | 'disable'
  description: string
}

export interface PlannedPrincipal {
  userId: string
  username: string
  operations: ConnectorOperation[]
}

export interface PlannedGroup {
  groupId: string
  name: string
  operations: ConnectorOperation[]
}

export interface FailedPrincipal {
  userId: string
  username: string
  error: string
}

export interface FailedGroup {
  groupId: string
  name: string
  error: string
}

export interface BlastRadiusEvaluation {
  tripped: boolean
  changedCount: number
  populationSize: number
  thresholdPercent: number
  floor: number
}

/** Mirrors `TargetReconciliationReport` (outbox/target-reconciliation.job.ts) exactly. */
export interface TargetReconciliationReport {
  /** The organization whose catalog and population this run covered. */
  organizationId: string
  target: ConnectorTarget
  populationSize: number
  toMutate: PlannedPrincipal[]
  toMutateGroups: PlannedGroup[]
  blastRadius: BlastRadiusEvaluation
  dryRun: boolean
  halted: boolean
  overridden: boolean
  appliedCount: number
  appliedGroupCount: number
  failed: FailedPrincipal[]
  failedGroups: FailedGroup[]
}

export interface ReconcileOptions {
  dryRun: boolean
  force?: boolean
}

/**
 * `POST /connector-targets/:target/reconcile` — "same safety-rail idiom as
 * the import preview" (this task's own BUILD section). `dryRun: true` writes
 * nothing anywhere on the server, proven by
 * apps/api/test/connector-targets.controller.spec.ts and this console's own
 * Playwright E2E; `dryRun: false` is a real apply, itself still guarded by
 * the target's blast-radius threshold/floor unless `force` is set.
 */
export function runReconcile(
  accessToken: string,
  target: ConnectorTarget,
  options: ReconcileOptions,
  organizationId?: string,
): Promise<TargetReconciliationReport> {
  return authorizedRequest<TargetReconciliationReport>(
    `/connector-targets/${target}/reconcile${buildQuery({ organizationId })}`,
    accessToken,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    },
  )
}

// ---------------------------------------------------------------------------
// Attribute target mappings — the editor over `attribute_target_mappings`.
// ---------------------------------------------------------------------------

/** Mirrors `AttributeTargetMappingRow` (apps/api/src/attributes/attribute-target-mappings.repository.ts). */
export interface AttributeTargetMappingRow {
  id: string
  source: 'custom' | 'core'
  attributeDefinitionId: string | null
  coreField: CoreProfileField | null
  localKey: string
  label: string | null
  target: ConnectorTarget
  remoteName: string
  enabled: boolean
}

export function fetchAttributeTargetMappings(accessToken: string): Promise<AttributeTargetMappingRow[]> {
  return authorizedRequest<AttributeTargetMappingRow[]>('/attribute-target-mappings', accessToken)
}

export interface CreateMappingInput {
  attributeDefinitionId?: string
  coreField?: CoreProfileField
  target: ConnectorTarget
  remoteName: string
  enabled?: boolean
  /**
   * The export impact the caller was shown, echoed back.
   *
   * REQUIRED by the API whenever this write would leave the mapping enabled
   * over a non-empty population — a missing one is a 400 naming the real
   * number, a stale one a 409. The API re-derives it inside the writing
   * transaction, so this console neither computes nor caches it: it shows the
   * number the API gave it and hands the same number back.
   */
  acknowledgedExportCount?: number
}

export function createAttributeTargetMapping(
  accessToken: string,
  input: CreateMappingInput,
): Promise<AttributeTargetMappingRow> {
  return authorizedRequest<AttributeTargetMappingRow>('/attribute-target-mappings', accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export interface UpdateMappingInput {
  remoteName?: string
  enabled?: boolean
  /**
   * The export impact the caller was shown, echoed back.
   *
   * REQUIRED by the API whenever this write would leave the mapping enabled
   * over a non-empty population — a missing one is a 400 naming the real
   * number, a stale one a 409. The API re-derives it inside the writing
   * transaction, so this console neither computes nor caches it: it shows the
   * number the API gave it and hands the same number back.
   */
  acknowledgedExportCount?: number
}

export function updateAttributeTargetMapping(
  accessToken: string,
  id: string,
  patch: UpdateMappingInput,
): Promise<AttributeTargetMappingRow> {
  return authorizedRequest<AttributeTargetMappingRow>(`/attribute-target-mappings/${id}`, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/**
 * What enabling a mapping would newly export — security finding 5.
 *
 * `holderCount` is scoped to organizations that actually have the target
 * enabled, so it is the number of people whose values genuinely leave, not a
 * directory-wide over-estimate. `sensitive` says the audit log is forbidden
 * to record those values, which makes the export unrecoverable from the log
 * afterwards.
 */
export interface ExportImpact {
  target: ConnectorTarget
  holderCount: number
  sensitive: boolean
}

export function fetchExportImpact(
  accessToken: string,
  query: { target: ConnectorTarget; attributeDefinitionId?: string; coreField?: CoreProfileField },
): Promise<ExportImpact> {
  return authorizedRequest<ExportImpact>(
    `/attribute-target-mappings/export-impact${buildQuery({
      target: query.target,
      attributeDefinitionId: query.attributeDefinitionId,
      coreField: query.coreField,
    })}`,
    accessToken,
  )
}

export function deleteAttributeTargetMapping(accessToken: string, id: string): Promise<{ deleted: true }> {
  return authorizedRequest<{ deleted: true }>(`/attribute-target-mappings/${id}`, accessToken, { method: 'DELETE' })
}
