import { Inject, Injectable } from '@nestjs/common'
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { auditLog } from '../db/schema/audit-log'
import * as schema from '../db/schema/index'
import { users } from '../db/schema/users'

/**
 * One audit row as reported to an operator — Milestone 8, Task 5. Extends
 * the original (Milestone 5) shape with the actor's own `username`/
 * `displayName`, resolved via a LEFT JOIN against `users` rather than left
 * for the caller to resolve separately: `audit:read` is the one permission
 * in today's static catalog whose entire purpose is "who did that, and what
 * changed" (docs/product-brief.md), so identifying the actor cannot be gated behind a
 * SEPARATE `user:read` grant/scope an auditor might not hold — an auditor
 * scoped away from a given actor's org unit must still see WHO acted, even
 * though they could not `GET /users/:id` that same person directly. The join
 * is safe unconditionally: `actorUserId`'s FK is `onDelete: 'restrict'`
 * (db/schema/audit-log.ts), so a non-null actor id always resolves to a real,
 * still-existing row.
 */
export interface AuditRow {
  id: number
  actorUserId: string | null
  actorUsername: string | null
  actorDisplayName: string | null
  action: string
  resourceType: string
  resourceId: string | null
  before: unknown
  after: unknown
  batchId: string | null
  createdAt: Date
}

/**
 * Every filter is optional and ANDed together, mirroring
 * UsersRepository.listFilters' own contract (status/orgUnit/search all
 * combine, never OR). `actor` is a free-text ILIKE substring match against
 * the joined user's username/displayName (never the raw UUID — an admin
 * searches by NAME, task-5-brief.md: "searchable... by actor"); every other
 * field is an exact match against a value the UI only ever offers from a
 * bounded set (a `<select>`) or a UUID copied from elsewhere in the console
 * (a resourceId or batchId deep link) — so exact `eq` is correct for those,
 * never a substring match that could surprise a caller pasting a full id.
 */
export interface AuditListFilters {
  actor?: string
  action?: string
  resourceType?: string
  resourceId?: string
  batchId?: string
  /** Inclusive lower bound on `createdAt`. */
  from?: Date
  /** Inclusive upper bound on `createdAt`. */
  to?: Date
}

@Injectable()
export class AuditRepository {
  constructor(
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async list(options: AuditListFilters & { limit: number; offset: number }): Promise<AuditRow[]> {
    const rows = await this.db
      .select({
        id: auditLog.id,
        actorUserId: auditLog.actorUserId,
        actorUsername: users.username,
        actorDisplayName: users.displayName,
        action: auditLog.action,
        resourceType: auditLog.resourceType,
        resourceId: auditLog.resourceId,
        before: auditLog.before,
        after: auditLog.after,
        batchId: auditLog.batchId,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .leftJoin(users, eq(auditLog.actorUserId, users.id))
      .where(this.filtersClause(options))
      .orderBy(desc(auditLog.id))
      .limit(options.limit)
      .offset(options.offset)

    return rows
  }

  async count(options: AuditListFilters = {}): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(auditLog)
      .leftJoin(users, eq(auditLog.actorUserId, users.id))
      .where(this.filtersClause(options))

    return row?.value ?? 0
  }

  /** Shared by list()/count() so the two can never disagree on which rows count as "in" — same reasoning as UsersRepository.listFilters. `and(...[])` (every filter absent) is `undefined`, which drizzle's `.where()` treats as "no filter" — the original, pre-Task-5 behaviour is preserved exactly when no filter is passed. */
  private filtersClause(filters: AuditListFilters): SQL | undefined {
    const clauses: SQL[] = []
    if (filters.actor !== undefined) clauses.push(this.actorSearchFilter(filters.actor))
    if (filters.action !== undefined) clauses.push(eq(auditLog.action, filters.action))
    if (filters.resourceType !== undefined) clauses.push(eq(auditLog.resourceType, filters.resourceType))
    if (filters.resourceId !== undefined) clauses.push(eq(auditLog.resourceId, filters.resourceId))
    if (filters.batchId !== undefined) clauses.push(eq(auditLog.batchId, filters.batchId))
    if (filters.from !== undefined) clauses.push(gte(auditLog.createdAt, filters.from))
    if (filters.to !== undefined) clauses.push(lte(auditLog.createdAt, filters.to))
    return and(...clauses)
  }

  /**
   * Case-insensitive substring match against the joined actor's username OR
   * displayName — a null actor (system-originated action) never matches any
   * non-empty term, which is correct: there is no name to search. Escaping
   * mirrors UsersRepository.searchFilter's own reasoning exactly (same
   * risk: a literal `%`/`_`/`\` in the caller's term must match itself, not
   * act as an ILIKE wildcard) — duplicated here rather than shared, since
   * the two repositories have no other coupling and this is two lines.
   */
  private actorSearchFilter(term: string): SQL {
    const escaped = term.replace(/[\\%_]/g, (match) => `\\${match}`)
    const pattern = `%${escaped}%`
    return sql`(${users.username} ILIKE ${pattern} OR ${users.displayName} ILIKE ${pattern})`
  }
}
