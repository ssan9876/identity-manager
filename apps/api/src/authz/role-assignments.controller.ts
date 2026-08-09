import { Body, Controller, Delete, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common'
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
import { UsersRepository } from '../users/users.repository'
import { ALL_ROLE_KEYS, type RoleKey } from './actions'
import { PermissionEngine } from './permission.engine'
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
 * THE FOUR CHECKS every route below runs, all load-bearing, none subsuming
 * another (task-4-brief.md, citing the M3a review; check 4 added post-launch
 * for finding H-1, docs/archive/audits/audit-authz.md):
 *   1. `PermissionGuard` (class-level, below): does this actor hold
 *      `role:assign` ANYWHERE at all? Only `super_admin` does, in today's
 *      static catalog (see ROLE_PERMISSIONS in actions.ts) — every other
 *      role is denied entry to every route on this controller before a
 *      single query runs.
 *   2. `PermissionEngine.assertCanIn(actor, 'role:assign', target.orgUnitId)`:
 *      may this actor reach the TARGET PRINCIPAL at all? This is the check
 *      H-1 found missing: `assertCanAssignRole` below validates the scope of
 *      the GRANT, never the location of the GRANTEE, and
 *      `assertCanModifyPrincipal` compares rank only — its own doc comment
 *      says explicitly that callers MUST additionally pair it with this
 *      exact call. Every other write endpoint in this codebase that loads a
 *      principal by id already pairs the two (users.controller.ts's
 *      update/deactivate, imports.controller.ts's row update); this
 *      controller — "the most security-sensitive writes in the system," per
 *      this file's own header — was the one place that didn't. Without it, a
 *      `super_admin` scoped to Sales could grant/revoke roles on principals
 *      in org units they cannot read, update, or even see.
 *   3. `PrivilegeGuards.assertCanAssignRole(actor, roleKey, scopeOrgUnitId)`:
 *      may THIS actor grant THIS role at THIS scope? A SCOPED holding must
 *      never produce a GLOBAL grant — that is the escalation path that turns
 *      a departmental account into a domain-wide one.
 *   4. `PrivilegeGuards.assertCanModifyPrincipal(actor, targetUserId)`: does
 *      the TARGET outrank the actor? Independent of scope entirely — a
 *      `help_desk` scoped to Sales must not be able to touch a GLOBAL
 *      `super_admin` who happens to sit in Sales.
 * Milestone 3a proved (3) and (4) are independent: rank alone permits peer
 * help-desks in disjoint subtrees to touch each other; scope alone permits
 * the Sales-super_admin-in-Sales escalation above. (2) is independent of
 * both: it answers "can the actor reach this PERSON," which neither of the
 * other two ever asks — (3) asks about the grant's scope, (4) asks about
 * rank, and a target can simultaneously be within-scope-of-the-grant AND
 * outrank-nothing AND still live in an org unit the actor cannot see.
 * Shipping only some of these four is the bug this controller exists not to
 * have — see role-assignments.write.spec.ts's file header for which
 * rejection paths are actually reachable through THIS controller given
 * today's role catalog, and why.
 */
@Controller('users')
@UseGuards(JwtGuard, PermissionGuard)
export class RoleAssignmentsController {
  constructor(
    @Inject(RoleAssignmentsRepository) private readonly roleAssignments: RoleAssignmentsRepository,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(PermissionEngine) private readonly engine: PermissionEngine,
    @Inject(PrivilegeGuards) private readonly privileges: PrivilegeGuards,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(OutboxWriter) private readonly outboxWriter: OutboxWriter,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Milestone 8, Task 4 — the admin console's Roles tab needs to SHOW a
   * target user's current grants before it can offer to revoke any of them,
   * and nothing before this task ever exposed `RoleAssignmentsRepository.
   * listForUser` over HTTP. Gated by the SAME `role:assign` permission as
   * every write route on this controller (`@RequirePermission` below), not
   * a broader `user:read` — this file's own header already establishes that
   * only `super_admin` holds `role:assign` in today's static catalog, and
   * "who holds what role, at what scope" is exactly the kind of privilege
   * information that permission is meant to gate, read or write alike. That
   * also keeps this route's authorization shape symmetric with `assign`/
   * `revoke`: a caller who could never grant or revoke a role for this
   * target cannot enumerate their existing grants either.
   *
   * Runs the SAME check 2 `assign`/`revoke` both run (finding H-1,
   * docs/archive/audits/audit-authz.md) — `assertCanIn(actor, 'role:assign',
   * target.orgUnitId)` — and nothing else: `assertCanAssignRole`/
   * `assertCanModifyPrincipal` answer "may I CHANGE this specific grant",
   * which has no meaning for a plain read. A target the actor cannot reach
   * under `role:assign` 403s here exactly as it would for `assign`, so this
   * route cannot be used to learn anything about a principal `assign`/
   * `revoke` would already refuse to disclose.
   */
  @Get(':id/roles')
  @RequirePermission('role:assign')
  async list(
    @Param('id') rawUserId: string,
    @Req() request: AuthorizedRequest,
  ): Promise<RoleAssignment[]> {
    const userId = parseId(rawUserId)

    const target = await this.users.findById(userId)
    if (target === null) {
      throw new NotFoundError('user', userId)
    }
    await this.engine.assertCanIn(request.actor, 'role:assign', target.orgUnitId)

    return this.roleAssignments.listForUser(userId)
  }

  /**
   * All three pre-transaction checks run BEFORE the transaction opens:
   * `roleKey` and `scopeOrgUnitId` come straight from the request body, and
   * the target `userId` comes straight from the URL — loading the target
   * user row is the only DB access any of the three needs, and it happens
   * once, up front, exactly like UsersController.create's pre-transaction
   * `assertCanIn` (see its doc comment). A rejection from any one throws
   * before the transaction ever opens, so there is nothing to roll back and
   * no audit row is ever written. `RoleAssignmentsRepository.assign` still
   * performs its own existence checks (target user, scope org unit) inside
   * the transaction, so a bogus id 404s cleanly rather than 500ing, same as
   * every other write endpoint this milestone.
   *
   * The `assertCanIn` call below is check 2 of the class doc comment's FOUR
   * CHECKS — finding H-1 (docs/archive/audits/audit-authz.md): it loads the
   * target user and asks "can this actor reach THIS PERSON at all," which
   * `assertCanAssignRole` (scope of the grant) and `assertCanModifyPrincipal`
   * (rank of the target) never ask between them. Ordered FIRST, before the
   * other two: there is no reason to reveal "you may not grant this role at
   * this scope" or "you may not touch a principal this senior" to an actor
   * who cannot reach the target user in the first place — a 404 for a
   * missing target, and now a 403 for an unreachable one, both happen before
   * either of the other two checks runs.
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

    const target = await this.users.findById(userId)
    if (target === null) {
      throw new NotFoundError('user', userId)
    }
    await this.engine.assertCanIn(request.actor, 'role:assign', target.orgUnitId)

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
   * All three checks below are passed `tx` explicitly, same finding-C1
   * reason as UsersController.update/deactivate (see their doc comments):
   * this handler already holds one pool connection for `tx`, and letting any
   * of them fall back to its pooled default would check out a second one
   * for the lifetime of a query that runs while the first is still held.
   *
   * The `assertCanIn` call is check 2 of the class doc comment's FOUR
   * CHECKS — finding H-1's revoke-direction symmetry
   * (docs/archive/audits/audit-authz.md): granting demands the actor can reach
   * the target user (see `assign` above); revoking must demand exactly the
   * same thing, against the SAME target this grant already belongs to
   * (`current.userId`, loaded from the row above — never re-trust `userId`
   * off the URL a second time), or a Sales-scoped super_admin could strip a
   * role from a principal outside their scope even though they could never
   * have granted it in the first place.
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

      const target = await this.users.findById(current.userId, tx)
      if (target === null) {
        throw new NotFoundError('user', current.userId)
      }
      await this.engine.assertCanIn(request.actor, 'role:assign', target.orgUnitId, tx)

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
