import { Inject, Injectable } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { ConflictError, NotFoundError } from '../common/errors'
import * as schema from '../db/schema/index'
import { orgUnits } from '../db/schema/org-units'
import { roleAssignments } from '../db/schema/role-assignments'
import { users } from '../db/schema/users'
import type { RoleKey } from './actions'

export interface RoleAssignment {
  id: string
  userId: string
  roleKey: RoleKey
  scopeOrgUnitId: string | null
  createdAt: Date
}

export interface AssignRoleInput {
  userId: string
  roleKey: RoleKey
  scopeOrgUnitId?: string | null
}

const UNIQUE_VIOLATION = '23505'

@Injectable()
export class RoleAssignmentsRepository {
  constructor(
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async assign(input: AssignRoleInput): Promise<RoleAssignment> {
    const [user] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)

    if (user === undefined) {
      throw new NotFoundError('user', input.userId)
    }

    const scopeOrgUnitId = input.scopeOrgUnitId ?? null

    if (scopeOrgUnitId !== null) {
      const [scope] = await this.db
        .select({ id: orgUnits.id })
        .from(orgUnits)
        .where(eq(orgUnits.id, scopeOrgUnitId))
        .limit(1)

      if (scope === undefined) {
        throw new NotFoundError('org unit', scopeOrgUnitId)
      }
    }

    try {
      const [row] = await this.db
        .insert(roleAssignments)
        .values({ userId: input.userId, roleKey: input.roleKey, scopeOrgUnitId })
        .returning()

      return row as RoleAssignment
    } catch (cause) {
      if ((cause as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new ConflictError(
          `user ${input.userId} already holds ${input.roleKey} at this scope`,
        )
      }
      throw cause
    }
  }

  async revoke(id: string): Promise<void> {
    await this.db.delete(roleAssignments).where(eq(roleAssignments.id, id))
  }

  async listForUser(userId: string): Promise<RoleAssignment[]> {
    const rows = await this.db
      .select()
      .from(roleAssignments)
      .where(eq(roleAssignments.userId, userId))

    return rows as RoleAssignment[]
  }
}
