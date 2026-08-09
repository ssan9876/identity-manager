import {
  type AnyPgColumn,
  foreignKey,
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
    // Milestone: organizations multi-tenancy, Task 4. A composite foreign
    // key can only reference a UNIQUE key over exactly the referenced pair —
    // the surrogate primary key alone is not enough, even though `id` is
    // already unique on its own. This index exists solely to be that
    // referenceable target for the FKs below and in users.ts/groups.ts.
    idOrganizationKey: uniqueIndex('org_units_id_organization_key').on(
      table.id,
      table.organizationId,
    ),
    // An org unit's parent must live in the SAME organization. Without this,
    // a single mis-set parent_id silently grafts one tenant's whole subtree
    // under another's — and because scope filtering is path-based, every
    // ancestor-scoped read would then walk straight across the tenant
    // boundary. MATCH SIMPLE (the default) lets a NULL parent_id pass,
    // which is what a root org unit needs.
    parentOrganizationFk: foreignKey({
      name: 'org_units_parent_organization_fk',
      columns: [table.parentId, table.organizationId],
      foreignColumns: [table.id, table.organizationId],
    }).onDelete('restrict'),
  }),
)
