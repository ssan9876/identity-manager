import { Injectable } from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { auditLog } from '../db/schema/audit-log'
import * as schema from '../db/schema/index'

/**
 * The live transaction handle passed to a `db.transaction(async (tx) => ...)`
 * callback — deliberately narrower than "the pooled handle or a transaction
 * handle". Drizzle's `PgTransaction` extends the pooled `NodePgDatabase`
 * shape with members the pool does not have (e.g. `rollback`), so passing
 * the pooled handle where a `DbHandle` is expected is a compile error, not
 * just a documented footgun. See `AuditWriter.record`.
 */
export type DbHandle = Parameters<
  Parameters<NodePgDatabase<typeof schema>['transaction']>[0]
>[0]

/**
 * `before` and `after` are persisted exactly as given — this module never
 * redacts, filters, or inspects them. Excluding credential-shaped data
 * (passwords, tokens, secrets, API keys) before it reaches `AuditWriter.record`
 * is entirely the CALLER's responsibility. Because `audit_log` is append-only
 * (enforced at the database level — see `enforceAuditAppendOnly` in
 * `db/migrate.ts`), a secret written into `before`/`after` can never be edited
 * or deleted afterward: there is no "fix it in a follow-up" for a leak into
 * this table.
 */
export interface AuditEntry {
  actorUserId: string | null
  action: string
  resourceType: string
  resourceId: string | null
  before: unknown
  after: unknown
}

@Injectable()
export class AuditWriter {
  /**
   * Takes the caller's transaction handle rather than opening its own, so
   * the audit row and the mutation it describes commit or roll back
   * together. `DbHandle` accepts only a live transaction handle — the
   * pooled handle does not satisfy the type, so the compiler rejects it —
   * meaning a standalone write must go through
   * `db.transaction(async (tx) => writer.record(tx, entry))`.
   *
   * `entry.before`/`entry.after` are written verbatim; see the warning on
   * `AuditEntry` about redaction being the caller's responsibility.
   */
  async record(tx: DbHandle, entry: AuditEntry): Promise<void> {
    await tx.insert(auditLog).values({
      actorUserId: entry.actorUserId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      before: entry.before ?? null,
      after: entry.after ?? null,
    })
  }
}
