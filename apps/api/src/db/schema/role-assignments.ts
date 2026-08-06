import { sql } from 'drizzle-orm'
import {
  index,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { orgUnits } from './org-units'
import { users } from './users'

export const roleKey = pgEnum('role_key', [
  'super_admin',
  'user_admin',
  'help_desk',
  'auditor',
  'read_only',
])

export const roleAssignments = pgTable(
  'role_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleKey: roleKey('role_key').notNull(),
    // NULL scope means the role applies across the whole directory.
    scopeOrgUnitId: uuid('scope_org_unit_id').references(() => orgUnits.id, {
      onDelete: 'cascade',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userIdx: index('role_assignments_user_idx').on(table.userId),
    // Two partial indexes: Postgres does not treat NULLs as equal, so a single
    // unique index over (user, role, scope) would permit unlimited duplicate
    // global assignments.
    scopedUnique: uniqueIndex('role_assignments_scoped_unique')
      .on(table.userId, table.roleKey, table.scopeOrgUnitId)
      .where(sql`${table.scopeOrgUnitId} IS NOT NULL`),
    globalUnique: uniqueIndex('role_assignments_global_unique')
      .on(table.userId, table.roleKey)
      .where(sql`${table.scopeOrgUnitId} IS NULL`),
  }),
)
