import { Inject, Injectable } from '@nestjs/common'
import { asc, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { alias } from 'drizzle-orm/pg-core'
import { DB_CLIENT } from '../common/db.token'
import { ConflictError, NotFoundError } from '../common/errors'
import { businessRoles, roleConflicts } from '../db/schema/business-roles'
import * as schema from '../db/schema/index'

/** One `role_conflicts` row, exactly as stored. */
export type RoleConflictRow = typeof roleConflicts.$inferSelect

/** The row plus the two role NAMES — what every screen and report actually says. */
export interface RoleConflictWithNames extends RoleConflictRow {
  roleAName: string
  roleBName: string
}

const UNIQUE_VIOLATION = '23505'
const PAIR_UNIQUE_CONSTRAINT = 'role_conflicts_pair_unique'

/**
 * Matched on the CONSTRAINT NAME, not on `code === '23505'` alone — the same
 * reasoning `BusinessRolesRepository.translateWriteError` states at length.
 * The message names neither role: finding SEC-L2, a 409 echoing the caller's
 * own input is an existence oracle.
 */
function translateWriteError(error: unknown): never {
  const pgError = error as { code?: string; constraint?: string }
  if (pgError?.code === UNIQUE_VIOLATION && pgError.constraint === PAIR_UNIQUE_CONSTRAINT) {
    throw new ConflictError('a conflict between these two roles already exists')
  }
  throw error
}

/**
 * `(A,B)` and `(B,A)` are the same policy, so they must be the same ROW.
 * Sorted here, once, on every path that touches the pair — and the schema's
 * `role_conflicts_canonical_pair` CHECK is what makes a write that somehow
 * skipped this function a loud constraint violation rather than a second,
 * invisible copy of the same policy.
 */
export function canonicalPair(one: string, two: string): { roleAId: string; roleBId: string } {
  return one < two ? { roleAId: one, roleBId: two } : { roleAId: two, roleBId: one }
}

/**
 * Segregation-of-duties conflicts between business roles.
 *
 * CRUD-minus-delete, deliberately: like roles, exceptions and everything
 * else in this schema, a conflict is never deleted — it is RETIRED via
 * `setEnabled(false)`, so the policy's history (who defined it, why, when it
 * stopped applying) survives the decision to stop enforcing it.
 *
 * Every write takes an optional trailing `db` handle defaulting to the
 * injected pooled connection, exactly as `BusinessRolesRepository`'s writes
 * do and for the same reason (finding C1): the controller always passes its
 * own open `tx`, so the mutation and its audit row commit together and
 * nothing here checks out a second pooled connection under an open
 * transaction.
 */
@Injectable()
export class RoleConflictsRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>) {}

  async create(
    input: {
      roleAId: string
      roleBId: string
      reason: string
      organizationId: string
      createdBy: string | null
    },
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<RoleConflictRow> {
    const pair = canonicalPair(input.roleAId, input.roleBId)
    const [row] = await db
      .insert(roleConflicts)
      .values({
        ...pair,
        reason: input.reason,
        organizationId: input.organizationId,
        createdBy: input.createdBy,
      })
      .returning()
      .catch(translateWriteError)
    return row
  }

  /**
   * Every conflict, retired ones included — the console's index, which shows
   * status rather than pretending retirement is deletion. Joined to the two
   * role names because that is what the screen says; created-at order so the
   * list reads as the policy's history.
   */
  async list(db: NodePgDatabase<typeof schema> = this.db): Promise<RoleConflictWithNames[]> {
    const roleA = alias(businessRoles, 'conflict_role_a')
    const roleB = alias(businessRoles, 'conflict_role_b')
    const rows = await db
      .select({
        conflict: roleConflicts,
        roleAName: roleA.name,
        roleBName: roleB.name,
      })
      .from(roleConflicts)
      .innerJoin(roleA, eq(roleConflicts.roleAId, roleA.id))
      .innerJoin(roleB, eq(roleConflicts.roleBId, roleB.id))
      .orderBy(asc(roleConflicts.createdAt), asc(roleConflicts.id))
    return rows.map((row) => ({ ...row.conflict, roleAName: row.roleAName, roleBName: row.roleBName }))
  }

  /** ENABLED conflicts only — what the publish gate and the standing checker consult. */
  async listEnabled(db: NodePgDatabase<typeof schema> = this.db): Promise<RoleConflictRow[]> {
    return db.select().from(roleConflicts).where(eq(roleConflicts.enabled, true))
  }

  async findById(
    id: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<RoleConflictRow | null> {
    const [row] = await db.select().from(roleConflicts).where(eq(roleConflicts.id, id))
    return row ?? null
  }

  /**
   * `reason` ONLY. The pair is immutable by design: "these two roles now
   * conflict about something else" is a different policy — retire this one
   * and define that one, each with its own audit trail.
   */
  async updateReason(
    id: string,
    reason: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<RoleConflictRow> {
    const [row] = await db
      .update(roleConflicts)
      .set({ reason, updatedAt: new Date() })
      .where(eq(roleConflicts.id, id))
      .returning()
    if (!row) throw new NotFoundError('role conflict', id)
    return row
  }

  /** The retirement switch — the only way a conflict stops being enforced. */
  async setEnabled(
    id: string,
    enabled: boolean,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<RoleConflictRow> {
    const [row] = await db
      .update(roleConflicts)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(roleConflicts.id, id))
      .returning()
    if (!row) throw new NotFoundError('role conflict', id)
    return row
  }
}
