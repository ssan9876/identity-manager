import { Injectable } from '@nestjs/common'
import type {
  ConnectorHealth,
  ConnectorOperation,
  DesiredGroup,
  DesiredUser,
  DirectoryConnector,
  DirectoryGroupConnector,
} from './connector'
import { resolveSecret } from './secrets'

/** One call this connector was asked to make, recorded verbatim — "recording what it was asked to do" (Milestone 10, Task 2 contract). */
export interface EchoRecordedCall {
  method: 'plan' | 'apply' | 'disable'
  desired?: DesiredUser
  externalId?: string
  at: Date
}

/**
 * Milestone 13, Task 8 — the GROUP-shaped mirror of `EchoRecordedCall`,
 * kept as its OWN array (`EchoConnector.groupCalls`) rather than widening
 * `calls` into a discriminated union: `desired` (a `DesiredUser`) and
 * `desiredGroup` (a `DesiredGroup`) are different payload shapes, and every
 * EXISTING test filtering `calls` by `method` (e.g. `calls.filter(call =>
 * call.method === 'apply')`) would otherwise need to additionally narrow
 * away group-shaped entries it never asked about. A separate array also
 * makes "zero group mutations reached the target" a direct, one-line
 * assertion (`groupCalls.filter(c => c.method === 'applyGroup').length ===
 * 0`) — exactly the shape the carried blast-radius gap (Milestone 11, Task
 * 6's own report, "Concerns" #1) needs proven against.
 */
export interface EchoRecordedGroupCall {
  method: 'planGroup' | 'applyGroup'
  desiredGroup?: DesiredGroup
  externalId?: string
  at: Date
}

const CREDENTIAL_SECRET_NAME_KEY = 'credentialSecretName'

/** Order-independent equality on two `Record<string, string[]>` attribute maps — same shape `KeycloakConnector`'s own (private) `attributesEqual` already checks, re-derived locally rather than imported: each connector narrows the same way independently (see keycloak.connector.ts's own doc comment for why this is a deliberate, repeated convention in `connectors/`, not an oversight). */
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

/** Order-independent equality on two id sets — `planGroup`'s own "would membership actually change" check, the group-membership analogue of `sameNameSet` immediately above. Mirrors `ActiveDirectoryConnector`'s own (private) `sameDnSet`, re-derived locally rather than imported — the same repeated-per-file convention every helper in this function already follows. */
function sameIdSet(a: Iterable<string>, b: Iterable<string>): boolean {
  const setA = new Set(a)
  const setB = new Set(b)
  return setA.size === setB.size && [...setA].every((id) => setB.has(id))
}

/**
 * The in-repo target Milestone 10 ships with — "a full in-repo
 * implementation recording what it was asked to do. This proves the spine
 * end-to-end before any vendor protocol exists" (milestone plan, Task 2).
 * Not a test double: it is a genuine `outbox_target`/`connector_targets`
 * citizen (see `ConnectorTarget`'s own doc comment) that Milestone 14's
 * console E2E configures and drives through the real spine.
 *
 * Milestone 13, Task 8 — ALSO implements `DirectoryGroupConnector`
 * (`planGroup`/`applyGroup`, below), the SECOND target to do so after
 * `ActiveDirectoryConnector` (Milestone 11, Task 6). This is what makes
 * `TargetReconciliationJob`'s dry-run/blast-radius guard testable against
 * GROUP mutations fast and deterministically, with no AD container needed —
 * the identical "fast, echo-based proof... no AD container needed for the
 * GENERIC fix" reasoning `test/target-reconciliation.spec.ts`'s own
 * per-principal-isolation tests already use for the USER-shaped guard (see
 * that file's own doc comment on that describe block). It is also the
 * second real case `ConnectorRegistry.resolveGroupConnector`'s own doc
 * comment explicitly anticipated ("When a second target gains this
 * capability... this becomes a real multi-entry catalog") — that
 * generalisation happens alongside this change, not before it, per this
 * project's own "generalise when there is a second real case, not before"
 * precedent.
 *
 * REQUIRES a `credentialSecretName` in its `connector_targets.config`,
 * exactly like a real vendor connector requires a bind password / client
 * secret / service-account key — this is what makes it a faithful stand-in
 * for proving secret resolution end-to-end, not just the profile-sync
 * plumbing. `apply`/`disable`/`plan` all resolve it (proving the DISCIPLINE
 * of "resolve transiently, use, discard" even though this connector has no
 * real remote system to send it to — see `requireSecret` below) and NEVER
 * record the resolved VALUE anywhere, including in `calls` — only `desired`/
 * `externalId`, which by construction never carry a credential (see
 * `DirectoryConnector`'s own doc comment: "never sends a user credential").
 *
 * `calls` and the username -> externalId map are read directly by tests —
 * this class deliberately exposes its own recorded state rather than hiding
 * it behind a second observer object, since "prove what it received" is
 * this connector's entire reason to exist.
 *
 * `@Injectable()` and registered in AppModule (Milestone 10, Task 2) so
 * `ConnectorRegistry`'s own `EchoConnector` constructor parameter is
 * resolvable through real Nest DI — Nest reflects EVERY constructor
 * parameter's TYPE regardless of whether it also has a default value, so an
 * unregistered class parameter fails DI resolution even with `= new
 * EchoConnector()` written at the call site (confirmed the hard way:
 * app.module.spec.ts's DI-graph smoke test failed on exactly this before
 * this class carried the decorator). Constructor takes nothing — same
 * "never network I/O at construction" property `KeycloakAdminClient`/
 * `OutboxRepository`/etc. already have, which is what makes it safe to
 * register unconditionally for every app boot, including tests that only
 * ever call `app.init()`.
 */
@Injectable()
export class EchoConnector implements DirectoryConnector, DirectoryGroupConnector {
  readonly calls: EchoRecordedCall[] = []
  private readonly externalIdsByUsername = new Map<string, string>()
  // Milestone 10, Task 4 — the LAST desired state a successful `apply()`
  // actually recorded for a username, kept so `plan()` (below) can report
  // a genuine diff instead of unconditionally saying "update". Updated ONLY
  // by `apply()`, never by `plan()` itself — planning must stay side-effect
  // free (see `plan()`'s own doc comment: "a plan writes nothing").
  private readonly lastAppliedByUsername = new Map<string, DesiredUser>()
  private nextSequence = 1
  private config: Record<string, unknown> = {}

  // Milestone 13, Task 8 — the GROUP-shaped mirror of the four fields
  // immediately above, same purpose each: `groupCalls` is this class's own
  // "recording what it was asked to do" for `planGroup`/`applyGroup` (see
  // `EchoRecordedGroupCall`'s own doc comment for why this is a SEPARATE
  // array rather than folded into `calls`); `lastAppliedGroupByName` is what
  // `planGroup` diffs against, updated ONLY by `applyGroup`; `externalGroupIdsByName`
  // is the group-shaped mirror of `externalIdsByUsername` (a stable synthetic
  // id, minted once per name and returned on every later `applyGroup` call —
  // idempotence depends on this exactly as it does for users).
  readonly groupCalls: EchoRecordedGroupCall[] = []
  private readonly lastAppliedGroupByName = new Map<string, DesiredGroup>()
  private readonly externalGroupIdsByName = new Map<string, string>()
  private nextGroupSequence = 1

  /**
   * Milestone 11, Task 5 test support — usernames whose NEXT `apply()` call
   * should throw instead of succeeding, so a test can prove per-principal
   * failure isolation (Milestone 10 Task 4 concern 3, closed by
   * `TargetReconciliationJob`'s own per-principal try/catch) WITHOUT needing
   * the real, slow AD container: a fast, deterministic stand-in for "AD hits
   * a transient per-entry error." Checked FIRST in `apply()`, before
   * `requireSecret`/recording, so a forced failure records NOTHING — the
   * same "never partially applies" contract a real failure must honour (see
   * `apply()`'s own doc comment). Never touched by production code
   * (`SyncWorker`/`TargetReconciliationJob`) — a test-only escape hatch,
   * exactly like `calls`/`lastAppliedByUsername` above are test-only reads;
   * this is the one test-only WRITE this class exposes, and it is additive
   * (empty means unchanged, real-connector behaviour).
   */
  readonly forcedFailureUsernames = new Set<string>()

  /**
   * Milestone 13, Task 8 test support — the GROUP-shaped mirror of
   * `forcedFailureUsernames` immediately above, for the identical reason:
   * proving per-GROUP failure isolation in `TargetReconciliationJob`'s new
   * group-apply loop without needing the real, slow AD container. Checked
   * FIRST in `applyGroup()`, before `requireSecret`/recording — a forced
   * failure records NOTHING.
   */
  readonly forcedFailureGroupNames = new Set<string>()

  /**
   * Binds this connector to a FRESH read of `connector_targets.config` —
   * called by `ConnectorRegistry.resolve` immediately before handing this
   * instance back to a caller, never by a caller directly. Not part of
   * `DirectoryConnector` — a registry-internal step, exactly analogous to
   * how `KeycloakConnector` needs no such step because its config source
   * (env, via `KeycloakAdminClient`) is unchanged by this milestone. Returns
   * `this` so `ConnectorRegistry.resolve` can `factory(config)` in one
   * expression.
   */
  configure(config: Record<string, unknown>): this {
    this.config = config
    return this
  }

  /**
   * Milestone 10, Task 4 — GENUINE diffing against the last state `apply()`
   * actually recorded for this username, mirroring `KeycloakConnector.plan`'s
   * own shape exactly (compare, emit only what actually differs, return `[]`
   * when nothing would change). Task 2's original implementation always
   * reported an operation (`exists ? 'update' : 'create'`, unconditionally)
   * — harmless for Task 2's own "does plan run before apply and after"
   * smoke test, but not enough for a REAL consumer that needs to know
   * "would this genuinely change anything": `TargetReconciliationJob`
   * (connectors/target-reconciliation.job.ts) counts a NON-empty `plan()`
   * result as one mutation toward its blast-radius threshold, and reports a
   * second, fully-converged run as a no-op — neither is meaningful against
   * an implementation that always says "update". A username never applied
   * before has no last-applied state to diff against, so it is always a
   * `create`, exactly as before.
   */
  async plan(desired: DesiredUser): Promise<ConnectorOperation[]> {
    this.requireSecret()
    this.calls.push({ method: 'plan', desired, at: new Date() })

    const existing = this.lastAppliedByUsername.get(desired.username)
    if (existing === undefined) {
      return [
        {
          kind: 'create',
          description: `create echo user "${desired.username}" (enabled=${desired.enabled}, groups=[${desired.groups.join(', ')}])`,
        },
      ]
    }

    const ops: ConnectorOperation[] = []
    const profileChanged =
      existing.email !== desired.email ||
      existing.firstName !== desired.firstName ||
      existing.lastName !== desired.lastName ||
      !attributesEqual(existing.attributes, desired.attributes)
    if (profileChanged) {
      ops.push({
        kind: 'update',
        description: `update echo user "${desired.username}" profile/attributes`,
      })
    }
    if (existing.enabled !== desired.enabled) {
      ops.push({
        kind: desired.enabled ? 'update' : 'disable',
        description: `set echo user "${desired.username}" enabled=${desired.enabled}`,
      })
    }
    if (!sameNameSet(existing.groups, desired.groups)) {
      ops.push({
        kind: 'update',
        description: `reconcile echo group membership for "${desired.username}"`,
      })
    }
    return ops
  }

  /**
   * Assigns a NEW synthetic external id the first time a given `username`
   * is seen, and returns the SAME one on every later call — the "immutable
   * external id" correlation (`external_identities`) depends on, and the
   * property idempotence tests need (applying the same desired state twice
   * must not mint a second identity). `requireSecret` runs FIRST, before any
   * recording or map mutation, so a missing secret leaves NOTHING applied —
   * "never partially applies" (Task 2 contract).
   */
  async apply(desired: DesiredUser): Promise<{ externalId: string }> {
    if (this.forcedFailureUsernames.has(desired.username)) {
      throw new Error(`echo connector: forced failure for username "${desired.username}" (test support)`)
    }
    this.requireSecret()

    let externalId = this.externalIdsByUsername.get(desired.username)
    if (externalId === undefined) {
      externalId = `echo-${this.nextSequence++}`
      this.externalIdsByUsername.set(desired.username, externalId)
    }

    this.calls.push({ method: 'apply', desired, externalId, at: new Date() })
    // Recorded AFTER pushing to `calls` (which never fails) so a genuinely
    // successful apply is always what future `plan()` calls diff against —
    // see `lastAppliedByUsername`'s own doc comment.
    this.lastAppliedByUsername.set(desired.username, desired)
    return { externalId }
  }

  async disable(externalId: string): Promise<void> {
    this.requireSecret()
    this.calls.push({ method: 'disable', externalId, at: new Date() })
  }

  async health(): Promise<ConnectorHealth> {
    try {
      const secretName = this.secretName()
      resolveSecret(secretName)
      return { ok: true, detail: `echo target reachable; credential resolved from "${secretName}"` }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  // -------------------------------------------------------------------
  // Group sync (Milestone 13, Task 8) — the SAME "genuine diff against the
  // last state APPLY actually recorded" shape `plan()`/`apply()` above
  // already establish for users, applied to `DesiredGroup`. Exists so
  // `TargetReconciliationJob`'s dry-run/blast-radius guard is provable
  // against GROUP mutations without a real AD container — see this class's
  // own top doc comment.
  // -------------------------------------------------------------------

  async planGroup(desired: DesiredGroup): Promise<ConnectorOperation[]> {
    this.requireSecret()
    this.groupCalls.push({ method: 'planGroup', desiredGroup: desired, at: new Date() })

    const existing = this.lastAppliedGroupByName.get(desired.name)
    if (existing === undefined) {
      return [
        {
          kind: 'create',
          description: `create echo group "${desired.name}" (members=[${desired.memberExternalIds.join(', ')}])`,
        },
      ]
    }

    if (!sameIdSet(existing.memberExternalIds, desired.memberExternalIds)) {
      return [
        {
          kind: 'update',
          description: `reconcile echo group "${desired.name}" membership`,
        },
      ]
    }
    return []
  }

  /**
   * Assigns a NEW synthetic external id the first time a given group `name`
   * is seen, and returns the SAME one on every later call — the group-shaped
   * mirror of `apply()`'s own identical discipline for `externalIdsByUsername`
   * (see that method's own doc comment: idempotence depends on this).
   * `requireSecret` runs FIRST, before any recording or map mutation, so a
   * missing secret leaves NOTHING applied — same "never partially applies"
   * contract.
   */
  async applyGroup(desired: DesiredGroup): Promise<{ externalId: string }> {
    if (this.forcedFailureGroupNames.has(desired.name)) {
      throw new Error(`echo connector: forced failure for group "${desired.name}" (test support)`)
    }
    this.requireSecret()

    let externalId = this.externalGroupIdsByName.get(desired.name)
    if (externalId === undefined) {
      externalId = `echo-group-${this.nextGroupSequence++}`
      this.externalGroupIdsByName.set(desired.name, externalId)
    }

    this.groupCalls.push({ method: 'applyGroup', desiredGroup: desired, externalId, at: new Date() })
    // Recorded AFTER pushing to `groupCalls` (which never fails) so a
    // genuinely successful apply is always what future `planGroup` calls
    // diff against — see `lastAppliedGroupByName`'s own doc comment.
    this.lastAppliedGroupByName.set(desired.name, desired)
    return { externalId }
  }

  /** Throws `MissingSecretError` (secrets.ts) if the configured secret name has no value in the environment. Discards the resolved value immediately — it exists only to prove resolution succeeded. */
  private requireSecret(): void {
    resolveSecret(this.secretName())
  }

  /** Throws a plain, config-shape error (distinct from MissingSecretError) when `connector_targets.config` itself never named a secret — a configuration defect, not an absent environment variable. Never includes any secret VALUE, only ever the fixed, non-sensitive field name `credentialSecretName`. */
  private secretName(): string {
    const raw = this.config[CREDENTIAL_SECRET_NAME_KEY]
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Error(
        `echo connector: connector_targets.config.${CREDENTIAL_SECRET_NAME_KEY} is required and must be a non-empty string`,
      )
    }
    return raw
  }
}
