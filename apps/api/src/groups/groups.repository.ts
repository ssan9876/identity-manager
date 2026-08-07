import { Inject, Injectable } from '@nestjs/common'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { AttributeDefinition, ValidationRules } from '../attributes/attribute-validator'
import { DB_CLIENT } from '../common/db.token'
import { ConflictError, CycleError, NotFoundError } from '../common/errors'
import { attributeDefinitions } from '../db/schema/attribute-definitions'
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

/**
 * A partial update to an existing group. A field left `undefined` (omitted
 * from the request body) leaves the corresponding column untouched;
 * `description`, being nullable, additionally accepts `null` explicitly to
 * clear it — same convention as UsersRepository's UpdateUserInput.
 *
 * Deliberately excludes `orgUnitId`: reassigning it is a materially
 * different authorization question than editing a group in place (same
 * reasoning UsersRepository.update's doc comment gives for excluding a
 * user's own orgUnitId), and for a group specifically it is a SHARPER
 * concern — decision 1 makes `orgUnitId = NULL` globally visible AND
 * globally writable, so allowing PATCH to null it out would let a scoped
 * actor launder an in-scope group into a global one and thereby hand every
 * other actor holding `group:update`/`group:manage_members` anywhere
 * write access to it. Out of this milestone's PATCH surface entirely.
 */
export interface UpdateGroupInput {
  name?: string
  description?: string | null
  attributes?: Record<string, unknown>
}

const FOREIGN_KEY_VIOLATION = '23503'
const UNIQUE_VIOLATION = '23505'

// Exact constraint/index names, taken from the generated migration SQL
// (0003_aromatic_storm.sql) — never guessed. See
// UsersRepository.translateWriteError's doc comment for why constraint NAME,
// not SQLSTATE alone, is what decides the branch below.
const ORG_UNIT_FK_CONSTRAINT = 'groups_org_unit_id_org_units_id_fk'
const NAME_UNIQUE_CONSTRAINT = 'groups_name_unique'

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

  /**
   * `create`, `findById`, `update`, `addUser`, `removeUser`, `addChildGroup`
   * and `removeChildGroup` below all accept an OPTIONAL trailing `db`
   * handle, defaulting to the injected pooled connection (`this.db`) — same
   * contract as UsersRepository's write methods (see its doc comment for
   * the full explanation). A caller that already opened a transaction
   * (every write in GroupsController does, so its mutation and its
   * AuditWriter.record(tx, …) audit row commit or roll back together)
   * passes that `tx` through instead, and every query in the call runs on
   * the SAME connection as the audit write.
   */
  async create(input: CreateGroupInput, db: NodePgDatabase<typeof schema> = this.db): Promise<Group> {
    try {
      const [row] = await db
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
      this.translateWriteError(cause, { name: input.name, orgUnitId: input.orgUnitId })
    }
  }

  async findById(id: string, db: NodePgDatabase<typeof schema> = this.db): Promise<Group | null> {
    const [row] = await db.select().from(groups).where(eq(groups.id, id)).limit(1)
    return (row as Group | undefined) ?? null
  }

  /**
   * Partial update of an existing group's editable fields. `id` must
   * already exist — 404s otherwise, defensively, even though the current
   * (and only) caller (GroupsController.update) has already loaded the row
   * moments earlier for its own assertCanIn check.
   *
   * Does not touch `orgUnitId` — see UpdateGroupInput's doc comment.
   */
  async update(
    id: string,
    patch: UpdateGroupInput,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<Group> {
    const current = await this.findById(id, db)
    if (current === null) {
      throw new NotFoundError('group', id)
    }

    const setValues: Record<string, unknown> = { updatedAt: new Date() }
    if (patch.name !== undefined) setValues.name = patch.name
    if (patch.description !== undefined) setValues.description = patch.description
    if (patch.attributes !== undefined) setValues.attributes = patch.attributes

    try {
      const [row] = await db.update(groups).set(setValues).where(eq(groups.id, id)).returning()
      return row as Group
    } catch (cause) {
      this.translateWriteError(cause, { name: patch.name, orgUnitId: undefined })
    }
  }

  /**
   * Maps a Postgres write-constraint violation to the right DomainError, by
   * CONSTRAINT NAME — never by SQLSTATE alone. `groups` carries one foreign
   * key (org_unit_id) and one unique index (name); matching on
   * `code === '23503'`/`'23505'` alone would misreport any FUTURE second
   * constraint on this table as one of these two — the exact carried
   * finding task-3-brief.md calls out closing, mirroring
   * UsersRepository.translateWriteError (see its doc comment for the full
   * reasoning). Anything unrecognized is rethrown verbatim, never swallowed.
   */
  private translateWriteError(
    cause: unknown,
    input: { name?: string; orgUnitId?: string },
  ): never {
    const pgError = cause as { code?: string; constraint?: string }

    if (
      pgError.code === FOREIGN_KEY_VIOLATION &&
      pgError.constraint === ORG_UNIT_FK_CONSTRAINT &&
      input.orgUnitId !== undefined
    ) {
      throw new NotFoundError('org unit', input.orgUnitId)
    }

    if (
      pgError.code === UNIQUE_VIOLATION &&
      pgError.constraint === NAME_UNIQUE_CONSTRAINT &&
      input.name !== undefined
    ) {
      throw new ConflictError(`a group named "${input.name}" already exists`)
    }

    throw cause
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
  // `db` is an OPTIONAL trailing handle, defaulting to the injected pooled
  // connection (`this.db`) - same contract as create/findById/update above.
  // Added for SyncWorker.syncEffectiveGroups (finding C1,
  // docs/superpowers/audit-integrity.md), which now threads its open
  // transaction through here instead of defaulting to the pool.
  async listByIds(
    ids: string[],
    options: { limit: number; offset: number; scopePaths?: string[] | null },
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<Group[]> {
    if (ids.length === 0) {
      return []
    }

    const filters = [inArray(groups.id, ids)]
    const scope = this.scopeFilter(options.scopePaths)
    if (scope !== undefined) filters.push(scope)

    const rows = await db
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

  private async requireGroup(id: string, db: NodePgDatabase<typeof schema> = this.db): Promise<void> {
    if ((await this.findById(id, db)) === null) {
      throw new NotFoundError('group', id)
    }
  }

  async addUser(
    groupId: string,
    userId: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<void> {
    await this.requireGroup(groupId, db)

    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)

    if (user === undefined) {
      throw new NotFoundError('user', userId)
    }

    await db.insert(groupUserMembers).values({ groupId, userId }).onConflictDoNothing()
  }

  async removeUser(
    groupId: string,
    userId: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<void> {
    await db
      .delete(groupUserMembers)
      .where(
        and(
          eq(groupUserMembers.groupId, groupId),
          eq(groupUserMembers.userId, userId),
        ),
      )
  }

  /**
   * `db` is an OPTIONAL trailing handle, defaulting to the injected pooled
   * connection (`this.db`) — same contract as `create`/`findById`/`update`
   * above. Widened for Milestone 11, Task 6's `SyncWorker.
   * buildDesiredGroupMemberExternalIds` (sync.worker.ts), which threads its
   * open transaction through here instead of defaulting to the pool —
   * finding C1 (docs/superpowers/audit-integrity.md), the same reason
   * `listEffectiveUserMembers`/`listEffectiveGroupsForUser` were widened in
   * Milestone 4.
   */
  async listDirectUserMembers(
    groupId: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<string[]> {
    const rows = await db
      .select({ userId: groupUserMembers.userId })
      .from(groupUserMembers)
      .where(eq(groupUserMembers.groupId, groupId))

    return rows.map((row) => row.userId)
  }

  /**
   * Every group `userId` belongs to DIRECTLY — the mirror image of
   * `listDirectUserMembers` just above (group -> its direct user ids); this
   * goes user -> their direct group ids. Added for SelfServiceController
   * (Milestone 6, Task 3), which shows a caller their DIRECT membership
   * distinctly from the wider EFFECTIVE set `listEffectiveGroupsForUser`
   * below already computes (which also walks upward through nested-group
   * ancestors) — direct membership is always a subset of effective
   * membership, never the reverse, so a client can compute "inherited only"
   * as effective-minus-direct without a third query.
   */
  async listDirectGroupsForUser(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ groupId: groupUserMembers.groupId })
      .from(groupUserMembers)
      .where(eq(groupUserMembers.userId, userId))

    return rows.map((row) => row.groupId)
  }

  /**
   * `db` defaults to `this.db` (the pool) exactly like every other method
   * above, but what it does with that handle is different: it always opens
   * its OWN nested transaction via `db.transaction(...)`, never runs its
   * lock/check/insert directly against `db`. That distinction is load-bearing
   * — do not "simplify" it away:
   *
   *  - Called with the default (`db === this.db`, the pool — every existing
   *    caller, including every test in group-membership.spec.ts):
   *    `this.db.transaction(cb)` opens a genuine new top-level transaction,
   *    exactly as before this parameter existed. Zero behavior change.
   *  - Called with a `tx` already open (GroupsController's write handlers,
   *    Task 3): `tx.transaction(cb)` — Drizzle's `PgTransaction` class
   *    implements its OWN `.transaction()` as a Postgres SAVEPOINT (verified
   *    directly against the installed drizzle-orm's
   *    node-postgres/session.js — `NodePgTransaction.transaction` issues
   *    `savepoint spN` / `release savepoint spN` / `rollback to savepoint
   *    spN`, not a second `BEGIN`/`COMMIT`), so this nests cleanly inside the
   *    caller's transaction instead of opening a second, independent one.
   *
   * Why it must be nested rather than flattened onto `db` directly: this
   * method's whole safety property — the advisory lock and the cycle check
   * and the edge insert happening as ONE atomic, serialized unit — depends
   * on all three running inside a SINGLE transaction (`pg_advisory_xact_lock`
   * is scoped to the CURRENT transaction; a `BEGIN`-less sequence of
   * awaited statements against a pooled connection would each auto-commit
   * independently, releasing the lock before the cycle check even ran — see
   * GROUP_GRAPH_LOCK_ID's doc comment, and the 20-iteration concurrent-race
   * test in group-membership.spec.ts this exists to keep passing). Always
   * opening `db.transaction(...)` — nested as a savepoint when `db` is
   * already a transaction — preserves that property in both calling shapes,
   * without this method ever needing to know which one it was given.
   *
   * Why nesting (not just correctness) is exactly what Task 3 needs: a
   * `CycleError` thrown inside rolls back to the savepoint and re-throws,
   * which propagates out of GroupsController's outer `db.transaction(async
   * (tx) => …)` callback uncaught — Drizzle rolls back the WHOLE outer
   * transaction on any uncaught throw from that callback — so a rejected
   * cycle attempt never reaches the audit write below it in the handler,
   * satisfying "no audit row on a cycle rejection" without this method or
   * its caller needing any special-case error handling for it.
   */
  async addChildGroup(
    parentGroupId: string,
    childGroupId: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<void> {
    if (parentGroupId === childGroupId) {
      throw new CycleError('a group cannot contain itself')
    }

    await this.requireGroup(parentGroupId, db)
    await this.requireGroup(childGroupId, db)

    await db.transaction(async (tx) => {
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

  async removeChildGroup(
    parentGroupId: string,
    childGroupId: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<void> {
    await db
      .delete(groupGroupMembers)
      .where(
        and(
          eq(groupGroupMembers.parentGroupId, parentGroupId),
          eq(groupGroupMembers.childGroupId, childGroupId),
        ),
      )
  }

  /**
   * `db` is an OPTIONAL trailing handle, defaulting to the injected pooled
   * connection (`this.db`) — same contract, widened for the SAME reason
   * (Milestone 11, Task 6's `SyncWorker.buildDesiredGroupMemberExternalIds`)
   * as `listDirectUserMembers` immediately above.
   */
  async listDirectChildGroups(
    groupId: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<string[]> {
    const rows = await db
      .select({ childGroupId: groupGroupMembers.childGroupId })
      .from(groupGroupMembers)
      .where(eq(groupGroupMembers.parentGroupId, groupId))

    return rows.map((row) => row.childGroupId)
  }

  /**
   * Every user in this group or any descendant group.
   * UNION (not UNION ALL) is load-bearing: it de-duplicates the frontier, so
   * the recursion terminates even against a graph that somehow contains a cycle.
   *
   * `db` is an OPTIONAL trailing handle, defaulting to the injected pooled
   * connection (`this.db`) - same contract as create/findById/update above.
   * Added for SyncWorker.reconcileGroup/reconcileMembership (finding C1,
   * docs/superpowers/audit-integrity.md), which now thread their open
   * transaction through here instead of defaulting to the pool.
   */
  async listEffectiveUserMembers(
    groupId: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<string[]> {
    const { rows } = await db.execute<{ user_id: string }>(sql`
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

  /**
   * Every group this user belongs to directly, plus all of their ancestors.
   *
   * `db` is an OPTIONAL trailing handle, defaulting to the injected pooled
   * connection (`this.db`) - same contract, added for the same reason
   * (SyncWorker.syncEffectiveGroups; finding C1), as
   * `listEffectiveUserMembers` above.
   */
  async listEffectiveGroupsForUser(
    userId: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<string[]> {
    const { rows } = await db.execute<{ group_id: string }>(sql`
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

  /**
   * Active, group-scoped custom attribute definitions, in the shape
   * `validateAttributes` expects — the group-side mirror of
   * UsersRepository.listActiveAttributeDefinitions. GroupsController's
   * create/update handlers use this to build the schema a request's
   * `attributes` is checked against. Attribute propagation is default-deny
   * (Milestone 3b global constraint): with zero active definitions — true
   * in every environment until `attribute_definitions` gets its own write
   * path (decision 4, not this milestone) — any submitted attribute is
   * rejected as unrecognized rather than silently stored.
   */
  async listActiveAttributeDefinitions(): Promise<AttributeDefinition[]> {
    const rows = await this.db
      .select()
      .from(attributeDefinitions)
      .where(
        and(eq(attributeDefinitions.isActive, true), eq(attributeDefinitions.appliesTo, 'group')),
      )

    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      label: row.label,
      dataType: row.dataType,
      required: row.required,
      validationRules: (row.validationRules ?? {}) as ValidationRules,
      appliesTo: row.appliesTo,
      isActive: row.isActive,
      selfEditable: row.selfEditable,
    }))
  }
}
