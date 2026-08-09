import { Inject, Injectable, Optional } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { AuditWriter } from '../audit/audit.writer'
import { DB_CLIENT } from '../common/db.token'
import type { ConnectorOperation, ConnectorTarget } from '../connectors/connector'
import { ConnectorRegistry } from '../connectors/connector-registry'
import { connectorTargets } from '../db/schema/connector-targets'
import * as schema from '../db/schema/index'
import { type Group, GroupsRepository } from '../groups/groups.repository'
import { type User, UsersRepository, type UserStatus } from '../users/users.repository'
import { SyncWorker, type TargetProvisioning } from './sync.worker'

// Every status, not just 'active' — mirrors `ReconciliationJob`'s own
// `ALL_USER_STATUSES` (outbox/reconciliation.job.ts) exactly, and for the
// identical reason (see that file's class-level doc comment): a
// pending/suspended/deactivated user is still an in-scope principal for a
// target — their DESIRED state there is `enabled: false`, and a target that
// somehow shows them enabled (e.g. an operator flipped it directly) is
// exactly the drift this job exists to find and correct. Duplicated here
// rather than imported — a deliberate, tiny, zero-risk repeat of two
// constants, not a dependency on that sibling job's internals (see this
// project's own established convention for small pure/constant duplication
// across sibling modules, e.g. `attributesEqual`/`sameNameSet` in THREE
// separate `connectors/`/`outbox/` files already).
const ALL_USER_STATUSES: readonly UserStatus[] = ['pending', 'active', 'suspended', 'deactivated']

// Same internal pagination chunk size as `ReconciliationJob`'s own walk —
// see that file's own doc comment for why this is an internal batch size,
// not a client-facing limit.
const PAGE_SIZE = 200

/**
 * The blast-radius guard's pure decision function — settling Task 1's own
 * open concern ("the threshold unit is an assumption") per Milestone 10,
 * Task 4: the threshold is a PERCENTAGE of the target's in-scope
 * population, `floor` is a configurable absolute count below which the
 * guard never trips regardless of percentage, and the guard trips only when
 * BOTH are exceeded (design doc "Safety rails" + this task's own brief).
 *
 * A pure function, exported and unit-tested directly with no database
 * involved — the same reasoning `computeBackoffDelayMs` (sync.worker.ts) is
 * a standalone export rather than inlined into its only caller.
 *
 * Both comparisons are STRICT ("exceeds", "more than" — never "at or
 * above"): a run that would mutate EXACTLY the threshold percentage, or
 * EXACTLY the floor count, proceeds. Cross-multiplication
 * (`changedCount * 100` vs `populationSize * thresholdPercent`) avoids
 * floating-point division entirely — an exact integer comparison, not an
 * approximation that could disagree with a human re-deriving the same
 * percentage by hand.
 */
export interface BlastRadiusEvaluation {
  tripped: boolean
  changedCount: number
  populationSize: number
  thresholdPercent: number
  floor: number
}

export function evaluateBlastRadius(
  changedCount: number,
  populationSize: number,
  thresholdPercent: number,
  floor: number,
): BlastRadiusEvaluation {
  // `populationSize > 0` guard is belt-and-braces, not load-bearing: with
  // zero in-scope principals, `changedCount` is always 0 too, and `0 > floor`
  // is already false for any non-negative floor — but spelling it out avoids
  // ever reasoning about "0 mutated out of 0" as a percentage at all.
  const percentExceeded = populationSize > 0 && changedCount * 100 > populationSize * thresholdPercent
  const floorExceeded = changedCount > floor

  return {
    tripped: percentExceeded && floorExceeded,
    changedCount,
    populationSize,
    thresholdPercent,
    floor,
  }
}

/** One in-scope principal `plan()` found at least one operation for — i.e. one the target is NOT currently converged with. */
export interface PlannedPrincipal {
  userId: string
  username: string
  operations: ConnectorOperation[]
}

/**
 * Milestone 13, Task 8 — the GROUP-shaped mirror of `PlannedPrincipal`,
 * closing Milestone 11 Task 6's own carried gap ("the dry-run/blast-radius
 * guard... does not walk groups this milestone" — that task's own report,
 * Concerns #1). One in-scope GROUP `planGroup()` found at least one
 * operation for, for a target with a real `DirectoryGroupConnector`
 * (`ConnectorRegistry.resolveGroupConnector` — today: `active_directory`,
 * plus `echo` for this job's own spine-level tests; see `EchoConnector`'s
 * own doc comment). A SEPARATE array from `toMutate` (`PlannedPrincipal`),
 * never merged into it — a group has no `userId`, and keeping the two
 * apart is what lets every EXISTING assertion against `toMutate` in this
 * job's own test suite stay exact and unchanged for every target that has
 * no group connector at all (i.e. every target except `active_directory`/
 * `echo`), which is precisely what keeps this a genuinely additive,
 * non-breaking change.
 */
export interface PlannedGroup {
  groupId: string
  name: string
  operations: ConnectorOperation[]
}

export interface TargetReconciliationOptions {
  /** When `true`, computes and returns the plan but never applies anything, regardless of the blast-radius outcome — writes nothing anywhere (design doc decision 7: "every connector is dry-runnable"). Defaults to `false`. */
  dryRun?: boolean
  /** Explicit override: proceed even if the blast-radius guard trips. Ignored when `dryRun` is `true`. Every override is audited — see `reconcile`'s own doc comment. Defaults to `false`. */
  force?: boolean
  /**
   * The authenticated actor who asked for this run, when there IS one —
   * threaded straight through to `auditOverride`'s `actorUserId`.
   *
   * Exists because this job is no longer CLI-only. `POST /connector-targets/
   * :target/reconcile` (`connectors/connector-targets.controller.ts`) calls
   * `reconcile()` from a JWT-guarded request, so the override row — the one
   * an auditor searches for when asking "who deliberately overrode the
   * blast-radius guard" — can and must name a human. Leaving it unset keeps
   * the pre-existing `actorUserId: null` system-actor shape, which is the
   * correct and only available answer for `target-reconcile-cli.ts`.
   *
   * Finding CAR-system-actor, item 3
   * (`docs/archive/audits/carried-findings-verification.md`): "thread the
   * acting `userId` into `TargetReconciliationJob.auditOverride` so
   * `connector:reconcile-override` names a human when one exists".
   */
  actorUserId?: string | null
}

/** One principal whose OWN `reconcileUser` call threw during the APPLY phase — see `TargetReconciliationReport.failed`'s own doc comment. */
export interface FailedPrincipal {
  userId: string
  username: string
  error: string
}

/** Milestone 13, Task 8 — the GROUP-shaped mirror of `FailedPrincipal`, for `TargetReconciliationReport.failedGroups`'s own per-group failure isolation. */
export interface FailedGroup {
  groupId: string
  name: string
  error: string
}

export interface TargetReconciliationReport {
  target: ConnectorTarget
  /**
   * Every in-scope principal walked — every user, every status (see
   * `ALL_USER_STATUSES`), PLUS every in-scope GROUP walked when `target` has
   * a real `DirectoryGroupConnector` (Milestone 13, Task 8 — see
   * `PlannedGroup`'s own doc comment). Zero groups contribute here for a
   * target with no group connector (every target except `active_directory`/
   * `echo`), which is what keeps this field's value byte-for-byte unchanged,
   * for every one of those targets, from what Milestone 10 Task 4 originally
   * shipped.
   */
  populationSize: number
  /** Every principal `plan()` found a non-empty operation list for — the FULL set, regardless of whether this run went on to apply it. */
  toMutate: PlannedPrincipal[]
  /** Milestone 13, Task 8 — every GROUP `planGroup()` found a non-empty operation list for. See `PlannedGroup`'s own doc comment for why this is a separate array from `toMutate`, not merged into it. Always empty for a target with no group connector. */
  toMutateGroups: PlannedGroup[]
  /**
   * Milestone 13, Task 8 — now evaluated against the COMBINED user +
   * group population/changed-count (`populationSize` above,
   * `toMutate.length + toMutateGroups.length`) rather than users alone —
   * "group and membership operations must count toward blast radius" (this
   * task's own brief). For a target with no group connector this is
   * identical to Milestone 10 Task 4's original behaviour, since both group
   * quantities are always zero there.
   */
  blastRadius: BlastRadiusEvaluation
  dryRun: boolean
  /** `true` iff the blast-radius guard tripped and this run was NOT overridden — nothing in `toMutate` OR `toMutateGroups` was applied. */
  halted: boolean
  /** `true` iff the blast-radius guard tripped AND `force` was set — every entry in `toMutate` AND `toMutateGroups` WAS applied, and the override was audited. */
  overridden: boolean
  /** How many principals were ACTUALLY reconciled against the target this run — 0 for a dry run or a halted run, otherwise `toMutate.length - failed.length` (see `failed`'s own doc comment: a per-principal failure does not stop the rest of the batch, so this can be less than `toMutate.length` on a real, non-halted run). */
  appliedCount: number
  /** Milestone 13, Task 8 — the GROUP-shaped mirror of `appliedCount`, counting entries in `toMutateGroups` actually applied. 0 for a dry run, a halted run, or a target with no group connector. */
  appliedGroupCount: number
  /**
   * Milestone 10 Task 4 concern 3, closed by Milestone 11 Task 5 —
   * per-principal failure isolation. Every principal in `toMutate` whose OWN
   * `SyncWorker.reconcileUser` call threw during APPLY, with the error
   * message it threw. ONE principal failing (AD will hit transient
   * per-entry errors in normal operation — a stale password-policy
   * violation, a momentarily unreachable DC, a constraint violation on one
   * malformed row) must not abort the whole run and must not leave a LATER
   * principal in `toMutate` unattempted just because an EARLIER one failed —
   * see `reconcile`'s own doc comment on the APPLY loop for how this is
   * enforced. Empty on a dry run, a halted run, or a real run where every
   * principal in `toMutate` succeeded.
   */
  failed: FailedPrincipal[]
  /** Milestone 13, Task 8 — the GROUP-shaped mirror of `failed`, with the identical per-entity isolation guarantee: one group's `reconcileGroupById` throwing does not abort the batch and does not affect any other group (or any user). Empty on a dry run, a halted run, or a real run where every group in `toMutateGroups` succeeded. */
  failedGroups: FailedGroup[]
}

/**
 * Milestone 10, Task 4 — per-target reconciliation, direct and synchronous,
 * via the Task 2 connector interface: "the reconciliation job takes a
 * target and asserts desired state for every in-scope principal" (milestone
 * plan). Deliberately NOT the outbox: `OutboxWriter.record` fans out to
 * EVERY currently-enabled target at once (design doc decision 6), which is
 * the wrong shape for "reconcile THIS one target, right now" — and going
 * through the outbox would make the whole point of this job (compute a
 * full plan, evaluate it against a threshold, THEN decide whether to touch
 * anything) an asynchronous, eventually-consistent guess instead of a
 * single, deterministic, blockable decision. So this job calls
 * `ConnectorRegistry.resolve(target, tx).plan(...)`/`SyncWorker.
 * reconcileUser(tx, ..., target)` directly — see those methods' own doc
 * comments for the connection-discipline contract both already guarantee
 * (every Postgres read/write goes through the SAME transaction handle a
 * caller provides; no connector implementation ever opens a second pool
 * connection).
 *
 * TWO-PHASE, by design:
 *
 * 1. PLAN — for every in-scope principal (every user, every status; see
 *    `ALL_USER_STATUSES`), build its desired state (`SyncWorker.
 *    buildDesiredUser` — the SAME computation an outbox-driven sync uses,
 *    reused rather than re-derived, so a dry-run plan can never silently
 *    diverge from what a real sync would actually assert) and call the
 *    resolved connector's `plan()`. A principal whose `plan()` comes back
 *    empty is ALREADY converged and is not counted as a mutation — this is
 *    what makes a second, fully-converged run report zero, not the full
 *    population, and it is what makes the blast-radius percentage meaningful
 *    at all (a percentage of "would genuinely change", never a percentage
 *    of "every principal that exists"). This phase writes nothing — it is
 *    exactly `dryRun`'s own behaviour, always, even on a real run.
 *
 * 2. APPLY — only reached when NOT a dry run, and only for the principals
 *    PLAN already flagged. Gated by the blast-radius guard: if the guard
 *    trips and `force` was not given, this phase is skipped ENTIRELY —
 *    "halts and applies nothing... Report what it would have done" (this
 *    task's own brief) — not a partial prefix, not "apply then warn".
 *    Overriding (`force: true`) is explicit (a caller must pass it) and
 *    audited (one `connector:reconcile-override` row — see `auditOverride`)
 *    before a single principal is touched.
 *
 * Idempotent by construction: since PLAN only counts principals that are
 * NOT already converged, and APPLY re-asserts full desired state via the
 * exact same `SyncWorker.reconcileUser` an outbox-driven sync already
 * proved idempotent, a second `reconcile()` call immediately after a
 * successful one finds nothing left to do (`toMutate` is empty) and applies
 * nothing — "a second run changes nothing" (design doc decision 2,
 * restated for this task).
 *
 * Unscoped (`scopePaths`-free), like `ReconciliationJob`/`LifecycleJob`
 * before it: it must see every in-scope principal, not just some actor's
 * subtree.
 *
 * That is NOT the same as "no request can reach it" — a claim an earlier
 * version of this comment made, and which is false. `POST /connector-
 * targets/:target/reconcile` (`connectors/connector-targets.controller.ts`)
 * calls `reconcile()` directly from a JWT-guarded HTTP handler, so an
 * unscoped, directory-wide, per-entity-unaudited system write IS inducible
 * from a user-facing path. What bounds it is authorization, not
 * unreachability: that route's `requireGlobalManageGrant` demands a GLOBAL
 * grant of `connector:manage` (`scopePathsFor(actor, 'connector:manage') ===
 * null`), and `connector:manage` is `super_admin`-only in the static
 * catalog — so a SCOPED actor cannot use this job to escape their subtree,
 * which is the property that actually matters. A caller-supplied
 * `options.actorUserId` records who asked, when anyone did.
 *
 * Finding CAR-system-actor
 * (`docs/archive/audits/carried-findings-verification.md`): the carried
 * claim "confirm this cannot be induced from a user-facing path" no longer
 * holds, and this comment used to restate it.
 *
 * NEVER calls `connector.disable()` — see `DirectoryConnector`'s own doc
 * comment ("connectors never delete... disable only") and `SyncWorker.
 * reconcileUser`'s: a principal whose desired state is "not enabled" is
 * asserted via `apply({ ..., enabled: false })`, the SAME path every OTHER
 * desired-state assertion uses, never a distinct removal-shaped call. There
 * is no code path here — or anywhere in `SyncWorker`/the connectors
 * themselves — that removes a principal from a target.
 *
 * GROUPS (Milestone 13, Task 8): for a target with a real
 * `DirectoryGroupConnector` (`ConnectorRegistry.resolveGroupConnector` —
 * today `active_directory`, plus `echo` for this job's own fast, container-
 * free tests), PLAN and APPLY additionally walk every group exactly the
 * same two-phase way, via `SyncWorker.buildDesiredGroup`/`reconcileGroupById`
 * (the group-shaped mirrors of `buildDesiredUser`/`reconcileUser` this job
 * already reused for users) — see `PlannedGroup`/`TargetReconciliationReport.
 * toMutateGroups`'s own doc comments. This closes a real, previously-carried
 * gap: Milestone 11 Task 6's own report flagged, in its "Concerns", that
 * this job's dry-run/blast-radius guard did not walk groups at all — group-
 * level AD sync happened ONLY via the outbox (`group`/`membership` events),
 * so a mass group-membership change was invisible to the ONE safety rail
 * that exists to catch exactly that shape of incident (design doc, "Safety
 * rails": "Directory syncs that went wrong at scale are a well-known way to
 * take down an organisation's logins"). Group and user mutations now share
 * ONE combined population/changed-count and ONE blast-radius verdict — a
 * run that trips the guard applies NEITHER, and a target with no group
 * connector sees this job behave byte-for-byte as it did before this task
 * (zero groups ever contribute to a population/count that was always
 * user-only for that target).
 *
 * PROVISIONING MODE (Milestone 18, Task 15). Desired state now includes
 * "should this account exist at all". On an `all_users` target — the
 * default, and every target until an operator deliberately opts one in —
 * nothing below changes at all. On an `entitled_only` target, a user holding
 * no `user_target_accounts` row has a desired state of DISABLED, so an
 * account they still have is planned for a disable rather than quietly
 * skipped; skipping is what leaves a live account nobody manages. The
 * entitlement set is read ONCE per run (`SyncWorker.loadTargetProvisioning`)
 * and threaded into `buildDesiredUser`, so this job's plan and the apply
 * phase behind it cannot disagree about who should have an account.
 *
 * THE BLAST-RADIUS GUARD IS EXACTLY WHY IT EXISTS. Flipping a populated
 * target to `entitled_only` before any role grants accounts makes the whole
 * directory's desired state "disabled" — the guard halts that run and
 * reports it instead of executing it, and NOTHING reaches the target.
 * test/business-role-sync.spec.ts asserts precisely that.
 */
@Injectable()
export class TargetReconciliationJob {
  constructor(
    @Inject(UsersRepository) private readonly usersRepository: UsersRepository,
    @Inject(ConnectorRegistry) private readonly connectorRegistry: ConnectorRegistry,
    @Inject(SyncWorker) private readonly syncWorker: SyncWorker,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
    // Milestone 13, Task 8 — `@Optional()`-with-JS-default, the SAME shape
    // `SyncWorker`'s own trailing constructor parameters already establish
    // (see that class's own doc comment): this class is never Nest-DI-
    // resolved today (constructed directly by target-reconcile-cli.ts and by
    // this job's own tests, not registered in app.module.ts), so every
    // existing raw `new TargetReconciliationJob(...)` call site keeps
    // compiling and behaving unchanged, defaulting to a fresh
    // `GroupsRepository` bound to the SAME `db` this job itself was given.
    @Optional() @Inject(GroupsRepository) private readonly groupsRepository: GroupsRepository = new GroupsRepository(db),
  ) {}

  async reconcile(
    target: ConnectorTarget,
    options: TargetReconciliationOptions = {},
  ): Promise<TargetReconciliationReport> {
    const dryRun = options.dryRun ?? false
    const force = options.force ?? false

    const { thresholdPercent, floor } = await this.loadBlastRadiusConfig(target)

    // MILESTONE 18, TASK 15 — this target's provisioning mode and, when it
    // is `entitled_only`, the FULL set of users entitled to an account in
    // it, read ONCE for the whole run rather than once per user (see
    // `SyncWorker.loadTargetProvisioning`'s own doc comment). Its own short
    // transaction, opened and committed before the population walk starts —
    // the identical connection discipline `planForUser` documents, for the
    // identical finding-C1 reason: `UsersRepository.list` below reads via
    // the pool and must never do so while a transaction of this job's sits
    // open.
    //
    // Read at the START of the run and used for every user in it, so one
    // run plans against ONE consistent answer. An entitlement granted
    // mid-walk is picked up by the next run — which is the same
    // eventual-consistency contract every other input to this job already
    // has, and far better than a walk whose first half and second half
    // disagree about who should have an account.
    const provisioning = await this.db.transaction(async (tx) =>
      this.syncWorker.loadTargetProvisioning(tx, target),
    )

    const toMutate: PlannedPrincipal[] = []
    let populationSize = 0

    for (const status of ALL_USER_STATUSES) {
      let offset = 0
      for (;;) {
        const page = await this.usersRepository.list({ status, limit: PAGE_SIZE, offset, scopePaths: null })
        if (page.length === 0) {
          break
        }

        for (const user of page) {
          populationSize += 1
          const operations = await this.planForUser(user, target, provisioning)
          if (operations.length > 0) {
            toMutate.push({ userId: user.id, username: user.username, operations })
          }
        }

        if (page.length < PAGE_SIZE) {
          break
        }
        offset += PAGE_SIZE
      }
    }

    // GROUP WALK (Milestone 13, Task 8) — see this class's own top doc
    // comment, "GROUPS", for the full reasoning. `hasGroupConnector` is ONE
    // cheap, throwaway-transaction check before ever touching
    // `groupsRepository.list` — a target with no group connector (every
    // target except `active_directory`/`echo`) pays that one check and
    // nothing more; `groupPopulationSize`/`toMutateGroups` stay exactly `0`/
    // `[]`, which is what keeps `populationSize`/`blastRadius` byte-for-byte
    // unchanged for those targets from what Milestone 10 Task 4 shipped.
    const toMutateGroups: PlannedGroup[] = []
    let groupPopulationSize = 0

    if (await this.hasGroupConnector(target)) {
      let offset = 0
      for (;;) {
        const page = await this.groupsRepository.list({ limit: PAGE_SIZE, offset, scopePaths: null })
        if (page.length === 0) {
          break
        }

        for (const group of page) {
          groupPopulationSize += 1
          const operations = await this.planForGroup(group, target)
          if (operations.length > 0) {
            toMutateGroups.push({ groupId: group.id, name: group.name, operations })
          }
        }

        if (page.length < PAGE_SIZE) {
          break
        }
        offset += PAGE_SIZE
      }
    }

    // ONE combined population/changed-count feeds the blast-radius guard —
    // "group and membership operations must count toward blast radius"
    // (this task's own brief), not a second, independent guard alongside
    // the user one.
    populationSize += groupPopulationSize
    const changedCount = toMutate.length + toMutateGroups.length
    const blastRadius = evaluateBlastRadius(changedCount, populationSize, thresholdPercent, floor)

    if (dryRun) {
      // Design doc decision 7 / this task's own brief: "printing the plan
      // for a target and writing nothing — the same shape as the
      // bulk-import preview." Nothing above this line ever wrote anything
      // either (PLAN calls `connector.plan()`/`planGroup()` only), so
      // returning here, before the blast-radius branch even runs, is what
      // makes dry run unconditional: it writes nothing REGARDLESS of what
      // the guard would have decided.
      return {
        target,
        populationSize,
        toMutate,
        toMutateGroups,
        blastRadius,
        dryRun: true,
        halted: false,
        overridden: false,
        appliedCount: 0,
        appliedGroupCount: 0,
        failed: [],
        failedGroups: [],
      }
    }

    if (blastRadius.tripped && !force) {
      // Halts and applies NOTHING — not a partial prefix, not
      // apply-then-warn. `toMutate`/`toMutateGroups` are still returned so a
      // caller (the CLI) can report exactly what would have happened.
      return {
        target,
        populationSize,
        toMutate,
        toMutateGroups,
        blastRadius,
        dryRun: false,
        halted: true,
        overridden: false,
        appliedCount: 0,
        appliedGroupCount: 0,
        failed: [],
        failedGroups: [],
      }
    }

    const overridden = blastRadius.tripped && force
    if (overridden) {
      // Audited BEFORE a single principal or group is touched — the
      // override decision is what is being recorded, independent of
      // whether the apply phase below fully succeeds.
      await this.auditOverride(target, blastRadius, options.actorUserId ?? null)
    }

    // PER-PRINCIPAL FAILURE ISOLATION (Milestone 10 Task 4 concern 3,
    // closed here): each principal gets its OWN try/catch, so one throwing
    // — AD hits transient per-entry errors in normal operation, this is not
    // a hypothetical — neither aborts the rest of the loop (every LATER
    // principal in `toMutate` is still attempted) nor un-applies anything
    // EARLIER that already succeeded (each iteration is its own committed
    // transaction — see `syncWorker.reconcileUser`'s own doc comment: it
    // either fully asserts one principal's desired state or throws having
    // asserted none of it; there is no partial-write state for THIS
    // iteration's `tx` to roll back beyond what that method already
    // guarantees). Failures are collected, never swallowed silently — see
    // `TargetReconciliationReport.failed`'s own doc comment.
    const failed: FailedPrincipal[] = []
    let appliedCount = 0
    for (const principal of toMutate) {
      try {
        await this.db.transaction(async (tx) => {
          await this.syncWorker.reconcileUser(tx, principal.userId, target)
        })
        appliedCount += 1
      } catch (error) {
        failed.push({
          userId: principal.userId,
          username: principal.username,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // PER-GROUP FAILURE ISOLATION (Milestone 13, Task 8) — the identical
    // shape immediately above, applied to `toMutateGroups`: one group's
    // `reconcileGroupById` throwing neither aborts this loop nor un-applies
    // anything already-succeeded (earlier in this loop, or any user above).
    const failedGroups: FailedGroup[] = []
    let appliedGroupCount = 0
    for (const plannedGroup of toMutateGroups) {
      try {
        await this.db.transaction(async (tx) => {
          await this.syncWorker.reconcileGroupById(tx, plannedGroup.groupId, target)
        })
        appliedGroupCount += 1
      } catch (error) {
        failedGroups.push({
          groupId: plannedGroup.groupId,
          name: plannedGroup.name,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return {
      target,
      populationSize,
      toMutate,
      toMutateGroups,
      blastRadius,
      dryRun: false,
      halted: false,
      overridden,
      appliedCount,
      appliedGroupCount,
      failed,
      failedGroups,
    }
  }

  /**
   * The PLAN half for one user: build desired state (reusing `SyncWorker.
   * buildDesiredUser` — see this class's own doc comment for why), resolve
   * `target`'s connector, and call `plan()`. Deliberately its OWN short
   * transaction, opened and committed before moving to the next user —
   * never one long-lived transaction spanning the whole population walk:
   * `UsersRepository.list` (the walk's own pagination, in `reconcile` above)
   * has no `tx` parameter at all and always reads via the pool (see that
   * repository's own signature), so holding a transaction open across it
   * would mean either threading a transaction through a method that cannot
   * accept one, or reading via the pool WHILE a transaction sits open
   * elsewhere in the same call stack — precisely the second-pool-connection-
   * inside-an-open-transaction shape finding C1 (docs/archive/audits/
   * audit-integrity.md) already burned this project once. One short
   * transaction per user, opened fresh each time, is the same shape
   * `SyncWorker.reconcileUser` itself already uses per event — proven safe
   * at the scale this project's own pool-exhaustion regression test
   * exercises.
   */
  private async planForUser(
    user: User,
    target: ConnectorTarget,
    provisioning: TargetProvisioning,
  ): Promise<ConnectorOperation[]> {
    return this.db.transaction(async (tx) => {
      // MILESTONE 18, TASK 15 — `provisioning` is threaded into
      // `buildDesiredUser` rather than left for it to resolve per user: the
      // answer is identical either way (that method falls back to a
      // single-user read of the same two tables), this just pays for it once
      // per RUN instead of once per user while walking an entire directory.
      // Desired state for an unentitled user on an `entitled_only` target is
      // therefore `enabled: false` — "should this account exist at all" is
      // part of the desired state this job corrects toward, so an unentitled
      // user is planned for a DISABLE rather than quietly skipped, which
      // would leave a live account nobody manages.
      const desired = await this.syncWorker.buildDesiredUser(tx, user, target, provisioning)
      const connector = await this.connectorRegistry.resolve(target, tx)
      const operations = await connector.plan(desired)

      const entitled = provisioning.mode === 'all_users' || provisioning.entitledUserIds.has(user.id)
      if (entitled) {
        return operations
      }

      // CREATE is dropped for an unentitled user, and only CREATE. A
      // connector reports `create` when the principal does not exist in the
      // target at all — and bringing an account into existence, even a
      // disabled one, is the one thing an unentitled user's desired state
      // definitively does NOT include. Every other operation is kept,
      // including the `disable` a connector reports for an account that
      // exists and is currently enabled: that is precisely the correction
      // this task exists to make.
      //
      // Note what this is NOT: it is not "skip unentitled users". An
      // unentitled user who HAS an account is planned (and disabled); an
      // unentitled user with no account produces an empty plan because
      // there is genuinely nothing to correct, not because they were
      // filtered out of the walk. They are still counted in
      // `populationSize`, so the blast-radius arithmetic still sees the
      // whole directory.
      return operations.filter((operation) => operation.kind !== 'create')
    })
  }

  /**
   * Milestone 13, Task 8 — ONE cheap, throwaway-transaction check, run
   * BEFORE the group population walk even starts: does `target` have a real
   * `DirectoryGroupConnector` at all (`ConnectorRegistry.resolveGroupConnector`)?
   * A target with none (every target except `active_directory`/`echo`) skips
   * `groupsRepository.list`'s pagination entirely — no wasted round trips —
   * and `groupPopulationSize`/`toMutateGroups` stay exactly `0`/`[]`, which
   * is what keeps this job's behaviour byte-for-byte unchanged, for every
   * one of those targets, from what Milestone 10 Task 4 originally shipped.
   */
  private async hasGroupConnector(target: ConnectorTarget): Promise<boolean> {
    return this.db.transaction(
      async (tx) => (await this.connectorRegistry.resolveGroupConnector(target, tx)) !== null,
    )
  }

  /**
   * The PLAN half for one group — the GROUP-shaped mirror of `planForUser`
   * immediately above, identical reasoning throughout (reuses `SyncWorker.
   * buildDesiredGroup`; its own short, fresh transaction per group, never
   * one long-lived transaction spanning the whole walk — see `planForUser`'s
   * own doc comment for the connection-discipline reasoning this mirrors
   * exactly). Resolves the group connector FRESH inside this same
   * transaction rather than reusing one resolved by `hasGroupConnector`
   * earlier — the identical "never trust a connector resolved before this
   * call" discipline `planForUser` already applies to `connectorRegistry.
   * resolve`, so a live admin edit to `connector_targets.config` mid-walk is
   * picked up on the very next group, not just the next `reconcile()` call.
   * A `null` result here (the connector disappeared between
   * `hasGroupConnector`'s check and this call — a narrow, theoretical race
   * with a concurrent admin deconfiguring the target mid-walk) degrades to
   * "no operations for this group" rather than throwing, the same fail-safe
   * "this group simply reports nothing to do" a target genuinely already
   * converged would also report — never a hard failure over a race this
   * narrow.
   */
  private async planForGroup(group: Group, target: ConnectorTarget): Promise<ConnectorOperation[]> {
    return this.db.transaction(async (tx) => {
      const groupConnector = await this.connectorRegistry.resolveGroupConnector(target, tx)
      if (groupConnector === null) {
        return []
      }
      const desired = await this.syncWorker.buildDesiredGroup(tx, group, target)
      return groupConnector.planGroup(desired)
    })
  }

  /**
   * Reads `target`'s own `blastRadiusThreshold`/`blastRadiusFloor` —
   * REQUIRES a `connector_targets` row to exist. Deliberately fails loudly
   * rather than falling back to the schema's own column defaults: a target
   * with no configured row has no admin-reviewed risk tolerance on record,
   * and silently assuming one (even a conservative one) is exactly the
   * "safety rail that is silently on until someone remembers to configure
   * it the OTHER way" gap this project's fail-safe posture exists to avoid
   * (see connector-targets.ts's own doc comment on why the columns
   * themselves are `NOT NULL` with a default, for the identical reason,
   * one layer down). Mirrors `ConnectorRegistry.resolve`'s own "fail clean,
   * not silently" posture for a target `connector_targets` has never heard
   * of.
   */
  private async loadBlastRadiusConfig(
    target: ConnectorTarget,
  ): Promise<{ thresholdPercent: number; floor: number }> {
    const [row] = await this.db
      .select({
        thresholdPercent: connectorTargets.blastRadiusThreshold,
        floor: connectorTargets.blastRadiusFloor,
      })
      .from(connectorTargets)
      .where(eq(connectorTargets.target, target))
      .limit(1)

    if (row === undefined) {
      throw new Error(
        `target-reconciliation: no connector_targets row configured for target "${target}" — cannot determine its blast-radius threshold/floor`,
      )
    }
    return row
  }

  /**
   * The ONE audit row an overridden run writes — "overriding is explicit
   * and audited" (this task's own brief).
   *
   * `actorUserId` is the caller-supplied `options.actorUserId` when there is
   * one, and `null` otherwise. Both cases are real:
   *
   * - `target-reconcile-cli.ts` passes nothing, so the row keeps the
   *   `actorUserId: null` "trusted, on-demand system/operator action with no
   *   HTTP-authenticated actor to attribute it to" convention
   *   `ReconciliationJob.enqueueRepair`, `LifecycleJob` and `RuleApplier`
   *   already use (see any of their own doc comments) — WHO ran it is
   *   answerable from server/OS process logs, same as every other script in
   *   this codebase.
   * - `POST /connector-targets/:target/reconcile` passes
   *   `request.actor.userId`, because that path DOES run under a JWT-guarded
   *   request. An earlier version of this comment asserted the opposite
   *   ("this job runs from a CLI, not a JWT-guarded request, so there is no
   *   `Actor` to record here"); that stopped being true when the HTTP route
   *   was added, and the consequence was that the single most dangerous
   *   action this endpoint offers — deliberately overriding the blast-radius
   *   guard — named nobody. The controller's own
   *   `connector_target:reconcile` row already carried the actor, so an
   *   investigator could correlate by timestamp; the override row itself,
   *   the one an auditor would actually search for, could not.
   *
   * Finding CAR-system-actor, item 3
   * (`docs/archive/audits/carried-findings-verification.md`).
   *
   * `resourceId` is `null`, not `target` — `audit_log.resource_id` is a
   * `uuid` column (see db/schema/audit-log.ts) and a target name is not
   * one; `target` itself, plus every number behind the decision, is
   * carried in `after` instead — mirrors `ImportsController.preview`'s own
   * `resourceType: 'import', resourceId: null` shape for an invocation-level
   * row with no single row-shaped resource to point at.
   */
  private async auditOverride(
    target: ConnectorTarget,
    blastRadius: BlastRadiusEvaluation,
    actorUserId: string | null,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.auditWriter.record(tx, {
        actorUserId,
        action: 'connector:reconcile-override',
        resourceType: 'connector_target',
        resourceId: null,
        before: null,
        after: {
          target,
          changedCount: blastRadius.changedCount,
          populationSize: blastRadius.populationSize,
          thresholdPercent: blastRadius.thresholdPercent,
          floor: blastRadius.floor,
        },
      })
    })
  }
}
