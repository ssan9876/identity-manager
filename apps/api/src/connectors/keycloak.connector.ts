import {
  type KeycloakAdminClient,
  type SyncableAttributeDefinition,
} from '../keycloak/keycloak-admin.client'
import type {
  ConnectorHealth,
  ConnectorOperation,
  DesiredUser,
  DirectoryConnector,
} from './connector'

/** Order-independent equality on two `Record<string, string[]>` attribute maps — same shape `ReconciliationJob`'s own (private) `attributesEqual` already checks, re-derived locally rather than imported: `connectors/` stays independent of `outbox/reconciliation.job.ts`, a higher-level orchestration module (see `DbHandle`'s own doc comment, outbox.writer.ts, for the identical "sibling modules, each narrows the same way" reasoning). */
function attributesEqual(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  const aKeys = Object.keys(a).sort()
  const bKeys = Object.keys(b).sort()
  if (aKeys.length !== bKeys.length || aKeys.some((key, i) => key !== bKeys[i])) {
    return false
  }
  return aKeys.every((key) => {
    const av = [...(a[key] ?? [])].sort()
    const bv = [...(b[key] ?? [])].sort()
    return av.length === bv.length && av.every((value, i) => value === bv[i])
  })
}

function sameNameSet(a: Iterable<string>, b: Iterable<string>): boolean {
  const setA = new Set(a)
  const setB = new Set(b)
  return setA.size === setB.size && [...setA].every((name) => setB.has(name))
}

/**
 * Keycloak, wrapped as a connector-shaped participant — "Keycloak becomes a
 * connector-shaped participant without changing what it does" (Task 2's own
 * non-negotiable). `apply` reproduces, byte-for-byte, the SAME sequence of
 * `KeycloakAdminClient` calls `SyncWorker.reconcileUser`/`syncEffectiveGroups`
 * made directly before this task: find-by-username, then either `createUser`
 * or (`updateUser` + `setEnabled`), then `ensureGroup` per desired group name
 * followed by one `setUserGroups`. `SyncWorker` now builds `DesiredUser` and
 * calls THIS instead of `KeycloakAdminClient` directly — see sync.worker.ts's
 * `reconcileUser` — so the observable REST traffic against a real Keycloak is
 * unchanged; only where the sequence lives has moved.
 *
 * ATTRIBUTE FILTERING: `desired.attributes` arrives ALREADY filtered to
 * exactly this target's (`'keycloak'`) enabled `attribute_target_mappings`
 * rows (`SyncWorker` computes it once, via `connectors/attribute-mapping.ts`'s
 * `buildTargetAttributes`, before calling ANY connector — see `DesiredUser`'s
 * own doc comment). Migration 0014 seeded Keycloak's rows to reproduce
 * exactly the pre-Task-3 `sync_to_keycloak = true` set, under the SAME key
 * as `remote_name` — so this connector still receives exactly what it always
 * did; no `given_name`/`surname`/`title`/`department` core-field row is
 * seeded for `'keycloak'` (see that migration's own comment), so none of
 * those four ever appear in this bag either — `given_name`/`surname` reach
 * Keycloak only via `desired.firstName`/`lastName` below, unconditionally,
 * exactly as before this task. `KeycloakAdminClient.createUser`/
 * `updateUser` still take a `definitions: SyncableAttributeDefinition[]`
 * parameter and re-run that SAME filter internally (their own, unrelated,
 * pre-existing contract — unchanged, so their own extensive existing test
 * coverage keeps proving what it always proved). Re-filtering an
 * already-filtered set with a PASSTHROUGH definitions list (every key in
 * `desired.attributes` marked syncable, nothing else) is a no-op: every key
 * present already passed the real filter once, and every value is already a
 * `string[]`, so the internal `Array.isArray(value) ? value.map(String) :
 * ...` transform is the identity. This is what lets `KeycloakAdminClient`'s
 * own public methods stay completely untouched by this task — no new "raw,
 * pre-filtered" method needed on that class.
 */
export class KeycloakConnector implements DirectoryConnector {
  constructor(private readonly client: KeycloakAdminClient) {}

  async plan(desired: DesiredUser): Promise<ConnectorOperation[]> {
    const existing = await this.client.findUserByUsername(desired.username)
    if (existing === null) {
      return [
        {
          kind: 'create',
          description: `create Keycloak user "${desired.username}" (enabled=${desired.enabled})`,
        },
      ]
    }

    const ops: ConnectorOperation[] = []
    const profileChanged =
      (existing.email ?? '') !== desired.email ||
      (existing.firstName ?? '') !== desired.firstName ||
      (existing.lastName ?? '') !== desired.lastName ||
      !attributesEqual(existing.attributes, desired.attributes)
    if (profileChanged) {
      ops.push({
        kind: 'update',
        description: `update Keycloak user "${desired.username}" profile/attributes`,
      })
    }
    if (existing.enabled !== desired.enabled) {
      ops.push({
        kind: desired.enabled ? 'update' : 'disable',
        description: `set Keycloak user "${desired.username}" enabled=${desired.enabled}`,
      })
    }

    const currentGroups = await this.client.listUserGroups(desired.username)
    if (!sameNameSet(currentGroups.map((group) => group.name), desired.groups)) {
      ops.push({
        kind: 'update',
        description: `reconcile Keycloak group membership for "${desired.username}"`,
      })
    }

    return ops
  }

  async apply(desired: DesiredUser): Promise<{ externalId: string }> {
    // Every key already passed the real default-deny filter once (see this
    // class's own doc comment) — this list only re-affirms that to satisfy
    // `createUser`/`updateUser`'s pre-existing, unrelated `definitions`
    // parameter, never re-deciding what is allowed to sync.
    const passthroughDefinitions: SyncableAttributeDefinition[] = Object.keys(desired.attributes).map(
      (key) => ({ key, syncToKeycloak: true }),
    )

    const existing = await this.client.findUserByUsername(desired.username)
    let externalId: string
    if (existing === null) {
      const created = await this.client.createUser(
        {
          username: desired.username,
          email: desired.email,
          firstName: desired.firstName,
          lastName: desired.lastName,
          enabled: desired.enabled,
          attributes: desired.attributes,
        },
        passthroughDefinitions,
      )
      externalId = created.id
    } else {
      await this.client.updateUser(
        desired.username,
        {
          email: desired.email,
          firstName: desired.firstName,
          lastName: desired.lastName,
          attributes: desired.attributes,
        },
        passthroughDefinitions,
      )
      // Excluded from updateUser on purpose (see that method's own doc
      // comment) — asserted separately so it converges independently,
      // exactly matching pre-Task-2 `reconcileUser`.
      await this.client.setEnabled(desired.username, desired.enabled)
      externalId = existing.id
    }

    const groupIds: string[] = []
    for (const name of desired.groups) {
      const group = await this.client.ensureGroup(name)
      groupIds.push(group.id)
    }
    await this.client.setUserGroups(desired.username, groupIds)

    return { externalId }
  }

  /** Keycloak's disable is `enabled: false`, set by the immutable Keycloak id `disable` is given — never a delete, never re-asserting the rest of the profile (see `KeycloakAdminClient.setEnabledById`'s own doc comment on why this is a second, independent method rather than a refactor of `setEnabled`). */
  async disable(externalId: string): Promise<void> {
    await this.client.setEnabledById(externalId, false)
  }

  async health(): Promise<ConnectorHealth> {
    return this.client.health()
  }
}
