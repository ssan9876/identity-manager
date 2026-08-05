import { asc, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { ConflictError } from '../common/errors'
import * as schema from '../db/schema/index'
import { groups } from '../db/schema/groups'

export interface Group {
  id: string
  name: string
  description: string | null
  orgUnitId: string | null
  attributes: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface CreateGroupInput {
  name: string
  description?: string
  orgUnitId?: string
  attributes?: Record<string, unknown>
}

const UNIQUE_VIOLATION = '23505'

export class GroupsRepository {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async create(input: CreateGroupInput): Promise<Group> {
    try {
      const [row] = await this.db
        .insert(groups)
        .values({
          name: input.name,
          description: input.description ?? null,
          orgUnitId: input.orgUnitId ?? null,
          attributes: input.attributes ?? {},
        })
        .returning()

      return row as Group
    } catch (cause) {
      if ((cause as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new ConflictError(`a group named "${input.name}" already exists`)
      }
      throw cause
    }
  }

  async findById(id: string): Promise<Group | null> {
    const [row] = await this.db.select().from(groups).where(eq(groups.id, id)).limit(1)
    return (row as Group | undefined) ?? null
  }

  async findByName(name: string): Promise<Group | null> {
    const [row] = await this.db
      .select()
      .from(groups)
      .where(sql`lower(${groups.name}) = lower(${name})`)
      .limit(1)

    return (row as Group | undefined) ?? null
  }

  async list(options: { limit: number; offset: number }): Promise<Group[]> {
    const rows = await this.db
      .select()
      .from(groups)
      .orderBy(asc(groups.name))
      .limit(options.limit)
      .offset(options.offset)

    return rows as Group[]
  }

  async count(): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(groups)

    return row?.value ?? 0
  }
}
