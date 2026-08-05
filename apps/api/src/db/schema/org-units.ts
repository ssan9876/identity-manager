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

export const orgUnits = pgTable(
  'org_units',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => orgUnits.id, {
      onDelete: 'restrict',
    }),
    path: ltree('path').notNull(),
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
  }),
)
