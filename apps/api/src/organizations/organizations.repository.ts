import { Inject, Injectable } from '@nestjs/common'
import { asc, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { ConflictError } from '../common/errors'
import type { PageQuery } from '../common/pagination'
import * as schema from '../db/schema/index'
import { type Organization, organizations } from '../db/schema/organizations'
import type { DbHandle } from '../outbox/outbox.writer'

const UNIQUE_VIOLATION = '23505'

// Exact index name, taken from the generated migration SQL
// (0025_organizations_backfill.sql / 0032) — never guessed. See
// UsersRepository.translateWriteError's doc comment for why constraint
// NAME, not SQLSTATE alone, is what decides the branch below.
const SLUG_UNIQUE_CONSTRAINT = 'organizations_slug_unique'

/**
 * Milestone: organizations multi-tenancy, Task 2, widened in Task 12 with
 * the write surface `POST/GET/PATCH /organizations` needs. It began
 * read-only so write paths that must fall back to master
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

  /**
   * The tenant roster, ordered by `slug` — a stable, human-meaningful
   * ordering, and the same column the console sorts on. Deliberately
   * INCLUDES master: an operator's first question about the roster is
   * usually "which of these is the platform's own", and hiding the row that
   * answers it would only push that question into a second endpoint.
   *
   * No scope filter parameter, unlike `UsersRepository.list`/
   * `OrgUnitsRepository.list`: an organization has no containing org unit,
   * so there is nothing an ltree scope could narrow on — the caller
   * (`OrganizationsController.list`) instead requires a GLOBAL grant before
   * ever reaching here. See `requireGlobalGrant`'s own doc comment.
   */
  async list(page: PageQuery, db: NodePgDatabase<typeof schema> = this.db): Promise<Organization[]> {
    return db
      .select()
      .from(organizations)
      .orderBy(asc(organizations.slug))
      .limit(page.limit)
      .offset(page.offset)
  }

  async count(db: NodePgDatabase<typeof schema> = this.db): Promise<number> {
    const [row] = await db.select({ total: sql<number>`count(*)::int` }).from(organizations)
    return row?.total ?? 0
  }

  async findById(
    id: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<Organization | null> {
    const [row] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1)
    return row ?? null
  }

  /**
   * Inserts a TENANT organization. `isMaster` is deliberately not a
   * parameter and never set here: exactly one master row exists, created by
   * migration 0025 and pinned at startup (`adoptMasterRealm`), and
   * `organizations_master_unique` would reject a second one anyway — making
   * it settable would only turn a schema guarantee into a runtime error
   * message.
   *
   * `realmProvisionedAt` is likewise not a parameter: it is written by
   * `SyncWorker.reconcileOrganization` once the realm genuinely exists in
   * Keycloak (Task 14), so a row this method returns always reads
   * "provisioning" until that has actually happened. Claiming otherwise at
   * insert time would make the console's badge a lie for the whole window
   * where it matters most.
   *
   * Takes the caller's `tx` REQUIRED, not optionally: every caller creates
   * the root org unit, the audit row and the outbox event in the same
   * transaction, and an organization without its root org unit is a shape
   * nothing else in this codebase knows how to handle.
   */
  async create(
    tx: DbHandle,
    input: { slug: string; name: string; realm: string },
  ): Promise<Organization> {
    try {
      const [row] = await tx
        .insert(organizations)
        .values({ slug: input.slug, name: input.name, realm: input.realm })
        .returning()
      return row as Organization
    } catch (cause) {
      this.translateWriteError(cause, input.slug)
    }
  }

  /**
   * `status` only. There is deliberately no method that updates `slug` or
   * `realm`: both become a Keycloak realm NAME the moment the organization
   * provisions, and every `external_identities` row for every person in the
   * tenant points into that realm — renaming it would strand all of them.
   * `updateOrganizationBodySchema`'s `.strict()` is the HTTP-level half of
   * the same rule; this is the repository-level half, so no future caller
   * can reach past it.
   */
  async setStatus(
    tx: DbHandle,
    id: string,
    status: 'active' | 'suspended',
  ): Promise<Organization> {
    const [row] = await tx
      .update(organizations)
      .set({ status, updatedAt: new Date() })
      .where(eq(organizations.id, id))
      .returning()
    return row as Organization
  }

  /**
   * Maps a Postgres write-constraint violation to the right DomainError, by
   * CONSTRAINT NAME — never by SQLSTATE alone (see
   * UsersRepository.translateWriteError's doc comment for the full reasoning
   * this mirrors). `organizations` has exactly one constraint reachable
   * through `create`: a slug that is already taken. Unlike the user-facing
   * "not available" wording that finding SEC-L2 forced on `users`, this one
   * NAMES the slug — the caller must already hold a global
   * `organization:create` grant (super_admin only) to get here, and such an
   * actor can list every organization anyway, so there is no existence
   * oracle to protect.
   *
   * The CHECK constraint `organizations_slug_format` is deliberately NOT
   * translated: Zod rejects a malformed slug with a 400 before any insert is
   * attempted, so a CHECK violation here would mean the two patterns had
   * drifted apart — a bug, and it should surface as the 500 a bug deserves
   * rather than being laundered into a 4xx.
   */
  private translateWriteError(cause: unknown, slug: string): never {
    const pgError = cause as { code?: string; constraint?: string }

    if (pgError.code === UNIQUE_VIOLATION && pgError.constraint === SLUG_UNIQUE_CONSTRAINT) {
      throw new ConflictError(`an organization with the slug "${slug}" already exists`)
    }

    throw cause
  }
}
