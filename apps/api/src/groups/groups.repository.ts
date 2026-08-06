import { Inject, Injectable } from '@nestjs/common'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { ConflictError, CycleError, NotFoundError } from '../common/errors'
import * as schema from '../db/schema/index'
import { groupGroupMembers, groupUserMembers } from '../db/schema/group-members'
import { groups } from '../db/schema/groups'
import { users } from '../db/schema/users'

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

/**
 * A single lock id shared by every nested-group mutation. Edge insertion is a
 * check-then-write, so two concurrent transactions could each observe no cycle
 * and together commit one. Nested-group edits are rare admin operations, so
 * serializing all of them is cheaper than reasoning about partial orders.
 */
const GROUP_GRAPH_LOCK_ID = 0x1d3a_0001

@Injectable()
export class GroupsRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>) {}

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

  /**
   * A group with `orgUnitId = NULL` is GLOBAL (decision 1): visible to any
   * actor holding `group:read`, regardless of scope — so it is included
   * unconditionally, never run through the org-unit containment check. A
   * scoped actor therefore sees global groups UNION groups within their
   * subtree, which is exactly what the `OR EXISTS (...)` below expresses.
   *
   * `undefined`/`null` means unrestricted (no filter at all — matches
   * PermissionEngine.scopePathsFor's contract exactly). An array — including
   * `[]` — adds a real filter: with `[]`, the EXISTS branch can never match
   * (`ANY` over an empty array is always false), so only global groups
   * remain visible — never "everything." Do not spell this
   * `if (scopePaths?.length)`; see scopePathsFor's doc comment for what that
   * trap does to an actor entitled nowhere.
   *
   * `scopePaths` is bound as ONE array-typed parameter via `sql.param`,
   * never interpolated into the query text — see permission.engine.ts:131.
   */
  private scopeFilter(scopePaths?: string[] | null) {
    if (scopePaths === undefined || scopePaths === null) {
      return undefined
    }
    return sql`(${groups.orgUnitId} IS NULL OR EXISTS (
      SELECT 1 FROM org_units ou
       WHERE ou.id = ${groups.orgUnitId}
         AND ou.path <@ ANY (${sql.param(scopePaths)}::ltree[])
    ))`
  }

  async list(options: { limit: number; offset: number; scopePaths?: string[] | null }): Promise<Group[]> {
    const rows = await this.db
      .select()
      .from(groups)
      .where(this.scopeFilter(options.scopePaths))
      .orderBy(asc(groups.name))
      .limit(options.limit)
      .offset(options.offset)

    return rows as Group[]
  }

  async count(options: { scopePaths?: string[] | null } = {}): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(groups)
      .where(this.scopeFilter(options.scopePaths))

    return row?.value ?? 0
  }

  /**
   * Groups restricted to a specific id set (e.g. a user's effective
   * memberships), paginated and ordered exactly like `list()`. An empty
   * `ids` means "nothing matched" (a user in no groups, or a well-formed id
   * that isn't a real user) — returned as an empty page rather than sending
   * `IN ()` to Postgres, which is invalid SQL. `scopePaths` narrows exactly
   * like `list()` — see `scopeFilter`.
   */
  async listByIds(
    ids: string[],
    options: { limit: number; offset: number; scopePaths?: string[] | null },
  ): Promise<Group[]> {
    if (ids.length === 0) {
      return []
    }

    const filters = [inArray(groups.id, ids)]
    const scope = this.scopeFilter(options.scopePaths)
    if (scope !== undefined) filters.push(scope)

    const rows = await this.db
      .select()
      .from(groups)
      .where(and(...filters))
      .orderBy(asc(groups.name))
      .limit(options.limit)
      .offset(options.offset)

    return rows as Group[]
  }

  /** Matching count for `listByIds` — always agrees with it, same filters. */
  async countByIds(ids: string[], scopePaths?: string[] | null): Promise<number> {
    if (ids.length === 0) {
      return 0
    }

    const filters = [inArray(groups.id, ids)]
    const scope = this.scopeFilter(scopePaths)
    if (scope !== undefined) filters.push(scope)

    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(groups)
      .where(and(...filters))

    return row?.value ?? 0
  }

  private async requireGroup(id: string): Promise<void> {
    if ((await this.findById(id)) === null) {
      throw new NotFoundError('group', id)
    }
  }

  async addUser(groupId: string, userId: string): Promise<void> {
    await this.requireGroup(groupId)

    const [user] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)

    if (user === undefined) {
      throw new NotFoundError('user', userId)
    }

    await this.db
      .insert(groupUserMembers)
      .values({ groupId, userId })
      .onConflictDoNothing()
  }

  async removeUser(groupId: string, userId: string): Promise<void> {
    await this.db
      .delete(groupUserMembers)
      .where(
        and(
          eq(groupUserMembers.groupId, groupId),
          eq(groupUserMembers.userId, userId),
        ),
      )
  }

  async listDirectUserMembers(groupId: string): Promise<string[]> {
    const rows = await this.db
      .select({ userId: groupUserMembers.userId })
      .from(groupUserMembers)
      .where(eq(groupUserMembers.groupId, groupId))

    return rows.map((row) => row.userId)
  }

  async addChildGroup(parentGroupId: string, childGroupId: string): Promise<void> {
    if (parentGroupId === childGroupId) {
      throw new CycleError('a group cannot contain itself')
    }

    await this.requireGroup(parentGroupId)
    await this.requireGroup(childGroupId)

    await this.db.transaction(async (tx) => {
      // Serialize every graph mutation; see GROUP_GRAPH_LOCK_ID.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${GROUP_GRAPH_LOCK_ID})`)

      // Would the new edge close a loop? It does exactly when the proposed
      // parent is already reachable downward from the proposed child.
      const { rows } = await tx.execute<{ reachable: boolean }>(sql`
        WITH RECURSIVE descendants AS (
          SELECT child_group_id AS id
            FROM group_group_members
           WHERE parent_group_id = ${childGroupId}::uuid
          UNION
          SELECT ggm.child_group_id
            FROM group_group_members ggm
            JOIN descendants d ON ggm.parent_group_id = d.id
        )
        SELECT EXISTS (
          SELECT 1 FROM descendants WHERE id = ${parentGroupId}::uuid
        ) AS reachable
      `)

      if (rows[0]?.reachable === true) {
        throw new CycleError(
          `nesting group ${childGroupId} under ${parentGroupId} would create a cycle`,
        )
      }

      await tx
        .insert(groupGroupMembers)
        .values({ parentGroupId, childGroupId })
        .onConflictDoNothing()
    })
  }

  async removeChildGroup(parentGroupId: string, childGroupId: string): Promise<void> {
    await this.db
      .delete(groupGroupMembers)
      .where(
        and(
          eq(groupGroupMembers.parentGroupId, parentGroupId),
          eq(groupGroupMembers.childGroupId, childGroupId),
        ),
      )
  }

  async listDirectChildGroups(groupId: string): Promise<string[]> {
    const rows = await this.db
      .select({ childGroupId: groupGroupMembers.childGroupId })
      .from(groupGroupMembers)
      .where(eq(groupGroupMembers.parentGroupId, groupId))

    return rows.map((row) => row.childGroupId)
  }

  /**
   * Every user in this group or any descendant group.
   * UNION (not UNION ALL) is load-bearing: it de-duplicates the frontier, so
   * the recursion terminates even against a graph that somehow contains a cycle.
   */
  async listEffectiveUserMembers(groupId: string): Promise<string[]> {
    const { rows } = await this.db.execute<{ user_id: string }>(sql`
      WITH RECURSIVE reachable AS (
        SELECT ${groupId}::uuid AS id
        UNION
        SELECT ggm.child_group_id
          FROM group_group_members ggm
          JOIN reachable r ON ggm.parent_group_id = r.id
      )
      SELECT DISTINCT gum.user_id
        FROM group_user_members gum
        JOIN reachable r ON gum.group_id = r.id
    `)

    return rows.map((row) => row.user_id)
  }

  /** Every group this user belongs to directly, plus all of their ancestors. */
  async listEffectiveGroupsForUser(userId: string): Promise<string[]> {
    const { rows } = await this.db.execute<{ group_id: string }>(sql`
      WITH RECURSIVE ancestors AS (
        SELECT gum.group_id AS id
          FROM group_user_members gum
         WHERE gum.user_id = ${userId}::uuid
        UNION
        SELECT ggm.parent_group_id
          FROM group_group_members ggm
          JOIN ancestors a ON ggm.child_group_id = a.id
      )
      SELECT DISTINCT id AS group_id FROM ancestors
    `)

    return rows.map((row) => row.group_id)
  }
}
