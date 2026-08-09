import {
  type AnyPgColumn,
  date,
  index,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orgUnits } from './org-units'
import { organizations } from './organizations'

export const userStatus = pgEnum('user_status', [
  'pending',
  'active',
  'suspended',
  'deactivated',
])

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    status: userStatus('status').notNull().default('pending'),
    primaryEmail: varchar('primary_email', { length: 320 }).notNull(),
    username: varchar('username', { length: 128 }).notNull(),
    firstName: varchar('first_name', { length: 128 }).notNull(),
    lastName: varchar('last_name', { length: 128 }).notNull(),
    displayName: varchar('display_name', { length: 256 }).notNull(),
    employeeId: varchar('employee_id', { length: 64 }),
    jobTitle: varchar('job_title', { length: 255 }),
    orgUnitId: uuid('org_unit_id')
      .notNull()
      .references(() => orgUnits.id, { onDelete: 'restrict' }),
    // Milestone: organizations multi-tenancy, Task 2. Derived from the
    // user's org unit at write time (see UsersRepository.create) — never
    // taken from the request — and backfilled to master for every
    // pre-existing row. ON DELETE RESTRICT: an organization can never be
    // removed out from under users that still reference it.
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    managerId: uuid('manager_id').references((): AnyPgColumn => users.id, {
      onDelete: 'set null',
    }),
    location: varchar('location', { length: 255 }),
    startDate: date('start_date'),
    endDate: date('end_date'),
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
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  },
  (table) => ({
    emailUnique: uniqueIndex('users_primary_email_unique').on(
      sql`lower(${table.primaryEmail})`,
    ),
    usernameUnique: uniqueIndex('users_username_unique').on(
      sql`lower(${table.username})`,
    ),
    employeeIdUnique: uniqueIndex('users_employee_id_unique')
      .on(table.employeeId)
      .where(sql`${table.employeeId} IS NOT NULL`),
    orgUnitIdx: index('users_org_unit_idx').on(table.orgUnitId),
    organizationIdx: index('users_organization_idx').on(table.organizationId),
  }),
)
