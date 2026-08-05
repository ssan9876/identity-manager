import { eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
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
   */
  async changeStatus(id: string, next: UserStatus): Promise<User> {
    const current = await this.findById(id)
    if (current === null) {
      throw new Error(`user not found: ${id}`)
    }

    if (current.status === 'deactivated') {
      throw new Error('deactivated is terminal; the user cannot be reactivated')
    }

    if (!ALLOWED_TRANSITIONS[current.status].includes(next)) {
      throw new Error(`cannot transition from ${current.status} to ${next}`)
    }

    const [row] = await this.db
      .update(users)
      .set({
        status: next,
        updatedAt: new Date(),
        deactivatedAt: next === 'deactivated' ? new Date() : current.deactivatedAt,
      })
      .where(eq(users.id, id))
      .returning()

    return row as User
  }
}
