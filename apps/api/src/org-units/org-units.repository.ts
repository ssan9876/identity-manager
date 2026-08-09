import { createHash } from 'node:crypto'
import { Inject, Injectable, Optional } from '@nestjs/common'
import { asc, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { ConflictError, NotFoundError } from '../common/errors'
import * as schema from '../db/schema/index'
import { orgUnits } from '../db/schema/org-units'
import { OrganizationsRepository } from '../organizations/organizations.repository'

/**
 * The organization a given org unit belongs to — a targeted, single-column
 * lookup, never the full row (see UsersRepository.create's identical
 * derivation, which this mirrors). `NotFoundError('org unit', ...)` on a
 * missing id, exactly like every other org-unit-id reference in this
 * codebase.
 */
export async function requireOrgUnitOrganization(
  db: NodePgDatabase<typeof schema>,
  orgUnitId: string,
): Promise<string> {
  const [unit] = await db
    .select({ organizationId: orgUnits.organizationId })
    .from(orgUnits)
    .where(eq(orgUnits.id, orgUnitId))
  if (unit === undefined) {
    throw new NotFoundError('org unit', orgUnitId)
  }
  return unit.organizationId
}

const UNIQUE_VIOLATION = '23505'

// Exact index name, taken from the generated migration SQL
// (0000_dry_epoch.sql) — never guessed. See
// UsersRepository.translateWriteError's doc comment for why constraint
// NAME, not SQLSTATE alone, is what decides the branch below.
const PATH_UNIQUE_CONSTRAINT = 'org_units_path_unique'

export interface OrgUnit {
  id: string
  name: string
  parentId: string | null
  path: string
  createdAt: Date
  updatedAt: Date
}

// ltree labels have a length ceiling; name is varchar(255), so cap well under it.
const MAX_LABEL_LENGTH = 200

// Combining diacritical marks split off by NFKD normalization (e.g. the
// acute accent separated from "é"). Stripping these lets accented Latin
// names collapse to their unaccented ASCII form instead of falling back to a
// hash, and stops names that differ only by diacritics/punctuation (e.g.
// "Café" vs "Caf!") from colliding on the same label.
const COMBINING_MARKS_LOW = 0x0300
const COMBINING_MARKS_HIGH = 0x036f

function stripCombiningMarks(input: string): string {
  let result = ''
  for (const char of input) {
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint < COMBINING_MARKS_LOW || codePoint > COMBINING_MARKS_HIGH) {
      result += char
    }
  }
  return result
}

/**
 * Converts a human name into a single valid ltree label ([A-Za-z0-9_]+).
 * Never throws — the real, unrestricted name is stored separately in the
 * `name` column; this label only has to be a stable, unique-enough handle
 * for the path.
 *
 * Names that are entirely non-Latin script (CJK, Cyrillic, emoji, ...) have
 * no ASCII-representable content left after slugification. Those fall back
 * to a deterministic label derived from a hash of the original name, rather
 * than transliterating (which would need a dependency and introduces its
 * own collisions). Determinism matters: the same name must always produce
 * the same label so the `org_units_path_unique` index still catches genuine
 * duplicate siblings.
 */
export function toLabel(name: string): string {
  const slug = stripCombiningMarks(name.normalize('NFKD'))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

  if (slug.length > 0) {
    return slug.slice(0, MAX_LABEL_LENGTH)
  }

  const hash = createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 12)
  return `ou_${hash}`
}

@Injectable()
export class OrgUnitsRepository {
  constructor(
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
    // OPTIONAL, defaulting to a raw instance bound to the same `db` — same
    // pattern SyncWorker/ReconciliationJob use for their own OrgUnitsRepository
    // dependency (see e.g. sync.worker.ts). Keeps every existing single-argument
    // `new OrgUnitsRepository(db)` call site across the test suite compiling
    // unchanged, while real Nest DI (AppModule) hands this the SAME managed
    // OrganizationsRepository instance every other provider gets.
    @Optional()
    @Inject(OrganizationsRepository)
    private readonly organizations: OrganizationsRepository = new OrganizationsRepository(db),
  ) {}

  /**
   * `createRoot`, `createChild` and `findById` below all accept an OPTIONAL
   * trailing `db` handle, defaulting to the injected pooled connection
   * (`this.db`) — same contract as UsersRepository's write methods (see its
   * doc comment for the full explanation). OrgUnitsController.create passes
   * its open transaction through, so the insert and its
   * AuditWriter.record(tx, …) audit row commit or roll back together.
   *
   * Milestone: organizations multi-tenancy, Task 2 — `organizationId` is
   * NOT NULL and there is no API surface yet to name a target organization
   * (that is a later task), so a fresh root falls back to master, exactly
   * like GroupsRepository.create's global-group case: today there is only
   * ever one organization, so every root org unit belongs to it.
   */
  async createRoot(name: string, db: NodePgDatabase<typeof schema> = this.db): Promise<OrgUnit> {
    try {
      const master = await this.organizations.findMaster(db)
      const [row] = await db
        .insert(orgUnits)
        .values({ name, parentId: null, path: toLabel(name), organizationId: master.id })
        .returning()

      return row as OrgUnit
    } catch (cause) {
      this.translateWriteError(cause, name)
    }
  }

  async createChild(
    parentId: string,
    name: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<OrgUnit> {
    const parent = await this.findById(parentId, db)
    if (parent === null) {
      throw new NotFoundError('parent org unit', parentId)
    }

    // Derived from the parent, never a parameter: a child org unit always
    // belongs to the SAME organization as its parent — Task 1's design
    // ("owns exactly one root org unit") only holds if a whole subtree
    // shares one organization, and this is what keeps it true by
    // construction rather than by convention.
    const organizationId = await requireOrgUnitOrganization(db, parentId)

    try {
      const [row] = await db
        .insert(orgUnits)
        .values({
          name,
          parentId,
          path: `${parent.path}.${toLabel(name)}`,
          organizationId,
        })
        .returning()

      return row as OrgUnit
    } catch (cause) {
      this.translateWriteError(cause, name)
    }
  }

  /**
   * Maps a Postgres write-constraint violation to the right DomainError, by
   * CONSTRAINT NAME — never by SQLSTATE alone (see
   * UsersRepository.translateWriteError's doc comment for the full
   * reasoning this mirrors). `org_units` has only one constraint reachable
   * through these two methods today (`parent_id`'s FK is already covered by
   * `createChild`'s own pre-check above, which throws a clean NotFoundError
   * before any insert is attempted): two siblings whose names both slugify
   * to the same label collide on `org_units_path_unique`. Not literally
   * named in task-3-brief.md's carried-finding item (that one is scoped to
   * GroupsRepository), but the same class of gap on this task's own new
   * write endpoint — left unmapped, it would 500 rather than 409 on the
   * first realistic collision (e.g. "Sales" and "sales" as siblings; see
   * org-units.repository.spec.ts's existing "rejects two siblings" test).
   * Anything unrecognized is rethrown verbatim, never swallowed.
   */
  private translateWriteError(cause: unknown, name: string): never {
    const pgError = cause as { code?: string; constraint?: string }

    if (pgError.code === UNIQUE_VIOLATION && pgError.constraint === PATH_UNIQUE_CONSTRAINT) {
      throw new ConflictError(`an org unit named "${name}" already exists at this level`)
    }

    throw cause
  }

  async findById(id: string, db: NodePgDatabase<typeof schema> = this.db): Promise<OrgUnit | null> {
    const [row] = await db
      .select()
      .from(orgUnits)
      .where(eq(orgUnits.id, id))
      .limit(1)

    return (row as OrgUnit | undefined) ?? null
  }

  /**
   * The first org unit in the system by `path` ordering (matching `list`'s
   * own ordering, so this is "whatever `list` would show first"), or `null`
   * if none exists yet. Deliberately not restricted to roots
   * (`parentId === null`) — any existing org unit is a perfectly good home
   * for a newly-created user, and this repository has no cheaper way to ask
   * "is the org_units table empty" than a `LIMIT 1` select.
   *
   * Exists for `bootstrap-admin` (apps/api/src/admin/bootstrap-admin.ts):
   * the anti-lockout script only needs SOME org unit to satisfy `users`'
   * NOT NULL `org_unit_id` FK, and reusing whatever already exists — rather
   * than minting a fresh root unconditionally — is what makes a second run
   * against a database that already has one idempotent instead of
   * accumulating an extra root org unit on every run.
   */
  async findFirst(db: NodePgDatabase<typeof schema> = this.db): Promise<OrgUnit | null> {
    const [row] = await db.select().from(orgUnits).orderBy(asc(orgUnits.path)).limit(1)

    return (row as OrgUnit | undefined) ?? null
  }

  async findSubtree(rootId: string): Promise<OrgUnit[]> {
    const root = await this.findById(rootId)
    if (root === null) {
      return []
    }

    const rows = await this.db
      .select()
      .from(orgUnits)
      .where(sql`${orgUnits.path} <@ ${root.path}::ltree`)

    return rows as OrgUnit[]
  }

  /**
   * True when `targetPath` is `scopePath` or a descendant of it. This is the
   * single indexed containment check the scoped permission engine relies on.
   */
  async isWithinScope(scopePath: string, targetPath: string): Promise<boolean> {
    const { rows } = await this.db.execute<{ contained: boolean }>(
      sql`SELECT ${targetPath}::ltree <@ ${scopePath}::ltree AS contained`,
    )

    return rows[0]?.contained ?? false
  }

  /**
   * `undefined`/`null` means unrestricted (no filter at all — matches
   * PermissionEngine.scopePathsFor's contract exactly). An array — including
   * `[]` — adds a real filter; `[]` matches no row, it does NOT fall back to
   * unrestricted. Do not spell this `if (scopePaths?.length)`; see
   * scopePathsFor's doc comment for what that trap does to an actor entitled
   * nowhere.
   *
   * `scopePaths` is bound as ONE array-typed parameter via `sql.param`,
   * never interpolated into the query text — see
   * permission.engine.ts:131 for why a bare `${scopePaths}` splice breaks.
   */
  private scopeFilter(scopePaths?: string[] | null) {
    if (scopePaths === undefined || scopePaths === null) {
      return undefined
    }
    return sql`${orgUnits.path} <@ ANY (${sql.param(scopePaths)}::ltree[])`
  }

  async list(options: { limit: number; offset: number; scopePaths?: string[] | null }): Promise<OrgUnit[]> {
    const rows = await this.db
      .select()
      .from(orgUnits)
      .where(this.scopeFilter(options.scopePaths))
      .orderBy(asc(orgUnits.path))
      .limit(options.limit)
      .offset(options.offset)

    return rows as OrgUnit[]
  }

  async count(options: { scopePaths?: string[] | null } = {}): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(orgUnits)
      .where(this.scopeFilter(options.scopePaths))

    return row?.value ?? 0
  }
}
