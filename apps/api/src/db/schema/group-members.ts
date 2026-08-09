import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { grantSource } from './grant-source'
import { groups } from './groups'
import { organizations } from './organizations'
import { users } from './users'

export const groupUserMembers = pgTable(
  'group_user_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * NOT NULL DEFAULT 'manual' is what makes the migration safe on an
     * existing database: every row that predates this column backfills to
     * `manual`, and the reconciler never revokes a `manual` row. A backfill
     * that guesses conservatively therefore cannot cause a revocation.
     */

    /**
     * Milestone: organizations multi-tenancy, Task 4. An edge table is the
     * one place a cross-tenant reference can hide in plain sight: both of
     * its endpoints are individually valid rows, and only the PAIR is
     * wrong. Carrying the organization on the EDGE itself, and pinning both
     * endpoints to it with composite FKs, makes the wrong pair
     * unrepresentable — there is no value of organization_id that satisfies
     * both sides when the endpoints disagree.
     *
     * Derived from the GROUP being written to, never from the actor: the
     * actor may legitimately be a platform operator in master acting on
     * another tenant's group.
     */
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

    grantSource: grantSource('grant_source').notNull().default('manual'),
    grantedBy: uuid('granted_by').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.groupId, table.userId] }),
    userIdx: index('group_user_members_user_idx').on(table.userId),
    // Supports the reconciler's "every role-derived row for this user" read,
    // which is the query it runs on every single evaluation.
    sourceIdx: index('group_user_members_source_idx').on(table.grantSource, table.userId),
    // Both endpoints pinned to the edge's own organization. CASCADE matches
    // the single-column FKs these sit alongside: deleting a group or a user
    // has always removed its membership rows, and a composite FK with a
    // different action would change that.
    groupOrganizationFk: foreignKey({
      name: 'gum_group_organization_fk',
      columns: [table.groupId, table.organizationId],
      foreignColumns: [groups.id, groups.organizationId],
    }).onDelete('cascade'),
    userOrganizationFk: foreignKey({
      name: 'gum_user_organization_fk',
      columns: [table.userId, table.organizationId],
      foreignColumns: [users.id, users.organizationId],
    }).onDelete('cascade'),
  }),
)

export const groupGroupMembers = pgTable(
  'group_group_members',
  {
    parentGroupId: uuid('parent_group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    childGroupId: uuid('child_group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),

    /**
     * Milestone: organizations multi-tenancy, Task 4. An edge table is the
     * one place a cross-tenant reference can hide in plain sight: both of
     * its endpoints are individually valid rows, and only the PAIR is
     * wrong. Carrying the organization on the EDGE itself, and pinning both
     * endpoints to it with composite FKs, makes the wrong pair
     * unrepresentable — there is no value of organization_id that satisfies
     * both sides when the endpoints disagree.
     *
     * Derived from the GROUP being written to, never from the actor: the
     * actor may legitimately be a platform operator in master acting on
     * another tenant's group.
     */
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.parentGroupId, table.childGroupId] }),
    childIdx: index('group_group_members_child_idx').on(table.childGroupId),
    noSelfEdge: check('group_group_members_no_self_edge', sql`${table.parentGroupId} <> ${table.childGroupId}`),
    // Nesting cannot cross a tenant boundary either — a nested group grants
    // its parent's members everything the child grants, so one cross-tenant
    // edge here is a silent privilege bridge between two tenants.
    parentOrganizationFk: foreignKey({
      name: 'ggm_parent_organization_fk',
      columns: [table.parentGroupId, table.organizationId],
      foreignColumns: [groups.id, groups.organizationId],
    }).onDelete('cascade'),
    childOrganizationFk: foreignKey({
      name: 'ggm_child_organization_fk',
      columns: [table.childGroupId, table.organizationId],
      foreignColumns: [groups.id, groups.organizationId],
    }).onDelete('cascade'),
  }),
)
