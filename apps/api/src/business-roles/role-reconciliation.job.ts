import { Inject, Injectable } from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { NotFoundError } from '../common/errors'
import * as schema from '../db/schema/index'
import { type UserStatus, UsersRepository } from '../users/users.repository'
import { BusinessRolesRepository } from './business-roles.repository'
import { RoleReconciler } from './role-reconciler'

// Every status, not just 'active' — the same constant, with the same
// reasoning, that `ReconciliationJob` (outbox/reconciliation.job.ts) and
// `TargetReconciliationJob` (outbox/target-reconciliation.job.ts) already
// carry: a pending/suspended/deactivated person is still an in-scope
// principal whose DESIRED entitlement set is a fact this engine must be able
// to assert. Here it matters even more literally than it does for those two.
// A business role's formula may condition on `status` itself, so a person who
// stops being active stops matching — and the ONLY thing that then revokes
// the rows that role granted them is a pass that VISITS them. Walking only
// active users would leave a deactivated leaver holding every role-derived
// group they had on the day they left, which is precisely the failure this
// sub-project exists to remove.
//
// Duplicated here rather than imported, for the same reason
// `TargetReconciliationJob` duplicates it rather than importing it from
// `ReconciliationJob`: a deliberate, tiny, zero-risk repeat of one constant,
// not a dependency on a sibling job's internals (this project's established
// convention for small pure/constant duplication across sibling modules —
// e.g. `attributesEqual`/`sameNameSet` in three separate `connectors/`/
// `outbox/` files already).
const ALL_USER_STATUSES: readonly UserStatus[] = ['pending', 'active', 'suspended', 'deactivated']

// Same internal pagination chunk size as `ReconciliationJob`'s and
// `TargetReconciliationJob`'s own walks — see those files' doc comments for
// why this is an internal batch size, not a client-facing limit. Nothing a
// caller passes can change it and no API surface exposes it.
const PAGE_SIZE = 200

/**
 * One user this sweep declined to touch, and the role that made it decline.
 *
 * A refusal is NOT an error and NOT a no-op: `RoleReconciler.reconcileUser`
 * returns it when `evaluateRoles` cannot understand some enabled role (a
 * field or operator written by a migration newer than the running binary),
 * and it means nothing was granted AND nothing was revoked for that person.
 * That is the correct conservative answer, but it is also a state somebody
 * has to fix, so it is carried out of the sweep as DATA rather than left as
 * a `console.warn` in a log nobody reads — exactly the correction finding M5
 * (docs/archive/audits/audit-integrity.md) forced on `LifecycleJob.run`,
 * whose `LifecycleReport.skipped` this mirrors deliberately.
 */
export interface RoleReconciliationRefusal {
  userId: string
  roleId: string
  roleName: string
  reason: string
}

/**
 * The counts this task's own brief names (`scanned`/`changed`/`refused`),
 * plus the two lists that make a non-zero count actionable rather than
 * merely alarming.
 *
 * `changed` counts USERS whose entitlements moved, not rows moved: one
 * person gaining three groups is one change, because the operator question
 * this number answers ("how much of the directory did this pass move?") is a
 * question about people.
 */
export interface RoleReconciliationReport {
  /** Every user visited, across every status. */
  scanned: number
  /** Users for whom at least one group or target row was added or removed. */
  changed: number
  /** Users left untouched because some enabled role was unevaluable. Equals `refusals.length`. */
  refused: number
  /** The refusals themselves — never empty when `refused > 0`. */
  refusals: RoleReconciliationRefusal[]
  /** Users selected by the walk that no longer existed by the time their own transaction opened. */
  skipped: string[]
}

/**
 * The periodic sweep that makes business-role entitlements EVENTUALLY
 * correct for everybody, independent of whether anything happened to notify
 * the engine — Milestone 17, Task 10.
 *
 * Task 9's per-write re-evaluation is the fast path: change someone's job
 * title and their roles move within that same transaction. This job is the
 * slow, unconditional backstop for everything that path cannot see — a role
 * definition edited, a role enabled or disabled, a group deleted underneath a
 * grant, a row changed by a migration or by hand in psql, or simply a bug in
 * the fast path. It is the same relationship `ReconciliationJob` has to the
 * outbox and `TargetReconciliationJob` has to `SyncWorker`, and it is why
 * both of those exist despite their event-driven counterparts working.
 *
 * ONE TRANSACTION PER USER — the single most important structural decision
 * here, and the reason this class walks users itself instead of handing the
 * whole directory to `reconcileUser` inside one big `db.transaction`:
 *
 *  - a single transaction spanning a whole directory holds row locks on
 *    `group_user_members` for as long as the sweep runs (minutes, at
 *    directory scale), blocking every ordinary group write the API is trying
 *    to serve while it does so; and
 *  - it would turn ONE unevaluable role into a total failure. Refusal is a
 *    per-user answer. Under one shared transaction the only honest response
 *    to a refusal is to abort and roll back every correct change the sweep
 *    had already made for everybody else — so a single malformed condition
 *    row would permanently prevent the whole directory from ever converging.
 *    Per-user transactions make a refusal exactly as narrow as it really is:
 *    one person skipped, counted, named in the report, and the sweep
 *    continues.
 *
 * CONNECTION DISCIPLINE: the walk itself (`usersRepository.list`) runs on the
 * pooled handle with NO transaction open, and everything that needs the
 * transaction runs inside it on that `tx` and nothing else. No query is ever
 * issued against the pool while this class holds a transaction — that is
 * finding C1 (docs/archive/audits/audit-integrity.md), which deadlocked this
 * API for real and is regression-guarded by test/pool-exhaustion.spec.ts.
 * `reconcileRole` resolves the role it is named for ONCE, before the loop and
 * outside every transaction, for the same reason `LifecycleJob` resolves its
 * sensitive-attribute set once per pass.
 *
 * IDEMPOTENCE is inherited, not re-implemented: `reconcileUser` writes the
 * DIFFERENCE between desired and actual entitlements and returns empty lists
 * when there is none, so a second run over an unchanged directory finds
 * nothing to write, counts `changed: 0`, and writes no audit rows. This job
 * adds no state of its own — no cursor, no "last swept at", nothing that
 * makes run N+1 behave differently from run N.
 */
@Injectable()
export class RoleReconciliationJob {
  constructor(
    @Inject(RoleReconciler) private readonly reconciler: RoleReconciler,
    @Inject(UsersRepository) private readonly usersRepository: UsersRepository,
    @Inject(BusinessRolesRepository) private readonly roles: BusinessRolesRepository,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Sweep the entire directory. The periodic entrypoint — `pnpm run
   * role-reconcile`, and any future scheduled unit alongside
   * `deploy/systemd/idm-lifecycle.timer`.
   */
  async reconcileAll(now: Date): Promise<RoleReconciliationReport> {
    return this.sweep('every enabled role', now)
  }

  /**
   * Sweep the directory on behalf of ONE role — what a controller enqueues
   * after publishing, enabling or disabling that role (Task 11).
   *
   * It deliberately does NOT narrow the walk to "users the role could
   * plausibly touch". It walks every user and lets the evaluator decide,
   * byte-for-byte as `reconcileAll` does, because the interesting population
   * for a role that just CHANGED is precisely the people who no longer match
   * it — and any pre-filter clever enough to find those would have to
   * re-implement the evaluator against the role's OLD definition, which is
   * gone. Worse, `reconcileUser` evaluates every enabled role at once (a
   * person's entitlements are the union of all of them), so a narrowed walk
   * could not produce a correct answer even for the users it did visit. The
   * parameter exists so a role change enqueues a bounded, NAMEABLE unit of
   * work — one an operator can point at in a log — not so it can skip
   * evaluation.
   *
   * The role is resolved here, once, before the loop and outside every
   * transaction: it gives an unknown id a clean `NotFoundError` before the
   * sweep does any work at all, and it puts the role's NAME in every log line
   * this pass emits without a per-user lookup.
   */
  async reconcileRole(roleId: string, now: Date): Promise<RoleReconciliationReport> {
    const role = await this.roles.findById(roleId)
    if (role === null) {
      throw new NotFoundError('business role', roleId)
    }

    return this.sweep(`role "${role.name}" (${roleId})`, now)
  }

  /**
   * The walk both entrypoints share. `label` is for the operator only —
   * nothing about the work performed depends on it, which is exactly the
   * point `reconcileRole`'s doc comment makes.
   */
  private async sweep(label: string, now: Date): Promise<RoleReconciliationReport> {
    let scanned = 0
    let changed = 0
    const refusals: RoleReconciliationRefusal[] = []
    const skipped: string[] = []

    for (const status of ALL_USER_STATUSES) {
      let offset = 0
      for (;;) {
        // On the pool, with NO transaction open — see this class's own
        // "CONNECTION DISCIPLINE" note. The offset walk is stable despite the
        // writes happening between pages: `reconcileUser` writes only
        // `group_user_members`/`user_target_accounts`/`audit_log`/`outbox`,
        // never `users`, so it can change neither a row's `status` (this
        // walk's filter) nor its `username` (its sort key), and therefore
        // cannot move a user between pages behind the sweep's back.
        const page = await this.usersRepository.list({ status, limit: PAGE_SIZE, offset, scopePaths: null })
        if (page.length === 0) {
          break
        }

        for (const user of page) {
          scanned += 1

          let outcome
          try {
            // ONE transaction per user, and `reconcileUser` runs every read
            // and write it makes on this `tx`.
            outcome = await this.db.transaction((tx) => this.reconciler.reconcileUser(tx, user.id, null, now))
          } catch (error) {
            // The row moved on between the SELECT above and this transaction
            // — an ordinary race on a live directory, not a failure of this
            // pass. Recorded, not swallowed, exactly as `LifecycleJob`
            // records its own skips (finding M5). Anything else — a lost
            // connection, a constraint violation — is a real fault and
            // rethrows: a sweep that reports success while silently failing
            // over half the directory is worse than one that stops.
            if (error instanceof NotFoundError) {
              console.warn(`[role-reconcile] skipped ${user.id} — ${error.message}`)
              skipped.push(user.id)
              continue
            }
            throw error
          }

          if (outcome.status === 'refused') {
            // Counted AND carried out in the report, never merely logged, and
            // never fatal. See `RoleReconciliationRefusal`'s doc comment.
            refusals.push({
              userId: user.id,
              roleId: outcome.roleId,
              roleName: outcome.roleName,
              reason: outcome.reason,
            })
            console.warn(
              `[role-reconcile] refused to reconcile ${user.username} (${user.id}) — ` +
                `role "${outcome.roleName}" (${outcome.roleId}) is unevaluable: ${outcome.reason}`,
            )
            continue
          }

          if (
            outcome.groupsAdded.length > 0 ||
            outcome.groupsRemoved.length > 0 ||
            outcome.targetsAdded.length > 0 ||
            outcome.targetsRemoved.length > 0
          ) {
            changed += 1
          }
        }

        if (page.length < PAGE_SIZE) {
          break
        }
        offset += PAGE_SIZE
      }
    }

    console.log(
      `[role-reconcile] swept ${label}: scanned ${scanned}, changed ${changed}, ` +
        `refused ${refusals.length}, skipped ${skipped.length}`,
    )

    return { scanned, changed, refused: refusals.length, refusals, skipped }
  }
}
