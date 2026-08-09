import { Inject, Injectable } from '@nestjs/common'
import { and, eq, inArray } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { AuditWriter } from '../audit/audit.writer'
import { NotFoundError } from '../common/errors'
import type { ConnectorTarget } from '../connectors/connector'
import * as schema from '../db/schema/index'
import { groupUserMembers } from '../db/schema/group-members'
import { groups } from '../db/schema/groups'
import { orgUnits } from '../db/schema/org-units'
import { outboxEvents } from '../db/schema/outbox-events'
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

/**
 * The WIDER handle: the pooled client, or an open transaction (a
 * `PgTransaction` structurally satisfies the pooled shape — see `DbHandle`
 * above, which deliberately narrows the other way).
 *
 * Only READ paths take this. `reconcileUser` and everything it writes stay
 * on `DbHandle`, so no write can ever be handed the pool by accident while
 * a caller's transaction sits open (finding C1,
 * docs/archive/audits/audit-integrity.md; test/pool-exhaustion.spec.ts).
 */
export type ReadHandle = NodePgDatabase<typeof schema>

/** One role, named — the unit `justifiedBy` is a list of. */
export interface JustifyingRole {
  roleId: string
  roleName: string
}

/**
 * Which enabled roles currently justify each entitlement a user holds —
 * Milestone 17, Task 12's answer to "why does this person have this?".
 *
 * Keyed by groupId / target rather than returned as a flat list, because the
 * caller is joining it onto rows it read from `group_user_members` and
 * `user_target_accounts` and needs a lookup, not a scan.
 *
 * The refusal arm carries the SAME three fields `ReconcileOutcome`'s does,
 * and for the same reason: `evaluateRoles` refuses wholesale on the first
 * role it cannot understand (see its own doc comment), so there is exactly
 * one role and one reason to name.
 */
export type Justification =
  | { evaluable: true; groups: Map<string, JustifyingRole[]>; targets: Map<ConnectorTarget, JustifyingRole[]> }
  | { evaluable: false; roleId: string; roleName: string; reason: string }

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
/** `map.get(key) ?? []`, appended to and written back — one line, twice used. */
function appendJustifier<K>(map: Map<K, JustifyingRole[]>, key: K, justifier: JustifyingRole): void {
  const existing = map.get(key)
  if (existing === undefined) {
    map.set(key, [justifier])
    return
  }
  existing.push(justifier)
}

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
    // Task 5 of the organizations milestone: the roles considered are the
    // ones belonging to THIS USER's organization. Taken from the user, never
    // from the actor — the actor may be a platform operator sitting in
    // master while acting on another tenant's person, and evaluating
    // master's formulas against that person is exactly the cross-tenant
    // grant this scoping exists to prevent.
    const roles = await this.roles.listEnabledForEvaluation(user.organizationId, tx)
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
      // Task 4 of the organizations milestone: a membership edge carries its
      // own organization_id, and it comes from the GROUP — never from the
      // actor, who on this path is whoever triggered the re-evaluation and
      // may be a platform operator in master, and never from the user, whose
      // organization is what the composite FK is there to CHECK rather than
      // to assume. Read on the caller's `tx`, like every other query in this
      // class (finding C1).
      const grantedGroups = await tx
        .select({ id: groups.id, organizationId: groups.organizationId })
        .from(groups)
        .where(inArray(groups.id, groupsToAdd))
      const organizationByGroupId = new Map(grantedGroups.map((g) => [g.id, g.organizationId]))

      const rows: (typeof groupUserMembers.$inferInsert)[] = groupsToAdd.map((groupId) => {
        const organizationId = organizationByGroupId.get(groupId)
        if (organizationId === undefined) {
          // The group vanished between evaluation and this write. Failing
          // loudly beats inventing an organization for the edge.
          throw new NotFoundError('group', groupId)
        }
        return {
          groupId,
          userId,
          organizationId,
          grantSource: 'business_role' as const,
          grantedBy: actorUserId,
          grantedAt: now,
        }
      })
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

      // MILESTONE 18, TASK 14 - losing an account entitlement DISABLES the
      // account; it never merely stops managing it. An account silently
      // dropped from management stays ENABLED in the target forever, which
      // is precisely the orphaned account a governance sub-project would
      // later have to go and find. Commit 92055ee established this rule for
      // the mail connector's aliases; this generalises it to every target.
      //
      // WRITTEN DIRECTLY, not through `this.outboxWriter.record`, and this
      // is the one place in this codebase that bypasses it. `record` decides
      // fan-out by reading `user_target_accounts` for this very user
      // (Milestone 18, Task 13) - and the rows it would read were deleted
      // three lines above, in this same transaction. So the generic writer
      // would look, correctly, find no entitlement, and send nothing at all
      // for exactly the target that most needs an event. The row shape below
      // therefore mirrors what `record` builds, with `target` pinned to the
      // specific revoked target instead of derived from a fan-out.
      //
      // SAME TRANSACTION as the delete, deliberately: a rollback must lose
      // both or neither. An entitlement deleted without its disable is a
      // live account nobody manages; a disable without the delete is an
      // account disabled for a reason that no longer exists.
      //
      // `eventType` is 'status_changed' - the SAME type
      // `UsersController.deactivate` already emits for a disable (there is
      // no 'deleted'/'disabled' event type; see db/schema/outbox-events.ts's
      // own doc comment on `outboxEventType`). Nothing downstream reads
      // `payload` as a delta: `SyncWorker` re-derives desired state from
      // Postgres, where this user now has no entitlement for this target and
      // therefore - on an `entitled_only` target - a desired `enabled:
      // false` (see `SyncWorker.buildDesiredUser`'s own Task 14 note). On an
      // `all_users` target the same event is a harmless re-assertion of
      // desired state, since an account there is desired for everyone
      // regardless of what any role granted; emitting it unconditionally is
      // what keeps this code free of a second, drifting copy of the
      // "should this account exist" rule.
      await tx.insert(outboxEvents).values(
        targetsToRemove.map((target) => ({
          aggregateType: 'user' as const,
          aggregateId: userId,
          eventType: 'status_changed' as const,
          payload: { userId, target, action: 'business_role.revoke', entitled: false },
          target,
        })),
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
   * READ-ONLY. Which enabled roles currently hold this user, and therefore
   * which of them justify each group membership and target account they
   * have — Milestone 17, Task 12 (`GET /users/:id/entitlements`).
   *
   * Writes NOTHING and opens NO transaction, deliberately on both counts.
   * The screen this feeds is diagnostic; an operator asking "why does this
   * person have this?" must not cause a reconcile as a side effect of
   * looking, and a read that took a transaction would then be holding a
   * pooled connection across the role load as well (finding C1,
   * docs/archive/audits/audit-integrity.md). Every query below runs on the
   * handle the caller passed and returns its connection before the next one
   * starts.
   *
   * It answers with the SAME inputs `reconcileUser` uses — the same
   * `EvaluableUser`, the same `listEnabledForEvaluation`, the same
   * `evaluateRoles` — because a "why" screen that disagrees with what
   * reconciliation would actually do is worse than no screen. That
   * includes the refusal: ONE unevaluable role makes the whole evaluation
   * unevaluable, so this returns a refusal rather than a partial
   * attribution, exactly as the reconciler does. The caller renders the
   * rows anyway with the refusal attached (see `UsersController.
   * entitlements`) — the person's memberships are a fact regardless of
   * whether the engine can currently explain them.
   *
   * Attribution is exact rather than blanket: a role justifies a row only
   * if the user holds that role AND that role grants that specific group or
   * target. `matchedRoleIds` supplies the first half and each role's own
   * `grants` the second, so a held role that grants some OTHER group is not
   * listed against this one.
   *
   * `grantSource` is NOT consulted here at all. This method answers "which
   * roles would want this?", and the caller — which is the thing that knows
   * a `manual` row belongs to the human who made it — decides what to do
   * with the answer.
   */
  async explainUser(db: ReadHandle, userId: string, now: Date): Promise<Justification> {
    const user = await this.loadEvaluableUser(db, userId)
    const roles = await this.roles.listEnabledForEvaluation(user.organizationId, db)
    const evaluation = evaluateRoles(user, roles, now)

    if (!evaluation.evaluable) {
      return {
        evaluable: false,
        roleId: evaluation.roleId,
        roleName: evaluation.roleName,
        reason: evaluation.reason,
      }
    }

    const heldRoleIds = new Set(evaluation.matchedRoleIds)
    const groups = new Map<string, JustifyingRole[]>()
    const targets = new Map<ConnectorTarget, JustifyingRole[]>()

    for (const role of roles) {
      if (!heldRoleIds.has(role.id)) continue
      const justifier: JustifyingRole = { roleId: role.id, roleName: role.name }

      for (const grant of role.grants) {
        if (grant.kind === 'group_membership' && grant.groupId !== null) {
          appendJustifier(groups, grant.groupId, justifier)
        }
        if (grant.kind === 'target_account' && grant.target !== null) {
          appendJustifier(targets, grant.target, justifier)
        }
      }
    }

    // Stable, name-first order. `listEnabledForEvaluation` selects without
    // an ORDER BY, so Postgres is free to hand back two roles in either
    // order on two otherwise identical requests; an operator comparing one
    // screenshot against another should not see the justification list
    // reshuffle for no reason. Ties broken on id so the order is TOTAL —
    // role names are unique today (business_roles_name_idx), and this stays
    // deterministic if that ever stops being true.
    for (const justifiers of [...groups.values(), ...targets.values()]) {
      justifiers.sort((a, b) => a.roleName.localeCompare(b.roleName) || a.roleId.localeCompare(b.roleId))
    }

    return { evaluable: true, groups, targets }
  }

  /**
   * `users` itself carries only the `orgUnitId` FK, never the ltree path
   * (same fact `UsersRepository.scopeFilter`'s own doc comment relies on) —
   * this joins `org_units` for `orgUnitPath` in ONE query on the caller's
   * handle, rather than two separate round trips through two repositories.
   *
   * Typed `ReadHandle`, not `DbHandle`: `reconcileUser` passes its caller's
   * open transaction (a `PgTransaction`, which structurally satisfies the
   * pooled shape), while `explainUser` — a READ-ONLY caller that opens no
   * transaction at all — passes the pooled handle. Widening here is what
   * lets both share one query; nothing about the query itself differs.
   */
  private async loadEvaluableUser(
    db: ReadHandle,
    userId: string,
  ): Promise<EvaluableUser & { organizationId: string }> {
    const [row] = await db
      .select({
        id: users.id,
        // NOT part of `EvaluableUser` — no condition may name it, and
        // widening the evaluator's input type would invite one to. It is
        // carried alongside purely to pick WHICH roles are in play (Task 5).
        organizationId: users.organizationId,
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
