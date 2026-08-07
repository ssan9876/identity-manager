import { Inject, Injectable } from '@nestjs/common'
import { and, asc, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DB_CLIENT } from '../common/db.token'
import { attributeDefinitions } from '../db/schema/attribute-definitions'
import * as schema from '../db/schema/index'
import type { AttributeDefinition, ValidationRules } from './attribute-validator'

@Injectable()
export class AttributeDefinitionsRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>) {}

  /**
   * Active attribute definitions for one entity type, ordered by `sortOrder`
   * (then `key` as a tiebreaker, since `sortOrder` alone is not unique) —
   * the schema's own `sort_order` column exists precisely so a client can
   * render fields in a sensible, admin-configured order, but nothing before
   * this method has ever read it: `UsersRepository.
   * listActiveAttributeDefinitions` (unchanged, still unordered) is used
   * only to build a VALIDATION schema, where order is irrelevant. This is a
   * separate, read-only path for a client to build a FORM from (Milestone
   * 8, Task 3's `GET /attribute-definitions`), where order is exactly the
   * point.
   *
   * Filter shape (isActive + appliesTo) intentionally mirrors
   * `UsersRepository.listActiveAttributeDefinitions` — this does not
   * replace that method (which stays exactly as it is, still user-only, for
   * POST/PATCH /users' own validation) but is not a new concept either, just
   * the same filter generalised to the `appliesTo` this table already
   * models for both entity types.
   */
  async listActive(appliesTo: 'user' | 'group'): Promise<AttributeDefinition[]> {
    const rows = await this.db
      .select()
      .from(attributeDefinitions)
      .where(
        and(eq(attributeDefinitions.isActive, true), eq(attributeDefinitions.appliesTo, appliesTo)),
      )
      .orderBy(asc(attributeDefinitions.sortOrder), asc(attributeDefinitions.key))

    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      label: row.label,
      dataType: row.dataType,
      required: row.required,
      validationRules: (row.validationRules ?? {}) as ValidationRules,
      appliesTo: row.appliesTo,
      isActive: row.isActive,
      selfEditable: row.selfEditable,
    }))
  }
}
