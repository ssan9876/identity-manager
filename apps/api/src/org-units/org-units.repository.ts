import { createHash } from 'node:crypto'
import { Inject, Injectable, Optional } from '@nestjs/common'
import { and, asc, eq, sql } from 'drizzle-orm'
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
  /**
   * DELIBERATELY EXPOSED (organizations milestone, Task 12), not merely
   * leaked. Every method here `SELECT *`s and returns the row verbatim, so
   * Drizzle has been returning this column since Task 2 regardless of what
   * this interface declared — there are no response DTOs anywhere in this
   * API, so the declared type was simply a lie about the wire format rather
   * than a filter on it. Task 12 had to choose between suppressing it
   * (explicit column lists on every read, in every repository) and owning
   * it; this is the "own it" half, written down.
   *
   * Owning it is right because the value is neither sensitive nor
   * inferable-from-nothing: every actor who can read an org unit at all
   * authenticates against the MASTER realm as a platform operator (design
   * decision 3), and `organization:read` — which returns the full roster and
   * its ids — is held by exactly the same super_admin population. There is
   * no tenant-facing API surface for this to leak ACROSS. What it buys is
   * the console being able to say which tenant a directory row belongs to
   * without a second round trip per row, which is the whole point of a
   * multi-tenant console.
   *
   * If a tenant-facing (non-master) API is ever added, this decision must be
   * revisited THERE, by adding response DTOs — not by quietly deleting the
   * field here and hoping every `SELECT *` was found.
   */
  organizationId: string
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
   * NOT NULL and there was no API surface yet to name a target organization,
   * so a fresh root fell back to master, exactly like
   * GroupsRepository.create's global-group case.
   *
   * Task 12 adds `organizationId` as an OPTIONAL THIRD parameter rather than
   * making it required: `OrganizationsController.create` is the one caller
   * that knows which tenant it is building a root for, and every other call
   * site (bootstrap-admin, the whole test suite) still means "master" and
   * keeps compiling unchanged. Omitting it therefore preserves the exact
   * pre-Task-12 behaviour — the master lookup below still happens, and still
   * costs the same one query — instead of silently changing what an
   * unqualified `createRoot` means.
   *
   * It is third, AFTER `db`, because `db` is the parameter that already had
   * to be passable on its own; putting the organization before it would have
   * forced every existing two-argument call site to be rewritten to keep the
   * same meaning.
   */
  async createRoot(
    name: string,
    db: NodePgDatabase<typeof schema> = this.db,
    organizationId?: string,
  ): Promise<OrgUnit> {
    try {
      const resolvedOrganizationId = organizationId ?? (await this.organizations.findMaster(db)).id
      const [row] = await db
        .insert(orgUnits)
        .values({ name, parentId: null, path: toLabel(name), organizationId: resolvedOrganizationId })
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
  /**
   * Rename an org unit, carrying its whole subtree with it.
   *
   * `path` is DERIVED from the name (`parent.path + '.' + toLabel(name)`),
   * so a rename is not a one-column update: every descendant's path is
   * prefixed by this unit's, and all of them move together or the tree is
   * inconsistent. The rewrite is one `UPDATE` over `path <@ oldPath`, not a
   * walk, so it is atomic and does not depend on how deep the subtree goes.
   *
   * SECURITY, and the reason this is not a cosmetic operation: scoped grants
   * are resolved BY PATH (`PermissionEngine.scopePathsFor`), so moving a
   * subtree's paths moves the reach of every grant that was written against
   * them. The grant rows are keyed on `scope_org_unit_id` and therefore
   * follow the unit automatically — which is the correct behaviour and worth
   * stating, because the alternative (paths that no longer match) would
   * silently strip administrators of access they still hold.
   *
   * Descendants are rewritten BEFORE the unit itself. `org_units_path_unique`
   * is a plain (non-deferrable) unique index, so every intermediate state has
   * to be legal: descendants move to `newPath.*`, which nothing occupies yet
   * because `newPath` itself does not exist until the second statement. A
   * name colliding with a sibling fails on that second statement and takes
   * the whole transaction with it.
   *
   * A rename that does not change the LABEL (different capitalisation,
   * punctuation the slug drops) touches no path at all — `toLabel('Sales')`
   * and `toLabel('sales!')` are both `sales`, and rewriting a subtree to the
   * value it already has would be a lot of write amplification for nothing.
   */
  async rename(
    id: string,
    name: string,
    db: NodePgDatabase<typeof schema> = this.db,
  ): Promise<OrgUnit> {
    const current = await this.findById(id, db)
    if (current === null) {
      throw new NotFoundError('org unit', id)
    }

    const label = toLabel(name)
    const segments = current.path.split('.')
    const newPath = segments.length === 1 ? label : [...segments.slice(0, -1), label].join('.')

    try {
      if (newPath !== current.path) {
        // Strict descendants only. `subpath(path, nlevel(old))` on the unit
        // itself would be an empty ltree, and `newPath || ''` is not a value.
        await db.execute(sql`
          UPDATE org_units
          SET path = ${newPath}::ltree || subpath(path, nlevel(${current.path}::ltree)),
              updated_at = now()
          WHERE path <@ ${current.path}::ltree AND path <> ${current.path}::ltree
        `)
      }

      const [row] = await db
        .update(orgUnits)
        .set({ name, path: newPath, updatedAt: new Date() })
        .where(eq(orgUnits.id, id))
        .returning()

      return row as OrgUnit
    } catch (cause) {
      this.translateWriteError(cause, name)
    }
  }

  /**
   * Delete an org unit, and ONLY if nothing depends on it.
   *
   * Every blocker is counted and named here rather than left to the foreign
   * keys, for two reasons. The lesser one is the message: `restrict` gives a
   * constraint name, and an administrator needs to be told "seven people are
   * still filed here", not `org_units_parent_id_fkey`.
   *
   * The greater one is that ONE of the four references does not restrict at
   * all. `role_assignments.scope_org_unit_id` is ON DELETE CASCADE, so a
   * delete that reached the database would silently revoke every scoped grant
   * pointing at this unit -- no audit row, no refusal, no way to discover it
   * afterwards except by noticing that an administrator has quietly stopped
   * being able to do their job. That is exactly the kind of write this system
   * refuses to make implicitly, so a unit with scoped grants against it
   * cannot be deleted until they are dealt with deliberately.
   *
   * A ROOT unit is never deletable: an organization "owns exactly one root
   * org unit" (Task 1's design), and removing it would leave a tenant with
   * nowhere to put anybody.
   */
  async deleteIfUnused(id: string, db: NodePgDatabase<typeof schema> = this.db): Promise<void> {
    const current = await this.findById(id, db)
    if (current === null) {
      throw new NotFoundError('org unit', id)
    }

    if (current.parentId === null) {
      throw new ConflictError(
        `"${current.name}" is a root org unit and cannot be deleted — every organization owns ` +
          'exactly one, and it is where a tenant with nowhere else to file someone puts them',
      )
    }

    const { rows } = (await db.execute(sql`
      SELECT
        (SELECT count(*) FROM org_units WHERE parent_id = ${id}) AS children,
        (SELECT count(*) FROM users WHERE org_unit_id = ${id}) AS people,
        (SELECT count(*) FROM groups WHERE org_unit_id = ${id}) AS groups,
        (SELECT count(*) FROM role_assignments WHERE scope_org_unit_id = ${id}) AS grants
    `)) as unknown as {
      rows: [{ children: string; people: string; groups: string; grants: string }]
    }

    const counts = rows[0]
    const blockers: string[] = []
    const child = Number(counts.children)
    const people = Number(counts.people)
    const groups = Number(counts.groups)
    const grants = Number(counts.grants)

    if (child > 0) blockers.push(`${child} child org unit${child === 1 ? '' : 's'}`)
    if (people > 0) blockers.push(`${people} ${people === 1 ? 'person' : 'people'}`)
    if (groups > 0) blockers.push(`${groups} group${groups === 1 ? '' : 's'}`)
    if (grants > 0) {
      // The cascade one. Named last and worded as a warning rather than a
      // count, because unlike the others this would not have stopped itself.
      blockers.push(
        `${grants} scoped role assignment${grants === 1 ? '' : 's'} (deleting the unit would ` +
          'revoke them silently -- the foreign key cascades)',
      )
    }

    if (blockers.length > 0) {
      throw new ConflictError(
        `"${current.name}" still has ${blockers.join(', ')} — move or remove them first`,
      )
    }

    await db.delete(orgUnits).where(eq(orgUnits.id, id))
  }

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
   * "Which of these ids exist?" in ONE round trip — the set-based sibling of
   * `findById` above, for a caller holding many ids at once (bulk import
   * resolves an org unit per CSV row; see `ImportLookups`). Selects the id
   * column alone because existence is the only question asked: a 5,000-row
   * file typically names a handful of DISTINCT org units, so this is one
   * small query in place of one round trip per row.
   *
   * Ids are bound as a single `uuid[]` parameter — every caller has already
   * shape-validated them as UUIDs (import rows via `parseImportRowShape`),
   * so a non-UUID string here is a caller bug and Postgres rejecting it is
   * the correct outcome, exactly as `findById` behaves today.
   */
  async listExistingIds(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set()
    const rows = await this.db
      .select({ id: orgUnits.id })
      .from(orgUnits)
      .where(sql`${orgUnits.id} = ANY (${sql.param([...ids])}::uuid[])`)

    return new Set(rows.map((row) => row.id))
  }

  /**
   * The first MASTER-ORGANIZATION org unit by `path` ordering (matching
   * `list`'s own ordering, so this is "whatever `list` would show first"
   * within master), or `null` if master has none yet. Deliberately not
   * restricted to roots (`parentId === null`) — any existing org unit is a
   * perfectly good home for a newly-created user, and this repository has no
   * cheaper way to ask "is master's slice of org_units empty" than a
   * `LIMIT 1` select.
   *
   * Exists for `bootstrap-admin` (apps/api/src/admin/bootstrap-admin.ts):
   * the anti-lockout script only needs SOME org unit to satisfy `users`'
   * NOT NULL `org_unit_id` FK, and reusing whatever already exists — rather
   * than minting a fresh root unconditionally — is what makes a second run
   * against a database that already has one idempotent instead of
   * accumulating an extra root org unit on every run.
   *
   * The master filter matters because that is the ONLY caller and because
   * `UsersRepository.create` DERIVES `organization_id` from the org unit it
   * is given. Unfiltered, this ordered-by-path lookup would happily return a
   * tenant's org unit (a tenant whose path simply sorts first, or any tenant
   * at all on an install where master has no org unit yet), and the recovery
   * admin would be created inside that tenant — where
   * `PermissionEngine.resolveActor`, which resolves principals in master
   * only, can never find them. The script would report success and the
   * operator would stay locked out, which is precisely the failure
   * bootstrap-admin exists to prevent. It also matches `createRoot`'s
   * unqualified behaviour immediately below/above, which already means
   * "master" — the two halves of bootstrap's find-or-create had drifted
   * apart on exactly this point.
   */
  async findFirst(db: NodePgDatabase<typeof schema> = this.db): Promise<OrgUnit | null> {
    const master = await this.organizations.findMaster(db)
    const [row] = await db
      .select()
      .from(orgUnits)
      .where(eq(orgUnits.organizationId, master.id))
      .orderBy(asc(orgUnits.path))
      .limit(1)

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

  /**
   * Scope AND tenant, as one predicate, so `list` and `count` cannot drift
   * apart. They already shared `scopeFilter`; adding a second filter to only
   * one of them is how a paginator starts reporting a total that does not
   * match the rows it can actually show.
   */
  private listFilters(options: { scopePaths?: string[] | null; organizationId?: string }) {
    const filters = []
    const scope = this.scopeFilter(options.scopePaths)
    if (scope !== undefined) filters.push(scope)
    if (options.organizationId !== undefined) {
      filters.push(eq(orgUnits.organizationId, options.organizationId))
    }
    return filters.length === 0 ? undefined : and(...filters)
  }

  async list(options: {
    limit: number
    offset: number
    scopePaths?: string[] | null
    /** Restrict to ONE tenant — see UsersRepository.list's own note on why this is a repository filter and not a post-hoc one. */
    organizationId?: string
  }): Promise<OrgUnit[]> {
    const rows = await this.db
      .select()
      .from(orgUnits)
      .where(this.listFilters(options))
      .orderBy(asc(orgUnits.path))
      .limit(options.limit)
      .offset(options.offset)

    return rows as OrgUnit[]
  }

  async count(
    options: { scopePaths?: string[] | null; organizationId?: string } = {},
  ): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(orgUnits)
      .where(this.listFilters(options))

    return row?.value ?? 0
  }
}
