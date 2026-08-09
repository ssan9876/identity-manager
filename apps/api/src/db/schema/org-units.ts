import {
  type AnyPgColumn,
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { ltree } from '../ltree'
import { organizations } from './organizations'

export const orgUnits = pgTable(
  'org_units',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => orgUnits.id, {
      onDelete: 'restrict',
    }),
    path: ltree('path').notNull(),
    // Milestone: organizations multi-tenancy, Task 2. Every org unit belongs
    // to exactly one tenant — backfilled to the single master organization
    // for all pre-existing rows (see the organizations backfill migration).
    // ON DELETE RESTRICT: an organization can never be removed out from
    // under org units that still reference it.
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pathGist: index('org_units_path_gist').using('gist', table.path),
    pathUnique: uniqueIndex('org_units_path_unique').on(table.path),
    organizationIdx: index('org_units_organization_idx').on(table.organizationId),
  }),
)
