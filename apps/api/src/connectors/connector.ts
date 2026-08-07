// The canonical "which directory backend" literal union — hand-rolled to
// mirror the `outbox_target` pgEnum (db/schema/outbox-events.ts), same
// convention as `OutboxAggregateType`/`OutboxEventType` (outbox.writer.ts)
// rather than a `(typeof outboxTarget.enumValues)[number]` derivation.
// `connectors/` is the canonical HOME for this type — `outbox.writer.ts`'s
// own `OutboxTarget` is a re-export of it (`export type OutboxTarget =
// ConnectorTarget`), not the other way around: the outbox is a caller of
// the connector spine (SyncWorker dispatches per-target through
// `ConnectorRegistry`), so it depends on this module, never the reverse.
// Keeping ONE canonical type — imported everywhere a target name is needed —
// instead of two independently hand-rolled unions is what makes
// `external_identities.system` assignable directly from `event.target` with
// no mapping table (see ConnectorRegistry/sync.worker.ts).
export type ConnectorTarget = 'keycloak' | 'active_directory' | 'entra_id' | 'google_workspace' | 'echo'

/**
 * A directory backend's DESIRED state for one user, already resolved to
 * plain data — no connector implementation ever reads Postgres itself (see
 * `DirectoryConnector`'s own doc comment on why). Deliberately target-
 * agnostic: `username`/`email`/`firstName`/`lastName`/`enabled` are the core
 * IDENTITY fields every real target (AD, Entra, Google) and the in-repo echo
 * target all understand, and are never subject to default-deny — you cannot
 * create a directory account with no name at all, the same reason `email`/
 * `username` have never been gated either. `attributes` is ALREADY filtered
 * to only the keys that should propagate, PER THIS EVENT'S OWN TARGET —
 * `SyncWorker.reconcileUser` computes this once, via
 * `connectors/attribute-mapping.ts`'s `buildTargetAttributes`, against
 * `attribute_target_mappings` (Milestone 10, Task 3) — covering both custom,
 * admin-configured attributes AND the four core PROFILE fields (given name,
 * surname, title, department) that a target may additionally want under its
 * own remote name; a local field absent from THIS target's mapping rows
 * never appears here, structurally, regardless of what any other target
 * receives. `groups` is the flattened
 * EFFECTIVE membership (already resolved from the nested local DAG — see
 * SyncWorker.syncEffectiveGroups' doc comment), as group NAMES: each
 * connector maps that onto its own target's representation of membership
 * (Keycloak: ensureGroup + setUserGroups; echo: recorded verbatim).
 */
export interface DesiredUser {
  username: string
  email: string
  firstName: string
  lastName: string
  enabled: boolean
  attributes: Record<string, string[]>
  groups: readonly string[]
}

export type ConnectorOperationKind = 'create' | 'update' | 'disable'

/** One line of a `plan()` result — human-legible, never itself applied (see `DirectoryConnector.plan`). */
export interface ConnectorOperation {
  kind: ConnectorOperationKind
  description: string
}

/**
 * `health()`'s answer — "can we reach and authenticate to this target right
 * now," per the connector interface's own contract. `detail` is always
 * SAFE to log/return as-is: every connector implementation in this codebase
 * builds it from a secret's NAME (when relevant) or a target's own error
 * response, never a resolved secret VALUE — see connectors/secrets.ts's
 * `resolveSecret`/`MissingSecretError`, which is the only place a credential
 * value is ever read out of `process.env`, and never surfaces it in a thrown
 * message.
 */
export interface ConnectorHealth {
  ok: boolean
  detail: string
}

/**
 * The one interface every directory backend implements — plan / apply /
 * disable / health, exactly four methods, nothing else. Settled by
 * docs/superpowers/specs/2026-08-06-directory-connectors-design.md and
 * docs/superpowers/plans/2026-08-06-idp-milestones-10-14-directory-
 * connectors.md (Milestone 10, Task 2). Implemented today by
 * `KeycloakConnector` (keycloak.connector.ts — wraps the pre-existing
 * `KeycloakAdminClient` so Keycloak becomes a connector-shaped participant
 * WITHOUT changing what it does) and `EchoConnector` (echo.connector.ts —
 * proves the spine end-to-end with no vendor protocol involved). Registered
 * target -> connector in `ConnectorRegistry` (connector-registry.ts).
 *
 * THERE IS DELIBERATELY NO `delete`. Decision 3 (design doc): this system
 * has no delete for users, and neither does any connector — a leaver is
 * DISABLED in the target, never removed. Do not add a `delete`, an escape
 * hatch that amounts to one, or a `hard`/`force` flag on `disable` — a
 * connector bug that disables is recoverable; one that deletes is not, and
 * removing the CAPABILITY is what removes the whole class of disaster, not
 * a convention to remember to follow.
 *
 * CONNECTION DISCIPLINE: no implementation of this interface may open its
 * own database connection, ever — every one of these methods is reachable
 * from INSIDE `SyncWorker`'s own open transaction (`reconcileUser`, itself
 * always inside the worker's claim transaction or a nested savepoint — see
 * sync.worker.ts's own doc comments), so a connector reaching for a second
 * pool connection here would reproduce the exact pool-exhaustion deadlock
 * finding C1 (docs/superpowers/audit-integrity.md) fixed elsewhere —
 * regression-guarded there by test/pool-exhaustion.spec.ts. Whatever a
 * connector needs is either passed in `desired`/`externalId`, or bound into
 * the connector instance BEFORE any of these methods is ever called — see
 * `ConnectorRegistry.resolve`, which does the one Postgres read every
 * connector needs (`connector_targets.config`) via the CALLER's own `tx`,
 * and hands back an already-configured connector. Reading `process.env` from
 * inside any of these four methods is fine (and expected, for secret
 * resolution — connectors/secrets.ts) — it is a second POOL CONNECTION that
 * is forbidden, not synchronous, in-memory environment access.
 *
 * NEVER SENDS A USER CREDENTIAL. No method here — on any implementation —
 * may generate, transmit or store a password, temporary password, or
 * credential array for the PERSON the desired state describes. (Google
 * Workspace's own service-account JWT is a SEPARATE, service-level secret,
 * resolved the same way as every other connector's — see secrets.ts; the
 * one-time, retain-nothing generated password Milestone 13 documents for
 * Google user CREATION is that adapter's own narrow, explicitly-documented
 * exception, not something this interface or Task 2's connectors do.)
 */
export interface DirectoryConnector {
  /** The operations `apply(desired)` WOULD run, writing nothing to the target. Every connector is dry-runnable (design doc decision 7). */
  plan(desired: DesiredUser): Promise<ConnectorOperation[]>

  /**
   * Asserts the WHOLE desired state — never a delta (same reconcile-to-
   * desired-state rule the pre-existing Keycloak worker already followed;
   * design doc decision 2) — and returns the target's own IMMUTABLE id for
   * this principal (AD `objectGUID`, Entra `id`, Google `id`, Keycloak `id`,
   * echo's own synthetic id). Must be atomic in the sense that matters here:
   * if this throws (including a missing secret — see MissingSecretError), it
   * must not have partially applied any part of `desired` first. The
   * returned id is what the caller correlates into `external_identities` —
   * never a DN, never an email; both move when a person is renamed or
   * transferred.
   */
  apply(desired: DesiredUser): Promise<{ externalId: string }>

  /**
   * The ONLY removal-shaped operation that exists, per decision 3. Takes
   * ONLY the target's own immutable id — no user data needed, so it remains
   * callable even when the rest of `desired` is unavailable or invalid,
   * which is exactly what makes it a safe, minimal, easy-to-audit LAST
   * resort. Must never delete, and must never be given a way to.
   */
  disable(externalId: string): Promise<void>

  /** Can we reach and authenticate to this target RIGHT NOW. Never throws — a target whose secret is missing from the environment resolves to `{ ok: false, detail: <actionable, secret-VALUE-free message> }`, not a thrown error. */
  health(): Promise<ConnectorHealth>
}
