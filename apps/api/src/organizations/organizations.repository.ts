import { Inject, Injectable } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import * as schema from '../db/schema/index'
import { type Organization, organizations } from '../db/schema/organizations'

/**
 * Milestone: organizations multi-tenancy, Task 2. Read-only for now — the
 * write surface (`POST /organizations`, realm provisioning, ...) is a later
 * task. This exists today only so write paths that must fall back to master
 * (a global group with no org unit — GroupsRepository.create; a root org
 * unit with no parent — OrgUnitsRepository.createRoot) have somewhere to
 * resolve it from, without duplicating the query at each call site.
 */
@Injectable()
export class OrganizationsRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>) {}

  /**
   * `db` is an OPTIONAL trailing handle, defaulting to the injected pooled
   * connection (`this.db`) — same contract as UsersRepository's write
   * methods (see its doc comment for the full explanation). Callers that
   * already opened a transaction (GroupsRepository.create,
   * OrgUnitsRepository.createRoot) pass that `tx` through instead, so the
   * lookup runs on the SAME connection as the write it feeds.
   *
   * Throws rather than returning `null`: the migration in this same task
   * guarantees exactly one master row exists from the moment it runs
   * (`organizations_master_unique`, a partial unique index, additionally
   * guarantees there is never more than one) — a caller reaching this with
   * none existing indicates a corrupt or pre-migration database, not a
   * normal "not found" outcome a caller should handle gracefully.
   */
  async findMaster(db: NodePgDatabase<typeof schema> = this.db): Promise<Organization> {
    const [master] = await db.select().from(organizations).where(eq(organizations.isMaster, true))
    if (master === undefined) {
      throw new Error('no master organization exists — has the organizations backfill migration run?')
    }
    return master
  }
}
