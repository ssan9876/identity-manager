import { Injectable } from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { auditLog } from '../db/schema/audit-log'
import * as schema from '../db/schema/index'

/** Either the pooled database handle or a live transaction handle. */
export type DbHandle =
  | NodePgDatabase<typeof schema>
  | Parameters<Parameters<NodePgDatabase<typeof schema>['transaction']>[0]>[0]

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
   * Takes the caller's handle rather than opening its own, so the audit row
   * and the mutation it describes commit or roll back together. Never call
   * this with the pooled handle from inside a transaction.
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
