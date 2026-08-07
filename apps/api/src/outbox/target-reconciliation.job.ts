import { Inject, Injectable } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { AuditWriter } from '../audit/audit.writer'
import { DB_CLIENT } from '../common/db.token'
import type { ConnectorOperation, ConnectorTarget } from '../connectors/connector'
import { ConnectorRegistry } from '../connectors/connector-registry'
import { connectorTargets } from '../db/schema/connector-targets'
import * as schema from '../db/schema/index'
import { type User, UsersRepository, type UserStatus } from '../users/users.repository'
import { SyncWorker } from './sync.worker'

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

export interface TargetReconciliationOptions {
  /** When `true`, computes and returns the plan but never applies anything, regardless of the blast-radius outcome — writes nothing anywhere (design doc decision 7: "every connector is dry-runnable"). Defaults to `false`. */
  dryRun?: boolean
  /** Explicit override: proceed even if the blast-radius guard trips. Ignored when `dryRun` is `true`. Every override is audited — see `reconcile`'s own doc comment. Defaults to `false`. */
  force?: boolean
}

export interface TargetReconciliationReport {
  target: ConnectorTarget
  /** Every in-scope principal walked — every user, every status (see `ALL_USER_STATUSES`). */
  populationSize: number
  /** Every principal `plan()` found a non-empty operation list for — the FULL set, regardless of whether this run went on to apply it. */
  toMutate: PlannedPrincipal[]
  blastRadius: BlastRadiusEvaluation
  dryRun: boolean
  /** `true` iff the blast-radius guard tripped and this run was NOT overridden — nothing in `toMutate` was applied. */
  halted: boolean
  /** `true` iff the blast-radius guard tripped AND `force` was set — every entry in `toMutate` WAS applied, and the override was audited. */
  overridden: boolean
  /** How many principals were actually reconciled against the target this run — 0 for a dry run or a halted run. */
  appliedCount: number
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
 * before it: a trusted, on-demand admin/CLI operation, not a request from a
 * scoped actor — it must see every in-scope principal, not just some
 * actor's subtree.
 *
 * NEVER calls `connector.disable()` — see `DirectoryConnector`'s own doc
 * comment ("connectors never delete... disable only") and `SyncWorker.
 * reconcileUser`'s: a principal whose desired state is "not enabled" is
 * asserted via `apply({ ..., enabled: false })`, the SAME path every OTHER
 * desired-state assertion uses, never a distinct removal-shaped call. There
 * is no code path here — or anywhere in `SyncWorker`/the connectors
 * themselves — that removes a principal from a target.
 */
@Injectable()
export class TargetReconciliationJob {
  constructor(
    @Inject(UsersRepository) private readonly usersRepository: UsersRepository,
    @Inject(ConnectorRegistry) private readonly connectorRegistry: ConnectorRegistry,
    @Inject(SyncWorker) private readonly syncWorker: SyncWorker,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async reconcile(
    target: ConnectorTarget,
    options: TargetReconciliationOptions = {},
  ): Promise<TargetReconciliationReport> {
    const dryRun = options.dryRun ?? false
    const force = options.force ?? false

    const { thresholdPercent, floor } = await this.loadBlastRadiusConfig(target)

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
          const operations = await this.planForUser(user, target)
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

    const blastRadius = evaluateBlastRadius(toMutate.length, populationSize, thresholdPercent, floor)

    if (dryRun) {
      // Design doc decision 7 / this task's own brief: "printing the plan
      // for a target and writing nothing — the same shape as the
      // bulk-import preview." Nothing above this line ever wrote anything
      // either (PLAN calls `connector.plan()` only), so returning here,
      // before the blast-radius branch even runs, is what makes dry run
      // unconditional: it writes nothing REGARDLESS of what the guard would
      // have decided.
      return {
        target,
        populationSize,
        toMutate,
        blastRadius,
        dryRun: true,
        halted: false,
        overridden: false,
        appliedCount: 0,
      }
    }

    if (blastRadius.tripped && !force) {
      // Halts and applies NOTHING — not a partial prefix, not
      // apply-then-warn. `toMutate` is still returned so a caller (the CLI)
      // can report exactly what would have happened.
      return {
        target,
        populationSize,
        toMutate,
        blastRadius,
        dryRun: false,
        halted: true,
        overridden: false,
        appliedCount: 0,
      }
    }

    const overridden = blastRadius.tripped && force
    if (overridden) {
      // Audited BEFORE a single principal is touched — the override
      // decision is what is being recorded, independent of whether the
      // apply phase below fully succeeds.
      await this.auditOverride(target, blastRadius)
    }

    for (const principal of toMutate) {
      await this.db.transaction(async (tx) => {
        await this.syncWorker.reconcileUser(tx, principal.userId, target)
      })
    }

    return {
      target,
      populationSize,
      toMutate,
      blastRadius,
      dryRun: false,
      halted: false,
      overridden,
      appliedCount: toMutate.length,
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
   * inside-an-open-transaction shape finding C1 (docs/superpowers/
   * audit-integrity.md) already burned this project once. One short
   * transaction per user, opened fresh each time, is the same shape
   * `SyncWorker.reconcileUser` itself already uses per event — proven safe
   * at the scale this project's own pool-exhaustion regression test
   * exercises.
   */
  private async planForUser(user: User, target: ConnectorTarget): Promise<ConnectorOperation[]> {
    return this.db.transaction(async (tx) => {
      const desired = await this.syncWorker.buildDesiredUser(tx, user, target)
      const connector = await this.connectorRegistry.resolve(target, tx)
      return connector.plan(desired)
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
   * and audited" (this task's own brief). `actorUserId: null` — the same
   * "trusted, on-demand system/operator action with no HTTP-authenticated
   * actor to attribute it to" convention `ReconciliationJob.enqueueRepair`,
   * `LifecycleJob` and `RuleApplier` already use (see any of their own doc
   * comments): this job runs from a CLI, not a JWT-guarded request, so
   * there is no `Actor` to record here any more than those other on-demand
   * scripts have one — WHO ran the override is answerable from server/OS
   * process logs, same as every other script in this codebase. `resourceId`
   * is `null`, not `target` — `audit_log.resource_id` is a `uuid` column
   * (see db/schema/audit-log.ts) and a target name is not one; `target`
   * itself, plus every number behind the decision, is carried in `after`
   * instead — mirrors `ImportsController.preview`'s own
   * `resourceType: 'import', resourceId: null` shape for an invocation-level
   * row with no single row-shaped resource to point at.
   */
  private async auditOverride(target: ConnectorTarget, blastRadius: BlastRadiusEvaluation): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.auditWriter.record(tx, {
        actorUserId: null,
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
