import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { InvalidTransitionError, NotFoundError } from '../common/errors'
import * as schema from '../db/schema/index'
import { users } from '../db/schema/users'

export type UserStatus = 'pending' | 'active' | 'suspended' | 'deactivated'

export interface User {
  id: string
  status: UserStatus
  primaryEmail: string
  username: string
  firstName: string
  lastName: string
  displayName: string
  employeeId: string | null
  jobTitle: string | null
  orgUnitId: string
  managerId: string | null
  location: string | null
  startDate: string | null
  endDate: string | null
  attributes: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
  deactivatedAt: Date | null
}

export interface CreateUserInput {
  primaryEmail: string
  username: string
  firstName: string
  lastName: string
  orgUnitId: string
  employeeId?: string
  jobTitle?: string
  managerId?: string
  location?: string
  startDate?: string
  endDate?: string
  attributes?: Record<string, unknown>
}

const ALLOWED_TRANSITIONS: Record<UserStatus, readonly UserStatus[]> = {
  pending: ['active'],
  active: ['suspended', 'deactivated'],
  suspended: ['active', 'deactivated'],
  deactivated: [],
}

/**
 * The statuses from which `next` may be reached directly, derived from
 * ALLOWED_TRANSITIONS so the two can never drift apart. Used as the `WHERE
 * status IN (...)` guard on the atomic transition update below. Empty for a
 * `next` nothing transitions into (currently only `pending`).
 */
function statusesThatMayTransitionTo(next: UserStatus): UserStatus[] {
  return (Object.keys(ALLOWED_TRANSITIONS) as UserStatus[]).filter((from) =>
    ALLOWED_TRANSITIONS[from].includes(next),
  )
}

export class UsersRepository {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async create(input: CreateUserInput): Promise<User> {
    const [row] = await this.db
      .insert(users)
      .values({
        primaryEmail: input.primaryEmail,
        username: input.username,
        firstName: input.firstName,
        lastName: input.lastName,
        displayName: `${input.firstName} ${input.lastName}`.trim(),
        orgUnitId: input.orgUnitId,
        employeeId: input.employeeId ?? null,
        jobTitle: input.jobTitle ?? null,
        managerId: input.managerId ?? null,
        location: input.location ?? null,
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        attributes: input.attributes ?? {},
      })
      .returning()

    return row as User
  }

  async findById(id: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1)

    return (row as User | undefined) ?? null
  }

  async findByEmail(email: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.primaryEmail}) = lower(${email})`)
      .limit(1)

    return (row as User | undefined) ?? null
  }

  /**
   * There is no delete. Removal is a transition to `deactivated`, which is
   * terminal, so historical access questions stay answerable.
   *
   * The read-validate-write pattern is not safe here: two concurrent callers
   * can both read the same starting status, both pass validation against
   * that stale snapshot, and both blindly overwrite the row, silently
   * discarding whichever write lost the race — including a `deactivated`
   * write, which must never be undone. Instead this issues a single
   * conditional UPDATE whose WHERE clause re-checks the transition legality
   * against the row's *current* committed status at write time. Postgres
   * serializes concurrent UPDATEs on the same row (row-level lock) and
   * re-evaluates a blocked UPDATE's WHERE clause against the winner's
   * committed data before applying it (EvalPlanQual), so the decision and
   * the write are one atomic step with no window for a lost update.
   */
  async changeStatus(id: string, next: UserStatus): Promise<User> {
    const permittedFrom = statusesThatMayTransitionTo(next)

    // A `next` with no valid predecessor (only `pending` today) can never
    // match any row. `inArray` with an empty array is unsafe to send to the
    // driver, and there is nothing to gain by trying — skip straight to
    // error determination below.
    if (permittedFrom.length > 0) {
      const [row] = await this.db
        .update(users)
        .set({
          status: next,
          updatedAt: new Date(),
          // Only touched when landing on `deactivated`; omitted entirely
          // from the SET clause otherwise so the existing value, if any, is
          // left untouched rather than being reset.
          ...(next === 'deactivated' ? { deactivatedAt: new Date() } : {}),
        })
        .where(and(eq(users.id, id), inArray(users.status, permittedFrom)))
        .returning()

      if (row) {
        return row as User
      }
    }

    // Zero rows matched (or there was no valid predecessor to try at all).
    // This read is advisory only, purely to report an accurate reason — the
    // atomic UPDATE above already made the real decision.
    const current = await this.findById(id)
    if (current === null) {
      throw new NotFoundError('user', id)
    }

    if (current.status === 'deactivated') {
      throw new InvalidTransitionError(
        'deactivated is terminal; the user cannot be reactivated',
      )
    }

    throw new InvalidTransitionError(
      `cannot transition from ${current.status} to ${next}`,
    )
  }

  async list(
    options: { limit: number; offset: number; status?: UserStatus; orgUnitId?: string },
  ): Promise<User[]> {
    const filters = []
    if (options.status !== undefined) filters.push(eq(users.status, options.status))
    if (options.orgUnitId !== undefined) filters.push(eq(users.orgUnitId, options.orgUnitId))

    const rows = await this.db
      .select()
      .from(users)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(asc(users.username))
      .limit(options.limit)
      .offset(options.offset)

    return rows as User[]
  }

  async count(filter: { status?: UserStatus; orgUnitId?: string } = {}): Promise<number> {
    const filters = []
    if (filter.status !== undefined) filters.push(eq(users.status, filter.status))
    if (filter.orgUnitId !== undefined) filters.push(eq(users.orgUnitId, filter.orgUnitId))

    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(users)
      .where(filters.length > 0 ? and(...filters) : undefined)

    return row?.value ?? 0
  }
}
