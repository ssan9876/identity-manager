import { Inject, Injectable } from '@nestjs/common'
import { asc, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { ConflictError, NotFoundError } from '../common/errors'
import { hrSources, type HrSource } from '../db/schema/hr-sources'
import * as schema from '../db/schema/index'
import { users } from '../db/schema/users'
import type { DbHandle } from '../outbox/outbox.writer'

const UNIQUE_VIOLATION = '23505'
/** Must match the index NAME 0040 creates — see that migration's own comment on why renaming it would silently turn a 409 into a 500. */
const ORG_NAME_UNIQUE_CONSTRAINT = 'hr_sources_org_name_unique'

function translateWriteError(error: unknown): never {
  const pgError = error as { code?: string; constraint?: string }
  if (pgError?.code === UNIQUE_VIOLATION && pgError.constraint === ORG_NAME_UNIQUE_CONSTRAINT) {
    throw new ConflictError('an HR source with that name already exists in this organization')
  }
  throw error
}

export interface CreateHrSourceInput {
  organizationId: string
  name: string
  kind: 'csv_url'
  url: string
  authHeaderName: string | null
  authSecretName: string | null
  columnMapping: Record<string, string>
  enabled?: boolean
  blastRadiusThreshold?: number
  blastRadiusFloor?: number
}

/**
 * `undefined` = "this request doesn't touch it" (same contract as
 * UpdateUserInput). `kind` and `organizationId` are deliberately absent —
 * both are immutable after creation: a source's identity IS its tenant plus
 * what it points at, and repointing a live feed at another tenant is
 * exactly the cross-tenant write the composite-tenancy work exists to
 * forbid. The auth pair travels together (both or neither), mirroring the
 * `hr_sources_auth_pair` CHECK.
 */
export interface UpdateHrSourceInput {
  name?: string
  url?: string
  auth?: { headerName: string; secretName: string } | null
  columnMapping?: Record<string, string>
  enabled?: boolean
  blastRadiusThreshold?: number
  blastRadiusFloor?: number
}

/** The closed outcome vocabulary — derived from the schema's own enum column so the two can never drift. */
export type HrRunOutcome = NonNullable<HrSource['lastRunOutcome']>

export interface HrRunFinish {
  outcome: HrRunOutcome
  counts: Record<string, unknown>
}

/**
 * CRUD-minus-delete over `hr_sources` — there is deliberately NO delete
 * method on this class (disable instead; see the table's own doc comment).
 * Every mutation takes the caller's open `tx` so the row write and its
 * audit entry (HrSourcesController / HrSyncService) commit or roll back
 * together — the same discipline every other repository here follows.
 */
@Injectable()
export class HrSourcesRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>) {}

  async list(db: NodePgDatabase<typeof schema> = this.db): Promise<HrSource[]> {
    return db.select().from(hrSources).orderBy(asc(hrSources.name))
  }

  async findById(id: string, db: NodePgDatabase<typeof schema> = this.db): Promise<HrSource | null> {
    const [row] = await db.select().from(hrSources).where(eq(hrSources.id, id)).limit(1)
    return row ?? null
  }

  /** CLI convenience: an exact id match first, then a name match (the CLI's `<source>` argument accepts either). A name shared across organizations is ambiguous and refused rather than guessed at. */
  async findByIdOrName(idOrName: string, db: NodePgDatabase<typeof schema> = this.db): Promise<HrSource | null> {
    const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (uuidShape.test(idOrName)) {
      const byId = await this.findById(idOrName, db)
      if (byId !== null) return byId
    }
    const rows = await db.select().from(hrSources).where(eq(hrSources.name, idOrName)).limit(2)
    if (rows.length > 1) {
      throw new ConflictError(
        `more than one HR source is named "${idOrName}" (across organizations) — use its id instead`,
      )
    }
    return rows[0] ?? null
  }

  async create(tx: DbHandle, input: CreateHrSourceInput): Promise<HrSource> {
    const [row] = await tx
      .insert(hrSources)
      .values({
        organizationId: input.organizationId,
        name: input.name,
        kind: input.kind,
        url: input.url,
        authHeaderName: input.authHeaderName,
        authSecretName: input.authSecretName,
        // Spread, deliberately: parseColumnMapping returns a null-prototype
        // object (its __proto__ safety), and drizzle's own `is()` walk
        // cannot handle a null prototype. Spread copies own enumerable
        // properties via CreateDataProperty — a genuine own "__proto__"
        // key survives the copy as data, never as a setter call.
        columnMapping: { ...input.columnMapping },
        enabled: input.enabled ?? false,
        blastRadiusThreshold: input.blastRadiusThreshold,
        blastRadiusFloor: input.blastRadiusFloor,
      })
      .returning()
      .catch(translateWriteError)
    return row
  }

  async update(tx: DbHandle, id: string, patch: UpdateHrSourceInput): Promise<HrSource> {
    const set: Partial<typeof hrSources.$inferInsert> = { updatedAt: new Date() }
    if (patch.name !== undefined) set.name = patch.name
    if (patch.url !== undefined) set.url = patch.url
    if (patch.auth !== undefined) {
      set.authHeaderName = patch.auth?.headerName ?? null
      set.authSecretName = patch.auth?.secretName ?? null
    }
    // Spread for the same null-prototype reason as `create` above.
    if (patch.columnMapping !== undefined) set.columnMapping = { ...patch.columnMapping }
    if (patch.enabled !== undefined) set.enabled = patch.enabled
    if (patch.blastRadiusThreshold !== undefined) set.blastRadiusThreshold = patch.blastRadiusThreshold
    if (patch.blastRadiusFloor !== undefined) set.blastRadiusFloor = patch.blastRadiusFloor

    const [row] = await tx
      .update(hrSources)
      .set(set)
      .where(eq(hrSources.id, id))
      .returning()
      .catch(translateWriteError)
    if (row === undefined) {
      throw new NotFoundError('HR source', id)
    }
    return row
  }

  /** Marks a run as begun: started stamped, the previous run's finished/outcome/counts CLEARED — a crashed run is then visible as "started, never finished" rather than wearing a stale outcome. Its own short write, not part of the run's (nonexistent) enclosing transaction: the mark must survive whatever the run later does. */
  async recordRunStarted(id: string, db: NodePgDatabase<typeof schema> = this.db): Promise<void> {
    await db
      .update(hrSources)
      .set({
        lastRunStartedAt: new Date(),
        lastRunFinishedAt: null,
        lastRunOutcome: null,
        lastRunCounts: null,
        updatedAt: new Date(),
      })
      .where(eq(hrSources.id, id))
  }

  /** Runs inside the caller's `tx` so the outcome and its `hr_source:sync` audit row commit together. */
  async recordRunFinished(tx: DbHandle, id: string, finish: HrRunFinish): Promise<void> {
    await tx
      .update(hrSources)
      .set({
        lastRunFinishedAt: new Date(),
        lastRunOutcome: finish.outcome,
        lastRunCounts: finish.counts,
        updatedAt: new Date(),
      })
      .where(eq(hrSources.id, id))
  }

  /** The blast-radius guard's population: every existing person in the source's organization, any status — mirroring TargetReconciliationJob's own "every user, every status" population definition. */
  async countUsersInOrganization(
    organizationId: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.organizationId, organizationId))
    return row?.count ?? 0
  }
}
