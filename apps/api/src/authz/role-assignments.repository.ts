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

// Exact index names, taken from the generated migration SQL
// (0005_sour_stepford_cuckoos.sql) — never guessed. See
// UsersRepository.translateWriteError's doc comment for why constraint
// NAME, not SQLSTATE alone, is what decides the branch below. `role_assignments`
// carries TWO partial unique indexes (see db/schema/role-assignments.ts's own
// doc comment on why: Postgres does not treat NULLs as equal, so one index
// cannot police both "duplicate scoped grant" and "duplicate global grant"),
// and prior to this fix both collided into the same generic "at this scope"
// message — actively wrong for the global case, which has no scope to name.
const SCOPED_UNIQUE_CONSTRAINT = 'role_assignments_scoped_unique'
const GLOBAL_UNIQUE_CONSTRAINT = 'role_assignments_global_unique'

@Injectable()
export class RoleAssignmentsRepository {
  constructor(
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * `assign`, `revoke` and `findById` below all accept an OPTIONAL trailing
   * `db` handle, defaulting to the injected pooled connection (`this.db`) —
   * same contract as every other repository's write methods in this
   * milestone (see UsersRepository.create's doc comment for the full
   * explanation). RoleAssignmentsController's handlers pass their open `tx`
   * through, so the mutation and its `AuditWriter.record(tx, …)` audit row
   * commit or roll back together.
   */
  async assign(
    input: AssignRoleInput,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<RoleAssignment> {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)

    if (user === undefined) {
      throw new NotFoundError('user', input.userId)
    }

    const scopeOrgUnitId = input.scopeOrgUnitId ?? null

    if (scopeOrgUnitId !== null) {
      const [scope] = await db
        .select({ id: orgUnits.id })
        .from(orgUnits)
        .where(eq(orgUnits.id, scopeOrgUnitId))
        .limit(1)

      if (scope === undefined) {
        throw new NotFoundError('org unit', scopeOrgUnitId)
      }
    }

    try {
      const [row] = await db
        .insert(roleAssignments)
        .values({ userId: input.userId, roleKey: input.roleKey, scopeOrgUnitId })
        .returning()

      return row as RoleAssignment
    } catch (cause) {
      this.translateWriteError(cause, {
        userId: input.userId,
        roleKey: input.roleKey,
        scopeOrgUnitId,
      })
    }
  }

  /**
   * Maps a Postgres unique-constraint violation to a `ConflictError` whose
   * message names the scope that actually collided — by CONSTRAINT NAME,
   * never SQLSTATE alone (see UsersRepository.translateWriteError's doc
   * comment for the full reasoning this mirrors). Dispatching on the
   * constraint name, not just `23505`, is what lets the SCOPED and GLOBAL
   * messages differ correctly instead of both saying "at this scope" — the
   * carried finding this fixes. Anything unrecognized is rethrown verbatim,
   * never swallowed.
   */
  private translateWriteError(
    cause: unknown,
    input: { userId: string; roleKey: RoleKey; scopeOrgUnitId: string | null },
  ): never {
    const pgError = cause as { code?: string; constraint?: string }

    if (pgError.code === UNIQUE_VIOLATION) {
      if (pgError.constraint === SCOPED_UNIQUE_CONSTRAINT) {
        throw new ConflictError(
          `user ${input.userId} already holds ${input.roleKey} at scope ${input.scopeOrgUnitId}`,
        )
      }
      if (pgError.constraint === GLOBAL_UNIQUE_CONSTRAINT) {
        throw new ConflictError(`user ${input.userId} already holds ${input.roleKey} globally`)
      }
    }

    throw cause
  }

  async revoke(id: string, db: NodePgDatabase<typeof schema> = this.db): Promise<void> {
    await db.delete(roleAssignments).where(eq(roleAssignments.id, id))
  }

  /**
   * Loads a single assignment by its own id, or `null`. Added for Task 4's
   * `DELETE /users/:id/roles/:assignmentId`: revoking needs the CURRENT
   * row's `roleKey`/`scopeOrgUnitId` (to run the same `assertCanAssignRole`
   * check granting it would have required) and `userId` (to confirm the
   * assignment actually belongs to the user named in the URL) before it can
   * decide anything — the same load-then-check shape
   * UsersController.update uses.
   */
  async findById(
    id: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<RoleAssignment | null> {
    const [row] = await db
      .select()
      .from(roleAssignments)
      .where(eq(roleAssignments.id, id))
      .limit(1)

    return (row as RoleAssignment | undefined) ?? null
  }

  async listForUser(userId: string): Promise<RoleAssignment[]> {
    const rows = await this.db
      .select()
      .from(roleAssignments)
      .where(eq(roleAssignments.userId, userId))

    return rows as RoleAssignment[]
  }
}
