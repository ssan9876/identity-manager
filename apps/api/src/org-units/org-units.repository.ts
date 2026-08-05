import { eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
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

/**
 * Converts a human name into a single valid ltree label.
 * ltree labels permit only [A-Za-z0-9_].
 */
export function toLabel(name: string): string {
  const label = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

  if (label.length === 0) {
    throw new Error(`"${name}" does not contain a valid ltree label`)
  }

  return label
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
      throw new Error(`parent org unit not found: ${parentId}`)
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
