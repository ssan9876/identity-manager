import { createHash } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { NotFoundError } from '../common/errors'
import * as schema from '../db/schema/index'
import { orgUnits } from '../db/schema/org-units'

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

export class OrgUnitsRepository {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async createRoot(name: string): Promise<OrgUnit> {
    const [row] = await this.db
      .insert(orgUnits)
      .values({ name, parentId: null, path: toLabel(name) })
      .returning()

    return row as OrgUnit
  }

  async createChild(parentId: string, name: string): Promise<OrgUnit> {
    const parent = await this.findById(parentId)
    if (parent === null) {
      throw new NotFoundError('parent org unit', parentId)
    }

    const [row] = await this.db
      .insert(orgUnits)
      .values({
        name,
        parentId,
        path: `${parent.path}.${toLabel(name)}`,
      })
      .returning()

    return row as OrgUnit
  }

  async findById(id: string): Promise<OrgUnit | null> {
    const [row] = await this.db
      .select()
      .from(orgUnits)
      .where(eq(orgUnits.id, id))
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
}
