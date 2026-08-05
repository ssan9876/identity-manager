import { Inject, Injectable } from '@nestjs/common'
import { desc, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { auditLog } from '../db/schema/audit-log'
import * as schema from '../db/schema/index'

export interface AuditRow {
  id: number
  actorUserId: string | null
  action: string
  resourceType: string
  resourceId: string | null
  before: unknown
  after: unknown
  createdAt: Date
}

@Injectable()
export class AuditRepository {
  constructor(
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async list(options: { limit: number; offset: number }): Promise<AuditRow[]> {
    const rows = await this.db
      .select()
      .from(auditLog)
      .orderBy(desc(auditLog.id))
      .limit(options.limit)
      .offset(options.offset)

    return rows
  }

  async count(): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(auditLog)

    return row?.value ?? 0
  }
}
