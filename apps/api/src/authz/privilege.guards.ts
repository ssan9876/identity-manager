import { Inject, Injectable } from '@nestjs/common'
import { eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { ForbiddenError } from '../common/errors'
import * as schema from '../db/schema/index'
import { roleAssignments } from '../db/schema/role-assignments'
import { ROLE_RANK, type RoleKey } from './actions'
import type { Actor, ActorAssignment } from './permission.engine'

const NO_PRIVILEGE = -1

@Injectable()
export class PrivilegeGuards {
  constructor(
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  highestRank(assignments: ActorAssignment[]): number {
    return assignments.reduce(
      (highest, assignment) => Math.max(highest, ROLE_RANK[assignment.roleKey]),
      NO_PRIVILEGE,
    )
  }

  /**
   * An administrator may only grant a role they themselves hold, at a scope
   * their own holding covers. Without this, "help desk can reset passwords"
   * becomes "help desk can make themselves a super admin".
   */
  async assertCanAssignRole(
    actor: Actor,
    roleKey: RoleKey,
    scopeOrgUnitId: string | null,
  ): Promise<void> {
    const holdings = actor.assignments.filter(
      (assignment) =>
        assignment.roleKey === roleKey || assignment.roleKey === 'super_admin',
    )

    if (holdings.length === 0) {
      throw new ForbiddenError(`not permitted to grant ${roleKey}`)
    }

    // A global holding covers every scope, including a global grant.
    if (holdings.some((assignment) => assignment.scopeOrgUnitId === null)) {
      return
    }

    // Only a global holding may create a global grant.
    if (scopeOrgUnitId === null) {
      throw new ForbiddenError(`not permitted to grant ${roleKey} globally`)
    }

    const scopePaths = holdings
      .map((assignment) => assignment.scopePath)
      .filter((path): path is string => path !== null)

    // scopePaths must be bound via sql.param as ONE array-typed parameter,
    // not a bare `${scopePaths}` interpolation. Drizzle's sql tag treats a
    // raw JS array specially: it splices it in as a parenthesized,
    // comma-separated list of individually-bound scalar params (its IN/ANY
    // convenience feature), not as one bound `ltree[]` value. Confirmed
    // against a real Postgres — the bare form throws "malformed array
    // literal" for any non-empty scopePaths (22P02). Same root cause and
    // fix as PermissionEngine.canIn; see its comment and task-3-report.md
    // for the full Drizzle-source-level explanation.
    const { rows } = await this.db.execute<{ contained: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
          FROM org_units
         WHERE id = ${scopeOrgUnitId}::uuid
           AND path <@ ANY (${sql.param(scopePaths)}::ltree[])
      ) AS contained
    `)

    if (rows[0]?.contained !== true) {
      throw new ForbiddenError(`not permitted to grant ${roleKey} at that scope`)
    }
  }

  /**
   * An administrator may not modify a principal whose privileges exceed their
   * own — otherwise a help-desk account becomes a path to any executive's.
   */
  async assertCanModifyPrincipal(actor: Actor, targetUserId: string): Promise<void> {
    const targetAssignments = await this.db
      .select({ roleKey: roleAssignments.roleKey })
      .from(roleAssignments)
      .where(eq(roleAssignments.userId, targetUserId))

    const targetRank = targetAssignments.reduce(
      (highest, row) => Math.max(highest, ROLE_RANK[row.roleKey as RoleKey]),
      NO_PRIVILEGE,
    )

    if (this.highestRank(actor.assignments) < targetRank) {
      throw new ForbiddenError('not permitted to modify a more privileged principal')
    }
  }
}
