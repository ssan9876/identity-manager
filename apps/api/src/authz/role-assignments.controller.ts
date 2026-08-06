import { Body, Controller, Delete, Inject, Param, Post, Req, UseGuards } from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { JwtGuard } from '../auth/jwt.guard'
import { AuditWriter } from '../audit/audit.writer'
import { DB_CLIENT } from '../common/db.token'
import { NotFoundError } from '../common/errors'
import { parseBody } from '../common/http/parse-body'
import { parseId } from '../common/http/parse-id'
import * as schema from '../db/schema/index'
import { OutboxWriter } from '../outbox/outbox.writer'
import { ALL_ROLE_KEYS, type RoleKey } from './actions'
import { PermissionGuard, type AuthorizedRequest } from './permission.guard'
import { PrivilegeGuards } from './privilege.guards'
import { RequirePermission } from './require-permission.decorator'
import { RoleAssignmentsRepository, type RoleAssignment } from './role-assignments.repository'

// ALL_ROLE_KEYS is typed `readonly RoleKey[]`, not a literal tuple, and
// `z.enum` needs `[string, ...string[]]`. The cast merely re-asserts a shape
// already true at runtime (five string literals, always non-empty) — same
// style as actions.ts's own `Object.create(null) as Record<RoleKey, ...>`
// casts, not a claim unchecked by anything: ALL_ROLE_KEYS and RoleKey are
// defined two lines apart in the same file and can't drift silently.
const roleKeySchema = z.enum(ALL_ROLE_KEYS as [RoleKey, ...RoleKey[]])

const assignRoleBodySchema = z
  .object({
    roleKey: roleKeySchema,
    // Omitted or explicit null both mean GLOBAL — matches
    // RoleAssignmentsRepository.AssignRoleInput's own `?: string | null`.
    scopeOrgUnitId: z.string().uuid().nullable().optional(),
  })
  .strict()

/**
 * Builds an audit `before`/`after` payload from explicitly named fields —
 * never `{ ...assignment }`. Same reasoning as every other controller's
 * snapshot helper this milestone (see UsersController.snapshotUser): a
 * spread would silently carry forward any column added to `role_assignments`
 * later into an append-only log a leak can never be removed from. `id` is
 * omitted (it is already the audit row's own `resourceId`) and `createdAt`
 * is omitted as bookkeeping that adds nothing to a before/after diff.
 */
function snapshotRoleAssignment(assignment: RoleAssignment): Record<string, unknown> {
  return {
    userId: assignment.userId,
    roleKey: assignment.roleKey,
    scopeOrgUnitId: assignment.scopeOrgUnitId,
  }
}

/**
 * Role assignment endpoints — the most security-sensitive writes in the
 * system, because getting them wrong is privilege escalation, not merely
 * disclosure.
 *
 * A `role_assignment` is its OWN first-class resource — it has its own `id`,
 * returned by POST and addressed directly by DELETE's `:assignmentId` —
 * unlike group membership (a pure edge with no id of its own, anchored on
 * the parent group; see GroupsController's doc comment on `requireGroup`).
 * So every audit row below anchors on the ASSIGNMENT's own id
 * (`resourceType: 'role_assignment'`), the same convention
 * UsersController/GroupsController/OrgUnitsController already use for THEIR
 * own entities, extended to this one — not on the target user's id.
 *
 * THE THREE CHECKS every route below runs, all load-bearing, none subsuming
 * another (task-4-brief.md, citing the M3a review):
 *   1. `PermissionGuard` (class-level, below): does this actor hold
 *      `role:assign` ANYWHERE at all? Only `super_admin` does, in today's
 *      static catalog (see ROLE_PERMISSIONS in actions.ts) — every other
 *      role is denied entry to every route on this controller before a
 *      single query runs.
 *   2. `PrivilegeGuards.assertCanAssignRole(actor, roleKey, scopeOrgUnitId)`:
 *      may THIS actor grant THIS role at THIS scope? A SCOPED holding must
 *      never produce a GLOBAL grant — that is the escalation path that turns
 *      a departmental account into a domain-wide one.
 *   3. `PrivilegeGuards.assertCanModifyPrincipal(actor, targetUserId)`: does
 *      the TARGET outrank the actor? Independent of scope entirely — a
 *      `help_desk` scoped to Sales must not be able to touch a GLOBAL
 *      `super_admin` who happens to sit in Sales.
 * Milestone 3a proved (2) and (3) are independent: rank alone permits peer
 * help-desks in disjoint subtrees to touch each other; scope alone permits
 * the Sales-super_admin-in-Sales escalation above. Shipping only some of
 * these three is the bug this controller exists not to have — see
 * role-assignments.write.spec.ts's file header for which rejection paths
 * are actually reachable through THIS controller given today's role
 * catalog, and why.
 */
@Controller('users')
@UseGuards(JwtGuard, PermissionGuard)
export class RoleAssignmentsController {
  constructor(
    @Inject(RoleAssignmentsRepository) private readonly roleAssignments: RoleAssignmentsRepository,
    @Inject(PrivilegeGuards) private readonly privileges: PrivilegeGuards,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(OutboxWriter) private readonly outboxWriter: OutboxWriter,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Both privilege checks run BEFORE the transaction opens: `roleKey` and
   * `scopeOrgUnitId` come straight from the request body and the target
   * `userId` comes straight from the URL — nothing has to be loaded from the
   * database first for either check to evaluate, exactly like
   * UsersController.create's pre-transaction `assertCanIn` (see its doc
   * comment). A rejection from either throws before the transaction ever
   * opens, so there is nothing to roll back and no audit row is ever
   * written. `RoleAssignmentsRepository.assign` still performs its own
   * existence checks (target user, scope org unit) inside the transaction,
   * so a bogus id 404s cleanly rather than 500ing, same as every other
   * write endpoint this milestone.
   */
  @Post(':id/roles')
  @RequirePermission('role:assign')
  async assign(
    @Param('id') rawUserId: string,
    @Body() body: unknown,
    @Req() request: AuthorizedRequest,
  ): Promise<RoleAssignment> {
    const userId = parseId(rawUserId)
    const parsed = parseBody(assignRoleBodySchema, body)
    const scopeOrgUnitId = parsed.scopeOrgUnitId ?? null

    await this.privileges.assertCanAssignRole(request.actor, parsed.roleKey, scopeOrgUnitId)
    await this.privileges.assertCanModifyPrincipal(request.actor, userId)

    return this.db.transaction(async (tx) => {
      const assignment = await this.roleAssignments.assign(
        { userId, roleKey: parsed.roleKey, scopeOrgUnitId },
        tx,
      )

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'role:assign',
        resourceType: 'role_assignment',
        resourceId: assignment.id,
        before: null,
        after: snapshotRoleAssignment(assignment),
      })

      // aggregateType 'user', not a bespoke 'role_assignment' type (there is
      // no such value in the outbox vocabulary): Keycloak cares about the
      // resulting USER state (their group/role membership as a whole), not
      // our internal assignment row — see this controller's own file-level
      // doc comment on why the audit anchor and the outbox anchor
      // deliberately differ here (audit: the assignment's own id; outbox:
      // the target user's id).
      await this.outboxWriter.record(tx, {
        aggregateType: 'user',
        aggregateId: userId,
        eventType: 'updated',
        payload: { ...snapshotRoleAssignment(assignment), action: 'role:assign' },
      })

      return assignment
    })
  }

  /**
   * Loads the CURRENT assignment inside the transaction FIRST — unlike
   * `assign` above, both privilege checks here need fields off that row
   * (`roleKey`, `scopeOrgUnitId`) that only exist once it's loaded, so this
   * cannot check-then-open; it must load-then-check, exactly like
   * UsersController.update. Revoking demands the SAME privilege as granting
   * would have required, checked against the grant being REMOVED, not
   * against whatever the caller might claim: an actor who could not have
   * created this exact grant (wrong role held, wrong scope, or a target
   * that outranks them) must not be able to destroy it either, or
   * revocation becomes a side door around assign's own narrowing — e.g. a
   * help_desk-equivalent scoped to Sales stripping a GLOBAL super_admin's
   * assignment despite never being able to grant `super_admin` globally
   * themselves.
   *
   * `:assignmentId` must belong to `:id` — a well-formed assignment id that
   * exists but belongs to a DIFFERENT user 404s exactly like a nonexistent
   * one, never silently acting on it through the "wrong" URL.
   *
   * Both privilege checks below are passed `tx` explicitly, same finding-C1
   * reason as UsersController.update/deactivate (see their doc comments):
   * this handler already holds one pool connection for `tx`, and letting
   * either check fall back to its pooled default would check out a second
   * one for the lifetime of a query that runs while the first is still
   * held.
   */
  @Delete(':id/roles/:assignmentId')
  @RequirePermission('role:assign')
  async revoke(
    @Param('id') rawUserId: string,
    @Param('assignmentId') rawAssignmentId: string,
    @Req() request: AuthorizedRequest,
  ): Promise<{ id: string; userId: string; roleKey: RoleKey; scopeOrgUnitId: string | null }> {
    const userId = parseId(rawUserId)
    const assignmentId = parseId(rawAssignmentId, 'assignmentId')

    return this.db.transaction(async (tx) => {
      const current = await this.roleAssignments.findById(assignmentId, tx)
      if (current === null || current.userId !== userId) {
        throw new NotFoundError('role assignment', assignmentId)
      }

      await this.privileges.assertCanAssignRole(
        request.actor,
        current.roleKey,
        current.scopeOrgUnitId,
        tx,
      )
      await this.privileges.assertCanModifyPrincipal(request.actor, current.userId, tx)

      await this.roleAssignments.revoke(assignmentId, tx)

      await this.auditWriter.record(tx, {
        actorUserId: request.actor.userId,
        action: 'role:revoke',
        resourceType: 'role_assignment',
        resourceId: assignmentId,
        before: snapshotRoleAssignment(current),
        after: null,
      })

      await this.outboxWriter.record(tx, {
        aggregateType: 'user',
        aggregateId: userId,
        eventType: 'updated',
        payload: { ...snapshotRoleAssignment(current), action: 'role:revoke' },
      })

      return {
        id: current.id,
        userId: current.userId,
        roleKey: current.roleKey,
        scopeOrgUnitId: current.scopeOrgUnitId,
      }
    })
  }
}
