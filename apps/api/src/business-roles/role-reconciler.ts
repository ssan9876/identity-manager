import { Inject, Injectable } from '@nestjs/common'
import { and, eq, inArray } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { AuditWriter } from '../audit/audit.writer'
import { NotFoundError } from '../common/errors'
import type { ConnectorTarget } from '../connectors/connector'
import * as schema from '../db/schema/index'
import { groupUserMembers } from '../db/schema/group-members'
import { orgUnits } from '../db/schema/org-units'
import { userTargetAccounts } from '../db/schema/user-target-accounts'
import { users } from '../db/schema/users'
import { OutboxWriter } from '../outbox/outbox.writer'
import { BusinessRolesRepository } from './business-roles.repository'
import { ATTRIBUTES_FIELD, CONDITION_FIELDS, evaluateRoles, type EvaluableUser } from './role-evaluator'

/**
 * The user fields whose change re-evaluates role membership (Milestone 17,
 * Task 9). `UsersController`'s PATCH handler skips the reconciler entirely
 * when a request names none of these — an email or display-name change must
 * not walk every role — and calls it when a request names any.
 *
 * DERIVED, not restated. `CONDITION_FIELDS` is the evaluator's own allowlist
 * (`CONDITION_FIELD_EXTRACTORS`' key set, role-evaluator.ts) and
 * `ATTRIBUTES_FIELD` is the column behind its open-ended `attributes.<key>`
 * form. The coupling is therefore STRUCTURAL: a nameable field cannot be
 * added to the evaluator without this trigger list growing with it in the
 * same edit, because there is only one list. A field that can be named in a
 * formula but does not trigger re-evaluation when it changes is a mover whose
 * access silently fails to follow them — the exact failure this sub-project
 * exists to remove — and holding that property depends on no reviewer
 * noticing anything.
 *
 * test/business-roles.spec.ts additionally pins the resulting set against the
 * literal list the plan specifies, so WIDENING the evaluator's allowlist stays
 * a deliberate, visible act rather than a silent one.
 */
export const REEVALUATION_FIELDS: readonly string[] = Object.freeze([...CONDITION_FIELDS, ATTRIBUTES_FIELD])

/**
 * The live transaction handle passed to a `db.transaction(async (tx) => ...)`
 * callback — deliberately narrower than "the pooled handle or a transaction
 * handle" (see `AuditWriter.record`'s own `DbHandle` for the full mechanical
 * explanation: `PgTransaction` structurally extends the pooled
 * `NodePgDatabase` shape, so this type rejects the pooled handle at compile
 * time). Its OWN declaration, not imported from `audit/audit.writer.ts` or
 * `outbox/outbox.writer.ts` even though the three are structurally
 * identical — `business-roles`, `audit` and `outbox` are sibling modules,
 * none depending on the others, each narrowing the pool away for the same
 * reason.
 */
export type DbHandle = Parameters<Parameters<NodePgDatabase<typeof schema>['transaction']>[0]>[0]

export type ReconcileOutcome =
  | {
      status: 'applied'
      groupsAdded: string[]
      groupsRemoved: string[]
      targetsAdded: ConnectorTarget[]
      targetsRemoved: ConnectorTarget[]
    }
  | { status: 'refused'; roleId: string; roleName: string; reason: string }

/**
 * Diffs one user's desired entitlements — the union of every grant made by
 * every ENABLED role they currently hold, per `evaluateRoles` — against
 * what they actually have in `group_user_members` and `user_target_accounts`,
 * and writes exactly the difference.
 *
 * THE central safety rule, restated because nothing else in this file
 * matters if this is wrong: a row is revoked ONLY when its `grant_source`
 * is `business_role`. A `manual` row — one a human granted by hand, through
 * the ordinary group/target APIs — is never touched by this class, on ANY
 * path, for ANY reason. A row that already exists for a desired
 * (user, group) or (user, target) pair — from EITHER source — already
 * satisfies that half of the desired state, so it is never re-inserted
 * either; only a MISSING row is added, and only a `business_role` row that
 * is no longer desired is removed. Four consequences follow, each asserted
 * by test/business-roles.spec.ts:
 *  - a `manual` row quietly absorbs a role's want, and keeps absorbing it
 *    even after the role stops matching;
 *  - a hand-removed role-derived row is re-added on the next pass;
 *  - two roles justifying the same group produce ONE row, which survives
 *    either role (but not both) ceasing to match;
 *  - disabling a role revokes its rows, because `evaluateRoles` is only
 *    ever given ENABLED roles (`BusinessRolesRepository.
 *    listEnabledForEvaluation`).
 *
 * CONNECTION DISCIPLINE: every read and write below runs on the CALLER's
 * own `tx` — never a second, independently-checked-out pooled connection.
 * This project has previously deadlocked its own connection pool exactly
 * that way: opening a transaction and then, inside it, calling something
 * that queried the pool instead of the open transaction (finding C1,
 * docs/archive/audits/audit-integrity.md; regression-guarded by
 * test/pool-exhaustion.spec.ts). `reconcileUser` is always reachable from
 * inside some OTHER caller's already-open transaction (Task 9's per-write
 * re-evaluation, Task 10's sweep job), so `BusinessRolesRepository.
 * listEnabledForEvaluation` is called with `tx` explicitly rather than
 * left to default to its own injected pooled handle.
 */
@Injectable()
export class RoleReconciler {
  constructor(
    @Inject(BusinessRolesRepository) private readonly roles: BusinessRolesRepository,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(OutboxWriter) private readonly outboxWriter: OutboxWriter,
  ) {}

  async reconcileUser(
    tx: DbHandle,
    userId: string,
    actorUserId: string | null,
    now: Date,
  ): Promise<ReconcileOutcome> {
    const user = await this.loadEvaluableUser(tx, userId)
    const roles = await this.roles.listEnabledForEvaluation(tx)
    const evaluation = evaluateRoles(user, roles, now)

    // Refusal writes NOTHING — not a partial grant, not a partial revoke.
    // A single unevaluable role makes the WHOLE evaluation unevaluable (see
    // evaluateRoles' own doc comment), and nothing below this line — no
    // read of current membership, no insert, no delete, no audit row, no
    // outbox event — may run until an evaluable answer exists.
    if (!evaluation.evaluable) {
      return {
        status: 'refused',
        roleId: evaluation.roleId,
        roleName: evaluation.roleName,
        reason: evaluation.reason,
      }
    }

    const currentGroups = await tx.select().from(groupUserMembers).where(eq(groupUserMembers.userId, userId))
    const currentTargets = await tx.select().from(userTargetAccounts).where(eq(userTargetAccounts.userId, userId))

    // A row that already exists — from ANY source — satisfies the desire,
    // so it is not re-added. A manual row therefore quietly absorbs a
    // role's want, and keeps absorbing it after the role stops matching.
    const heldGroupIds = new Set(currentGroups.map((row) => row.groupId))
    const groupsToAdd = evaluation.groupIds.filter((id) => !heldGroupIds.has(id))

    const heldTargets = new Set(currentTargets.map((row) => row.target))
    const targetsToAdd = evaluation.targets.filter((target) => !heldTargets.has(target))

    // ONLY business_role rows are revocable — the single most important
    // rule in this module. The predicate is repeated in the SQL DELETE
    // below, not merely in this JavaScript filter: a hand-grant landing
    // between this read and that write must not be swept up by it.
    const desiredGroupIds = new Set(evaluation.groupIds)
    const groupsToRemove = currentGroups
      .filter((row) => row.grantSource === 'business_role' && !desiredGroupIds.has(row.groupId))
      .map((row) => row.groupId)

    const desiredTargets = new Set(evaluation.targets)
    const targetsToRemove = currentTargets
      .filter((row) => row.grantSource === 'business_role' && !desiredTargets.has(row.target))
      .map((row) => row.target)

    if (
      groupsToAdd.length === 0 &&
      groupsToRemove.length === 0 &&
      targetsToAdd.length === 0 &&
      targetsToRemove.length === 0
    ) {
      return { status: 'applied', groupsAdded: [], groupsRemoved: [], targetsAdded: [], targetsRemoved: [] }
    }

    if (groupsToAdd.length > 0) {
      const rows: (typeof groupUserMembers.$inferInsert)[] = groupsToAdd.map((groupId) => ({
        groupId,
        userId,
        grantSource: 'business_role',
        grantedBy: actorUserId,
        grantedAt: now,
      }))
      // onConflictDoNothing: belt-and-braces against a concurrent hand-grant
      // of this exact (user, group) pair landing between the read above and
      // this write — same idempotency posture as GroupsRepository.addUser.
      await tx.insert(groupUserMembers).values(rows).onConflictDoNothing()
    }

    if (groupsToRemove.length > 0) {
      await tx
        .delete(groupUserMembers)
        .where(
          and(
            eq(groupUserMembers.userId, userId),
            inArray(groupUserMembers.groupId, groupsToRemove),
            eq(groupUserMembers.grantSource, 'business_role'),
          ),
        )
    }

    if (targetsToAdd.length > 0) {
      const rows: (typeof userTargetAccounts.$inferInsert)[] = targetsToAdd.map((target) => ({
        target,
        userId,
        grantSource: 'business_role',
        grantedBy: actorUserId,
        grantedAt: now,
      }))
      await tx.insert(userTargetAccounts).values(rows).onConflictDoNothing()
    }

    if (targetsToRemove.length > 0) {
      await tx
        .delete(userTargetAccounts)
        .where(
          and(
            eq(userTargetAccounts.userId, userId),
            inArray(userTargetAccounts.target, targetsToRemove),
            eq(userTargetAccounts.grantSource, 'business_role'),
          ),
        )
    }

    // Full before/after snapshots (every source, not just business_role) —
    // the same "explicit named fields, not `{ ...row }`" discipline
    // GroupsController.snapshotGroup follows, applied to two sets instead
    // of one row. One row per pass that changed something; the early
    // return above already handles "none for a no-op".
    const afterGroupIds = new Set(heldGroupIds)
    for (const id of groupsToAdd) afterGroupIds.add(id)
    for (const id of groupsToRemove) afterGroupIds.delete(id)

    const afterTargets = new Set(heldTargets)
    for (const target of targetsToAdd) afterTargets.add(target)
    for (const target of targetsToRemove) afterTargets.delete(target)

    await this.auditWriter.record(tx, {
      actorUserId,
      action: 'business_role.reconcile',
      resourceType: 'user',
      resourceId: userId,
      before: { groupIds: [...heldGroupIds].sort(), targets: [...heldTargets].sort() },
      after: { groupIds: [...afterGroupIds].sort(), targets: [...afterTargets].sort() },
    })

    // Mirrors GroupsController's addMember/removeMember handlers exactly —
    // same aggregateType ('membership'), same eventType
    // ('membership_changed'), same payload shape ({ groupId, userId,
    // action }), anchored on the GROUP's id exactly like those handlers.
    // Nothing downstream of the outbox learns anything new: SyncWorker
    // reconciles by reading the CURRENT membership row straight from
    // Postgres, never by replaying this payload as a delta.
    for (const groupId of [...groupsToAdd, ...groupsToRemove]) {
      await this.outboxWriter.record(tx, {
        aggregateType: 'membership',
        aggregateId: groupId,
        eventType: 'membership_changed',
        payload: { groupId, userId, action: 'business_role.reconcile' },
      })
    }

    return {
      status: 'applied',
      groupsAdded: groupsToAdd,
      groupsRemoved: groupsToRemove,
      targetsAdded: targetsToAdd,
      targetsRemoved: targetsToRemove,
    }
  }

  /**
   * `users` itself carries only the `orgUnitId` FK, never the ltree path
   * (same fact `UsersRepository.scopeFilter`'s own doc comment relies on) —
   * this joins `org_units` for `orgUnitPath` in ONE query on the caller's
   * `tx`, rather than two separate round trips through two repositories.
   */
  private async loadEvaluableUser(tx: DbHandle, userId: string): Promise<EvaluableUser> {
    const [row] = await tx
      .select({
        id: users.id,
        status: users.status,
        jobTitle: users.jobTitle,
        location: users.location,
        orgUnitId: users.orgUnitId,
        orgUnitPath: orgUnits.path,
        attributes: users.attributes,
      })
      .from(users)
      .innerJoin(orgUnits, eq(users.orgUnitId, orgUnits.id))
      .where(eq(users.id, userId))
      .limit(1)

    if (!row) {
      throw new NotFoundError('user', userId)
    }

    return row
  }
}
