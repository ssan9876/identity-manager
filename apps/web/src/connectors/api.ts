import { authorizedRequest } from '../api/client'

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
 * whenever a target is added. Check it whenever `outbox_target` grows.
 */
export type ConnectorTarget =
  | 'keycloak'
  | 'active_directory'
  | 'entra_id'
  | 'google_workspace'
  | 'echo'
  | 'mail_server'
  | 'keycloak_sso'

export const ALL_CONNECTOR_TARGETS: readonly ConnectorTarget[] = [
  'keycloak',
  'active_directory',
  'entra_id',
  'google_workspace',
  'echo',
  'mail_server',
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

export function fetchConnectorTargets(accessToken: string): Promise<ConnectorTargetSummary[]> {
  return authorizedRequest<ConnectorTargetSummary[]>('/connector-targets', accessToken)
}

export function fetchConnectorTarget(accessToken: string, target: ConnectorTarget): Promise<ConnectorTargetSummary> {
  return authorizedRequest<ConnectorTargetSummary>(`/connector-targets/${target}`, accessToken)
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
): Promise<ConnectorTargetSummary> {
  return authorizedRequest<ConnectorTargetSummary>(`/connector-targets/${target}`, accessToken, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
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
): Promise<TargetReconciliationReport> {
  return authorizedRequest<TargetReconciliationReport>(`/connector-targets/${target}/reconcile`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  })
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

export function deleteAttributeTargetMapping(accessToken: string, id: string): Promise<{ deleted: true }> {
  return authorizedRequest<{ deleted: true }>(`/attribute-target-mappings/${id}`, accessToken, { method: 'DELETE' })
}
