import type { UserStatus } from '../users/users.repository'

// The canonical "which directory backend" catalog, mirroring the
// `outbox_target` pgEnum (db/schema/outbox-events.ts). Kept as its own
// literal — rather than a `(typeof outboxTarget.enumValues)[number]`
// derivation — so `connectors/` does not depend on `db/schema/`; the
// equivalence is asserted at runtime instead, in both directions, by
// test/connector-target-catalog.spec.ts.
// `connectors/` is the canonical HOME for this type — `outbox.writer.ts`'s
// own `OutboxTarget` is a re-export of it (`export type OutboxTarget =
// ConnectorTarget`), not the other way around: the outbox is a caller of
// the connector spine (SyncWorker dispatches per-target through
// `ConnectorRegistry`), so it depends on this module, never the reverse.
// Keeping ONE canonical type — imported everywhere a target name is needed —
// instead of two independently hand-rolled unions is what makes
// `external_identities.system` assignable directly from `event.target` with
// no mapping table (see ConnectorRegistry/sync.worker.ts).
//
// SINGLE SOURCE OF TRUTH (security audit, finding "catalog drift"). This was
// a hand-rolled `|` union, and every place that needed the values as a
// RUNTIME array — five of them: two `z.enum` route validators, the console's
// `ALL_CONNECTOR_TARGETS`, the dead-letter target filter, and the reconcile
// CLI — hand-copied the same five literals. Adding `mail_server` to the union
// therefore left all five stale, and the type system could not see it: a
// narrower literal list is perfectly assignable to a wider union. The
// observable result was a real target that the console could not list,
// configure, enable or DISABLE, that the dead-letter view rejected as an
// unknown filter, and that the reconcile CLI refused to run — i.e. no way to
// turn off a live outbound integration without direct database access.
//
// The array is now the source and the union DERIVES from it, so a new target
// is one edit and every consumer follows. Anything needing the runtime list
// imports `ALL_CONNECTOR_TARGETS` rather than retyping it — do not reintroduce
// a literal list of targets anywhere; `test/connector-target-catalog.spec.ts`
// asserts this array matches the `outbox_target` pgEnum in BOTH directions.
export const ALL_CONNECTOR_TARGETS = [
  'keycloak',
  'active_directory',
  'entra_id',
  'google_workspace',
  'echo',
  'mail_server',
] as const

export type ConnectorTarget = (typeof ALL_CONNECTOR_TARGETS)[number]

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
  /**
   * THIS system's own `users.id` — not a remote id, and not correlated with
   * anything downstream. REQUIRED and always populated, unlike the optional,
   * target-gated fields below: it costs nothing to compute (every caller
   * already holds the loaded user) and an optional field that is in practice
   * always set is a lie about the shape of the data.
   *
   * Exists because a target may address a principal by OUR id rather than by
   * one of its own. `mail_server` is the first: its provisioning API is
   * `PUT /provisioning/identities/{external_id}` where that key IS this
   * uuid, so without this field that connector cannot construct a URL at
   * all. Keying on `username` instead is explicitly rejected by the
   * counterpart's own spec — "keying on external_id rather than the address
   * is what makes renames correct: a changed email becomes a rename of an
   * existing mailbox, not an orphan plus a new empty one" — and `username`
   * is mutable here too, so it carries the identical defect. Targets that
   * correlate by an immutable id of their OWN (AD/Entra/Google, via
   * `existingExternalId` below) simply ignore this.
   */
  userId: string

  username: string
  email: string
  firstName: string
  lastName: string
  enabled: boolean

  /**
   * This user's FULL lifecycle status, for a target whose own model has more
   * than the two states `enabled` can express. OPTIONAL and target-gated,
   * exactly like `orgUnitPath` below: populated for `'mail_server'` only (see
   * sync.worker.ts's `TARGETS_NEEDING_FULL_STATUS`), `undefined` for every
   * other target, and structurally invisible to the connectors that ignore
   * it — no existing connector reads it or has to acknowledge it.
   *
   * `enabled` immediately above cannot stand in for this. It is
   * `status === 'active'`, so `pending`, `suspended` and `deactivated` all
   * collapse into one value — and for the mail target that is DATA LOSS, not
   * merely lost fidelity: only `deactivated` stamps the counterpart's
   * `deactivated_at`, which starts its retention clock. Map `suspended` onto
   * `deactivated` and a suspended employee's mail is eventually purged; map
   * `deactivated` onto `suspended` and offboarded mail never purges at all.
   * The counterpart's spec states the rule directly: "A suspension must never
   * stamp deactivated_at — suspension is not offboarding and must not start
   * the retention clock."
   */
  status?: UserStatus

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
   * Milestone 11, Task 5 (widened to `entra_id` in Milestone 12, Task 7;
   * widened to `google_workspace` in Milestone 13, Task 8) — this user's
   * PREVIOUSLY-correlated immutable id for THIS SAME target, if
   * `external_identities` already has a row for (user, target) — i.e. what a
   * past successful `apply()` returned as `externalId`. `apply(desired)`
   * deliberately takes no `externalId` parameter of its own (Milestone 10,
   * Task 2 — settled interface), so a connector that wants to re-identify "is
   * this a known principal" by an IMMUTABLE key rather than a mutable one
   * (decision: "Correlate on objectGUID/Graph id/Google id... never the
   * DN/UPN, never sAMAccountName, never mail, never the primary email — all
   * move") has nowhere else to receive it from. OPTIONAL and `undefined`
   * when no prior correlation exists (first-ever sync) or for a target that
   * has not opted in to the extra read (see `sync.worker.ts`'s own
   * `TARGETS_NEEDING_IMMUTABLE_ID_CORRELATION` — currently
   * `active_directory`, `entra_id` and `google_workspace`, NOT
   * `orgUnitPath`'s own narrower AD-only gate, since neither Graph nor the
   * Admin SDK has an OU-equivalent concept those two targets need).
   * `ActiveDirectoryConnector` uses this to find an existing entry by
   * `objectGUID` FIRST, falling back to `sAMAccountName` only when this is
   * absent; `EntraIdConnector`/`GoogleWorkspaceConnector` each do the
   * identical thing with their own target's `id` and a
   * `userPrincipalName`/`primaryEmail` bootstrap fallback — so a local
   * username change still resolves to the SAME remote object instead of
   * minting a duplicate. Keycloak/echo ignore it; both already correlate by
   * username, which Milestone 10 accepted as sufficient for those targets
   * (their own ids are not subject to the "immutable-key fields all move"
   * hazard AD/Entra/Google have).
   */
  existingExternalId?: string

  /**
   * Milestone 11, Task 5 (widened to `entra_id` in Milestone 12, Task 7;
   * widened to `google_workspace` in Milestone 13, Task 8) — every REMOTE
   * name (custom and core alike) that has an ENABLED
   * `attribute_target_mappings` row for THIS target right now — i.e.
   * `mappings.map(m => remoteName)`, the same `mappings` array `attributes`
   * above was already built from (`buildTargetAttributes`). OPTIONAL,
   * populated under the SAME `TARGETS_NEEDING_IMMUTABLE_ID_CORRELATION` gate
   * as `existingExternalId` immediately above (see that field's own doc
   * comment for the latency reasoning).
   *
   * WHY THIS EXISTS, when `attributes` already carries every value that
   * SHOULD propagate: a PARTIAL-UPDATE write operation only touches
   * property/attribute NAMES explicitly named in the request — unlike
   * Keycloak's Admin REST API, where sending the whole `attributes` map
   * REPLACES the stored map wholesale, so simply omitting a key already
   * clears it there. LDAP's `modify` (AD), Microsoft Graph's `PATCH` (Entra
   * — confirmed directly against
   * https://learn.microsoft.com/en-us/graph/api/user-update's own "Request
   * body" text: "Existing properties that aren't included in the request
   * body maintain their previous values"), AND the Admin SDK Directory
   * API's `users.update` (Google — confirmed directly against
   * https://developers.google.com/admin-sdk/directory/reference/rest/v1/users/update's
   * own text: "you only need to include the fields you wish to update...
   * fields set to null will be cleared") ALL share this gap: omitting a key
   * leaves whatever the target already has for that name COMPLETELY
   * UNTOUCHED — so the moment an admin disables a mapping (or a value goes
   * from set to empty), `attributes` correctly stops carrying it, but
   * nothing tells the connector a REMOTE name that used to be managed now
   * needs to be ACTIVELY CLEARED rather than merely not re-sent.
   * `ActiveDirectoryConnector.apply`/`EntraIdConnector.apply`/
   * `GoogleWorkspaceConnector.apply` each diff THIS set against
   * `attributes`' own keys to find exactly that gap and clear it (AD: an
   * explicit empty-values `replace`; Entra/Google: an explicit `null`, per
   * each target's own documented clearing convention — both confirmed
   * independently, not assumed to match just because the shape rhymes).
   * Keycloak/echo need no such thing (their own "send the whole map"
   * semantics already self-clear) and ignore this field entirely.
   */
  managedAttributeRemoteNames?: readonly string[]
}

/**
 * Thrown by `DirectoryConnector.apply` when this connector has NOTHING to
 * represent for this principal — not a failure, and not something to retry.
 *
 * `apply()` returns `{ externalId: string }` with no null case, and
 * `external_identities.external_id` is `NOT NULL`, so there is otherwise
 * nowhere to express "did nothing, correlate nothing". `SyncWorker.
 * reconcileUser` catches this, skips the correlation upsert, and lets the
 * event complete normally.
 *
 * Deliberately NOT modelled as widening `apply()`'s return to `| null`: that
 * would force every connector to acknowledge a case exactly one of them has,
 * against the "do not casually widen a settled interface" discipline
 * `DirectoryConnector`'s own doc comment records. And deliberately NOT
 * modelled as a check hoisted up into `SyncWorker`: eligibility is a
 * property of a TARGET, decided at apply time. Deciding it at EMISSION time
 * instead is a correctness bug — a user who becomes ineligible would then
 * emit no event at all, and their downstream account would live forever.
 */
export class NotApplicableError extends Error {
  constructor(
    readonly target: ConnectorTarget,
    readonly reason: string,
  ) {
    super(`${target}: nothing to apply for this principal — ${reason}`)
    this.name = 'NotApplicableError'
  }
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
/**
 * Milestone 11, Task 6 — one directory backend's DESIRED state for one
 * GROUP's own identity and DIRECT membership edges. Separate from
 * `DesiredUser.groups` (the flattened EFFECTIVE membership a user asserts
 * about itself — see that field's own doc comment) on purpose: `.groups` has
 * ALREADY discarded every bit of nesting structure by the time a connector
 * ever sees it (`SyncWorker.effectiveGroupNames` walks the full ancestor
 * closure), so a connector that only ever consumed it could never represent
 * AD's own native group-in-group nesting — only ever a flat, Keycloak-style
 * membership. `DesiredGroup` is what makes native nesting possible: it
 * carries this ONE group's DIRECT edges only, so a connector can choose,
 * PER EDGE, whether to write a native nested reference or a flattened
 * stand-in — see `ActiveDirectoryConnector`'s own "nesting decision" doc
 * comment for the exact rule this system settled on.
 */
export interface DesiredGroup {
  name: string
  /**
   * Every principal (user OR group, indiscriminately — LDAP's `member`
   * attribute does not care) that should be a DIRECT member of this group,
   * expressed as THAT PRINCIPAL'S OWN already-correlated immutable id for
   * this same target (never a DN, never a name — both move; same rule
   * `DesiredUser.existingExternalId` follows). Computed by `SyncWorker.
   * buildDesiredGroupMemberExternalIds` (sync.worker.ts) by mixing two kinds
   * of source, per direct local edge:
   *  - a direct CHILD-GROUP edge whose child already has a correlated id
   *    for this target contributes THAT CHILD'S OWN id — this is what a
   *    connector turns into a genuine nested group-in-group reference
   *    (native nesting).
   *  - a direct CHILD-GROUP edge whose child has NO correlated id yet (never
   *    synced to this target) contributes that child's current EFFECTIVE
   *    USER ids instead (however many of THOSE happen to already be
   *    correlated) — a flattened stand-in that keeps this group's own
   *    membership complete and correct in the meantime, self-healing into a
   *    real nested edge the moment the child itself finishes syncing (the
   *    very next reconcile pass, since desired state is always recomputed
   *    fresh — never a one-time upgrade this system has to remember to do).
   *  - a direct USER edge contributes that user's own correlated id, or
   *    nothing at all if that user has not yet synced either (same
   *    self-healing reasoning).
   * A principal that never resolves (a stale id AD no longer recognises —
   * should not happen, since neither side of this system ever deletes) is
   * simply skipped by the connector rather than failing the whole group.
   */
  memberExternalIds: readonly string[]
  /** Same purpose as `DesiredUser.existingExternalId` — this group's PREVIOUSLY-correlated immutable id for this target, if any, letting a connector re-identify it by immutable id instead of falling back to its (mutable) name. */
  existingExternalId?: string
}

/**
 * Milestone 11, Task 6 — group-shaped sync, ADDITIVE and ORTHOGONAL to
 * `DirectoryConnector`'s four settled, user-shaped methods (unchanged, never
 * widened — see that interface's own doc comment on why there is
 * deliberately no `delete`; the same "do not casually widen a settled
 * interface" discipline applies here, which is why this is a SEPARATE
 * interface rather than two more methods bolted onto `DirectoryConnector`).
 *
 * OPTIONAL: a target implements this ONLY when it has a genuine native
 * group-nesting concept worth preserving, or (Milestone 13, Task 8) a
 * strong reason to stand in for one in tests. `KeycloakConnector`/
 * `EntraIdConnector`/`GoogleWorkspaceConnector` do NOT implement it — their
 * own group membership is already fully expressed through `DesiredUser.
 * groups` inside `apply()` (Keycloak: `ensureGroup` + `setUserGroups`;
 * Entra: `$ref`; Google: the Members API — one flat remote group per local
 * group, in all three cases) and stays exactly as it was before this task.
 * `ActiveDirectoryConnector` is the first, and remains the only REAL
 * vendor, implementation — see its own doc comment for the concrete
 * nesting rule. `EchoConnector` is the second (Milestone 13, Task 8): the
 * in-repo spine-proving target gained this capability so
 * `TargetReconciliationJob`'s dry-run/blast-radius guard could be proven
 * against GROUP mutations fast and deterministically, with no AD container
 * needed — see that connector's own doc comment. `ConnectorRegistry.
 * resolveGroupConnector` is how a caller (`SyncWorker`,
 * `TargetReconciliationJob`) discovers, per target, whether this
 * capability exists at all; a target with no group connector falls back to
 * the pre-existing per-user `DesiredUser.groups` path, unchanged.
 */
export interface DirectoryGroupConnector {
  /** The operations `applyGroup(desired)` WOULD run, writing nothing — same contract as `DirectoryConnector.plan`. */
  planGroup(desired: DesiredGroup): Promise<ConnectorOperation[]>

  /**
   * Asserts the WHOLE desired group identity + direct membership — never a
   * delta (same reconcile-to-desired-state rule `DirectoryConnector.apply`
   * follows) — and returns the target's own immutable id for this group.
   * Must not partially apply: a thrown error must leave this group's target
   * state exactly as it was before the call (see `ActiveDirectoryConnector.
   * applyGroup`'s own doc comment for how CREATE achieves this atomically
   * and UPDATE achieves it via an ordered, self-healing sequence, mirroring
   * `apply()`'s own UPDATE-path discipline for users).
   */
  applyGroup(desired: DesiredGroup): Promise<{ externalId: string }>
}

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
