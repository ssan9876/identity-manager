import {
  type AnyPgColumn,
  date,
  foreignKey,
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
    // Milestone: organizations multi-tenancy, Task 3. Uniqueness is
    // PER-ORGANIZATION, not global: two tenants may each employ a `jsmith`
    // with the same corporate-looking address, and a global index would let
    // whichever tenant onboarded first permanently deny the name to every
    // other one. Within a single organization the old case-insensitive
    // behaviour is unchanged — the key is (organization_id, lower(...)), so
    // `jsmith` and `JSmith` still collide inside one tenant.
    //
    // The index NAMES are deliberately unchanged. `translateWriteError` in
    // the users and groups repositories matches on exactly these strings to
    // turn a 23505 into a ConflictError; renaming one would silently turn a
    // 409 into a 500.
    //
    // Security note (finding SEC-L2, docs/archive/audits/carried-findings-
    // verification.md): POST /users' 409 is an existence oracle. It is
    // already scrubbed of the submitted value there; scoping these indexes
    // per organization additionally narrows the oracle to WITHIN one tenant,
    // where the caller is already authorised to look.
    emailUnique: uniqueIndex('users_primary_email_unique').on(
      table.organizationId,
      sql`lower(${table.primaryEmail})`,
    ),
    usernameUnique: uniqueIndex('users_username_unique').on(
      table.organizationId,
      sql`lower(${table.username})`,
    ),
    // Still PARTIAL: employee_id is nullable and most rows have none. A
    // plain unique index would be fine for NULLs under Postgres' default
    // NULLS DISTINCT, but the partial index keeps the index small and keeps
    // the intent explicit.
    employeeIdUnique: uniqueIndex('users_employee_id_unique')
      .on(table.organizationId, table.employeeId)
      .where(sql`${table.employeeId} IS NOT NULL`),
    orgUnitIdx: index('users_org_unit_idx').on(table.orgUnitId),
    organizationIdx: index('users_organization_idx').on(table.organizationId),
    // Milestone: organizations multi-tenancy, Task 4. The referenceable
    // target for the membership edges' composite FKs (group-members.ts) and
    // for this table's own self-referencing manager FK below — see
    // org-units.ts for why the surrogate PK is not enough on its own.
    idOrganizationKey: uniqueIndex('users_id_organization_key').on(
      table.id,
      table.organizationId,
    ),
    // A user's org unit must be in the user's own organization. This is the
    // load-bearing constraint of the whole milestone: organization_id is
    // DERIVED from the org unit at write time (UsersRepository.create), so
    // application code cannot produce a mismatch today — but a CSV import, a
    // connector write-back, a future endpoint or a plain bug could, and the
    // failure mode is one tenant reading another's directory. Belongs in the
    // database, where nothing can route around it.
    orgUnitOrganizationFk: foreignKey({
      name: 'users_org_unit_organization_fk',
      columns: [table.orgUnitId, table.organizationId],
      foreignColumns: [orgUnits.id, orgUnits.organizationId],
    }).onDelete('restrict'),
    // A user's manager likewise. NULL manager_id passes under MATCH SIMPLE,
    // which is the wanted behaviour — most people have no manager recorded.
    //
    // The hand-written migration spells the referential action as
    // `ON DELETE SET NULL (manager_id)` — a COLUMN LIST, Postgres 15+ —
    // which drizzle's `onDelete('set null')` cannot express. That deviation
    // is deliberate and load-bearing: organization_id is NOT NULL, so a
    // column-list-less SET NULL would try to null it too and every manager
    // deletion would fail with a not-null violation instead of orphaning
    // the report the way users_manager_id_users_id_fk always has. The real
    // behaviour is pinned by test/organizations.isolation.spec.ts
    // ('deleting a manager nulls only manager_id').
    managerOrganizationFk: foreignKey({
      name: 'users_manager_organization_fk',
      columns: [table.managerId, table.organizationId],
      foreignColumns: [table.id, table.organizationId],
    }).onDelete('set null'),
  }),
)
