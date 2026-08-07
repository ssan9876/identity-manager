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

  /**
   * Milestone 11, Task 5 — the user's current org unit, as ltree LABEL
   * segments root-to-leaf (e.g. `['engineering', 'backend_team']` — see
   * `OrgUnitsRepository`'s own doc comment for the label alphabet:
   * `[a-z0-9_]+`, ASCII-safe by construction, never needing DN-escaping).
   * OPTIONAL and `undefined` for any target that has no structural concept
   * of nested containment — populated by `SyncWorker.buildDesiredUser` ONLY
   * for `target === 'active_directory'` today (see that method's own doc
   * comment for why this is a narrow, target-gated fetch rather than
   * unconditional — the identical "extra round trip only when a target
   * actually needs it" reasoning `orgUnit`'s own lazy core-field fetch
   * already established in Milestone 10, Task 3). AD's own OU tree is the
   * first, and so far only, consumer: `ActiveDirectoryConnector` maps this
   * onto a nested `OU=...,OU=...,<baseDN>` placement — see that connector's
   * own doc comment. A target that ignores this field (Keycloak, echo) is
   * unaffected: TypeScript structural typing means an implementation never
   * has to acknowledge a field it does not read.
   */
  orgUnitPath?: readonly string[]

  /**
   * Milestone 11, Task 5 — this user's PREVIOUSLY-correlated immutable id
   * for THIS SAME target, if `external_identities` already has a row for
   * (user, target) — i.e. what a past successful `apply()` returned as
   * `externalId`. `apply(desired)` deliberately takes no `externalId`
   * parameter of its own (Milestone 10, Task 2 — settled interface), so a
   * connector that wants to re-identify "is this a known principal" by an
   * IMMUTABLE key rather than a mutable one (decision: "Correlate on
   * objectGUID... never the DN, never sAMAccountName, never mail — all
   * three move") has nowhere else to receive it from. OPTIONAL and
   * `undefined` when no prior correlation exists (first-ever sync) or for a
   * target that has not opted in to the extra read (see `orgUnitPath`'s own
   * doc comment — populated under the identical `target === 'active_directory'`
   * gate, for the identical latency reason). `ActiveDirectoryConnector` uses
   * this to find an existing entry by `objectGUID` FIRST, falling back to
   * `sAMAccountName` only when this is absent — so a local username change
   * still resolves to the SAME AD object instead of minting a duplicate.
   * Keycloak/echo ignore it; both already correlate by username, which
   * Milestone 10 accepted as sufficient for those targets (their own ids are
   * not subject to the "DN/sAMAccountName/mail all move" hazard AD has).
   */
  existingExternalId?: string

  /**
   * Milestone 11, Task 5 — every REMOTE name (custom and core alike) that
   * has an ENABLED `attribute_target_mappings` row for THIS target right
   * now — i.e. `mappings.map(m => remoteName)`, the same `mappings` array
   * `attributes` above was already built from (`buildTargetAttributes`).
   * OPTIONAL, populated under the identical `target === 'active_directory'`
   * gate as `orgUnitPath`/`existingExternalId` (see either's own doc
   * comment for the latency reasoning).
   *
   * WHY THIS EXISTS, when `attributes` already carries every value that
   * SHOULD propagate: LDAP's `modify` operation only touches attribute
   * NAMES explicitly named in the request — unlike Keycloak's Admin REST
   * API, where sending the whole `attributes` map REPLACES the stored map
   * wholesale, so simply omitting a key already clears it there. Over LDAP,
   * omitting a key from a `modify` leaves whatever AD already has for that
   * name COMPLETELY UNTOUCHED — so the moment an admin disables a mapping
   * (or a value goes from set to empty), `attributes` correctly stops
   * carrying it, but nothing tells the connector a REMOTE name that used to
   * be managed now needs to be ACTIVELY CLEARED rather than merely not
   * re-sent. `ActiveDirectoryConnector.apply` diffs THIS set against
   * `attributes`' own keys to find exactly that gap and clears it — see
   * that method's own doc comment. Keycloak/echo need no such thing (their
   * own "send the whole map" semantics already self-clear) and ignore this
   * field entirely.
   */
  managedAttributeRemoteNames?: readonly string[]
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
