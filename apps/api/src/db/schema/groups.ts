import { sql } from 'drizzle-orm'
import {
  foreignKey,
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { orgUnits } from './org-units'
import { organizations } from './organizations'

export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 255 }).notNull(),
    description: varchar('description', { length: 1024 }),
    orgUnitId: uuid('org_unit_id').references(() => orgUnits.id, {
      onDelete: 'restrict',
    }),
    // Milestone: organizations multi-tenancy, Task 2. Derived at write time
    // (see GroupsRepository.create): from the target org unit when set, or
    // master when this is a global group (orgUnitId null) — preserving
    // today's behaviour that global groups are platform-wide. Backfilled to
    // master for every pre-existing row. ON DELETE RESTRICT: an organization
    // can never be removed out from under groups that still reference it.
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    attributes: jsonb('attributes')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // Milestone: organizations multi-tenancy, Task 3. Per-organization, for
    // the same reason as users' indexes above: a group called `engineers`
    // in one tenant must not deny the name to every other tenant. Global
    // groups (org_unit_id NULL) still carry an organization_id — master —
    // so they participate in this index exactly like any other row.
    // Name unchanged: GroupsRepository.translateWriteError matches on it.
    nameUnique: uniqueIndex('groups_name_unique').on(
      table.organizationId,
      sql`lower(${table.name})`,
    ),
    orgUnitIdx: index('groups_org_unit_idx').on(table.orgUnitId),
    organizationIdx: index('groups_organization_idx').on(table.organizationId),
    // Milestone: organizations multi-tenancy, Task 4. The referenceable
    // target for the membership edges' composite FKs (group-members.ts) —
    // see org-units.ts for why the surrogate PK is not enough on its own.
    idOrganizationKey: uniqueIndex('groups_id_organization_key').on(
      table.id,
      table.organizationId,
    ),
    // A group's org unit must be in the group's own organization. NULL
    // org_unit_id — a GLOBAL group — passes under MATCH SIMPLE, which is
    // exactly the wanted behaviour: global groups still exist, they are
    // just global WITHIN one organization (their organization_id is master
    // for every pre-existing row; see GroupsRepository.create).
    orgUnitOrganizationFk: foreignKey({
      name: 'groups_org_unit_organization_fk',
      columns: [table.orgUnitId, table.organizationId],
      foreignColumns: [orgUnits.id, orgUnits.organizationId],
    }).onDelete('restrict'),
  }),
)
